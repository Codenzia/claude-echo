# Claude WhatsApp Bridge

> Chat with your Claude Code agent from WhatsApp. Developed by [**Codenzia**](https://codenzia.com).

Bind a Claude Code session running in your VSCode workspace to your WhatsApp number, and talk to your agent from anywhere — your phone, a borrowed laptop, your kitchen — by texting yourself. Replies appear on WhatsApp; the conversation is recorded in the same Claude Code transcript you can open in the IDE later.

## How it works

```
WhatsApp message (from your allowlisted number)
   │
   ▼
Baileys WebSocket client embedded in the extension
   │
   ▼
claude --print --resume <sessionId> --output-format json "<your text>"
   │     (appends to ~/.claude/projects/.../<sessionId>.jsonl on disk)
   ▼
Assistant response captured from CLI stdout
   │
   ▼
Baileys.sendText(your number, reply)
```

The IDE tab for the bound session shows the new exchanges next time it's opened — there is no live-refresh of an open tab (the Claude Code extension does not expose an inject-message API at this time).

## Quick start

1. **Install** this extension and the [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension.
2. Open at least one Claude Code conversation in the workspace you want to bind.
3. Click the **WhatsApp bubble icon** in the Activity Bar → **Bind a Claude Code session**.
4. Pick the session. Enter your phone number in E.164 (e.g. `+15551234567`). VSCode will display a **verification code** like `XK7-9PQ`.
5. Click **Start bridge**. A QR-code panel opens — scan it from **WhatsApp → Settings → Linked Devices → Link a Device**.
6. **Send the verification code** from your phone via WhatsApp to your own number. The bridge replies "Number verified ✓" and is now active.
7. From this point on, any message you send to your own number is forwarded to your Claude agent and the reply comes back.

After the first scan, the auth is cached under the extension's global storage, so subsequent restarts skip the QR step. After verification, the bridge remembers the binding is trusted; you only need to re-verify if you re-bind or rotate the code.

## Commands

| Command | Description |
| --- | --- |
| `Claude WhatsApp: Bind a Claude Code session…` | Pick a running session and tie it to your WhatsApp number |
| `Claude WhatsApp: Unbind current session` | Stop and remove the binding |
| `Claude WhatsApp: Start bridge` / `Stop bridge` | Manual control |
| `Claude WhatsApp: Show WhatsApp QR code` | Reveal the QR panel for first-time or re-auth |
| `Claude WhatsApp: Send test message` | Sends a `[bridge] test` message to verify outbound path |
| `Claude WhatsApp: Show logs` | Open the diagnostic Output Channel |
| `Claude WhatsApp: Show verification code` | Reveal the current pending verification code |
| `Claude WhatsApp: Regenerate verification code` | Issue a fresh code (e.g. if the previous one expired) |

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `claudeWhatsApp.allowedNumber` | `""` | Single E.164 phone number permitted to message Claude. Anything else is dropped. |
| `claudeWhatsApp.claudeCliPath` | `"claude"` | Path to the Claude Code CLI binary. |
| `claudeWhatsApp.responseTimeoutMs` | `120000` | Max time to wait for a Claude reply before sending a timeout error to WhatsApp. |
| `claudeWhatsApp.autoStart` | `false` | Auto-start the bridge on activation when a **verified** binding exists. Off by default for safety. |
| `claudeWhatsApp.maxMessagesPerHour` | `60` | Drop inbound messages above this rate. `0` disables. |
| `claudeWhatsApp.maxMessagesPerDay` | `500` | Same, rolling 24-hour window. |
| `claudeWhatsApp.maxInboundBytes` | `4096` | Truncate inbound message bodies to this many bytes to cap per-message Claude cost. |
| `claudeWhatsApp.verboseLogging` | `false` | Log full message bodies. Off by default — logs and the activity tree only show an 8-char prefix to avoid leaking chat content if you share diagnostics. |

## Security

The bridge has several layers of defense, but you should understand each one.

### Allowlist + verification challenge

Only the single phone number configured in `claudeWhatsApp.allowedNumber` is accepted as a sender. On first bind, the extension issues a one-time alphanumeric **verification code** (e.g. `XK7-9PQ`) that you must echo back via WhatsApp from the configured number before any messages are forwarded to Claude. This catches the most common mistake — typing the wrong number — and confirms you actually control the phone.

Codes expire 30 minutes after issue. Run **Claude WhatsApp: Regenerate verification code** to issue a fresh one.

### Settings are user/machine-scoped

`claudeWhatsApp.claudeCliPath` and `claudeWhatsApp.allowedNumber` cannot be overridden by a workspace's `.vscode/settings.json`. A malicious workspace can't redirect the bridge to a different CLI binary or change which phone number is allowed.

### Rate limits

Default 60 messages/hour and 500/day are enforced before any Claude CLI invocation. If a sender's account is compromised, the blast radius (and Claude billing exposure) is capped. Adjust via `claudeWhatsApp.maxMessagesPerHour` / `maxMessagesPerDay`.

### Message body truncation

Inbound bodies above `claudeWhatsApp.maxInboundBytes` (default 4 KB) are truncated before being sent to Claude.

### Group messages

Always dropped. Group chats can have ~256 members, any of whom could "speak as" the senders.

### WhatsApp auth state on disk

After scanning the QR, Baileys persists multi-device auth keys at:

- Windows: `%APPDATA%\Code\User\globalStorage\codenzia.claude-whatsapp-bridge\wa-auth\`
- macOS: `~/Library/Application Support/Code/User/globalStorage/codenzia.claude-whatsapp-bridge/wa-auth/`
- Linux: `~/.config/Code/User/globalStorage/codenzia.claude-whatsapp-bridge/wa-auth/`

Anyone who can read this directory can act as a linked WhatsApp device tied to your account. NTFS / POSIX user-only perms are the only protection. If you suspect leakage: open WhatsApp on your phone → Linked Devices → unlink the "Claude WhatsApp Bridge" entry; the extension will require a fresh QR scan.

### The unfixable risk

WhatsApp **is** the auth boundary. Anyone messaging from the allowed number drives your Claude agent with whatever tools that workspace's Claude Code has (Bash, Edit, Web, MCP). Treat that phone number / WhatsApp session like an SSH key.

## Risks you should know about

1. **WhatsApp Terms of Service** — [Baileys](https://github.com/WhiskeySockets/Baileys) speaks the WhatsApp multi-device WebSocket protocol directly (no browser automation). Like all unofficial WhatsApp clients, using it may violate WhatsApp's ToS, and your account could in theory be suspended. Use at your own risk.
2. **Cost** — every inbound message kicks off one Claude API turn. If a malicious party gets hold of your phone number / SIM, the bill is yours.
3. **Footprint** — small. Baileys is a pure-WebSocket library with no Chromium dependency (~5 MB extension install vs. ~150 MB for Puppeteer-based alternatives).
4. **No real-time IDE display** — the IDE tab for the bound session does not auto-refresh when WhatsApp messages arrive. Close and reopen the tab to see the latest transcript.
5. **Concurrency** — don't actively type into the IDE tab while messages are flowing via WhatsApp. The two writers share a `.jsonl` transcript and can race.

## Requirements

- VSCode `1.85` or newer
- [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension
- Claude Code CLI installed and on your `PATH` (or path configured in settings)

## About Codenzia

[Codenzia](https://codenzia.com) builds developer tooling and SaaS infrastructure on the Laravel + Filament stack. Companion extension: [Claude Tabs](https://github.com/Codenzia/claude-tabs-vscode) — snapshot and restore your Claude Code tabs across VSCode restarts.

## License

MIT — see [LICENSE](LICENSE).
