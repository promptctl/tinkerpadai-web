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

      await cleanupTurn(handle);
    },
    5 * 60 * 1000,
  );
});
