import * as vscode from 'vscode';
import * as path from 'path';
import { listSessionsForWorkspace } from './sessionScanner';
import { Binding, BindingStore } from './bindingStore';
import { ActivityLog } from './activityLog';
import { WhatsAppClient, WaStatus, digitsOnly, IncomingMessage } from './whatsappClient';
import { runClaudeCli } from './claudeBridge';
import { showQrPanel, updateQrPanel } from './qrPanel';
import { BindingProvider } from './bindingProvider';
import { getLogger, logError, logInfo, logWarn } from './logger';
import { RateLimiter } from './rateLimiter';
import { redactBody } from './redact';
import { checkChallenge, formatChallenge, generateChallenge } from './verification';

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
  const wa = new WhatsAppClient();
  const root = workspaceRoot();

  let limiter = new RateLimiter(
    cfg().get<number>('maxMessagesPerHour', 60),
    cfg().get<number>('maxMessagesPerDay', 500)
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeWhatsApp.maxMessagesPerHour') ||
          e.affectsConfiguration('claudeWhatsApp.maxMessagesPerDay')) {
        limiter = new RateLimiter(
          cfg().get<number>('maxMessagesPerHour', 60),
          cfg().get<number>('maxMessagesPerDay', 500)
        );
        logInfo('Rate limits reconfigured.');
      }
    })
  );

  const provider = new BindingProvider(store, activity, root, () => wa.getStatus());
  const treeView = vscode.window.createTreeView('claudeWhatsApp.bridge', {
    treeDataProvider: provider,
    showCollapseAll: false
  });
  context.subscriptions.push(treeView);

  setRunningContext(wa.getStatus() === 'ready');
  context.subscriptions.push(
    wa.onStatus((s: WaStatus) => {
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

    const verbose = cfg().get<boolean>('verboseLogging', false);

    // Verification gate: until verified, the only message we accept is the challenge code.
    if (!binding.verified) {
      const outcome = checkChallenge(binding.pendingChallenge, msg.body);
      if (outcome.matched) {
        const verified: Binding = { ...binding, verified: true, pendingChallenge: undefined };
        await store.set(verified);
        activity.push('system', 'Number verified ✓');
        logInfo('Verification challenge matched. Binding is now verified.');
        try {
          await wa.sendText(binding.allowedNumber,
            `[Claude WhatsApp Bridge]\nNumber verified ✓\nYou can now chat with Claude. Every message you send will be billed against your Claude API usage.`);
        } catch (err) {
          logError('Failed to send verification confirmation', err);
        }
        return;
      }
      if (outcome.expired) {
        activity.push('error', 'Verification code expired');
        try {
          await wa.sendText(binding.allowedNumber,
            '[Claude WhatsApp Bridge] The verification code expired. Open VSCode → "Claude WhatsApp: Regenerate verification code" to get a new one.');
        } catch { /* ignore */ }
        return;
      }
      // Unmatched message while pending — tell user what we expect.
      const codeHint = binding.pendingChallenge
        ? `Send the verification code shown in VSCode (format: ${formatChallenge(binding.pendingChallenge.code)}).`
        : 'Run "Claude WhatsApp: Regenerate verification code" in VSCode to issue one.';
      try {
        await wa.sendText(binding.allowedNumber, `[Claude WhatsApp Bridge] Number not yet verified. ${codeHint}`);
      } catch { /* ignore */ }
      activity.push('error', 'Dropped — awaiting verification');
      return;
    }

    // Rate limit check before doing anything expensive.
    const decision = limiter.check();
    if (!decision.ok) {
      logWarn(`Rate limited: ${decision.reason}`);
      activity.push('error', `Rate limited (${limiter.stats().lastHour}/h, ${limiter.stats().lastDay}/d)`);
      try {
        await wa.sendText(binding.allowedNumber, `[bridge] ${decision.reason}`);
      } catch { /* ignore */ }
      return;
    }

    // Truncate inbound body to cap per-message Claude cost.
    const maxBytes = cfg().get<number>('maxInboundBytes', 4096);
    let prompt = msg.body;
    let truncated = false;
    if (maxBytes > 0 && Buffer.byteLength(prompt, 'utf8') > maxBytes) {
      prompt = Buffer.from(prompt, 'utf8').subarray(0, maxBytes).toString('utf8');
      truncated = true;
    }

    activity.push('inbound', `> ${redactBody(prompt, verbose)}${truncated ? ' [truncated]' : ''}`);
    logInfo(`Inbound from ${msg.fromNumber}: ${redactBody(prompt, verbose)}${truncated ? ' (truncated)' : ''}`);

    const timeoutMs = cfg().get<number>('responseTimeoutMs', 120_000);
    const cliPath = cfg().get<string>('claudeCliPath', 'claude') || 'claude';

    limiter.record();
    const result = await runClaudeCli({
      cliPath,
      sessionId: binding.sessionId,
      cwd: binding.workspaceFolder,
      prompt,
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
      activity.push('outbound', `< ${redactBody(reply, verbose)}`);
      logInfo(`Outbound reply (${result.durationMs} ms): ${redactBody(reply, verbose)}`);
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
    const authDir = path.join(context.globalStorageUri.fsPath, 'wa-auth');
    activity.push('system', 'Starting bridge…');
    if (opts.interactive) {
      await showQrPanel(wa.getLatestQr(), 'Starting WhatsApp client…');
    }
    try {
      await wa.start({ authDir });
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

      const challenge = generateChallenge();
      const binding: Binding = {
        sessionId: pick.session.sessionId,
        sessionTitle: pick.session.title,
        workspaceFolder: root,
        allowedNumber,
        createdAt: Date.now(),
        verified: false,
        pendingChallenge: challenge
      };
      await store.set(binding);
      activity.push('system', `Bound to ${allowedNumber} — verification pending (code ${formatChallenge(challenge.code)})`);

      const startNow = await vscode.window.showInformationMessage(
        `Session bound. To verify the number, after the bridge starts send this code from your phone: ${formatChallenge(challenge.code)}`,
        { modal: false },
        'Start bridge',
        'Copy code',
        'Later'
      );
      if (startNow === 'Copy code') {
        await vscode.env.clipboard.writeText(challenge.code);
        vscode.window.showInformationMessage(`Verification code copied: ${formatChallenge(challenge.code)}. Click "Claude WhatsApp: Start bridge" when ready.`);
      } else if (startNow === 'Start bridge') {
        await startBridge({ interactive: true });
        vscode.window.showInformationMessage(
          `Bridge starting. After you scan the QR with WhatsApp, send the code ${formatChallenge(challenge.code)} from your phone to verify the binding.`
        );
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
    }),

    vscode.commands.registerCommand('claudeWhatsApp.regenerateChallenge', async () => {
      if (!root) { return; }
      const binding = store.get(root);
      if (!binding) {
        vscode.window.showWarningMessage('No binding yet. Run "Bind a Claude Code session" first.');
        return;
      }
      const challenge = generateChallenge();
      await store.set({ ...binding, verified: false, pendingChallenge: challenge });
      activity.push('system', `New verification code issued: ${formatChallenge(challenge.code)}`);
      const formatted = formatChallenge(challenge.code);
      const action = await vscode.window.showInformationMessage(
        `New verification code: ${formatted}. Send it from ${binding.allowedNumber} via WhatsApp.`,
        'Copy code'
      );
      if (action === 'Copy code') {
        await vscode.env.clipboard.writeText(challenge.code);
      }
    }),

    vscode.commands.registerCommand('claudeWhatsApp.showChallenge', async () => {
      if (!root) { return; }
      const binding = store.get(root);
      if (!binding) {
        vscode.window.showInformationMessage('No binding yet.');
        return;
      }
      if (binding.verified) {
        vscode.window.showInformationMessage(`Number ${binding.allowedNumber} is already verified.`);
        return;
      }
      if (!binding.pendingChallenge) {
        vscode.window.showWarningMessage('No pending verification code. Run "Regenerate verification code".');
        return;
      }
      const formatted = formatChallenge(binding.pendingChallenge.code);
      const expiresIn = Math.max(0, Math.round((binding.pendingChallenge.expiresAt - Date.now()) / 60000));
      const action = await vscode.window.showInformationMessage(
        `Verification code: ${formatted} (expires in ~${expiresIn} min). Send it from ${binding.allowedNumber} via WhatsApp.`,
        'Copy code',
        'Regenerate'
      );
      if (action === 'Copy code') {
        await vscode.env.clipboard.writeText(binding.pendingChallenge.code);
      } else if (action === 'Regenerate') {
        await vscode.commands.executeCommand('claudeWhatsApp.regenerateChallenge');
      }
    })
  );

  context.subscriptions.push({ dispose: () => stopBridge() });

  const autoStartBinding = root ? store.get(root) : undefined;
  if (cfg().get<boolean>('autoStart', false) && autoStartBinding) {
    if (autoStartBinding.verified) {
      logInfo('autoStart enabled and binding is verified; starting bridge in background.');
      startBridge({ interactive: false }).catch((err) => logError('autoStart failed', err));
    } else {
      logInfo('autoStart enabled but binding is not yet verified; skipping auto-start.');
    }
  }
}

export function deactivate(): void {
  // Best-effort: openWa client kill() is async and may not complete before host exits.
}

function describeStatus(s: WaStatus): string {
  switch (s) {
    case 'idle': return 'Not running.';
    case 'starting': return 'Starting WhatsApp client…';
    case 'qr': return 'Scan the QR with WhatsApp to authenticate.';
    case 'connecting': return 'Reconnecting…';
    case 'ready': return 'Bridge is listening for WhatsApp messages.';
    case 'stopping': return 'Stopping…';
    case 'error': return 'Error — see Output → "Claude WhatsApp".';
  }
}
