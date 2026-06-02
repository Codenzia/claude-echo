# Changelog

## [0.4.0] — 2026-06-03

### Renamed
- **Extension renamed from "Claude WhatsApp Bridge" to "Claude Echo".** New ID: `codenzia.claude-echo`. Settings namespace: `claudeEcho.*`. Repository: `Codenzia/claude-echo`. Bindings from prior `claudeWhatsApp.*` / `claudeBridge.*` namespaces are auto-migrated on first activation.

### Added — multi-gateway
- **Three new messaging gateways** alongside WhatsApp:
  - **Telegram** — via `getUpdates` long-poll. No QR, no Chromium, no Puppeteer. Requires a bot token from `@BotFather`. Recommended for most users.
  - **Discord** — via `discord.js`. Bot DMs you. Requires bot token and the `MESSAGE_CONTENT` privileged intent.
  - **Slack** — via Socket Mode (`@slack/socket-mode` + `@slack/web-api`). Requires an app-level token (`xapp-…`) and bot token (`xoxb-…`).
- **Gateway picker** at bind time — choose Telegram / Discord / Slack / WhatsApp per workspace.
- **`Gateway` abstraction** in [src/gateway.ts](src/gateway.ts) — every client implements the same `start/onMessage/onStatus/sendText/stop` surface; rest of the extension is gateway-agnostic.
- **Reset gateway auth** command — wipes cached WhatsApp credentials and restarts cleanly. Useful when WhatsApp link state gets stuck.

### Changed
- Verification challenge now applies **only to WhatsApp** (the only gateway where the sender ID is a phone number that could be typo'd). For Telegram/Discord/Slack the user types their own numeric user ID into VSCode, so the binding is verified immediately.
- New marketplace icon: speech bubble with concentric echo pulses on a dark slate background.
- Welcome view, command titles, settings descriptions all updated for the new branding.

### Removed
- `claudeWhatsApp.allowedNumber` setting (now stored per-binding as `allowedId`).

### Migration notes
- Existing v0.3.x bindings keep their sessions and active pointer; they're auto-tagged as the WhatsApp gateway.
- WhatsApp `wa-auth` directory location is unchanged.

## [0.3.1] — 2026-06-02

### Added
- `Reset WhatsApp auth` command for when the linked-device state gets stuck.

## [0.3.0] — 2026-06-02

### Added — multi-session routing
- Bulk binding via multi-select picker.
- Auto-derived per-session tags (e.g. `serveeta`, `bmp`).
- Active session pointer + `/list`, `/use`, `/where`, `/help`, `#<tag>` commands.
- Tree view "Sessions" group with star marker on active.

## [0.2.1] — 2026-06-02

### Added
- WhatsApp verification challenge.
- Rate limiter, body truncation, body redaction.

### Changed
- `claudeCliPath` and `allowedNumber` made machine-scoped.

## [0.2.0] — 2026-06-02

### Changed
- Replaced `@open-wa/wa-automate` with `@whiskeysockets/baileys` (pure WebSocket, no Chromium).

## [0.1.0] — 2026-06-02

### Initial release
- WhatsApp bridge to Claude Code via open-wa.
- Single binding per workspace; named verification challenge; sidebar tree view.
