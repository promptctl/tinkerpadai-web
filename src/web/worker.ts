import type { D1Database, KVNamespace, MessageBatch, Queue, R2Bucket, ScheduledController } from '@cloudflare/workers-types';
import type { BrowserWorker } from '@cloudflare/puppeteer';
import page from './index.html';
import { makeApp, parseAdminSubjects } from '../app.js';
import { ProviderRegistry } from '../provider/index.js';
import { makeGenerationQuota, makeGitHubOAuthProvider, parseMaxGenerationAttempts, parseQuotaLimits, passThroughValidator } from '../api/index.js';
import type { RenderJob, RenderPipelineDeps } from '../api/index.js';
import { runBackfill, runRenderBatch } from '../api/index.js';
import { makeBrowserRenderer } from '../api/browserRenderer.js';
import { makeD1SessionStore } from '../api/d1SessionStore.js';
import { makeR2ArtifactStore } from '../storage/r2ArtifactStore.js';
import { makeR2ThumbnailStore } from '../storage/r2ThumbnailStore.js';
import { makeKvRenderStatusStore } from '../storage/kvRenderStatusStore.js';
import { makeD1Catalog } from '../storage/d1Catalog.js';
import { makeD1ReportStore } from '../storage/d1ReportStore.js';
import { makeFrontDoorRouter } from './frontDoorRouter.js';
import { playgroundContentUrl } from './contentUrl.js';
import { appOriginOf, assertDistinctOriginHosts } from './originGuard.js';

// The type of the assembled request handler, memoized per isolate below.
type Handler = (request: Request) => Promise<Response>;

// THE CLOUDFLARE WORKER ENTRY — the edge composition root, sibling to the Node entry (nodeApp.ts).
// It is the only edge-specific effectful top of the steel thread: it reads the environment (bindings
// and secrets), builds the SAME app graph makeApp assembles everywhere — swapping in R2 for the
// artifact store and D1 for the catalog and sessions — and hands each request to the pure two-origin
// router. There is NO branch on "are we on Cloudflare"; the difference between here and Node is
// entirely which adapters are wired. The app and the raw playground content stay on SEPARATE hosts
// (the router splits them), the sandbox boundary the deploy must preserve. [LAW:effects-at-boundaries]
// [LAW:dataflow-not-control-flow] [LAW:single-enforcer]

