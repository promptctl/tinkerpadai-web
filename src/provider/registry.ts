import type { Provider } from './provider.js';
import type { Availability, ProviderCapabilities, ProviderDescriptor, ProviderId } from './types.js';

// Capabilities derived from which optional methods the provider actually
// implements. This is the single source of truth for "what can this provider do";
// there is no hand-maintained boolean that could disagree with the methods.
// [LAW:one-source-of-truth] [LAW:dataflow-not-control-flow]
export const capabilitiesOf = (provider: Provider): ProviderCapabilities => ({
  continue: typeof provider.continueSession === 'function',
  fork: typeof provider.fork === 'function',
});

// The static, sync view of a registered provider, for rendering selection UI.
// Derived from the provider; never stored separately. [LAW:one-source-of-truth]
const describe = (provider: Provider): ProviderDescriptor => ({
  id: provider.id,
  label: provider.label,
  capabilities: capabilitiesOf(provider),
});

// The single owner of the set of providers. 0..N entries, keyed by id. Nothing
// reads or mutates the provider set except through this API — there is no module
// global; the app composes one registry and passes it where it is needed.
// [LAW:no-shared-mutable-globals] [LAW:single-enforcer]
export class ProviderRegistry {
  readonly #providers = new Map<ProviderId, Provider>();

  // Add a provider. A duplicate id is a programming error, not a silent overwrite —
  // two providers answering to one id would make selection ambiguous.
  // [LAW:no-silent-failure]
  register(provider: Provider): void {
    if (this.#providers.has(provider.id)) {
      throw new Error(`provider already registered: ${provider.id}`);
    }
    this.#providers.set(provider.id, provider);
  }

  // Resolve a selection (a value carried by the request) to its provider. An
  // unknown id fails loudly rather than returning a null that callers must guard.
  // [LAW:no-defensive-null-guards] [LAW:no-silent-failure]
  get(id: ProviderId): Provider {
    const provider = this.#providers.get(id);
    if (provider === undefined) {
      throw new Error(`unknown provider: ${id}`);
    }
    return provider;
  }

  has(id: ProviderId): boolean {
    return this.#providers.has(id);
  }

  // The descriptors for rendering the selection dropdown. An empty registry yields
  // an empty list, which the front door reads as "no generation UI" (p0v.5) — that
  // is data flow, not a special case to branch on. [LAW:dataflow-not-control-flow]
  list(): readonly ProviderDescriptor[] {
    return [...this.#providers.values()].map(describe);
  }

  // Live availability of one provider, for the generation toggle (p0v.5). Delegates
  // to the provider because availability is an effect the provider owns.
  // [LAW:effects-at-boundaries]
  availabilityOf(id: ProviderId): Promise<Availability> {
    return this.get(id).getAvailability();
  }

  get size(): number {
    return this.#providers.size;
  }
}
