import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evictIdleWorkdirs, expiredWorkdirs } from './tmuxDriver.js';
import type { WorkdirEntry } from './tmuxDriver.js';

// The idle-workdir GC. The PURE policy (expiredWorkdirs) is exercised exhaustively and
// deterministically here; the EFFECT (evictIdleWorkdirs) is exercised against real dirs
// with controlled mtimes so the readdir/stat/rm glue is proven without the live agent.
// The full re-seed-after-eviction round trip is the live test's job. [LAW:behavior-not-structure]

// The driver keys every workdir under this root; the test mirrors that one constant so a
// drift in where dirs live would make the effect test find nothing and fail loudly.
const ROOT = join(tmpdir(), 'tinkerpad-gen');

describe('expiredWorkdirs — the pure idle policy', () => {
  const entry = (name: string, mtimeMs: number): WorkdirEntry => ({ name, mtimeMs });

  it('selects nothing from an empty set — data flow, not a special case', () => {
    expect(expiredWorkdirs([], 1000, 100)).toEqual([]);
  });

  it('evicts only dirs idle longer than maxIdleMs, keeping recently-touched ones', () => {
    const now = 10_000;
    const entries = [entry('fresh', 9_950), entry('stale', 8_000), entry('warm', 9_000)];
    // idle = now - mtime, expired when strictly greater than maxIdleMs (1000):
    // fresh=50 keep, stale=2000 evict, warm=1000 keep (not strictly greater).
    expect(expiredWorkdirs(entries, now, 1000)).toEqual(['stale']);
  });

  it('treats exactly-at-the-threshold as still fresh', () => {
    expect(expiredWorkdirs([entry('x', 0)], 1000, 1000)).toEqual([]);
    expect(expiredWorkdirs([entry('x', 0)], 1001, 1000)).toEqual(['x']);
  });
});

describe('evictIdleWorkdirs — removes cold dirs, keeps warm ones', () => {
  const created: string[] = [];

  // Create a real workdir under ROOT and force its mtime. mkdir then write bump the dir
  // mtime to now, so utimes runs LAST to set the intended age. [LAW:no-ambient-temporal-coupling]
  const makeDir = async (mtimeMs: number): Promise<string> => {
    const name = `gc-test-${randomUUID()}`;
    const dir = join(ROOT, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'playground.html'), '<!-- x -->', 'utf8');
    const when = new Date(mtimeMs);
    await utimes(dir, when, when);
    created.push(dir);
    return name;
  };

  afterEach(async () => {
    await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
    created.length = 0;
  });

  it('evicts a dir idle past maxIdleMs and leaves a freshly-touched one', async () => {
    const now = Date.now();
    const cold = await makeDir(now - 60_000);
    const warm = await makeDir(now);

    const evicted = await evictIdleWorkdirs({ maxIdleMs: 10_000, nowMs: now });

    // Assert by membership, never exclusivity: the shared root may hold other dirs.
    expect(evicted).toContain(cold);
    expect(evicted).not.toContain(warm);
    await expect(stat(join(ROOT, cold))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(join(ROOT, warm))).isDirectory()).toBe(true);
  });
});
