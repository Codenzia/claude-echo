import * as vscode from 'vscode';
import { logError, logInfo, logWarn } from './logger';
import { Gateway, GatewayKind, GatewayStatus, IncomingMessage } from './gateway';

export interface SlackConfig {
  /** App-level token starting with `xapp-` — needed for Socket Mode. */
  appToken: string;
  /** Bot token starting with `xoxb-` — needed to send messages. */
  botToken: string;
}

type SocketModeModule = typeof import('@slack/socket-mode');
type WebApiModule = typeof import('@slack/web-api');

function loadSocketMode(): SocketModeModule { return require('@slack/socket-mode'); }
function loadWebApi(): WebApiModule { return require('@slack/web-api'); }

export class SlackClient implements Gateway {
  readonly kind: GatewayKind = 'slack';
  private status: GatewayStatus = 'idle';
  private socketClient?: any;
  private webClient?: any;
  private cfg: SlackConfig;
  private botUserId?: string;
  private readonly _onStatus = new vscode.EventEmitter<GatewayStatus>();
  private readonly _onQr = new vscode.EventEmitter<string>();
  private readonly _onMessage = new vscode.EventEmitter<IncomingMessage>();
  readonly onStatus = this._onStatus.event;
  readonly onQr = this._onQr.event;
  readonly onMessage = this._onMessage.event;

  constructor(cfg: SlackConfig) { this.cfg = cfg; }

  getStatus(): GatewayStatus { return this.status; }
  getLatestQr(): undefined { return undefined; }

  private setStatus(s: GatewayStatus): void {
    this.status = s;
    this._onStatus.fire(s);
  }

  async start(): Promise<void> {
    if (this.status === 'starting' || this.status === 'ready') { return; }
    if (!this.cfg.appToken || !this.cfg.botToken) {
      this.setStatus('error');
      throw new Error('Slack appToken (xapp-...) and botToken (xoxb-...) are both required.');
    }
    this.setStatus('starting');
    try {
      const { WebClient } = loadWebApi();
      const { SocketModeClient } = loadSocketMode();
      this.webClient = new WebClient(this.cfg.botToken);

      // Determine our bot user id so we can ignore self-messages.
      try {
        const auth = await this.webClient.auth.test({});
        this.botUserId = auth.user_id ?? undefined;
        logInfo(`Slack bot authenticated as ${auth.user} (id=${auth.user_id})`);
      } catch (err) {
        logWarn(`Slack auth.test failed: ${err instanceof Error ? err.message : err}`);
      }

      this.socketClient = new SocketModeClient({ appToken: this.cfg.appToken });

      this.socketClient.on('connecting', () => this.setStatus('connecting'));
      this.socketClient.on('connected', () => this.setStatus('ready'));
      this.socketClient.on('disconnected', () => {
        if (this.status === 'ready') { this.setStatus('connecting'); }
      });
      this.socketClient.on('unable_to_socket_mode_start', (err: any) => {
        logError('Slack unable_to_socket_mode_start', err);
        this.setStatus('error');
      });

      this.socketClient.on('message', async ({ event, ack }: any) => {
        try { await ack?.(); }
        catch { /* ignore */ }
        try { this.handleEvent(event); }
        catch (err) { logError('Slack message handler failed', err); }
      });

      await this.socketClient.start();
    } catch (err) {
      this.setStatus('error');
      logError('Failed to start Slack client', err);
      throw err;
    }
  }

  private handleEvent(event: any): void {
    if (!event || event.type !== 'message') { return; }
    if (event.subtype) { return; } // Ignore edits, deletions, channel-join, etc.
    if (event.bot_id) { return; }
    if (this.botUserId && event.user === this.botUserId) { return; }
    const isGroup = event.channel_type !== 'im';
    const body = typeof event.text === 'string' ? event.text : '';
    const ts = event.ts ? Number(String(event.ts).split('.')[0]) * 1000 : Date.now();
    this._onMessage.fire({
      from: event.channel,
      senderId: event.user,
      body,
      isGroup,
      timestamp: ts
    });
  }

  async sendText(to: string, body: string): Promise<void> {
    if (!this.webClient) { throw new Error('Slack client is not running.'); }
    const res = await this.webClient.chat.postMessage({ channel: to, text: body });
    if (!res.ok) {
      throw new Error(`Slack chat.postMessage failed: ${(res as any).error ?? 'unknown'}`);
    }
  }

  async stop(): Promise<void> {
    if (this.status === 'idle') { return; }
    this.setStatus('stopping');
    try { await this.socketClient?.disconnect(); }
    catch (err) { logWarn(`Slack disconnect raised: ${err instanceof Error ? err.message : err}`); }
    this.socketClient = undefined;
    this.webClient = undefined;
    this.setStatus('idle');
    logInfo('Slack client stopped.');
  }
}
