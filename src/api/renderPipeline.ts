import type { RenderSession } from './browserRenderer.js';
import type { CatalogReader, PlaygroundSummary, RenderStatusStore, ThumbnailStore, VersionId } from '../storage/index.js';
import { PlaygroundId, PlaygroundNotFoundError, currentVersionOf, renderStateOf } from '../storage/index.js';

// THE ASYNC RENDER PIPELINE — the derivation that turns the store + driver (render-dax.1, .2) into a
// running producer of thumbnails, ASYNC and OUT of any generation-create path. This module is the PURE
// core: it decides WHAT to render and records the result through injected seams (catalog, thumbnail store,
// status store, a render session, a URL formula), and it returns a plain DIRECTIVE for how the caller
// should treat the queue message. It holds NO Cloudflare types — the queue's ack/retry/attempts mechanics
// live in the edge shell (worker.ts), which maps this directive onto them. So the whole decision logic is
// testable with memory stores and a fake session, and the edge glue is trivial. [LAW:effects-at-boundaries]
// [LAW:decomposition] [LAW:dataflow-not-control-flow]

// One unit of work: render the preview for a playground. It carries ONLY the playground id — never the
// version — because the version to render is derived from the authoritative catalog at CONSUME time, so a
// thumbnail can never be keyed to a version whose pixels it does not actually show (a race where a new turn
// lands between enqueue and render would otherwise mint that lie). [LAW:one-source-of-truth]
export interface RenderJob {
  readonly playgroundId: PlaygroundId;
}

// The seams the per-message pipeline reads and writes. `contentUrlOf` is the SAME formula the player frames
// (playgroundContentUrl), injected as a value so the pipeline never imports the web layer — the composition
// root supplies it. [LAW:decomposition]
export interface RenderPipelineDeps {
  readonly catalog: CatalogReader;
  readonly thumbnails: ThumbnailStore;
  readonly statuses: RenderStatusStore;
  readonly contentUrlOf: (playgroundId: PlaygroundId) => string;
}

// What (if anything) a job resolves to render. Skipping is a VALUE, not a thrown special case: an unlisted
// playground shows no preview (a takedown reaches even the derived cache), and a version that already has a
// thumbnail is a no-op (idempotency: re-delivery and overlapping backfills converge). [LAW:dataflow-not-control-flow]
export interface RenderTarget {
  readonly versionId: VersionId;
  readonly contentUrl: string;
}
export type ResolveResult =
  | { readonly render: RenderTarget }
  | { readonly skip: 'unlisted' | 'already-rendered' };

// Decide the target for a job from the two authorities — the catalog (what exists, and its visibility) and
// the thumbnail cache (what is already rendered). Renders the CURRENT version's content URL, keyed by that
// current version, so the stored thumbnail always matches the bytes the URL serves. An unknown playground
// throws PlaygroundNotFoundError (the caller treats it as a poison message to drop, not to retry forever).
// [LAW:one-source-of-truth]
export const resolveRenderTarget = async (deps: RenderPipelineDeps, job: RenderJob): Promise<ResolveResult> => {
  const playground = await deps.catalog.getPlayground(job.playgroundId);
  if (playground.listing === 'unlisted') return { skip: 'unlisted' };
  const versionId = currentVersionOf(playground.session);
  if ((await deps.thumbnails.get(versionId)) !== undefined) return { skip: 'already-rendered' };
  return { render: { versionId, contentUrl: deps.contentUrlOf(job.playgroundId) } };
};

// How the caller should treat the message after one attempt. `done` → ack it (rendered, skipped, or
// terminally failed-and-recorded). `retry` → return it to the queue for another bounded attempt. A plain
// directive, so the pure core owns the DECISION and the edge shell owns the queue MECHANICS. [LAW:dataflow-not-control-flow]
export type AttemptResult = { readonly kind: 'done' } | { readonly kind: 'retry' };
const DONE: AttemptResult = { kind: 'done' };
const RETRY: AttemptResult = { kind: 'retry' };

// Which attempt this is (1-based, from the queue) and the bound past which a persistent render failure is
// recorded 'failed' rather than retried again. The bound is the caller's (the queue's max_retries); the
// pipeline only compares against it. [LAW:no-ambient-temporal-coupling]
export interface Attempt {
  readonly number: number;
  readonly max: number;
}

