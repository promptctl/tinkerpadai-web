import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Subject } from '../identity/index.js';
import { makeFileReportStore } from './fileReportStore.js';
import { makeMemoryReportStore } from './memoryReportStore.js';
import type { ReportStore } from './reportStore.js';
import { PlaygroundId } from './types.js';

// The backend-agnostic contract every ReportStore must satisfy, run against each local adapter — a
// new backend proves itself by passing this same suite, exactly like the Catalog contract. What is
// pinned here is the seam's promise: record persists a signal (minting id + timestamp), and list
// returns every report in insertion order.
interface Harness {
  readonly reports: ReportStore;
  readonly close: () => Promise<void>;
}

const ADAPTERS: ReadonlyArray<{ readonly name: string; readonly open: () => Promise<Harness> }> = [
  {
    name: 'memory',
    open: async () => ({ reports: makeMemoryReportStore(), close: async () => {} }),
  },
  {
    name: 'file',
    open: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'tp-reports-'));
      return { reports: makeFileReportStore(join(dir, 'reports.json')), close: () => rm(dir, { recursive: true, force: true }) };
    },
  },
];

const REPORTER = Subject('github:7');

describe.each(ADAPTERS)('ReportStore contract: $name', ({ open }) => {
  it('records a report, minting an id and an ISO timestamp, and lists it back', async () => {
    const { reports, close } = await open();
    try {
      const before = Date.now();
      const report = await reports.record({
        playgroundId: PlaygroundId('pg-1'),
        reporter: REPORTER,
        reason: 'this is spam',
      });

      // The store minted identity and the clock — the reporter supplied neither.
      expect(report.id).toMatch(/\S/);
      expect(report.playgroundId).toBe('pg-1');
      expect(report.reporter).toBe('github:7');
      expect(report.reason).toBe('this is spam');
      // `at` is a real ISO-8601 instant at (or after) record time.
      const at = Date.parse(report.at);
      expect(Number.isNaN(at)).toBe(false);
      expect(at).toBeGreaterThanOrEqual(before);
      expect(new Date(at).toISOString()).toBe(report.at);

      const listed = await reports.list();
      expect(listed).toEqual([report]);
    } finally {
      await close();
    }
  });

  it('keeps every report in insertion order with distinct ids', async () => {
    const { reports, close } = await open();
    try {
      const a = await reports.record({ playgroundId: PlaygroundId('pg-1'), reporter: REPORTER, reason: 'harmful' });
      const b = await reports.record({ playgroundId: PlaygroundId('pg-2'), reporter: Subject('github:8'), reason: 'illegal' });
      const c = await reports.record({ playgroundId: PlaygroundId('pg-1'), reporter: REPORTER, reason: 'spam again' });

      const listed = await reports.list();
      expect(listed.map((r) => r.reason)).toEqual(['harmful', 'illegal', 'spam again']);
      // A playground can carry more than one report — the store never dedupes signal.
      expect(listed.filter((r) => r.playgroundId === 'pg-1')).toHaveLength(2);
      // Ids are unique per report.
      expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    } finally {
      await close();
    }
  });

  it('lists an empty store as an empty array, never a crash', async () => {
    const { reports, close } = await open();
    try {
      expect(await reports.list()).toEqual([]);
    } finally {
      await close();
    }
  });
});
