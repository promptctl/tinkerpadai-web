import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CodeGenDriver, DriverSnapshot } from './codeGenDriver.js';
import type { Artifact, Availability, Brief, ProgressEvent, SessionHandle } from './types.js';

// The real, deliberately crude body behind the Provider seam: it drives Claude Code
// over tmux to turn a brief into a self-contained HTML playground. It is the one
// place in this subsystem that touches the world — processes, files, the clock — and
// it is disposable: swappable for a future provider with zero changes outside this
// file, because everything above it depends only on CodeGenDriver.
// [LAW:effects-at-boundaries]
//
// Mechanism (cheapest thing that proves the seam): each turn gets a private temp
// workdir and a detached tmux session whose pane runs Claude Code in print mode with
// the brief, then writes its shell exit code to a sentinel file. Completion is
// detected by that sentinel — written by the SHELL after the process exits, so it
// does not depend on the agent's cooperation. Success = exit 0 AND a non-empty
// playground file; anything else is a loud failure carrying the surfaced reason.
// [LAW:no-silent-failure]
//
// NOT unit-tested here: its correctness is the live generation, verified by running
// the app (p0v.4/p0v.5). The provider's contract is proven deterministically by the
// scripted driver instead. This file is scripted only against the tmux/claude CLI
// surface that was run by hand first.

const run = promisify(execFile);

export interface TmuxDriverConfig {
  // Milliseconds between completion checks while a turn is running; this is where the
  // driver OWNS pacing so the provider's await-loop never spins. [LAW:no-ambient-temporal-coupling]
  readonly pollIntervalMs?: number;
  // Hard deadline for a single generation; past it the turn fails loudly rather than
  // hanging forever. [LAW:no-silent-failure]
  readonly timeoutMs?: number;
}

const ARTIFACT_FILE = 'playground.html';
const PROMPT_FILE = 'prompt.txt';
const EXIT_FILE = 'exit.code';

// The single root every session workdir lives under — named once so dirOf (which
// resolves one session's dir) and the idle GC (which scans them all) cannot drift on
// where the workdirs are. [LAW:one-source-of-truth]
const WORKDIR_ROOT = join(tmpdir(), 'tinkerpad-gen');

