export type PermissionMode = 'plan' | 'acceptEdits' | 'bypassPermissions';
export type ModelAlias = 'opus' | 'sonnet' | 'haiku';

export type Parsed =
  | { kind: 'message'; tag?: string; body: string; mode?: PermissionMode; model?: ModelAlias }
  | { kind: 'list' }
  | { kind: 'use'; tag: string }
  | { kind: 'where' }
  | { kind: 'help' };

/** Per-message modifier verbs that translate into Claude CLI flags. */
const MODE_VERBS: Record<string, PermissionMode> = {
  plan: 'plan',
  auto: 'acceptEdits',
  yolo: 'bypassPermissions'
};
const MODEL_VERBS: Record<string, ModelAlias> = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku'
};

/**
 * Parses a chat-side message into a routable intent.
 *
 *   "/list"                          -> { kind: 'list' }
 *   "/use serveeta"                  -> { kind: 'use', tag: 'serveeta' }
 *   "/where" / "/help"               -> { kind: 'where' | 'help' }
 *   "#bmp deploy?"                   -> { kind: 'message', tag: 'bmp', body: 'deploy?' }
 *   "/plan how should we proceed?"   -> { kind: 'message', mode: 'plan', body: '...' }
 *   "/opus design the api"           -> { kind: 'message', model: 'opus', body: '...' }
 *   "#bmp /plan migration?"          -> { kind: 'message', tag: 'bmp', mode: 'plan', body: '...' }
 *   "/auto #serveeta refactor"       -> { kind: 'message', tag: 'serveeta', mode: 'acceptEdits', body: '...' }
 *
 * Modifiers can appear in any order before the body; routing/control commands
 * (/list, /use, /where, /help) must be the first token.
 */
export function parseMessage(rawBody: string): Parsed {
  let body = (rawBody || '').trim();
  if (!body) { return { kind: 'message', body: '' }; }

  // Routing/control verbs win if they're the FIRST token.
  if (body.startsWith('/')) {
    const verb = firstToken(body).slice(1).toLowerCase();
    if (verb === 'list')  { return { kind: 'list' }; }
    if (verb === 'where') { return { kind: 'where' }; }
    if (verb === 'help')  { return { kind: 'help' }; }
    if (verb === 'use' || verb === 'switch') {
      const tag = normalizeTag(restAfterFirstToken(body));
      if (!tag) { return { kind: 'help' }; }
      return { kind: 'use', tag };
    }
  }

  // Strip modifier prefixes in any order: /plan, /auto, /yolo, /opus, /sonnet, /haiku, #tag.
  let tag: string | undefined;
  let mode: PermissionMode | undefined;
  let model: ModelAlias | undefined;
  let progressed = true;
  while (progressed) {
    progressed = false;
    if (body.startsWith('#')) {
      const rest = body.slice(1);
      const space = rest.search(/\s/);
      if (space > 0) {
        const candidate = normalizeTag(rest.slice(0, space));
        if (candidate && !tag) {
          tag = candidate;
          body = rest.slice(space + 1).trim();
          progressed = true;
          continue;
        }
      }
    }
    if (body.startsWith('/')) {
      const verb = firstToken(body).slice(1).toLowerCase();
      if (verb in MODE_VERBS && !mode) {
        mode = MODE_VERBS[verb];
        body = restAfterFirstToken(body);
        progressed = true;
        continue;
      }
      if (verb in MODEL_VERBS && !model) {
        model = MODEL_VERBS[verb];
        body = restAfterFirstToken(body);
        progressed = true;
        continue;
      }
    }
  }

  return { kind: 'message', tag, mode, model, body };
}

function firstToken(s: string): string {
  const idx = s.search(/\s/);
  return idx < 0 ? s : s.slice(0, idx);
}

function restAfterFirstToken(s: string): string {
  const idx = s.search(/\s/);
  return idx < 0 ? '' : s.slice(idx + 1).trim();
}

function normalizeTag(s: string): string {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9\-]/g, '');
}
