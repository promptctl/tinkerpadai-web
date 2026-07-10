import type {
  Artifact,
  Availability,
  Brief,
  GenerationRequest,
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
  // Release a settled turn's provider-internal resources once its outcome is durably
  // recorded. Injected, not imported, so the service never names a concrete provider:
  // the composition root supplies the tmux disposer (cleanupTurn); a provider with
  // nothing to release supplies a no-op. The service disposes unconditionally — a value
  // varying, not a branch on which provider is in play. [LAW:dataflow-not-control-flow]
  readonly disposeTurn: (handle: SessionHandle) => Promise<void>;
  // The per-identity generation budget, consulted at the start of every turn (submit,
  // continue, fork) and released when the turn settles. Injected as a seam so the caps and
  // the clock are a composition-root concern and the service stays pure with respect to
  // both — it only reserves and releases. [LAW:decomposition] [LAW:single-enforcer]
  readonly quota: GenerationQuota;
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

// Per-turn state the service owns: the brief the turn carried (the catalog needs the
// prompt at persist time and the handle does not carry it — so the service is the single
// source of truth for the prompt that drove the turn), where its result will be recorded,
// and the memoized terminal transition. [LAW:one-source-of-truth]
interface TurnRecord {
  readonly brief: Brief;
  readonly target: TurnTarget;
  // The quota slot this turn holds. Freed exactly once, when the turn settles (see settle) —
  // tying the concurrent-budget release to the same terminal transition the store+catalog write
  // rides, so the two cannot disagree about whether the turn is still in flight. [LAW:one-source-of-truth]
  readonly reservation: Reservation;
  // Null until the first poll observes a terminal provider status; then it holds the
  // single in-flight/settled persist. Memoizing the transition (not just a boolean) is
  // what makes the effect fire exactly once even under concurrent polls.
  terminal: Promise<GenerationStatus> | null;
}

export const makeGenerationService = (deps: GenerationServiceDeps): GenerationService => {
  const { registry, store, catalog, disposeTurn, quota } = deps;

  // The single owner of in-flight turn state. In-memory and not evicted: a local
  // steel-thread limitation — turns in flight do not survive a process restart, while
  // completed playgrounds do (the catalog is durable). [LAW:no-shared-mutable-globals]
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
  const release = async (handle: SessionHandle): Promise<void> => {
    try {
      await disposeTurn(handle);
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
  const reclaimOnFailure = (handle: SessionHandle, target: TurnTarget): Promise<void> => {
    switch (target.kind) {
      case 'create':
        return release(handle);
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
    await reclaimOnFailure(handle, target);
    return { state: 'failed', error: message };
  };

  // Seal a turn's terminal outcome: memoize the transition AND free its concurrent quota slot.
  // The single seam both terminal branches of poll route through, so the slot is released in
  // exactly one place. It runs only from that switch, which the double-checked memo guard reaches
  // only while terminal is null — so release fires exactly once, synchronously, the instant the
  // turn is DECIDED terminal (the provider is done), before persist's first await. The daily
  // budget is NOT returned here: a generation that ran counts against the day.
  // [LAW:no-ambient-temporal-coupling] [LAW:single-enforcer]
  const settle = (record: TurnRecord, outcome: Promise<GenerationStatus>): Promise<GenerationStatus> => {
    record.terminal = outcome;
    record.reservation.release();
    return outcome;
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
      const handle = await startTurn(reservation, () => provider.startSession(request.brief));
      turns.set(handle.turnId, {
        brief: request.brief,
        target: { kind: 'create', lineage: null, author: requester },
        reservation,
        terminal: null,
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
      const handle = await startTurn(reservation, () => continueSession(prior, brief, seed));
      turns.set(handle.turnId, { brief, target: { kind: 'append', playgroundId }, reservation, terminal: null });
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
      const handle = await startTurn(reservation, () => forkSession(parent, seed));

      // fork carries no user brief, so the service owns the new playground's first-turn
      // prompt: the parent's original describe (turns[0], always present — a session enters
      // the catalog only once its first turn produced a version). The fork branches into a
      // NEW playground (kind: 'create') carrying lineage back to the parent — the only thing
      // distinguishing this create from submit's. [LAW:one-source-of-truth]
      const brief: Brief = { description: session.turns[0].prompt };
      const lineage: Lineage = { parentSession: session.sessionId, forkedFromVersion };
      turns.set(handle.turnId, { brief, target: { kind: 'create', lineage, author: requester }, reservation, terminal: null });
      return handle;
    },

    async poll(handle: SessionHandle): Promise<GenerationStatus> {
      const record = recordOf(handle);
      if (record.terminal !== null) return record.terminal;

      const status: SessionStatus = await registry.get(handle.providerId).getStatus(handle);

      // Synchronous decision point: there is NO await from the re-check below to the memo
      // assignment, so under JS's single-threaded model a terminal transition is started
      // exactly once even when many polls observe the same succeeded/failed status
      // concurrently. The first poll to resume sets `record.terminal`; the rest read it.
      // [LAW:no-ambient-temporal-coupling]
      if (record.terminal !== null) return record.terminal;
      switch (status.state) {
        case 'pending':
          return { state: 'pending' };
        case 'running':
          return { state: 'running' };
        case 'succeeded':
          return settle(record, finalizeSuccess(handle, record.brief, record.target, status.result.artifact));
        case 'failed':
          return settle(record, finalizeFailure(handle, record.target, status.error.message));
        default: {
          const unreachable: never = status;
          return unreachable;
        }
      }
    },
  };
};