// Per-turn world state the driver owns: where its files live, what its tmux session
// is called, when it must give up, and whether this turn re-seeded a cold workdir (so
// progress can say so honestly). [LAW:one-source-of-truth]
interface TurnWorld {
  readonly dir: string;
  readonly session: string;
  readonly deadline: number;
  readonly reseeded: boolean;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// tmux session names cannot contain '.' or ':'; reduce the turn id to a safe token.
const sessionName = (handle: SessionHandle): string =>
  `tinkerpad-${handle.turnId.replace(/[^A-Za-z0-9_-]/g, '_')}`;

// Read a file, or null if it does not exist yet. Absence is a real, expected state
// here (the sentinel has not appeared), so it is a typed value, not a swallowed
// error — any OTHER failure still throws loudly. [LAW:no-silent-failure]
const readOrNull = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const binaryPresent = async (bin: string, versionFlag: string): Promise<boolean> => {
  try {
    await run(bin, [versionFlag]);
    return true;
  } catch {
    return false;
  }
};

// The directory a SESSION's files live in — a pure function of its sessionId. All
// turns of one session share this one workdir: it holds Claude Code's conversation
// history and the playground file, which are the session's continuable state, not any
// single turn's. Keying it by sessionId is what lets continue re-enter the live
// workdir for EVERY follow-up turn (turn 2, 3, … N), not just the first — and it does
// so without reaching into begin's in-memory state. A per-turn key was a lie about
// what the directory represents: it bent away from the live workdir the moment a
// session was continued more than once. [LAW:one-source-of-truth] [FRAMING:representation]
const dirOf = (handle: SessionHandle): string => join(WORKDIR_ROOT, handle.sessionId);

// Whether a session's workdir is still on disk. Absence is a real, expected state —
// the idle GC may have evicted it, or a restart/reboot may have wiped /tmp — so it is
// a typed answer, not a swallowed error; any OTHER stat failure throws loudly.
// [LAW:no-silent-failure]
const dirExists = async (dir: string): Promise<boolean> => {
  try {
    return (await stat(dir)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

// The one closing instruction every turn's prompt ends with. EVERY generation this driver
// runs — user-triggered or seeded, new/refine/fork — executes headless in a detached tmux
// pane, so the headless contract is universal to the driver, not specific to seeding. The
// playground skill tells the agent to open the finished file in a browser: correct for a
// human's desktop, but in a headless pane that `open` can only fail or (on a provider host
// with a display) pop a spurious window — a seeding wave being the acute case, one per brief.
// The directive suppresses only that wasted action; it never changes what the agent builds.
// Stated here once, for every prompt shape. [LAW:one-source-of-truth] [LAW:effects-at-boundaries]
const PROMPT_CLOSING =
  'Write nothing else to that path. Do NOT open the file in a browser or run the open command — ' +
  'you are running headless; the platform serves the file itself. When the file is written, you are done.';

// The instruction handed to Claude Code. The brief reaches the agent only via this
// file on disk — never interpolated into a shell command — so a brief can say
// anything without becoming an injection. [FRAMING:representation]
const promptFor = (brief: Brief, artifactPath: string): string =>
  [
    'Use the playground skill to build a single self-contained interactive HTML playground for this request:',
    '',
    brief.description,
    '',
    `Write the complete, self-contained HTML file (inline CSS/JS, no external dependencies) to exactly this path: ${artifactPath}`,
    PROMPT_CLOSING,
  ].join('\n');

// The follow-up instruction for a continue turn: refine the file already on disk
// rather than build from nothing. The conversation is resumed via `claude --continue`
// (below); this prompt names the artifact so the agent edits it in place and keeps it
// self-contained. [FRAMING:representation]
const continuePromptFor = (brief: Brief, artifactPath: string): string =>
  [
    'Continue refining the self-contained interactive HTML playground you built earlier. Apply this follow-up request:',
    '',
    brief.description,
    '',
    `The current playground is the file at exactly this path: ${artifactPath}. Update that file in place; keep it self-contained (inline CSS/JS, no external dependencies).`,
    PROMPT_CLOSING,
  ].join('\n');

// The genesis instruction for a FORK: the seed artifact is already written to the
// working file; this prompt hands the agent that file as the starting point of a new,
// independent session. Running Claude (rather than copying the file silently) is what
// establishes a live conversation in the fresh workdir, so a later refine of the fork
// resumes with context exactly as any session's does. [FRAMING:representation]
const forkPromptFor = (artifactPath: string): string =>
  [
    'You are forking an existing self-contained interactive HTML playground to use as the starting point for a new one.',
    `The playground is the file at exactly this path: ${artifactPath}. Keep it as the playground; keep it self-contained (inline CSS/JS, no external dependencies).`,
    PROMPT_CLOSING,
  ].join('\n');

export const makeTmuxDriver = (config: TmuxDriverConfig = {}): CodeGenDriver => {
  const pollIntervalMs = config.pollIntervalMs ?? 750;
  const timeoutMs = config.timeoutMs ?? 5 * 60 * 1000;
  const worlds = new Map<string, TurnWorld>();

  const worldOf = (handle: SessionHandle): TurnWorld => {
    const world = worlds.get(handle.turnId);
    if (world === undefined) throw new Error(`unknown turn: ${handle.turnId}`);
    return world;
  };

  const tmux = (args: readonly string[]): Promise<unknown> => run('tmux', [...args]);

  const isAlive = async (session: string): Promise<boolean> => {
    try {
      await run('tmux', ['has-session', '-t', session]);
      return true;
    } catch {
      return false;
    }
  };

  // Resolve a terminal turn: the exit sentinel exists, so the pane's process is done.
  // Map the exit code + artifact presence onto the snapshot, then tear down the
  // session. Only a clean exit WITH a non-empty file is a success. [LAW:no-silent-failure]
  const settle = async (world: TurnWorld, exitRaw: string): Promise<DriverSnapshot> => {
    await tmux(['kill-session', '-t', world.session]).catch(() => undefined);
    const code = Number.parseInt(exitRaw.trim(), 10);
    if (code !== 0) {
      return { state: 'failed', message: `Claude Code exited with status ${code}` };
    }
    const html = await readOrNull(join(world.dir, ARTIFACT_FILE));
    if (html === null || html.trim() === '') {
      return { state: 'failed', message: 'Claude Code finished but wrote no playground file' };
    }
    return { state: 'succeeded', html };
  };

  return {
    async isAvailable(): Promise<Availability> {
      if (!(await binaryPresent('tmux', '-V'))) {
        return { state: 'unavailable', reason: 'tmux is not installed' };
      }
      if (!(await binaryPresent('claude', '--version'))) {
        return { state: 'unavailable', reason: 'the Claude Code CLI (claude) is not installed' };
      }
      return { state: 'available' };
    },

    async begin(brief: Brief, handle: SessionHandle): Promise<void> {
      const dir = dirOf(handle);
      const session = sessionName(handle);
      await mkdir(dir, { recursive: true });

      const artifactPath = join(dir, ARTIFACT_FILE);
      await writeFile(join(dir, PROMPT_FILE), promptFor(brief, artifactPath), 'utf8');

      // The pane runs Claude Code in print mode, then the SHELL records the exit code.
      // The brief is read from the file, never interpolated into this command line.
      const paneCommand =
        `claude -p "$(cat ${PROMPT_FILE})" --dangerously-skip-permissions; ` +
        `echo $? > ${EXIT_FILE}`;
      await tmux(['new-session', '-d', '-s', session, '-c', dir, paneCommand]);

      worlds.set(handle.turnId, { dir, session, deadline: Date.now() + timeoutMs, reseeded: false });
    },

    // Resume the prior turn and refine its artifact. The follow-up runs in the SAME
    // workdir as priorHandle. Two cases, decided by whether that workdir cache survived:
    //
    //  WARM — the dir is on disk: resume the live Claude Code conversation with
    //  `--continue`, so the full prior context carries forward. The seed is redundant.
    //
    //  COLD — the dir was evicted by the idle GC, or lost to a restart/reboot: the
    //  conversation cache is gone, but the playground's artifact is the store's durable
    //  truth and arrives here as `seed`. Re-seed the working file from it and run FRESH
    //  (no `--continue`) — the agent refines the real current artifact from the file,
    //  forgoing only the prior conversation, never the artifact or the ability to
    //  continue. We deliberately do not depend on Claude Code's own session store
    //  surviving; the durable seed we control is the source of truth. [LAW:one-source-of-truth]
    //
    // The new turn gets its own fresh tmux session and its own world keyed by its
    // turnId, so poll/progress track it independently of the prior turn.
    // [LAW:dataflow-not-control-flow] [LAW:no-silent-failure]
    async continue(
      brief: Brief,
      handle: SessionHandle,
      priorHandle: SessionHandle,
      seed: Artifact,
    ): Promise<void> {
      const dir = dirOf(priorHandle);
      const session = sessionName(handle);
      const warm = await dirExists(dir);

      await mkdir(dir, { recursive: true });
      const artifactPath = join(dir, ARTIFACT_FILE);
      // Cold: the cache is gone, so the working file must be reconstructed from the
      // durable seed before the agent can refine it in place.
      if (!warm) await writeFile(artifactPath, seed.html, 'utf8');

      // The prior turn left its exit sentinel in this dir; the new turn settles on a
      // FRESH sentinel, so the stale one must go first or poll would read it and report
      // the new turn done before it has even run. Harmless on a cold dir. [LAW:no-silent-failure]
      await rm(join(dir, EXIT_FILE), { force: true });
      await writeFile(join(dir, PROMPT_FILE), continuePromptFor(brief, artifactPath), 'utf8');

      // `--continue` only when warm: it resumes the latest Claude Code conversation in
      // this cwd. On a cold re-seed there is no conversation to resume, so the flag is
      // omitted and the agent works from the re-seeded file alone.
      const continueFlag = warm ? '--continue ' : '';
      const paneCommand =
        `claude -p "$(cat ${PROMPT_FILE})" ${continueFlag}--dangerously-skip-permissions; ` +
        `echo $? > ${EXIT_FILE}`;
      await tmux(['new-session', '-d', '-s', session, '-c', dir, paneCommand]);

      worlds.set(handle.turnId, { dir, session, deadline: Date.now() + timeoutMs, reseeded: !warm });
    },

    // Branch a NEW independent session from a seed artifact. `handle` already carries a
    // freshly-minted sessionId (the provider minted it), so dirOf resolves a brand-new
    // workdir — distinct from the parent's by construction, never reached into. This is
    // begin() seeded from the durable artifact: write the seed to the working file, then
    // run Claude FRESH (no `--continue`, there is no prior conversation in this new dir)
    // so a live conversation is established for later refines. The parent session — warm,
    // cold, or evicted — is untouched: the fork is backed by the seed value, not the
    // parent's cache. [LAW:one-source-of-truth] [LAW:dataflow-not-control-flow]
    async fork(handle: SessionHandle, seed: Artifact): Promise<void> {
      const dir = dirOf(handle);
      const session = sessionName(handle);
      await mkdir(dir, { recursive: true });

      const artifactPath = join(dir, ARTIFACT_FILE);
      await writeFile(artifactPath, seed.html, 'utf8');
      await writeFile(join(dir, PROMPT_FILE), forkPromptFor(artifactPath), 'utf8');

      const paneCommand =
        `claude -p "$(cat ${PROMPT_FILE})" --dangerously-skip-permissions; ` +
        `echo $? > ${EXIT_FILE}`;
      await tmux(['new-session', '-d', '-s', session, '-c', dir, paneCommand]);

      worlds.set(handle.turnId, { dir, session, deadline: Date.now() + timeoutMs, reseeded: false });
    },

    async poll(handle: SessionHandle): Promise<DriverSnapshot> {
      const world = worldOf(handle);
      const exitRaw = await readOrNull(join(world.dir, EXIT_FILE));
      if (exitRaw !== null) return settle(world, exitRaw);

      if (Date.now() > world.deadline) {
        await tmux(['kill-session', '-t', world.session]).catch(() => undefined);
        return { state: 'failed', message: `generation timed out after ${timeoutMs}ms` };
      }
      // Still running: pace here so the provider's getResult loop does not spin.
      await delay(pollIntervalMs);
      return { state: 'running' };
    },

    async *progress(handle: SessionHandle): AsyncIterable<ProgressEvent> {
      const world = worldOf(handle);
      // The opening status is ONE event whose message varies with the turn's state: a
      // re-seeded turn refines the durable artifact without its prior conversation, so it
      // says so — surfacing that loss of context rather than hiding it — while every other
      // turn reports the normal start. One unconditional yield, the message carried as a
      // value, never a conditional extra event. [LAW:dataflow-not-control-flow] [LAW:no-silent-failure]
      yield {
        at: Date.now(),
        message: world.reseeded
          ? 'resuming from stored version (prior conversation unavailable)'
          : 'generation started',
      };
      while ((await readOrNull(join(world.dir, EXIT_FILE))) === null && Date.now() <= world.deadline) {
        if (!(await isAlive(world.session))) break;
        const pane = (await run('tmux', ['capture-pane', '-t', world.session, '-p']).catch(
          () => ({ stdout: '' }),
        )) as { stdout: string };
        const lastLine = pane.stdout.split('\n').filter((line) => line.trim() !== '').at(-1);
        if (lastLine !== undefined) yield { at: Date.now(), message: lastLine };
        await delay(pollIntervalMs);
      }
      yield { at: Date.now(), message: 'generation finished' };
    },
  };
};

// Remove one session's temp workdir by handle (the same dir dirOf resolves — one source
// of truth for where it lives, never a second path that can drift). It disposes the whole
// session because the workdir IS the session's, shared by every turn. Removing it is
// always safe: continue re-seeds a missing workdir from the durable store, so this only
// drops the session's cache to cold, never destroys its continuability. The eager,
// by-handle disposer for a failed create (reclaimOnFailure); the idle bulk sweep is
// evictIdleWorkdirs. Separate from the driver because cleanup is the app's call to make,
// not part of generating. [LAW:decomposition] [LAW:one-source-of-truth]
export const cleanupTurn = async (handle: SessionHandle): Promise<void> => {
  await rm(dirOf(handle), { recursive: true, force: true });
};

// ── Idle workdir eviction ───────────────────────────────────────────────────
// A successful session's workdir is a CACHE of its durable artifact, kept warm so a
// follow-up resumes with full conversation context. Nothing disposes it on the happy
// path, so without a sweeper the dirs accumulate one-per-session for the life of the
// process. These reclaim the cold ones. Eviction is always SAFE because continue
// re-seeds a missing workdir from the store (above): an evicted session stays
// continuable, it only loses prior conversation context. The filesystem is the source
// of truth (a dir's mtime is its last turn's activity), so this survives a restart
// that the in-memory turn maps do not. [LAW:one-source-of-truth] [LAW:effects-at-boundaries]

// One scanned workdir: its session id (the dir name) and when it was last touched.
export interface WorkdirEntry {
  readonly name: string;
  readonly mtimeMs: number;
}

// The PURE policy: which workdirs are past the idle deadline. Each turn rewrites its
// dir as it runs (the exit sentinel is removed and recreated), so a fresh mtime means
// recent activity and idleness beyond maxIdleMs means no turn has touched it since.
// maxIdleMs must stay far larger than a single generation's timeout, so an in-flight
// turn — whose dir was just written — is never a candidate. Pure, so the policy is
// verified without touching the clock or disk. [LAW:effects-at-boundaries]
export const expiredWorkdirs = (
  entries: readonly WorkdirEntry[],
  nowMs: number,
  maxIdleMs: number,
): readonly string[] => entries.filter((entry) => nowMs - entry.mtimeMs > maxIdleMs).map((entry) => entry.name);

export interface EvictWorkdirsOptions {
  readonly maxIdleMs: number;
  readonly nowMs: number;
}

// The EFFECT: read the workdir root, decide with the pure policy, remove the expired
// dirs. Returns the session ids it evicted, for logging and verification. A missing
// root means no session has generated yet — a real empty state, not an error to
// swallow; any other read failure throws loudly. [LAW:no-silent-failure]
export const evictIdleWorkdirs = async (opts: EvictWorkdirsOptions): Promise<readonly string[]> => {
  const names = await readdir(WORKDIR_ROOT).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const entries = await Promise.all(
    names.map(
      async (name): Promise<WorkdirEntry> => ({
        name,
        mtimeMs: (await stat(join(WORKDIR_ROOT, name))).mtimeMs,
      }),
    ),
  );
  const expired = expiredWorkdirs(entries, opts.nowMs, opts.maxIdleMs);
  await Promise.all(expired.map((name) => rm(join(WORKDIR_ROOT, name), { recursive: true, force: true })));
  return expired;
};

export interface WorkdirJanitorConfig {
  readonly maxIdleMs?: number;
  readonly sweepIntervalMs?: number;
}

export interface WorkdirJanitor {
  stop(): void;
}

const DEFAULT_MAX_IDLE_MS = 6 * 60 * 60 * 1000; // 6h idle — far beyond any single generation
const DEFAULT_SWEEP_INTERVAL_MS = 30 * 60 * 1000; // sweep every 30 minutes

// The lifecycle OWNER: a background sweeper that evicts idle workdirs on an interval.
// It is the SINGLE explicit owner of eviction timing — start is this call, stop is the
// returned handle — with the clock read only at the effect edge, never an ambient timer
// smeared across the code. The timer is unref'd so it never keeps the process alive on
// its own. Local-only: started by the runtime entry (main.ts), never by makeApp,
// because the workdir cache is the local tmux provider's concern and the agnostic app
// graph must stay free of background effects. [LAW:no-ambient-temporal-coupling]
export const startWorkdirJanitor = (config: WorkdirJanitorConfig = {}): WorkdirJanitor => {
  const maxIdleMs = config.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
  const sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;

  const sweep = (): void => {
    void evictIdleWorkdirs({ maxIdleMs, nowMs: Date.now() })
      .then((evicted) => {
        if (evicted.length > 0) {
          console.log(`tinkerpad: evicted ${evicted.length} idle session workdir(s)`);
        }
      })
      // A sweep fault is surfaced loudly but must not crash the server. [LAW:no-silent-failure]
      .catch((error: unknown) => {
        console.error('tinkerpad: workdir janitor sweep failed:', error);
      });
  };

  sweep(); // clear restart-orphans promptly, then keep sweeping on the interval
  const timer = setInterval(sweep, sweepIntervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};
