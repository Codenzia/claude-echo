import * as vscode from 'vscode';
import { Binding, BindingStore } from './bindingStore';
import { ActivityEntry, ActivityLog } from './activityLog';
import { OpenWaStatus } from './openWaClient';

export type TreeNode = HeaderNode | InfoNode | ActionNode | ActivityNode;

export class HeaderNode extends vscode.TreeItem {
  readonly kind = 'header' as const;
  constructor(label: string, icon: string, readonly children: TreeNode[]) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'header';
  }
}

export class InfoNode extends vscode.TreeItem {
  readonly kind = 'info' as const;
  constructor(label: string, description?: string, icon?: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (description) { this.description = description; }
    if (icon) { this.iconPath = new vscode.ThemeIcon(icon); }
    if (tooltip) { this.tooltip = tooltip; }
    this.contextValue = 'info';
  }
}

export class ActionNode extends vscode.TreeItem {
  readonly kind = 'action' as const;
  constructor(label: string, commandId: string, icon: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = tooltip ?? label;
    this.contextValue = 'action';
    this.command = { command: commandId, title: label };
  }
}

export class ActivityNode extends vscode.TreeItem {
  readonly kind = 'activity' as const;
  constructor(entry: ActivityEntry) {
    super(entry.label, vscode.TreeItemCollapsibleState.None);
    this.description = new Date(entry.ts).toLocaleTimeString();
    const iconByKind: Record<ActivityEntry['kind'], string> = {
      inbound: 'arrow-down',
      outbound: 'arrow-up',
      error: 'error',
      system: 'info'
    };
    this.iconPath = new vscode.ThemeIcon(iconByKind[entry.kind]);
    this.contextValue = 'activity';
  }
}

export class BindingProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(
    private readonly store: BindingStore,
    private readonly activity: ActivityLog,
    private readonly workspaceFolder: string | undefined,
    private readonly getStatus: () => OpenWaStatus
  ) {
    store.onChange(() => this._onDidChange.fire());
    activity.onChange(() => this._onDidChange.fire());
  }

  refresh(): void { this._onDidChange.fire(); }

  getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element && (element.kind === 'header')) {
      return element.children;
    }
    if (element) { return []; }
    if (!this.workspaceFolder) { return []; }
    const binding = this.store.get(this.workspaceFolder);
    if (!binding) {
      return [
        new ActionNode('Bind a Claude Code session…', 'claudeWhatsApp.bindSession', 'link',
          'Pick a running Claude Code session in this workspace and tie it to your WhatsApp number')
      ];
    }

    const status = this.getStatus();
    const statusLabel = describeStatus(status);

    const bindingChildren: TreeNode[] = [
      new InfoNode('Session', binding.sessionTitle, 'comment-discussion', `sessionId: ${binding.sessionId}`),
      new InfoNode('Allowed number', binding.allowedNumber, 'device-mobile'),
      new InfoNode('Status', statusLabel, statusIcon(status)),
      new ActionNode(status === 'ready' ? 'Stop bridge' : 'Start bridge',
        status === 'ready' ? 'claudeWhatsApp.stop' : 'claudeWhatsApp.start',
        status === 'ready' ? 'debug-stop' : 'play'),
      new ActionNode('Show QR code', 'claudeWhatsApp.showQR', 'device-mobile'),
      new ActionNode('Send test message', 'claudeWhatsApp.testSend', 'send'),
      new ActionNode('Unbind session', 'claudeWhatsApp.unbind', 'unlink')
    ];

    const entries = this.activity.list();
    const activityChildren: TreeNode[] = entries.length === 0
      ? [new InfoNode('(no recent activity)', undefined, 'circle-slash')]
      : entries.map((e) => new ActivityNode(e));

    return [
      new HeaderNode('Binding', 'link', bindingChildren),
      new HeaderNode('Activity', 'pulse', activityChildren)
    ];
  }
}

function describeStatus(s: OpenWaStatus): string {
  switch (s) {
    case 'idle': return 'Not running';
    case 'starting': return 'Starting…';
    case 'qr': return 'Waiting for QR scan';
    case 'authenticated': return 'Authenticated, finishing setup…';
    case 'ready': return 'Listening on WhatsApp';
    case 'stopping': return 'Stopping…';
    case 'error': return 'Error (see logs)';
  }
}

function statusIcon(s: OpenWaStatus): string {
  switch (s) {
    case 'ready': return 'check';
    case 'starting':
    case 'authenticated':
    case 'stopping': return 'sync';
    case 'qr': return 'device-mobile';
    case 'error': return 'error';
    case 'idle': return 'circle-slash';
  }
}

export function getBinding(store: BindingStore, workspaceFolder: string | undefined): Binding | undefined {
  if (!workspaceFolder) { return undefined; }
  return store.get(workspaceFolder);
}