// The Worker's bindings and secrets. Bindings (R2/D1) are provisioned in wrangler.toml; the secrets
// and vars are set with `wrangler secret put` / the [vars] table. Optional-typed because the runtime
// hands them as possibly-absent; each is validated loudly below before use. [LAW:types-are-the-program]
export interface Env {
  // The R2 bucket holding immutable playground html, one object per version.
  readonly ARTIFACTS: R2Bucket;
  // The D1 database backing BOTH the catalog (single-row document) and live sessions (one table).
  readonly DB: D1Database;
  // THE RENDER PIPELINE'S BINDINGS (render-dax.3) — the async derivation of preview thumbnails. They are
  // consumed ONLY by the queue/scheduled handlers below, never by fetch: a request is served without ever
  // touching the renderer. [LAW:decomposition]
  //   BROWSER: the Cloudflare Browser Rendering binding — the isolated headless-Chrome sandbox the driver
  //     loads untrusted playground html in (a sibling to the player iframe, never this trusted isolate).
  readonly BROWSER: BrowserWorker;
  //   THUMBNAILS: the R2 bucket of derived PNG previews, DISTINCT from ARTIFACTS so the evictable cache is
  //     kept physically apart from the immutable source of truth. [LAW:one-source-of-truth]
  readonly THUMBNAILS: R2Bucket;
  //   RENDER_STATUS: the KV namespace of per-version render status (pending/failed) — operational state of
  //     the derivation, owned by the pipeline, never the catalog. [LAW:one-source-of-truth]
  readonly RENDER_STATUS: KVNamespace;
  //   RENDER_QUEUE: the Cloudflare Queue of render jobs. The scheduled backfill PRODUCES onto it; the queue
  //     handler CONSUMES from it, one browser per batch. [LAW:no-ambient-temporal-coupling]
  readonly RENDER_QUEUE: Queue<RenderJob>;
  // The GitHub OAuth app credentials. Secrets, never committed — set with `wrangler secret put`.
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  // The registered GitHub Authorization callback URL. Pinned as config because request.url behind
  // the CDN is NOT the public origin, so it cannot be derived per request. [LAW:one-source-of-truth]
  readonly TINKERPAD_OAUTH_CALLBACK_URL?: string;
  // The SEPARATE content origin's public base URL (a distinct host from the app). Load-bearing: the
  // router serves raw playground html only on this host, and the player frames it from here.
  readonly TINKERPAD_CONTENT_ORIGIN?: string;
  // The moderation admin allowlist (moderation-5g7.2): a comma-separated list of subjects (github:<id>)
  // authorized for the review console. OPTIONAL, unlike the credentials above — its absence is a safe
  // default (no admins → console reachable by no one), not a boot failure, so it is read directly
  // rather than through `required`. Set it in the [vars] table of wrangler.toml. [LAW:no-silent-failure]
  readonly TINKERPAD_ADMIN_SUBJECTS?: string;
  // The per-identity generation caps, OPTIONAL [vars] entries. Absent falls back to the documented
  // defaults; a set-but-invalid value fails the isolate's first request loudly. They enforce once
  // public generation turns on (providers-u1h) — the first edge deploy registers no provider, so no
  // turn is ever admitted and these are inert until then. Set them in the [vars] table of wrangler.toml.
  readonly TINKERPAD_MAX_CONCURRENT_GENERATIONS?: string;
  readonly TINKERPAD_MAX_DAILY_GENERATIONS?: string;
  // The retry budget, an OPTIONAL [vars] entry read through the same parseMaxGenerationAttempts seam
  // the Node roots use. Inert while the registry is empty (like the quota caps above), but parsed here
  // because it IS wired into makeApp — validated so it cannot drift once public generation turns on
  // (providers-u1h). The per-attempt DEADLINE (TINKERPAD_GENERATION_TIMEOUT_MS) is deliberately absent:
  // the edge has no driver to enforce it, so validating a value with no consumer here — and bricking
  // the whole Worker on an invalid inert deadline — would be disproportionate. It arrives with the edge
  // driver. [LAW:decomposition]
  readonly TINKERPAD_MAX_GENERATION_ATTEMPTS?: string;
}

// A real user's session at the edge, durably in D1 so it survives Worker cold starts. 7 days — long
// enough to stay signed in across visits, bounded so a session cannot live forever. The store owns
// the deadline; this composition root states the policy. [LAW:no-ambient-temporal-coupling]
const EDGE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The env keys that carry a required STRING (secrets + config), distinct from the object bindings
// (ARTIFACTS, DB). `required` accepts only these, so `required(env, 'ARTIFACTS')` is a COMPILE error
// rather than a call that type-checks but always throws (an R2Bucket is never a string). The type
// makes the invalid call unrepresentable. [LAW:types-are-the-program]
type RequiredEnvKey =
  | 'GITHUB_CLIENT_ID'
  | 'GITHUB_CLIENT_SECRET'
  | 'TINKERPAD_OAUTH_CALLBACK_URL'
  | 'TINKERPAD_CONTENT_ORIGIN';

// The keys that are SECRETS — credentials that must be set with `wrangler secret put` and must NEVER
// land in the committed wrangler.toml [vars]. The remediation text below is chosen from this set so an
// operator is steered to the safe mechanism per key, not told both work for all four (which would
// invite committing a GitHub secret). [LAW:no-silent-failure]
const SECRET_KEYS: ReadonlySet<RequiredEnvKey> = new Set(['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']);

// Read a required secret/var, failing LOUDLY and by name when absent — never a silent fallback to an
// open gate or a wrong origin. `|| undefined` so an empty string is treated as unset. The GitHub
// credentials CANNOT be minted, so their absence is a hard failure, exactly as the Node entry
// enforces. The remediation is key-specific: a secret is steered to `wrangler secret put` with an
// explicit warning against [vars]; a non-secret var to [vars]. [LAW:no-silent-failure]
const required = (env: Env, name: RequiredEnvKey): string => {
  const value = env[name] || undefined;
  if (typeof value !== 'string') {
    const how = SECRET_KEYS.has(name)
      ? `Set it with \`wrangler secret put ${name}\` — it is a SECRET; never put it in the [vars] table (that would commit it to the repo).`
      : `Set it in the [vars] table of wrangler.toml.`;
    throw new Error(`${name} is required for the Cloudflare deploy. ${how}`);
  }
  return value;
};

