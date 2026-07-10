import type {
  Artifact,
  Availability,
  Brief,
  GenerationRequest,
  ProgressEvent,
  Provider,
  ProviderDescriptor,
  ProviderId,
  ProviderRegistry,
  SessionHandle,
  SessionStatus,
} from '../provider/index.js';
import type { Subject } from '../identity/index.js';
import type { ArtifactStore, Catalog, Lineage, Playground, PlaygroundId, VersionId } from '../storage/index.js';
import { currentTurnOf, currentVersionOf, SelfContainmentError } from '../storage/index.js';
import { deriveTags } from './deriveTags.js';
import type { GenerationQuota, Reservation } from './generationQuota.js';
import { FunctionalDefectError } from './artifactValidation.js';
import type { ArtifactValidator } from './artifactValidation.js';

// THE GENERATION SERVICE — the one boundary where the generation effect is performed,
// wiring registry -> provider -> store -> catalog. It is provider-agnostic by
// construction: it resolves the chosen provider from the registry by VALUE and reads
// only the Provider/ArtifactStore/Catalog seams, so swapping the adapter behind any of
// them changes nothing here. The rest of the system (browse, use) reads the catalog and
// store and never depends on this. [LAW:decomposition] [LAW:effects-at-boundaries]

// The client-facing status of a generation. It mirrors the provider's SessionStatus
// with one deliberate difference: terminal success is `ready`, carrying the catalog's
// PlaygroundId rather than the raw file. By the time a client observes success the file
// is already a durably stored version and a catalogued playground, so "succeeded but
// not yet persisted" is not a state this surface can return — the illegal intermediate
// is unrepresentable. Terminal failure carries the surfaced message, never an empty
// file or a meaning-changing fallback. [LAW:types-are-the-program] [LAW:no-silent-failure]
export type GenerationStatus =
  | { readonly state: 'pending' }
  | { readonly state: 'running' }
  | { readonly state: 'ready'; readonly playgroundId: PlaygroundId }
  | { readonly state: 'failed'; readonly error: string };

// The READ-ONLY observability of a turn in flight — the companion to poll(), never a replacement.
// poll() owns the terminal transition and the one store+catalog write; progress() only OBSERVES, so a
// client watching it can neither cause a write nor advance a turn. It carries the two things poll's
// point-in-time GenerationStatus cannot, and that a 5-11 minute (plus retry) generation needs:
//   - `generating` with the live `message` — the provider's latest note, the proof a long turn is
//     advancing rather than hung;
//   - `validating` — the post-provider-success window in which poll() is blocked inside finalizeSuccess
//     running the functional gate (a headless-Chrome load, ~10s). That window would otherwise read as a
//     stalled 'running'; naming it as a DISTINCT phase is the honesty the ticket calls for. This phase is
//     a SERVICE fact, not a provider one — the provider's feed has already ended by the time it holds.
//   - `done` — the provider attempt is terminal with no retry pending; the client's poll carries the real
//     ready/failed outcome, so progress steps aside rather than inventing a terminal it does not own.
// Illegal pairings (a validating phase with a detail line, a done phase carrying a provider message) are
// unrepresentable. [LAW:types-are-the-program] [LAW:effects-at-boundaries] [LAW:no-silent-failure]
export type GenerationProgress =
  | { readonly phase: 'generating'; readonly at: number; readonly message: string }
  | { readonly phase: 'validating'; readonly at: number }
  | { readonly phase: 'done'; readonly at: number };

// The TYPED "this provider can't iterate" signal. continue() is only meaningful against a
// provider that implements continueSession; capability IS method presence (registry's
// capabilitiesOf derives it the same way). A one-shot provider asked to continue is a loud,
// typed failure at submit time — not a silent no-op that would leave the caller polling a
// turn that will never exist. Typed (not a bare Error) so the HTTP route can map it to a
// distinct status, the way PlaygroundNotFoundError is the 404 signal.
// [LAW:no-silent-failure] [LAW:types-are-the-program]
export class ProviderCannotContinueError extends Error {
  constructor(public readonly providerId: ProviderId) {
    super(`provider ${providerId} cannot continue a session`);
    this.name = 'ProviderCannotContinueError';
  }
}

// The TYPED "this provider can't fork" signal — the remix sibling of
// ProviderCannotContinueError. fork() is only meaningful against a provider that
// implements fork; capability IS method presence (capabilitiesOf derives it the same way).
// A provider asked to branch a session it can't is a loud, typed failure at fork time, so
// the HTTP route (p0v.15) can map it to a distinct status the way the continue signal does.
// [LAW:no-silent-failure] [LAW:types-are-the-program]
export class ProviderCannotForkError extends Error {
  constructor(public readonly providerId: ProviderId) {
    super(`provider ${providerId} cannot fork a session`);
    this.name = 'ProviderCannotForkError';
  }
}

