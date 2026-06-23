import { randomUUID } from 'node:crypto';
import type {
  CatalogDoc,
  NewPlayground,
  NewTurn,
  Playground,
  PlaygroundId,
  PlaygroundSummary,
  SessionRecord,
  TurnRecord,
  VersionId,
} from './types.js';
import { PlaygroundId as mkPlaygroundId } from './types.js';

// The TYPED not-found signal. getPlayground fails loudly on an unknown id — but a caller
// must be able to tell "this id genuinely isn't in the commons" (a 404) apart from "the
// catalog itself couldn't be read" (an infra/invariant failure — a 500). An untyped Error
// conflates the two and forces callers to relabel every failure as not-found, a
// [LAW:no-silent-failure] trap. The type is the discriminator, decided once here.
// [LAW:types-are-the-program] [LAW:single-enforcer]
export class PlaygroundNotFoundError extends Error {
  constructor(public readonly id: PlaygroundId) {
    super(`unknown playground: ${id}`);
    this.name = 'PlaygroundNotFoundError';
  }
}

// THE CATALOG SEAM. The single source of truth for what playgrounds exist (public by
// default; design-docs/PROJECT.md). It records the session -> turns -> versions shape
// and fork lineage; browsing and running read from here and never touch the provider.
export interface Catalog {
  // Record a brand-new playground from a session's first succeeded turn. The catalog
  // mints and returns the PlaygroundId. [LAW:single-enforcer]
  createPlayground(input: NewPlayground): Promise<Playground>;

  // Append a follow-up turn (a new version) to an existing playground's session — the
  // iterate write path. The READ path needs no change: currentVersionOf already derives
  // the newest turn, so the commons and player serve the appended version automatically.
  // An unknown id fails loudly with PlaygroundNotFoundError, distinct from infra failure;
  // a turn whose handle names a different session is rejected, not silently stitched on.
  // [LAW:one-source-of-truth] [LAW:no-silent-failure]
  appendTurn(id: PlaygroundId, turn: NewTurn): Promise<Playground>;

  // The full record for one playground — session, turns, versions, lineage. An
  // unknown id fails loudly rather than returning a null callers must guard.
  // [LAW:no-silent-failure] [LAW:no-defensive-null-guards]
  getPlayground(id: PlaygroundId): Promise<Playground>;

  // The commons listing (p0v.6), in insertion order. An empty catalog yields an empty
  // list — data flow, not a special case. [LAW:dataflow-not-control-flow]
  listPlaygrounds(): Promise<readonly PlaygroundSummary[]>;
}

// The swap point beneath the seam: read and write the whole catalog document. This is
// the environment-varying part (local json file now; sqlite/D1/KV later) — isolating
// it is what lets one Catalog run everywhere by swapping the backend, never by
// branching on environment. The invariant logic lives in makeCatalog, not here.
// [LAW:decomposition] [LAW:dataflow-not-control-flow]
export interface CatalogStore {
  read(): Promise<CatalogDoc>;
  write(doc: CatalogDoc): Promise<void>;
}

// The latest version of a playground, derived from its session's turns. Version
// history is the turns in order; the current version is simply the last one. Derived,
// never stored, so it cannot drift from the turns. The non-empty turns tuple makes
// this total. [LAW:one-source-of-truth]
export const currentVersionOf = (session: SessionRecord): VersionId => {
  const [first, ...rest] = session.turns;
  return (rest.at(-1) ?? first).version;
};

// The cheap projection for the commons list: original describe + latest version.
// Derived from the playground, never persisted alongside it. [LAW:one-source-of-truth]
export const summarize = (playground: Playground): PlaygroundSummary => ({
  id: playground.id,
  prompt: playground.session.turns[0].prompt,
  providerId: playground.session.providerId,
  currentVersion: currentVersionOf(playground.session),
});

// The single implementation of the catalog invariants over any CatalogStore. The
// record shape, lineage-separate-from-history, and PlaygroundId minting live here
// exactly once; the local adapters (memory, file) supply only the backend.
// [LAW:single-enforcer]
export const makeCatalog = (store: CatalogStore): Catalog => {
  // One explicit owner of write ordering: every mutation runs after the previous one
  // settles, so the read-modify-write of the shared document can never interleave and
  // lose a playground. Reads do not need ordering and run directly.
  // [LAW:no-ambient-temporal-coupling]
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(op: () => Promise<T>): Promise<T> => {
    const run = tail.then(op, op);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const find = (doc: CatalogDoc, id: PlaygroundId): Playground => {
    const playground = doc.playgrounds.find((p) => p.id === id);
    if (playground === undefined) {
      throw new PlaygroundNotFoundError(id);
    }
    return playground;
  };

  return {
    createPlayground(input: NewPlayground): Promise<Playground> {
      return serialize(async () => {
        const playground: Playground = {
          id: mkPlaygroundId(randomUUID()),
          session: {
            sessionId: input.handle.sessionId,
            providerId: input.handle.providerId,
            lineage: input.lineage,
            turns: [{ turnId: input.handle.turnId, prompt: input.prompt, version: input.version }],
          },
        };
        const doc = await store.read();
        await store.write({ playgrounds: [...doc.playgrounds, playground] });
        return playground;
      });
    },

    appendTurn(id: PlaygroundId, turn: NewTurn): Promise<Playground> {
      return serialize(async () => {
        const doc = await store.read();
        const existing = find(doc, id);
        // A follow-up turn belongs to its playground's session. A handle minted against a
        // different session or provider would corrupt the record's identity, so reject it
        // loudly rather than appending a foreign turn. [LAW:no-silent-failure]
        if (
          turn.handle.sessionId !== existing.session.sessionId ||
          turn.handle.providerId !== existing.session.providerId
        ) {
          throw new Error(`turn ${turn.handle.turnId} does not belong to playground ${id}'s session`);
        }
        const appended: TurnRecord = {
          turnId: turn.handle.turnId,
          prompt: turn.prompt,
          version: turn.version,
        };
        const updated: Playground = {
          ...existing,
          session: { ...existing.session, turns: [...existing.session.turns, appended] },
        };
        await store.write({
          playgrounds: doc.playgrounds.map((p) => (p.id === id ? updated : p)),
        });
        return updated;
      });
    },

    async getPlayground(id: PlaygroundId): Promise<Playground> {
      return find(await store.read(), id);
    },

    async listPlaygrounds(): Promise<readonly PlaygroundSummary[]> {
      const doc = await store.read();
      return doc.playgrounds.map(summarize);
    },
  };
};
