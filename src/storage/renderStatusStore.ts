import type { VersionId } from './types.js';

// THE RENDER-STATUS SEAM — the operational state of a version's thumbnail DERIVATION, owned by the render
// pipeline (render-dax.3), never the catalog. It is the deliberate companion of the ThumbnailStore, and
// the split between them is a single-source-of-truth decision:
//
//   - `rendered` is NOT a value this store holds. A version IS rendered exactly when its thumbnail blob
//     exists (ThumbnailStore.get !== undefined). Recording a 'rendered' status here as well would mint a
//     SECOND authority for rendered-ness that could disagree with the blob — so the type makes it
//     unrepresentable: the only statuses are the two the blob's presence CANNOT tell you apart.
//     [LAW:one-source-of-truth] [LAW:types-are-the-program]
//
//   - `pending` (enqueued, awaiting render) and `failed` (render failed past its retry bound) are the two
//     states a MISSING thumbnail could mean, and only the pipeline knows which. Absence of BOTH a
//     thumbnail and a status is the third honest reading — 'never enqueued' — so `get` returns `undefined`
//     for that, never a loud error: a version with no status is a legitimate state, not a fault, exactly
//     as with the thumbnail store. [LAW:no-defensive-null-guards] [FRAMING:representation]
//
// Ownership of the transitions is clean: the ENQUEUER (backfill, the future publish hook) writes 'pending';
// the CONSUMER clears it on success (rendered-ness then lives solely in the blob) or writes 'failed' on
// terminal failure — so a crashed render is a distinguishable, surfaced state, never an eternally-empty
// slot that reads as 'not yet' forever. [LAW:no-silent-failure]
export type RenderStatus = 'pending' | 'failed';

export interface RenderStatusStore {
  // Record the operational status of a version's render — 'pending' at enqueue, 'failed' at terminal
  // failure. Idempotent by version: re-writing overwrites.
  set(versionId: VersionId, status: RenderStatus): Promise<void>;

  // The status for a version, or `undefined` when none is recorded ('never enqueued', or cleared after a
  // successful render). Absence is a value, never a loud failure. [LAW:no-silent-failure]
  get(versionId: VersionId): Promise<RenderStatus | undefined>;

  // Drop a version's status. Called by the consumer on a SUCCESSFUL render: rendered-ness now lives in the
  // thumbnail blob (the one source of truth), so the operational 'pending' marker is retired rather than
  // left as stale state the blob already shadows. Clearing an absent status is a no-op, not an error.
  clear(versionId: VersionId): Promise<void>;
}

// THE THREE-STATE VIEW the commons card consumes (discovery-rye.3): the honest render-state of a version,
// DERIVED — never stored — from the two authorities. A present thumbnail IS 'rendered' (the blob is the
// source of truth, so it wins over any stale status). Otherwise the explicit operational status, with a
// missing status reading as 'pending' — an enqueued-but-unrendered and a never-touched version both show
// the same honest "not yet" slot, so the card needs no fourth state. The failed state is distinct from
// pending, so a crashed render is surfaced, not hidden as a permanent blank. This function is the SINGLE
// home of "what does a version's render look like", so the card and any operator view read it identically.
// [LAW:one-source-of-truth] [LAW:dataflow-not-control-flow]
export type RenderState = 'rendered' | 'pending' | 'failed';

export const renderStateOf = (hasThumbnail: boolean, status: RenderStatus | undefined): RenderState =>
  hasThumbnail ? 'rendered' : (status ?? 'pending');

// The key convention for a version's status entry — the ONE owner of the `render-status/<versionId>`
// namespace, so the KV backend and any tool that addresses statuses derive it from here and a change to
// the format changes every reader at once. Prefixed distinctly so it can never be confused with any other
// key that might live in the same namespace. [LAW:one-source-of-truth]
export const renderStatusKey = (versionId: VersionId): string => `render-status/${versionId}`;

// Turn a raw stored value back into a RenderStatus at the read boundary. `null` (genuine absence) becomes
// `undefined`, the honest "no status". A recognized status passes through. ANYTHING else — a value only
// manual tampering could put there — fails LOUDLY rather than being silently coerced to a wrong state that
// would mislabel a version's render. This is the single trust boundary where an untyped stored string
// becomes the typed status. [LAW:types-are-the-program] [LAW:no-silent-failure]
export const parseRenderStatus = (raw: string | null): RenderStatus | undefined => {
  if (raw === null) return undefined;
  if (raw === 'pending' || raw === 'failed') return raw;
  throw new Error(`stored render status is malformed: expected 'pending' | 'failed', got ${JSON.stringify(raw)}`);
};
