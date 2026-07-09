import { describe, expect, it } from 'vitest';
import type { R2Bucket } from '@cloudflare/workers-types';
import { makeR2ArtifactStore } from './r2ArtifactStore.js';
import { VersionId } from './types.js';

// The R2 adapter's distinctive behavior, asserted at the ArtifactStore contract with a faithful
// in-memory fake of the exact R2 surface it touches (put + get→text()/null). The seam invariants
// (fresh version per put, unknown version is loud) come from makeArtifactStore; what is NEW here is
// the null-object → undefined translation, so that is what these tests pin. [LAW:behavior-not-structure]

// A fake R2 bucket: a Map of key → bytes, exposing only the two methods the adapter calls. A present
// key returns an object whose text() yields the stored string; an absent key returns null, exactly as
// R2 does. [LAW:one-type-per-behavior]
const makeFakeR2 = (): R2Bucket => {
  const objects = new Map<string, string>();
  return {
    async put(key: string, value: string): Promise<unknown> {
      objects.set(key, value);
      return {};
    },
    async get(key: string): Promise<{ text: () => Promise<string> } | null> {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
  } as unknown as R2Bucket;
};

describe('makeR2ArtifactStore', () => {
  it('round-trips a stored file under the version it mints', async () => {
    const store = makeR2ArtifactStore(makeFakeR2());
    const version = await store.put({ html: '<html><body>hi</body></html>' });
    expect((await store.get(version)).html).toBe('<html><body>hi</body></html>');
  });

  it('mints a fresh version per put — two identical files are two distinct versions', async () => {
    const store = makeR2ArtifactStore(makeFakeR2());
    const a = await store.put({ html: '<html></html>' });
    const b = await store.put({ html: '<html></html>' });
    expect(a).not.toBe(b);
    expect((await store.get(a)).html).toBe('<html></html>');
    expect((await store.get(b)).html).toBe('<html></html>');
  });

  it('a genuinely absent object (R2 null) surfaces as a loud unknown-version error, not empty bytes', async () => {
    const store = makeR2ArtifactStore(makeFakeR2());
    await expect(store.get(VersionId('never-written'))).rejects.toThrow('unknown version: never-written');
  });
});
