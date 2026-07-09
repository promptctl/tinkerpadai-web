import type { D1Database } from '@cloudflare/workers-types';
import { Subject } from '../identity/index.js';
import type { SessionStore, SessionStoreDeps } from './sessionStore.js';
import { mintSessionToken } from './sessionStore.js';

// THE DURABLE SESSION STORE for the edge — the D1-backed sibling of the in-memory dev store, behind
// the identical SessionStore seam (create/lookup/destroy). It survives Worker cold starts, which is
// the whole reason it exists: an isolate can be discarded between requests, so live sessions cannot
// live in isolate memory. D1 (strongly consistent SQL) is chosen over KV (eventually consistent, up
// to ~60s propagation) precisely because a just-minted session MUST be readable on the very next
// request — the login redirect lands the browser back immediately, and an eventually-consistent read
// would flash it as logged-out. The clock and ttl are injected exactly as for the memory store, so
// expiry is owned and testable, never an ambient read. [LAW:types-are-the-program]
// [LAW:no-ambient-temporal-coupling] [LAW:one-source-of-truth]
//
// The `sessions` table is created by a migration at deploy time (migrations/0001_init.sql), NOT
// lazily here — the schema has one owner. A missing table is a real deploy failure that propagates
// loudly, never masked. [LAW:single-enforcer] [LAW:no-silent-failure]
export const makeD1SessionStore = (db: D1Database, deps: SessionStoreDeps): SessionStore => {
  const { now, ttlMs } = deps;
  return {
    create: async (subject) => {
      const token = mintSessionToken();
      await db
        .prepare('INSERT INTO sessions (token, subject, expires_at) VALUES (?, ?, ?)')
        .bind(token, subject, now() + ttlMs)
        .run();
      return token;
    },
    // Absent → null; expired → delete and null; live → its principal. Expiry is evaluated against the
    // injected clock and the stored deadline, and a session observed past its deadline is deleted
    // (the lifecycle owner reclaiming a session it knows is dead), exactly mirroring the memory
    // store's lazy eviction. The stored subject is re-branded through Subject() at this trust
    // boundary — a plain TEXT column crossing back into the domain type. [LAW:dataflow-not-control-flow]
    lookup: async (token) => {
      const row = await db
        .prepare('SELECT subject, expires_at AS expiresAt FROM sessions WHERE token = ?')
        .bind(token)
        .first<{ subject: string; expiresAt: number }>();
      if (row === null) return null;
      if (now() >= row.expiresAt) {
        await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
        return null;
      }
      return Subject(row.subject);
    },
    destroy: async (token) => {
      await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    },
  };
};
