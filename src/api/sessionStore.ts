import { randomBytes } from 'node:crypto';
import type { Subject } from './identity.js';

// THE SESSION STORE — the single owner of live sessions. It maps an opaque, unguessable token
// (the value that rides in the cookie) to the principal that token authenticates. The login
// route mints sessions here; the resolver looks them up. It is the one authoritative record of
// "which tokens are live", so nothing else may hold that truth. [LAW:one-source-of-truth]
// [LAW:no-shared-mutable-globals] — a single owner, an explicit API, one instance wired at the
// composition root.
//
// In-memory because the local dev thread is one process and a dev session's honest lifetime IS
// the life of that process — it dies on restart, which is correct, not a gap. Token minting is
// the store's own effect (randomness), held here because the store owns session lifecycle.
// [LAW:effects-at-boundaries] A typed session lifecycle — expiry, logout — is the next slice
// (qw8.3); today a token maps directly to its Subject and the seam below does not change when
// that internal shape grows.
export interface SessionStore {
  // Mint a new session for a principal and return its opaque token (the cookie value).
  create(subject: Subject): string;
  // The principal a token authenticates, or null when no live session carries that token.
  lookup(token: string): Subject | null;
}

export const makeMemorySessionStore = (): SessionStore => {
  const sessions = new Map<string, Subject>();
  return {
    // 32 random bytes, base64url — URL- and cookie-safe (no `;`, `=`, or whitespace), with
    // ~256 bits of entropy so a token cannot be guessed. [LAW:no-silent-failure]
    create: (subject) => {
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, subject);
      return token;
    },
    lookup: (token) => sessions.get(token) ?? null,
  };
};
