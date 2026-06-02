import * as vscode from 'vscode';

export type GatewayKind = 'whatsapp' | 'telegram' | 'discord' | 'slack';

export type GatewayStatus =
  | 'idle'
  | 'starting'
  | 'qr'              // WhatsApp only
  | 'connecting'
  | 'ready'
  | 'stopping'
  | 'error';

export interface IncomingMessage {
  /** Routing back-channel for replies (gateway-native; e.g. chat_id, channel, jid). */
  from: string;
  /** Stable user identifier used for allowlist matching. */
  senderId: string;
  body: string;
  isGroup: boolean;
  timestamp: number;
}

export interface Gateway {
  readonly kind: GatewayKind;
  readonly onStatus: vscode.Event<GatewayStatus>;
  readonly onMessage: vscode.Event<IncomingMessage>;
  /** WhatsApp emits QR strings; other gateways are silent. */
  readonly onQr: vscode.Event<string>;
  getStatus(): GatewayStatus;
  getLatestQr(): string | undefined;
  start(): Promise<void>;
  sendText(to: string, body: string): Promise<void>;
  stop(): Promise<void>;
}

export function gatewayDisplayName(kind: GatewayKind): string {
  switch (kind) {
    case 'whatsapp': return 'WhatsApp';
    case 'telegram': return 'Telegram';
    case 'discord':  return 'Discord';
    case 'slack':    return 'Slack';
  }
}
