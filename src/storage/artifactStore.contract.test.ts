import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ArtifactStore } from './artifactStore.js';
import { makeFileArtifactStore } from './fileArtifactStore.js';
import { makeMemoryArtifactStore } from './memoryArtifactStore.js';
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

  it('refuses a non-self-contained artifact at the seam, before minting or writing anything', async () => {
    const { store, close } = await open();
    try {
      // The single enforcement point: every backend rejects an external reference identically, and
      // does so BEFORE writing — a refused artifact leaves no version behind to be mistaken for real.
      await expect(store.put({ html: '<script src="https://cdn.example.com/x.js"></script>' })).rejects.toThrow(
        /not self-contained.*https:\/\/cdn\.example\.com\/x\.js/,
      );
    } finally {
      await close();
    }
  });
});
