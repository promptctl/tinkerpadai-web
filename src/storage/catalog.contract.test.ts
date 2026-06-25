import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Subject } from '../identity/index.js';
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

// A fixed author for the create writes. Every playground has one; the contract proves it is
// recorded, projected onto the summary, and preserved across an append (which never re-authors).
const AUTHOR = Subject('ada');

describe.each(ADAPTERS)('Catalog contract: $name', ({ open }) => {
  it('round-trips the full session → turn → version record', async () => {
    const { catalog, close } = await open();
    try {
      const created = await catalog.createPlayground({
        handle: handle('tmux', 'session-1', 'turn-1'),
        prompt: 'a bouncing ball',
        version: VersionId('version-1'),
        lineage: null,
        author: AUTHOR,
      });
      const got = await catalog.getPlayground(created.id);

      expect(got.id).toBe(created.id);
      expect(got.session.providerId).toBe(ProviderId('tmux'));
      expect(got.session.sessionId).toBe(SessionId('session-1'));
      expect(got.session.turns[0].turnId).toBe(TurnId('turn-1'));
      expect(got.session.turns[0].prompt).toBe('a bouncing ball');
      expect(got.session.turns[0].version).toBe(VersionId('version-1'));
      expect(got.session.lineage).toBeNull();
      // The author is recorded on the session — who made this playground, stored once at create.
      expect(got.session.author).toBe(AUTHOR);
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
        author: AUTHOR,
      });
      const second = await catalog.createPlayground({
        handle: handle('tmux', 'session-2', 'turn-2'),
        prompt: 'second',
        version: VersionId('version-2'),
        lineage: null,
        author: AUTHOR,
      });

      const list = await catalog.listPlaygrounds();
      expect(list.map((s) => s.id)).toEqual([first.id, second.id]);

      const summary = list.find((s) => s.id === first.id);
      expect(summary?.prompt).toBe('first');
      expect(summary?.providerId).toBe(ProviderId('tmux'));
      expect(summary?.currentVersion).toBe(VersionId('version-1'));
      // Authorship is projected onto the summary the commons reads — derived, never re-stored.
      expect(summary?.author).toBe(AUTHOR);
    } finally {
      await close();
    }
  });

  it('appends a follow-up turn as a new version; the current version becomes the latest', async () => {
    const { catalog, close } = await open();
    try {
      const created = await catalog.createPlayground({
        handle: handle('tmux', 'session-1', 'turn-1'),
        prompt: 'a counter',
        version: VersionId('version-1'),
        lineage: null,
        author: AUTHOR,
      });

      const updated = await catalog.appendTurn(created.id, {
        handle: handle('tmux', 'session-1', 'turn-2'),
        prompt: 'add a reset button',
        version: VersionId('version-2'),
      });

      // Turns are preserved in order, both versions remain addressable, and the derived
      // current version is the newest — the read path serves it with no change.
      expect(updated.session.turns.map((t) => t.turnId)).toEqual([TurnId('turn-1'), TurnId('turn-2')]);
      expect(updated.session.turns.map((t) => t.version)).toEqual([VersionId('version-1'), VersionId('version-2')]);
      expect(currentVersionOf(updated.session)).toBe(VersionId('version-2'));
      // Appending a turn is the version-history axis, never the fork axis — lineage is untouched.
      expect(updated.session.lineage).toBeNull();
      // Nor does appending re-author: a follow-up extends the original author's playground.
      expect(updated.session.author).toBe(AUTHOR);

      const got = await catalog.getPlayground(created.id);
      expect(currentVersionOf(got.session)).toBe(VersionId('version-2'));
      // The commons summary now reflects the latest version while keeping the original prompt.
      const summary = (await catalog.listPlaygrounds()).find((s) => s.id === created.id);
      expect(summary?.prompt).toBe('a counter');
      expect(summary?.currentVersion).toBe(VersionId('version-2'));
    } finally {
      await close();
    }
  });

  it('appending to an unknown playground fails loudly', async () => {
    const { catalog, close } = await open();
    try {
      await expect(
        catalog.appendTurn(PlaygroundId('does-not-exist'), {
          handle: handle('tmux', 'session-x', 'turn-x'),
          prompt: 'nope',
          version: VersionId('version-x'),
        }),
      ).rejects.toThrow(/unknown playground/);
    } finally {
      await close();
    }
  });

  it('rejects a follow-up turn minted against a different session', async () => {
    const { catalog, close } = await open();
    try {
      const created = await catalog.createPlayground({
        handle: handle('tmux', 'session-1', 'turn-1'),
        prompt: 'a counter',
        version: VersionId('version-1'),
        lineage: null,
        author: AUTHOR,
      });
      await expect(
        catalog.appendTurn(created.id, {
          handle: handle('tmux', 'a-different-session', 'turn-2'),
          prompt: 'foreign turn',
          version: VersionId('version-2'),
        }),
      ).rejects.toThrow(/does not belong/);
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

  it('projects fork attribution onto the summary, resolving the parent to a browsable reference', async () => {
    const { catalog, close } = await open();
    try {
      const parent = await catalog.createPlayground({
        handle: handle('tmux', 'parent-session', 'parent-turn'),
        prompt: 'the original',
        version: VersionId('parent-version'),
        lineage: null,
        author: AUTHOR,
      });
      const child = await catalog.createPlayground({
        handle: handle('tmux', 'child-session', 'child-turn'),
        prompt: 'a remix',
        version: VersionId('child-version'),
        lineage: { parentSession: SessionId('parent-session'), forkedFromVersion: VersionId('parent-version') },
        author: AUTHOR,
      });

      const list = await catalog.listPlaygrounds();
      // A non-fork carries no attribution; a fork resolves to the parent's browsable id AND its
      // original describe (the title the commons shows) — derived over the catalog, never stored.
      expect(list.find((s) => s.id === parent.id)?.forkedFrom).toBeNull();
      expect(list.find((s) => s.id === child.id)?.forkedFrom).toEqual({
        parent: { id: parent.id, prompt: 'the original' },
      });
    } finally {
      await close();
    }
  });

  it('surfaces the fork fact without a parent link when the parent is not in the commons', async () => {
    const { catalog, close } = await open();
    try {
      const orphan = await catalog.createPlayground({
        handle: handle('tmux', 'child-session', 'child-turn'),
        prompt: 'a remix of a departed parent',
        version: VersionId('child-version'),
        lineage: { parentSession: SessionId('gone-session'), forkedFromVersion: VersionId('gone-version') },
        author: AUTHOR,
      });

      const summary = (await catalog.listPlaygrounds()).find((s) => s.id === orphan.id);
      // It is durably a fork, but the parent has left — attribution present, parent null.
      expect(summary?.forkedFrom).toEqual({ parent: null });
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
        author: AUTHOR,
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
