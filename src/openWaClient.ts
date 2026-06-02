import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logError, logInfo, logWarn } from './logger';

export interface IncomingMessage {
  from: string;
  fromNumber: string;
  body: string;
  isGroup: boolean;
  timestamp: number;
}

export interface OpenWaConfig {
  sessionDataDir: string;
  headless: boolean;
  disableSpins: boolean;
}

export type OpenWaStatus = 'idle' | 'starting' | 'qr' | 'authenticated' | 'ready' | 'stopping' | 'error';

type OpenWaModule = typeof import('@open-wa/wa-automate');
type OpenWaInstance = Awaited<ReturnType<OpenWaModule['create']>>;

function loadOpenWa(): OpenWaModule {
  return require('@open-wa/wa-automate') as OpenWaModule;
}

function digits(s: string): string {
  return (s || '').replace(/[^\d]/g, '');
}

export class OpenWaClient {
  private status: OpenWaStatus = 'idle';
  private client?: OpenWaInstance;
  private latestQr?: string;
  private readonly _onStatus = new vscode.EventEmitter<OpenWaStatus>();
  private readonly _onQr = new vscode.EventEmitter<string>();
  private readonly _onMessage = new vscode.EventEmitter<IncomingMessage>();
  readonly onStatus = this._onStatus.event;
  readonly onQr = this._onQr.event;
  readonly onMessage = this._onMessage.event;

  getStatus(): OpenWaStatus { return this.status; }
  getLatestQr(): string | undefined { return this.latestQr; }

  private setStatus(s: OpenWaStatus): void {
    this.status = s;
    this._onStatus.fire(s);
  }

  async start(cfg: OpenWaConfig): Promise<void> {
    if (this.status === 'starting' || this.status === 'ready') {
      logInfo(`start() called while status=${this.status}; ignoring.`);
      return;
    }
    this.setStatus('starting');
    try {
      fs.mkdirSync(cfg.sessionDataDir, { recursive: true });
      const wa = loadOpenWa();
      logInfo(`Booting open-wa (sessionDataDir=${cfg.sessionDataDir}, headless=${cfg.headless})`);
      this.client = await wa.create({
        sessionId: 'claude-bridge',
        sessionDataPath: cfg.sessionDataDir,
        headless: cfg.headless,
        disableSpins: cfg.disableSpins,
        qrTimeout: 0,
        authTimeout: 0,
        cacheEnabled: false,
        chromiumArgs: ['--no-sandbox', '--disable-setuid-sandbox'],
        qrCallback: (qr: string) => {
          this.latestQr = qr;
          this.setStatus('qr');
          this._onQr.fire(qr);
          logInfo('open-wa emitted QR code (scan with WhatsApp on your phone).');
        }
      } as any);
      this.setStatus('authenticated');
      logInfo('open-wa session authenticated.');

      await this.client.onMessage((m: any) => {
        if (!m) { return; }
        if (m.fromMe) { return; }
        const fromRaw: string = m.from ?? '';
        const fromNumber = digits(fromRaw);
        const msg: IncomingMessage = {
          from: fromRaw,
          fromNumber,
          body: typeof m.body === 'string' ? m.body : '',
          isGroup: !!m.isGroupMsg,
          timestamp: typeof m.t === 'number' ? m.t * 1000 : Date.now()
        };
        this._onMessage.fire(msg);
      });

      this.setStatus('ready');
      logInfo('Bridge listening for WhatsApp messages.');
    } catch (err) {
      this.setStatus('error');
      logError('Failed to start open-wa', err);
      throw err;
    }
  }

  async sendText(toRaw: string, body: string): Promise<void> {
    if (!this.client) {
      throw new Error('open-wa client is not started.');
    }
    const to = toRaw.includes('@') ? toRaw : `${digits(toRaw)}@c.us`;
    try {
      await this.client.sendText(to as any, body);
    } catch (err) {
      logError(`sendText failed to=${to}`, err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.client) {
      this.setStatus('idle');
      return;
    }
    this.setStatus('stopping');
    try {
      await this.client.kill();
    } catch (err) {
      logWarn(`open-wa kill() raised: ${err instanceof Error ? err.message : err}`);
    }
    this.client = undefined;
    this.latestQr = undefined;
    this.setStatus('idle');
    logInfo('Bridge stopped.');
  }
}

export function digitsOnly(num: string): string {
  return digits(num);
}
