import * as vscode from 'vscode';
import * as path from 'path';
import { listSessionsForWorkspace } from './sessionScanner';
import { BindingStore, SessionBinding, WorkspaceBinding } from './bindingStore';
import { ActivityLog } from './activityLog';
import { runClaudeCli } from './claudeBridge';
import { showQrPanel, updateQrPanel } from './qrPanel';
import { BindingProvider } from './bindingProvider';
import { getLogger, logError, logInfo, logWarn } from './logger';
import { RateLimiter } from './rateLimiter';
import { redactBody } from './redact';
import { checkChallenge, formatChallenge, generateChallenge } from './verification';
import { slugifyTitle, uniqueTag } from './tagging';
import { parseMessage } from './commandParser';
import { Gateway, GatewayKind, GatewayStatus, IncomingMessage, gatewayDisplayName } from './gateway';
import { WhatsAppClient, digitsOnly } from './whatsappClient';
import { TelegramClient } from './telegramClient';
import { DiscordClient } from './discordClient';
import { SlackClient } from './slackClient';

const CONFIG_NS = 'claudeEcho';
const CTX_RUNNING = 'claudeEcho:running';

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
    'Claude Echo commands:',
    '',
    'Routing:',
    '  /list             list bound sessions',
    '  /where            show currently active session',
    '  /use <tag>        switch active session',
    '  /help             this message',
    '  #<tag> <text>     one-off route to a specific session',
    '',
    'Per-message modifiers (combine with #tag in any order):',
    '  /plan <text>      plan mode — returns a plan, no execution',
    '  /auto <text>      acceptEdits — auto-applies file edits',
    '  /yolo <text>      bypassPermissions (use rarely; no permission checks)',
    '  /opus <text>      run this turn on Opus',
    '  /sonnet <text>    run this turn on Sonnet',
    '  /haiku <text>     run this turn on Haiku',
    '',
    'Examples:',
    '  /plan how do we ship this?',
    '  #bmp /opus design the data model',
    '  /yolo #serveeta deploy the staging build',
    '',
    'Anything without a prefix goes to the active session.'
  ].join('\n');
}

