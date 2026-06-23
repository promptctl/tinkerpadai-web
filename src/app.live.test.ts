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

      // REFINE: a follow-up brief onto the same playground produces a successive version, the
      // contract the player's refine box drives. continue resolves the provider from the
      // playground's session — no provider is restated. The playground count stays 1 (an
      // appended version, not a new playground) and currentVersion advances to the refined
      // file, which is what currentVersionOf serves on reload. [LAW:verifiable-goals]
      const refined = await service.continue(status.playgroundId, {
        description: 'add a reset button that sets the count back to zero',
      });
      let refinedStatus: GenerationStatus = await service.poll(refined);
      while (refinedStatus.state === 'pending' || refinedStatus.state === 'running') {
        refinedStatus = await service.poll(refined);
      }
      expect(refinedStatus.state).toBe('ready');
      if (refinedStatus.state !== 'ready') throw new Error(refinedStatus.state);
      expect(refinedStatus.playgroundId).toBe(status.playgroundId);

      const afterRefine = await catalog.listPlaygrounds();
      expect(afterRefine).toHaveLength(1);
      const newVersion = afterRefine[0]?.currentVersion;
      if (newVersion === undefined) throw new Error('refined playground has no version');
      expect(newVersion).not.toBe(version);
      expect((await store.get(newVersion)).html.toLowerCase()).toContain('<html');
    },
    10 * 60 * 1000,
  );
});
