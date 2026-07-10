import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import page from './index.html';
import { makeApp, parseAdminSubjects } from '../app.js';
import { ProviderRegistry } from '../provider/index.js';
import { makeGenerationQuota, makeGitHubOAuthProvider, parseMaxGenerationAttempts, parseQuotaLimits } from '../api/index.js';
import { makeD1SessionStore } from '../api/d1SessionStore.js';
import { makeR2ArtifactStore } from '../storage/r2ArtifactStore.js';
import { makeD1Catalog } from '../storage/d1Catalog.js';
import { makeD1ReportStore } from '../storage/d1ReportStore.js';
import { makeFrontDoorRouter } from './frontDoorRouter.js';

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

  const app = makeApp({
    // Generation is disabled at the first public deploy — an empty registry the front door reads as
    // "no generation UI". Public generation turns on later with the credits ledger + API driver
    // (tinkerpadai-providers-u1h). [LAW:dataflow-not-control-flow]
    registry: new ProviderRegistry(),
    store: makeR2ArtifactStore(env.ARTIFACTS),
    catalog: makeD1Catalog(env.DB),
    // Reports persist durably in the same D1 database as the catalog and sessions — the edge can
    // collect moderation signal against the commons it serves even with generation disabled.
    reportStore: makeD1ReportStore(env.DB),
    sessionStore: makeD1SessionStore(env.DB, { now: () => Date.now(), ttlMs: EDGE_SESSION_TTL_MS }),
    // No provider means no turns are ever created, so the disposer is unreachable — a no-op is the
    // contract's sanctioned value for "a provider with nothing to release". [LAW:dataflow-not-control-flow]
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
    // The retry budget, parsed from env through the single-value seam the Node roots share — inert
    // while the registry is empty (no turn is ever admitted), but validated and consistent so it
    // applies the instant public generation turns on (providers-u1h). ONLY maxAttempts is parsed here:
    // the edge has no driver, so the per-attempt deadline has no consumer and is not read (validating
    // it would risk bricking the whole Worker on an invalid inert value). [LAW:decomposition]
    maxAttempts: parseMaxGenerationAttempts(env.TINKERPAD_MAX_GENERATION_ATTEMPTS),
    oauth: makeGitHubOAuthProvider({ clientId, clientSecret }),
    oauthCallbackUrl,
    // The edge is HTTPS, so cookies are hardened: Secure + __Host- prefix. [LAW:single-enforcer]
    cookieSecurity: { secure: true },
    // The moderation admin allowlist, from the optional [vars] entry — no admins configured means the
    // review console is reachable by no one, the safe default. [LAW:no-silent-failure]
    adminSubjects: parseAdminSubjects(env.TINKERPAD_ADMIN_SUBJECTS),
  });

  const handler = makeFrontDoorRouter({ app, page, contentOrigin });
  cached = { env, handler };
  return handler;
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
};
