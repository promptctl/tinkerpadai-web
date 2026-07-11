import { describe, expect, it } from 'vitest';
import type { R2Bucket } from '@cloudflare/workers-types';
import { artifactObjectKey } from './artifactStore.js';
import { makeMemoryThumbnailStore } from './memoryThumbnailStore.js';
import { makeR2ThumbnailStore } from './r2ThumbnailStore.js';
import type { ThumbnailStore } from './thumbnailStore.js';
import { thumbnailObjectKey } from './thumbnailStore.js';
import { VersionId } from './types.js';

// The backend-agnostic contract every ThumbnailStore must satisfy, run against each backend we ship. A
// new backend proves itself by passing this same suite — the seam is honest only if its laws hold
// wherever the bytes live. The three points pin the seam's behaviour, TWO of them the deliberate inverse
// of the artifact store: absence is a value, not a loud error; and a re-put overwrites (a derived cache
// re-renders), it does not mint-and-preserve.

const png = (bytes: readonly number[]): Uint8Array => Uint8Array.from(bytes);

// A faithful in-memory fake of the exact R2 surface the adapter touches: put(key, ArrayBufferView) and
// get(key) -> { arrayBuffer() } | null. A present key returns an object whose arrayBuffer() yields the
// stored bytes; an absent key returns null, exactly as R2 does. [LAW:one-type-per-behavior]
const makeFakeR2 = (): R2Bucket => {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key: string, value: Uint8Array): Promise<unknown> {
      objects.set(key, Uint8Array.from(value));
      return {};
    },
    async get(key: string): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null> {
      const value = objects.get(key);
      if (value === undefined) return null;
      // A fresh ArrayBuffer-backed copy, exactly as R2's arrayBuffer() hands back a standalone buffer.
      const copy = new Uint8Array(value);
      return { arrayBuffer: async () => copy.buffer };
    },
  } as unknown as R2Bucket;
};

const ADAPTERS: ReadonlyArray<{ readonly name: string; readonly open: () => ThumbnailStore }> = [
  { name: 'memory', open: () => makeMemoryThumbnailStore() },
  { name: 'r2', open: () => makeR2ThumbnailStore(makeFakeR2()) },
];

describe.each(ADAPTERS)('ThumbnailStore contract: $name', ({ open }) => {
  it('round-trips the stored png under its version', async () => {
    const store = open();
    const version = VersionId('v-1');
    await store.put(version, png([137, 80, 78, 71]));
    expect(await store.get(version)).toEqual(png([137, 80, 78, 71]));
  });

  it('reads back undefined for a version with no thumbnail — absence is a value, not a loud error', async () => {
    // The inverse of ArtifactStore.get, which throws on an unknown version. "No thumbnail yet" is a
    // legitimate state the consumer renders as an empty slot, so it MUST NOT throw. [LAW:no-defensive-null-guards]
    const store = open();
    expect(await store.get(VersionId('never-rendered'))).toBeUndefined();
  });

  it('a re-put replaces the bytes for the same version — a derived cache re-renders', async () => {
    // The inverse of the artifact store's never-overwrite immutability: re-rendering a version (a better
    // renderer, a repaired pipeline) is a plain re-put, and the latest bytes win. [LAW:one-source-of-truth]
    const store = open();
    const version = VersionId('v-2');
    await store.put(version, png([1, 1, 1]));
    await store.put(version, png([2, 2, 2, 2]));
    expect(await store.get(version)).toEqual(png([2, 2, 2, 2]));
  });
});

// The disjointness invariant, pinned directly: a thumbnail key and the artifact key for the SAME version
// are never equal, so a thumbnail write can never land on the .html it derives from — even in a shared
// bucket. [LAW:one-source-of-truth]
describe('thumbnail and artifact keys for one version are disjoint', () => {
  it('never collide', () => {
    const version = VersionId('same-version');
    expect(thumbnailObjectKey(version)).not.toBe(artifactObjectKey(version));
  });
});
