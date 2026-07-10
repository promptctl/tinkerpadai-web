import { join } from 'node:path';
import { makeApp } from '../app.js';
import type { App } from '../app.js';
import { ProviderRegistry, cleanupTurn, makeTmuxDriver, makeTmuxProvider } from '../provider/index.js';
import { makeFileArtifactStore, makeFileCatalog, makeFileReportStore } from '../storage/index.js';
import { makeGenerationQuota, makeMemorySessionStore, DEFAULT_QUOTA_LIMITS } from '../api/index.js';
import type { CookieSecurity, GenerationPolicy, OAuthProvider, QuotaLimits, Subject } from '../api/index.js';

// THE NODE COMPOSITION ROOT — the one place that knows the concrete shape of the local steel thread:
// the provider is the tmux/Claude-Code body, storage is the local file backends, sessions live in an
// in-memory map that dies with the process, and cleanup is tmux's disposer. Both Node entries
// (main.ts production, main.dev.ts loopback) build their app HERE, differing only in the identity
// provider and the driver deadline they pass — so the file/memory/tmux wiring exists exactly once
// and cannot drift between the two. The Cloudflare entry (src/web/worker.ts) is the SIBLING
// composition root that wires R2/D1 instead; makeApp itself sees neither. [LAW:one-source-of-truth]
// [LAW:effects-at-boundaries]

// The local session lifetime, stated explicitly by this composition root. 6 hours — long enough to
// span a working session without re-auth, short enough that a session cannot live forever. The store
// owns lifetime; the real clock (Date.now, the world's clock) is supplied here at the boundary rather
// than read inside the store. [LAW:no-ambient-temporal-coupling]
const NODE_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export interface NodeAppConfig {
  // Where the file artifact store and catalog live.
  readonly dataDir: string;
  // The delegated identity provider (real GitHub in main.ts, a loopback in main.dev.ts).
  readonly oauth: OAuthProvider;
  // The absolute URL the identity provider redirects back to (this app's /session/callback).
  readonly oauthCallbackUrl: string;
  // The cookie hardening policy. The Node entries bind a plain http socket, so they pass
  // { secure: false }; the HTTPS Worker entry is the production target that passes { secure: true }.
  readonly cookieSecurity: CookieSecurity;
  // The moderation admin allowlist (moderation-5g7.2). main.ts parses it from TINKERPAD_ADMIN_SUBJECTS;
  // main.dev.ts passes the dev subject so the loop can be driven with a real admin locally. Empty is a
  // valid default (no admins → console reachable by no one). [LAW:no-silent-failure]
  readonly adminSubjects: ReadonlySet<Subject>;
  // The per-identity generation caps. main.ts parses them from the environment; main.dev.ts omits
  // them, so the loopback loop runs on the documented defaults. Optional because there is a sane
  // default (unlike adminSubjects, whose empty default is a deliberate safety posture the entries
  // always state). [LAW:no-mode-explosion]
  readonly quotaLimits?: QuotaLimits;
  // The generation policy — the per-attempt deadline (which the driver enforces) and the retry
  // budget (which the service enforces). REQUIRED, not defaulted: the deadline especially is a
  // deliberate deploy choice this composition root must state, not silently inherit — main.ts reads
  // it from the environment, main.dev.ts widens the deadline for local rich briefs. Both roots route
  // its two halves to the two seams that enforce them. [LAW:decomposition] [LAW:one-source-of-truth]
  readonly generationPolicy: GenerationPolicy;
  readonly providerId?: string;
  readonly providerLabel?: string;
}

export const makeNodeApp = (config: NodeAppConfig): App => {
  const registry = new ProviderRegistry();
  registry.register(
    makeTmuxProvider({
      id: config.providerId ?? 'claude-code-tmux',
      label: config.providerLabel ?? 'Claude Code (local tmux)',
      // The deadline half of the policy flows to the driver, the mechanism that enforces it.
      driver: makeTmuxDriver({ timeoutMs: config.generationPolicy.timeoutMs }),
    }),
  );

  const store = makeFileArtifactStore(join(config.dataDir, 'artifacts'));
  const catalog = makeFileCatalog(join(config.dataDir, 'catalog.json'));
  const reportStore = makeFileReportStore(join(config.dataDir, 'reports.json'));
  const sessionStore = makeMemorySessionStore({ now: () => Date.now(), ttlMs: NODE_SESSION_TTL_MS });

  // The generation budget, built HERE with the real clock — the same boundary the session store's
  // clock is supplied at, keeping makeApp clock-free. In-memory, matching the single Node process.
  const quota = makeGenerationQuota({ limits: config.quotaLimits ?? DEFAULT_QUOTA_LIMITS, now: () => Date.now() });

  return makeApp({
    registry,
    store,
    catalog,
    reportStore,
    sessionStore,
    // cleanupTurn is tmux's per-turn disposer; injecting it here is what keeps the service
    // provider-agnostic — the service releases settled turns without knowing it is tmux.
    disposeTurn: cleanupTurn,
    quota,
    // The retry half of the policy flows to the service, the single owner of turn lifecycle.
    maxAttempts: config.generationPolicy.maxAttempts,
    oauth: config.oauth,
    oauthCallbackUrl: config.oauthCallbackUrl,
    cookieSecurity: config.cookieSecurity,
    adminSubjects: config.adminSubjects,
  });
};
