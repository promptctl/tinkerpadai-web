import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ── Age-based directory retention ─────────────────────────────────────────────
// The shared MECHANISM behind every mtime-age sweep in the system: given a root whose children are each
// one reclaimable unit, remove the ones whose last write is older than a max age. Two owners configure it
// differently — the tmux workdir janitor (root = the tmpdir session cache, age = an IDLE horizon: each
// turn rewrites its dir, so mtime is last activity) and the durable diagnostics retention sweeper (root =
// dataDir/diagnostics, age = a USEFULNESS horizon: each record is written once, so mtime is its creation).
// The mechanism is one part; the policy — which root, how old, whether to sweep eagerly on boot — lives in
// each owner. That is the seam: shared mechanism, distinct policy owners. [LAW:one-type-per-behavior]

// One scanned child under a swept root: its name and when it was last written (its mtime).
export interface AgedEntry {
  readonly name: string;
  readonly mtimeMs: number;
}

// The PURE policy: which entries at nowMs are older than maxAgeMs. Strictly-greater, so an entry exactly
// at the threshold is still kept. Pure, so the policy is verified without touching the clock or disk.
// [LAW:effects-at-boundaries]
export const expiredByAge = (
  entries: readonly AgedEntry[],
  nowMs: number,
  maxAgeMs: number,
): readonly string[] => entries.filter((entry) => nowMs - entry.mtimeMs > maxAgeMs).map((entry) => entry.name);

export interface EvictExpiredDirsOptions {
  readonly root: string;
  readonly maxAgeMs: number;
  readonly nowMs: number;
}

// The EFFECT: read root's children, decide with the pure policy, remove the expired ones, and return the
// removed names for logging and verification. A missing root means nothing has been written there yet — a
// real empty state, not an error to swallow; any other read failure throws loudly. The clock is a value
// passed in (nowMs), never read here, so the reclaim is deterministic given a staged root.
// [LAW:no-silent-failure] [LAW:effects-at-boundaries]
export const evictExpiredDirs = async (opts: EvictExpiredDirsOptions): Promise<readonly string[]> => {
  const names = await readdir(opts.root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const entries = await Promise.all(
    names.map(async (name): Promise<AgedEntry | null> => {
      // A child removed between the readdir above and this stat — a concurrent reclaim, e.g. cleanupTurn
      // reaping a workdir while the janitor sweeps — is a REAL absence: the entry is already gone, so there
      // is nothing to evict. Lift that into a null the filter drops, so one vanished child never rejects the
      // whole sweep. Any other stat error is a genuine fault and throws loudly.
      // [LAW:dataflow-not-control-flow] [LAW:no-silent-failure]
      const stats = await stat(join(opts.root, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      return stats === null ? null : { name, mtimeMs: stats.mtimeMs };
    }),
  );
  const present = entries.filter((entry): entry is AgedEntry => entry !== null);
  const expired = expiredByAge(present, opts.nowMs, opts.maxAgeMs);
  await Promise.all(expired.map((name) => rm(join(opts.root, name), { recursive: true, force: true })));
  return expired;
};
