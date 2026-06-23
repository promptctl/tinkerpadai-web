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
      await driver.continue({ description: 'add a reset button that sets the count to zero' }, followUp, handle);

      let next = await driver.poll(followUp);
      while (next.state === 'running') next = await driver.poll(followUp);

      expect(next.state).toBe('succeeded');
      if (next.state !== 'succeeded') throw new Error(next.state);
      expect(next.html.toLowerCase()).toContain('<html');
      expect(next.html).not.toBe(firstHtml);

      await cleanupTurn(handle);
    },
    8 * 60 * 1000,
  );
});
