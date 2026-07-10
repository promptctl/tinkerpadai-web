import { describe, expect, it } from 'vitest';
import { Subject } from '../identity/index.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import { makeMemoryArtifactStore, makeMemoryCatalog, makeMemoryReportStore, PlaygroundId, VersionId } from '../storage/index.js';
import type { Catalog } from '../storage/index.js';
import { makeReportService } from './reportService.js';

// The report service's contract: it records a signal against a playground that EXISTS, and refuses —
// loudly — a report against one that does not. The existence check reuses the catalog's typed
// PlaygroundNotFoundError, so the HTTP boundary maps it to 404 the same way continue/fork do.
// [LAW:behavior-not-structure] [LAW:no-silent-failure]

const seedPlayground = async (catalog: Catalog): Promise<string> => {
  const created = await catalog.createPlayground({
    handle: { providerId: ProviderId('p'), sessionId: SessionId('s'), turnId: TurnId('t') },
    prompt: 'a tiny counter',
    version: VersionId('v1'),
    lineage: null,
    author: Subject('ada'),
    tags: [],
  });
  return created.id;
};

describe('makeReportService', () => {
  it('records a report against an existing playground and persists it to the store', async () => {
    const catalog = makeMemoryCatalog();
    const store = makeMemoryReportStore();
    const service = makeReportService({ catalog, reports: store });
    const id = await seedPlayground(catalog);

    const report = await service.report({
      playgroundId: PlaygroundId(id),
      reason: 'this is spam',
      reporter: Subject('github:7'),
    });

    expect(report.playgroundId).toBe(id);
    expect(report.reporter).toBe('github:7');
    expect(report.reason).toBe('this is spam');
    // The signal is durably in the store, listable for the review queue.
    expect(await store.list()).toEqual([report]);
  });

  it('refuses a report against an unknown playground, loudly, with nothing persisted', async () => {
    const catalog = makeMemoryCatalog();
    const store = makeMemoryReportStore();
    const service = makeReportService({ catalog, reports: store });

    await expect(
      service.report({ playgroundId: PlaygroundId('ghost'), reason: 'spam', reporter: Subject('github:7') }),
    ).rejects.toThrow(/ghost/);
    // No orphan signal was recorded.
    expect(await store.list()).toEqual([]);
  });
});