// The request handler, built ONCE per isolate and reused — memoized on the `env` it was built from.
// An isolate's `env` is fixed for its whole life, and the app is a pure function of `env` (the R2/D1
// adapters are stateless wrappers over stable bindings; the router's parsed content host and handler
// closures derive only from config). So the graph is constructed on the first request and reused,
// spending the per-request budget on I/O rather than rebuilding stateless wrappers each fetch. The
// cache is KEYED on `env` identity, so the signature stays honest — the handler is a value derived
// from `env`, not an ignored parameter — and a different `env` (never happens in a stable isolate,
// but the type permits it) rebuilds rather than returning a stale handler. One module-owned cell,
// one accessor, documented invariant. [LAW:no-shared-mutable-globals] [LAW:dataflow-not-control-flow]
// [LAW:no-ambient-temporal-coupling]
let cached: { readonly env: Env; readonly handler: Handler } | undefined;

const handlerFor = (env: Env): Handler => {
  if (cached !== undefined && cached.env === env) return cached.handler;

  const clientId = required(env, 'GITHUB_CLIENT_ID');
  const clientSecret = required(env, 'GITHUB_CLIENT_SECRET');
  const oauthCallbackUrl = required(env, 'TINKERPAD_OAUTH_CALLBACK_URL');
  const contentOrigin = required(env, 'TINKERPAD_CONTENT_ORIGIN');

  // The load-bearing sandbox invariant: the content origin must be a DIFFERENT hostname from the app.
  // These are two independent env values (TINKERPAD_CONTENT_ORIGIN and the app-origin callback URL),
  // so a misconfiguration can set them to the same hostname — collapsing the two-origin split enforced
  // below into a same-origin serve of untrusted HTML. Reject it here, as the config is validated,
  // before a single request is served rather than as a silent runtime collapse. The app origin is the
  // OAuth callback's hostname: the callback is registered on the app origin by construction (the login
  // CSRF cookie must be present on it), so it is the app's public hostname the content origin must not
  // share. [LAW:no-silent-failure] [LAW:single-enforcer]
  assertDistinctOriginHosts(oauthCallbackUrl, contentOrigin);

  const app = makeApp({
    // Generation is disabled at the first public deploy — an empty registry the front door reads as
    // "no generation UI". Public generation turns on later with the credits ledger + API driver
    // (tinkerpadai-providers-u1h). [LAW:dataflow-not-control-flow]
    registry: new ProviderRegistry(),
    store: makeR2ArtifactStore(env.ARTIFACTS),
    catalog: makeD1Catalog(env.DB),
    // The derived preview cache the async render pipeline populates (render-dax), read by the content
    // handler's /thumb route. The SAME R2 bucket binding the queue/backfill write to (renderContextFor
    // builds its own view of it for the pipeline), so the surface reads exactly the bytes the pipeline
    // rendered. [LAW:one-source-of-truth]
    thumbnails: makeR2ThumbnailStore(env.THUMBNAILS),
    // Reports persist durably in the same D1 database as the catalog and sessions — the edge can
    // collect moderation signal against the commons it serves even with generation disabled.
    reportStore: makeD1ReportStore(env.DB),
    sessionStore: makeD1SessionStore(env.DB, { now: () => Date.now(), ttlMs: EDGE_SESSION_TTL_MS }),
    // No provider means no turns are ever created, so the disposer is unreachable — a no-op is the
    // contract's sanctioned value for "a provider with nothing to release". The failure reason it now
    // receives is intentionally discarded: there is no diagnostics record at the edge (generation, and
    // thus any failure to preserve, is disabled here). When public edge generation turns on
    // (providers-u1h) a real disposer swaps in behind this seam. [LAW:dataflow-not-control-flow]
    disposeTurn: async () => undefined,
    // The generation budget. In-memory per isolate, inert while the registry is empty (no turn is
    // admitted). When public generation turns on across the isolate fleet (providers-u1h) a durable
    // implementation swaps in behind this same seam so caps hold across isolates. [LAW:decomposition]
    quota: makeGenerationQuota({
      limits: parseQuotaLimits({
        maxConcurrent: env.TINKERPAD_MAX_CONCURRENT_GENERATIONS,
        maxDaily: env.TINKERPAD_MAX_DAILY_GENERATIONS,
      }),
      now: () => Date.now(),
    }),
    // The service's clock, supplied with the quota's. Inert while the registry is empty (no turn ever
    // settles, so nothing is stamped or swept), but present so the seam is complete when public edge
    // generation turns on. [LAW:effects-at-boundaries]
    now: () => Date.now(),
    // The retry budget, parsed from env through the single-value seam the Node roots share — inert
    // while the registry is empty (no turn is ever admitted), but validated and consistent so it
    // applies the instant public generation turns on (providers-u1h). ONLY maxAttempts is parsed here:
    // the edge has no driver, so the per-attempt deadline has no consumer and is not read (validating
    // it would risk bricking the whole Worker on an invalid inert value). [LAW:decomposition]
    maxAttempts: parseMaxGenerationAttempts(env.TINKERPAD_MAX_GENERATION_ATTEMPTS),
    // No provider means no turn is ever admitted, so the functional gate is unreachable — the pass-through
    // is the contract's sanctioned value, exactly like the no-op disposeTurn. When public generation turns
    // on at the edge (providers-u1h), an ISOLATED render sandbox (not a browser in this trusted Worker)
    // swaps in behind this seam. [LAW:dataflow-not-control-flow]
    validateArtifact: passThroughValidator,
    oauth: makeGitHubOAuthProvider({ clientId, clientSecret }),
    oauthCallbackUrl,
    // The edge is HTTPS, so cookies are hardened: Secure + __Host- prefix. [LAW:single-enforcer]
    cookieSecurity: { secure: true },
    // The moderation admin allowlist, from the optional [vars] entry — no admins configured means the
    // review console is reachable by no one, the safe default. [LAW:no-silent-failure]
    adminSubjects: parseAdminSubjects(env.TINKERPAD_ADMIN_SUBJECTS),
  });

  // The app origin scoped into the content CSP's frame-ancestors — derived from the OAuth callback URL,
  // the canonical app-origin source (no standalone app-origin config exists). [LAW:one-source-of-truth]
  const handler = makeFrontDoorRouter({ app, page, contentOrigin, appOrigin: appOriginOf(oauthCallbackUrl) });
  cached = { env, handler };
  return handler;
};

