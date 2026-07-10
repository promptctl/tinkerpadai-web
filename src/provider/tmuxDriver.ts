import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { evictExpiredDirs } from './dirRetention.js';
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
  // driver OWNS pacing so the provider's await-loop never spins. Internal pacing with a sane
  // default — not a policy the deploy must state. [LAW:no-ambient-temporal-coupling]
  readonly pollIntervalMs?: number;
  // Hard deadline for a single generation; past it the turn fails loudly rather than hanging
  // forever. REQUIRED, not defaulted: the deadline is a deliberate deploy POLICY (a real brief
  // brushes right up against it), so the composition root must state it — a driver that silently
  // inherited a fallback is exactly how production ran on 5 minutes while briefs needed 10+
  // (quality-ppu.2). Making it required makes "no deadline chosen" unrepresentable.
  // [LAW:types-are-the-program] [LAW:no-silent-failure]
  readonly timeoutMs: number;
}

const ARTIFACT_FILE = 'playground.html';
const PROMPT_FILE = 'prompt.txt';
const EXIT_FILE = 'exit.code';
// The pane's recent output, captured into the workdir the instant a turn fails — the only moment the
// tmux pane still exists. It makes the workdir a self-contained diagnostic record: prompt + any partial
// artifact + exit code + what the agent was doing when it died, all in one place for the failure
// disposer to preserve (ppu.4). [LAW:one-source-of-truth]
const PANE_TAIL_FILE = 'pane.tail';
// The surfaced failure reason, written beside a preserved workdir so the on-disk record states WHY the
// turn failed — a timeout leaves no other marker, and a functional defect's load errors live only here.
const FAILURE_FILE = 'failure.txt';
// The turn's world on disk: the two launch-time facts that are NOT pure functions of the handle — its
// deadline and whether a cold continue re-seeded it. Written at launch, reaped WITH the workdir by
// cleanupTurn, so a turn's whole world lives in exactly one place and is disposed atomically. This is
// what replaced the in-memory map that used to shadow it: a map keyed by turnId outlived the workdir it
// described, growing unbounded and drifting into a spurious 'running' when a reaped turn was re-polled
// (ppu.5). [LAW:one-source-of-truth]
const TURN_FILE = 'turn.json';
// How much scrollback to preserve — enough to see the trailing activity of a stalled or crashed turn,
// bounded so a runaway pane cannot write an unbounded file.
const PANE_TAIL_LINES = 200;

// The single root every session workdir lives under — named once so dirOf (which
// resolves one session's dir) and the idle GC (which scans them all) cannot drift on
// where the workdirs are. Exported so tests that stage real workdirs reference this one
// constant rather than re-declaring the literal. [LAW:one-source-of-truth]
export const WORKDIR_ROOT = join(tmpdir(), 'tinkerpad-gen');

// The driver's in-memory VIEW of a turn's world, RECONSTRUCTED on demand from the handle
// and the workdir — never held in a long-lived map. dir and session are pure functions of
// the handle; deadline and reseeded are read from the turn's on-disk state (TURN_FILE).
// Reconstructing per call is what makes the workdir the single source of truth: there is no
// second in-memory copy to grow unbounded or to outlive the files cleanupTurn reaps.
// [LAW:one-source-of-truth] [LAW:no-shared-mutable-globals]
interface TurnWorld {
  readonly dir: string;
  readonly session: string;
  readonly deadline: number;
  readonly reseeded: boolean;
}

// The persisted half of a turn's world — exactly the two facts not derivable from the handle.
// The whole of what the workdir must carry to be the turn's single source of truth.
interface TurnState {
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

// Record a turn's world into its workdir at launch. Written wholesale each turn (begin/continue/fork),
// so a continue that re-enters a warm workdir simply overwrites the prior turn's state — no stale marker
// to clear, unlike the shell-written exit sentinel. This is the write half of the single source of truth
// for a turn's lifecycle. [LAW:one-source-of-truth]
const writeTurnState = (dir: string, state: TurnState): Promise<void> =>
  writeFile(join(dir, TURN_FILE), JSON.stringify(state), 'utf8');

// Assert a parsed value has the turn-state shape. turn.json round-trips through the filesystem, which a
// crash or torn write can corrupt; a corrupt read that happened to parse to the wrong shape (an object
// with an undefined deadline) would make `Date.now() > deadline` always false and drift the turn into the
// exact silent 'running-forever' this design exists to prevent. So the shape is checked at the read
// boundary and a violation throws, never trusted through a bare cast. (Malformed JSON already throws from
// JSON.parse; this covers the valid-JSON-wrong-shape half.) [LAW:no-silent-failure] [LAW:types-are-the-program]
const isTurnState = (value: unknown): value is TurnState =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as TurnState).deadline === 'number' &&
  typeof (value as TurnState).reseeded === 'boolean';

