export type Parsed =
  | { kind: 'message'; tag?: string; body: string }
  | { kind: 'list' }
  | { kind: 'use'; tag: string }
  | { kind: 'where' }
  | { kind: 'help' };

/**
 * Parses a WhatsApp message body into a routable intent.
 *
 *   "/list"              -> { kind: 'list' }
 *   "/use serveeta"      -> { kind: 'use', tag: 'serveeta' }
 *   "/where"             -> { kind: 'where' }
 *   "/help"              -> { kind: 'help' }
 *   "#bmp deploy?"       -> { kind: 'message', tag: 'bmp', body: 'deploy?' }
 *   "hello"              -> { kind: 'message', body: 'hello' }
 *
 * Slash commands and tags are case-insensitive. Tag normalization mirrors
 * `slugifyTitle` (lowercased, alphanumeric+dash).
 */
export function parseMessage(rawBody: string): Parsed {
  const body = (rawBody || '').trim();
  if (!body) { return { kind: 'message', body: '' }; }

  // Slash commands
  if (body.startsWith('/')) {
    const slashRest = body.slice(1);
    const space = slashRest.search(/\s/);
    const verb = (space < 0 ? slashRest : slashRest.slice(0, space)).toLowerCase();
    const rest = space < 0 ? '' : slashRest.slice(space + 1).trim();
    switch (verb) {
      case 'list':  return { kind: 'list' };
      case 'where': return { kind: 'where' };
      case 'help':  return { kind: 'help' };
      case 'use':
      case 'switch': {
        const tag = normalizeTag(rest);
        if (!tag) { return { kind: 'help' }; }
        return { kind: 'use', tag };
      }
    }
    // Unknown slash command — treat as ordinary message (the user might be quoting code).
  }

  // Tag prefix
  if (body.startsWith('#')) {
    const rest = body.slice(1);
    const space = rest.search(/\s/);
    if (space > 0) {
      const tag = normalizeTag(rest.slice(0, space));
      const text = rest.slice(space + 1).trim();
      if (tag) { return { kind: 'message', tag, body: text }; }
    }
  }

  return { kind: 'message', body };
}

function normalizeTag(s: string): string {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9\-]/g, '');
}
