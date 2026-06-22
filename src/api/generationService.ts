import type {
  Artifact,
  Brief,
  GenerationRequest,
  ProviderDescriptor,
  ProviderRegistry,
  SessionHandle,
  SessionStatus,
} from '../provider/index.js';
import type { ArtifactStore, Catalog, PlaygroundId } from '../storage/index.js';

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

  // Submit a brief against a chosen provider; resolves once the turn EXISTS, not once it
  // is done. The returned handle is what the caller polls.
  submit(request: GenerationRequest): Promise<SessionHandle>;

  // The point-in-time status of a turn. On the first observation of a succeeded provider
  // status it performs the one effectful transition (store the file, record the
  // playground, release the turn) exactly once and thereafter reports `ready`; on
  // failure it surfaces the message and writes nothing. [LAW:no-silent-failure]
  poll(handle: SessionHandle): Promise<GenerationStatus>;
}

// Per-turn state the service owns: the brief the turn carried (the catalog needs the
// prompt at persist time and the handle does not carry it — so the service is the single
// source of truth for the prompt that drove the turn), and the memoized terminal
// transition. [LAW:one-source-of-truth]
interface TurnRecord {
  readonly brief: Brief;
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

  // The one effectful transition. Order is load-bearing: store first (the catalog
  // references the version it returns), then catalog — the outcome is SEALED once
  // createPlayground returns. A failure of store/catalog rejects this promise and is
  // surfaced loudly; nothing half-written is reported as success. Release runs last and
  // cannot change the sealed outcome. [LAW:no-ambient-temporal-coupling]
  const finalizeSuccess = async (
    handle: SessionHandle,
    brief: Brief,
    artifact: Artifact,
  ): Promise<GenerationStatus> => {
    const version = await store.put(artifact);
    const playground = await catalog.createPlayground({
      handle,
      prompt: brief.description,
      version,
      lineage: null,
    });
    await release(handle);
    return { state: 'ready', playgroundId: playground.id };
  };

  // A failed turn produces no version and no playground — the error is surfaced, never a
  // silent empty file. The turn's provider resources are still released. [LAW:no-silent-failure]
  const finalizeFailure = async (handle: SessionHandle, message: string): Promise<GenerationStatus> => {
    await release(handle);
    return { state: 'failed', error: message };
  };

  return {
    listProviders(): readonly ProviderDescriptor[] {
      return registry.list();
    },

    async submit(request: GenerationRequest): Promise<SessionHandle> {
      // Resolve the selection by value: registry.get throws loudly on an unknown id, so
      // there is no null to branch on. [LAW:dataflow-not-control-flow]
      const provider = registry.get(request.providerId);
      const handle = await provider.startSession(request.brief);
      turns.set(handle.turnId, { brief: request.brief, terminal: null });
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
          record.terminal = finalizeSuccess(handle, record.brief, status.result.artifact);
          return record.terminal;
        case 'failed':
          record.terminal = finalizeFailure(handle, status.error.message);
          return record.terminal;
        default: {
          const unreachable: never = status;
          return unreachable;
        }
      }
    },
  };
};