// Run ONE attempt for one job, on an already-open render session (the batch's single browser — Browser
// Rendering rate-limits launches, so the shell opens one session per batch and hands it here per message).
// TOTAL: it never throws, always returning a directive, so the edge shell is a pure mapping to ack/retry.
//
//   - resolve → unknown playground: a poison message, dropped (`done`) with a warning, never retried;
//               any other resolve fault (catalog/store unreachable) is transient → `retry`, and NOT
//               recorded 'failed' (an infra outage is not a bad artifact).
//   - render success → store the thumbnail (rendered-ness now lives in the blob) and CLEAR the status
//               (retire the enqueuer's 'pending' marker) → `done`.
//   - render failure → below the bound, `retry`; AT the bound, record 'failed' and error-log so a crashed
//               render is a distinguishable, surfaced state, never an eternally-empty 'pending' slot that
//               reads as 'not yet' forever → `done`. [LAW:no-silent-failure]
export const renderAttempt = async (
  session: RenderSession,
  deps: RenderPipelineDeps,
  job: RenderJob,
  attempt: Attempt,
): Promise<AttemptResult> => {
  let target: RenderTarget;
  try {
    const resolved = await resolveRenderTarget(deps, job);
    if ('skip' in resolved) return DONE;
    target = resolved.render;
  } catch (error) {
    if (error instanceof PlaygroundNotFoundError) {
      console.warn(`tinkerpad render: dropping job for unknown playground ${job.playgroundId}: ${error.message}`);
      return DONE;
    }
    console.warn(`tinkerpad render: could not resolve job for ${job.playgroundId}, will retry: ${messageOf(error)}`);
    return RETRY;
  }

  // The RENDER itself — separated from persistence below so a store fault is never miscounted as a render
  // failure. A throw here is the renderer crashing/timing out: below the bound retry; AT the bound record
  // 'failed' and finish. The terminal status write is BEST-EFFORT — this function is documented TOTAL
  // (never throws, so the edge shell is a pure ack/retry mapping), so a KV outage while recording must not
  // escape: if it fails, the version stays pending-without-thumbnail and the self-healing backfill
  // re-enqueues it, re-recording 'failed' once KV recovers. [LAW:no-silent-failure] [FRAMING:representation]
  let png: Uint8Array;
  try {
    ({ png } = await session.render(target.contentUrl));
  } catch (error) {
    const message = messageOf(error);
    if (attempt.number >= attempt.max) {
      console.error(
        `tinkerpad render: version ${target.versionId} failed after ${attempt.number} attempt(s); recording failed: ${message}`,
      );
      await deps.statuses.set(target.versionId, 'failed').catch((statusError) =>
        console.error(`tinkerpad render: version ${target.versionId} failed but recording 'failed' also failed; backfill will retry: ${messageOf(statusError)}`),
      );
      return DONE;
    }
    console.warn(`tinkerpad render: version ${target.versionId} attempt ${attempt.number} failed, will retry: ${message}`);
    return RETRY;
  }

  // The render SUCCEEDED. Persist it; a persistence fault (KV/R2 unavailable) is transient and the render is
  // redoable and IDEMPOTENT, so it is a retry, not a throw and not a recorded failure — a later delivery
  // re-renders and re-puts, after which resolveRenderTarget skips it as already-rendered. put is the
  // load-bearing write (rendered-ness lives in the blob); clearing the 'pending' marker is a follow-up the
  // blob already shadows. Keeping this OUT of the render catch is what stops a store blip from ever being
  // recorded as a 'failed' artifact. [LAW:one-source-of-truth] [LAW:no-silent-failure]
  try {
    await deps.thumbnails.put(target.versionId, png);
    await deps.statuses.clear(target.versionId);
    return DONE;
  } catch (error) {
    console.warn(`tinkerpad render: version ${target.versionId} rendered but persisting failed, will retry: ${messageOf(error)}`);
    return RETRY;
  }
};

// The seams the backfill reads and writes. It needs only the commons LISTING (listPlaygrounds already
// filters to listed playgrounds, so an unlisted one is never enqueued), the thumbnail cache (to skip what
// is already rendered), the status store (to mark the honest 'pending'), and the producer seam that hands
// jobs to the queue. [LAW:decomposition]
export interface BackfillDeps {
  readonly catalog: { listPlaygrounds(): Promise<readonly PlaygroundSummary[]> };
  readonly thumbnails: ThumbnailStore;
  readonly statuses: RenderStatusStore;
  // Hand a batch of jobs to the queue. Accepts an empty batch as a no-op, so the caller need not branch on
  // emptiness. [LAW:dataflow-not-control-flow]
  readonly enqueue: (jobs: readonly RenderJob[]) => Promise<void>;
}
export interface BackfillReport {
  readonly enqueued: number;
  readonly skipped: number;
}

