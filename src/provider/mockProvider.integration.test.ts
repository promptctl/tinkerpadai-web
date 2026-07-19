import { describe, expect, it } from 'vitest';
import { Subject } from '../identity/index.js';
import { makeMockProvider } from './mockProvider.js';
import type { MockConversation } from './mockProvider.js';
import { ProviderId, ProviderRegistry } from './index.js';
import { makeMemoryArtifactStore, makeMemoryCatalog } from '../storage/index.js';
import { makeGenerationService } from '../api/generationService.js';
import { makeTestQuota } from '../api/__fixtures__/testQuota.js';
import { passThroughValidator } from '../api/artifactValidation.js';

// The epic's acceptance, at the makeGenerationService seam: the mock provider carries the FULL
// create → refine → remix loop through the REAL service, store, and catalog — deterministically,
// with no upstream. This is what registering the mock at the edge buys: an end-to-end generation
// path that can be driven and asserted on before a metered driver exists. [LAW:verifiable-goals]

const script: MockConversation = {
  turns: [
    { progress: ['generating v1'], outcome: { kind: 'artifact', html: '<!-- MOCK V1 -->' } },
    { progress: ['generating v2'], outcome: { kind: 'artifact', html: '<!-- MOCK V2 -->' } },
  ],
};

const AUTHOR = Subject('ada');
const REFINER = Subject('lin');
const FORKER = Subject('grace');

const harness = () => {
  const registry = new ProviderRegistry();
  registry.register(makeMockProvider({ id: 'mock', label: 'Mock', conversation: script }));
  const store = makeMemoryArtifactStore();
  const catalog = makeMemoryCatalog();
  const service = makeGenerationService({
    registry,
    store,
    catalog,
    disposeTurn: async () => undefined,
    quota: makeTestQuota(),
    maxAttempts: 1,
    validateArtifact: passThroughValidator,
    now: () => Date.now(),
  });
  return { service, store, catalog, providerId: ProviderId('mock') };
};

// The current html catalogued for a playground — how the loop's effect is observed end to end.
const currentHtml = async (h: ReturnType<typeof harness>, playgroundId: string): Promise<string> => {
  const summaries = await h.catalog.listPlaygrounds();
  const summary = summaries.find((s) => s.id === playgroundId);
  if (summary?.currentVersion === undefined) throw new Error(`no current version for ${playgroundId}`);
  return (await h.store.get(summary.currentVersion)).html;
};

describe('mock provider drives the full create → refine → remix loop through the real service', () => {
  it('creates, refines to a new version, and remixes from the parent artifact — all canned', async () => {
    const h = harness();

    // CREATE: submit → poll → ready, with the first canned artifact catalogued.
    const created = await h.service.submit({ providerId: h.providerId, brief: { description: 'make a color tool' } }, AUTHOR);
    const createdStatus = await h.service.poll(created);
    expect(createdStatus.state).toBe('ready');
    if (createdStatus.state !== 'ready') throw new Error('unreachable');
    expect(await currentHtml(h, createdStatus.playgroundId)).toBe('<!-- MOCK V1 -->');

    // REFINE: continue the same playground → a NEW version (the second canned turn).
    const refined = await h.service.continue(createdStatus.playgroundId, { description: 'add a slider' }, REFINER);
    const refinedStatus = await h.service.poll(refined);
    expect(refinedStatus.state).toBe('ready');
    if (refinedStatus.state !== 'ready') throw new Error('unreachable');
    expect(refinedStatus.playgroundId).toBe(createdStatus.playgroundId);
    expect(await currentHtml(h, createdStatus.playgroundId)).toBe('<!-- MOCK V2 -->');

    // REMIX: fork into a NEW playground seeded from the parent's CURRENT artifact.
    const forked = await h.service.fork(createdStatus.playgroundId, FORKER);
    const forkedStatus = await h.service.poll(forked);
    expect(forkedStatus.state).toBe('ready');
    if (forkedStatus.state !== 'ready') throw new Error('unreachable');
    expect(forkedStatus.playgroundId).not.toBe(createdStatus.playgroundId);
    // The remix begins where the parent is: its genesis artifact is the seed, not a scripted turn.
    expect(await currentHtml(h, forkedStatus.playgroundId)).toBe('<!-- MOCK V2 -->');
  });
});
