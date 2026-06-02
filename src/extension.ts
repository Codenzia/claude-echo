import * as vscode from 'vscode';
import * as path from 'path';
import { listSessionsForWorkspace } from './sessionScanner';
import { Binding, BindingStore } from './bindingStore';
import { ActivityLog } from './activityLog';
import { OpenWaClient, OpenWaStatus, digitsOnly, IncomingMessage } from './openWaClient';
import { runClaudeCli } from './claudeBridge';
import { showQrPanel, updateQrPanel } from './qrPanel';
import { BindingProvider } from './bindingProvider';
import { getLogger, logError, logInfo, logWarn } from './logger';

const CONFIG_NS = 'claudeWhatsApp';
const CTX_RUNNING = 'claudeWhatsApp:running';

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_NS);
}

function setRunningContext(running: boolean): void {
  vscode.commands.executeCommand('setContext', CTX_RUNNING, running);
}

function sanitizeE164(n: string): string {
  const trimmed = (n || '').trim();
  if (!trimmed) { return ''; }
  if (!trimmed.startsWith('+')) { return `+${trimmed.replace(/[^\d]/g, '')}`; }
  return `+${trimmed.slice(1).replace(/[^\d]/g, '')}`;
}

export async function activate(context: vscode.ExtensionContext) {
  const store = new BindingStore(context);
  const activity = new ActivityLog();
  const wa = new OpenWaClient();
  const root = workspaceRoot();

  const provider = new BindingProvider(store, activity, root, () => wa.getStatus());
  const treeView = vscode.window.createTreeView('claudeWhatsApp.bridge', {
    treeDataProvider: provider,
    showCollapseAll: false
  });
  context.subscriptions.push(treeView);

  setRunningContext(wa.getStatus() === 'ready');
  context.subscriptions.push(
    wa.onStatus((s: OpenWaStatus) => {
      setRunningContext(s === 'ready');
      provider.refresh();
      updateQrPanel(undefined, describeStatus(s));
    }),
    wa.onQr((qr: string) => {
      updateQrPanel(qr, 'Scan the QR code to link the bridge to WhatsApp.');
    }),
    wa.onMessage((m) => handleIncoming(m).catch((err) => logError('handleIncoming threw', err)))
  );

  async function handleIncoming(msg: IncomingMessage): Promise<void> {
    if (!root) { return; }
    const binding = store.get(root);
    if (!binding) {
      logWarn('Incoming message ignored: no binding configured.');
      return;
    }
    if (msg.isGroup) {
      logInfo(`Dropping group message from ${msg.from}`);
      return;
    }
    const allowed = digitsOnly(binding.allowedNumber);
    if (!allowed || msg.fromNumber !== allowed) {
      logWarn(`Dropping message from disallowed sender ${msg.fromNumber} (allowed=${allowed})`);
      activity.push('error', `Dropped (sender not allowlisted): ${msg.fromNumber}`);
      return;
    }
    if (!msg.body || !msg.body.trim()) {
      logInfo('Dropping empty inbound message.');
      return;
    }

    activity.push('inbound', `> ${msg.body.slice(0, 80)}`);
    logInfo(`Inbound from ${msg.fromNumber}: ${msg.body.slice(0, 120)}`);

    const timeoutMs = cfg().get<number>('responseTimeoutMs', 120_000);
    const cliPath = cfg().get<string>('claudeCliPath', 'claude') || 'claude';

    const result = await runClaudeCli({
      cliPath,
      sessionId: binding.sessionId,
      cwd: binding.workspaceFolder,
      prompt: msg.body,
      timeoutMs
    });

    if (!result.ok) {
      const reply = `[bridge error] ${result.error ?? 'unknown error'}`;
      activity.push('error', reply.slice(0, 100));
      logError(`Claude CLI failed: ${result.error}`);
      try { await wa.sendText(binding.allowedNumber, reply); } catch (err) {
        logError('Failed to send error reply to WhatsApp', err);
      }
      return;
    }

    const reply = result.text.trim() || '(empty response)';
    try {
      await wa.sendText(binding.allowedNumber, reply);
      activity.push('outbound', `< ${reply.slice(0, 80)}`);
      logInfo(`Outbound reply (${result.durationMs} ms): ${reply.slice(0, 120)}`);
    } catch (err) {
      logError('Failed to send Claude reply to WhatsApp', err);
      activity.push('error', `Send failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function startBridge(opts: { interactive: boolean }): Promise<void> {
    if (!root) {
      vscode.window.showWarningMessage('Claude WhatsApp: open a workspace folder first.');
      return;
    }
    const binding = store.get(root);
    if (!binding) {
      if (opts.interactive) {
        vscode.window.showWarningMessage('Claude WhatsApp: bind a session first.');
      }
      return;
    }
    if (wa.getStatus() === 'ready' || wa.getStatus() === 'starting') {
      logInfo(`Bridge already in status=${wa.getStatus()}; ignoring start.`);
      return;
    }
    const sessionDataDir = path.join(context.globalStorageUri.fsPath, 'wa-session');
    activity.push('system', 'Starting bridge…');
    if (opts.interactive) {
      await showQrPanel(wa.getLatestQr(), 'Starting open-wa…');
    }
    try {
      await wa.start({
        sessionDataDir,
        headless: cfg().get<boolean>('openWa.headless', true),
        disableSpins: cfg().get<boolean>('openWa.disableSpins', true)
      });
      activity.push('system', 'Bridge is ready.');
    } catch (err: any) {
      activity.push('error', `Start failed: ${err?.message ?? err}`);
      if (opts.interactive) {
        vscode.window.showErrorMessage(`Claude WhatsApp: failed to start bridge: ${err?.message ?? err}`);
      }
    }
  }

  async function stopBridge(): Promise<void> {
    if (wa.getStatus() === 'idle') { return; }
    activity.push('system', 'Stopping bridge…');
    try {
      await wa.stop();
    } catch (err: any) {
      activity.push('error', `Stop failed: ${err?.message ?? err}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeWhatsApp.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('claudeWhatsApp.bindSession', async () => {
      if (!root) {
        vscode.window.showWarningMessage('Claude WhatsApp: open a workspace folder first.');
        return;
      }
      const sessions = listSessionsForWorkspace(root);
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('No running Claude Code tabs found for this workspace. Open at least one Claude Code conversation first.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        sessions.map((s) => ({
          label: s.title,
          description: s.sessionId.slice(0, 8),
          detail: new Date(s.startedAt).toLocaleString(),
          session: s
        })),
        { placeHolder: 'Pick a Claude Code session to bind to your WhatsApp number' }
      );
      if (!pick) { return; }

      const current = cfg().get<string>('allowedNumber', '') || '';
      const numberInput = await vscode.window.showInputBox({
        prompt: 'Allowed WhatsApp number (E.164, e.g. +15551234567) — only this number will be able to chat with Claude',
        value: current,
        validateInput: (v) => /^\+\d{6,15}$/.test(v.trim()) ? undefined : 'Enter a phone number in E.164 format, e.g. +15551234567'
      });
      if (!numberInput) { return; }
      const allowedNumber = sanitizeE164(numberInput);

      await cfg().update('allowedNumber', allowedNumber, vscode.ConfigurationTarget.Global);

      const binding: Binding = {
        sessionId: pick.session.sessionId,
        sessionTitle: pick.session.title,
        workspaceFolder: root,
        allowedNumber,
        createdAt: Date.now()
      };
      await store.set(binding);
      activity.push('system', `Bound session "${pick.session.title.slice(0, 40)}" to ${allowedNumber}`);

      const startNow = await vscode.window.showInformationMessage(
        'Session bound. Start the WhatsApp bridge now?',
        'Start bridge',
        'Later'
      );
      if (startNow === 'Start bridge') {
        await startBridge({ interactive: true });
      }
    }),

    vscode.commands.registerCommand('claudeWhatsApp.unbind', async () => {
      if (!root) { return; }
      const binding = store.get(root);
      if (!binding) {
        vscode.window.showInformationMessage('No binding to remove.');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Unbind "${binding.sessionTitle}" from ${binding.allowedNumber}?`,
        { modal: true },
        'Unbind'
      );
      if (choice !== 'Unbind') { return; }
      await stopBridge();
      await store.clear(root);
      activity.push('system', 'Binding removed.');
    }),

    vscode.commands.registerCommand('claudeWhatsApp.start', () => startBridge({ interactive: true })),
    vscode.commands.registerCommand('claudeWhatsApp.stop', () => stopBridge()),

    vscode.commands.registerCommand('claudeWhatsApp.showQR', async () => {
      await showQrPanel(wa.getLatestQr(), describeStatus(wa.getStatus()));
    }),

    vscode.commands.registerCommand('claudeWhatsApp.testSend', async () => {
      if (!root) { return; }
      const binding = store.get(root);
      if (!binding) {
        vscode.window.showWarningMessage('Bind a session first.');
        return;
      }
      if (wa.getStatus() !== 'ready') {
        vscode.window.showWarningMessage('Start the bridge first (status must be "Listening").');
        return;
      }
      try {
        const body = `[Claude WhatsApp Bridge] Test message at ${new Date().toLocaleString()}`;
        await wa.sendText(binding.allowedNumber, body);
        activity.push('outbound', body.slice(0, 80));
        vscode.window.showInformationMessage('Test message sent.');
      } catch (err: any) {
        vscode.window.showErrorMessage(`Test send failed: ${err?.message ?? err}`);
      }
    }),

    vscode.commands.registerCommand('claudeWhatsApp.showLogs', () => {
      getLogger().show();
    })
  );

  context.subscriptions.push({ dispose: () => stopBridge() });

  if (cfg().get<boolean>('autoStart', true) && root && store.get(root)) {
    logInfo('autoStart=true and binding present; starting bridge in background.');
    startBridge({ interactive: false }).catch((err) => logError('autoStart failed', err));
  }
}

export function deactivate(): void {
  // Best-effort: openWa client kill() is async and may not complete before host exits.
}

function describeStatus(s: OpenWaStatus): string {
  switch (s) {
    case 'idle': return 'Not running.';
    case 'starting': return 'Starting open-wa…';
    case 'qr': return 'Scan the QR with WhatsApp to authenticate.';
    case 'authenticated': return 'Authenticated, finishing setup…';
    case 'ready': return 'Bridge is listening for WhatsApp messages.';
    case 'stopping': return 'Stopping…';
    case 'error': return 'Error — see Output → "Claude WhatsApp".';
  }
}
