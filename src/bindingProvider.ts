import * as vscode from 'vscode';
import { BindingStore, SessionBinding, WorkspaceBinding } from './bindingStore';
import { ActivityEntry, ActivityLog } from './activityLog';
import { WaStatus } from './whatsappClient';

export type TreeNode = HeaderNode | InfoNode | ActionNode | ActivityNode | SessionNode;

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
  constructor(label: string, commandId: string, icon: string, tooltip?: string, args?: unknown[]) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.tooltip = tooltip ?? label;
    this.contextValue = 'action';
    this.command = { command: commandId, title: label, arguments: args };
  }
}

export class SessionNode extends vscode.TreeItem {
  readonly kind = 'session' as const;
  constructor(readonly session: SessionBinding, readonly isActive: boolean) {
    super(`${isActive ? '★ ' : ''}${session.tag}`, vscode.TreeItemCollapsibleState.None);
    this.description = session.sessionTitle.length > 60 ? session.sessionTitle.slice(0, 57) + '…' : session.sessionTitle;
    this.tooltip = `${session.tag}\n${session.sessionTitle}\nsessionId: ${session.sessionId}${isActive ? '\n\n(active — messages without a #tag go here)' : ''}`;
    this.iconPath = new vscode.ThemeIcon(isActive ? 'star-full' : 'comment-discussion');
    this.contextValue = 'session';
    this.command = {
      command: 'claudeWhatsApp.setActive',
      title: 'Set as active'
    };
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
    private readonly getStatus: () => WaStatus
  ) {
    store.onChange(() => this._onDidChange.fire());
    activity.onChange(() => this._onDidChange.fire());
  }

  refresh(): void { this._onDidChange.fire(); }

  getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element && element.kind === 'header') { return element.children; }
    if (element) { return []; }
    if (!this.workspaceFolder) { return []; }

    const ws = this.store.get(this.workspaceFolder);
    if (!ws) {
      return [
        new ActionNode('Bind Claude Code sessions…', 'claudeWhatsApp.bindSessions', 'link',
          'Pick one or more running Claude Code tabs and tie them to your WhatsApp number')
      ];
    }

    const status = this.getStatus();
    const statusLabel = describeStatus(status);

    const verifiedLabel = ws.verified
      ? `Verified ✓ (${ws.allowedNumber})`
      : ws.pendingChallenge
        ? `Pending — send "${formatPending(ws.pendingChallenge.code)}" from your phone`
        : 'Not verified — regenerate a code';

    const overviewChildren: TreeNode[] = [
      new InfoNode('Allowed number', ws.allowedNumber, 'device-mobile'),
      new InfoNode('Verification', verifiedLabel, ws.verified ? 'pass' : 'warning'),
      new InfoNode('Status', statusLabel, statusIcon(status)),
      new ActionNode(status === 'ready' ? 'Stop bridge' : 'Start bridge',
        status === 'ready' ? 'claudeWhatsApp.stop' : 'claudeWhatsApp.start',
        status === 'ready' ? 'debug-stop' : 'play')
    ];

    if (!ws.verified) {
      overviewChildren.push(
        new ActionNode(ws.pendingChallenge ? 'Show verification code' : 'Generate verification code',
          ws.pendingChallenge ? 'claudeWhatsApp.showChallenge' : 'claudeWhatsApp.regenerateChallenge',
          'key')
      );
    }

    overviewChildren.push(
      new ActionNode('Show QR code', 'claudeWhatsApp.showQR', 'device-mobile'),
      new ActionNode('Send test message', 'claudeWhatsApp.testSend', 'send')
    );

    const sessionChildren: TreeNode[] = [
      new ActionNode('Add more sessions…', 'claudeWhatsApp.bindSessions', 'add'),
      new ActionNode('Change active session…', 'claudeWhatsApp.setActive', 'star-empty'),
      new ActionNode('Unbind a session…', 'claudeWhatsApp.unbindOne', 'unlink'),
      ...ws.sessions.map((s) => new SessionNode(s, s.sessionId === ws.activeSessionId))
    ];
    if (ws.sessions.length === 0) {
      sessionChildren.push(new InfoNode('(no sessions bound yet)', undefined, 'circle-slash'));
    }

    const entries = this.activity.list();
    const activityChildren: TreeNode[] = entries.length === 0
      ? [new InfoNode('(no recent activity)', undefined, 'circle-slash')]
      : entries.map((e) => new ActivityNode(e));

    return [
      new HeaderNode('Bridge', 'link', overviewChildren),
      new HeaderNode(`Sessions (${ws.sessions.length})`, 'list-tree', sessionChildren),
      new HeaderNode('Activity', 'pulse', activityChildren)
    ];
  }
}

function formatPending(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

function describeStatus(s: WaStatus): string {
  switch (s) {
    case 'idle': return 'Not running';
    case 'starting': return 'Starting…';
    case 'qr': return 'Waiting for QR scan';
    case 'connecting': return 'Reconnecting…';
    case 'ready': return 'Listening on WhatsApp';
    case 'stopping': return 'Stopping…';
    case 'error': return 'Error (see logs)';
  }
}

function statusIcon(s: WaStatus): string {
  switch (s) {
    case 'ready': return 'check';
    case 'starting':
    case 'connecting':
    case 'stopping': return 'sync';
    case 'qr': return 'device-mobile';
    case 'error': return 'error';
    case 'idle': return 'circle-slash';
  }
}
