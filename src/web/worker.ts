import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import page from './index.html';
import { makeApp } from '../app.js';
import { ProviderRegistry } from '../provider/index.js';
import { makeGitHubOAuthProvider } from '../api/index.js';
import { makeD1SessionStore } from '../api/d1SessionStore.js';
import { makeR2ArtifactStore } from '../storage/r2ArtifactStore.js';
import { makeD1Catalog } from '../storage/d1Catalog.js';
import { makeFrontDoorRouter } from './frontDoorRouter.js';

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
}

// A real user's session at the edge, durably in D1 so it survives Worker cold starts. 7 days — long
// enough to stay signed in across visits, bounded so a session cannot live forever. The store owns
// the deadline; this composition root states the policy. [LAW:no-ambient-temporal-coupling]
const EDGE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Read a required secret/var, failing LOUDLY and by name when absent — never a silent fallback to an
// open gate or a wrong origin. `|| undefined` so an empty string is treated as unset. The GitHub
// credentials CANNOT be minted, so their absence is a hard failure, exactly as the Node entry
// enforces. [LAW:no-silent-failure]
const required = (env: Env, name: keyof Env): string => {
  const value = env[name] || undefined;
  if (typeof value !== 'string') {
    throw new Error(
      `${String(name)} is required for the Cloudflare deploy. Set it with \`wrangler secret put ${String(name)}\` ` +
        `(secrets) or the [vars] table in wrangler.toml (config).`,
    );
  }
  return value;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const clientId = required(env, 'GITHUB_CLIENT_ID');
    const clientSecret = required(env, 'GITHUB_CLIENT_SECRET');
    const oauthCallbackUrl = required(env, 'TINKERPAD_OAUTH_CALLBACK_URL');
    const contentOrigin = required(env, 'TINKERPAD_CONTENT_ORIGIN');

    // The app graph, built per request from the edge bindings. makeApp is pure composition (no I/O),
    // so rebuilding it costs only closure allocation — cheaper than caching a mutable singleton across
    // requests and free of any binding-lifetime or isolate-reuse assumption. [LAW:no-shared-mutable-globals]
    const app = makeApp({
      // Generation is disabled at the first public deploy — an empty registry the front door reads as
      // "no generation UI". Public generation turns on later with the credits ledger + API driver
      // (tinkerpadai-providers-u1h). [LAW:dataflow-not-control-flow]
      registry: new ProviderRegistry(),
      store: makeR2ArtifactStore(env.ARTIFACTS),
      catalog: makeD1Catalog(env.DB),
      sessionStore: makeD1SessionStore(env.DB, { now: () => Date.now(), ttlMs: EDGE_SESSION_TTL_MS }),
      // No provider means no turns are ever created, so the disposer is unreachable — a no-op is the
      // contract's sanctioned value for "a provider with nothing to release". [LAW:dataflow-not-control-flow]
      disposeTurn: async () => undefined,
      oauth: makeGitHubOAuthProvider({ clientId, clientSecret }),
      oauthCallbackUrl,
      // The edge is HTTPS, so cookies are hardened: Secure + __Host- prefix. [LAW:single-enforcer]
      cookieSecurity: { secure: true },
    });

    return makeFrontDoorRouter({ app, page, contentOrigin })(request);
  },
};
