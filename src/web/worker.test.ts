import { describe, expect, it } from 'vitest';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import workerEntry from './worker.js';
import type { Env } from './worker.js';

// The edge composition root must reject a config where the content origin shares the app origin's
// host — the misconfiguration that collapses the two-origin sandbox split. The distinctness guard
// runs on the required() path, BEFORE makeApp touches R2/D1, so this exercises the real wiring with
// inert bindings: a colliding config becomes a loud 500 carrying the invariant's message, never a
// running Worker that serves untrusted HTML same-origin with the app. [LAW:behavior-not-structure]
// [LAW:no-silent-failure]

// Inert bindings: the guard throws before either is dereferenced, so their bodies are never reached.
const inertBindings = {
  ARTIFACTS: {} as unknown as R2Bucket,
  DB: {} as unknown as D1Database,
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
