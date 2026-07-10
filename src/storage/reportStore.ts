import { randomUUID } from 'node:crypto';
import type { NewReport, Report, ReportsDoc } from './types.js';
import { ReportId } from './types.js';

// THE REPORT STORE SEAM. The persistence boundary for moderation SIGNALS — reports raised against
// playgrounds — kept deliberately SEPARATE from the Catalog (design-docs/PROJECT.md keeps "what is
// dangerous" for the sandbox and "what is unwanted" for moderation as distinct concerns). The
// catalog is the PUBLIC source of truth for what exists; this store holds PRIVATE signal that a
// human reviewer (moderation-5g7.2) acts on, and whose reporter must never leak into the public read
// path. Recording is the signal-collection half of the epic; this seam does not act on reports.
// [LAW:decomposition] [LAW:one-source-of-truth]
export interface ReportStore {
  // Record a report against a playground. The store mints the ReportId and the timestamp — a
  // reporter raises a signal, it owns neither identity nor the clock. [LAW:single-enforcer]
  record(input: NewReport): Promise<Report>;

  // Every report ever recorded, in insertion order — the "listable" half of the ticket and the read
  // the review queue (moderation-5g7.2) is built on. An empty store yields an empty list — data
  // flow, not a special case. [LAW:dataflow-not-control-flow]
  list(): Promise<readonly Report[]>;
}

// The swap point beneath the seam: read and write the whole reports document. This is the
// environment-varying part (an in-memory array for tests, a JSON file on Node, a D1 row at the edge);
// isolating it is what lets one ReportStore run everywhere by swapping the backend, never by branching
// on environment. The minting and write-ordering invariants live in makeReportStore, not here — the
// exact decomposition the Catalog uses. [LAW:decomposition] [LAW:dataflow-not-control-flow]
export interface ReportStoreBackend {
  read(): Promise<ReportsDoc>;
  write(doc: ReportsDoc): Promise<void>;
}

// The empty document — the one initial state every backend starts from and returns when nothing is
// stored yet (no file, no D1 row, a fresh memory instance). It lives here, on the module that owns the
// ReportsDoc shape, so a change to what "empty" means is made once. [LAW:one-source-of-truth]
export const EMPTY_REPORTS: ReportsDoc = { reports: [] };

// The trust boundary where untyped persisted bytes become the typed document, applied at the read
// boundary of every persisted backend (file, D1, any future store). It validates rather than trusts a
// cast: a stored value that isn't the expected { reports: [...] } shape — gross corruption or manual
// tampering — fails LOUDLY with a clear message, never a downstream "cannot read properties of
// undefined" that hides what actually went wrong. It validates the skeleton, deliberately NOT every
// leaf field: we are the sole legitimate writer, so the threat is gross corruption, not malformed
// leaves, and a field-by-field validator would duplicate the Report type as runtime checks that drift
// from it. The in-memory store needs no hydration — it only ever holds current-shape objects. Mirrors
// the catalog's hydrateStoredDoc exactly. [LAW:types-are-the-program] [LAW:no-silent-failure]
// [LAW:single-enforcer]
export const hydrateReportsDoc = (doc: unknown): ReportsDoc => {
  if (typeof doc !== 'object' || doc === null || !Array.isArray((doc as { reports?: unknown }).reports)) {
    throw new Error('stored reports document is malformed: expected { reports: [...] }');
  }
  const reports = (doc as { reports: readonly unknown[] }).reports;
  // Validate each element is a non-null object, the same structural skeleton the catalog's
  // hydrateStoredDoc enforces per playground. Without this a tampered `{ reports: [42, null] }` would
  // pass and hand list() entries whose `.id`/`.reason`/`.at` are silently undefined — a corrupt
  // document read as valid, the exact lie this boundary exists to catch. Deliberately NOT a
  // field-by-field validator: we are the sole legitimate writer, so the threat is gross corruption,
  // not malformed leaves, and mirroring the Report type as runtime checks would duplicate it and
  // drift. [LAW:no-silent-failure] [LAW:types-are-the-program] [LAW:one-type-per-behavior]
  reports.forEach((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('stored reports document is malformed: each report must be an object');
    }
  });
  return doc as ReportsDoc;
};

// The single implementation of the report-store invariants over any backend. Id minting, timestamp
// minting, and write ordering live here exactly once; the adapters (memory, file, D1) supply only the
// backend. Mirrors makeCatalog. [LAW:single-enforcer]
export const makeReportStore = (backend: ReportStoreBackend): ReportStore => {
  // One explicit owner of write ordering: every record runs after the previous one settles, so the
  // read-modify-write of the shared document can never interleave and lose a report. The list read
  // needs no ordering and runs directly. The same serialize discipline makeCatalog uses.
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

  return {
    record(input: NewReport): Promise<Report> {
      return serialize(async () => {
        // Identity (randomUUID) and the clock (Date) are world effects the store owns at its
        // boundary, exactly as makeCatalog mints the PlaygroundId — the reporter supplies neither.
        // [LAW:effects-at-boundaries]
        const report: Report = {
          id: ReportId(randomUUID()),
          playgroundId: input.playgroundId,
          reporter: input.reporter,
          reason: input.reason,
          at: new Date().toISOString(),
        };
        const doc = await backend.read();
        await backend.write({ reports: [...doc.reports, report] });
        return report;
      });
    },

    async list(): Promise<readonly Report[]> {
      return (await backend.read()).reports;
    },
  };
};
