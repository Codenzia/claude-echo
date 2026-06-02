# Claude WhatsApp Bridge

> Chat with your Claude Code agent from WhatsApp. Developed by [**Codenzia**](https://codenzia.com).

Bind a Claude Code session running in your VSCode workspace to your WhatsApp number, and talk to your agent from anywhere — your phone, a borrowed laptop, your kitchen — by texting yourself. Replies appear on WhatsApp; the conversation is recorded in the same Claude Code transcript you can open in the IDE later.

## How it works

```
WhatsApp message (from your allowlisted number)
   │
   ▼
open-wa client embedded in the extension
   │
   ▼
claude --print --resume <sessionId> --output-format json "<your text>"
   │     (appends to ~/.claude/projects/.../<sessionId>.jsonl on disk)
   ▼
Assistant response captured from CLI stdout
   │
   ▼
open-wa.sendText(your number, reply)
```

The IDE tab for the bound session shows the new exchanges next time it's opened — there is no live-refresh of an open tab (the Claude Code extension does not expose an inject-message API at this time).

## Quick start

1. **Install** this extension and the [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension.
2. Open at least one Claude Code conversation in the workspace you want to bind.
3. Click the **WhatsApp bubble icon** in the Activity Bar → **Bind a Claude Code session**.
4. Pick the session. Enter your phone number in E.164 (e.g. `+15551234567`).
5. Confirm "Start bridge". A QR-code panel opens — scan it from **WhatsApp → Settings → Linked Devices → Link a Device**.
6. Send a WhatsApp message to your own number. Within a few seconds you'll get Claude's reply.

After the first scan, the auth is cached under the extension's global storage, so subsequent restarts skip the QR step.

## Commands

| Command | Description |
| --- | --- |
| `Claude WhatsApp: Bind a Claude Code session…` | Pick a running session and tie it to your WhatsApp number |
| `Claude WhatsApp: Unbind current session` | Stop and remove the binding |
| `Claude WhatsApp: Start bridge` / `Stop bridge` | Manual control |
| `Claude WhatsApp: Show WhatsApp QR code` | Reveal the QR panel for first-time or re-auth |
| `Claude WhatsApp: Send test message` | Sends a `[bridge] test` message to verify outbound path |
| `Claude WhatsApp: Show logs` | Open the diagnostic Output Channel |

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `claudeWhatsApp.allowedNumber` | `""` | Single E.164 phone number permitted to message Claude. Anything else is dropped. |
| `claudeWhatsApp.claudeCliPath` | `"claude"` | Path to the Claude Code CLI binary. |
| `claudeWhatsApp.responseTimeoutMs` | `120000` | Max time to wait for a Claude reply before sending a timeout error to WhatsApp. |
| `claudeWhatsApp.openWa.headless` | `true` | Run the open-wa Chromium controller headless. Disable to debug. |
| `claudeWhatsApp.autoStart` | `true` | Auto-start the bridge on activation when a binding exists. |

## Security

Only the single phone number you configure in `claudeWhatsApp.allowedNumber` can drive your Claude agent through this bridge. Messages from any other sender are silently dropped and logged. **Treat that number like a credential** — anyone who can send WhatsApp messages from it has full access to your agent (and your wallet, since every message costs Claude API tokens).

Group messages are always ignored.

## Risks you should know about

1. **WhatsApp Terms of Service** — `@open-wa/wa-automate` automates the WhatsApp Web client via Puppeteer. This is an unofficial integration and using it may violate WhatsApp's ToS. Your WhatsApp account could in theory be suspended. Use at your own risk.
2. **Cost** — every inbound message kicks off one Claude API turn. If a malicious party gets hold of your phone number / SIM, the bill is yours.
3. **Footprint** — `@open-wa/wa-automate` downloads Chromium (~150 MB) on first run.
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
