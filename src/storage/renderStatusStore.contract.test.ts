import { describe, expect, it } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';
import { makeMemoryRenderStatusStore } from './memoryRenderStatusStore.js';
import { makeKvRenderStatusStore } from './kvRenderStatusStore.js';
import type { RenderStatusStore } from './renderStatusStore.js';
import { parseRenderStatus, renderStateOf } from './renderStatusStore.js';
import { VersionId } from './types.js';

// The backend-agnostic contract every RenderStatusStore must satisfy, run against each backend we ship. The
// seam is honest only if its laws hold wherever the status lives: set overwrites, an absent version reads
// back `undefined` (a value, not a loud error), and clear returns a version to that absent state.

// A faithful in-memory fake of the exact KV surface the adapter touches: put(key, string), get(key) ->
// string | null (default text), delete(key). A present key returns the stored string; an absent key
// returns null, exactly as KV does. [LAW:one-type-per-behavior]
const makeFakeKv = (): KVNamespace => {
  const entries = new Map<string, string>();
  return {
    async put(key: string, value: string): Promise<void> {
      entries.set(key, value);
    },
    async get(key: string): Promise<string | null> {
      return entries.get(key) ?? null;
    },
    async delete(key: string): Promise<void> {
      entries.delete(key);
    },
  } as unknown as KVNamespace;
};

const ADAPTERS: ReadonlyArray<{ readonly name: string; readonly open: () => RenderStatusStore }> = [
  { name: 'memory', open: () => makeMemoryRenderStatusStore() },
  { name: 'kv', open: () => makeKvRenderStatusStore(makeFakeKv()) },
];

describe.each(ADAPTERS)('RenderStatusStore contract: $name', ({ open }) => {
  it('round-trips a stored status under its version', async () => {
    const store = open();
    await store.set(VersionId('v-1'), 'pending');
    expect(await store.get(VersionId('v-1'))).toBe('pending');
    await store.set(VersionId('v-1'), 'failed');
    expect(await store.get(VersionId('v-1'))).toBe('failed');
  });

  it('reads back undefined for a version with no status — absence is a value, not a loud error', async () => {
    // The version exists and is usable; it simply has no render status (never enqueued, or cleared after a
    // successful render). That MUST NOT throw. [LAW:no-defensive-null-guards]
    const store = open();
    expect(await store.get(VersionId('never-enqueued'))).toBeUndefined();
  });

  it('clear returns a version to the absent state; clearing an absent version is a no-op', async () => {
    const store = open();
    await store.set(VersionId('v-2'), 'pending');
    await store.clear(VersionId('v-2'));
    expect(await store.get(VersionId('v-2'))).toBeUndefined();
    // Idempotent: clearing again does not throw. [LAW:dataflow-not-control-flow]
    await store.clear(VersionId('v-2'));
    expect(await store.get(VersionId('v-2'))).toBeUndefined();
  });
});

// The read boundary rejects a tampered value loudly rather than coercing it to a wrong render-state.
// [LAW:types-are-the-program] [LAW:no-silent-failure]
describe('parseRenderStatus at the read boundary', () => {
  it('maps null to undefined and passes the two valid statuses through', () => {
    expect(parseRenderStatus(null)).toBeUndefined();
    expect(parseRenderStatus('pending')).toBe('pending');
    expect(parseRenderStatus('failed')).toBe('failed');
  });

  it('throws loudly on a value only tampering could store — never a silent wrong state', () => {
    expect(() => parseRenderStatus('rendered')).toThrow(/malformed/);
    expect(() => parseRenderStatus('')).toThrow(/malformed/);
  });
});

// The derived three-state view the commons card reads. The thumbnail blob is the source of truth for
// 'rendered' — a present thumbnail wins over any stale status; a missing thumbnail defers to the explicit
// status, defaulting to 'pending'. [LAW:one-source-of-truth]
describe('renderStateOf derivation', () => {
  it('a present thumbnail is rendered, regardless of a stale status', () => {
    expect(renderStateOf(true, undefined)).toBe('rendered');
    expect(renderStateOf(true, 'pending')).toBe('rendered');
    // Even a stale 'failed' loses to a real thumbnail: a version that failed then re-rendered IS rendered.
    expect(renderStateOf(true, 'failed')).toBe('rendered');
  });

  it('no thumbnail defers to the status, with absent reading as the honest pending', () => {
    expect(renderStateOf(false, undefined)).toBe('pending');
    expect(renderStateOf(false, 'pending')).toBe('pending');
    expect(renderStateOf(false, 'failed')).toBe('failed');
  });
});
