/**
 * Single source of truth for chat-side commands.
 *
 * Every verb the bot recognizes lives here. Both the parser (commandParser.ts)
 * and the /help text generator (extension.ts) derive from this registry —
 * adding a new command means adding one entry here and nothing else can
 * silently drift out of sync.
 */

export type PermissionMode = 'plan' | 'acceptEdits' | 'bypassPermissions';
export type ModelAlias = 'opus' | 'sonnet' | 'haiku';

export type CommandCategory = 'control' | 'modifier-mode' | 'modifier-model' | 'routing-prefix';

export interface CommandDef {
  category: CommandCategory;
  /** The bareword after the leading slash (or empty for prefix-style commands). */
  verb: string;
  /** Aliases that map to the same intent (e.g. 'switch' for 'use'). */
  aliases?: string[];
  /** Display syntax for /help — e.g. "/use <tag>" or "#<tag> <text>". */
  syntax: string;
  /** One-line description for /help. */
  description: string;
  /** Optional concrete example for /help. */
  example?: string;
  /** For modifier-mode commands: the Claude CLI --permission-mode value. */
  permissionMode?: PermissionMode;
  /** For modifier-model commands: the Claude CLI --model value. */
  model?: ModelAlias;
}

export const COMMANDS: CommandDef[] = [
  // Control & routing
  {
    category: 'control', verb: 'list', syntax: '/list',
    description: 'list bound sessions'
  },
  {
    category: 'control', verb: 'where', syntax: '/where',
    description: 'show currently active session'
  },
  {
    category: 'control', verb: 'use', aliases: ['switch'],
    syntax: '/use <tag>',
    description: 'switch the active session',
    example: '/use bmp'
  },
  {
    category: 'control', verb: 'help', syntax: '/help',
    description: 'this command reference'
  },
  {
    category: 'routing-prefix', verb: '',
    syntax: '#<tag> <text>',
    description: 'one-off route to a specific session (does not change active)',
    example: '#bmp how is the migration?'
  },

  // Per-message permission-mode modifiers
  {
    category: 'modifier-mode', verb: 'plan',
    syntax: '/plan <text>',
    description: 'plan mode — returns a plan, no execution',
    example: '/plan how should we ship this?',
    permissionMode: 'plan'
  },
  {
    category: 'modifier-mode', verb: 'auto',
    syntax: '/auto <text>',
    description: 'acceptEdits — auto-applies file edits',
    example: '/auto refactor the validator',
    permissionMode: 'acceptEdits'
  },
  {
    category: 'modifier-mode', verb: 'yolo',
    syntax: '/yolo <text>',
    description: 'bypassPermissions — use rarely; no permission checks',
    example: '/yolo deploy now',
    permissionMode: 'bypassPermissions'
  },

  // Per-message model modifiers
  {
    category: 'modifier-model', verb: 'opus',
    syntax: '/opus <text>',
    description: 'run this turn on Opus (best for design + reasoning)',
    model: 'opus'
  },
  {
    category: 'modifier-model', verb: 'sonnet',
    syntax: '/sonnet <text>',
    description: 'run this turn on Sonnet (balanced default)',
    model: 'sonnet'
  },
  {
    category: 'modifier-model', verb: 'haiku',
    syntax: '/haiku <text>',
    description: 'run this turn on Haiku (fast + cheap, light tasks)',
    model: 'haiku'
  }
];

// ---- Derived lookups (do not edit; regenerated from COMMANDS) ----------------

function byCategory(cat: CommandCategory): CommandDef[] {
  return COMMANDS.filter((c) => c.category === cat);
}

export function controlVerbs(): Set<string> {
  const out = new Set<string>();
  for (const c of byCategory('control')) {
    out.add(c.verb);
    for (const a of c.aliases ?? []) { out.add(a); }
  }
  return out;
}

export function modeVerbToMode(verb: string): PermissionMode | undefined {
  const v = verb.toLowerCase();
  for (const c of byCategory('modifier-mode')) {
    if (c.verb === v || c.aliases?.includes(v)) { return c.permissionMode; }
  }
  return undefined;
}

export function modelVerbToModel(verb: string): ModelAlias | undefined {
  const v = verb.toLowerCase();
  for (const c of byCategory('modifier-model')) {
    if (c.verb === v || c.aliases?.includes(v)) { return c.model; }
  }
  return undefined;
}

/** Build the chat-side /help text. Sole renderer; never inline elsewhere. */
export function renderHelp(): string {
  const lines: string[] = ['Claude Echo commands:', ''];

  const control = byCategory('control');
  const routing = byCategory('routing-prefix');
  const modes   = byCategory('modifier-mode');
  const models  = byCategory('modifier-model');

  if (control.length || routing.length) {
    lines.push('Routing & control:');
    for (const c of [...control, ...routing]) {
      lines.push(`  ${c.syntax.padEnd(18)} ${c.description}`);
    }
    lines.push('');
  }

  if (modes.length) {
    lines.push('Per-message permission mode (composes with #tag in any order):');
    for (const c of modes) {
      lines.push(`  ${c.syntax.padEnd(18)} ${c.description}`);
    }
    lines.push('');
  }

  if (models.length) {
    lines.push('Per-message model:');
    for (const c of models) {
      lines.push(`  ${c.syntax.padEnd(18)} ${c.description}`);
    }
    lines.push('');
  }

  const examples = COMMANDS.filter((c) => c.example).slice(0, 3);
  if (examples.length) {
    lines.push('Examples:');
    for (const c of examples) {
      lines.push(`  ${c.example}`);
    }
    lines.push('  /auto #serveeta refactor the form');
    lines.push('');
  }

  lines.push('Anything without a prefix is forwarded to the currently active session.');
  return lines.join('\n');
}
