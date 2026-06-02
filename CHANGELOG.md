# Changelog

## [0.1.0] — 2026-06-02

### Initial release

- Bind a running Claude Code session in the current workspace to a single allowed WhatsApp number.
- Embedded [open-wa](https://open-wa.org) (`@open-wa/wa-automate`) client with QR-code panel for first-time authentication; session credentials persisted under the extension's global storage so re-auth isn't needed every launch.
- Incoming WhatsApp messages from the allowlisted number are forwarded to the bound Claude session via `claude --print --resume <sessionId> --output-format json "<text>"`.
- Assistant responses are sent back to the same WhatsApp contact.
- Activity Bar sidebar with `Binding` and `Activity` sections showing current status, allowed number, recent inbound/outbound timestamps, and one-click Start/Stop/Test/Unbind.
- Auto-start on workspace activation when a binding exists.
- Output Channel logging (`Claude WhatsApp`) for diagnostics.
