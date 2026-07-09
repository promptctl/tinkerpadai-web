import { randomBytes } from 'node:crypto';
import type { Subject } from './identity.js';

// THE SESSION STORE — the single owner of live sessions AND their lifecycle. It maps an opaque,
// unguessable token (the value that rides in the cookie) to the principal that token authenticates,
// for as long as that session is alive. The login route mints sessions here; the resolver looks
// them up; logout destroys them; and a session that has outlived its ttl is dead on next lookup.
// It is the one authoritative record of "which tokens are live", so nothing else may hold that
// truth. [LAW:one-source-of-truth] [LAW:no-shared-mutable-globals] — a single owner, an explicit
// API, one instance wired at the composition root.
//
// In-memory because the local dev thread is one process and a dev session's honest lifetime IS the
// life of that process — it dies on restart, which is correct, not a gap. Two effects are the
// store's own and live here because the store owns session lifecycle: token minting (randomness)
// and reading the clock to decide expiry. The clock is INJECTED, not read ambiently, so the store
// stays the lifecycle owner while time is an explicit capability the composition root supplies and
// tests control deterministically. [LAW:effects-at-boundaries] [LAW:no-ambient-temporal-coupling]
export interface SessionStoreDeps {
  // The clock, as a capability: epoch milliseconds. Injected so expiry is owned, testable, and
  // never an ambient read buried in lookup. [LAW:no-ambient-temporal-coupling]
  readonly now: () => number;
  // A session's lifetime from creation, in milliseconds. Required, not defaulted: there is no
  // "sessions live forever" mode — the owner states the policy explicitly. [LAW:types-are-the-program]
  readonly ttlMs: number;
}

// Every operation is async. A durable backend (Cloudflare D1/KV at the edge) reaches the session
// record over I/O, so the seam's truthful type is a Promise — the in-memory dev store simply
// resolves immediately. A synchronous signature would be a type "too strong but false" for any
// store that survives a process restart, forcing that store to lie or block. The resolver and the
// enforcer await these, so the async reality lives in the type, not in folklore about which backend
// is wired. [LAW:types-are-the-program] [LAW:effects-at-boundaries]
export interface SessionStore {
  // Mint a new session for a principal and return its opaque token (the cookie value). The session
  // is alive until its ttl elapses.
  create(subject: Subject): Promise<string>;
  // The principal a token authenticates, or null when no LIVE session carries that token — absent,
  // expired, and destroyed are one observable value (null) the resolver matches.
  lookup(token: string): Promise<Subject | null>;
  // End a session now (logout). Idempotent: destroying an absent or already-dead token is a
  // harmless no-op, so a logout never needs to know whether a session was really there.
  destroy(token: string): Promise<void>;
}

// What the store holds per token. `expiresAt` is computed once at create (now + ttl) and is the one
// source of truth for when this session dies — lookup compares against it rather than re-deriving
// from a stored createdAt + ttl. [LAW:one-source-of-truth]
interface SessionRecord {
  readonly subject: Subject;
  readonly expiresAt: number;
}

export const makeMemorySessionStore = (deps: SessionStoreDeps): SessionStore => {
  const { now, ttlMs } = deps;
  const sessions = new Map<string, SessionRecord>();
  return {
    // 32 random bytes, base64url — URL- and cookie-safe (no `;`, `=`, or whitespace), with
    // ~256 bits of entropy so a token cannot be guessed. [LAW:no-silent-failure]
    create: async (subject) => {
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { subject, expiresAt: now() + ttlMs });
      return token;
    },
    // Absent → null; expired → evict and null; live → its principal. Lazy eviction on observation
    // keeps the map from accumulating dead sessions in a long-lived process — the store reclaiming
    // a session it knows is dead, which is the lifecycle owner doing its job, not a hidden effect.
    lookup: async (token) => {
      const record = sessions.get(token);
      if (record === undefined) return null;
      if (now() >= record.expiresAt) {
        sessions.delete(token);
        return null;
      }
      return record.subject;
    },
    destroy: async (token) => {
      sessions.delete(token);
    },
  };
};
