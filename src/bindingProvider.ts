import * as vscode from 'vscode';
import { BindingStore, SessionBinding, WorkspaceBinding } from './bindingStore';
import { ActivityEntry, ActivityLog } from './activityLog';
import { GatewayKind, GatewayStatus, gatewayDisplayName } from './gateway';

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
    this.command = { command: 'claudeEcho.setActive', title: 'Set as active' };
  }
}

export class ActivityNode extends vscode.TreeItem {
  readonly kind = 'activity' as const;
  constructor(entry: ActivityEntry) {
    super(entry.label, vscode.TreeItemCollapsibleState.None);
    this.description = new Date(entry.ts).toLocaleTimeString();
    const iconByKind: Record<ActivityEntry['kind'], string> = {
      inbound: 'arrow-down', outbound: 'arrow-up', error: 'error', system: 'info'
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
    private readonly getStatus: () => GatewayStatus,
    private readonly getKind: () => GatewayKind | undefined
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
        new ActionNode('Bind Claude Code sessions…', 'claudeEcho.bindSessions', 'link',
          'Pick a messaging gateway and tie your Claude sessions to it')
      ];
    }

    const status = this.getStatus();
    const statusLabel = describeStatus(status, ws.gateway);

    const verifiedLabel = ws.gateway === 'whatsapp'
      ? (ws.verified
          ? `Verified ✓ (${ws.allowedId})`
          : ws.pendingChallenge
            ? `Pending — send "${formatPending(ws.pendingChallenge.code)}" from your phone`
            : 'Not verified — regenerate a code')
      : `Allowed user: ${ws.allowedId}`;

    const overviewChildren: TreeNode[] = [
      new InfoNode('Gateway', gatewayDisplayName(ws.gateway), gatewayIcon(ws.gateway)),
      new InfoNode(ws.gateway === 'whatsapp' ? 'Allowed number' : 'Allowed user', ws.allowedId, 'account'),
      new InfoNode(ws.gateway === 'whatsapp' ? 'Verification' : 'Allowlist', verifiedLabel,
        ws.gateway === 'whatsapp' ? (ws.verified ? 'pass' : 'warning') : 'pass'),
      new InfoNode('Status', statusLabel, statusIcon(status)),
      new ActionNode(status === 'ready' ? 'Stop bridge' : 'Start bridge',
        status === 'ready' ? 'claudeEcho.stop' : 'claudeEcho.start',
        status === 'ready' ? 'debug-stop' : 'play')
    ];

    if (ws.gateway === 'whatsapp' && !ws.verified) {
      overviewChildren.push(
        new ActionNode(ws.pendingChallenge ? 'Show verification code' : 'Generate verification code',
          ws.pendingChallenge ? 'claudeEcho.showChallenge' : 'claudeEcho.regenerateChallenge', 'key')
      );
      overviewChildren.push(
        new ActionNode('Show QR code', 'claudeEcho.showQR', 'device-mobile')
      );
    }

    overviewChildren.push(
      new ActionNode('Send test message', 'claudeEcho.testSend', 'send')
    );

    const sessionChildren: TreeNode[] = [
      new ActionNode('Add more sessions…', 'claudeEcho.bindSessions', 'add'),
      new ActionNode('Change active session…', 'claudeEcho.setActive', 'star-empty'),
      new ActionNode('Unbind a session…', 'claudeEcho.unbindOne', 'unlink'),
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

function gatewayIcon(k: GatewayKind): string {
  switch (k) {
    case 'whatsapp': return 'device-mobile';
    case 'telegram': return 'send';
    case 'discord':  return 'comment-discussion';
    case 'slack':    return 'organization';
  }
}

function describeStatus(s: GatewayStatus, k: GatewayKind): string {
  switch (s) {
    case 'idle': return 'Not running';
    case 'starting': return 'Starting…';
    case 'qr': return 'Waiting for QR scan';
    case 'connecting': return 'Connecting…';
    case 'ready': return `Listening on ${gatewayDisplayName(k)}`;
    case 'stopping': return 'Stopping…';
    case 'error': return 'Error (see logs)';
  }
}

function statusIcon(s: GatewayStatus): string {
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