export interface GenerationServiceDeps {
  readonly registry: ProviderRegistry;
  readonly store: ArtifactStore;
  readonly catalog: Catalog;
  // Dispose a FAILED turn's provider-internal resources, given the reason it failed. Injected, not
  // imported, so the service never names a concrete provider: the composition root supplies the tmux
  // disposer (cleanupTurn, which the Node root composes behind diagnostics preservation — the reason is
  // what that record states, ppu.4); a provider with nothing to release supplies a no-op. Only failed
  // turns are disposed (a successful one's workdir is continuable), so the reason is always meaningful.
  // The service disposes unconditionally — a value varying, not a branch on which provider is in play.
  // [LAW:dataflow-not-control-flow]
  readonly disposeTurn: (handle: SessionHandle, reason: string) => Promise<void>;
  // The per-identity generation budget, consulted at the start of every turn (submit,
  // continue, fork) and released when the turn settles. Injected as a seam so the caps and
  // the clock are a composition-root concern and the service stays pure with respect to
  // both — it only reserves and releases. [LAW:decomposition] [LAW:single-enforcer]
  readonly quota: GenerationQuota;
  // Total provider attempts one request may make, INCLUDING the first (1 = no retry). A failed
  // provider attempt is retried from the same brief until this budget is spent, then the failure is
  // surfaced. Retry lives at THIS one boundary (the owner of turn lifecycle), never sprinkled per
  // caller, so a single policy governs submit, continue, and fork alike. [LAW:single-enforcer]
  //
  // Domain: an integer >= 1. Validated ONCE, at the composition root's parseGenerationPolicy /
  // parseMaxGenerationAttempts seam (the single enforcer, mirroring how QuotaLimits is validated by
  // parseQuotaLimits) — not re-guarded here, so this service trusts a value already proven valid,
  // exactly as makeGenerationQuota trusts its limits. [LAW:single-enforcer] [LAW:one-type-per-behavior]
  readonly maxAttempts: number;
  // The functional-quality gate: does a succeeded attempt's artifact actually RUN, or is it built-but-
  // broken (an uncaught error on load)? Injected, not imported, so the service stays pure with respect to
  // it and the composition root decides how isolated the browser is — the Node root a local headless
  // Chrome, the edge a no-op (generation is disabled there). Consulted once per succeeded attempt, before
  // the artifact is stored. A functional defect is a TYPED rejection routed to the failed-turn path; any
  // other rejection is an infra fault that propagates loudly. [LAW:effects-at-boundaries] [LAW:decomposition]
  readonly validateArtifact: ArtifactValidator;
  // The world's clock, injected so the service stays pure with respect to time — the same boundary the
  // quota reads its clock at. Read once per settle, to stamp when a request became terminal, so the
  // retention sweeper can later reclaim a record whose outcome has been observable long enough. Injected,
  // never Date.now inline, so eviction is deterministic in tests. [LAW:effects-at-boundaries]
  // [LAW:no-ambient-temporal-coupling]
  readonly now: () => number;
}

export interface GenerationService {
  // The providers available to select from, for the front door's dropdown (p0v.5). An
  // empty registry yields an empty list — data flow, not a special case.
  listProviders(): readonly ProviderDescriptor[];

  // Whether a chosen provider can generate right now, for the front door's generation
  // toggle (p0v.5). LIVE — re-checks the provider on every call (the tmux provider shells
  // out to confirm its binaries), so the toggle reflects real machine state each read, not
  // a cached snapshot. `unavailable` carries the reason to render. Sits beside
  // listProviders because both are the front door reading the registry through the one
  // surface it depends on. [LAW:single-enforcer]
  availabilityOf(providerId: ProviderId): Promise<Availability>;

  // Submit a brief against a chosen provider; resolves once the turn EXISTS, not once it
  // is done. The returned handle is what the caller polls. `requester` is the authenticated
  // principal the gated write path resolved — it is this generation's quota subject AND,
  // because a submit creates a playground, the new playground's recorded author (the create
  // write is the one place this identity is persisted).
  submit(request: GenerationRequest, requester: Subject): Promise<SessionHandle>;

  // Refine an existing playground: send a follow-up brief into its session, producing a
  // successive version. Symmetric with submit — it registers a turn and returns the handle
  // to poll; the difference is purely the turn's TARGET (append onto this playground, not
  // create a new one), carried as a value so the one finalize path serves both. `requester` is
  // the authenticated principal driving this turn — used ONLY as its quota subject, never as an
  // author (an append extends a playground that already has its author). An unknown id fails
  // loudly (PlaygroundNotFoundError); a provider that can't iterate fails loudly
  // (ProviderCannotContinueError). [LAW:dataflow-not-control-flow] [LAW:no-silent-failure]
  continue(playgroundId: PlaygroundId, brief: Brief, requester: Subject): Promise<SessionHandle>;

  // Fork an existing playground: branch its CURRENT artifact into a NEW independent
  // session, producing a fresh playground whose lineage points back at the parent. Like
  // submit it registers a first turn that CREATES a playground (not appends a version) and
  // returns the handle to poll; like continue it resolves the parent and reads its current
  // artifact as the seed. The two differences from submit are both values, not branches: the
  // turn's create target carries fork lineage, and fork carries no user brief, so the new
  // playground's first-turn prompt is the parent's original describe. `requester` is the
  // authenticated principal performing the fork — this turn's quota subject AND, because a fork
  // creates a playground, its recorded author (a remix is "by the remixer"; the parent keeps its
  // own author). An unknown id fails loudly (PlaygroundNotFoundError); a provider that can't fork
  // fails loudly (ProviderCannotForkError). [LAW:dataflow-not-control-flow] [LAW:no-silent-failure]
  fork(playgroundId: PlaygroundId, requester: Subject): Promise<SessionHandle>;

  // The point-in-time status of a turn. On the first observation of a succeeded provider
  // status it performs the one effectful transition (store the file, record the version on
  // its target playground) exactly once and thereafter reports `ready`; on failure it
  // surfaces the message, writes nothing, and releases the turn. [LAW:no-silent-failure]
  poll(handle: SessionHandle): Promise<GenerationStatus>;

  // The read-only progress snapshot of a turn — the enrichment poll() cannot give during a long
  // generation. It reports the LIVE attempt (record.current) read FRESH on every call, so across a retry
  // attempt-swap it reflects the new attempt with no special handling: re-reading `current` each call IS
  // the retry honesty the ticket requires. It performs NO write and never drives the terminal transition,
  // so a client may watch it freely without moving the turn — the single write-gate stays poll's alone. An
  // unknown or evicted turn fails loudly, exactly as poll does. [LAW:effects-at-boundaries] [LAW:no-silent-failure]
  progress(handle: SessionHandle): Promise<GenerationProgress>;

