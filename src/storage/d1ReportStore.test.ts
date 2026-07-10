import { describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { Subject } from '../identity/index.js';
import { makeD1ReportStore } from './d1ReportStore.js';
import { PlaygroundId } from './types.js';

// The D1 adapter's distinctive read path, asserted at the ReportStore contract with a faithful fake
// of the exact D1 surface it touches (the single-row SELECT / upsert). Id/timestamp minting and write
// ordering come from makeReportStore; what is NEW here is a null row reading as an empty store and a
// malformed stored document failing LOUDLY rather than as empty. Mirrors d1Catalog.test.
// [LAW:behavior-not-structure]
const makeFakeD1 = (): { db: D1Database; setRaw: (doc: string) => void } => {
  let cell: string | undefined;
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (!sql.startsWith('SELECT')) throw new Error(`unexpected first() on: ${sql}`);
              return cell === undefined ? null : ({ doc: cell } as T);
            },
            async run(): Promise<unknown> {
              if (!sql.startsWith('INSERT')) throw new Error(`unexpected run() on: ${sql}`);
              cell = String(args[1]);
              return {};
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, setRaw: (doc: string) => { cell = doc; } };
};

describe('makeD1ReportStore', () => {
  it('reads an empty store when there is no row yet', async () => {
    const { db } = makeFakeD1();
    expect(await makeD1ReportStore(db).list()).toEqual([]);
  });

  it('round-trips a report through the single-row document', async () => {
    const store = makeD1ReportStore(makeFakeD1().db);
    const recorded = await store.record({
      playgroundId: PlaygroundId('pg-1'),
      reporter: Subject('github:7'),
      reason: 'this is spam',
    });
    const listed = await store.list();
    expect(listed).toEqual([recorded]);
    expect(listed[0]?.reason).toBe('this is spam');
    expect(listed[0]?.reporter).toBe('github:7');
  });

  it('fails LOUDLY on a malformed stored document rather than reading it as empty', async () => {
    const { db, setRaw } = makeFakeD1();
    setRaw('42');
    await expect(makeD1ReportStore(db).list()).rejects.toThrow(/malformed/);
  });
});