function createGateway(kind: GatewayKind, ctx: vscode.ExtensionContext): Gateway {
  switch (kind) {
    case 'whatsapp': {
      const authDir = path.join(ctx.globalStorageUri.fsPath, 'wa-auth');
      return new WhatsAppClient({ authDir });
    }
    case 'telegram': {
      const token = cfg().get<string>('telegram.botToken', '') || '';
      return new TelegramClient({ botToken: token });
    }
    case 'discord': {
      const token = cfg().get<string>('discord.botToken', '') || '';
      return new DiscordClient({ botToken: token });
    }
    case 'slack': {
      const appToken = cfg().get<string>('slack.appToken', '') || '';
      const botToken = cfg().get<string>('slack.botToken', '') || '';
      return new SlackClient({ appToken, botToken });
    }
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const store = new BindingStore(context);
  const activity = new ActivityLog();
  const root = workspaceRoot();
  let gateway: Gateway | undefined;
  const gatewayDisposables: vscode.Disposable[] = [];

  let limiter = new RateLimiter(
    cfg().get<number>('maxMessagesPerHour', 60),
    cfg().get<number>('maxMessagesPerDay', 500)
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeEcho.maxMessagesPerHour') ||
          e.affectsConfiguration('claudeEcho.maxMessagesPerDay')) {
        limiter = new RateLimiter(
          cfg().get<number>('maxMessagesPerHour', 60),
          cfg().get<number>('maxMessagesPerDay', 500)
        );
        logInfo('Rate limits reconfigured.');
      }
    })
  );

  const provider = new BindingProvider(
    store, activity, root,
    () => gateway?.getStatus() ?? 'idle',
    () => gateway?.kind
  );
  const treeView = vscode.window.createTreeView('claudeEcho.main', {
    treeDataProvider: provider,
    showCollapseAll: false
  });
  context.subscriptions.push(treeView);

  function disposeGatewayListeners(): void {
    for (const d of gatewayDisposables) { try { d.dispose(); } catch { /* ignore */ } }
    gatewayDisposables.length = 0;
  }

  function wireGateway(g: Gateway): void {
    disposeGatewayListeners();
    gateway = g;
    setRunningContext(g.getStatus() === 'ready');
    gatewayDisposables.push(
      g.onStatus((s: GatewayStatus) => {
        setRunningContext(s === 'ready');
        provider.refresh();
        if (g.kind === 'whatsapp') {
          updateQrPanel(undefined, describeStatus(s, g.kind));
        }
      }),
      g.onQr((qr: string) => {
        if (g.kind !== 'whatsapp') { return; }
        updateQrPanel(qr, 'Scan the QR code to link the WhatsApp bridge.');
      }),
      g.onMessage((m) => handleIncoming(m).catch((err) => logError('handleIncoming threw', err)))
    );
  }

  async function sendSafe(to: string, body: string): Promise<void> {
    if (!gateway) { return; }
    try { await gateway.sendText(to, body); }
    catch (err) { logError(`sendText failed to ${to}`, err); }
  }

  async function handleIncoming(msg: IncomingMessage): Promise<void> {
    if (!root) { return; }
    const ws = store.get(root);
    if (!ws) { logWarn('Incoming message ignored: no workspace binding.'); return; }
    if (msg.isGroup) { logInfo(`Dropping group message from ${msg.from}`); return; }

    const allowedId = (ws.allowedId || '').trim();
    const senderId = (msg.senderId || '').trim();
    if (!allowedId || !senderIdMatches(ws.gateway, senderId, allowedId)) {
      logWarn(`Dropping message from disallowed sender ${senderId} (allowed=${allowedId})`);
      activity.push('error', `Dropped (sender not allowlisted): ${senderId}`);
      return;
    }
    if (!msg.body || !msg.body.trim()) { return; }

    const verbose = cfg().get<boolean>('verboseLogging', false);

    // Verification gate (WhatsApp only — other gateways verify by typed user ID).
    if (!ws.verified) {
      if (ws.gateway !== 'whatsapp') {
        await store.patch(root, { verified: true, pendingChallenge: undefined });
      } else {
        const outcome = checkChallenge(ws.pendingChallenge, msg.body);
        if (outcome.matched) {
          await store.patch(root, { verified: true, pendingChallenge: undefined });
          activity.push('system', 'Number verified ✓');
          logInfo('Verification challenge matched. Workspace verified.');
          await sendSafe(msg.from,
            `[Claude Echo]\nNumber verified ✓\nType /help for commands.\n${listText({ ...ws, verified: true })}`);
          return;
        }
        if (outcome.expired) {
          activity.push('error', 'Verification code expired');
          await sendSafe(msg.from, '[bridge] The verification code expired. In VSCode run "Claude Echo: Regenerate verification code" to get a new one.');
          return;
        }
        const hint = ws.pendingChallenge
          ? `Send the verification code shown in VSCode (format: ${formatChallenge(ws.pendingChallenge.code)}).`
          : 'In VSCode run "Claude Echo: Regenerate verification code" to issue one.';
        await sendSafe(msg.from, `[bridge] Number not yet verified. ${hint}`);
        activity.push('error', 'Dropped — awaiting verification');
        return;
      }
    }

    const parsed = parseMessage(msg.body);

    if (parsed.kind === 'help')  { await sendSafe(msg.from, helpText()); return; }
    if (parsed.kind === 'list')  { await sendSafe(msg.from, listText(ws)); return; }
    if (parsed.kind === 'where') {
      const a = activeBinding(ws);
      await sendSafe(msg.from, a ? `Active: ${a.tag} — ${a.sessionTitle}` : 'No active session.');
      return;
    }
    if (parsed.kind === 'use') {
      const target = findBindingByTag(ws, parsed.tag);
      if (!target) { await sendSafe(msg.from, `Unknown tag "${parsed.tag}".\n${listText(ws)}`); return; }
      await store.setActive(root, target.sessionId);
      activity.push('system', `Active session → ${target.tag}`);
      await sendSafe(msg.from, `active → ${target.tag}`);
      return;
    }

    // Routed message
    let targetBinding: SessionBinding | undefined;
    if (parsed.tag) {
      targetBinding = findBindingByTag(ws, parsed.tag);
      if (!targetBinding) { await sendSafe(msg.from, `Unknown tag "${parsed.tag}".\n${listText(ws)}`); return; }
    } else {
      targetBinding = activeBinding(ws);
    }
    if (!targetBinding) { await sendSafe(msg.from, 'No bound sessions yet. Bind one from VSCode first.'); return; }
    if (!parsed.body.trim()) { return; }

    const decision = limiter.check();
    if (!decision.ok) {
      logWarn(`Rate limited: ${decision.reason}`);
      activity.push('error', `Rate limited (${limiter.stats().lastHour}/h, ${limiter.stats().lastDay}/d)`);
      await sendSafe(msg.from, `[bridge] ${decision.reason}`);
      return;
    }

    const maxBytes = cfg().get<number>('maxInboundBytes', 4096);
    let prompt = parsed.body;
    let truncated = false;
    if (maxBytes > 0 && Buffer.byteLength(prompt, 'utf8') > maxBytes) {
      prompt = Buffer.from(prompt, 'utf8').subarray(0, maxBytes).toString('utf8');
      truncated = true;
    }

    const modifierTag = [parsed.mode, parsed.model].filter(Boolean).join('|');
    const modifierSuffix = modifierTag ? ` {${modifierTag}}` : '';
    activity.push('inbound', `> [${targetBinding.tag}${modifierSuffix}] ${redactBody(prompt, verbose)}${truncated ? ' [truncated]' : ''}`);
    logInfo(`Inbound -> ${targetBinding.tag}${modifierSuffix}: ${redactBody(prompt, verbose)}${truncated ? ' (truncated)' : ''}`);

    const timeoutMs = cfg().get<number>('responseTimeoutMs', 120_000);
    const cliPath = cfg().get<string>('claudeCliPath', 'claude') || 'claude';

    limiter.record();
    const result = await runClaudeCli({
      cliPath,
      sessionId: targetBinding.sessionId,
      cwd: ws.workspaceFolder,
      prompt,
      timeoutMs,
      permissionMode: parsed.mode,
      model: parsed.model
    });

    if (!result.ok) {
      const reply = `[bridge error · ${targetBinding.tag}] ${result.error ?? 'unknown error'}`;
      activity.push('error', reply.slice(0, 100));
      logError(`Claude CLI failed for ${targetBinding.tag}: ${result.error}`);
      await sendSafe(msg.from, reply);
      return;
    }

    const replyBody = result.text.trim() || '(empty response)';
    const reply = ws.sessions.length > 1 ? `[${targetBinding.tag}]\n${replyBody}` : replyBody;
    await sendSafe(msg.from, reply);
    activity.push('outbound', `< [${targetBinding.tag}] ${redactBody(replyBody, verbose)}`);
    logInfo(`Outbound from ${targetBinding.tag} (${result.durationMs} ms): ${redactBody(replyBody, verbose)}`);
  }

  function senderIdMatches(gatewayKind: GatewayKind, senderId: string, allowedId: string): boolean {
    if (gatewayKind === 'whatsapp') {
      return digitsOnly(senderId) === digitsOnly(allowedId);
    }
    return senderId === allowedId;
  }

  async function startBridge(opts: { interactive: boolean }): Promise<void> {
    if (!root) { vscode.window.showWarningMessage('Claude Echo: open a workspace folder first.'); return; }
    const ws = store.get(root);
    if (!ws) {
      if (opts.interactive) { vscode.window.showWarningMessage('Claude Echo: bind at least one session first.'); }
      return;
    }
    if (gateway && (gateway.getStatus() === 'ready' || gateway.getStatus() === 'starting')) { return; }

    const g = createGateway(ws.gateway, context);
    wireGateway(g);
    activity.push('system', `Starting ${gatewayDisplayName(ws.gateway)} bridge…`);
    if (opts.interactive && ws.gateway === 'whatsapp') {
      await showQrPanel(g.getLatestQr(), 'Starting WhatsApp client…');
    }
    try {
      await g.start();
      activity.push('system', 'Bridge is ready.');
    } catch (err: any) {
      activity.push('error', `Start failed: ${err?.message ?? err}`);
      if (opts.interactive) {
        vscode.window.showErrorMessage(`Claude Echo: failed to start bridge: ${err?.message ?? err}`);
      }
    }
  }

  async function stopBridge(): Promise<void> {
    if (!gateway || gateway.getStatus() === 'idle') { return; }
    activity.push('system', 'Stopping bridge…');
    try { await gateway.stop(); }
    catch (err: any) { activity.push('error', `Stop failed: ${err?.message ?? err}`); }
  }

  async function pickGateway(currentKind?: GatewayKind): Promise<GatewayKind | undefined> {
    const items: Array<vscode.QuickPickItem & { gatewayKind: GatewayKind }> = [
      { label: '$(comment-discussion) Telegram',  description: 'Recommended — easiest setup, no QR, free, official.', gatewayKind: 'telegram'  },
      { label: '$(comment-discussion) Discord',   description: 'Bot DMs you. Free, official.',                          gatewayKind: 'discord'   },
      { label: '$(comment-discussion) Slack',     description: 'Socket Mode bot, free for personal workspaces.',        gatewayKind: 'slack'     },
      { label: '$(device-mobile) WhatsApp',       description: 'Personal number via Baileys. QR scan, may break.',      gatewayKind: 'whatsapp'  }
    ];
    if (currentKind) {
      const idx = items.findIndex((i) => i.gatewayKind === currentKind);
      if (idx >= 0) { items[idx].label = `$(check) ${items[idx].label.replace(/^\$\([^\)]*\)\s*/, '')}`; }
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Pick a messaging gateway' });
    return pick?.gatewayKind;
  }

  async function promptForAllowedId(kind: GatewayKind, current?: string): Promise<string | undefined> {
    let prompt: string;
    let validateInput: (v: string) => string | undefined;
    let placeHolder: string;
    switch (kind) {
      case 'whatsapp':
        prompt = 'Your WhatsApp number in E.164 (e.g. +15551234567). Only messages from this number will be processed.';
        placeHolder = '+15551234567';
        validateInput = (v) => /^\+\d{6,15}$/.test((v || '').trim()) ? undefined : 'Enter E.164 format, e.g. +15551234567';
        break;
      case 'telegram':
        prompt = 'Your Telegram numeric user ID (chat with @userinfobot to find it). Only messages from this user will be processed.';
        placeHolder = '123456789';
        validateInput = (v) => /^\d{5,15}$/.test((v || '').trim()) ? undefined : 'Numeric user ID, no spaces.';
        break;
      case 'discord':
        prompt = 'Your Discord user ID (Settings → Advanced → Developer Mode, then right-click your name → Copy User ID).';
        placeHolder = '198765432109876543';
        validateInput = (v) => /^\d{10,25}$/.test((v || '').trim()) ? undefined : 'Numeric Discord user ID.';
        break;
      case 'slack':
        prompt = 'Your Slack user ID (starts with U…). Open your Slack profile → … menu → Copy member ID.';
        placeHolder = 'U01ABCDE2FG';
        validateInput = (v) => /^[UW][A-Z0-9]{5,20}$/.test((v || '').trim().toUpperCase()) ? undefined : 'Slack user ID like U01ABCDE2FG.';
        break;
    }
    const input = await vscode.window.showInputBox({ prompt, value: current ?? '', placeHolder, validateInput });
    if (!input) { return undefined; }
    return kind === 'whatsapp' ? sanitizeE164(input) : input.trim();
  }

  async function bulkBindSessions(): Promise<void> {
    if (!root) { vscode.window.showWarningMessage('Claude Echo: open a workspace folder first.'); return; }
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
      placeHolder: `Tick sessions to bind (${sessions.length} available). Space toggles, Enter confirms.`
    });
    if (!picks || picks.length === 0) { return; }
    const fresh = picks.filter((p) => !p.alreadyBound);
    if (fresh.length === 0) {
      vscode.window.showInformationMessage('All picked sessions are already bound.');
      return;
    }

    let workspace = existing;
    if (!workspace) {
      const kind = await pickGateway();
      if (!kind) { return; }

      // Make sure the gateway is configured.
      const cfgError = checkGatewayConfig(kind);
      if (cfgError) {
        const open = await vscode.window.showErrorMessage(`Claude Echo: ${cfgError}`, 'Open settings');
        if (open === 'Open settings') {
          await vscode.commands.executeCommand('workbench.action.openSettings', `claudeEcho.${kind}`);
        }
        return;
      }

      const allowedId = await promptForAllowedId(kind);
      if (!allowedId) { return; }

      const challenge = kind === 'whatsapp' ? generateChallenge() : undefined;
      workspace = {
        workspaceFolder: root,
        gateway: kind,
        allowedId,
        verified: kind !== 'whatsapp', // non-WhatsApp gateways verify by typed ID
        pendingChallenge: challenge,
        sessions: [],
        createdAt: Date.now()
      };
      await store.setWorkspace(workspace);
    }

    const usedTags = new Set(workspace!.sessions.map((s) => s.tag));
    const newBindings: SessionBinding[] = fresh.map((p) => {
      const base = slugifyTitle(p.session.title);
      const tag = uniqueTag(base, usedTags);
      usedTags.add(tag);
      return { sessionId: p.session.sessionId, sessionTitle: p.session.title, tag, addedAt: Date.now() };
    });

    const updated = await store.addSessions(root, newBindings);
    if (!updated) { return; }
    activity.push('system', `Bound ${newBindings.length} session${newBindings.length === 1 ? '' : 's'}: ${newBindings.map((s) => s.tag).join(', ')}`);

    if (updated.gateway === 'whatsapp' && !updated.verified && updated.pendingChallenge) {
      const formatted = formatChallenge(updated.pendingChallenge.code);
      const action = await vscode.window.showInformationMessage(
        `Bound ${newBindings.length} session${newBindings.length === 1 ? '' : 's'}. Verification code: ${formatted}. Start the bridge and send this code via WhatsApp to verify.`,
        'Start bridge',
        'Copy code',
        'Later'
      );
      if (action === 'Copy code') { await vscode.env.clipboard.writeText(updated.pendingChallenge.code); }
      else if (action === 'Start bridge') { await startBridge({ interactive: true }); }
    } else {
      const tags = newBindings.map((s) => s.tag).join(', ');
      const action = await vscode.window.showInformationMessage(
        `Bound: ${tags}. Start the ${gatewayDisplayName(updated.gateway)} bridge now?`,
        'Start bridge',
        'Later'
      );
      if (action === 'Start bridge') { await startBridge({ interactive: true }); }
    }
  }

  function checkGatewayConfig(kind: GatewayKind): string | undefined {
    switch (kind) {
      case 'telegram':
        if (!(cfg().get<string>('telegram.botToken', '') || '').trim()) {
          return 'Set claudeEcho.telegram.botToken first (get it from @BotFather on Telegram).';
        }
        return undefined;
      case 'discord':
        if (!(cfg().get<string>('discord.botToken', '') || '').trim()) {
          return 'Set claudeEcho.discord.botToken first (create a bot at discord.com/developers).';
        }
        return undefined;
      case 'slack':
        if (!(cfg().get<string>('slack.appToken', '') || '').trim() ||
            !(cfg().get<string>('slack.botToken', '') || '').trim()) {
          return 'Set claudeEcho.slack.appToken (xapp-…) AND claudeEcho.slack.botToken (xoxb-…) first.';
        }
        return undefined;
      case 'whatsapp':
        return undefined;
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
    vscode.commands.registerCommand('claudeEcho.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('claudeEcho.bindSessions', () => bulkBindSessions()),
    vscode.commands.registerCommand('claudeEcho.unbindOne', () => unbindSinglePicker()),
    vscode.commands.registerCommand('claudeEcho.setActive', () => setActivePicker()),

    vscode.commands.registerCommand('claudeEcho.unbind', async () => {
      if (!root) { return; }
      const ws = store.get(root);
      if (!ws) { vscode.window.showInformationMessage('No binding to remove.'); return; }
      const choice = await vscode.window.showWarningMessage(
        `Remove the ${gatewayDisplayName(ws.gateway)} binding for this workspace? This unbinds all ${ws.sessions.length} session${ws.sessions.length === 1 ? '' : 's'}.`,
        { modal: true },
        'Unbind'
      );
      if (choice !== 'Unbind') { return; }
      await stopBridge();
      await store.clearWorkspace(root);
      activity.push('system', 'Workspace binding removed.');
    }),

    vscode.commands.registerCommand('claudeEcho.start', () => startBridge({ interactive: true })),
    vscode.commands.registerCommand('claudeEcho.stop', () => stopBridge()),

    vscode.commands.registerCommand('claudeEcho.showQR', async () => {
      if (gateway && gateway.kind === 'whatsapp') {
        await showQrPanel(gateway.getLatestQr(), describeStatus(gateway.getStatus(), 'whatsapp'));
        return;
      }
      vscode.window.showInformationMessage('QR code applies only to the WhatsApp gateway.');
    }),

    vscode.commands.registerCommand('claudeEcho.testSend', async () => {
      if (!root) { return; }
      const ws = store.get(root);
      if (!ws) { vscode.window.showWarningMessage('Bind a session first.'); return; }
      if (!gateway || gateway.getStatus() !== 'ready') {
        vscode.window.showWarningMessage('Start the bridge first.');
        return;
      }
      try {
        const target = ws.allowedId;
        await gateway.sendText(target, `[Claude Echo] Test message at ${new Date().toLocaleString()}`);
        vscode.window.showInformationMessage('Test message sent.');
      } catch (err: any) {
        vscode.window.showErrorMessage(`Test send failed: ${err?.message ?? err}`);
      }
    }),

    vscode.commands.registerCommand('claudeEcho.showLogs', () => getLogger().show()),

    vscode.commands.registerCommand('claudeEcho.resetAuth', async () => {
      const ws = root ? store.get(root) : undefined;
      const kindLabel = ws ? gatewayDisplayName(ws.gateway) : 'gateway';
      const choice = await vscode.window.showWarningMessage(
        `Reset the ${kindLabel} authentication and restart? The bridge will stop, cached credentials wiped, and you may need to re-authenticate.`,
        { modal: true },
        'Reset'
      );
      if (choice !== 'Reset') { return; }
      try {
        await stopBridge();
        // Wipe WhatsApp auth dir (the other gateways store no on-disk auth — tokens stay in settings).
        const authDir = path.join(context.globalStorageUri.fsPath, 'wa-auth');
        const fs = require('fs') as typeof import('fs');
        if (fs.existsSync(authDir)) { fs.rmSync(authDir, { recursive: true, force: true }); }
        activity.push('system', 'Gateway auth cache cleared.');
        if (ws) { await startBridge({ interactive: true }); }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Reset failed: ${err?.message ?? err}.`);
      }
    }),

    vscode.commands.registerCommand('claudeEcho.regenerateChallenge', async () => {
      if (!root) { return; }
      const ws = store.get(root);
      if (!ws || ws.gateway !== 'whatsapp') {
        vscode.window.showInformationMessage('Verification codes only apply to the WhatsApp gateway.');
        return;
      }
      const challenge = generateChallenge();
      await store.patch(root, { verified: false, pendingChallenge: challenge });
      activity.push('system', `New verification code: ${formatChallenge(challenge.code)}`);
      const action = await vscode.window.showInformationMessage(
        `New verification code: ${formatChallenge(challenge.code)}. Send it from ${ws.allowedId} via WhatsApp.`,
        'Copy code'
      );
      if (action === 'Copy code') { await vscode.env.clipboard.writeText(challenge.code); }
    }),

    vscode.commands.registerCommand('claudeEcho.showChallenge', async () => {
      if (!root) { return; }
      const ws = store.get(root);
      if (!ws || ws.gateway !== 'whatsapp') {
        vscode.window.showInformationMessage('Verification codes only apply to the WhatsApp gateway.');
        return;
      }
      if (ws.verified) { vscode.window.showInformationMessage(`Number ${ws.allowedId} is already verified.`); return; }
      if (!ws.pendingChallenge) { vscode.window.showWarningMessage('No pending verification code.'); return; }
      const expiresIn = Math.max(0, Math.round((ws.pendingChallenge.expiresAt - Date.now()) / 60000));
      const action = await vscode.window.showInformationMessage(
        `Verification code: ${formatChallenge(ws.pendingChallenge.code)} (expires in ~${expiresIn} min)`,
        'Copy code',
        'Regenerate'
      );
      if (action === 'Copy code') { await vscode.env.clipboard.writeText(ws.pendingChallenge.code); }
      else if (action === 'Regenerate') { await vscode.commands.executeCommand('claudeEcho.regenerateChallenge'); }
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

function describeStatus(s: GatewayStatus, kind: GatewayKind): string {
  switch (s) {
    case 'idle': return 'Not running.';
    case 'starting': return `Starting ${gatewayDisplayName(kind)} client…`;
    case 'qr': return 'Scan the QR with WhatsApp to authenticate.';
    case 'connecting': return 'Reconnecting…';
    case 'ready': return `Listening on ${gatewayDisplayName(kind)}.`;
    case 'stopping': return 'Stopping…';
    case 'error': return 'Error — see Output → "Claude Echo".';
  }
}
