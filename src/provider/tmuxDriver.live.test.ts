import { describe, expect, it } from 'vitest';
import { ProviderId, SessionId, TurnId } from './types.js';
import { cleanupTurn, makeTmuxDriver } from './tmuxDriver.js';

// A LIVE end-to-end smoke of the real tmux driver: it spawns Claude Code over tmux
// and waits for a real generation. It is gated behind TINKERPAD_LIVE=1 because it
// needs tmux + the claude CLI + network + tokens, and takes minutes — so it never
// runs in the normal suite or CI. It exists to make the disposable body verifiable
// at all, on demand: `TINKERPAD_LIVE=1 npx vitest run tmuxDriver.live`.
// [LAW:verifiable-goals]

const live = process.env.TINKERPAD_LIVE === '1';

describe.runIf(live)('tmux driver (live)', () => {
  it(
    'drives Claude Code to produce a non-empty self-contained playground',
    async () => {
      const driver = makeTmuxDriver({ pollIntervalMs: 1000, timeoutMs: 4 * 60 * 1000 });
      expect((await driver.isAvailable()).state).toBe('available');

      const handle = {
        providerId: ProviderId('tmux-live'),
        sessionId: SessionId(`session-${Date.now()}`),
        turnId: TurnId(`turn-${Date.now()}`),
      };
      await driver.begin({ description: 'a tiny counter with a + and - button' }, handle);

      let snapshot = await driver.poll(handle);
      while (snapshot.state === 'running') snapshot = await driver.poll(handle);

      expect(snapshot.state).toBe('succeeded');
      if (snapshot.state !== 'succeeded') throw new Error(snapshot.state);
      expect(snapshot.html.length).toBeGreaterThan(0);
      expect(snapshot.html.toLowerCase()).toContain('<html');
      const firstHtml = snapshot.html;

      // Continue the same session with a follow-up and confirm a fresh artifact comes
      // back — the live proof that "send a follow-up into the live session" works.
      const followUp = {
        providerId: handle.providerId,
        sessionId: handle.sessionId,
        turnId: TurnId(`turn-${Date.now()}-2`),
      };
      await driver.continue(
        { description: 'add a reset button that sets the count to zero' },
        followUp,
        handle,
        { html: firstHtml },
      );

      let next = await driver.poll(followUp);
      while (next.state === 'running') next = await driver.poll(followUp);

      expect(next.state).toBe('succeeded');
      if (next.state !== 'succeeded') throw new Error(next.state);
      expect(next.html.toLowerCase()).toContain('<html');
      expect(next.html).not.toBe(firstHtml);
      const secondHtml = next.html;

      // A THIRD turn — continuing an ALREADY-continued session. This is the case that
      // regressed: a workdir keyed by turnId resolved the prior (turn-2) handle to a
      // never-created directory, so this continue died in writeFile(prompt) with ENOENT.
      // Keyed by sessionId every turn re-enters the one live workdir, so turn 3 (and N)
      // resume cleanly. priorHandle is turn 2, exactly as the service reconstructs it
      // from the catalog's newest turn. [LAW:one-source-of-truth]
      const thirdTurn = {
        providerId: handle.providerId,
        sessionId: handle.sessionId,
        turnId: TurnId(`turn-${Date.now()}-3`),
      };
      await driver.continue(
        { description: 'make the count text larger and bold' },
        thirdTurn,
        followUp,
        { html: secondHtml },
      );

      let third = await driver.poll(thirdTurn);
      while (third.state === 'running') third = await driver.poll(thirdTurn);

      expect(third.state).toBe('succeeded');
      if (third.state !== 'succeeded') throw new Error(third.state);
      expect(third.html.toLowerCase()).toContain('<html');
      expect(third.html).not.toBe(secondHtml);
      const thirdHtml = third.html;

      // COLD-PATH RE-SEED — the eviction case. Evict the session's workdir (exactly what
      // the idle GC does), then continue anyway. With the cache gone, the driver must
      // re-seed the working file from the durable artifact handed in as `seed` and run
      // fresh, so the playground stays refinable across eviction — the live proof that
      // eviction never costs continuability, only conversation context. [LAW:one-source-of-truth]
      await cleanupTurn(thirdTurn);

      const afterEvict = {
        providerId: handle.providerId,
        sessionId: handle.sessionId,
        turnId: TurnId(`turn-${Date.now()}-4`),
      };
      await driver.continue(
        { description: 'add a label that reads "Counter" above the number' },
        afterEvict,
        thirdTurn,
        { html: thirdHtml },
      );

      let fourth = await driver.poll(afterEvict);
      while (fourth.state === 'running') fourth = await driver.poll(afterEvict);

      expect(fourth.state).toBe('succeeded');
      if (fourth.state !== 'succeeded') throw new Error(fourth.state);
      expect(fourth.html.toLowerCase()).toContain('<html');

      // REMIX FORK — branch a brand-new independent session from a prior artifact. The
      // fork handle carries a FRESH sessionId (the provider mints it), so the driver
      // resolves a NEW workdir distinct from the parent's, seeds it from the artifact
      // handed in as `seed`, and runs fresh — establishing an independent, refinable
      // playground that stands on the durable seed alone, never the parent's workdir.
      // The live proof of the new-session-from-seed path the scripted driver can't reach
      // (it has no workdir). [LAW:one-source-of-truth]
      const forkHandle = {
        providerId: handle.providerId,
        sessionId: SessionId(`session-${Date.now()}-fork`),
        turnId: TurnId(`turn-${Date.now()}-fork`),
      };
      await driver.fork(forkHandle, { html: firstHtml });

      let forked = await driver.poll(forkHandle);
      while (forked.state === 'running') forked = await driver.poll(forkHandle);

      expect(forked.state).toBe('succeeded');
      if (forked.state !== 'succeeded') throw new Error(forked.state);
      expect(forked.html.toLowerCase()).toContain('<html');

      // The fork is a SEPARATE session: continuing it must not disturb the parent's still-
      // live workdir. Refine the fork once to confirm it is independently continuable.
      const forkRefine = {
        providerId: handle.providerId,
        sessionId: forkHandle.sessionId,
        turnId: TurnId(`turn-${Date.now()}-fork-2`),
      };
      await driver.continue(
        { description: 'change the buttons to say "up" and "down"' },
        forkRefine,
        forkHandle,
        { html: forked.html },
      );

      let forkedNext = await driver.poll(forkRefine);
      while (forkedNext.state === 'running') forkedNext = await driver.poll(forkRefine);

      expect(forkedNext.state).toBe('succeeded');
      if (forkedNext.state !== 'succeeded') throw new Error(forkedNext.state);
      expect(forkedNext.html.toLowerCase()).toContain('<html');

      await cleanupTurn(forkHandle);
      await cleanupTurn(handle);
    },
    12 * 60 * 1000,
  );
});
