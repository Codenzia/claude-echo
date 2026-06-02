import * as vscode from 'vscode';
import * as fs from 'fs';
import { logError, logInfo, logWarn } from './logger';

export interface IncomingMessage {
  from: string;
  fromNumber: string;
  body: string;
  isGroup: boolean;
  timestamp: number;
}

export interface WaConfig {
  authDir: string;
}

export type WaStatus =
  | 'idle'
  | 'starting'
  | 'qr'
  | 'connecting'
  | 'ready'
  | 'stopping'
  | 'error';

type BaileysModule = typeof import('@whiskeysockets/baileys');

function loadBaileys(): BaileysModule {
  // CommonJS require; types are picked up from the package
  return require('@whiskeysockets/baileys');
}

function digits(s: string): string {
  return (s || '').replace(/[^\d]/g, '');
}

function extractText(message: any): string {
  if (!message) { return ''; }
  if (typeof message.conversation === 'string' && message.conversation) {
    return message.conversation;
  }
  if (message.extendedTextMessage?.text) { return String(message.extendedTextMessage.text); }
  if (message.imageMessage?.caption) { return String(message.imageMessage.caption); }
  if (message.videoMessage?.caption) { return String(message.videoMessage.caption); }
  if (message.documentMessage?.caption) { return String(message.documentMessage.caption); }
  return '';
}

// Minimal silent logger that satisfies the pino-compatible shape Baileys expects.
function silentLogger(): any {
  const noop = () => undefined;
  const self: any = {
    level: 'silent',
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => self
  };
  return self;
}

export class WhatsAppClient {
  private status: WaStatus = 'idle';
  private sock?: any;
  private latestQr?: string;
  private cfg?: WaConfig;
  private shuttingDown = false;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly _onStatus = new vscode.EventEmitter<WaStatus>();
  private readonly _onQr = new vscode.EventEmitter<string>();
  private readonly _onMessage = new vscode.EventEmitter<IncomingMessage>();
  readonly onStatus = this._onStatus.event;
  readonly onQr = this._onQr.event;
  readonly onMessage = this._onMessage.event;

  getStatus(): WaStatus { return this.status; }
  getLatestQr(): string | undefined { return this.latestQr; }

  private setStatus(s: WaStatus): void {
    this.status = s;
    this._onStatus.fire(s);
  }

  async start(cfg: WaConfig): Promise<void> {
    if (this.status === 'starting' || this.status === 'ready') {
      logInfo(`start() called while status=${this.status}; ignoring.`);
      return;
    }
    this.cfg = cfg;
    this.shuttingDown = false;
    this.setStatus('starting');
    try {
      fs.mkdirSync(cfg.authDir, { recursive: true });
      const baileys: any = loadBaileys();
      const { state, saveCreds } = await baileys.useMultiFileAuthState(cfg.authDir);
      let version: number[] | undefined;
      try {
        const v = await baileys.fetchLatestBaileysVersion();
        version = v.version;
      } catch (err) {
        logWarn(`fetchLatestBaileysVersion failed (using bundled default): ${err instanceof Error ? err.message : err}`);
      }

      const makeSocket = baileys.makeWASocket ?? baileys.default;
      this.sock = makeSocket({
        auth: state,
        printQRInTerminal: false,
        version,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        logger: silentLogger(),
        browser: ['Claude WhatsApp Bridge', 'Chrome', '1.0']
      });

      this.sock.ev.on('creds.update', saveCreds);
      this.sock.ev.on('connection.update', (u: any) => this.handleConnectionUpdate(u));
      this.sock.ev.on('messages.upsert', (m: any) => this.handleIncoming(m));

      logInfo(`Baileys started (authDir=${cfg.authDir})`);
    } catch (err) {
      this.setStatus('error');
      logError('Failed to start Baileys', err);
      throw err;
    }
  }

  private handleConnectionUpdate(u: any): void {
    if (u.qr) {
      this.latestQr = u.qr;
      this.setStatus('qr');
      this._onQr.fire(u.qr);
      logInfo('Baileys emitted QR code (scan with WhatsApp on your phone).');
    }
    if (u.connection === 'connecting') {
      if (this.status !== 'qr') { this.setStatus('connecting'); }
    } else if (u.connection === 'open') {
      this.latestQr = undefined;
      this.setStatus('ready');
      logInfo('Bridge listening for WhatsApp messages.');
    } else if (u.connection === 'close') {
      const baileys: any = loadBaileys();
      const code = u.lastDisconnect?.error?.output?.statusCode;
      const reason = u.lastDisconnect?.error?.message ?? '';
      logWarn(`WhatsApp connection closed (code=${code}, reason=${reason}).`);
      this.sock = undefined;
      if (this.shuttingDown) {
        this.setStatus('idle');
        return;
      }
      if (code === baileys.DisconnectReason?.loggedOut) {
        logWarn('Device unlinked remotely; clearing cached auth state.');
        if (this.cfg) {
          try { fs.rmSync(this.cfg.authDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        this.setStatus('idle');
        return;
      }
      this.setStatus('connecting');
      const cfg = this.cfg;
      if (!cfg) { return; }
      this.reconnectTimer = setTimeout(() => {
        this.status = 'idle';
        this.start(cfg).catch((err) => logError('Reconnect failed', err));
      }, 2000);
    }
  }

  private handleIncoming(m: any): void {
    if (!m || m.type !== 'notify' || !Array.isArray(m.messages)) { return; }
    for (const msg of m.messages) {
      if (!msg?.message) { continue; }
      if (msg.key?.fromMe) { continue; }
      const remoteJid: string = msg.key?.remoteJid ?? '';
      if (!remoteJid) { continue; }
      const isGroup = remoteJid.endsWith('@g.us');
      const body = extractText(msg.message);
      const fromNumber = digits(remoteJid.split('@')[0]);
      const ts = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp * 1000 : Date.now();
      this._onMessage.fire({ from: remoteJid, fromNumber, body, isGroup, timestamp: ts });
    }
  }

  async sendText(toRaw: string, body: string): Promise<void> {
    if (!this.sock) { throw new Error('WhatsApp client is not running.'); }
    const jid = toRaw.includes('@') ? toRaw : `${digits(toRaw)}@s.whatsapp.net`;
    try {
      await this.sock.sendMessage(jid, { text: body });
    } catch (err) {
      logError(`sendText failed to=${jid}`, err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (!this.sock) {
      this.setStatus('idle');
      return;
    }
    this.shuttingDown = true;
    this.setStatus('stopping');
    try {
      if (typeof this.sock.logout === 'function' && this.status === 'ready') {
        // logout would unlink the device; we only want to disconnect — use end() instead
      }
      this.sock.end(undefined);
    } catch (err) {
      logWarn(`Baileys end() raised: ${err instanceof Error ? err.message : err}`);
    }
    this.sock = undefined;
    this.latestQr = undefined;
    this.setStatus('idle');
    logInfo('Bridge stopped.');
  }
}

export function digitsOnly(num: string): string {
  return digits(num);
}
