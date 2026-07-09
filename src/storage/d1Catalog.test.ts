import { describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { Subject } from '../identity/index.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import type { SessionHandle } from '../provider/index.js';
import { makeD1Catalog } from './d1Catalog.js';
import { PlaygroundId, VersionId } from './types.js';

// The D1 adapter's distinctive read path, asserted at the Catalog contract with a faithful fake of
// the exact D1 surface it touches (the single-row SELECT / upsert). The record shape, minting, and
// write ordering come from makeCatalog; what is NEW here — a null row reading as the empty catalog, a
// malformed stored document failing LOUDLY rather than as empty, and a legacy tag-less document
// hydrating to an empty tag list — is what these tests pin. [LAW:behavior-not-structure]

// A fake D1 holding the one catalog row as a single string cell, responding to exactly the two
// statements the adapter issues (a SELECT of the doc, an upsert of it). `setRaw` seeds the cell with
// arbitrary stored TEXT so the malformed-JSON and legacy-shape paths can be exercised directly.
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

const handle = (session: string, turn: string): SessionHandle => ({
  providerId: ProviderId('fake'),
  sessionId: SessionId(session),
  turnId: TurnId(turn),
});

const seed = { prompt: 'a bouncing ball', version: VersionId('v1'), lineage: null, author: Subject('ada'), tags: [] };

describe('makeD1Catalog', () => {
  it('reads an empty catalog when there is no row yet', async () => {
    const { db } = makeFakeD1();
    expect(await makeD1Catalog(db).listPlaygrounds()).toEqual([]);
  });

  it('round-trips a playground through the single-row document', async () => {
    const catalog = makeD1Catalog(makeFakeD1().db);
    const created = await catalog.createPlayground({ handle: handle('s1', 't1'), ...seed });
    const got = await catalog.getPlayground(created.id);
    expect(got.session.turns[0].prompt).toBe('a bouncing ball');
    expect(got.session.turns[0].version).toBe(VersionId('v1'));
    expect((await catalog.listPlaygrounds())).toHaveLength(1);
  });

  it('fails LOUDLY on a malformed stored document — never masks corruption as an empty catalog', async () => {
    const { db, setRaw } = makeFakeD1();
    setRaw('this is not json{');
    await expect(makeD1Catalog(db).listPlaygrounds()).rejects.toThrow();
  });

  it('fails LOUDLY with a clear message on valid JSON of the wrong shape (manual tampering)', async () => {
    const { db, setRaw } = makeFakeD1();
    // Valid JSON, wrong shape — e.g. someone set the cell to a number via `wrangler d1 execute`.
    setRaw('42');
    await expect(makeD1Catalog(db).listPlaygrounds()).rejects.toThrow('stored catalog document is malformed');
  });

  it('fails LOUDLY on a well-shaped array holding a malformed element, not a cryptic TypeError', async () => {
    const { db, setRaw } = makeFakeD1();
    // Outer shape valid, but an element is not a playground object — must still be a clear message.
    setRaw('{"playgrounds":[null]}');
    await expect(makeD1Catalog(db).listPlaygrounds()).rejects.toThrow('each playground must be an object');
  });

  it('hydrates a legacy tag-less document to an empty tag list at the read boundary', async () => {
    const { db, setRaw } = makeFakeD1();
    // A document written before the tags field existed: the session carries no `tags`.
    setRaw(
      JSON.stringify({
        playgrounds: [
          {
            id: 'pg-legacy',
            session: {
              sessionId: 's1',
              providerId: 'fake',
              lineage: null,
              author: 'ada',
              turns: [{ turnId: 't1', prompt: 'old', version: 'v0' }],
            },
          },
        ],
      }),
    );
    const got = await makeD1Catalog(db).getPlayground(PlaygroundId('pg-legacy'));
    expect(got.session.tags).toEqual([]);
  });
});
