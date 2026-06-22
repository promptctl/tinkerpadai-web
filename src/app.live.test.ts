import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeApp } from './app.js';
import type { GenerationStatus } from './api/index.js';

// A LIVE end-to-end smoke of the WHOLE composition: makeApp wires the real tmux/Claude
// Code provider to the file store and catalog, and we drive a real generation through
// submit -> poll -> a stored, catalogued, runnable playground. Gated behind
// TINKERPAD_LIVE=1 because it needs tmux + the claude CLI + network + tokens and takes
// minutes, so it never runs in the normal suite or CI:
// `TINKERPAD_LIVE=1 npx vitest run app.live`. This is the steel thread proving the four
// seams (provider, store, catalog, registry) compose for real. [LAW:verifiable-goals]

const live = process.env.TINKERPAD_LIVE === '1';

describe.runIf(live)('generation API (live, real tmux provider)', () => {
  it(
    'submits a brief and polls it through to a stored, catalogued, runnable playground',
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'tinkerpad-app-live-'));
      const { service, registry, store, catalog } = makeApp({
        dataDir,
        driver: { pollIntervalMs: 1000 },
      });

      const [provider] = service.listProviders();
      if (provider === undefined) throw new Error('no provider registered');
      expect((await registry.availabilityOf(provider.id)).state).toBe('available');

      const handle = await service.submit({
        providerId: provider.id,
        brief: { description: 'a tiny counter with a + and - button' },
      });

      let status: GenerationStatus = await service.poll(handle);
      while (status.state === 'pending' || status.state === 'running') {
        status = await service.poll(handle);
      }

      expect(status.state).toBe('ready');
      if (status.state !== 'ready') throw new Error(status.state);

      const summaries = await catalog.listPlaygrounds();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.id).toBe(status.playgroundId);

      const version = summaries[0]?.currentVersion;
      if (version === undefined) throw new Error('catalogued playground has no version');
      const artifact = await store.get(version);
      expect(artifact.html.toLowerCase()).toContain('<html');
    },
    5 * 60 * 1000,
  );
});
