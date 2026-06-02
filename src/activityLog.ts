import * as vscode from 'vscode';

export type ActivityKind = 'inbound' | 'outbound' | 'error' | 'system';

export interface ActivityEntry {
  ts: number;
  kind: ActivityKind;
  label: string;
}

const MAX_ENTRIES = 20;

export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;

  push(kind: ActivityKind, label: string): void {
    this.entries.unshift({ ts: Date.now(), kind, label: label.slice(0, 120) });
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
    this._onChange.fire();
  }

  list(): ActivityEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this._onChange.fire();
  }
}
