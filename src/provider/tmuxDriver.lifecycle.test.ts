import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKDIR_ROOT, cleanupTurn, makeTmuxDriver } from './tmuxDriver.js';
import type { ProgressEvent, SessionHandle } from './types.js';
import { ProviderId, SessionId, TurnId } from './types.js';

// The turn LIFECYCLE the driver owns (ppu.5). The driver's tmux-driving orchestration is only provable
// live (that is the live test's job), but its WORLD LIFECYCLE — where a turn's deadline/reseeded state
// lives and when it is disposed — became deterministically testable the moment that state moved out of an
// in-memory map and into the workdir. These tests stage a workdir directly (the same way the diagnostics
// test does) and drive poll/progress against it, with no live agent, to pin the two defects this ticket
// closed: (1) the world is reconstructed from disk, so no in-memory map grows unbounded or is even
// required; (2) a turn whose workdir was reaped fails LOUDLY on re-poll instead of drifting to a spurious
// timeout. tmux calls on the (nonexistent) sessions are best-effort in the driver, so these never need a
// real tmux. [LAW:verifiable-goals] [LAW:behavior-not-structure]

const handleFor = (sessionId: string): SessionHandle => ({
  providerId: ProviderId('claude-code-tmux'),
  sessionId: SessionId(sessionId),
  turnId: TurnId(`turn-${randomUUID()}`),
});

describe('tmux driver — a turn world is the workdir, reconstructed from disk', () => {
  const staged: string[] = [];

  // Stage a turn's on-disk world by hand: its TURN_FILE (deadline/reseeded) plus whatever sentinel and
  // artifact the case needs. No begin() ran, so nothing is held in memory — proving whatever poll returns
  // it read entirely off disk. The workdir is keyed by sessionId under the same exported root the driver
  // resolves, so there is no mirrored literal to drift from. [LAW:one-source-of-truth]
  const stageWorld = async (
    handle: SessionHandle,
    files: { turn?: { deadline: number; reseeded: boolean }; exit?: string; html?: string },
  ): Promise<void> => {
    const dir = join(WORKDIR_ROOT, handle.sessionId);
    await mkdir(dir, { recursive: true });
    if (files.turn !== undefined) await writeFile(join(dir, 'turn.json'), JSON.stringify(files.turn), 'utf8');
    if (files.exit !== undefined) await writeFile(join(dir, 'exit.code'), files.exit, 'utf8');
    if (files.html !== undefined) await writeFile(join(dir, 'playground.html'), files.html, 'utf8');
    staged.push(dir);
  };

  afterEach(async () => {
    await Promise.all(staged.map((dir) => rm(dir, { recursive: true, force: true })));
    staged.length = 0;
  });

  it('settles a turn a FRESH driver instance never began — the world is read from the workdir, not memory', async () => {
    // The proof there is no in-memory map that is the source of truth: this driver never ran begin/continue/
    // fork for this handle, yet poll settles it purely from the staged workdir. [LAW:one-source-of-truth]
    const driver = makeTmuxDriver({ pollIntervalMs: 1, timeoutMs: 60_000 });
    const handle = handleFor(`session-${randomUUID()}`);
    await stageWorld(handle, { turn: { deadline: Date.now() + 60_000, reseeded: false }, exit: '0', html: '<html>ok</html>' });

    const snapshot = await driver.poll(handle);
    expect(snapshot.state).toBe('succeeded');
    if (snapshot.state !== 'succeeded') throw new Error(snapshot.state);
    expect(snapshot.html).toBe('<html>ok</html>');
  });

  it('re-polling a turn whose workdir was reaped fails LOUDLY, never drifts to a spurious timeout', async () => {
    // The ticket's latent bug: the in-memory map outlived the reaped workdir, so a re-poll read no exit
    // sentinel and reported 'running' until the deadline, then a spurious timeout. With the world living
    // in the workdir, cleanupTurn disposes it in the one place it exists, and worldOf finds nothing —
    // a loud, honest failure. [LAW:no-silent-failure] [LAW:one-source-of-truth]
    const driver = makeTmuxDriver({ pollIntervalMs: 1, timeoutMs: 60_000 });
    const handle = handleFor(`session-${randomUUID()}`);
    await stageWorld(handle, { turn: { deadline: Date.now() + 60_000, reseeded: false }, exit: '0', html: '<html>ok</html>' });

    expect((await driver.poll(handle)).state).toBe('succeeded');

    // Reap the workdir exactly as the failed-turn disposer / idle GC does, then re-poll.
    await cleanupTurn(handle);
    expect(await readdir(WORKDIR_ROOT)).not.toContain(handle.sessionId);
    await expect(driver.poll(handle)).rejects.toThrow(/unknown turn/);
  });

  it('a corrupt (wrong-shape) turn state fails LOUDLY, never drifts into running-forever', async () => {
    // turn.json round-trips through the filesystem; a torn write could parse to the wrong shape. An object
    // with no deadline would make the timeout check `Date.now() > undefined` always false and hang the turn
    // in 'running' with no error — the same silent failure absence already guards against. Poll must reject.
    // [LAW:no-silent-failure]
    const driver = makeTmuxDriver({ pollIntervalMs: 1, timeoutMs: 60_000 });
    const handle = handleFor(`session-${randomUUID()}`);
    const dir = join(WORKDIR_ROOT, handle.sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'turn.json'), JSON.stringify({ reseeded: false }), 'utf8'); // deadline missing
    staged.push(dir);

    await expect(driver.poll(handle)).rejects.toThrow(/corrupt turn state/);
  });

  it('the timeout deadline is read from the workdir, not an in-memory clock capture', async () => {
    // A staged deadline already in the past, no exit sentinel: poll must map that on-disk deadline to a
    // loud timeout failure — proving the deadline the driver enforces is the one persisted at launch.
    const driver = makeTmuxDriver({ pollIntervalMs: 1, timeoutMs: 60_000 });
    const handle = handleFor(`session-${randomUUID()}`);
    await stageWorld(handle, { turn: { deadline: Date.now() - 1, reseeded: false } });

    const snapshot = await driver.poll(handle);
    expect(snapshot.state).toBe('failed');
    if (snapshot.state !== 'failed') throw new Error(snapshot.state);
    expect(snapshot.message).toMatch(/timed out/);
  });

  it("progress reports a re-seed from the workdir's persisted reseeded flag", async () => {
    // reseeded is the one behavioural fact progress varies its opening message on; it now rides in TURN_FILE.
    // A past deadline makes the poll loop exit immediately with no live tmux, so only the disk-driven
    // opening/closing events are emitted — the deterministic proof reseeded flows from disk. [LAW:dataflow-not-control-flow]
    const driver = makeTmuxDriver({ pollIntervalMs: 1, timeoutMs: 60_000 });
    const handle = handleFor(`session-${randomUUID()}`);
    await stageWorld(handle, { turn: { deadline: Date.now() - 1, reseeded: true } });

    const events: ProgressEvent[] = [];
    for await (const event of driver.progress(handle)) events.push(event);

    expect(events[0]?.message).toBe('resuming from stored version (prior conversation unavailable)');
    expect(events.at(-1)?.message).toBe('generation finished');
  });
});
