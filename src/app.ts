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
import {
  makeGenerationService,
  makeHttpHandler,
  makeMemorySessionStore,
  makeSessionHandler,
  makeSessionResolver,
} from './api/index.js';
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
  // The session lifecycle surface (login + whoami), composed onto the app origin ahead of the
  // generation API. It owns its own routes and returns null for everything else, so the front
  // door composes it without enumerating auth routes. [LAW:decomposition]
  readonly sessionHandler: (request: Request) => Promise<Response | null>;
}

export interface AppConfig {
  // Where the file artifact store and catalog live.
  readonly dataDir: string;
  // The shared secret a dev login must present to establish a session. Required, not optional:
  // there is no "auth off" mode — without a secret there is no working write path, so the app
  // cannot be constructed without one and the gate is always real. [LAW:types-are-the-program]
  readonly devSecret: string;
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

  // THE IDENTITY MECHANISM, wired behind the seam. One store owns live sessions; the resolver
  // reads a request's cookie THROUGH that store to a principal (or null), and the same resolver
  // both gates the write path (in the handler) and answers whoami (in the session handler) — one
  // source of truth for "who is this request". Swapping the resolver here is the entire activation
  // of real auth: the enforcer (makeHttpHandler) is untouched. [LAW:locality-or-seam] [LAW:one-source-of-truth]
  const sessionStore = makeMemorySessionStore();
  const resolveIdentity = makeSessionResolver(sessionStore);
  return {
    registry,
    service,
    store,
    catalog,
    handler: makeHttpHandler(service, resolveIdentity),
    sessionHandler: makeSessionHandler({ store: sessionStore, resolveIdentity, secret: config.devSecret }),
  };
};
