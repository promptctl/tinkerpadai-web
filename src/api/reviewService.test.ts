import { describe, expect, it } from 'vitest';
import { makeMemoryCatalog, makeMemoryReportStore, PlaygroundId, VersionId } from '../storage/index.js';
import type { Catalog, ReportStore } from '../storage/index.js';
import { Subject } from '../identity/index.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import { makeReviewService } from './reviewService.js';

// The moderation review service's contract: it reads the SAME report store the intake writes as a
// queue grouped by playground, joins each to its current catalog state, and enacts unlist/relist —
// the enforcement half of moderation. These assertions are the ticket's admin-queue acceptance.
// [LAW:verifiable-goals]

const REPORTER = Subject('github:reporter');

const seed = async (catalog: Catalog, prompt: string): Promise<PlaygroundId> => {
  const playground = await catalog.createPlayground({
    handle: { providerId: ProviderId('p'), sessionId: SessionId(prompt), turnId: TurnId('t') },
    prompt,
    version: VersionId('v1'),
    lineage: null,
    author: Subject('ada'),
    tags: [],
  });
  return playground.id;
};

const setup = (): { catalog: Catalog; reportStore: ReportStore; review: ReturnType<typeof makeReviewService> } => {
  const catalog = makeMemoryCatalog();
  const reportStore = makeMemoryReportStore();
  return { catalog, reportStore, review: makeReviewService({ reports: reportStore, catalog }) };
};

describe('makeReviewService — the moderation review queue and enforcement', () => {
  it('yields an empty queue when nothing has been reported', async () => {
    const { review } = setup();
    expect(await review.queue()).toEqual([]);
  });

  it('groups reports by playground, joined to its title and current listing, in first-reported order', async () => {
    const { catalog, reportStore, review } = setup();
    const alpha = await seed(catalog, 'alpha');
    const beta = await seed(catalog, 'beta');

    // beta is reported first, then alpha twice — the queue is keyed by playground, ordered by when
    // each was FIRST reported, and carries every report against it.
    await reportStore.record({ playgroundId: beta, reporter: REPORTER, reason: 'spam' });
    await reportStore.record({ playgroundId: alpha, reporter: REPORTER, reason: 'harmful' });
    await reportStore.record({ playgroundId: alpha, reporter: REPORTER, reason: 'also broken' });

    const queue = await review.queue();
    expect(queue.map((item) => item.id)).toEqual([beta, alpha]);

    const betaItem = queue.find((item) => item.id === beta);
    expect(betaItem?.title).toBe('beta');
    expect(betaItem?.listing).toBe('listed');
    expect(betaItem?.reports.map((r) => r.reason)).toEqual(['spam']);

    const alphaItem = queue.find((item) => item.id === alpha);
    expect(alphaItem?.title).toBe('alpha');
    // One row for the twice-reported playground, carrying both reasons in order.
    expect(alphaItem?.reports.map((r) => r.reason)).toEqual(['harmful', 'also broken']);
  });

  it('keeps an already-unlisted reported playground in the queue, showing its listing so it can be relisted', async () => {
    const { catalog, reportStore, review } = setup();
    const id = await seed(catalog, 'flagged');
    await reportStore.record({ playgroundId: id, reporter: REPORTER, reason: 'harmful' });
    await review.setListing(id, 'unlisted');

    const queue = await review.queue();
    // getPlayground resolves an unlisted playground, so it still appears — with its listing shown, the
    // signal the reviewer needs to relist it.
    expect(queue.map((item) => item.id)).toEqual([id]);
    expect(queue.find((item) => item.id === id)?.listing).toBe('unlisted');
  });

  it('enacts the listing decision on the catalog — unlist hides from the commons, relist restores it', async () => {
    const { catalog, review } = setup();
    const id = await seed(catalog, 'target');

    await review.setListing(id, 'unlisted');
    expect(await catalog.listPlaygrounds()).toEqual([]);

    await review.setListing(id, 'listed');
    expect((await catalog.listPlaygrounds()).map((s) => s.id)).toEqual([id]);
  });

  it('fails loudly when asked to act on an unknown playground', async () => {
    const { review } = setup();
    await expect(review.setListing(PlaygroundId('does-not-exist'), 'unlisted')).rejects.toThrow(/unknown playground/);
  });
});