  // The retention seam that bounds the in-memory turns map — the maintenance half of the map's own
  // lifecycle, not a client surface. A record is reclaimed ONLY once it has settled (terminal outcome
  // sealed) AND that outcome has been observable through the retention window; an in-flight request
  // (settledAtMs still null) is never touched, so a live turn's memoized transition always stays
  // reachable. `settledBeforeMs` is the cutoff: every request that settled at or before it is removed,
  // and the count is returned. The service owns the map, so this is the ONE seam its records are
  // reclaimed through; a composition-root sweeper drives it on an interval with the clock read at its
  // own edge, never an ambient timer here. [LAW:no-shared-mutable-globals] [LAW:no-ambient-temporal-coupling]
  evictSettledTurns(settledBeforeMs: number): number;
}

// Where a turn's successful artifact lands in the catalog, carried as a VALUE on the
// turn so the one finalize path dispatches on it rather than branching on which kind of
// turn produced it. A first turn creates a playground; a follow-up appends a version to a
// named one. submit and fork are BOTH 'create' turns differing only by their lineage value
// (submit null, fork the parent reference) — not two kinds — so the one createPlayground
// write serves both and a failed fork inherits create's failure-disposal for free.
// [LAW:dataflow-not-control-flow] [LAW:one-type-per-behavior]
// The author rides on the 'create' member ONLY: a create write records who authored the new
// playground (submit's submitter, fork's forker), while an append extends a playground that
// already has its author — so "an append carries an author" and "a create lacks one" are both
// unrepresentable, and continue never threads an identity it would only discard. The author is
// a value on the create target, dispatched at persist time, not a branch on which turn produced
// it. [LAW:types-are-the-program] [LAW:dataflow-not-control-flow]
type TurnTarget =
  | { readonly kind: 'create'; readonly lineage: Lineage | null; readonly author: Subject }
  | { readonly kind: 'append'; readonly playgroundId: PlaygroundId };

// Per-REQUEST state the service owns. One record per client request, which may span several
// provider attempts under retry: the brief the request carried (the catalog needs the prompt at
// persist time and the handle does not carry it), where its result will be recorded, the held
// quota slot, and — the retry machinery — how to start another attempt, which attempt is live,
// how many remain, and the two single-flight guards. [LAW:one-source-of-truth]
interface TurnRecord {
  readonly brief: Brief;
  readonly target: TurnTarget;
  // The quota slot this REQUEST holds — for its whole life, across every attempt. Freed exactly
  // once, when the request settles (see settle), NOT per attempt: a retry is the same request
  // still in flight, so it must not re-reserve or release early. [LAW:one-source-of-truth]
  readonly reservation: Reservation;
  // How to start a fresh attempt: submit re-runs startSession(brief), continue re-runs
  // continueSession(prior, brief, seed), fork re-runs fork(parent, seed). The kind-specific
  // provider effect captured ONCE as a value, so retry re-invokes it without ever branching on
  // which kind of request this is. [LAW:dataflow-not-control-flow]
  readonly restart: () => Promise<SessionHandle>;
  // The live attempt's provider handle. The client's ORIGINAL handle is this record's stable key
  // (it is the poll id the client holds and never changes); `current` is the session poll/persist
  // act on. They diverge only after a retry — the client keeps polling its stable handle while the
  // underlying attempt is swapped beneath it. [LAW:one-source-of-truth]
  current: SessionHandle;
  // Attempts remaining AFTER the current one. 0 means the current attempt is the last; a failure
  // then settles the request rather than retrying.
  attemptsLeft: number;
  // Non-null while a retry is being launched (the failed attempt reclaimed, the next one starting).
  // A poll that observes it reports `running` rather than starting a SECOND retry — the single-flight
  // guard for the launch window, before `current` advances. [LAW:no-ambient-temporal-coupling]
  retryInFlight: Promise<void> | null;
  // Null until the first poll observes a TERMINAL outcome (success, or failure with no attempts
  // left); then it holds the single settled transition. Memoizing it (not a boolean) is what makes
  // the store+catalog write fire exactly once under concurrent polls. [LAW:no-ambient-temporal-coupling]
  terminal: Promise<GenerationStatus> | null;
  // The instant this request settled (the clock reading taken in settle), or null while still in flight.
  // It is the eviction-eligibility value the retention sweeper reads: null is never reclaimable (the
  // request is live and its memoized terminal must stay reachable); a timestamp marks a sealed outcome
  // that becomes reclaimable once the retention window past it elapses. Set in the SAME place terminal is
  // memoized, so "settled" and "when it settled" cannot drift. [LAW:one-source-of-truth]
  settledAtMs: number | null;
}

