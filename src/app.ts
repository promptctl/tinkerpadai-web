import { join } from 'node:path';
import {
  ProviderRegistry,
  cleanupTurn,
  makeTmuxDriver,
  makeTmuxProvider,
} from './provider/index.js';
import type { TmuxDriverConfig } from './provider/index.js';
import { makeFileArtifactStore, makeFileCatalog } from './storage/index.js';
import type { ArtifactStore, Catalog } from './storage/index.js';
import { makeGenerationService, makeHttpHandler } from './api/index.js';
import type { GenerationService } from './api/index.js';

// THE COMPOSITION ROOT. The one place that knows the concrete shape of the steel
// thread: that the provider is the local tmux/Claude-Code body, that storage is the
// local file backends, and that cleanup is tmux's disposer. Everything it constructs
// sees only the agnostic seams (Provider, ArtifactStore, Catalog) — so changing the
// provider or a backend happens HERE, by changing what is wired, and nothing downstream
// changes. This is where the four shipped seams (p0v.1..p0v.3) compose. [LAW:effects-at-boundaries]

// The assembled system graph. It exposes the persistence seams as well as the generation
// surface because browsing and running (p0v.6) read the catalog and store directly and
// never go through the provider — that read path is a different concern from generation.
// [LAW:decomposition]
export interface App {
  readonly registry: ProviderRegistry;
  readonly service: GenerationService;
  readonly store: ArtifactStore;
  readonly catalog: Catalog;
  readonly handler: (request: Request) => Promise<Response>;
}

export interface AppConfig {
  // Where the file artifact store and catalog live.
  readonly dataDir: string;
  readonly providerId?: string;
  readonly providerLabel?: string;
  readonly driver?: TmuxDriverConfig;
}

export const makeApp = (config: AppConfig): App => {
  const registry = new ProviderRegistry();
  registry.register(
    makeTmuxProvider({
      id: config.providerId ?? 'claude-code-tmux',
      label: config.providerLabel ?? 'Claude Code (local tmux)',
      driver: makeTmuxDriver(config.driver ?? {}),
    }),
  );

  const store = makeFileArtifactStore(join(config.dataDir, 'artifacts'));
  const catalog = makeFileCatalog(join(config.dataDir, 'catalog.json'));

  // cleanupTurn is tmux's per-turn disposer; injecting it here is what keeps the service
  // provider-agnostic — the service releases settled turns without knowing it is tmux.
  // [LAW:dataflow-not-control-flow]
  const service = makeGenerationService({ registry, store, catalog, disposeTurn: cleanupTurn });
  return { registry, service, store, catalog, handler: makeHttpHandler(service) };
};
