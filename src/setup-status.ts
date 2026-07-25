/**
 * Product setup status derivation.
 * ----------------------------------------------------------------------------
 * Pure logic — no DB, no HTTP, no filesystem. Turns raw product facts into the
 * four-step checklist the dashboard renders.
 *
 * Three of the four setup steps are observable by the server. Embedding the
 * public key into the product's own app is NOT (it happens in a different
 * repository), so the operator marks it. To stop that mark from outliving the
 * key it was made for, it stores a fingerprint of the public key it was made
 * against — a `keygen --force` rotation then flips the step to `stale` rather
 * than leaving a checkmark that no longer reflects reality.
 */
import crypto from 'crypto';

export type PrivateKeySource = 'env' | 'local-file' | 'none';
export type EmbedState = 'pending' | 'done' | 'stale';
export type SetupPill = 'ready' | 'needs-setup' | 'stale';

/** Operator's assertion that the public key was embedded in the product's app. */
export interface EmbedMark {
  /** ISO timestamp the mark was made. */
  at: string;
  /** Admin username who marked it. */
  by: string;
  /** Fingerprint of the public key the mark was made against. */
  key_fp: string;
}

/**
 * Stable fingerprint of a public key PEM.
 *
 * ALL whitespace is stripped before hashing. The same key legitimately shows up
 * with different whitespace — round-tripped through MySQL, pasted via the
 * clipboard, or supplied through an env var holding literal "\n" sequences (see
 * normalizePem in keys.ts). Hashing the raw string would make a trailing
 * newline or a CRLF look like a key rotation and raise a false `stale`.
 */
export function publicKeyFingerprint(pem: string): string {
  const stripped = (pem || '').replace(/\\n/g, '').replace(/\s+/g, '');
  return crypto.createHash('sha256').update(stripped).digest('hex').slice(0, 16);
}

/**
 * Resolve the embed step. `stale` means a mark exists but was made against a
 * different key — the app is running with a public key that no longer matches.
 */
export function deriveEmbedState(publicKey: string | null, mark: EmbedMark | null): EmbedState {
  if (!mark) return 'pending';
  // A mark with no key to embed cannot be `done`; there is nothing it describes.
  if (!publicKey) return 'stale';
  return mark.key_fp === publicKeyFingerprint(publicKey) ? 'done' : 'stale';
}

/**
 * Roll the steps up into the single pill shown in the table. First match wins.
 *
 * `stale` is checked first and rendered distinctly because it is the actively
 * broken state, not merely an unfinished one.
 *
 * Note `source === 'local-file'` still counts as ready: this server cannot tell
 * "never deployed to Railway" apart from "deployed, but you are viewing a local
 * dashboard", so it must not gate `ready` on that difference. The expanded
 * panel surfaces the nuance instead.
 */
export function deriveSetupPill(input: {
  hasKeypair: boolean;
  source: PrivateKeySource;
  embed: EmbedState;
}): SetupPill {
  if (input.embed === 'stale') return 'stale';
  if (!input.hasKeypair || input.source === 'none' || input.embed === 'pending') {
    return 'needs-setup';
  }
  return 'ready';
}
