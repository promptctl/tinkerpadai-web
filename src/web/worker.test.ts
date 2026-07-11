import { describe, expect, it } from 'vitest';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import { makeD1Catalog } from '../storage/d1Catalog.js';
import { makeR2ArtifactStore } from '../storage/r2ArtifactStore.js';
import { Subject } from '../identity/index.js';
import workerEntry from './worker.js';
import type { Env } from './worker.js';

// The edge composition root must reject a config where the content origin shares the app origin's
// host — the misconfiguration that collapses the two-origin sandbox split. The distinctness guard
// runs on the required() path, BEFORE makeApp touches R2/D1, so this exercises the real wiring with
// inert bindings: a colliding config becomes a loud 500 carrying the invariant's message, never a
// running Worker that serves untrusted HTML same-origin with the app. [LAW:behavior-not-structure]
// [LAW:no-silent-failure]

// Inert bindings: the guard throws before either is dereferenced, so their bodies are never reached. The
// render-pipeline bindings (render-dax.3) are inert here too — these tests exercise ONLY the fetch path,
// which never touches the browser/thumbnail/status/queue bindings. [LAW:decomposition]
const inertRenderBindings = {
  BROWSER: {} as unknown as Env['BROWSER'],
  THUMBNAILS: {} as unknown as R2Bucket,
  RENDER_STATUS: {} as unknown as Env['RENDER_STATUS'],
  RENDER_QUEUE: {} as unknown as Env['RENDER_QUEUE'],
};
const inertBindings = {
  ARTIFACTS: {} as unknown as R2Bucket,
  DB: {} as unknown as D1Database,
  ...inertRenderBindings,
};

const collidingEnv = (host: string): Env => ({
  ...inertBindings,
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  TINKERPAD_OAUTH_CALLBACK_URL: `https://${host}/session/callback`,
  TINKERPAD_CONTENT_ORIGIN: `https://${host}`,
});

describe('worker entry — two-origin distinctness guard', () => {
  it('returns a 500 naming the collapse when content origin shares the app host', async () => {
    const res = await workerEntry.fetch(
      new Request('https://tinkerpad.example/'),
      collidingEnv('tinkerpad.example'),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/must be different hostnames/);
  });
});

// A fake D1 holding the one catalog row as a single string cell — the exact surface makeD1Catalog
// issues (a SELECT of the doc, an upsert of it), so a playground can be seeded and read back through
// the REAL adapter the Worker wires.
const makeFakeD1 = (): D1Database => {
  let cell: string | undefined;
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              return cell === undefined ? null : ({ doc: cell } as T);
            },
            async run(): Promise<unknown> {
              cell = String(args[1]);
              return {};
            },
          };
        },
      };
    },
  } as unknown as D1Database;
};

const makeFakeR2 = (): R2Bucket => {
  const objects = new Map<string, string>();
  return {
    async put(key: string, value: string): Promise<unknown> {
      objects.set(key, value);
      return {};
    },
    async get(key: string): Promise<{ text: () => Promise<string> } | null> {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
  } as unknown as R2Bucket;
};

// The other half of the boundary this ticket lands: a served playground's CSP must scope frame-ancestors
// to the app origin, and at the edge that origin is DERIVED from the OAuth callback URL — there is no
// standalone app-origin config. This exercises the real edge wiring (worker → appOriginOf(callback) →
// frontDoorRouter → contentHandler) with faithful D1/R2 fakes: a request on the content host returns the
// raw bytes sealed under a CSP whose frame-ancestors is the callback's origin, so only the app's player
// may frame it and a third party cannot hotlink it. [LAW:behavior-not-structure] [LAW:one-source-of-truth]
describe('worker entry — content CSP scopes frame-ancestors to the derived app origin', () => {
  it('serves a playground on the content host sealed with frame-ancestors = the OAuth callback origin', async () => {
    const RAW = '<!doctype html><html><body><script>void 0</script></body></html>';
    const db = makeFakeD1();
    const bucket = makeFakeR2();
    // Seed through the SAME adapters the Worker wires, against the SAME bindings its env carries.
    const version = await makeR2ArtifactStore(bucket).put({ html: RAW });
    const playground = await makeD1Catalog(db).createPlayground({
      handle: { providerId: ProviderId('p'), sessionId: SessionId('s'), turnId: TurnId('t') },
      prompt: 'a thing',
      version,
      lineage: null,
      author: Subject('github:1'),
      tags: [],
    });

    const env: Env = {
      ...inertRenderBindings,
      ARTIFACTS: bucket,
      DB: db,
      GITHUB_CLIENT_ID: 'client-id',
      GITHUB_CLIENT_SECRET: 'client-secret',
      // The app origin the frame-ancestors must resolve to is THIS URL's origin — https://app.example.
      TINKERPAD_OAUTH_CALLBACK_URL: 'https://app.example/session/callback',
      TINKERPAD_CONTENT_ORIGIN: 'https://content.example',
    };

    const res = await workerEntry.fetch(
      new Request(`https://content.example/?id=${encodeURIComponent(playground.id)}`),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(RAW);
    const csp = res.headers.get('content-security-policy') ?? '';
    // The load-bearing assertion: the app origin scoped into frame-ancestors is the callback's origin,
    // proving the edge derives it from the callback URL rather than a mint-your-own second source.
    expect(csp).toContain('frame-ancestors https://app.example');
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
