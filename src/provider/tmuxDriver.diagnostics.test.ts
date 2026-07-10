import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorkdirDiagnostics } from './tmuxDriver.js';
import type { SessionHandle } from './types.js';
import { ProviderId, SessionId, TurnId } from './types.js';

// The failure-evidence preserver (ppu.4). The EFFECT (copy a failed turn's workdir into a durable
// diagnostics dir, stamp the reason) is exercised against real dirs so the mkdir/cp/writeFile glue is
// proven without the live agent — the same way the GC's effect is proven with controlled workdirs. The
// driver's pane-tail capture (which needs a live tmux pane) is the live test's job. [LAW:behavior-not-structure]

// The driver keys every session workdir under this root; the preserver resolves the source from it, so
// the test mirrors that one constant exactly as the GC test does. A drift would make the copy find
// nothing and the assertions fail loudly. [LAW:one-source-of-truth]
const ROOT = join(tmpdir(), 'tinkerpad-gen');

const handleFor = (sessionId: string): SessionHandle => ({
  providerId: ProviderId('claude-code-tmux'),
  sessionId: SessionId(sessionId),
  turnId: TurnId(`turn-${randomUUID()}`),
});

describe('makeWorkdirDiagnostics — preserves a failed turn workdir into a durable diagnostics dir', () => {
  const created: string[] = [];

  // A real failed-turn workdir under ROOT: the prompt that drove it, a partial artifact, an exit code,
  // and the pane tail the driver captured on failure — the full self-contained record.
  const seedWorkdir = async (handle: SessionHandle): Promise<string> => {
    const dir = join(ROOT, handle.sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'prompt.txt'), 'build a wave explorer', 'utf8');
    await writeFile(join(dir, 'playground.html'), '<!-- partial -->', 'utf8');
    await writeFile(join(dir, 'exit.code'), '1', 'utf8');
    await writeFile(join(dir, 'pane.tail'), 'Error: the agent crashed here', 'utf8');
    created.push(dir);
    return dir;
  };

  afterEach(async () => {
    await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
    created.length = 0;
  });

  it('copies the whole workdir and stamps the surfaced reason as failure.txt', async () => {
    const handle = handleFor(`session-${randomUUID()}`);
    await seedWorkdir(handle);
    const diagnosticsDir = await mkdtemp(join(tmpdir(), 'tinkerpad-diag-'));
    created.push(diagnosticsDir);

    await makeWorkdirDiagnostics(diagnosticsDir)(handle, 'generation timed out after 600000ms');

    // Exactly one record dir, named for the turn — the operator can correlate it back to the turn id.
    const records = await readdir(diagnosticsDir);
    expect(records).toHaveLength(1);
    const record = join(diagnosticsDir, records[0]!);
    expect(records[0]).toContain(handle.turnId);

    // Every piece of evidence survived the reap: the prompt, the partial artifact, the exit code, and
    // the pane tail — plus the surfaced reason a timeout leaves no other marker of.
    expect(await readFile(join(record, 'prompt.txt'), 'utf8')).toBe('build a wave explorer');
    expect(await readFile(join(record, 'playground.html'), 'utf8')).toBe('<!-- partial -->');
    expect(await readFile(join(record, 'exit.code'), 'utf8')).toBe('1');
    expect(await readFile(join(record, 'pane.tail'), 'utf8')).toBe('Error: the agent crashed here');
    expect(await readFile(join(record, 'failure.txt'), 'utf8')).toBe('generation timed out after 600000ms');
  });

  it('is a no-op — never throwing — when the workdir was already reaped', async () => {
    // A create/fork failure always leaves its workdir, but a restart may have wiped tmpdir first. Absence
    // is a real empty state, not a fault: preserve nothing, write nothing, do not throw. [LAW:no-silent-failure]
    const handle = handleFor(`session-${randomUUID()}`); // no workdir seeded
    const diagnosticsDir = await mkdtemp(join(tmpdir(), 'tinkerpad-diag-'));
    created.push(diagnosticsDir);

    await expect(makeWorkdirDiagnostics(diagnosticsDir)(handle, 'boom')).resolves.toBeUndefined();
    expect(await readdir(diagnosticsDir)).toEqual([]);
  });

  it('never rejects even when the diagnostics destination cannot be written — preservation is best-effort', async () => {
    // A preservation fault must not unmake the failure outcome, the same contract the service's release
    // seam gives its disposer. A destination path that is a FILE (not a directory) makes the copy fail;
    // the preserver logs loudly and resolves. [LAW:no-silent-failure]
    const handle = handleFor(`session-${randomUUID()}`);
    await seedWorkdir(handle);
    const blocker = await mkdtemp(join(tmpdir(), 'tinkerpad-diag-'));
    created.push(blocker);
    const notADir = join(blocker, 'file-where-a-dir-should-be');
    await writeFile(notADir, 'x', 'utf8');

    await expect(makeWorkdirDiagnostics(notADir)(handle, 'boom')).resolves.toBeUndefined();
    // The destination path stayed a plain file — nothing was written under it.
    expect((await stat(notADir)).isFile()).toBe(true);
  });
});
