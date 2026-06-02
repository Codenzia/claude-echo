import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getLogger(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Claude WhatsApp');
  }
  return channel;
}

function ts(): string {
  return new Date().toISOString();
}

export function logInfo(message: string): void {
  getLogger().appendLine(`[${ts()}] INFO  ${message}`);
}

export function logWarn(message: string): void {
  getLogger().appendLine(`[${ts()}] WARN  ${message}`);
}

export function logError(message: string, err?: unknown): void {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : (err !== undefined ? String(err) : '');
  getLogger().appendLine(`[${ts()}] ERROR ${message}${detail ? '\n' + detail : ''}`);
}