// IDEMPOTENT commons backfill — what populates the grid TODAY, independent of edge generation being off,
// and the self-healing tick that later picks up any newly-published playground the immediate hook missed.
// Enqueues a job only for a listed playground whose CURRENT version is still awaiting a render, marking it
// 'pending' so an honest awaiting-render slot appears immediately, and converges to a true no-op once every
// version is either rendered or terminally failed.
//
// Skippability is the SAME 3-state view the card reads (renderStateOf): 'rendered' (a thumbnail exists) and
// 'failed' (past the retry bound, recorded terminal) are both skipped; only a 'pending' version — never
// enqueued, or enqueued-but-not-yet-done — is a gap to fill. Consulting the status store here, not just the
// thumbnail cache, is what makes 'failed' actually terminal: without it a persistently-unrenderable
// playground has no thumbnail, so it would land in the gap set every tick and burn its whole retry budget of
// browser renders every 15 minutes, forever — the eternally-retried counterpart of the eternally-empty slot
// renderAttempt already guards against. A genuinely-fixable failure is re-rendered by an operator clearing
// its status, not by the backfill grinding on it. [LAW:no-silent-failure] [LAW:one-source-of-truth]
// [LAW:dataflow-not-control-flow]
export const runBackfill = async (deps: BackfillDeps): Promise<BackfillReport> => {
  const summaries = await deps.catalog.listPlaygrounds();
  const missing: PlaygroundSummary[] = [];
  let skipped = 0;
  for (const summary of summaries) {
    const hasThumbnail = (await deps.thumbnails.get(summary.currentVersion)) !== undefined;
    const status = await deps.statuses.get(summary.currentVersion);
    if (renderStateOf(hasThumbnail, status) !== 'pending') {
      skipped += 1;
      continue;
    }
    missing.push(summary);
  }
  await Promise.all(missing.map((summary) => deps.statuses.set(summary.currentVersion, 'pending')));
  const jobs = missing.map((summary): RenderJob => ({ playgroundId: summary.id }));
  await deps.enqueue(jobs);
  return { enqueued: jobs.length, skipped };
};

// A delivered queue message, reduced to exactly what the batch processor needs — its untyped body, its
// 1-based delivery count, an id for logging, and the two acknowledgements it can send. Cloudflare's
// Message<unknown> satisfies this shape structurally, so the edge shell passes real messages straight in
// while a test passes fakes: the batch logic never names a Cloudflare type. [LAW:decomposition]
export interface RenderMessage {
  readonly id: string;
  readonly body: unknown;
  readonly attempts: number;
  ack(): void;
  retry(): void;
}

// Process one delivered batch on an ALREADY-OPEN session — the pure per-batch logic lifted out of the edge
// shell so the Cloudflare-Queue-specific wiring is testable without a browser. Per message: parse at the
// trust boundary (a malformed body is a poison message — logged and ACKED so it leaves the queue, never
// retried into a permanent block), then run one bounded attempt and map its directive onto the queue's
// ack/retry. The browser lifecycle (one launch per batch) and the real Message live in worker.ts; this owns
// only the mapping, so a wrong ack/retry or a missing poison-pill guard is caught by a fake-message test
// rather than only in production. [LAW:effects-at-boundaries] [LAW:decomposition] [LAW:dataflow-not-control-flow]
export const runRenderBatch = async (
  session: RenderSession,
  deps: RenderPipelineDeps,
  messages: readonly RenderMessage[],
  maxAttempts: number,
): Promise<void> => {
  for (const message of messages) {
    let job: RenderJob;
    try {
      job = parseRenderJob(message.body);
    } catch (error) {
      console.error(`tinkerpad render: dropping malformed queue message ${message.id}: ${messageOf(error)}`);
      message.ack();
      continue;
    }
    const result = await renderAttempt(session, deps, job, { number: message.attempts, max: maxAttempts });
    if (result.kind === 'retry') message.retry();
    else message.ack();
  }
};

// The trust boundary for a queue message body — foreign, untyped bytes off the wire become a typed
// RenderJob here and ONLY here (the playgroundId's runtime brand was erased in transit, so it is re-branded
// after validation). A malformed body fails loudly rather than flowing a bad id downstream. [LAW:types-are-the-program]
// [LAW:single-enforcer]
export const parseRenderJob = (body: unknown): RenderJob => {
  if (typeof body !== 'object' || body === null) {
    throw new Error('render job is malformed: expected an object');
  }
  const playgroundId = (body as { playgroundId?: unknown }).playgroundId;
  if (typeof playgroundId !== 'string' || playgroundId === '') {
    throw new Error('render job is malformed: playgroundId must be a non-empty string');
  }
  return { playgroundId: PlaygroundId(playgroundId) };
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
