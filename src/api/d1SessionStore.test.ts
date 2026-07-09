import { describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { Subject } from '../identity/index.js';
import { makeD1SessionStore } from './d1SessionStore.js';

// The D1 session store's contract, asserted with a faithful fake of the exact D1 surface it touches
// (insert / select-by-token / delete). It must behave identically to the in-memory store — mint a
// token that resolves back, expire on the injected clock, evict a dead row on observation, and
// destroy on logout — which is what makes it a true drop-in behind the SessionStore seam. Durability
// across cold starts is inherent to D1 (the row outlives the isolate); here we pin the lifecycle
// logic the adapter owns. [LAW:behavior-not-structure] [LAW:one-type-per-behavior]

// A fake sessions table: Map of token → record, responding to the three statements the adapter
// issues. Exposes size so eviction (a dead row deleted on lookup) is observable.
const makeFakeD1 = (): { db: D1Database; size: () => number } => {
  const rows = new Map<string, { subject: string; expiresAt: number }>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const token = String(args[0]);
          return {
            async first<T>(): Promise<T | null> {
              const row = rows.get(token);
              return row === undefined ? null : ({ subject: row.subject, expiresAt: row.expiresAt } as T);
            },
            async run(): Promise<unknown> {
              if (sql.startsWith('INSERT')) rows.set(token, { subject: String(args[1]), expiresAt: Number(args[2]) });
              else if (sql.startsWith('DELETE')) rows.delete(token);
              else throw new Error(`unexpected run() on: ${sql}`);
              return {};
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, size: () => rows.size };
};

const clockFrom = (start: number) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

const TTL_MS = 60_000;

describe('makeD1SessionStore', () => {
  it('mints a token that resolves back to its principal', async () => {
    const store = makeD1SessionStore(makeFakeD1().db, { now: () => 0, ttlMs: TTL_MS });
    const token = await store.create(Subject('github:42'));
    expect(await store.lookup(token)).toBe('github:42');
  });

  it('returns null for a token it never issued', async () => {
    const store = makeD1SessionStore(makeFakeD1().db, { now: () => 0, ttlMs: TTL_MS });
    expect(await store.lookup('ghost')).toBeNull();
  });

  it('keeps a session live up to its ttl, then evicts and returns null once it elapses', async () => {
    const clock = clockFrom(0);
    const fake = makeFakeD1();
    const store = makeD1SessionStore(fake.db, { now: clock.now, ttlMs: TTL_MS });
    const token = await store.create(Subject('github:42'));

    clock.advance(TTL_MS - 1);
    expect(await store.lookup(token)).toBe('github:42');
    clock.advance(1);
    expect(await store.lookup(token)).toBeNull();
    // The dead row is reclaimed on observation, exactly like the memory store's lazy eviction.
    expect(fake.size()).toBe(0);
  });

  it('destroy ends a session so its token no longer resolves', async () => {
    const store = makeD1SessionStore(makeFakeD1().db, { now: () => 0, ttlMs: TTL_MS });
    const token = await store.create(Subject('github:42'));
    await store.destroy(token);
    expect(await store.lookup(token)).toBeNull();
  });
});
