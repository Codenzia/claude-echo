/**
 * Shortens a message body for logs/activity so private chat content isn't leaked
 * when a user shares diagnostics. Set `verbose` to true to bypass.
 */
export function redactBody(body: string, verbose: boolean): string {
  if (verbose) { return body; }
  const safe = (body || '').replace(/\s+/g, ' ').trim();
  if (!safe) { return '(empty)'; }
  const head = safe.slice(0, 8);
  return `${head}… [${safe.length} chars]`;
}
