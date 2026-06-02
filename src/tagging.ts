const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'could', 'do',
  'does', 'for', 'from', 'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its',
  'me', 'my', 'of', 'on', 'or', 'our', 'should', 'that', 'the', 'their',
  'this', 'to', 'was', 'we', 'were', 'will', 'with', 'would', 'you', 'your',
  'check', 'show', 'help', 'lets', 'so', 'just', 'about'
]);

/** Slugify a session title into a short tag (e.g. "serveeta", "filament-shopping"). */
export function slugifyTitle(title: string): string {
  const cleaned = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) { return 'session'; }
  const words = cleaned.split(' ').filter((w) => !!w && !STOPWORDS.has(w));
  const picked = words.length > 0 ? words.slice(0, 2).join('-') : cleaned.split(' ').slice(0, 2).join('-');
  const slug = picked.replace(/[^a-z0-9\-]/g, '').replace(/^-|-$/g, '');
  return slug.slice(0, 20) || 'session';
}

/** Ensure tag is unique among `existing`; append -2, -3, etc. if needed. */
export function uniqueTag(base: string, existing: Iterable<string>): string {
  const taken = new Set<string>();
  for (const t of existing) { taken.add(t); }
  if (!taken.has(base)) { return base; }
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) { return candidate; }
  }
  return `${base}-${Date.now().toString(36)}`;
}
