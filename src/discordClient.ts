import * as vscode from 'vscode';
import { logError, logInfo, logWarn } from './logger';
import { Gateway, GatewayKind, GatewayStatus, IncomingMessage } from './gateway';

export interface DiscordConfig {
  botToken: string;
}

type DiscordModule = typeof import('discord.js');

function loadDiscord(): DiscordModule {
  return require('discord.js');
}

export class DiscordClient implements Gateway {
  readonly kind: GatewayKind = 'discord';
  private status: GatewayStatus = 'idle';
  private client?: any;
  private cfg: DiscordConfig;
  private readonly _onStatus = new vscode.EventEmitter<GatewayStatus>();
  private readonly _onQr = new vscode.EventEmitter<string>();
  private readonly _onMessage = new vscode.EventEmitter<IncomingMessage>();
  readonly onStatus = this._onStatus.event;
  readonly onQr = this._onQr.event;
  readonly onMessage = this._onMessage.event;

  constructor(cfg: DiscordConfig) { this.cfg = cfg; }

  getStatus(): GatewayStatus { return this.status; }
  getLatestQr(): undefined { return undefined; }

  private setStatus(s: GatewayStatus): void {
    this.status = s;
    this._onStatus.fire(s);
  }

  async start(): Promise<void> {
    if (this.status === 'starting' || this.status === 'ready') { return; }
    if (!this.cfg.botToken) {
      this.setStatus('error');
      throw new Error('Discord bot token is missing.');
    }
    this.setStatus('starting');
    try {
      const discord = loadDiscord();
      const { Client, GatewayIntentBits, Partials } = discord;
      this.client = new Client({
        intents: [
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent
        ],
        partials: [Partials.Channel, Partials.Message]
      });

      this.client.on('ready', () => {
        logInfo(`Discord bot ready as ${this.client.user?.tag} (id=${this.client.user?.id})`);
        this.setStatus('ready');
      });

      this.client.on('messageCreate', (m: any) => {
        try {
          if (!m || m.author?.bot) { return; }
          // Only handle DMs.
          if (m.channel?.type !== 1 /* DM */) {
            // not a DM — ignore (we don't operate in guild channels)
            return;
          }
          const senderId = m.author?.id ?? '';
          const channelId = m.channel?.id ?? '';
          if (!senderId || !channelId) { return; }
          this._onMessage.fire({
            from: channelId,
            senderId,
            body: typeof m.content === 'string' ? m.content : '',
            isGroup: false,
            timestamp: m.createdTimestamp ?? Date.now()
          });
        } catch (err) {
          logError('Discord message handler failed', err);
        }
      });

      this.client.on('error', (err: any) => {
        logError('Discord client error', err);
      });

      this.client.on('shardError', (err: any) => {
        logError('Discord shard error', err);
      });

      this.client.on('disconnect', () => {
        if (this.status === 'ready') {
          this.setStatus('connecting');
          logWarn('Discord disconnected.');
        }
      });

      this.setStatus('connecting');
      await this.client.login(this.cfg.botToken);
      // 'ready' event will set the status to ready.
    } catch (err) {
      this.setStatus('error');
      logError('Failed to start Discord client', err);
      throw err;
    }
  }

  async sendText(to: string, body: string): Promise<void> {
    if (!this.client) { throw new Error('Discord client is not running.'); }
    // `to` is the channelId (a DM channel).
    let channel: any;
    try { channel = await this.client.channels.fetch(to); }
    catch (err) {
      // Fallback: treat as userId and create a DM channel.
      const user = await this.client.users.fetch(to);
      channel = await user.createDM();
    }
    if (!channel) { throw new Error(`Could not resolve Discord channel ${to}`); }
    await channel.send(body);
  }

  async stop(): Promise<void> {
    if (this.status === 'idle') { return; }
    this.setStatus('stopping');
    try { await this.client?.destroy(); }
    catch (err) { logWarn(`Discord destroy() raised: ${err instanceof Error ? err.message : err}`); }
    this.client = undefined;
    this.setStatus('idle');
    logInfo('Discord client stopped.');
  }
}
