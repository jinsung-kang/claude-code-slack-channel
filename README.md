# claude-code-slack-bridge

Tiny Slack Socket Mode listener that forwards **@mentions in allowlisted channels** to a headless `claude -p` subprocess and posts the result back into the Slack thread. Per-thread continuity via Claude CLI's `--resume`.

One file (`index.ts`, ~400 lines). No MCP, no policy engine, no audit journal. If you want those, fork an earlier revision.

## Architecture

```
Slack workspace ──▶ Socket Mode ──▶ index.ts ──spawn──▶ claude -p --output-format json [--resume <id>] "<prompt>"
                                     │                    │
                                     ▼                    ▼
                         sessions.json             result JSON → Slack thread reply
                  (threadKey ↔ session_id)
```

- **Input**: Socket Mode subscribes to `app_mention`. Only allowlisted channels are processed.
- **Prompt**: user text is wrapped in a `<slack_context>` / `<user_message>` envelope so skills that need Slack metadata can read it; Slack's inline encoding (`<url|label>`, `<#C|name>`, `<@U>`) is normalised to plain text first.
- **Execution**: each mention spawns its own `claude -p` (parallel safe). Thread continuity via `--resume <session_id>` kept in a small JSON map.
- **Output**: final JSON result is posted to the originating thread in 3500-char chunks. Reactions `:eyes:` (received) / `:white_check_mark:` (done) / `:warning:` (failed) are added to the user's mention.

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- [Claude Code CLI](https://code.claude.com) ≥ 2.1.80 on `PATH` (or set `CLAUDE_BIN`)
- A Slack workspace you can install an app to

## Slack app setup

1. Create an app at <https://api.slack.com/apps>.
2. **Socket Mode**: Enable. Generate an app-level token (`xapp-…`) with scope `connections:write`.
3. **OAuth & Permissions** → **Bot Token Scopes**, add:
   - `app_mentions:read` — receive @mention events
   - `chat:write` — post replies
   - `reactions:write` — add 👀 / ✅ / ⚠️ reactions
4. **Event Subscriptions**: subscribe to bot event `app_mention`.
5. **Install to Workspace**. Copy the Bot User OAuth Token (`xoxb-…`).
6. `/invite @your-bot` in each channel you plan to allow.
7. Copy channel IDs from the Slack channel details panel (top, after the name).

## Quick start

```bash
# 1. clone + install
git clone <this repo>
cd claude-code-slack-channel
bun install
bun run typecheck

# 2. choose a working directory for the bridge to operate in.
# By default state is per-repo: <working-dir>/.claude/channels/slack/.env
export BRIDGE_HOME=~/Project/some-repo       # any directory you like
mkdir -p "$BRIDGE_HOME/.claude/channels/slack"
chmod 700 "$BRIDGE_HOME/.claude/channels/slack"

# 3. write tokens
cat > "$BRIDGE_HOME/.claude/channels/slack/.env" <<EOF
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ALLOWED_CHANNELS=C01FJBRKYDU,C02ABCDEF
EOF
chmod 600 "$BRIDGE_HOME/.claude/channels/slack/.env"

# 4. run from that working directory
cd "$BRIDGE_HOME"
bun --cwd=<path-to-claude-code-slack-channel> run start
```

Expected stderr:

```
[bridge] bot identity: { botUserId: 'U...', selfBotId: 'B...' }
[bridge] allowed channels: C01FJBRKYDU, C02ABCDEF
[bridge] claude -p cwd: /Users/you/Project/some-repo
[bridge] state dir: /Users/you/Project/some-repo/.claude/channels/slack
[bridge] sessions loaded: 0
[bridge] Socket Mode connected — waiting for @mentions
```

Go to an allowlisted Slack channel and `@your-bot 안녕`. The bot replies in a thread; every subsequent @mention inside that same thread resumes the same Claude session.

## Recommended launcher: `run.sh`

A tiny shim that pins the working directory is the cleanest way to run the bridge from a specific repo. Put this at the root of the repo you want Claude to operate in:

```bash
#!/usr/bin/env bash
# ~/Project/some-repo/run.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
export CLAUDE_CWD="$HERE"
exec bun --cwd=/absolute/path/to/claude-code-slack-channel run start
```

```bash
chmod +x ~/Project/some-repo/run.sh
~/Project/some-repo/run.sh
```

## Auto-start on macOS (launchd)

For an always-on deployment on your laptop, drop a LaunchAgent so the bridge starts at login and restarts on crash.

Create `~/Library/LaunchAgents/com.example.claude-slack-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.example.claude-slack-bridge</string>

    <key>ProgramArguments</key>
    <array>
        <string>/Users/you/Project/some-repo/run.sh</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/you/Project/some-repo</string>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Interactive</string>

    <key>StandardOutPath</key>
    <string>/Users/you/Project/some-repo/bridge.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/Project/some-repo/bridge.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/you/.bun/bin:/Users/you/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/you</string>
    </dict>
</dict>
</plist>
```

```bash
# load it
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.claude-slack-bridge.plist

# status  (PID non-zero + EXIT=0 means healthy)
launchctl list | grep claude-slack-bridge

# restart (after config/code change)
launchctl kickstart -k gui/$(id -u)/com.example.claude-slack-bridge

# stop + remove from launchd
launchctl bootout gui/$(id -u)/com.example.claude-slack-bridge
```

Lid close / lid open is handled automatically by the `@slack/socket-mode` library's reconnection logic — no action needed on wake. Events received *while the laptop is sleeping* are dropped by Slack's Socket Mode (no queue), so the user needs to re-mention.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `SLACK_BOT_TOKEN` | — (required, in `.env`) | `xoxb-…` bot token |
| `SLACK_APP_TOKEN` | — (required, in `.env`) | `xapp-…` app-level token for Socket Mode |
| `ALLOWED_CHANNELS` | — (required, in `.env` or env) | Comma-separated list of channel IDs the bot will respond in |
| `CLAUDE_CWD` | `process.cwd()` at boot | Working directory for spawned `claude -p`. Also the base for `STATE_DIR`. |
| `SLACK_STATE_DIR` | `<CLAUDE_CWD>/.claude/channels/slack` | Override the state directory |
| `CLAUDE_BIN` | `claude` | Path to the Claude CLI if not on `PATH` |
| `CLAUDE_TIMEOUT_MS` | `600000` (10 min) | Per-invocation timeout; child is killed on expiry |
| `SESSION_MAX_AGE_MS` | `604800000` (7 days) | Drop session mappings older than this at boot. Set to `0` to disable pruning. |

Env vars override `.env` file entries.

## State layout

```
<CLAUDE_CWD>/.claude/channels/slack/
├── .env            # tokens + allowlist  (chmod 0600)
└── sessions.json   # { "<channel>:<thread_ts>": "<claude_session_id>", ... }  (chmod 0600)
```

Per-repo state — different working directories get independent Slack configs and session maps. No global `~/.claude/channels/slack/` is created or read by default.

`sessions.json` writes are serialised through a single Promise chain, so parallel `claude -p` spawns never corrupt it.

At boot the bridge prunes entries whose Slack `thread_ts` is older than `SESSION_MAX_AGE_MS` (default 7 days). An operator line `[bridge] pruned N stale session entries ...` is logged only when something was actually removed; otherwise boot is silent about it. If a user re-mentions a pruned thread, the resume linkage is gone and the bridge starts a fresh Claude session in that thread.

## Behavior notes

- **Only `app_mention` events are handled.** DMs / ambient channel messages are ignored by design. The bot must be explicitly `@` mentioned.
- **Channel not in `ALLOWED_CHANNELS`** → silent drop (stderr log only).
- **Thread continuity**: the first mention in a thread creates a new Claude session; subsequent mentions in that same thread reuse it via `--resume <session_id>`.
- **Session retention**: at boot, any `sessions.json` entry whose Slack `thread_ts` is older than `SESSION_MAX_AGE_MS` (default **7 days**) is dropped. This keeps the map from growing unbounded as old threads fall out of use. A log line `[bridge] pruned N stale session entries (older than 7d)` is emitted only when something was actually removed. Re-mentioning a pruned thread simply starts a fresh Claude session there. Set `SESSION_MAX_AGE_MS=0` to keep everything forever.
- **Resume failure** (session expired / not found on Claude's side) → the stale mapping is cleared, the call is retried from scratch, and the thread gets a `_(previous session is gone — starting a new conversation)_` notice.
- **Slack inline encoding** (`<url|label>`, `<#C|name>`, `<@U>`) is normalised in the incoming text so downstream skills receive clean URLs.
- **Attachments** are not supported; the bot posts a heads-up note and processes the text only.
- **Timeout** → child is `SIGTERM`'d via `AbortController`, error posted to the thread.
- **Parallel spawn**: a long `claude` call on thread A does not block a mention arriving on thread B.

## Operations

```bash
# live log
tail -f /path/to/working-dir/bridge.log

# find bridge processes
pgrep -af "bun.*index\.ts"

# diagnose a specific reaction failure (e.g. missing scope)
grep 'reaction :' /path/to/working-dir/bridge.log

# see when the session map was last pruned + how many entries were dropped
grep 'pruned' /path/to/working-dir/bridge.log

# inspect the current thread_ts age distribution (pre-prune dry run)
python3 -c "
import json, time
now = time.time()
for k in json.load(open('/path/to/.claude/channels/slack/sessions.json')):
    _, ts = k.rsplit(':', 1)
    age_d = (now - float(ts)) / 86400
    print(f'{age_d:6.2f}d  {k}')
"

# see what text the bridge passed to claude -p on the last few mentions
grep 'user_text' /path/to/working-dir/bridge.log | tail
```

Bridge boot line to look for after a restart:

```
[bridge] state dir: /abs/path/to/.claude/channels/slack
```

If that path isn't what you expect, something is off with `CLAUDE_CWD` or `SLACK_STATE_DIR`.

## Security

- `.env` is `chmod 0600` on every boot; tokens are never logged.
- `spawn` uses positional args (`shell: false`), so Slack message text never goes through a shell.
- `@mention` text becomes the Claude prompt verbatim — **`ALLOWED_CHANNELS` is your trust boundary**. Anyone who can mention the bot in an allowed channel can invoke `claude -p` with arbitrary content. Don't add public channels; don't let the bot operate against sensitive repos without a channel-level ACL upstream.
- Self-echo guard: the bot's own posts are dropped via `bot_id === selfBotId`.
- Peer-bot mentions pass through (rare because `app_mention` fires only on explicit @s).

## What it does NOT do

- No DM or ambient-message support (explicit @mention only).
- No attachment handling (text prompts only).
- No policy engine / audit journal / allowlist beyond `ALLOWED_CHANNELS`.
- No streaming output — posts the final result in one go (chunked at 3500 chars).
- No message editing after posting.
- No Slack API access for Claude — Claude can't call `chat.postMessage`, `reactions.add`, etc. directly. The bridge posts whatever Claude emits as its final response, and that's it.

## Troubleshooting

**Reactions not appearing.** Check `grep 'reaction :' bridge.log`. A `missing_scope` message means the bot token lacks `reactions:write` — add the scope in the Slack app, reinstall to workspace, restart the bridge.

**Bot never responds.** Confirm:
- `[bridge] Socket Mode connected` line is in the log (WebSocket up)
- Bot is a member of the channel (`/invite @your-bot`)
- Channel ID is in `ALLOWED_CHANNELS`
- Event Subscriptions has `app_mention` enabled in the Slack app
- Look for `[bridge] drop (channel not allowed): ...` — that means the event arrived but the allowlist blocked it

**"No conversation found with session ID"** in the thread. A stored Claude session expired. The bridge already retries from scratch automatically and posts `_(previous session is gone — starting a new conversation)_` — nothing to do.

**Bridge keeps respawning (PID changes in `launchctl list`).** Tail `bridge.log` for the real error on boot. Common causes:
- `.env` missing or unreadable from the working directory
- `bun` or `claude` not on `PATH` in launchd's environment (check the `EnvironmentVariables.PATH` in the plist)

**Slack link with label 404s on fetch in a skill.** The bridge already unwraps `<url|label>` → `url`; if a skill still sees a corrupt URL, look for `[bridge] user_text` in the log — that's the exact text passed to Claude and the skill.

## License

MIT.