// THE RENDER PIPELINE'S EDGE CONTEXT — the lean set of seams the queue/scheduled handlers need, built
// straight from the bindings. Deliberately NOT the whole app graph (handlerFor): the pipeline needs only
// the catalog (what exists), the thumbnail cache, the status store, and the content-URL formula — never
// OAuth, sessions, or the API. It is cheap (stateless wrappers over stable bindings), so it is built per
// invocation rather than memoized; the browser and queue bindings are passed through for the handlers to
// own their lifecycle. `contentUrlOf` is the SAME formula the player frames (playgroundContentUrl), so a
// thumbnail is shot from exactly the URL users run. [LAW:decomposition] [LAW:one-source-of-truth]
const renderContextFor = (env: Env): {
  readonly catalog: ReturnType<typeof makeD1Catalog>;
  readonly thumbnails: ReturnType<typeof makeR2ThumbnailStore>;
  readonly statuses: ReturnType<typeof makeKvRenderStatusStore>;
  readonly pipeline: RenderPipelineDeps;
} => {
  const contentOrigin = required(env, 'TINKERPAD_CONTENT_ORIGIN');
  const catalog = makeD1Catalog(env.DB);
  const thumbnails = makeR2ThumbnailStore(env.THUMBNAILS);
  const statuses = makeKvRenderStatusStore(env.RENDER_STATUS);
  return {
    catalog,
    thumbnails,
    statuses,
    pipeline: { catalog, thumbnails, statuses, contentUrlOf: (id) => playgroundContentUrl(contentOrigin, id) },
  };
};

// The code-owned retry bound: a render that fails on its 3rd delivery is recorded 'failed' and acked, so it
// is surfaced, not retried forever nor silently dead-lettered. This is the SINGLE source of truth for the
// bound — the queue's max_retries (wrangler.toml) is set to match as a backstop for an unexpected THROW,
// but our handler acks at this bound so that backstop is never reached on a normal render failure.
// [LAW:one-source-of-truth] [LAW:no-silent-failure]
const MAX_RENDER_ATTEMPTS = 3;

