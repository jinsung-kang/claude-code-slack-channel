# CLAUDE.md

## What This Is

Slack ↔ `claude -p` bridge. Socket Mode listener that forwards **@mentions in allowlisted channels** to a headless Claude subprocess and posts the result back into the originating Slack thread. Per-thread session continuity via Claude CLI's `--resume`. No MCP, no policy engine, no audit journal.

## Architecture

One file: `index.ts` (~300 lines).

```
Slack workspace ──▶ Socket Mode ──▶ index.ts ──spawn──▶ `claude -p --output-format json [--resume <id>] "<prompt>"`
                                     │                    │
                                     ▼                    ▼
                         sessions.json             result JSON → Slack thread reply
                  (threadKey ↔ session_id)
```

## Commands

```bash
bun install
bun run typecheck    # tsc --noEmit
bun run start        # bun index.ts
bun run dev          # bun --watch index.ts
```

## Config

Tokens + allowlist live in `~/.claude/channels/slack/.env` (auto-chmod 0o600). Env vars override .env values.

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ALLOWED_CHANNELS=C01FJBRKYDU,C02ABCDEF
# Optional
CLAUDE_BIN=claude            # path to claude CLI if not on PATH
CLAUDE_TIMEOUT_MS=600000     # per-invocation timeout (default 10 min)
SLACK_STATE_DIR=/custom/dir  # override state directory
```

## Slack App Scopes

Bot token scopes: `app_mentions:read`, `chat:write`, `reactions:write`. Event subscriptions: `app_mention`. Socket Mode: enabled (generate an app-level token with `connections:write`).

## State Layout

```
~/.claude/channels/slack/
├── .env            # tokens (chmod 0o600)
└── sessions.json   # { "<channel>:<thread_ts>": "<claude_session_id>", ... } (chmod 0o600)
```

Atomic write: `sessions.json.tmp.<pid>` → `rename()`. Parallel `claude -p` spawns serialize through a single Promise chain so writes never overlap.

## Behavior Notes

- **Only `app_mention` events** are handled. DMs / ambient messages are ignored by design.
- **Channel not in `ALLOWED_CHANNELS`** → silent drop (stderr log).
- **Resume failure** (session expired / not found) → map entry cleared, invocation retried without `--resume`, user sees `_(previous session is gone — starting a new conversation)_` in the thread.
- **Timeout** (`CLAUDE_TIMEOUT_MS`) → child killed via `AbortController`, error posted to thread.
- **Parallel spawn** — each mention runs independently; a long claude call on thread A does not block a mention on thread B.
- **Attachments** — not supported; bot posts a heads-up and processes the text only.
- **`claude -p` output** is parsed as JSON (`{ result, session_id, ... }`), so `--output-format json` is non-optional.

## Security

- `.env` chmod 0o600 every boot; tokens never logged.
- `spawn` uses positional args (`shell: false`) — no shell metacharacter interpretation of Slack message text.
- `@mention` text is passed verbatim as the Claude prompt. Anyone who can mention the bot in an allowed channel can invoke `claude -p` with arbitrary prompt content (**prompt-injection scope** is the set of people allowed into the channel). Treat `ALLOWED_CHANNELS` as a trust boundary accordingly — don't add a public channel.
- Self-echo guard: `bot_id === selfBotId` → drop. Peer-bot @mentions are currently processed (rare because `app_mention` only fires on explicit mentions).
