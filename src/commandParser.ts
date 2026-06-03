import { controlVerbs, modeVerbToMode, modelVerbToModel, PermissionMode, ModelAlias } from './commands';

export type { PermissionMode, ModelAlias };

export type Parsed =
  | { kind: 'message'; tag?: string; body: string; mode?: PermissionMode; model?: ModelAlias }
  | { kind: 'list' }
  | { kind: 'use'; tag: string }
  | { kind: 'where' }
  | { kind: 'help' };

const CTRL = controlVerbs();

/**
 * Parses a chat-side message into a routable intent. Verb tables come from
 * `commands.ts` so adding a new command in one place wires both the parser
 * and the /help text generator at once.
 */
export function parseMessage(rawBody: string): Parsed {
  let body = (rawBody || '').trim();
  if (!body) { return { kind: 'message', body: '' }; }

  // Routing/control verbs win if they're the FIRST token.
  if (body.startsWith('/')) {
    const verb = firstToken(body).slice(1).toLowerCase();
    if (CTRL.has(verb)) {
      if (verb === 'list')  { return { kind: 'list' }; }
      if (verb === 'where') { return { kind: 'where' }; }
      if (verb === 'help')  { return { kind: 'help' }; }
      if (verb === 'use' || verb === 'switch') {
        const tag = normalizeTag(restAfterFirstToken(body));
        if (!tag) { return { kind: 'help' }; }
        return { kind: 'use', tag };
      }
    }
  }

  // Modifier prefixes in any order: #tag, /plan, /auto, /yolo, /opus, /sonnet, /haiku.
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
      if (!mode) {
        const m = modeVerbToMode(verb);
        if (m) {
          mode = m;
          body = restAfterFirstToken(body);
          progressed = true;
          continue;
        }
      }
      if (!model) {
        const md = modelVerbToModel(verb);
        if (md) {
          model = md;
          body = restAfterFirstToken(body);
          progressed = true;
          continue;
        }
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