// Reconstruct a turn's world from disk. dir and session are pure functions of the handle; deadline and
// reseeded are read from the turn's on-disk state. A missing state file means the turn never ran here or
// its workdir was already reaped (by cleanupTurn or the idle GC); a present-but-corrupt one means a torn
// write. Both are loud, honest failures, NOT a silent 'running' that drifts to a spurious timeout the way
// an in-memory map outliving its workdir did (ppu.5). [LAW:one-source-of-truth] [LAW:no-silent-failure]
const worldOf = async (handle: SessionHandle): Promise<TurnWorld> => {
  const dir = dirOf(handle);
  const raw = await readOrNull(join(dir, TURN_FILE));
  if (raw === null) throw new Error(`unknown turn: ${handle.turnId}`);
  const parsed: unknown = JSON.parse(raw);
  if (!isTurnState(parsed)) throw new Error(`corrupt turn state for ${handle.turnId}: ${raw}`);
  return { dir, session: sessionName(handle), deadline: parsed.deadline, reseeded: parsed.reseeded };
};

// The one closing instruction every turn's prompt ends with. EVERY generation this driver
// runs — user-triggered or seeded, new/refine/fork — executes headless in a detached tmux
// pane, so the headless contract is universal to the driver, not specific to seeding. The
// playground skill tells the agent to open the finished file in a browser: correct for a
// human's desktop, but in a headless pane that `open` can only fail or (on a provider host
// with a display) pop a spurious window — a seeding wave being the acute case, one per brief.
// The directive suppresses only that wasted action; it never changes what the agent builds.
// Stated here once, for every prompt shape. [LAW:one-source-of-truth] [LAW:effects-at-boundaries]
const HEADLESS_CLOSING_DIRECTIVE =
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
    HEADLESS_CLOSING_DIRECTIVE,
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
    HEADLESS_CLOSING_DIRECTIVE,
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
    HEADLESS_CLOSING_DIRECTIVE,
  ].join('\n');

