import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CodeGenDriver, DriverSnapshot } from './codeGenDriver.js';
import type { Availability, Brief, ProgressEvent, SessionHandle } from './types.js';

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

// Per-turn world state the driver owns: where its files live, what its tmux session
// is called, and when it must give up. [LAW:one-source-of-truth]
interface TurnWorld {
  readonly dir: string;
  readonly session: string;
  readonly deadline: number;
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
    'Write nothing else to that path. When the file is written, you are done.',
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
      const dir = join(tmpdir(), 'tinkerpad-gen', handle.turnId);
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

      worlds.set(handle.turnId, { dir, session, deadline: Date.now() + timeoutMs });
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
      yield { at: Date.now(), message: 'generation started' };
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

// Remove a turn's temp workdir. Separate from the driver because cleanup is the
// app's call to make once it has the artifact, not part of generating. [LAW:decomposition]
export const cleanupTurn = async (handle: SessionHandle): Promise<void> => {
  await rm(join(tmpdir(), 'tinkerpad-gen', handle.turnId), { recursive: true, force: true });
};
