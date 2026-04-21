#!/usr/bin/env bun
/**
 * Slack ↔ `claude -p` bridge.
 *
 * Socket Mode listener that forwards @mentions in allowlisted channels to a
 * headless `claude -p` subprocess, then posts the result back into the Slack
 * thread. Session continuity is preserved per-thread via the Claude CLI's
 * `--resume <session-id>` flag, with the mapping persisted to
 * `${STATE_DIR}/sessions.json`.
 *
 * No MCP. No policy engine. No audit journal. If you need those, use an
 * earlier revision of this repo (pre-rewrite/headless-p).
 *
 * SPDX-License-Identifier: MIT
 */
import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATE_DIR =
  process.env['SLACK_STATE_DIR'] ?? join(homedir(), '.claude', 'channels', 'slack')
const ENV_FILE = join(STATE_DIR, '.env')
const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')

const CLAUDE_BIN = process.env['CLAUDE_BIN'] ?? 'claude'
const CLAUDE_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env['CLAUDE_TIMEOUT_MS']) || 10 * 60 * 1000,
)

const SLACK_TEXT_LIMIT = 3500 // leave some headroom below Slack's 4000-char cap

// ---------------------------------------------------------------------------
// .env loader — same format as the prior MCP server for drop-in compatibility
// ---------------------------------------------------------------------------

interface Config {
  botToken: string
  appToken: string
  allowedChannels: Set<string>
}