// Cloudflare Queues cap a sendBatch at 100 messages; the backfill of the whole commons chunks to fit.
const QUEUE_BATCH_MAX = 100;

// The queue PRODUCER adapter: hand render jobs to the queue in ≤100-message batches. An empty job list is a
// no-op (the loop simply does not run), so the backfill need not branch on emptiness. [LAW:dataflow-not-control-flow]
const enqueueRenderJobs = async (queue: Queue<RenderJob>, jobs: readonly RenderJob[]): Promise<void> => {
  for (let i = 0; i < jobs.length; i += QUEUE_BATCH_MAX) {
    await queue.sendBatch(jobs.slice(i, i + QUEUE_BATCH_MAX).map((body) => ({ body })));
  }
};

// THE QUEUE CONSUMER EDGE — owns only the browser lifecycle: one browser for the whole batch (Browser
// Rendering rate-limits launches, so the batch shares a single withSession; each render still gets a fresh
// isolated context), on which the pure per-batch mapping (runRenderBatch) runs. The ack/retry mapping,
// poison-pill handling, and attempt-bound logic all live in that tested core; a real Cloudflare
// Message<unknown> satisfies its RenderMessage shape structurally, so messages pass straight through.
// [LAW:effects-at-boundaries] [LAW:decomposition]
const consumeRenderBatch = async (env: Env, batch: MessageBatch<unknown>): Promise<void> => {
  const { pipeline } = renderContextFor(env);
  await makeBrowserRenderer(env.BROWSER).withSession((session) =>
    runRenderBatch(session, pipeline, batch.messages, MAX_RENDER_ATTEMPTS),
  );
};

// THE SCHEDULED BACKFILL — the idempotent, self-healing tick that populates the grid: it enqueues a render
// job for every listed playground whose current version has no thumbnail yet, and converges to a no-op once
// the commons is fully rendered. It also picks up any newly-published playground the (future, providers-u1h)
// immediate publish hook has not yet covered. Producing (fast: a list + gets + sends) is separated from
// consuming (slow: the actual renders) so no single invocation renders the whole commons inline and blows
// its wall-clock budget. [LAW:no-ambient-temporal-coupling] [LAW:dataflow-not-control-flow]
const runScheduledBackfill = async (env: Env): Promise<void> => {
  const ctx = renderContextFor(env);
  const report = await runBackfill({
    catalog: ctx.catalog,
    thumbnails: ctx.thumbnails,
    statuses: ctx.statuses,
    enqueue: (jobs) => enqueueRenderJobs(env.RENDER_QUEUE, jobs),
  });
  console.log(`tinkerpad render backfill: enqueued ${report.enqueued}, skipped ${report.skipped}`);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // THE EDGE ERROR BOUNDARY — the Worker's equivalent of the Node socket's try/catch in serve().
    // Any failure building the graph (a missing secret) or serving a request (a D1/R2 error — real
    // now that the seams are async and remote, e.g. a session-mint write that fails) becomes a loud
    // 500 carrying its message, never a generic runtime crash that tells the caller nothing. Two
    // separate runtime edges (Node socket, Worker fetch) each own their own boundary; this is not a
    // duplicate enforcer. [LAW:no-silent-failure] [LAW:single-enforcer]
    try {
      return await handlerFor(env)(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  },

  // THE QUEUE CONSUMER EDGE — renders one batch of thumbnail jobs. Its own error boundary, distinct from
  // fetch's: an infra failure that escapes consumeRenderBatch (a browser that will not launch) is logged
  // LOUDLY and rethrown, so every message the batch did not explicitly ack is returned to the queue for a
  // bounded retry rather than silently lost. Per-message render failures never reach here — renderAttempt
  // is total and records them 'failed'. [LAW:no-silent-failure] [LAW:single-enforcer]
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    try {
      await consumeRenderBatch(env, batch);
    } catch (error) {
      console.error(`tinkerpad render: queue batch failed, returning unacked messages for retry: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  },

  // THE CRON EDGE — the scheduled backfill tick. Its own boundary: a failure is logged LOUDLY and rethrown
  // so the invocation is recorded as failed in observability, never swallowed into a silently-skipped tick
  // that leaves the grid unpopulated with no signal why. [LAW:no-silent-failure]
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      await runScheduledBackfill(env);
    } catch (error) {
      console.error(`tinkerpad render: scheduled backfill failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  },
};
