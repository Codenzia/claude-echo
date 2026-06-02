import * as vscode from 'vscode';
import { logError, logInfo, logWarn } from './logger';
import { Gateway, GatewayKind, GatewayStatus, IncomingMessage } from './gateway';

export interface TelegramConfig {
  botToken: string;
}

const API_BASE = 'https://api.telegram.org';
const LONG_POLL_TIMEOUT_SECONDS = 50;

export class TelegramClient implements Gateway {
  readonly kind: GatewayKind = 'telegram';
  private status: GatewayStatus = 'idle';
  private offset = 0;
  private polling = false;
  private abort?: AbortController;
  private cfg: TelegramConfig;
  private readonly _onStatus = new vscode.EventEmitter<GatewayStatus>();
  private readonly _onQr = new vscode.EventEmitter<string>();
  private readonly _onMessage = new vscode.EventEmitter<IncomingMessage>();
  readonly onStatus = this._onStatus.event;
  readonly onQr = this._onQr.event;
  readonly onMessage = this._onMessage.event;

  constructor(cfg: TelegramConfig) { this.cfg = cfg; }

  getStatus(): GatewayStatus { return this.status; }
  getLatestQr(): undefined { return undefined; }

  private setStatus(s: GatewayStatus): void {
    this.status = s;
    this._onStatus.fire(s);
  }

  private apiUrl(method: string): string {
    return `${API_BASE}/bot${this.cfg.botToken}/${method}`;
  }

  async start(): Promise<void> {
    if (this.status === 'starting' || this.status === 'ready') { return; }
    if (!this.cfg.botToken) {
      this.setStatus('error');
      throw new Error('Telegram bot token is missing.');
    }
    this.setStatus('starting');
    try {
      // Verify token via getMe.
      const me = await this.callApi<any>('getMe', {});
      if (!me?.ok) {
        throw new Error(`getMe failed: ${me?.description ?? 'unknown'}`);
      }
      logInfo(`Telegram bot authenticated as @${me.result?.username} (id=${me.result?.id})`);
      this.setStatus('ready');
      void this.pollLoop();
    } catch (err) {
      this.setStatus('error');
      logError('Failed to start Telegram client', err);
      throw err;
    }
  }

  private async pollLoop(): Promise<void> {
    if (this.polling) { return; }
    this.polling = true;
    while (this.status === 'ready') {
      this.abort = new AbortController();
      try {
        const res = await this.callApi<any>('getUpdates', {
          offset: this.offset,
          timeout: LONG_POLL_TIMEOUT_SECONDS,
          allowed_updates: ['message']
        }, this.abort.signal, (LONG_POLL_TIMEOUT_SECONDS + 5) * 1000);
        if (!res?.ok) {
          logWarn(`getUpdates returned not ok: ${res?.description ?? '(no description)'}`);
          await sleep(2000);
          continue;
        }
        const updates: any[] = res.result ?? [];
        for (const u of updates) {
          this.offset = u.update_id + 1;
          this.handleUpdate(u);
        }
      } catch (err: any) {
        if (this.status !== 'ready') { break; }
        const msg = err?.message ?? String(err);
        if (/abort/i.test(msg)) { break; }
        logWarn(`Telegram poll error: ${msg}`);
        await sleep(2000);
      }
    }
    this.polling = false;
  }

  private handleUpdate(u: any): void {
    const m = u?.message;
    if (!m) { return; }
    const from = m.from;
    if (!from || from.is_bot) { return; }
    const chat = m.chat;
    if (!chat) { return; }
    const isGroup = chat.type !== 'private';
    const body = typeof m.text === 'string' ? m.text : (m.caption ?? '');
    this._onMessage.fire({
      from: String(chat.id),
      senderId: String(from.id),
      body,
      isGroup,
      timestamp: (m.date ?? Math.floor(Date.now() / 1000)) * 1000
    });
  }

  async sendText(to: string, body: string): Promise<void> {
    const res = await this.callApi<any>('sendMessage', { chat_id: to, text: body });
    if (!res?.ok) {
      throw new Error(`Telegram sendMessage failed: ${res?.description ?? 'unknown'}`);
    }
  }

  async stop(): Promise<void> {
    if (this.status === 'idle') { return; }
    this.setStatus('stopping');
    try { this.abort?.abort(); } catch { /* ignore */ }
    this.polling = false;
    this.setStatus('idle');
    logInfo('Telegram client stopped.');
  }

  private async callApi<T>(method: string, payload: any, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs) { timer = setTimeout(() => controller.abort(), timeoutMs); }
    const combinedAbort = signal ? anySignal(signal, controller.signal) : controller.signal;
    try {
      const res = await fetch(this.apiUrl(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: combinedAbort
      });
      return await res.json() as T;
    } finally {
      if (timer) { clearTimeout(timer); }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const c = new AbortController();
  if (a.aborted || b.aborted) { c.abort(); return c.signal; }
  a.addEventListener('abort', () => c.abort());
  b.addEventListener('abort', () => c.abort());
  return c.signal;
}