export const makeGenerationService = (deps: GenerationServiceDeps): GenerationService => {
  const { registry, store, catalog, disposeTurn, quota, maxAttempts, validateArtifact, now } = deps;

  // The single owner of in-flight turn state. In-memory, so turns in flight do not survive a process
  // restart while completed playgrounds do (the catalog is durable) — a local steel-thread limitation.
  // Bounded by retention: a settled record is retained only long enough for its outcome to be observed,
  // then reclaimed through evictSettledTurns, so the map does not grow without limit on a long-running
  // server. [LAW:no-shared-mutable-globals]
  const turns = new Map<SessionHandle['turnId'], TurnRecord>();

  const recordOf = (handle: SessionHandle): TurnRecord => {
    const record = turns.get(handle.turnId);
    // A handle for a turn this service never started is invalid input from the trust
    // boundary, not a state to silently skip — fail loudly. [LAW:no-silent-failure]
    if (record === undefined) throw new Error(`unknown turn: ${handle.turnId}`);
    return record;
  };

  // Release a settled turn's provider resources. Best-effort by contract: it runs only
  // AFTER the turn's outcome is sealed (a durable playground, or a surfaced failure), so a
  // disposal fault cannot unmake that outcome. The fault is surfaced loudly to stderr —
  // never swallowed — but it never rejects the caller's promise, because rejecting would
  // misreport a live playground as failed and, since the outcome is memoized, wedge the
  // turn behind that lie forever. Outcome integrity has one enforcer: this service, which
  // owns the outcome, not each disposer. [FRAMING:representation] [LAW:no-silent-failure]
  // [LAW:single-enforcer] [LAW:decomposition]
  const release = async (handle: SessionHandle, reason: string): Promise<void> => {
    try {
      await disposeTurn(handle, reason);
    } catch (error) {
      console.error(`tinkerpad: failed to release turn ${handle.turnId}:`, error);
    }
  };

  // Start a provider turn under a held reservation. The reservation is taken BEFORE this — after
  // the cheap validations, so an unknown/unforkable target never burns quota — and freed HERE iff
  // the provider never produces a turn to poll: a startSession/continueSession/fork that rejects
  // leaves no TurnRecord and so would never reach settle, so its concurrent slot must be returned
  // right here or leak forever. On success the reservation rides on the TurnRecord to settle. This
  // is the one place a reservation's fate is tied to whether a turn came to exist.
  // [LAW:no-silent-failure] [LAW:decomposition]
  const startTurn = async (
    reservation: Reservation,
    start: () => Promise<SessionHandle>,
  ): Promise<SessionHandle> => {
    try {
      return await start();
    } catch (error) {
      reservation.release();
      throw error;
    }
  };

  // Record a stored version against its target. The create-vs-append choice is the turn's
  // target value, matched exhaustively here — the single seam between submit and continue
  // at persist time. appendTurn rejects a handle whose session doesn't match the target
  // playground, but the continue path reconstructs the prior handle from that same session,
  // so the check passes by construction. [LAW:dataflow-not-control-flow]
  const persist = (
    target: TurnTarget,
    handle: SessionHandle,
    prompt: string,
    version: VersionId,
  ): Promise<Playground> => {
    switch (target.kind) {
      case 'create':
        // The post-generation extraction step: classify the describe prompt into topic tags and
        // hand them to the catalog as a value. Only a create tags — an append extends a playground
        // that already carries its tags, exactly as it already carries its author, so refining never
        // re-tags. The producer lives here, at the generation boundary, not in the catalog.
        // [LAW:decomposition] [LAW:one-source-of-truth]
        return catalog.createPlayground({
          handle,
          prompt,
          version,
          lineage: target.lineage,
          author: target.author,
          tags: deriveTags(prompt),
        });
      case 'append':
        return catalog.appendTurn(target.playgroundId, { handle, prompt, version });
      default: {
        const unreachable: never = target;
        return unreachable;
      }
    }
  };

  // The one effectful transition. Order is load-bearing: store first (the catalog
  // references the version it returns), then catalog — the outcome is SEALED once persist
  // returns. A failure of store/catalog rejects this promise and is surfaced loudly;
  // nothing half-written is reported as success. [LAW:no-ambient-temporal-coupling]
  //
  // A successful turn is NOT released here: its workdir is the warm cache a follow-up
  // (continue) re-enters to resume with full conversation context, so disposing it the
  // instant a turn settles would throw that context away on every refine. Idle caches are
  // instead reclaimed out-of-band by the workdir janitor (provider layer), and eviction is
  // safe because continue re-seeds a missing workdir from the durable store — so the cache
  // is an optimization, never the source of truth. Only a failed FIRST turn — which leaves
  // no continuable session — is released eagerly; a failed refine keeps the session, since
  // its prior version is still continuable (see reclaimOnFailure). [LAW:no-ambient-temporal-coupling]
  // [LAW:one-source-of-truth]
  const finalizeSuccess = async (
    handle: SessionHandle,
    brief: Brief,
    target: TurnTarget,
    artifact: Artifact,
  ): Promise<GenerationStatus> => {
    // BEFORE storing anything: does the artifact actually RUN? A provider can succeed and produce a
    // self-contained file that still throws an uncaught error on load — a built-but-broken generation
    // (wave-1 shipped 2 of 24). Route a functional defect through the SAME failed-turn path a provider
    // failure and a self-containment refusal take — actionable message, workdir reclaimed per target,
    // TERMINAL (never retried: retry is a provider-'failed' concern, and a deterministic broken artifact
    // would only reproduce). Only the TYPED FunctionalDefectError is a generation failure; any other
    // rejection is an infra fault (the validator's browser could not launch) that MUST propagate loudly,
    // never relabelled as a quality failure — the type is the discriminator, exactly as with
    // SelfContainmentError below. Running before store.put means a broken artifact never enters storage.
    // [LAW:effects-at-boundaries] [LAW:no-silent-failure] [LAW:types-are-the-program]
    try {
      await validateArtifact(artifact);
    } catch (error) {
      if (error instanceof FunctionalDefectError) {
        return finalizeFailure(handle, target, error.message);
      }
      throw error;
    }
    let version: VersionId;
    try {
      version = await store.put(artifact);
    } catch (error) {
      // A self-containment refusal means the provider SUCCEEDED but produced a file that breaks the
      // artifact contract (an external <script>, an @import, an absurd size). That is a FAILED
      // generation, not an infra fault: route it through the SAME failed-turn path as a provider
      // failure — actionable message, workdir reclaimed per target, retry-able — never a 500. Only the
      // TYPED violation is a generation failure; any other store error (disk, catalog infra) is a real
      // fault and MUST propagate loudly, never be relabelled as a quality failure. The type is the
      // discriminator. [LAW:types-are-the-program] [LAW:no-silent-failure]
      if (error instanceof SelfContainmentError) {
        return finalizeFailure(handle, target, error.message);
      }
      throw error;
    }
    const playground = await persist(target, handle, brief.description, version);
    return { state: 'ready', playgroundId: playground.id };
  };

  // Reclaim a failed turn's workdir ONLY when the turn leaves nothing continuable —
  // decided by its target, matched exhaustively so a new target kind (e.g. the remix
  // epic's fork) MUST declare its failure-disposal here, never silently leak or destroy
  // live state. A failed first turn (create) has no continuable session, so its workdir
  // is reclaimed; a failed refine (append) sits on a still-continuable prior version, so
  // the session is kept exactly as a successful turn's workdir is — releasing it would
  // delete the live state a subsequent refine re-enters. The disposal is the target
  // value, not a branch on which provider ran. [LAW:dataflow-not-control-flow]
  // [LAW:types-are-the-program] [LAW:no-ambient-temporal-coupling]
  const reclaimOnFailure = (handle: SessionHandle, target: TurnTarget, reason: string): Promise<void> => {
    switch (target.kind) {
      case 'create':
        return release(handle, reason);
      case 'append':
        return Promise.resolve();
      default: {
        const unreachable: never = target;
        return unreachable;
      }
    }
  };

  // A failed turn produces no version and no playground — the error is surfaced, never a
  // silent empty file. Its workdir is reclaimed only when nothing continuable remains
  // (reclaimOnFailure). [LAW:no-silent-failure]
  const finalizeFailure = async (
    handle: SessionHandle,
    target: TurnTarget,
    message: string,
  ): Promise<GenerationStatus> => {
    // The surfaced message IS the reason the diagnostics record states, so the on-disk record and what
    // the client is told cannot drift — one source of truth for why the turn failed. [LAW:one-source-of-truth]
    await reclaimOnFailure(handle, target, message);
    return { state: 'failed', error: message };
  };

  // Seal a REQUEST's terminal outcome: memoize the transition AND free its concurrent quota slot.
  // The single seam every terminal path routes through — poll's success and budget-spent-failure
  // branches, and a retry that cannot start — so the slot is released in exactly one place, once.
  // Each caller reaches it only while terminal is null (poll via its double-checked memo guard, a
  // retry via its finally), so release fires exactly once, synchronously, the instant the request is
  // DECIDED terminal, before persist's first await. The daily budget is NOT returned here: a
  // generation that ran counts against the day. [LAW:no-ambient-temporal-coupling] [LAW:single-enforcer]
  const settle = (record: TurnRecord, outcome: Promise<GenerationStatus>): Promise<GenerationStatus> => {
    record.terminal = outcome;
    // Stamp the settle instant in the SAME place the terminal is memoized, so a record can never be
    // terminal without a settle time or vice versa. This is the value the retention sweeper reads to
    // reclaim the record once its outcome has been observable for the full retention window.
    // [LAW:one-source-of-truth]
    record.settledAtMs = now();
    record.reservation.release();
    return outcome;
  };

  // The surfaced reason when a retry could not even START a new attempt — an infra fault (e.g. the
  // provider cannot spawn a session), distinct from a normal attempt failure the provider reported.
  const retryStartFailureMessage = (error: unknown): string =>
    `generation failed and the retry could not start: ${error instanceof Error ? error.message : String(error)}`;

  // Launch a retry as a tracked background transition. Reclaim the failed attempt per its target,
  // then start a fresh attempt from the same restart thunk and swap it in as `current`. The poll
  // that triggers this — and any concurrent poll — reports `running` (guarded by retryInFlight during
  // the launch, then by `current` having advanced) until the new attempt is live, so at most ONE
  // retry starts. A retry that cannot even start a new attempt is an infra fault, not a silent stall:
  // it settles the request failed (releasing its quota), never wedging every future poll on a
  // rejection. The reservation is untouched here — a retry is the same request still in flight, so it
  // keeps its held slot and is released only when the request finally settles.
  // [LAW:no-silent-failure] [LAW:no-ambient-temporal-coupling] [LAW:single-enforcer]
  const beginRetry = (record: TurnRecord, reason: string): void => {
    const launch = (async (): Promise<void> => {
      try {
        // The failed attempt's workdir is reclaimed exactly as a settled failure reclaims it: a
        // create/fork's dead session is released (preserving its diagnostics first, ppu.4 — an
        // intermediate attempt that fails-then-retries must not silently destroy its evidence), an
        // append keeps the still-continuable session its next attempt re-enters. The reason is this
        // attempt's surfaced failure. [LAW:dataflow-not-control-flow]
        await reclaimOnFailure(record.current, record.target, reason);
        record.current = await record.restart();
        record.attemptsLeft -= 1;
      } catch (error) {
        // Could not reclaim the failed attempt or start the next one: seal the request failed and free
        // its budget. The failed attempt is ALREADY reclaimed above (or the reclaim itself is what
        // threw), so this records the terminal failure directly rather than through finalizeFailure —
        // no second reclaim, hence no double-dispose. [LAW:no-silent-failure]
        settle(record, Promise.resolve({ state: 'failed', error: retryStartFailureMessage(error) }));
      } finally {
        // Always clear the single-flight guard, whatever rejected — the whole body is under this
        // finally so no rejection can leave every future poll wedged on `running`. [LAW:no-silent-failure]
        record.retryInFlight = null;
      }
    })();
    record.retryInFlight = launch;
  };

  // Sample the provider's live progress feed for its freshest note — one point-in-time read, NOT a
  // continuous subscription. streamProgress is an open-ended feed built for streaming; the long-poll
  // progress surface wants a single latest value, so this pulls the feed's opening event plus the next
  // one (the current detail line) and closes the iterator immediately, returning whichever is freshest. A
  // feed that yields nothing before ending settles to a neutral note rather than a lie. The iterator is
  // always closed in the finally — this is a sample, so the underlying loop (the tmux driver's pane
  // capture) must stop the instant we have our value, never linger. [LAW:effects-at-boundaries]
  // [LAW:no-ambient-temporal-coupling] [LAW:no-silent-failure]
  const latestProgress = async (provider: Provider, attempt: SessionHandle): Promise<ProgressEvent> => {
    const iterator = provider.streamProgress(attempt)[Symbol.asyncIterator]();
    try {
      let latest: ProgressEvent = { at: now(), message: 'generating…' };
      const opening = await iterator.next();
      if (opening.done !== true) latest = opening.value;
      const next = await iterator.next();
      if (next.done !== true) latest = next.value;
      return latest;
    } finally {
      await iterator.return?.();
    }
  };

  return {
    listProviders(): readonly ProviderDescriptor[] {
      return registry.list();
    },

    async availabilityOf(providerId: ProviderId): Promise<Availability> {
      // Delegate by value: registry.availabilityOf fails loudly on an unknown id (it
      // resolves the provider first), so there is no null to branch on. The provider owns
      // the effect of checking; the service just forwards the selection. `async` so an
      // unknown id surfaces as a rejection, never a synchronous throw — one error channel
      // for a Promise-returning method, matching submit. [LAW:effects-at-boundaries]
      return registry.availabilityOf(providerId);
    },

    async submit(request: GenerationRequest, requester: Subject): Promise<SessionHandle> {
      // Resolve the selection by value: registry.get throws loudly on an unknown id, so
      // there is no null to branch on. [LAW:dataflow-not-control-flow]
      const provider = registry.get(request.providerId);
      // Reserve the identity's budget AFTER resolving the provider (an unknown provider is a
      // client error that must not burn quota) and BEFORE the provider effect — over-cap fails
      // loudly with QuotaExceededError, never a silent queue. [LAW:no-silent-failure]
      const reservation = quota.reserve(requester);
      // The restart thunk IS the retriable attempt: a fresh startSession from the same brief.
      // startTurn runs it for the first attempt (releasing the reservation if no turn comes to
      // exist); retry re-invokes the same thunk. [LAW:dataflow-not-control-flow]
      const restart = (): Promise<SessionHandle> => provider.startSession(request.brief);
      const handle = await startTurn(reservation, restart);
      turns.set(handle.turnId, {
        brief: request.brief,
        target: { kind: 'create', lineage: null, author: requester },
        reservation,
        restart,
        current: handle,
        attemptsLeft: maxAttempts - 1,
        retryInFlight: null,
        terminal: null,
        settledAtMs: null,
      });
      return handle;
    },

    async continue(playgroundId: PlaygroundId, brief: Brief, requester: Subject): Promise<SessionHandle> {
      // Resolve the target playground first: an unknown id fails loudly here with the typed
      // PlaygroundNotFoundError, never a turn that targets nothing. [LAW:no-silent-failure]
      const { session } = await catalog.getPlayground(playgroundId);
      const provider = registry.get(session.providerId);

      // Capability is method presence. A provider that can't iterate fails loudly at submit
      // time — never a silent no-op. The guard narrows continueSession to defined; captured to a
      // local so the narrowing survives into the startTurn closure below. [LAW:no-silent-failure]
      const continueSession = provider.continueSession;
      if (continueSession === undefined) {
        throw new ProviderCannotContinueError(session.providerId);
      }

      // Reconstruct the handle that resumes this session: its newest turn. providerId and
      // sessionId are preserved from the record, so the appended turn belongs to this
      // session by construction (appendTurn enforces that). [LAW:one-source-of-truth]
      const prior: SessionHandle = {
        providerId: session.providerId,
        sessionId: session.sessionId,
        turnId: currentTurnOf(session).turnId,
      };

      // The playground's current artifact, read from the store — the durable source of
      // truth for its bytes — handed to the provider as the seed it continues from. This
      // is the one place store and provider legitimately meet, so the provider never
      // reaches into storage itself: continuability is backed by the durable artifact,
      // not the provider's evictable per-session cache. A continuable playground always
      // has a current version in the store (finalizeSuccess put it there), so this is a
      // total read, not a guard. [LAW:one-source-of-truth] [LAW:effects-at-boundaries]
      const seed = await store.get(currentVersionOf(session));
      // Reserve only once the target is known valid and continuable (the 404/422 above must not
      // burn quota) and before the provider effect. [LAW:no-silent-failure]
      const reservation = quota.reserve(requester);
      // A retriable refine: re-continue from the SAME prior handle + seed. A failed attempt
      // appended nothing, so the playground's current version is unchanged and the seed stays
      // valid across attempts. [LAW:dataflow-not-control-flow] [LAW:one-source-of-truth]
      const restart = (): Promise<SessionHandle> => continueSession(prior, brief, seed);
      const handle = await startTurn(reservation, restart);
      turns.set(handle.turnId, {
        brief,
        target: { kind: 'append', playgroundId },
        reservation,
        restart,
        current: handle,
        attemptsLeft: maxAttempts - 1,
        retryInFlight: null,
        terminal: null,
        settledAtMs: null,
      });
      return handle;
    },

    async fork(playgroundId: PlaygroundId, requester: Subject): Promise<SessionHandle> {
      // Resolve the parent first: an unknown id fails loudly with the typed
      // PlaygroundNotFoundError, never a fork of nothing. [LAW:no-silent-failure]
      const { session } = await catalog.getPlayground(playgroundId);
      const provider = registry.get(session.providerId);

      // Capability is method presence. A provider that can't fork fails loudly here — never
      // a silent no-op. The guard narrows fork to defined; captured to a local so the narrowing
      // survives into the startTurn closure below. [LAW:no-silent-failure]
      const forkSession = provider.fork;
      if (forkSession === undefined) {
        throw new ProviderCannotForkError(session.providerId);
      }

      // The parent's newest turn — the handle whose current artifact we branch from.
      const parent: SessionHandle = {
        providerId: session.providerId,
        sessionId: session.sessionId,
        turnId: currentTurnOf(session).turnId,
      };

      // The parent's CURRENT artifact, read from the store (the durable source of truth for
      // its bytes) and handed to the provider as the seed it branches from — the same seam
      // continue uses, so the provider never reaches into storage. This version IS what
      // lineage records as forkedFromVersion: the seed and the recorded origin are one value,
      // so they cannot drift. [LAW:one-source-of-truth] [LAW:effects-at-boundaries]
      const forkedFromVersion = currentVersionOf(session);
      const seed = await store.get(forkedFromVersion);
      // Reserve only once the parent is known valid and forkable (the 404/422 above must not burn
      // quota) and before the provider effect. [LAW:no-silent-failure]
      const reservation = quota.reserve(requester);
      // A retriable fork: re-branch a NEW independent session from the SAME seed. Each attempt
      // mints its own sessionId; whichever succeeds is the one persisted, carrying the lineage
      // values captured below. [LAW:dataflow-not-control-flow] [LAW:one-source-of-truth]
      const restart = (): Promise<SessionHandle> => forkSession(parent, seed);
      const handle = await startTurn(reservation, restart);

      // fork carries no user brief, so the service owns the new playground's first-turn
      // prompt: the parent's original describe (turns[0], always present — a session enters
      // the catalog only once its first turn produced a version). The fork branches into a
      // NEW playground (kind: 'create') carrying lineage back to the parent — the only thing
      // distinguishing this create from submit's. [LAW:one-source-of-truth]
      const brief: Brief = { description: session.turns[0].prompt };
      const lineage: Lineage = { parentSession: session.sessionId, forkedFromVersion };
      turns.set(handle.turnId, {
        brief,
        target: { kind: 'create', lineage, author: requester },
        reservation,
        restart,
        current: handle,
        attemptsLeft: maxAttempts - 1,
        retryInFlight: null,
        terminal: null,
        settledAtMs: null,
      });
      return handle;
    },

    async poll(handle: SessionHandle): Promise<GenerationStatus> {
      const record = recordOf(handle);
      if (record.terminal !== null) return record.terminal;
      // A retry is mid-launch: report running rather than starting a second one or reading a
      // half-swapped attempt. [LAW:no-ambient-temporal-coupling]
      if (record.retryInFlight !== null) return { state: 'running' };

      // Poll the LIVE attempt, not the client's stable handle — they diverge after a retry, and
      // the live attempt is where the real provider state is. [LAW:one-source-of-truth]
      const attempt = record.current;
      const status: SessionStatus = await registry.get(attempt.providerId).getStatus(attempt);

      // Re-decide synchronously after the await: a concurrent poll may have settled the request or
      // advanced past this attempt via a retry. There is NO await from these guards to the memo/retry
      // assignments below, so the terminal write and the retry launch each fire exactly once even
      // under concurrent polls. [LAW:no-ambient-temporal-coupling]
      if (record.terminal !== null) return record.terminal;
      if (record.retryInFlight !== null) return { state: 'running' };
      // A retry already advanced past the attempt we observed: our status is stale — report running so
      // the client polls the new attempt next. `current` is monotonic across attempts, so identity is
      // a reliable "is this still the live attempt" test. [LAW:no-ambient-temporal-coupling]
      if (record.current !== attempt) return { state: 'running' };

      switch (status.state) {
        case 'pending':
          return { state: 'pending' };
        case 'running':
          return { state: 'running' };
        case 'succeeded':
          return settle(record, finalizeSuccess(attempt, record.brief, record.target, status.result.artifact));
        case 'failed':
          // A failed provider attempt with budget left is retried from the same brief; the failure is
          // surfaced only once the budget is spent. Retry vs settle is decided by the VALUE
          // attemptsLeft, never a branch on why the attempt failed. [LAW:dataflow-not-control-flow]
          if (record.attemptsLeft > 0) {
            beginRetry(record, status.error.message);
            return { state: 'running' };
          }
          return settle(record, finalizeFailure(attempt, record.target, status.error.message));
        default: {
          const unreachable: never = status;
          return unreachable;
        }
      }
    },

    async progress(handle: SessionHandle): Promise<GenerationProgress> {
      const record = recordOf(handle);
      // A retry is mid-launch: the failed attempt reclaimed, the next not yet live. Still generating from
      // the client's view — report continuity across the swap rather than a gap that reads as a stall. This
      // is the launch-window twin of poll's own retryInFlight guard. [LAW:no-ambient-temporal-coupling]
      if (record.retryInFlight !== null) return { phase: 'generating', at: now(), message: 'retrying…' };

      // The LIVE attempt, read fresh — after a retry this is the new attempt, so following the swap is just
      // reading `current`, never a stored stale handle. [LAW:one-source-of-truth]
      const attempt = record.current;
      const provider = registry.get(attempt.providerId);
      let status: SessionStatus;
      try {
        status = await provider.getStatus(attempt);
      } catch (error) {
        // The attempt we read may have been reaped out from under us during the await — either by a retry
        // that reclaimed this failed attempt and swapped in a live successor (the request is still going), or
        // by a settled failure that released its workdir (the request is terminal). A retry swap keeps the
        // turn alive, so report generating; only a genuinely settled turn with no successor is done; anything
        // else is a real fault that must surface. [LAW:no-silent-failure] [LAW:no-ambient-temporal-coupling]
        if (record.retryInFlight !== null || record.current !== attempt) {
          return { phase: 'generating', at: now(), message: 'retrying…' };
        }
        if (record.settledAtMs !== null) return { phase: 'done', at: now() };
        throw error;
      }

      // Re-decide after the await, exactly as poll() re-guards its own post-await window: a concurrent poll
      // may have launched a retry or swapped the live attempt while getStatus was in flight. Without these
      // the failed→done branch below could read a freshly-decremented attemptsLeft and report `done` for a
      // turn that is alive on a new attempt — a stale terminal the client's watcher would stop on. The status
      // we hold describes an attempt that is no longer current, so we do not act on it. [LAW:no-ambient-temporal-coupling]
      if (record.retryInFlight !== null || record.current !== attempt) {
        return { phase: 'generating', at: now(), message: 'retrying…' };
      }

      switch (status.state) {
        case 'pending':
          return { phase: 'generating', at: now(), message: 'starting…' };
        case 'running': {
          // The one place progress samples the provider's live feed: its latest note, the proof the turn is
          // advancing during a multi-minute generation. [LAW:effects-at-boundaries]
          const latest = await latestProgress(provider, attempt);
          return { phase: 'generating', at: latest.at, message: latest.message };
        }
        case 'succeeded':
          // The provider finished; the service is now finalizing — poll() awaits the functional gate inside
          // finalizeSuccess (~10s) before it can report ready. That window is VALIDATING, not a stalled
          // 'running'. Progress only REPORTS the phase; it never runs the gate, so the single write stays
          // poll's. [LAW:single-enforcer]
          return { phase: 'validating', at: now() };
        case 'failed':
          // A failed attempt with retry budget left: a retry will start on the next poll — still generating
          // from the client's view. Budget spent: the request is settling failed; report done and let poll
          // surface the message. Retry-vs-terminal is the VALUE attemptsLeft, never a branch on why the
          // attempt failed. [LAW:dataflow-not-control-flow]
          return record.attemptsLeft > 0
            ? { phase: 'generating', at: now(), message: 'retrying…' }
            : { phase: 'done', at: now() };
        default: {
          const unreachable: never = status;
          return unreachable;
        }
      }
    },

    evictSettledTurns(settledBeforeMs: number): number {
      let evicted = 0;
      // Deleting the current entry mid-iteration is well-defined for a Map, so the sweep is a single
      // pass. Never evict a request still in flight (settledAtMs === null): its memoized terminal must
      // stay reachable for the poll that will observe it. Only a request settled at or before the cutoff
      // is reclaimed — its outcome has had the full retention window to be read. [LAW:no-silent-failure]
      for (const [turnId, record] of turns) {
        if (record.settledAtMs !== null && record.settledAtMs <= settledBeforeMs) {
          turns.delete(turnId);
          evicted += 1;
        }
      }
      return evicted;
    },
  };
};

