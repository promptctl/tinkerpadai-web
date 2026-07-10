import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDiagnosticsRetentionSweeper } from './tmuxDriver.js';
import type { DiagnosticsRetentionSweeper } from './tmuxDriver.js';

// The durable-diagnostics retention sweeper's OWNER behavior. The reclaim mechanism itself is proven in
// dirRetention.test.ts; here we prove the one thing this owner adds over the mechanism and over the
// in-memory turn sweeper — an EAGER first sweep on boot, warranted because the dir is DURABLE and can hold
// records orphaned across a restart. The clock is injected so the sweep is deterministic with no real
// timer wait. [LAW:behavior-not-structure]

describe('startDiagnosticsRetentionSweeper — eager sweep reclaims stale records, keeps fresh ones', () => {
  let dir: string;
  let sweeper: DiagnosticsRetentionSweeper | undefined;

  // A real diagnostics record with a forced mtime — a per-failure subdir holding its evidence, exactly the
  // shape makeWorkdirDiagnostics writes. utimes runs LAST so mkdir/write don't bump the age back to now.
  const seedRecord = async (mtimeMs: number): Promise<string> => {
    const name = `session-${randomUUID()}-turn-${randomUUID()}`;
    const record = join(dir, name);
    await mkdir(record, { recursive: true });
    await writeFile(join(record, 'failure.txt'), 'generation timed out', 'utf8');
    await writeFile(join(record, 'prompt.txt'), 'build a wave explorer', 'utf8');
    const when = new Date(mtimeMs);
    await utimes(record, when, when);
    return name;
  };

  const exists = (name: string): Promise<boolean> => stat(join(dir, name)).then(() => true, () => false);

  afterEach(async () => {
    sweeper?.stop();
    sweeper = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('reclaims a record older than the retention window on boot and leaves a recent one', async () => {
    dir = await mkdtemp(join(tmpdir(), 'diagnostics-retention-'));
    const now = Date.now();
    const retentionMs = 24 * 60 * 60 * 1000; // one day
    const stale = await seedRecord(now - retentionMs - 60_000); // a minute past the window
    const fresh = await seedRecord(now - 60_000); // a minute old, well within it

    // A far-future sweep interval so ONLY the eager boot sweep can run — the behavior under test.
    sweeper = startDiagnosticsRetentionSweeper(dir, { retentionMs, sweepIntervalMs: 60 * 60 * 1000, now: () => now });

    await expect.poll(() => exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });
});
