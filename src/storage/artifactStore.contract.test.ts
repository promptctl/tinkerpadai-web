import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Artifact } from '../provider/index.js';
import type { ArtifactStore, BlobStore } from './artifactStore.js';
import { makeArtifactStore } from './artifactStore.js';
import { makeFileArtifactStore } from './fileArtifactStore.js';
import { makeMemoryArtifactStore } from './memoryArtifactStore.js';
import { MAX_ARTIFACT_BYTES } from './selfContainment.js';
import { VersionId } from './types.js';

// The provider-agnostic contract every ArtifactStore must satisfy, run against each
// local adapter. New backends prove themselves by passing this same suite — the seam
// is honest only if its laws hold regardless of where the bytes live.
interface Harness {
  readonly store: ArtifactStore;
  readonly close: () => Promise<void>;
}

const ADAPTERS: ReadonlyArray<{ readonly name: string; readonly open: () => Promise<Harness> }> = [
  {
    name: 'memory',
    open: async () => ({ store: makeMemoryArtifactStore(), close: async () => {} }),
  },
  {
    name: 'file',
    open: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tp-artifact-'));
      return { store: makeFileArtifactStore(dir), close: () => rm(dir, { recursive: true, force: true }) };
    },
  },
];

describe.each(ADAPTERS)('ArtifactStore contract: $name', ({ open }) => {
  it('round-trips the stored file under its minted version', async () => {
    const { store, close } = await open();
    try {
      const version = await store.put({ html: '<h1>hello</h1>' });
      expect((await store.get(version)).html).toBe('<h1>hello</h1>');
    } finally {
      await close();
    }
  });

  it('mints a fresh version per put — byte-identical files never overwrite', async () => {
    const { store, close } = await open();
    try {
      const first = await store.put({ html: 'same bytes' });
      const second = await store.put({ html: 'same bytes' });
      expect(first).not.toBe(second);
      expect((await store.get(first)).html).toBe('same bytes');
      expect((await store.get(second)).html).toBe('same bytes');
    } finally {
      await close();
    }
  });

  it('fails loudly on an unknown version rather than returning an empty file', async () => {
    const { store, close } = await open();
    try {
      await expect(store.get(VersionId('does-not-exist'))).rejects.toThrow(/unknown version/);
    } finally {
      await close();
    }
  });

  it('refuses a non-self-contained artifact at the seam, identically across backends', async () => {
    const { store, close } = await open();
    try {
      // The single enforcement point: every backend rejects an external reference identically. That the
      // refusal happens BEFORE any write is verified separately, where a spy BlobStore can observe it —
      // this each-block only claims what it can see through the interface. [LAW:behavior-not-structure]
      await expect(store.put({ html: '<script src="https://cdn.example.com/x.js"></script>' })).rejects.toThrow(
        /not self-contained.*https:\/\/cdn\.example\.com\/x\.js/,
      );
    } finally {
      await close();
    }
  });

  it('refuses an oversize artifact at the seam — the size cap is gated through the same single enforcer', async () => {
    const { store, close } = await open();
    try {
      // The oversize path is the enforcer's OTHER branch; every backend must surface it identically,
      // exactly as the external-resource path does.
      await expect(store.put({ html: 'a'.repeat(MAX_ARTIFACT_BYTES + 1) })).rejects.toThrow(
        /not self-contained.*over the .* limit/,
      );
    } finally {
      await close();
    }
  });
});

// The "refuse BEFORE writing" invariant, verified where it is OBSERVABLE: a spy BlobStore over the real
// makeArtifactStore records every write, so we can assert a rejected put touched the backend zero times.
// The each-block above cannot see this through the ArtifactStore interface (no enumeration method), so
// the claim lives here, proven behaviorally rather than trusted from ordering. [LAW:behavior-not-structure]
// [LAW:verifiable-goals]
describe('makeArtifactStore refuses a non-self-contained artifact before it reaches the backend', () => {
  it('never calls blobs.write when the artifact violates self-containment', async () => {
    const writes: Artifact[] = [];
    const spy: BlobStore = {
      async write(_versionId: VersionId, artifact: Artifact): Promise<void> {
        writes.push(artifact);
      },
      async read(): Promise<Artifact | undefined> {
        return undefined;
      },
    };
    const store = makeArtifactStore(spy);

    await expect(store.put({ html: '<link rel="stylesheet" href="https://cdn.example.com/x.css">' })).rejects.toThrow(
      /not self-contained/,
    );
    await expect(store.put({ html: 'a'.repeat(MAX_ARTIFACT_BYTES + 1) })).rejects.toThrow(/not self-contained/);
    expect(writes).toEqual([]);

    // And a self-contained artifact DOES reach the backend — the gate rejects, it does not block writes.
    await store.put({ html: '<h1>ok</h1>' });
    expect(writes).toHaveLength(1);
  });
});
