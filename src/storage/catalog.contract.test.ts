import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionHandle } from '../provider/index.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import type { Catalog } from './catalog.js';
import { currentVersionOf } from './catalog.js';
import { makeFileCatalog } from './fileCatalog.js';
import { makeMemoryCatalog } from './memoryCatalog.js';
import type { Lineage } from './types.js';
import { PlaygroundId, VersionId } from './types.js';

// The provider-agnostic contract every Catalog must satisfy, run against each local
// adapter. A new backend proves itself by passing this same suite.
interface Harness {
  readonly catalog: Catalog;
  readonly close: () => Promise<void>;
}

const ADAPTERS: ReadonlyArray<{ readonly name: string; readonly open: () => Promise<Harness> }> = [
  {
    name: 'memory',
    open: async () => ({ catalog: makeMemoryCatalog(), close: async () => {} }),
  },
  {
    name: 'file',
    open: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tp-catalog-'));
      return { catalog: makeFileCatalog(join(dir, 'catalog.json')), close: () => rm(dir, { recursive: true, force: true }) };
    },
  },
];

const handle = (provider: string, session: string, turn: string): SessionHandle => ({
  providerId: ProviderId(provider),
  sessionId: SessionId(session),
  turnId: TurnId(turn),
});

describe.each(ADAPTERS)('Catalog contract: $name', ({ open }) => {
  it('round-trips the full session → turn → version record', async () => {
    const { catalog, close } = await open();
    try {
      const created = await catalog.createPlayground({
        handle: handle('tmux', 'session-1', 'turn-1'),
        prompt: 'a bouncing ball',
        version: VersionId('version-1'),
        lineage: null,
      });
      const got = await catalog.getPlayground(created.id);

      expect(got.id).toBe(created.id);
      expect(got.session.providerId).toBe(ProviderId('tmux'));
      expect(got.session.sessionId).toBe(SessionId('session-1'));
      expect(got.session.turns[0].turnId).toBe(TurnId('turn-1'));
      expect(got.session.turns[0].prompt).toBe('a bouncing ball');
      expect(got.session.turns[0].version).toBe(VersionId('version-1'));
      expect(got.session.lineage).toBeNull();
    } finally {
      await close();
    }
  });

  it('lists playgrounds in insertion order with a derived summary', async () => {
    const { catalog, close } = await open();
    try {
      const first = await catalog.createPlayground({
        handle: handle('tmux', 'session-1', 'turn-1'),
        prompt: 'first',
        version: VersionId('version-1'),
        lineage: null,
      });
      const second = await catalog.createPlayground({
        handle: handle('tmux', 'session-2', 'turn-2'),
        prompt: 'second',
        version: VersionId('version-2'),
        lineage: null,
      });

      const list = await catalog.listPlaygrounds();
      expect(list.map((s) => s.id)).toEqual([first.id, second.id]);

      const summary = list.find((s) => s.id === first.id);
      expect(summary?.prompt).toBe('first');
      expect(summary?.providerId).toBe(ProviderId('tmux'));
      expect(summary?.currentVersion).toBe(VersionId('version-1'));
    } finally {
      await close();
    }
  });

  it('fails loudly on an unknown playground rather than returning null', async () => {
    const { catalog, close } = await open();
    try {
      await expect(catalog.getPlayground(PlaygroundId('does-not-exist'))).rejects.toThrow(/unknown playground/);
    } finally {
      await close();
    }
  });

  it('keeps fork lineage a separate axis from version history', async () => {
    const { catalog, close } = await open();
    try {
      const lineage: Lineage = {
        parentSession: SessionId('parent-session'),
        forkedFromVersion: VersionId('parent-version'),
      };
      const forked = await catalog.createPlayground({
        handle: handle('tmux', 'child-session', 'child-turn'),
        prompt: 'remix of the parent',
        version: VersionId('own-version'),
        lineage,
      });
      const got = await catalog.getPlayground(forked.id);

      expect(got.session.lineage).toEqual(lineage);
      // This playground's own version history is its own version, never the parent's —
      // the two axes do not bleed into each other.
      expect(currentVersionOf(got.session)).toBe(VersionId('own-version'));
      expect(got.session.lineage?.forkedFromVersion).toBe(VersionId('parent-version'));
      expect(currentVersionOf(got.session)).not.toBe(got.session.lineage?.forkedFromVersion);
    } finally {
      await close();
    }
  });
});
