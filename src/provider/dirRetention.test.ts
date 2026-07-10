import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictExpiredDirs, expiredByAge } from './dirRetention.js';
import type { AgedEntry } from './dirRetention.js';

// The shared age-based directory-retention mechanism. The PURE policy (expiredByAge) is exercised
// exhaustively and deterministically; the EFFECT (evictExpiredDirs) is exercised against a real staged
// root with controlled mtimes so the readdir/stat/rm glue is proven without any live producer. Both
// owners (the workdir janitor, the diagnostics sweeper) ride on this, so proving it once proves the
// reclaim for both. [LAW:behavior-not-structure]

describe('expiredByAge — the pure age policy', () => {
  const entry = (name: string, mtimeMs: number): AgedEntry => ({ name, mtimeMs });

  it('selects nothing from an empty set — data flow, not a special case', () => {
    expect(expiredByAge([], 1000, 100)).toEqual([]);
  });

  it('selects only entries older than maxAgeMs, keeping recently-written ones', () => {
    const now = 10_000;
    const entries = [entry('fresh', 9_950), entry('stale', 8_000), entry('warm', 9_000)];
    // age = now - mtime, expired when strictly greater than maxAgeMs (1000):
    // fresh=50 keep, stale=2000 evict, warm=1000 keep (not strictly greater).
    expect(expiredByAge(entries, now, 1000)).toEqual(['stale']);
  });

  it('treats exactly-at-the-threshold as still fresh', () => {
    expect(expiredByAge([entry('x', 0)], 1000, 1000)).toEqual([]);
    expect(expiredByAge([entry('x', 0)], 1001, 1000)).toEqual(['x']);
  });
});

describe('evictExpiredDirs — removes aged children, keeps fresh ones', () => {
  let root: string;

  // A real child dir under the staged root with a forced mtime. mkdir then write bump the dir mtime to
  // now, so utimes runs LAST to set the intended age. [LAW:no-ambient-temporal-coupling]
  const makeChild = async (mtimeMs: number): Promise<string> => {
    const name = `entry-${randomUUID()}`;
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'payload'), 'x', 'utf8');
    const when = new Date(mtimeMs);
    await utimes(dir, when, when);
    return name;
  };

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes a child older than maxAgeMs and leaves a freshly-written one', async () => {
    root = await mkdtemp(join(tmpdir(), 'dir-retention-'));
    const now = Date.now();
    const cold = await makeChild(now - 60_000);
    const warm = await makeChild(now);

    const evicted = await evictExpiredDirs({ root, maxAgeMs: 10_000, nowMs: now });

    expect(evicted).toEqual([cold]);
    await expect(stat(join(root, cold))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(join(root, warm))).isDirectory()).toBe(true);
  });

  it('skips a child that vanished before stat (ENOENT) and still evicts the aged ones', async () => {
    root = await mkdtemp(join(tmpdir(), 'dir-retention-'));
    const now = Date.now();
    const cold = await makeChild(now - 60_000);
    // A broken symlink is listed by readdir but stat (which follows it) throws ENOENT — exactly the shape
    // of a child reaped between readdir and stat (cleanupTurn racing the janitor). The sweep must skip it
    // and still evict the genuinely-expired dir, never reject the whole cycle.
    await symlink(join(root, 'reaped-mid-sweep'), join(root, 'vanished'));

    const evicted = await evictExpiredDirs({ root, maxAgeMs: 10_000, nowMs: now });

    expect(evicted).toEqual([cold]);
  });

  it('skips an unreadable child (non-ENOENT) loudly and still evicts the aged ones', async () => {
    root = await mkdtemp(join(tmpdir(), 'dir-retention-'));
    const now = Date.now();
    const cold = await makeChild(now - 60_000);
    // A symlink loop makes stat throw ELOOP — a real, non-ENOENT fault on that entry (the durable dir's
    // EACCES/EIO analogue). One bad child must not abort the sweep: the aged dir is still evicted, and the
    // fault is surfaced loudly rather than swallowed. [LAW:no-silent-failure]
    await symlink(join(root, 'loop-b'), join(root, 'loop-a'));
    await symlink(join(root, 'loop-a'), join(root, 'loop-b'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    const evicted = await evictExpiredDirs({ root, maxAgeMs: 10_000, nowMs: now });

    expect(evicted).toEqual([cold]);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('skipping unreadable retention entry'), expect.anything());
    errorLog.mockRestore();
  });

  it('treats a missing root as an empty set, never an error', async () => {
    root = join(tmpdir(), `dir-retention-absent-${randomUUID()}`);
    await expect(evictExpiredDirs({ root, maxAgeMs: 10_000, nowMs: Date.now() })).resolves.toEqual([]);
  });
});