export interface TurnRetentionSweeperConfig {
  readonly retentionMs?: number;
  readonly sweepIntervalMs?: number;
  // The clock read at the sweep edge to compute the cutoff. Injected for deterministic sweeper tests;
  // the runtime default is the real wall clock. [LAW:effects-at-boundaries]
  readonly now?: () => number;
}

export interface TurnRetentionSweeper {
  stop(): void;
}

// One hour past settle — vastly beyond any client's poll-until-terminal loop, so a client always reads
// its own outcome before the record is reclaimed, while the map stays bounded.
const DEFAULT_TURN_RETENTION_MS = 60 * 60 * 1000;
// Sweep every ten minutes: frequent enough to keep the map bounded on a busy server, rare enough to cost
// nothing.
const DEFAULT_TURN_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

// The retention lifecycle OWNER for the service's in-flight turn map — the agnostic-service sibling of
// the provider's startWorkdirJanitor. A background sweeper evicts settled records once their outcome has
// been observable for retentionMs, and it is the SINGLE explicit owner of that timing: start is this
// call, stop the returned handle, the clock read only at the sweep edge (now() - retentionMs is the
// cutoff handed to the service), never an ambient timer smeared across the code. The timer is unref'd so
// it never keeps the process alive on its own. Started by the runtime entry, never by makeApp, because a
// background timer is a runtime effect and makeApp must stay a pure graph builder. Unlike the workdir
// janitor there is no eager first sweep: the map lives in memory and starts empty on every boot, so there
// are no restart-orphans to clear. [LAW:no-ambient-temporal-coupling] [LAW:effects-at-boundaries]
export const startTurnRetentionSweeper = (
  service: Pick<GenerationService, 'evictSettledTurns'>,
  config: TurnRetentionSweeperConfig = {},
): TurnRetentionSweeper => {
  const retentionMs = config.retentionMs ?? DEFAULT_TURN_RETENTION_MS;
  const sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_TURN_SWEEP_INTERVAL_MS;
  const now = config.now ?? Date.now;

  const sweep = (): void => {
    const evicted = service.evictSettledTurns(now() - retentionMs);
    if (evicted > 0) {
      console.log(`tinkerpad: evicted ${evicted} settled generation turn(s)`);
    }
  };

  const timer = setInterval(sweep, sweepIntervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};