function loadEnv(): Config {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

  if (!existsSync(ENV_FILE)) {
    console.error(
      `[bridge] no .env at ${ENV_FILE}. create it with:\n` +
        '  SLACK_BOT_TOKEN=xoxb-...\n' +
        '  SLACK_APP_TOKEN=xapp-...\n' +
        '  ALLOWED_CHANNELS=C01FJBRKYDU,C02ABCDEF',
    )
    process.exit(1)
  }

  // Lock down perms every boot so a careless edit doesn't leave tokens
  // world-readable. `chmod` is idempotent when already 0o600.
  chmodSync(ENV_FILE, 0o600)

  const vars: Record<string, string> = {}
  for (const line of readFileSync(ENV_FILE, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    vars[key] = val
  }

  // env vars beat .env entries — useful for ALLOWED_CHANNELS overrides in dev
  const envFirst = (key: string): string =>
    process.env[key] !== undefined && process.env[key] !== ''
      ? (process.env[key] as string)
      : vars[key] ?? ''

  const botToken = envFirst('SLACK_BOT_TOKEN')
  const appToken = envFirst('SLACK_APP_TOKEN')
  const allowedRaw = envFirst('ALLOWED_CHANNELS')

  if (!botToken.startsWith('xoxb-')) {
    console.error('[bridge] SLACK_BOT_TOKEN must start with xoxb-')
    process.exit(1)
  }
  if (!appToken.startsWith('xapp-')) {
    console.error('[bridge] SLACK_APP_TOKEN must start with xapp-')
    process.exit(1)
  }

  const allowedChannels = new Set(
    allowedRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  if (allowedChannels.size === 0) {
    console.error(
      '[bridge] ALLOWED_CHANNELS is empty — every mention will be dropped. ' +
        'Set it in .env or env var: ALLOWED_CHANNELS=C01...,C02...',
    )
  }

  return { botToken, appToken, allowedChannels }
}

// ---------------------------------------------------------------------------
// Sessions map: threadKey → claude session_id
// ---------------------------------------------------------------------------

type SessionMap = Map<string, string>

function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`
}

function loadSessions(): SessionMap {
  if (!existsSync(SESSIONS_FILE)) return new Map()
  try {
    const raw = readFileSync(SESSIONS_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, string>
    return new Map(Object.entries(parsed))
  } catch (err) {
    console.error(
      '[bridge] sessions.json unreadable — starting with empty map:',
      err instanceof Error ? err.message : err,
    )
    return new Map()
  }
}

// Serialize concurrent saves through one Promise chain so parallel spawns
// never overlap their atomic writes. Best-effort: a save failure logs and
// drops that update — the next successful save catches up.
let saveChain: Promise<void> = Promise.resolve()
function saveSessions(map: SessionMap): Promise<void> {
  saveChain = saveChain.then(() => {
    const obj = Object.fromEntries(map.entries())
    const tmp = `${SESSIONS_FILE}.tmp.${process.pid}`
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
    renameSync(tmp, SESSIONS_FILE)
  }).catch((err) => {
    console.error(
      '[bridge] sessions.json save failed:',
      err instanceof Error ? err.message : err,
    )
  })
  return saveChain
}

// ---------------------------------------------------------------------------
// Slack text chunking (4000-char limit; split on newline boundaries where
// possible, fall back to hard-slice).
// ---------------------------------------------------------------------------

function chunk(text: string, limit = SLACK_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let buf = ''
  for (const line of text.split('\n')) {
    // A single line that exceeds limit — hard-slice it.
    if (line.length > limit) {
      if (buf) {
        out.push(buf)
        buf = ''
      }
      for (let i = 0; i < line.length; i += limit) {
        out.push(line.slice(i, i + limit))
      }
      continue
    }
    if (buf.length + line.length + 1 > limit) {
      out.push(buf)
      buf = line
    } else {
      buf = buf ? `${buf}\n${line}` : line
    }
  }
  if (buf) out.push(buf)
  return out
}

// ---------------------------------------------------------------------------
// `claude -p` runner
// ---------------------------------------------------------------------------

interface ClaudeResult {
  ok: true
  result: string
  sessionId: string
  resumed: boolean
}
interface ClaudeFailure {
  ok: false
  error: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  resumeFailed: boolean
}

function isResumeFailure(stderr: string): boolean {
  const s = stderr.toLowerCase()
  return (
    s.includes('session') &&
    (s.includes('not found') ||
      s.includes('expired') ||
      s.includes('no such session') ||
      s.includes('does not exist') ||
      s.includes('invalid session'))
  )
}

function runClaude(
  prompt: string,
  resumeId: string | undefined,
): Promise<ClaudeResult | ClaudeFailure> {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json']
    if (resumeId) args.push('--resume', resumeId)

    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), CLAUDE_TIMEOUT_MS)

    const proc = spawn(CLAUDE_BIN, args, {
      signal: ac.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      // No shell — positional prompt arg is passed through exec safely.
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })

    proc.on('error', (err) => {
      clearTimeout(to)
      resolve({
        ok: false,
        error: `spawn failed: ${err.message}`,
        stderr,
        exitCode: null,
        timedOut: false,
        resumeFailed: false,
      })
    })

    proc.on('close', (code, signal) => {
      clearTimeout(to)
      const timedOut = ac.signal.aborted || signal === 'SIGTERM' || signal === 'SIGKILL'
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout) as {
            result?: string
            session_id?: string
          }
          const sessionId = parsed.session_id ?? ''
          const result = parsed.result ?? ''
          if (!sessionId) {
            resolve({
              ok: false,
              error: 'claude -p returned no session_id in JSON output',
              stderr,
              exitCode: 0,
              timedOut: false,
              resumeFailed: false,
            })
            return
          }
          resolve({ ok: true, result, sessionId, resumed: Boolean(resumeId) })
        } catch (err) {
          resolve({
            ok: false,
            error: `parse JSON output failed: ${err instanceof Error ? err.message : err}`,
            stderr,
            exitCode: 0,
            timedOut: false,
            resumeFailed: false,
          })
        }
        return
      }

      // Non-zero exit. If --resume was used, check whether the error looks
      // like a resume failure so the caller can retry without the flag.
      resolve({
        ok: false,
        error: timedOut
          ? `timeout after ${CLAUDE_TIMEOUT_MS}ms`
          : `claude exited ${code}`,
        stderr,
        exitCode: code,
        timedOut,
        resumeFailed: Boolean(resumeId) && !timedOut && isResumeFailure(stderr),
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Slack helpers
// ---------------------------------------------------------------------------

async function postChunks(
  web: WebClient,
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  for (const piece of chunk(text)) {
    try {
      await web.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: piece,
        unfurl_links: false,
        unfurl_media: false,
      })
    } catch (err) {
      console.error(
        '[bridge] chat.postMessage failed:',
        err instanceof Error ? err.message : err,
      )
      return
    }
  }
}

async function addReaction(
  web: WebClient,
  channel: string,
  ts: string,
  name: string,
): Promise<void> {
  try {
    await web.reactions.add({ channel, timestamp: ts, name })
  } catch {
    /* non-critical */
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

interface Runtime {
  web: WebClient
  cfg: Config
  sessions: SessionMap
  selfBotId: string
  botUserId: string
}

async function handleMention(rt: Runtime, ev: Record<string, unknown>): Promise<void> {
  const channel = ev['channel'] as string
  const user = ev['user'] as string | undefined
  const ts = ev['ts'] as string
  const threadTs = (ev['thread_ts'] as string | undefined) ?? ts
  const rawText = (ev['text'] as string | undefined) ?? ''

  if (!rt.cfg.allowedChannels.has(channel)) {
    console.error(
      `[bridge] drop (channel not allowed): channel=${channel} user=${user ?? '?'} ts=${ts}`,
    )
    return
  }

  // Self-echo guard — bot's own posts (or posts from any bot) won't retrigger.
  // app_mention only fires on explicit @mentions so bots rarely mention
  // themselves, but a worker bot forwarding text could.
  if (ev['bot_id'] && ev['bot_id'] === rt.selfBotId) {
    return
  }

  // Strip the bot mention from the prompt. If nothing remains, bail out.
  const prompt = rawText
    .replace(new RegExp(`<@${rt.botUserId}>`, 'g'), '')
    .trim()
  if (!prompt) {
    await postChunks(rt.web, channel, threadTs, '_(empty prompt — nothing to do)_')
    return
  }

  if (Array.isArray(ev['files']) && (ev['files'] as unknown[]).length > 0) {
    await postChunks(
      rt.web,
      channel,
      threadTs,
      '_(attachments are not supported in this bridge — only the text prompt will be used)_',
    )
  }

  const key = threadKey(channel, threadTs)
  const prior = rt.sessions.get(key)
  void addReaction(rt.web, channel, ts, 'thought_balloon')

  console.error(
    `[bridge] claude -p start channel=${channel} thread=${threadTs} resume=${prior ?? 'none'} prompt_len=${prompt.length}`,
  )

  let outcome = await runClaude(prompt, prior)

  // Resume failure → retry once with no prior session and warn the thread.
  if (!outcome.ok && outcome.resumeFailed) {
    console.error(
      `[bridge] resume failed, retrying fresh channel=${channel} thread=${threadTs}`,
    )
    rt.sessions.delete(key)
    void saveSessions(rt.sessions)
    await postChunks(
      rt.web,
      channel,
      threadTs,
      '_(previous session is gone — starting a new conversation)_',
    )
    outcome = await runClaude(prompt, undefined)
  }

  if (!outcome.ok) {
    console.error(
      `[bridge] claude -p failed channel=${channel} thread=${threadTs} error=${outcome.error}`,
    )
    const errSnippet = outcome.stderr.trim().slice(0, 800)
    const body = `⚠️ \`claude -p\` failed: ${outcome.error}${
      errSnippet ? `\n\`\`\`\n${errSnippet}\n\`\`\`` : ''
    }`
    await postChunks(rt.web, channel, threadTs, body)
    void addReaction(rt.web, channel, ts, 'warning')
    return
  }

  rt.sessions.set(key, outcome.sessionId)
  void saveSessions(rt.sessions)

  const body = outcome.result.trim()
  await postChunks(rt.web, channel, threadTs, body.length > 0 ? body : '_(empty response)_')
  void addReaction(rt.web, channel, ts, 'white_check_mark')
  console.error(
    `[bridge] claude -p ok channel=${channel} thread=${threadTs} session=${outcome.sessionId} out_len=${body.length}`,
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Non-terminal diagnostics. These handlers stay installed for the lifetime
  // of the process so a stray unawaited promise logs instead of crashes.
  process.on('unhandledRejection', (reason) => {
    console.error(
      '[bridge] UNHANDLED REJECTION:',
      reason instanceof Error ? reason.stack ?? reason.message : reason,
    )
  })
  process.on('uncaughtException', (err) => {
    console.error('[bridge] UNCAUGHT EXCEPTION:', err?.stack ?? err)
  })

  const cfg = loadEnv()
  const sessions = loadSessions()
  const web = new WebClient(cfg.botToken)
  const socket = new SocketModeClient({ appToken: cfg.appToken })

  let botUserId = ''
  let selfBotId = ''
  try {
    const auth = await web.auth.test()
    botUserId = (auth['user_id'] as string | undefined) ?? ''
    selfBotId = (auth['bot_id'] as string | undefined) ?? ''
    console.error('[bridge] bot identity:', { botUserId, selfBotId })
  } catch (err) {
    console.error('[bridge] auth.test failed:', err instanceof Error ? err.message : err)
    process.exit(1)
  }

  console.error(
    `[bridge] allowed channels: ${[...cfg.allowedChannels].join(', ') || '(none)'}`,
  )
  console.error(`[bridge] sessions loaded: ${sessions.size}`)

  const rt: Runtime = { web, cfg, sessions, selfBotId, botUserId }

  socket.on('app_mention', async ({ event, ack }) => {
    await ack()
    if (!event) return
    // Don't await — each mention runs independently so a long claude -p
    // won't block the next mention on another thread (parallel spawn).
    handleMention(rt, event as Record<string, unknown>).catch((err) => {
      const channel = (event as Record<string, unknown>)['channel'] as string
      const ts = (event as Record<string, unknown>)['ts'] as string
      const threadTs =
        ((event as Record<string, unknown>)['thread_ts'] as string | undefined) ?? ts
      console.error(
        '[bridge] handleMention threw:',
        err instanceof Error ? err.stack ?? err.message : err,
      )
      void postChunks(
        web,
        channel,
        threadTs,
        `⚠️ internal error: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  })

  // Shutdown
  let shuttingDown = false
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    console.error(`[bridge] shutting down: ${reason}`)
    try {
      await socket.disconnect()
    } catch (err) {
      console.error(
        '[bridge] socket.disconnect failed:',
        err instanceof Error ? err.message : err,
      )
    }
    // Wait for any in-flight session save to settle so we don't leave a
    // half-written tmp file behind.
    try {
      await saveChain
    } catch { /* already logged */ }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await socket.start()
  console.error('[bridge] Socket Mode connected — waiting for @mentions')
}

main().catch((err) => {
  console.error('[bridge] fatal:', err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
