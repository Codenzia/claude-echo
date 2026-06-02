import * as crypto from 'crypto';

// Excludes ambiguous chars (0/O, 1/I/L) so users can read & type easily.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface Challenge {
  code: string;
  issuedAt: number;
  expiresAt: number;
}

export const CHALLENGE_TTL_MS = 30 * 60 * 1000;

export function generateChallenge(now: number = Date.now()): Challenge {
  const bytes = crypto.randomBytes(8);
  let raw = '';
  for (let i = 0; i < 6; i++) {
    raw += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return {
    code: raw,
    issuedAt: now,
    expiresAt: now + CHALLENGE_TTL_MS
  };
}

/** Renders as `XK7-9PQ` for readability. */
export function formatChallenge(code: string): string {
  if (code.length <= 3) { return code; }
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/** Normalizes user input — strip dashes/whitespace, uppercase. */
function normalize(s: string): string {
  return (s || '').replace(/[\s\-]/g, '').toUpperCase();
}

export interface VerificationOutcome {
  matched: boolean;
  expired: boolean;
}

export function checkChallenge(challenge: Challenge | undefined, body: string, now: number = Date.now()): VerificationOutcome {
  if (!challenge) { return { matched: false, expired: false }; }
  if (now > challenge.expiresAt) { return { matched: false, expired: true }; }
  const normBody = normalize(body);
  const normCode = normalize(challenge.code);
  // Allow the user to send the code with extra context, e.g. "verify XK7-9PQ".
  return { matched: normBody.includes(normCode), expired: false };
}
