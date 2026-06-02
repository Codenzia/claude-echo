import * as vscode from 'vscode';
import * as path from 'path';
import { listSessionsForWorkspace } from './sessionScanner';
import { BindingStore, SessionBinding, WorkspaceBinding } from './bindingStore';
import { ActivityLog } from './activityLog';
import { WhatsAppClient, WaStatus, digitsOnly, IncomingMessage } from './whatsappClient';
import { runClaudeCli } from './claudeBridge';
import { showQrPanel, updateQrPanel } from './qrPanel';
import { BindingProvider } from './bindingProvider';
import { getLogger, logError, logInfo, logWarn } from './logger';
import { RateLimiter } from './rateLimiter';
import { redactBody } from './redact';
import { checkChallenge, formatChallenge, generateChallenge } from './verification';
import { slugifyTitle, uniqueTag } from './tagging';
import { parseMessage } from './commandParser';

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

function findBindingByTag(ws: WorkspaceBinding, tag: string): SessionBinding | undefined {
  const lower = tag.toLowerCase();
  return ws.sessions.find((s) => s.tag.toLowerCase() === lower);
}

function activeBinding(ws: WorkspaceBinding): SessionBinding | undefined {
  if (!ws.activeSessionId) { return ws.sessions[0]; }
  return ws.sessions.find((s) => s.sessionId === ws.activeSessionId) ?? ws.sessions[0];
}

