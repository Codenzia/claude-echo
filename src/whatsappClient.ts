import * as vscode from 'vscode';
import * as fs from 'fs';
import { logError, logInfo, logWarn } from './logger';
import { Gateway, GatewayKind, GatewayStatus, IncomingMessage } from './gateway';

export interface WaConfig {
  authDir: string;
}

type BaileysModule = typeof import('@whiskeysockets/baileys');

function loadBaileys(): BaileysModule {
  return require('@whiskeysockets/baileys');
}

function digits(s: string): string {
  return (s || '').replace(/[^\d]/g, '');
}

function extractText(message: any): string {
  if (!message) { return ''; }
  if (typeof message.conversation === 'string' && message.conversation) { return message.conversation; }
  if (message.extendedTextMessage?.text) { return String(message.extendedTextMessage.text); }
  if (message.imageMessage?.caption) { return String(message.imageMessage.caption); }
  if (message.videoMessage?.caption) { return String(message.videoMessage.caption); }
  if (message.documentMessage?.caption) { return String(message.documentMessage.caption); }
  return '';
}

function silentLogger(): any {
  const noop = () => undefined;
  const self: any = {
    level: 'silent',
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => self
  };
  return self;
}

/** Map Baileys DisconnectReason status code → human-readable name (best-effort). */
function reasonName(b: any, code?: number): string {
  if (code === undefined || !b?.DisconnectReason) { return '(no code)'; }
  const dr = b.DisconnectReason;
  const entry = Object.entries(dr).find(([_, v]) => v === code);
  return entry ? entry[0] : String(code);
}

export class WhatsAppClient implements Gateway {
  readonly kind: GatewayKind = 'whatsapp';
  private status: GatewayStatus = 'idle';
  private sock?: any;
  private latestQr?: string;
  private cfg: WaConfig;
  private shuttingDown = false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private readonly _onStatus = new vscode.EventEmitter<GatewayStatus>();
  private readonly _onQr = new vscode.EventEmitter<string>();
  private readonly _onMessage = new vscode.EventEmitter<IncomingMessage>();
  readonly onStatus = this._onStatus.event;
  readonly onQr = this._onQr.event;
  readonly onMessage = this._onMessage.event;

  constructor(cfg: WaConfig) { this.cfg = cfg; }

  getStatus(): GatewayStatus { return this.status; }
  getLatestQr(): string | undefined { return this.latestQr; }

  private setStatus(s: GatewayStatus): void {
    this.status = s;
    this._onStatus.fire(s);
  }

  async start(): Promise<void> {
    if (this.status === 'starting' || this.status === 'ready') {
      logInfo(`WhatsApp start() called while status=${this.status}; ignoring.`);
      return;
    }
    this.shuttingDown = false;
    this.setStatus('starting');
    try {
      fs.mkdirSync(this.cfg.authDir, { recursive: true });
      const baileys: any = loadBaileys();
      const { state, saveCreds } = await baileys.useMultiFileAuthState(this.cfg.authDir);
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
        browser: ['Claude Bridge', 'Chrome', '1.0']
      });

      this.sock.ev.on('creds.update', saveCreds);
      this.sock.ev.on('connection.update', (u: any) => this.handleConnectionUpdate(u, baileys));
      this.sock.ev.on('messages.upsert', (m: any) => this.handleIncoming(m));

      logInfo(`Baileys started (authDir=${this.cfg.authDir})`);
    } catch (err) {
      this.setStatus('error');
      logError('Failed to start Baileys', err);
      throw err;
    }
  }

  private handleConnectionUpdate(u: any, baileys: any): void {
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
      this.reconnectAttempt = 0;
      this.setStatus('ready');
      logInfo('WhatsApp bridge listening.');
    } else if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      const name = reasonName(baileys, code);
      const reason = u.lastDisconnect?.error?.message ?? '';
      logWarn(`WhatsApp connection closed: ${name} (code=${code}); ${reason}`);
      this.sock = undefined;
      if (this.shuttingDown) {
        this.setStatus('idle');
        return;
      }
      if (code === baileys.DisconnectReason?.loggedOut) {
        logWarn('Device unlinked remotely; clearing cached auth state.');
        try { fs.rmSync(this.cfg.authDir, { recursive: true, force: true }); } catch { /* ignore */ }
        this.latestQr = undefined;
        this.setStatus('idle');
        return;
      }
      this.setStatus('connecting');
      // Exponential backoff: 2s, 4s, 8s, 16s, capped at 30s.
      this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 5);
      const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempt - 1), 30_000);
      this.reconnectTimer = setTimeout(() => {
        this.status = 'idle';
        this.start().catch((err) => logError('Reconnect failed', err));
      }, delay);
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
      const senderId = digits(remoteJid.split('@')[0]);
      const ts = typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp * 1000 : Date.now();
      this._onMessage.fire({ from: remoteJid, senderId, body, isGroup, timestamp: ts });
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
    this.reconnectAttempt = 0;
    if (!this.sock) {
      this.setStatus('idle');
      return;
    }
    this.shuttingDown = true;
    this.setStatus('stopping');
    try { this.sock.end(undefined); }
    catch (err) { logWarn(`Baileys end() raised: ${err instanceof Error ? err.message : err}`); }
    this.sock = undefined;
    this.latestQr = undefined;
    this.setStatus('idle');
    logInfo('WhatsApp bridge stopped.');
  }
}

export function digitsOnly(num: string): string { return digits(num); }
