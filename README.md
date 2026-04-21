# claude-code-slack-bridge

Tiny Slack Socket Mode listener that forwards **@mentions in allowlisted channels** to a headless `claude -p` subprocess and posts the result back into the Slack thread. Per-thread continuity via Claude CLI's `--resume`.

One file (`index.ts`, ~300 lines). No MCP, no policy engine, no audit journal. If you want those, fork an earlier revision.

## Quick Start

1. **Create a Slack app** (`https://api.slack.com/apps`).
   - **OAuth scopes (bot)**: `app_mentions:read`, `chat:write`, `reactions:write`
   - **Event subscriptions**: subscribe to `app_mention`
   - **Socket Mode**: enabled. Generate an app-level token with `connections:write`
   - Install the app to your workspace.

2. **Write the `.env`** at `~/.claude/channels/slack/.env`:

   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ALLOWED_CHANNELS=C01FJBRKYDU,C02ABCDEF
   ```

   (`ALLOWED_CHANNELS` is a comma-separated list of channel IDs — grab them from the Slack channel details panel.)

3. **Install and run:**

   ```bash
   bun install
   bun run typecheck
   bun run start
   ```

   Expected output:
   ```
   [bridge] bot identity: { botUserId: 'U...', selfBotId: 'B...' }
   [bridge] allowed channels: C01FJBRKYDU,C02ABCDEF
   [bridge] sessions loaded: 0
   [bridge] Socket Mode connected — waiting for @mentions
   ```

4. Invite the bot to an allowed channel and mention it: `@your-bot hello`. It'll reply in a thread and every follow-up mention in that same thread resumes the same Claude session.

## Requirements

- [Bun](https://bun.sh) ≥ 1.0 (or swap the scripts for `tsx` / `node --import tsx`)
- [Claude Code CLI](https://code.claude.com) ≥ 2.1.80 on `PATH` (or set `CLAUDE_BIN`)

## Optional knobs

| Env var | Default | Purpose |
|---|---|---|
| `CLAUDE_BIN` | `claude` | Full path to `claude` CLI if not on `PATH` |
| `CLAUDE_TIMEOUT_MS` | `600000` | Per-invocation timeout (ms) — child is killed on expiry |
| `SLACK_STATE_DIR` | `~/.claude/channels/slack` | Override state directory |

## What it does NOT do

- No attachment handling (text prompts only — you'll see a heads-up note in the thread if someone attaches a file)
- No policy engine / audit journal / allowlist beyond `ALLOWED_CHANNELS`
- No DM / ambient-message support by design — the bot must be explicitly @mentioned
- No message editing / streaming output (posts the final `claude -p` result in one go, chunked at 3500 chars)

## Security

- `.env` is `chmod 0o600` on every boot.
- `spawn` uses positional args (`shell: false`), so Slack message text never goes through a shell.
- `ALLOWED_CHANNELS` is the trust boundary. Anyone who can mention the bot in an allowed channel can invoke `claude -p` with arbitrary prompt content — keep those channels private.
- Self-echo (bot's own posts) are dropped.

## License

MIT.