function listText(ws: WorkspaceBinding): string {
  if (ws.sessions.length === 0) { return 'No bound sessions.'; }
  const active = activeBinding(ws);
  const lines = ws.sessions.map((s) => {
    const star = s.sessionId === active?.sessionId ? '* ' : '  ';
    const title = s.sessionTitle.length > 50 ? s.sessionTitle.slice(0, 47) + '…' : s.sessionTitle;
    return `${star}${s.tag} — ${title}`;
  });
  return `${ws.sessions.length} bound session${ws.sessions.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

function helpText(): string {
  return [
    'Claude WhatsApp commands:',
    '  /list           list bound sessions',
    '  /where          show currently active session',
    '  /use <tag>      switch active session',
    '  /help           this message',
    '  #<tag> <text>   one-off route to a specific session',
    'Anything else is forwarded to the active session.'
  ].join('\n');
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

  async function sendSafe(to: string, body: string): Promise<void> {
    try { await wa.sendText(to, body); }
    catch (err) { logError(`sendText failed to ${to}`, err); }
  }

  async function handleIncoming(msg: IncomingMessage): Promise<void> {
    if (!root) { return; }
    const ws = store.get(root);
    if (!ws) {
      logWarn('Incoming message ignored: no workspace binding configured.');
      return;
    }
    if (msg.isGroup) {
      logInfo(`Dropping group message from ${msg.from}`);
      return;
    }
    const allowed = digitsOnly(ws.allowedNumber);
    if (!allowed || msg.fromNumber !== allowed) {
      logWarn(`Dropping message from disallowed sender ${msg.fromNumber} (allowed=${allowed})`);
      activity.push('error', `Dropped (sender not allowlisted): ${msg.fromNumber}`);
      return;
    }
    if (!msg.body || !msg.body.trim()) { return; }

    const verbose = cfg().get<boolean>('verboseLogging', false);

    // Verification gate: the only thing accepted before verification is the challenge code.
    if (!ws.verified) {
      const outcome = checkChallenge(ws.pendingChallenge, msg.body);
      if (outcome.matched) {
        await store.patch(root, { verified: true, pendingChallenge: undefined });
        activity.push('system', 'Number verified ✓');
        logInfo('Verification challenge matched. Workspace is now verified.');
        await sendSafe(ws.allowedNumber,
          `[Claude WhatsApp Bridge]\nNumber verified ✓\nType /help to see the available commands.\n${listText({ ...ws, verified: true })}`);
        return;
      }
      if (outcome.expired) {
        activity.push('error', 'Verification code expired');
        await sendSafe(ws.allowedNumber,
          '[bridge] The verification code expired. In VSCode run "Claude WhatsApp: Regenerate verification code" to get a new one.');
        return;
      }
      const hint = ws.pendingChallenge
        ? `Send the verification code shown in VSCode (format: ${formatChallenge(ws.pendingChallenge.code)}).`
        : 'In VSCode run "Claude WhatsApp: Regenerate verification code" to issue one.';
      await sendSafe(ws.allowedNumber, `[bridge] Number not yet verified. ${hint}`);
      activity.push('error', 'Dropped — awaiting verification');
      return;
    }

    // Parse the message.
    const parsed = parseMessage(msg.body);

    if (parsed.kind === 'help') {
      await sendSafe(ws.allowedNumber, helpText());
      return;
    }
    if (parsed.kind === 'list') {
      await sendSafe(ws.allowedNumber, listText(ws));
      return;
    }
    if (parsed.kind === 'where') {
      const a = activeBinding(ws);
      await sendSafe(ws.allowedNumber, a ? `Active: ${a.tag} — ${a.sessionTitle}` : 'No active session.');
      return;
    }
    if (parsed.kind === 'use') {
      const target = findBindingByTag(ws, parsed.tag);
      if (!target) {
        await sendSafe(ws.allowedNumber, `Unknown tag "${parsed.tag}".\n${listText(ws)}`);
        return;
      }
      await store.setActive(root, target.sessionId);
      activity.push('system', `Active session → ${target.tag}`);
      await sendSafe(ws.allowedNumber, `active → ${target.tag}`);
      return;
    }

    // It's a real message — pick the binding.
    let targetBinding: SessionBinding | undefined;
    if (parsed.tag) {
      targetBinding = findBindingByTag(ws, parsed.tag);
      if (!targetBinding) {
        await sendSafe(ws.allowedNumber, `Unknown tag "${parsed.tag}".\n${listText(ws)}`);
        return;
      }
    } else {
      targetBinding = activeBinding(ws);
    }
    if (!targetBinding) {
      await sendSafe(ws.allowedNumber, 'No bound sessions yet. Bind one from VSCode first.');
      return;
    }
    if (!parsed.body.trim()) { return; }

    // Rate limit
    const decision = limiter.check();
    if (!decision.ok) {
      logWarn(`Rate limited: ${decision.reason}`);
      activity.push('error', `Rate limited (${limiter.stats().lastHour}/h, ${limiter.stats().lastDay}/d)`);
      await sendSafe(ws.allowedNumber, `[bridge] ${decision.reason}`);
      return;
    }

    // Truncate
    const maxBytes = cfg().get<number>('maxInboundBytes', 4096);
    let prompt = parsed.body;
    let truncated = false;
    if (maxBytes > 0 && Buffer.byteLength(prompt, 'utf8') > maxBytes) {
      prompt = Buffer.from(prompt, 'utf8').subarray(0, maxBytes).toString('utf8');
      truncated = true;
    }

    activity.push('inbound', `> [${targetBinding.tag}] ${redactBody(prompt, verbose)}${truncated ? ' [truncated]' : ''}`);
    logInfo(`Inbound -> ${targetBinding.tag}: ${redactBody(prompt, verbose)}${truncated ? ' (truncated)' : ''}`);

    const timeoutMs = cfg().get<number>('responseTimeoutMs', 120_000);
    const cliPath = cfg().get<string>('claudeCliPath', 'claude') || 'claude';

    limiter.record();
    const result = await runClaudeCli({
      cliPath,
      sessionId: targetBinding.sessionId,
      cwd: ws.workspaceFolder,
      prompt,
      timeoutMs
    });

    if (!result.ok) {
      const reply = `[bridge error · ${targetBinding.tag}] ${result.error ?? 'unknown error'}`;
      activity.push('error', reply.slice(0, 100));
      logError(`Claude CLI failed for ${targetBinding.tag}: ${result.error}`);
      await sendSafe(ws.allowedNumber, reply);
      return;
    }

    const replyBody = result.text.trim() || '(empty response)';
    const reply = ws.sessions.length > 1 ? `[${targetBinding.tag}]\n${replyBody}` : replyBody;
    await sendSafe(ws.allowedNumber, reply);
    activity.push('outbound', `< [${targetBinding.tag}] ${redactBody(replyBody, verbose)}`);
    logInfo(`Outbound from ${targetBinding.tag} (${result.durationMs} ms): ${redactBody(replyBody, verbose)}`);
  }

  async function startBridge(opts: { interactive: boolean }): Promise<void> {
    if (!root) {
      vscode.window.showWarningMessage('Claude WhatsApp: open a workspace folder first.');
      return;
    }
    const ws = store.get(root);
    if (!ws) {
      if (opts.interactive) {
        vscode.window.showWarningMessage('Claude WhatsApp: bind at least one session first.');
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
    try { await wa.stop(); }
    catch (err: any) { activity.push('error', `Stop failed: ${err?.message ?? err}`); }
  }

  async function bulkBindSessions(): Promise<void> {
    if (!root) {
      vscode.window.showWarningMessage('Claude WhatsApp: open a workspace folder first.');
      return;
    }
    const sessions = listSessionsForWorkspace(root);
    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No running Claude Code tabs found in this workspace.');
      return;
    }

    const existing = store.get(root);
    const alreadyBound = new Set(existing?.sessions.map((s) => s.sessionId) ?? []);
    const items = sessions.map((s) => ({
      label: s.title,
      description: alreadyBound.has(s.sessionId) ? '(already bound)' : s.sessionId.slice(0, 8),
      detail: new Date(s.startedAt).toLocaleString(),
      picked: !alreadyBound.has(s.sessionId),
      session: s,
      alreadyBound: alreadyBound.has(s.sessionId)
    }));

    const picks = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: `Tick the Claude Code sessions to bind (${sessions.length} available). Space to toggle, Enter to confirm.`
    });
    if (!picks || picks.length === 0) { return; }

    const fresh = picks.filter((p) => !p.alreadyBound);
    if (fresh.length === 0) {
      vscode.window.showInformationMessage('All picked sessions are already bound.');
      return;
    }

    // If first-ever binding, prompt for phone number and issue a challenge.
    let workspace = existing;
    if (!workspace) {
      const current = cfg().get<string>('allowedNumber', '') || '';
      const numberInput = await vscode.window.showInputBox({
        prompt: 'Allowed WhatsApp number (E.164, e.g. +15551234567) — only this number will be able to chat with Claude',
        value: current,
        validateInput: (v) => /^\+\d{6,15}$/.test(v.trim()) ? undefined : 'Enter E.164 format, e.g. +15551234567'
      });
      if (!numberInput) { return; }
      const allowedNumber = sanitizeE164(numberInput);
      await cfg().update('allowedNumber', allowedNumber, vscode.ConfigurationTarget.Global);

      const challenge = generateChallenge();
      workspace = {
        workspaceFolder: root,
        allowedNumber,
        verified: false,
        pendingChallenge: challenge,
        sessions: [],
        createdAt: Date.now()
      };
      await store.setWorkspace(workspace);
    }

    // Build binding objects with unique tags.
    const usedTags = new Set(workspace!.sessions.map((s) => s.tag));
    const newBindings: SessionBinding[] = fresh.map((p) => {
      const base = slugifyTitle(p.session.title);
      const tag = uniqueTag(base, usedTags);
      usedTags.add(tag);
      return {
        sessionId: p.session.sessionId,
        sessionTitle: p.session.title,
        tag,
        addedAt: Date.now()
      };
    });

    const updated = await store.addSessions(root, newBindings);
    if (!updated) { return; }

    activity.push('system', `Bound ${newBindings.length} session${newBindings.length === 1 ? '' : 's'}: ${newBindings.map((s) => s.tag).join(', ')}`);

    if (!updated.verified && updated.pendingChallenge) {
      const formatted = formatChallenge(updated.pendingChallenge.code);
      const action = await vscode.window.showInformationMessage(
        `Bound ${newBindings.length} session${newBindings.length === 1 ? '' : 's'}. Verification code: ${formatted}. Start the bridge and send this code via WhatsApp to verify.`,
        'Start bridge',
        'Copy code',
        'Later'
      );
      if (action === 'Copy code') {
        await vscode.env.clipboard.writeText(updated.pendingChallenge.code);
      } else if (action === 'Start bridge') {
        await startBridge({ interactive: true });
      }
    } else {
      const tags = newBindings.map((s) => s.tag).join(', ');
      vscode.window.showInformationMessage(`Bound: ${tags}. Send "/list" via WhatsApp to verify.`);
    }
  }

  async function unbindSinglePicker(): Promise<void> {
    if (!root) { return; }
    const ws = store.get(root);
    if (!ws || ws.sessions.length === 0) {
      vscode.window.showInformationMessage('No bound sessions to remove.');
      return;
    }
    const items = ws.sessions.map((s) => ({
      label: s.tag,
      description: s.sessionId === ws.activeSessionId ? '(active)' : '',
      detail: s.sessionTitle,
      session: s
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Pick a session to unbind' });
    if (!pick) { return; }
    await store.removeSession(root, pick.session.sessionId);
    activity.push('system', `Removed ${pick.session.tag}`);
  }

  async function setActivePicker(): Promise<void> {
    if (!root) { return; }
    const ws = store.get(root);
    if (!ws || ws.sessions.length === 0) {
      vscode.window.showInformationMessage('No bound sessions yet.');
      return;
    }
    const items = ws.sessions.map((s) => ({
      label: s.tag,
      description: s.sessionId === ws.activeSessionId ? '(current)' : '',
      detail: s.sessionTitle,
      session: s
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Pick the active session' });
    if (!pick) { return; }
    await store.setActive(root, pick.session.sessionId);
    activity.push('system', `Active session → ${pick.session.tag}`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeWhatsApp.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('claudeWhatsApp.bindSession', () => bulkBindSessions()),
    vscode.commands.registerCommand('claudeWhatsApp.bindSessions', () => bulkBindSessions()),
    vscode.commands.registerCommand('claudeWhatsApp.unbindOne', () => unbindSinglePicker()),
    vscode.commands.registerCommand('claudeWhatsApp.setActive', () => setActivePicker()),

    vscode.commands.registerCommand('claudeWhatsApp.unbind', async () => {
      if (!root) { return; }
      const ws = store.get(root);
      if (!ws) { vscode.window.showInformationMessage('No binding to remove.'); return; }
      const choice = await vscode.window.showWarningMessage(
        `Remove the WhatsApp binding for this workspace? This unbinds all ${ws.sessions.length} session${ws.sessions.length === 1 ? '' : 's'} and clears the verified number.`,
        { modal: true },
        'Unbind'
      );
      if (choice !== 'Unbind') { return; }
      await stopBridge();
      await store.clearWorkspace(root);
      activity.push('system', 'Workspace binding removed.');
    }),

    vscode.commands.registerCommand('claudeWhatsApp.start', () => startBridge({ interactive: true })),
    vscode.commands.registerCommand('claudeWhatsApp.stop', () => stopBridge()),

    vscode.commands.registerCommand('claudeWhatsApp.showQR', async () => {
      await showQrPanel(wa.getLatestQr(), describeStatus(wa.getStatus()));
    }),

    vscode.commands.registerCommand('claudeWhatsApp.testSend', async () => {
      if (!root) { return; }
      const ws = store.get(root);
      if (!ws) { vscode.window.showWarningMessage('Bind a session first.'); return; }
      if (wa.getStatus() !== 'ready') { vscode.window.showWarningMessage('Start the bridge first.'); return; }
      try {
        await wa.sendText(ws.allowedNumber, `[Claude WhatsApp Bridge] Test message at ${new Date().toLocaleString()}`);
        vscode.window.showInformationMessage('Test message sent.');
      } catch (err: any) {
        vscode.window.showErrorMessage(`Test send failed: ${err?.message ?? err}`);
      }
    }),

    vscode.commands.registerCommand('claudeWhatsApp.showLogs', () => getLogger().show()),

    vscode.commands.registerCommand('claudeWhatsApp.regenerateChallenge', async () => {
      if (!root) { return; }
      const ws = store.get(root);
      if (!ws) { vscode.window.showWarningMessage('Bind a session first.'); return; }
      const challenge = generateChallenge();
      await store.patch(root, { verified: false, pendingChallenge: challenge });
      activity.push('system', `New verification code: ${formatChallenge(challenge.code)}`);
      const action = await vscode.window.showInformationMessage(
        `New verification code: ${formatChallenge(challenge.code)}. Send it from ${ws.allowedNumber} via WhatsApp.`,
        'Copy code'
      );
      if (action === 'Copy code') {
        await vscode.env.clipboard.writeText(challenge.code);
      }
    }),

    vscode.commands.registerCommand('claudeWhatsApp.showChallenge', async () => {
      if (!root) { return; }
      const ws = store.get(root);
      if (!ws) { vscode.window.showInformationMessage('No binding yet.'); return; }
      if (ws.verified) { vscode.window.showInformationMessage(`Number ${ws.allowedNumber} is already verified.`); return; }
      if (!ws.pendingChallenge) { vscode.window.showWarningMessage('No pending verification code.'); return; }
      const expiresIn = Math.max(0, Math.round((ws.pendingChallenge.expiresAt - Date.now()) / 60000));
      const action = await vscode.window.showInformationMessage(
        `Verification code: ${formatChallenge(ws.pendingChallenge.code)} (expires in ~${expiresIn} min)`,
        'Copy code',
        'Regenerate'
      );
      if (action === 'Copy code') {
        await vscode.env.clipboard.writeText(ws.pendingChallenge.code);
      } else if (action === 'Regenerate') {
        await vscode.commands.executeCommand('claudeWhatsApp.regenerateChallenge');
      }
    })
  );

  context.subscriptions.push({ dispose: () => stopBridge() });

  const autoStartWs = root ? store.get(root) : undefined;
  if (cfg().get<boolean>('autoStart', false) && autoStartWs?.verified && autoStartWs.sessions.length > 0) {
    logInfo('autoStart enabled with a verified binding; starting bridge in background.');
    startBridge({ interactive: false }).catch((err) => logError('autoStart failed', err));
  }
}

export function deactivate(): void { /* best-effort */ }

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
