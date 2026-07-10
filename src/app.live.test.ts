import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeNodeApp } from './web/nodeApp.js';
import { Subject } from './api/index.js';
import { resolveBrowserExecutablePath } from './api/headlessArtifactValidator.js';
import { makeFakeOAuthProvider } from './api/__fixtures__/fakeOAuthProvider.js';
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
      const { service, registry, store, catalog } = makeNodeApp({
        dataDir,
        oauth: makeFakeOAuthProvider({ subject: Subject('live-tester') }),
        oauthCallbackUrl: 'http://127.0.0.1/session/callback',
        cookieSecurity: { secure: false },
        adminSubjects: new Set(),
        // A tight smoke policy: a 5-minute per-attempt deadline and NO retry (maxAttempts 1). This
        // test verifies the whole graph composes and drives real generations end to end — not the
        // production deadline or retry, which are unit-tested. Retry (the 15-min × 2 default) could
        // push this multi-generation live run past its own 15-minute vitest ceiling; a single fast-
        // failing attempt keeps the smoke bounded. [LAW:decomposition]
        generationPolicy: { timeoutMs: 5 * 60 * 1000, maxAttempts: 1 },
        // The live e2e runs the REAL functional gate over real Claude-generated artifacts — the whole
        // composition, including "does the artifact actually run", proven end to end.
        browserExecutablePath: resolveBrowserExecutablePath(process.env),
      });

      const [provider] = service.listProviders();
      if (provider === undefined) throw new Error('no provider registered');
      expect((await registry.availabilityOf(provider.id)).state).toBe('available');

      const handle = await service.submit(
        {
          providerId: provider.id,
          brief: { description: 'a tiny counter with a + and - button' },
        },
        Subject('live-tester'),
      );

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
      const refined = await service.continue(
        status.playgroundId,
        { description: 'add a reset button that sets the count back to zero' },
        Subject('live-tester'),
      );
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

      // REMIX: forking the playground branches its current version into a NEW, INDEPENDENT
      // session — the contract the player's remix button drives. fork carries no brief (the
      // service derives the first-turn prompt from the parent's original describe) and resolves
      // the provider from the parent's session. INDEPENDENT: the catalog gains a second
      // playground with a DISTINCT id, not another version of the parent. [LAW:verifiable-goals]
      const forked = await service.fork(status.playgroundId, Subject('live-tester'));
      let forkedStatus: GenerationStatus = await service.poll(forked);
      while (forkedStatus.state === 'pending' || forkedStatus.state === 'running') {
        forkedStatus = await service.poll(forked);
      }
      expect(forkedStatus.state).toBe('ready');
      if (forkedStatus.state !== 'ready') throw new Error(forkedStatus.state);
      expect(forkedStatus.playgroundId).not.toBe(status.playgroundId);

      const afterFork = await catalog.listPlaygrounds();
      expect(afterFork).toHaveLength(2);
      const forkVersion = afterFork.find((s) => s.id === forkedStatus.playgroundId)?.currentVersion;
      if (forkVersion === undefined) throw new Error('forked playground has no version');
      expect((await store.get(forkVersion)).html.toLowerCase()).toContain('<html');

      // VISIBLE LINEAGE (p0v.17): the read projection surfaces the fork's provenance over the
      // REAL catalog — the parent (not a fork) carries none, the fork resolves back to the
      // parent's browsable id and original describe. This is the attribution the commons/player
      // render; here we prove it is derived correctly from real minted ids. [LAW:verifiable-goals]
      const parentSummary = afterFork.find((s) => s.id === status.playgroundId);
      const forkSummary = afterFork.find((s) => s.id === forkedStatus.playgroundId);
      expect(parentSummary?.forkedFrom).toBeNull();
      expect(forkSummary?.forkedFrom).toEqual({
        parent: { id: status.playgroundId, prompt: parentSummary?.prompt },
      });

      // CONTINUABLE: the fork is a first-class playground that can itself be refined — a
      // follow-up onto the fork advances ITS version while leaving the parent untouched (the
      // catalog stays at 2). This is what makes a remix "your own copy you can iterate".
      const forkRefined = await service.continue(
        forkedStatus.playgroundId,
        { description: 'add a label above the counter' },
        Subject('live-tester'),
      );
      let forkRefinedStatus: GenerationStatus = await service.poll(forkRefined);
      while (forkRefinedStatus.state === 'pending' || forkRefinedStatus.state === 'running') {
        forkRefinedStatus = await service.poll(forkRefined);
      }
      expect(forkRefinedStatus.state).toBe('ready');
      if (forkRefinedStatus.state !== 'ready') throw new Error(forkRefinedStatus.state);
      expect(forkRefinedStatus.playgroundId).toBe(forkedStatus.playgroundId);

      const afterForkRefine = await catalog.listPlaygrounds();
      expect(afterForkRefine).toHaveLength(2);
      const forkNewVersion = afterForkRefine.find((s) => s.id === forkedStatus.playgroundId)?.currentVersion;
      if (forkNewVersion === undefined) throw new Error('refined fork has no version');
      expect(forkNewVersion).not.toBe(forkVersion);
      // The parent is untouched by work on its fork — independent sessions, not shared state.
      expect(afterForkRefine.find((s) => s.id === status.playgroundId)?.currentVersion).toBe(newVersion);
    },
    15 * 60 * 1000,
  );
});
