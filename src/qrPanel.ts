import * as vscode from 'vscode';
import * as QRCode from 'qrcode';

let panel: vscode.WebviewPanel | undefined;
let lastRawQr: string | undefined;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function htmlFor(qr: string | undefined, status: string): Promise<string> {
  let svg = '';
  if (qr) {
    svg = await QRCode.toString(qr, { type: 'svg', margin: 2, width: 320, color: { dark: '#0B141A', light: '#FFFFFF' } });
  }
  const body = qr
    ? `${svg}<p class="hint">Open WhatsApp on your phone → Settings → Linked Devices → Link a Device.</p>`
    : '<p class="hint">Waiting for the open-wa client to produce a QR code…</p>';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; padding: 24px; text-align: center; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
  h1 { margin: 0 0 12px; font-size: 18px; }
  .status { opacity: 0.8; margin-bottom: 24px; }
  .hint { opacity: 0.7; max-width: 360px; margin: 16px auto 0; font-size: 13px; line-height: 1.5; }
  svg { background: white; padding: 12px; border-radius: 8px; }
  .codenzia { margin-top: 32px; font-size: 11px; opacity: 0.5; }
  .codenzia a { color: inherit; }
</style>
</head>
<body>
  <h1>Claude WhatsApp Bridge</h1>
  <div class="status">${escapeHtml(status)}</div>
  ${body}
  <div class="codenzia">Developed by <a href="https://codenzia.com">Codenzia</a></div>
</body>
</html>`;
}

export async function showQrPanel(rawQr: string | undefined, status: string): Promise<void> {
  lastRawQr = rawQr ?? lastRawQr;
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'claudeWhatsApp.qr',
      'Claude WhatsApp QR',
      vscode.ViewColumn.Active,
      { enableScripts: false, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => { panel = undefined; });
  }
  panel.webview.html = await htmlFor(lastRawQr, status);
  panel.reveal();
}

export function updateQrPanel(rawQr: string | undefined, status: string): Thenable<void> | void {
  if (rawQr) { lastRawQr = rawQr; }
  if (!panel) { return; }
  return htmlFor(lastRawQr, status).then((h) => {
    if (panel) { panel.webview.html = h; }
  });
}
