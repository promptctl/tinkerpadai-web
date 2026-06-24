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
import type { ArtifactStore, Catalog, Playground, PlaygroundId, VersionId } from '../storage/index.js';
import { currentTurnOf, currentVersionOf } from '../storage/index.js';

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
  // is done. The returned handle is what the caller polls.
  submit(request: GenerationRequest): Promise<SessionHandle>;

  // Refine an existing playground: send a follow-up brief into its session, producing a
  // successive version. Symmetric with submit — it registers a turn and returns the handle
  // to poll; the difference is purely the turn's TARGET (append onto this playground, not
  // create a new one), carried as a value so the one finalize path serves both. An unknown
  // id fails loudly (PlaygroundNotFoundError); a provider that can't iterate fails loudly
  // (ProviderCannotContinueError). [LAW:dataflow-not-control-flow] [LAW:no-silent-failure]
  continue(playgroundId: PlaygroundId, brief: Brief): Promise<SessionHandle>;

  // The point-in-time status of a turn. On the first observation of a succeeded provider
  // status it performs the one effectful transition (store the file, record the version on
  // its target playground) exactly once and thereafter reports `ready`; on failure it
  // surfaces the message, writes nothing, and releases the turn. [LAW:no-silent-failure]
  poll(handle: SessionHandle): Promise<GenerationStatus>;
}

// Where a turn's successful artifact lands in the catalog, carried as a VALUE on the
// turn so the one finalize path dispatches on it rather than branching on which kind of
// turn produced it. A first turn creates a playground; a follow-up appends a version to a
// named one. This is the only difference between submit and continue at persist time.
// [LAW:dataflow-not-control-flow]
type TurnTarget =
  | { readonly kind: 'create' }
  | { readonly kind: 'append'; readonly playgroundId: PlaygroundId };

// Per-turn state the service owns: the brief the turn carried (the catalog needs the
// prompt at persist time and the handle does not carry it — so the service is the single
// source of truth for the prompt that drove the turn), where its result will be recorded,
// and the memoized terminal transition. [LAW:one-source-of-truth]
interface TurnRecord {
  readonly brief: Brief;
  readonly target: TurnTarget;
  // Null until the first poll observes a terminal provider status; then it holds the
  // single in-flight/settled persist. Memoizing the transition (not just a boolean) is
  // what makes the effect fire exactly once even under concurrent polls.
  terminal: Promise<GenerationStatus> | null;
}

export const makeGenerationService = (deps: GenerationServiceDeps): GenerationService => {
  const { registry, store, catalog, disposeTurn } = deps;

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
        return catalog.createPlayground({ handle, prompt, version, lineage: null });
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
    const version = await store.put(artifact);
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

    async submit(request: GenerationRequest): Promise<SessionHandle> {
      // Resolve the selection by value: registry.get throws loudly on an unknown id, so
      // there is no null to branch on. [LAW:dataflow-not-control-flow]
      const provider = registry.get(request.providerId);
      const handle = await provider.startSession(request.brief);
      turns.set(handle.turnId, { brief: request.brief, target: { kind: 'create' }, terminal: null });
      return handle;
    },

    async continue(playgroundId: PlaygroundId, brief: Brief): Promise<SessionHandle> {
      // Resolve the target playground first: an unknown id fails loudly here with the typed
      // PlaygroundNotFoundError, never a turn that targets nothing. [LAW:no-silent-failure]
      const { session } = await catalog.getPlayground(playgroundId);
      const provider = registry.get(session.providerId);

      // Capability is method presence. A provider that can't iterate fails loudly at submit
      // time — never a silent no-op. The guard narrows continueSession to defined, and we
      // call it on the provider so it keeps its receiver. [LAW:no-silent-failure]
      if (provider.continueSession === undefined) {
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
      const handle = await provider.continueSession(prior, brief, seed);
      turns.set(handle.turnId, { brief, target: { kind: 'append', playgroundId }, terminal: null });
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
          record.terminal = finalizeSuccess(handle, record.brief, record.target, status.result.artifact);
          return record.terminal;
        case 'failed':
          record.terminal = finalizeFailure(handle, record.target, status.error.message);
          return record.terminal;
        default: {
          const unreachable: never = status;
          return unreachable;
        }
      }
    },
  };
};
