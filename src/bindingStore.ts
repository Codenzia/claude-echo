import * as vscode from 'vscode';

export interface Binding {
  sessionId: string;
  sessionTitle: string;
  workspaceFolder: string;
  allowedNumber: string;
  createdAt: number;
}

interface StoreShape {
  [workspaceFolder: string]: Binding;
}

const STORE_KEY = 'claudeWhatsApp.binding.v1';

function normalizeKey(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

export class BindingStore {
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private read(): StoreShape {
    return this.ctx.globalState.get<StoreShape>(STORE_KEY, {});
  }

  private async write(s: StoreShape): Promise<void> {
    await this.ctx.globalState.update(STORE_KEY, s);
    this._onChange.fire();
  }

  get(workspaceFolder: string): Binding | undefined {
    const store = this.read();
    return store[normalizeKey(workspaceFolder)];
  }

  async set(b: Binding): Promise<void> {
    const store = this.read();
    store[normalizeKey(b.workspaceFolder)] = b;
    await this.write(store);
  }

  async clear(workspaceFolder: string): Promise<void> {
    const store = this.read();
    delete store[normalizeKey(workspaceFolder)];
    await this.write(store);
  }

  listAll(): Binding[] {
    return Object.values(this.read());
  }
}
