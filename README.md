# Claude Echo

> Chat with your Claude Code agent from WhatsApp, Telegram, Discord, or Slack. Developed by [**Codenzia**](https://codenzia.com).

Bind your Claude Code conversations to a messaging gateway and talk to your agent from anywhere — your phone, a borrowed laptop, your kitchen. Replies echo back through the same channel. The conversation lives in the same Claude Code transcript you can open in the IDE later.

## Pick your gateway

| Gateway | Setup | Pain | Notes |
| --- | --- | --- | --- |
| **Telegram** (recommended) | Create a bot via [@BotFather](https://t.me/BotFather), paste token. | ⭐ 30 seconds | Free, official API, no QR, no Chromium. Polling — no public URL needed. |
| **Discord** | Create app at [discord.com/developers](https://discord.com/developers/applications), enable the **MESSAGE_CONTENT** privileged intent, paste bot token. | ⭐ ~2 min | Free, official. DM the bot from anywhere. |
| **Slack** | Create Slack app, enable Socket Mode, install to workspace, paste app + bot tokens. | 🟡 ~5 min | Free, official. Great if your team is already in Slack. |
| **WhatsApp** | Scan QR with WhatsApp Web. | 🔴 Fragile | Personal number is the win, but the underlying library (Baileys) is unofficial and may break with WhatsApp protocol updates. |

## Quick start (Telegram)

1. Open Telegram → search **@BotFather** → `/newbot` → follow the prompts to name your bot → copy the token.
2. Open VSCode settings → search `claudeEcho.telegram.botToken` → paste your token.
3. On Telegram, search **@userinfobot** → it replies with your numeric user ID — copy it.
4. In VSCode click the **Claude Echo bookmark icon** in the Activity Bar → **Bind Claude Code sessions…**
5. Tick the sessions you want available, pick **Telegram**, paste your user ID.
6. Click **Start bridge**. Open your bot on Telegram and say "hi".

No QR, no Chromium, no reconnect loops — Telegram just works.

## Routing across many sessions

Echo holds an *active* session per workspace. Untagged messages go there. Switch via these commands (work on every gateway):

| You type | What happens |
| --- | --- |
| `/list` | Lists all bound sessions, marks active with `*` |
| `/use serveeta` | Sets `serveeta` as active |
| `/where` | Replies with current active |
| `#bmp how's the deploy?` | One-off — routes this single message to `bmp`, doesn't change active |
| `/help` | Command reference |
| anything else | Forwarded to the currently active session |

When more than one session is bound, replies are prefixed with `[tag]` so you always know who answered.

## Commands (in VSCode)

| Command | Description |
| --- | --- |
| `Claude Echo: Bind Claude Code sessions…` | Multi-pick sessions, choose a gateway, tie to your allowed user/number |
| `Claude Echo: Change active session…` | Pick a different default-route session |
| `Claude Echo: Unbind a single session…` | Drop one session from the workspace binding |
| `Claude Echo: Remove workspace binding` | Clear all bindings (full reset for this workspace) |
| `Claude Echo: Start bridge` / `Stop bridge` | Manual control |
| `Claude Echo: Show WhatsApp QR code` | For the WhatsApp gateway only |
| `Claude Echo: Send test message` | Sanity-check outbound path |
| `Claude Echo: Show logs` | Open the diagnostic Output Channel |
| `Claude Echo: Reset gateway auth` | Wipe cached WhatsApp creds and reconnect from scratch |
| `Claude Echo: Show / Regenerate verification code` | WhatsApp verification handshake |

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `claudeEcho.claudeCliPath` | `"claude"` | Path to the Claude CLI binary. Machine-scoped. |
| `claudeEcho.responseTimeoutMs` | `120000` | Max wait for a Claude reply. |
| `claudeEcho.autoStart` | `false` | Start bridge on workspace activation when a verified binding exists. |
| `claudeEcho.maxMessagesPerHour` | `60` | Drop inbound above this rate. `0` disables. |
| `claudeEcho.maxMessagesPerDay` | `500` | Rolling 24-hour cap. |
| `claudeEcho.maxInboundBytes` | `4096` | Truncate inbound bodies to cap Claude cost. |
| `claudeEcho.verboseLogging` | `false` | Off by default — only an 8-char prefix is logged so private chat content doesn't leak in shared diagnostics. |
| `claudeEcho.telegram.botToken` | `""` | Telegram bot token from @BotFather. Machine-scoped. |
| `claudeEcho.discord.botToken` | `""` | Discord bot token. Bot needs the MESSAGE_CONTENT intent enabled. Machine-scoped. |
| `claudeEcho.slack.appToken` | `""` | Slack app-level token (`xapp-…`). Machine-scoped. |
| `claudeEcho.slack.botToken` | `""` | Slack bot token (`xoxb-…`). Needs scopes `chat:write`, `im:history`, `im:read`. Machine-scoped. |

## Security

- **Sender allowlist.** Each binding stores a single allowed identifier (phone number for WhatsApp, numeric user ID for Telegram/Discord, Slack user ID). Messages from anything else are silently dropped and logged.
- **WhatsApp verification challenge.** Bindings to a WhatsApp number must first echo a one-time alphanumeric code (e.g. `XK7-9PQ`) from the configured phone before any Claude call is made. Catches phone-number typos and confirms possession.
- **Rate limits.** 60/h and 500/d by default; configurable.
- **Body truncation.** Inbound bodies are capped at `maxInboundBytes`.
- **Machine-scoped settings.** Tokens, CLI path, and allowed numbers cannot be overridden by a workspace's `.vscode/settings.json`.
- **Group messages dropped.** All gateways: group chats are ignored.

### The unfixable risk

The agent has the same tools Claude Code gave it. Anyone who can send messages from the allowed identifier drives your agent with whatever permissions it already has — bash, file edits, web fetches, MCP servers. Treat the allowed identifier (your phone, your Telegram account, your Discord user) like an SSH key.

## Detailed setup per gateway

### Telegram

1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → pick name + username → copy token.
2. Talk to [@userinfobot](https://t.me/userinfobot) → it replies with your numeric ID.
3. VSCode settings → `claudeEcho.telegram.botToken` → paste.
4. Run **Bind Claude Code sessions…** → pick Telegram → paste your user ID.

### Discord

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → New Application.
2. Bot tab → **Add Bot** → Reset Token → copy.
3. Privileged Gateway Intents → enable **MESSAGE CONTENT INTENT**.
4. OAuth2 → URL Generator → scopes `bot`, permissions `Send Messages`, `Read Message History` — open the URL and authorize the bot (you can install it to no server if it's just for DMs).
5. VSCode settings → `claudeEcho.discord.botToken` → paste.
6. In Discord (Settings → Advanced → enable Developer Mode), right-click your name → Copy User ID.
7. Run **Bind Claude Code sessions…** → pick Discord → paste your user ID.

### Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch.
2. Socket Mode → Enable → generate app-level token with `connections:write` (starts `xapp-…`).
3. OAuth & Permissions → bot scopes: `chat:write`, `im:history`, `im:read`, `im:write` → install to workspace → copy bot token (starts `xoxb-…`).
4. Event Subscriptions → enable → subscribe to bot events: `message.im`.
5. VSCode settings → `claudeEcho.slack.appToken` and `claudeEcho.slack.botToken` → paste both.
6. In Slack, open your profile → ⋯ → **Copy member ID** (starts with `U…`).
7. Run **Bind Claude Code sessions…** → pick Slack → paste your member ID.

### WhatsApp

1. Run **Bind Claude Code sessions…** → pick WhatsApp → enter your number in E.164.
2. A verification code shows in the notification. Note it.
3. Click **Start bridge**. A QR panel appears.
4. WhatsApp on your phone → Settings → Linked Devices → Link a Device → scan.
5. Once linked, send the verification code from your phone via WhatsApp to your own number.
6. Reply "Number verified ✓" confirms the bridge is live.

## Requirements

- VSCode `1.85` or newer
- [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension
- Claude Code CLI on PATH (`claude --version` should work)

## About Codenzia

[Codenzia](https://codenzia.com) builds developer tooling and SaaS infrastructure on the Laravel + Filament stack. Companion extension: [Claude Tabs](https://github.com/Codenzia/claude-tabs-vscode) — snapshot and restore Claude Code tab sets across VSCode restarts.

## License

MIT — see [LICENSE](LICENSE).
