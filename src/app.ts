import { ProviderRegistry } from './provider/index.js';
import type { SessionHandle } from './provider/index.js';
import { Subject } from './identity/index.js';
import type { ArtifactStore, Catalog, ReportStore } from './storage/index.js';
import {
  makeGenerationService,
  makeHttpHandler,
  makeReportService,
  makeReviewService,
  makeSessionHandler,
  makeSessionResolver,
} from './api/index.js';
import type { ArtifactValidator, CookieSecurity, GenerationQuota, GenerationService, OAuthProvider, ReviewService, SessionStore } from './api/index.js';

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
  // The moderation review+enforcement surface (moderation-5g7.2): the review queue read and the
  // unlist/relist action. The app-origin admin console consumes it behind the isAdminRequest gate.
  readonly reviewService: ReviewService;
  // Whether a request is made by a configured admin — it resolves identity through the SAME resolver
  // the write gate uses, then checks the admin allowlist. The ONE seam "who may moderate" is decided
  // through, consumed by the app-origin admin console to gate the moderation pages. [LAW:single-enforcer]
  readonly isAdminRequest: (request: Request) => Promise<boolean>;
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
  // Dispose a failed turn's provider-internal resources, given why it failed. The Node entry supplies
  // tmux's disposer (cleanupTurn, composed behind diagnostics preservation so the reason is captured to
  // a durable record, ppu.4); the edge, with no provider, supplies a no-op — the service disposes
  // unconditionally, so this is a value varying, not a branch. [LAW:dataflow-not-control-flow]
  readonly disposeTurn: (handle: SessionHandle, reason: string) => Promise<void>;
  // The per-identity generation budget. Built by each entry (its caps from the environment, its
  // clock the real one) and passed in as a value, exactly like the session store — so makeApp
  // stays a pure graph builder and a future durable edge quota swaps here without touching the
  // service that consumes it. [LAW:decomposition] [LAW:effects-at-boundaries]
  readonly quota: GenerationQuota;
  // Total provider attempts one generation request may make, including the first (1 = no retry) — an
  // integer >= 1, validated at the composition root's parseGenerationPolicy seam and trusted here.
  // The GenerationPolicy value, threaded into the service where retry is enforced at the single
  // turn-lifecycle boundary. Stated as a value here, like the quota, so makeApp stays a pure graph
  // builder and the edge/Node roots each choose their own policy. [LAW:decomposition]
  readonly maxAttempts: number;
  // The functional-quality gate — does a succeeded artifact actually run without an uncaught error on
  // load? A seam whose concrete effect is chosen by the entry: the Node root a local headless Chrome, the
  // edge the pass-through (generation is disabled there, so no turn is ever admitted to validate), a test
  // a fake. Passed as a value, like the quota and disposer, so makeApp stays a pure graph builder and the
  // isolated edge render sandbox swaps in here without touching the service. [LAW:decomposition]
  // [LAW:effects-at-boundaries]
  readonly validateArtifact: ArtifactValidator;
  // The world's clock, supplied by the entry as an already-built value exactly like the quota's clock —
  // so makeApp stays clock-free (it forwards this to the service, never reads it). The service stamps a
  // request's settle time from it, which the retention sweeper reads to bound the in-flight turn map.
  // [LAW:effects-at-boundaries] [LAW:decomposition]
  readonly now: () => number;
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
  // The subjects authorized to use the moderation console (moderation-5g7.2). There is no admin ROLE
  // in the identity model yet, so an admin is simply a KNOWN subject; the entry supplies the allowlist
  // (from env at the edge, the dev subject in loopback) so makeApp stays a pure graph builder. Empty
  // is a valid, safe default: with no admins configured the console is reachable by no one, never an
  // accidental open grant. [LAW:decomposition] [LAW:no-silent-failure]
  readonly adminSubjects: ReadonlySet<Subject>;
}

// The one parser for the admin allowlist config — a comma-separated list of subjects (e.g.
// `github:12345,github:67890` at the edge). Both composition roots (Node and edge) read the same env
// var through this, so "how the allowlist string becomes subjects" is defined once and cannot drift
// between deployments. Absent or empty config yields the empty set — no admins, the safe default that
// leaves the console reachable by no one rather than open to all. Whitespace is trimmed and empty
// entries dropped, so a trailing comma or spaced list is not a phantom admin. [LAW:one-source-of-truth]
// [LAW:no-silent-failure]
export const parseAdminSubjects = (raw: string | undefined): ReadonlySet<Subject> =>
  new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => Subject(entry)),
  );

export const makeApp = (deps: AppDeps): App => {
  const {
    registry,
    store,
    catalog,
    reportStore,
    sessionStore,
    disposeTurn,
    quota,
    maxAttempts,
    validateArtifact,
    now,
    oauth,
    oauthCallbackUrl,
    cookieSecurity,
    adminSubjects,
  } = deps;

  const service = makeGenerationService({ registry, store, catalog, disposeTurn, quota, maxAttempts, validateArtifact, now });

  // The moderation report service — reads the catalog to prove a reported playground exists, then
  // records the signal. It shares the catalog with generation (one source of truth for what exists)
  // but persists to its own store. [LAW:decomposition] [LAW:one-source-of-truth]
  const reports = makeReportService({ catalog, reports: reportStore });

  // The moderation review+enforcement service — the sibling half of report intake: it READS the same
  // report store as a review queue and WRITES the catalog's listing to enact takedowns. Scoped to a
  // read-only view of the reports (it cannot forge signal) and the full catalog (moderation owns
  // visibility). [LAW:decomposition] [LAW:single-enforcer]
  const reviewService = makeReviewService({ reports: reportStore, catalog });

  // THE IDENTITY MECHANISM, wired behind the seam. One store owns live sessions; the resolver reads a
  // request's cookie THROUGH that store to a principal (or null), and the same resolver both gates
  // the write path (in the handler) and answers whoami (in the session handler) — one source of truth
  // for "who is this request". The store and the cookie policy are injected, so activating durable
  // edge sessions or HTTPS cookie hardening is a change at the entry; the enforcer (makeHttpHandler)
  // is untouched. [LAW:locality-or-seam] [LAW:one-source-of-truth]
  const resolveIdentity = makeSessionResolver(sessionStore, cookieSecurity);

  // "Who may moderate" decided in ONE place: resolve the request's identity through the same resolver
  // the write gate uses (so the admin surface can never see an identity the gate would reject), then
  // test the configured allowlist. The admin console consumes only this boolean — a signed-out or
  // non-admin request is indistinguishable to it, which is what lets the console stay invisible.
  // [LAW:single-enforcer] [LAW:dataflow-not-control-flow]
  const isAdminRequest = async (request: Request): Promise<boolean> => {
    const identity = await resolveIdentity(request);
    return identity !== null && adminSubjects.has(identity.subject);
  };

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
    reviewService,
    isAdminRequest,
  };
};
