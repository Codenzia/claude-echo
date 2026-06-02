# Changelog

## [0.3.0] — 2026-06-02

### Added — multi-session routing
- **Bulk binding.** "Bind Claude Code sessions…" now opens a multi-select picker. Tick every Claude tab you want available; each becomes a tagged session in the workspace.
- **Tags** auto-derived from each session's first user message (e.g. `serveeta`, `bmp`, `dropflow`). Uniqueness enforced per workspace.
- **Active session** concept. One bound session is marked active at any time. Untagged WhatsApp messages route there. Reply prefixed with `[tag]` when more than one session is bound.
- **WhatsApp commands** parsed at the bridge:
  - `/list` — show all bound sessions
  - `/use <tag>` (or `/switch`) — change active
  - `/where` — current active
  - `/help` — list commands
  - `#<tag> <text>` — one-off override that routes a single message without changing active
- **New VSCode commands**: `Change active session…`, `Unbind a single session…`, `Remove workspace binding`.
- **Tree view** shows a new "Sessions" group with star marker on the active one. Clicking a session sets it active.

### Changed
- Verification is now **per-WhatsApp-number**, not per-session. Verify once, and all sessions bound to that number flow.
- `Unbind` now removes the whole workspace binding (all sessions + verified number). Use `Unbind a single session…` to drop just one.

### Migration
- Existing `v0.2.x` bindings are migrated automatically on first load — single binding becomes a workspace with one tagged session, marked active.

## [0.2.1] — 2026-06-02

### Added
- **Verification challenge.** First-time bindings now issue a 6-character code (e.g. `XK7-9PQ`) that must be echoed via WhatsApp from the configured number before any messages are forwarded to Claude. Catches typos in `allowedNumber` and confirms phone possession.
- New commands `Show verification code` and `Regenerate verification code`.
- Rate limiter with `maxMessagesPerHour` (default 60) and `maxMessagesPerDay` (default 500) settings to cap billing exposure.
- `maxInboundBytes` setting (default 4 KB) truncates oversized inbound messages.
- `verboseLogging` setting; when off (default), Activity tree and Output Channel show only an 8-char prefix of message bodies to avoid leaking chat content if logs are shared.

### Changed
- `autoStart` default flipped from `true` to `false`. Even when on, the bridge only auto-starts for *verified* bindings.
- `claudeCliPath` and `allowedNumber` settings are now `machine`-scoped — a workspace's `.vscode/settings.json` cannot override them.
- Claude CLI now invoked with `--` before the prompt, preventing a message body starting with `--` from being parsed as a CLI flag.

## [0.2.0] — 2026-06-02

### Changed
- **Replaced `@open-wa/wa-automate` with `@whiskeysockets/baileys` as the WhatsApp transport.**
  Baileys speaks the WhatsApp multi-device WebSocket protocol directly — no Chromium dependency.
  - Extension install footprint shrinks dramatically (no ~150 MB Puppeteer/Chromium download).
  - Faster cold start: no browser process to spin up.
  - No outbound message branding/nag injected by the library.
  - QR code panel works the same way; auth state cached under the extension's global storage as before.

### Removed
- `claudeWhatsApp.openWa.headless` setting (Baileys has no browser to configure).
- `claudeWhatsApp.openWa.disableSpins` setting.

## [0.1.0] — 2026-06-02

### Initial release

- Bind a running Claude Code session in the current workspace to a single allowed WhatsApp number.
- Embedded [open-wa](https://open-wa.org) (`@open-wa/wa-automate`) client with QR-code panel for first-time authentication; session credentials persisted under the extension's global storage so re-auth isn't needed every launch.
- Incoming WhatsApp messages from the allowlisted number are forwarded to the bound Claude session via `claude --print --resume <sessionId> --output-format json "<text>"`.
- Assistant responses are sent back to the same WhatsApp contact.
- Activity Bar sidebar with `Binding` and `Activity` sections showing current status, allowed number, recent inbound/outbound timestamps, and one-click Start/Stop/Test/Unbind.
- Auto-start on workspace activation when a binding exists.
- Output Channel logging (`Claude WhatsApp`) for diagnostics.
