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
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Where `claude -p` runs. Captured once at boot so a later `process.chdir`
// (unlikely but cheap insurance) doesn't drift subsequent spawns. If you want
// the bridge to operate on a specific repo, start the server from that repo:
//   cd ~/Project/payhere-work-review && bun run start
// Override explicitly with `CLAUDE_CWD=/abs/path` when needed.
//
// Note: `process.cwd()` here is the shell's cwd when the bridge was exec'd —
// NOT the bridge source directory. `run.sh` does `cd <target>` before exec,
// so this ends up pointing at the operator's working repo as expected.
const CLAUDE_CWD = process.env['CLAUDE_CWD'] ?? process.cwd()

// State directory layout (tokens + session map). Defaults to a
// `.claude/channels/slack` subtree under CLAUDE_CWD so each working repo gets
// its own isolated state without polluting $HOME. Override with
// `SLACK_STATE_DIR=/abs/path` if you really want shared global state.
const STATE_DIR =
  process.env['SLACK_STATE_DIR'] ?? join(CLAUDE_CWD, '.claude', 'channels', 'slack')
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
  stdout: string
  exitCode: number | null
  timedOut: boolean
  resumeFailed: boolean
}

// Match known resume-failure signatures across Claude CLI versions. Pass
// BOTH stderr and stdout because `--output-format json` may emit errors on
// either stream depending on when the failure is detected (pre-JSON-wrap
// vs. inside the JSON envelope).
//
// Observed phrasings:
//   - "No conversation found with session ID: <uuid>"  (current; Oct 2025+)
//   - "session not found"                               (earlier)
//   - "session <id> does not exist" / "has expired"
//   - "invalid session"
function isResumeFailure(stderr: string, stdout: string): boolean {
  const s = `${stderr}\n${stdout}`.toLowerCase()
  return (
    s.includes('no conversation found') ||
    s.includes('session not found') ||
    s.includes('session expired') ||
    s.includes('session has expired') ||
    s.includes('no such session') ||
    s.includes('session does not exist') ||
    s.includes('invalid session') ||
    // Broad safety net: any "session" + "not found" / "not exist" / "invalid"
    // that the specific patterns above miss.
    (s.includes('session') &&
      (s.includes('not found') ||
        s.includes('not exist') ||
        s.includes('invalid')))
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
      cwd: CLAUDE_CWD,
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
        stdout,
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
              stdout,
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
            stdout,
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
        stdout,
        exitCode: code,
        timedOut,
        resumeFailed:
          Boolean(resumeId) && !timedOut && isResumeFailure(stderr, stdout),
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
  } catch (err) {
    // Non-critical — reactions are UX polish, not correctness. But silent
    // swallows mask scope issues (e.g. missing `reactions:write`) and Slack
    // rate-limit signals, so log once per failure.
    console.error(
      `[bridge] reaction :${name}: failed on ${channel}/${ts}:`,
      err instanceof Error ? err.message : err,
    )
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

  // Normalize Slack's inline link/mention encoding down to plain text so
  // downstream regex / skills see clean URLs. Slack wraps URLs the user
  // typed as `<https://example.com>` and labeled links as
  // `<https://example.com|label>` — if we pass these through verbatim,
  // skill-side URL extractors grab `https://example.com|label` (pipe +
  // label included) and 404 on fetch. References:
  //   https://api.slack.com/reference/surfaces/formatting#retrieving-messages
  const userText = rawText
    // 1. Drop bot's own mention entirely
    .replace(new RegExp(`<@${rt.botUserId}>`, 'g'), '')
    // 2. Labeled URL: <url|label>  →  url
    .replace(/<((?:https?|mailto):[^|>\s]+)\|[^>]*>/g, '$1')
    // 3. Bare URL:    <url>        →  url
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    // 4. Channel ref: <#C123|name> →  #name   (informational; preserves the name if present)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<#[A-Z0-9]+>/g, '')
    // 5. Other user mentions stay as-is (<@U...>) so the skill can see them.
    .trim()
  if (!userText) {
    await postChunks(rt.web, channel, threadTs, '_(empty prompt — nothing to do)_')
    return
  }

  // Diagnostic: log the first 400 chars of the cleaned text so operators can
  // see exactly what the skill will receive. Avoid logging full prompts —
  // users' messages may be sensitive and the stream can get long.
  console.error(
    `[bridge] user_text (first 400 chars): ${
      userText.length > 400 ? userText.slice(0, 400) + '…' : userText
    }`,
  )

  // Wrap the user's message with a <slack_context> preamble so skills that
  // need to know where they are running (channel, thread, user) can read it
  // from the prompt. Plain conversations can ignore the preamble — Claude
  // treats it as context, and the final instruction in <user_message> is
  // what it acts on. Keeping it as structured tags instead of free-form
  // prose avoids ambiguity when the user's text itself contains phrases
  // like "channel" or "thread".
  const prompt = [
    '<slack_context>',
    `  <channel_id>${channel}</channel_id>`,
    `  <thread_ts>${threadTs}</thread_ts>`,
    `  <message_ts>${ts}</message_ts>`,
    `  <user_id>${user ?? 'unknown'}</user_id>`,
    '</slack_context>',
    '',
    '<user_message>',
    userText,
    '</user_message>',
    '',
    'Note: you are running via a Slack bridge. Anything you emit as your',
    'final response text will be posted back into the thread above. You do',
    'not have direct Slack API access — the bridge handles posting. If a',
    'skill requires Slack channel/thread info, read it from <slack_context>.',
  ].join('\n')

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
  // Immediate ack: tells the user the bridge received the mention and is
  // working on it, before claude -p produces any output.
  void addReaction(rt.web, channel, ts, 'eyes')

  console.error(
    `[bridge] claude -p start channel=${channel} thread=${threadTs} resume=${prior ?? 'none'} user_text_len=${userText.length}`,
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
    // stderr usually carries the diagnostic; fall back to stdout when empty
    // (some error paths emit structured JSON on stdout instead).
    const diag = (outcome.stderr.trim() || outcome.stdout.trim()).slice(0, 800)
    const body = `⚠️ \`claude -p\` failed: ${outcome.error}${
      diag ? `\n\`\`\`\n${diag}\n\`\`\`` : ''
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
  console.error(`[bridge] claude -p cwd: ${CLAUDE_CWD}`)
  console.error(`[bridge] state dir: ${STATE_DIR}`)
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