export const makeTmuxDriver = (config: TmuxDriverConfig): CodeGenDriver => {
  const pollIntervalMs = config.pollIntervalMs ?? 750;
  const timeoutMs = config.timeoutMs;

  const tmux = (args: readonly string[]): Promise<unknown> => run('tmux', [...args]);

  const isAlive = async (session: string): Promise<boolean> => {
    try {
      await run('tmux', ['has-session', '-t', session]);
      return true;
    } catch {
      return false;
    }
  };

  // Tear down a turn's tmux session. Best-effort — a turn may already have exited on its own.
  const killSession = (world: TurnWorld): Promise<unknown> =>
    tmux(['kill-session', '-t', world.session]).catch(() => undefined);

  // The tail of the pane's output — the last thing the agent did before the session ends. Only
  // readable while the session is still alive, so it is always captured BEFORE killSession. A capture
  // fault returns '' so the record is still written, but is surfaced loudly: an empty pane.tail must be
  // distinguishable from a crashed capture. This is a single diagnostic moment, not the hot progress
  // loop (which silences transient misses on purpose). [LAW:no-silent-failure] [LAW:no-ambient-temporal-coupling]
  const capturePaneTail = async (world: TurnWorld): Promise<string> => {
    try {
      const pane = (await run('tmux', ['capture-pane', '-p', '-S', `-${PANE_TAIL_LINES}`, '-t', world.session])) as {
        stdout: string;
      };
      return pane.stdout;
    } catch (error) {
      console.error(`tinkerpad: failed to capture pane for ${world.session}:`, error);
      return '';
    }
  };

  // Tear down a session, capturing its pane tail into the workdir first — the ONE place the driver ends
  // a session, so the pane is preserved on EVERY teardown, not only driver-level failures. This is what
  // gives a built-but-broken artifact (a driver success the service later rejects — FunctionalDefectError
  // / SelfContainmentError, the wave-1 class) its pane context in the preserved record (ppu.4), since the
  // session is already dead by the time the service rejects. Capture is unconditional, not a branch on
  // outcome; a capture/write fault is surfaced loudly but never converts an outcome into a crash — the
  // diagnostic is auxiliary. [LAW:dataflow-not-control-flow] [LAW:no-silent-failure]
  const captureAndKill = async (world: TurnWorld): Promise<void> => {
    try {
      await writeFile(join(world.dir, PANE_TAIL_FILE), await capturePaneTail(world), 'utf8');
    } catch (error) {
      console.error(`tinkerpad: failed to write pane tail for ${world.session}:`, error);
    }
    await killSession(world);
  };

  // Resolve a turn to a loud failure, tearing the session down (which preserves its pane tail into the
  // workdir) first, so the whole workdir is a self-contained diagnostic record the failure disposer
  // preserves before it reaps the workdir (ppu.4). [LAW:no-silent-failure]
  const failWith = async (world: TurnWorld, message: string): Promise<DriverSnapshot> => {
    await captureAndKill(world);
    return { state: 'failed', message };
  };

  // Resolve a terminal turn: the exit sentinel exists, so the pane's process is done.
  // Map the exit code + artifact presence onto the snapshot. Every teardown goes through captureAndKill,
  // so the pane tail is preserved whether the turn failed here or succeeded (and is later rejected
  // downstream); only a clean exit WITH a non-empty file is a success. [LAW:no-silent-failure]
  const settle = async (world: TurnWorld, exitRaw: string): Promise<DriverSnapshot> => {
    const code = Number.parseInt(exitRaw.trim(), 10);
    if (code !== 0) return failWith(world, `Claude Code exited with status ${code}`);
    // Read the artifact BEFORE killing the session: an empty-file result is a failure, and failWith must
    // still find a live pane to capture. A non-ENOENT read fault (EACCES/EIO) is a real infra fault that
    // propagates loudly — but the session must be torn down first, never leaked, since the fault escapes
    // before the success-path kill below. [LAW:no-silent-failure] [LAW:no-ambient-temporal-coupling]
    let html: string | null;
    try {
      html = await readOrNull(join(world.dir, ARTIFACT_FILE));
    } catch (error) {
      await captureAndKill(world);
      throw error;
    }
    if (html === null || html.trim() === '') {
      return failWith(world, 'Claude Code finished but wrote no playground file');
    }
    // Success still tears down through captureAndKill: a self-contained file can still be built-but-
    // broken, and the service's functional/self-containment gate rejects it AFTER the session is gone —
    // so its preserved record needs the pane captured here, the last moment it exists (ppu.4).
    await captureAndKill(world);
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
      // Persist the turn's world BEFORE spawning the session: the tmux session is the un-cleanable
      // resource, so every fallible step precedes it. A write failure here leaves no orphaned pane —
      // only a workdir the idle GC reaps — never a live agent with no cleanup path.
      // [LAW:no-ambient-temporal-coupling]
      await writeTurnState(dir, { deadline: Date.now() + timeoutMs, reseeded: false });
      await tmux(['new-session', '-d', '-s', session, '-c', dir, paneCommand]);
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
      // Written to `dir` = dirOf(priorHandle); since a continue is pinned to the SAME session, that is
      // dirOf(handle) too, so poll(handle) reconstructs this exact state. Written BEFORE the session spawns,
      // so a state-write failure never orphans a live pane. [LAW:one-source-of-truth] [LAW:no-ambient-temporal-coupling]
      await writeTurnState(dir, { deadline: Date.now() + timeoutMs, reseeded: !warm });
      await tmux(['new-session', '-d', '-s', session, '-c', dir, paneCommand]);
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
      // Persist the turn's world before spawning, so a state-write failure never orphans a live pane —
      // the session is the last, un-cleanable effect. [LAW:no-ambient-temporal-coupling]
      await writeTurnState(dir, { deadline: Date.now() + timeoutMs, reseeded: false });
      await tmux(['new-session', '-d', '-s', session, '-c', dir, paneCommand]);
    },

    async poll(handle: SessionHandle): Promise<DriverSnapshot> {
      const world = await worldOf(handle);
      const exitRaw = await readOrNull(join(world.dir, EXIT_FILE));
      if (exitRaw !== null) return settle(world, exitRaw);

      if (Date.now() > world.deadline) {
        return failWith(world, `generation timed out after ${timeoutMs}ms`);
      }
      // Still running: pace here so the provider's getResult loop does not spin.
      await delay(pollIntervalMs);
      return { state: 'running' };
    },

    async *progress(handle: SessionHandle): AsyncIterable<ProgressEvent> {
      const world = await worldOf(handle);
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
// session because the workdir IS the session's, shared by every turn — including each turn's
// on-disk world state (TURN_FILE), so removing the workdir disposes the turn's world in the
// one place it lives. That is why there is no separate in-memory map to reach and no drift to
// reconcile: after this runs, worldOf(handle) finds no state and fails loudly rather than
// misreporting a reaped turn as running (ppu.5). Removing it is always safe: continue re-seeds
// a missing workdir from the durable store, so this only drops the session's cache to cold,
// never destroys its continuability. The eager, by-handle disposer for a failed create
// (reclaimOnFailure); the idle bulk sweep is evictIdleWorkdirs. Separate from the driver
// because cleanup is the app's call to make, not part of generating.
// [LAW:decomposition] [LAW:one-source-of-truth]
export const cleanupTurn = async (handle: SessionHandle): Promise<void> => {
  await rm(dirOf(handle), { recursive: true, force: true });
};

// A collision-free, filesystem-safe name for one failed turn's diagnostics — its session and turn
// ids (both randomUUID-based, so globally unique) reduced to a safe token, the same reduction tmux
// session names use. sessionId alone is unique among reclaimed create/fork failures (each attempt mints
// a fresh session), and turnId disambiguates any future sharing. [LAW:one-source-of-truth]
const diagnosticName = (handle: SessionHandle): string =>
  `${handle.sessionId}-${handle.turnId}`.replace(/[^A-Za-z0-9_-]/g, '_');

// Preserve a FAILED turn's evidence before its workdir is reclaimed. The workdir is the turn's
// self-contained diagnostic record — the prompt that drove it (prompt.txt), any partial or built-but-
// broken artifact (playground.html), the shell exit code (exit.code), and the pane tail the driver
// captured on failure (pane.tail). cleanupTurn would rm all of it (and the idle GC lives in tmpdir,
// wiped on reboot), so this COPIES the workdir into a DURABLE diagnostics directory under the app's
// data dir, alongside the surfaced failure reason (failure.txt), so a timeout or failure can be
// diagnosed or retried intelligently after the fact instead of being reaped (ppu.4). It only preserves;
// the caller composes it before cleanupTurn, so the workdir is still reclaimed. Best-effort: a
// preservation fault is surfaced loudly but never rejects — it must not unmake the failure outcome, the
// same contract the service's release seam gives its disposer. [LAW:no-silent-failure] [LAW:decomposition]
export const makeWorkdirDiagnostics =
  (diagnosticsDir: string) =>
  async (handle: SessionHandle, reason: string): Promise<void> => {
    const src = dirOf(handle);
    try {
      // A create/fork failure always leaves its workdir; absence means it was already reaped (or a
      // restart wiped tmpdir) — a real empty state, not a fault to preserve nothing from.
      if (!(await dirExists(src))) return;
      const dest = join(diagnosticsDir, diagnosticName(handle));
      await mkdir(dest, { recursive: true });
      // Write the reason FIRST, then copy the workdir: failure.txt is the smallest and only
      // non-reconstructable piece (a timeout leaves no other marker of why it failed), so it is the one
      // most worth surviving a mid-write disk-full — the bulky cp comes last. cp merges into dest
      // without disturbing failure.txt (it is not in src). [LAW:no-silent-failure]
      await writeFile(join(dest, FAILURE_FILE), reason, 'utf8');
      await cp(src, dest, { recursive: true });
    } catch (error) {
      console.error(`tinkerpad: failed to preserve diagnostics for turn ${handle.turnId}:`, error);
    }
  };

// Where a deployment's durable failure diagnostics live: a fixed subdir of its data dir. The single home
// of that path, so the WRITER (makeWorkdirDiagnostics, above, which the composition root builds over it)
// and the retention sweeper (below) derive it from one rule and can never target different dirs.
// [LAW:one-source-of-truth]
export const diagnosticsDirOf = (dataDir: string): string => join(dataDir, 'diagnostics');

export interface DiagnosticsRetentionSweeperConfig {
  readonly retentionMs?: number;
  readonly sweepIntervalMs?: number;
  // The clock read at the sweep edge to compute the age cutoff. Injected for deterministic tests; the
  // runtime default is the real wall clock. [LAW:effects-at-boundaries]
  readonly now?: () => number;
}

export interface DiagnosticsRetentionSweeper {
  stop(): void;
}

// Seven days: long enough to diagnose a week of failures after the fact, bounded so the dir cannot grow
// for the life of the deployment. A diagnostics record is the ONLY copy of a failure's evidence (unlike
// the re-seedable workdir cache), so its window is far longer than the caches'.
const DEFAULT_DIAGNOSTICS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Sweep every six hours: records accrue at most one-per-failure and the window is days, so a frequent
// sweep would cost more than it saves.
const DEFAULT_DIAGNOSTICS_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

// The retention lifecycle OWNER for the durable diagnostics dir (ppu.4 writes it; nothing reaped it) —
// the durable-storage sibling of the in-memory turn sweeper and the tmpdir workdir janitor. A background
// sweeper reclaims records whose on-disk age exceeds retentionMs, and it is the SINGLE explicit owner of
// that timing: start is this call, stop the returned handle, the clock read only at the sweep edge (now()
// is the nowMs handed to the shared mechanism), never an ambient timer smeared across the code. The timer
// is unref'd so it never keeps the process alive on its own. Started by the runtime entry, never by
// makeApp/makeNodeApp, because a background timer is a runtime effect the graph builder must not own.
// Like the workdir janitor — and UNLIKE the in-memory turn sweeper — the dir is DURABLE, so an eager first
// sweep on boot clears records orphaned across a restart. [LAW:no-ambient-temporal-coupling]
// [LAW:effects-at-boundaries]
export const startDiagnosticsRetentionSweeper = (
  diagnosticsDir: string,
  config: DiagnosticsRetentionSweeperConfig = {},
): DiagnosticsRetentionSweeper => {
  const retentionMs = config.retentionMs ?? DEFAULT_DIAGNOSTICS_RETENTION_MS;
  const sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_DIAGNOSTICS_SWEEP_INTERVAL_MS;
  const now = config.now ?? Date.now;

  const sweep = (): void => {
    void evictExpiredDirs({ root: diagnosticsDir, maxAgeMs: retentionMs, nowMs: now() })
      .then((evicted) => {
        if (evicted.length > 0) {
          console.log(`tinkerpad: reclaimed ${evicted.length} expired diagnostics record(s)`);
        }
      })
      // A sweep fault is surfaced loudly but must not crash the server. [LAW:no-silent-failure]
      .catch((error: unknown) => {
        console.error('tinkerpad: diagnostics retention sweep failed:', error);
      });
  };

  sweep(); // clear restart-orphans promptly, then keep sweeping on the interval
  const timer = setInterval(sweep, sweepIntervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
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

export interface EvictWorkdirsOptions {
  readonly maxIdleMs: number;
  readonly nowMs: number;
}

// The workdir cache's binding of the shared age mechanism (evictExpiredDirs): it fixes the root to
// WORKDIR_ROOT — the cache's single home — and reads the age as an IDLE horizon, because each turn
// rewrites its dir (the exit sentinel is removed and recreated) so a dir's mtime is its last activity.
// maxIdleMs must stay far larger than a single generation's timeout, so an in-flight turn — whose dir was
// just written — is never a candidate. The scan/decide/remove mechanism lives once in evictExpiredDirs;
// this is the workdir OWNER's use of it. [LAW:one-type-per-behavior]
export const evictIdleWorkdirs = (opts: EvictWorkdirsOptions): Promise<readonly string[]> =>
  evictExpiredDirs({ root: WORKDIR_ROOT, maxAgeMs: opts.maxIdleMs, nowMs: opts.nowMs });

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
