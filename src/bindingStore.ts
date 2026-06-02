import * as vscode from 'vscode';
import { GatewayKind } from './gateway';

export interface PendingChallenge {
  code: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SessionBinding {
  sessionId: string;
  sessionTitle: string;
  tag: string;
  addedAt: number;
}

export interface WorkspaceBinding {
  workspaceFolder: string;
  gateway: GatewayKind;
  /** WhatsApp: phone number (E.164). Telegram/Discord/Slack: chat or user identifier. */
  allowedId: string;
  verified: boolean;
  pendingChallenge?: PendingChallenge;
  activeSessionId?: string;
  sessions: SessionBinding[];
  createdAt: number;
}

interface StoreShape {
  [workspaceFolder: string]: WorkspaceBinding;
}

const STORE_KEY = 'claudeEcho.workspace.v1';
const OLD_KEYS = [
  'claudeBridge.workspace.v1',
  'claudeWhatsApp.workspace.v2',
  'claudeWhatsApp.binding.v1'
];

function normalizeKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

export class BindingStore {
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;
  private migratedThisSession = false;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private read(): StoreShape {
    const cur = this.ctx.globalState.get<StoreShape>(STORE_KEY, {});
    if (Object.keys(cur).length > 0 || this.migratedThisSession) { return cur; }

    let merged: StoreShape = {};

    // Try v0.3.x (claudeBridge.workspace.v1) and v0.3.0 (claudeWhatsApp.workspace.v2) — same shape.
    for (const oldKey of OLD_KEYS.slice(0, 2)) {
      const v2 = this.ctx.globalState.get<any>(oldKey, {});
      if (!v2 || Object.keys(v2).length === 0) { continue; }
      for (const [key, b] of Object.entries<any>(v2)) {
        if (!b) { continue; }
        merged[key] = {
          workspaceFolder: b.workspaceFolder ?? key,
          gateway: b.gateway ?? 'whatsapp',
          allowedId: b.allowedId ?? b.allowedNumber ?? '',
          verified: !!b.verified,
          pendingChallenge: b.pendingChallenge,
          activeSessionId: b.activeSessionId ?? b.sessions?.[0]?.sessionId,
          sessions: Array.isArray(b.sessions) ? b.sessions : [],
          createdAt: b.createdAt ?? Date.now()
        };
      }
      if (Object.keys(merged).length > 0) { break; }
    }

    if (Object.keys(merged).length === 0) {
      // Try the v0.2.x single-session shape.
      const v1 = this.ctx.globalState.get<any>(OLD_KEYS[2], {});
      for (const [key, b] of Object.entries<any>(v1 ?? {})) {
        if (!b || !b.sessionId) { continue; }
        const tag = slugifyForMigration(b.sessionTitle ?? 'session');
        merged[key] = {
          workspaceFolder: b.workspaceFolder ?? key,
          gateway: 'whatsapp',
          allowedId: b.allowedNumber ?? '',
          verified: !!b.verified,
          pendingChallenge: b.pendingChallenge,
          activeSessionId: b.sessionId,
          sessions: [{
            sessionId: b.sessionId,
            sessionTitle: b.sessionTitle ?? '(untitled)',
            tag,
            addedAt: b.createdAt ?? Date.now()
          }],
          createdAt: b.createdAt ?? Date.now()
        };
      }
    }

    this.migratedThisSession = true;
    if (Object.keys(merged).length > 0) {
      void this.ctx.globalState.update(STORE_KEY, merged);
    }
    return merged;
  }

  private async write(s: StoreShape): Promise<void> {
    await this.ctx.globalState.update(STORE_KEY, s);
    this._onChange.fire();
  }

  get(workspaceFolder: string): WorkspaceBinding | undefined {
    return this.read()[normalizeKey(workspaceFolder)];
  }

  async setWorkspace(b: WorkspaceBinding): Promise<void> {
    const store = this.read();
    store[normalizeKey(b.workspaceFolder)] = b;
    await this.write(store);
  }

  async clearWorkspace(workspaceFolder: string): Promise<void> {
    const store = this.read();
    delete store[normalizeKey(workspaceFolder)];
    await this.write(store);
  }

  async patch(workspaceFolder: string, patch: Partial<WorkspaceBinding>): Promise<WorkspaceBinding | undefined> {
    const store = this.read();
    const key = normalizeKey(workspaceFolder);
    const cur = store[key];
    if (!cur) { return undefined; }
    const next = { ...cur, ...patch };
    store[key] = next;
    await this.write(store);
    return next;
  }

  async addSessions(workspaceFolder: string, sessions: SessionBinding[]): Promise<WorkspaceBinding | undefined> {
    const store = this.read();
    const key = normalizeKey(workspaceFolder);
    const cur = store[key];
    if (!cur) { return undefined; }
    const existing = new Set(cur.sessions.map((s) => s.sessionId));
    const fresh = sessions.filter((s) => !existing.has(s.sessionId));
    const merged = [...cur.sessions, ...fresh];
    const next: WorkspaceBinding = {
      ...cur,
      sessions: merged,
      activeSessionId: cur.activeSessionId ?? merged[0]?.sessionId
    };
    store[key] = next;
    await this.write(store);
    return next;
  }

  async removeSession(workspaceFolder: string, sessionId: string): Promise<WorkspaceBinding | undefined> {
    const store = this.read();
    const key = normalizeKey(workspaceFolder);
    const cur = store[key];
    if (!cur) { return undefined; }
    const remaining = cur.sessions.filter((s) => s.sessionId !== sessionId);
    const next: WorkspaceBinding = {
      ...cur,
      sessions: remaining,
      activeSessionId: cur.activeSessionId === sessionId ? remaining[0]?.sessionId : cur.activeSessionId
    };
    store[key] = next;
    await this.write(store);
    return next;
  }

  async setActive(workspaceFolder: string, sessionId: string): Promise<WorkspaceBinding | undefined> {
    const store = this.read();
    const key = normalizeKey(workspaceFolder);
    const cur = store[key];
    if (!cur) { return undefined; }
    if (!cur.sessions.some((s) => s.sessionId === sessionId)) { return cur; }
    const next: WorkspaceBinding = { ...cur, activeSessionId: sessionId };
    store[key] = next;
    await this.write(store);
    return next;
  }

  listAll(): WorkspaceBinding[] {
    return Object.values(this.read());
  }
}

function slugifyForMigration(s: string): string {
  return (s || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 16) || 'session';
}
