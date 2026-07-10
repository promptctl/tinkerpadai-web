import { ProviderRegistry } from './provider/index.js';
import type { SessionHandle } from './provider/index.js';
import type { ArtifactStore, Catalog, ReportStore } from './storage/index.js';
import {
  makeGenerationService,
  makeHttpHandler,
  makeReportService,
  makeSessionHandler,
  makeSessionResolver,
} from './api/index.js';
import type { CookieSecurity, GenerationService, OAuthProvider, SessionStore } from './api/index.js';

// THE COMPOSITION ROOT'S GRAPH BUILDER. It composes the four agnostic seams — provider registry,
// artifact store, catalog, session store — into the running app, and knows NOTHING about which
// concrete backend sits behind any of them. The tmux provider vs none, file storage vs R2, an
// in-memory session map vs D1: those are decided by the entry that BUILDS the deps (src/web/main.ts
// on Node, src/web/worker.ts on Cloudflare) and passed in as values. Changing the deployment target
// changes what is wired at the entry, and NOTHING here — no branch on environment, only different
// adapters. This is exactly the seam the Workers deploy (tinkerpadai-cloudflare-8le) turns on.
// [LAW:effects-at-boundaries] [LAW:dataflow-not-control-flow]

// The assembled system graph. It exposes the persistence seams as well as the generation surface
// because browsing and running read the catalog and store directly and never go through the provider
// — that read path is a different concern from generation. [LAW:decomposition]
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

// The environment-varying parts, all supplied by the entry as already-built values. makeApp is a
// pure graph builder over these — a test constructs it with fakes, the Node entry with file/memory/
// tmux, the Worker entry with R2/D1. Each field is a seam whose concrete backend is the ONE thing
// that differs across deployments; naming them here, once, is what keeps that difference out of
// every downstream part. [LAW:decomposition] [LAW:types-are-the-program]
export interface AppDeps {
  // The provider set for generation. The Node entry registers the local tmux/Claude-Code provider;
  // the first edge deploy registers NONE (generation disabled), which the front door reads as "no
  // generation UI" — a value (empty list), not a mode. [LAW:dataflow-not-control-flow]
  readonly registry: ProviderRegistry;
  // Immutable keyed HTML storage: a local directory on Node, an R2 bucket at the edge.
  readonly store: ArtifactStore;
  // The single source of truth for what playgrounds exist: a JSON file on Node, D1 at the edge.
  readonly catalog: Catalog;
  // Where moderation reports are persisted: a JSON file on Node, D1 at the edge. A separate seam from
  // the catalog because a report is a private moderation signal, not part of the public commons — the
  // same reason the store never crosses into the read path. [LAW:decomposition]
  readonly reportStore: ReportStore;
  // Live sessions and their lifecycle: an in-memory map on Node (dies with the process, which is
  // correct for dev), a durable D1-backed store at the edge (survives Worker cold starts).
  readonly sessionStore: SessionStore;
  // Release a settled turn's provider-internal resources. The Node entry supplies tmux's disposer
  // (cleanupTurn); the edge, with no provider, supplies a no-op — the service disposes
  // unconditionally, so this is a value varying, not a branch. [LAW:dataflow-not-control-flow]
  readonly disposeTurn: (handle: SessionHandle) => Promise<void>;
  // The delegated identity provider behind the login seam (GitHub in production, a loopback in dev,
  // a fake in tests). Required, not optional: there is no "auth off" mode — without a provider there
  // is no working write path, so the app cannot be constructed without one and the gate is always
  // real. The concrete provider and its credentials/HTTP are built by the entry at the true edge, so
  // makeApp stays a pure graph builder a test can construct with a fake. [LAW:types-are-the-program]
  readonly oauth: OAuthProvider;
  // The absolute URL the identity provider redirects back to (this app's /session/callback).
  readonly oauthCallbackUrl: string;
  // The cookie hardening policy (Secure + `__Host-`). The HTTPS edge passes { secure: true }; http
  // loopback dev passes { secure: false }. A value the entry decides by its transport, threaded into
  // both the resolver and the session handler so they share one cookie name. [LAW:one-source-of-truth]
  readonly cookieSecurity: CookieSecurity;
}

export const makeApp = (deps: AppDeps): App => {
  const { registry, store, catalog, reportStore, sessionStore, disposeTurn, oauth, oauthCallbackUrl, cookieSecurity } =
    deps;

  const service = makeGenerationService({ registry, store, catalog, disposeTurn });

  // The moderation report service — reads the catalog to prove a reported playground exists, then
  // records the signal. It shares the catalog with generation (one source of truth for what exists)
  // but persists to its own store. [LAW:decomposition] [LAW:one-source-of-truth]
  const reports = makeReportService({ catalog, reports: reportStore });

  // THE IDENTITY MECHANISM, wired behind the seam. One store owns live sessions; the resolver reads a
  // request's cookie THROUGH that store to a principal (or null), and the same resolver both gates
  // the write path (in the handler) and answers whoami (in the session handler) — one source of truth
  // for "who is this request". The store and the cookie policy are injected, so activating durable
  // edge sessions or HTTPS cookie hardening is a change at the entry; the enforcer (makeHttpHandler)
  // is untouched. [LAW:locality-or-seam] [LAW:one-source-of-truth]
  const resolveIdentity = makeSessionResolver(sessionStore, cookieSecurity);

  return {
    registry,
    service,
    store,
    catalog,
    handler: makeHttpHandler(service, reports, resolveIdentity),
    sessionHandler: makeSessionHandler({
      store: sessionStore,
      resolveIdentity,
      oauth,
      callbackUrl: oauthCallbackUrl,
      security: cookieSecurity,
    }),
  };
};
