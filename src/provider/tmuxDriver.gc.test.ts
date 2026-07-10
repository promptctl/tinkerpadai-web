import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKDIR_ROOT, evictIdleWorkdirs } from './tmuxDriver.js';

// The idle-workdir GC's binding of the shared age mechanism. The mechanism itself (the pure policy and the
// scan/stat/rm effect) is exercised exhaustively in dirRetention.test.ts; here we prove the WORKDIR
// binding — evictIdleWorkdirs reclaims cold dirs under WORKDIR_ROOT and leaves warm ones — against real
// dirs with controlled mtimes. The full re-seed-after-eviction round trip is the live test's job.
// [LAW:behavior-not-structure]

// The driver keys every workdir under WORKDIR_ROOT; the test stages dirs under that same exported
// constant so there is no mirrored literal to drift from. [LAW:one-source-of-truth]
const ROOT = WORKDIR_ROOT;

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
