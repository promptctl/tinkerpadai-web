import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cookiePair,
  generateOne,
  login,
  parseManifest,
  resolveConfig,
  runWave,
  summarize,
  UsageError,
  type BriefDriver,
  type BriefEntry,
  type BriefResult,
  type Outcome,
} from './seed-wave.js';

// The seeding driver's core behaviors, verified without a server: the trust-boundary
// validators (manifest, cookies, args) are pure; the poll enumeration and the worker
// draining are exercised through injected seams. Tests assert the contract — what each
// unit promises — never its internal shape. [LAW:behavior-not-structure]

// The core narrates progress to stdout by design; silence it so a 25-brief wave test
// does not bury the reporter. This spies the effect, it does not change behavior.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const brief = (type: BriefEntry['type'], description: string): BriefEntry => ({ type, description });

describe('parseManifest', () => {
  it('shapes a well-formed manifest into brief entries', () => {
    const raw = JSON.stringify([
      { type: 'design', description: 'a card' },
      { type: 'code-map', description: 'an MVC app', extra: 'ignored' },
    ]);
    expect(parseManifest(raw, 'm.json')).toEqual([
      { type: 'design', description: 'a card' },
      { type: 'code-map', description: 'an MVC app' },
    ]);
  });

  it('rejects a non-array top level', () => {
    expect(() => parseManifest('{}', 'm.json')).toThrow(/must be a non-empty JSON array/);
  });

  it('rejects an empty array — a wave with no briefs is a mistake, not a no-op', () => {
    expect(() => parseManifest('[]', 'm.json')).toThrow(/must be a non-empty JSON array/);
  });

  it('rejects an entry whose type is not one of the six', () => {
    const raw = JSON.stringify([{ type: 'not-a-type', description: 'x' }]);
    expect(() => parseManifest(raw, 'm.json')).toThrow(/\[0\]: type must be one of/);
  });

  it('rejects a whitespace-only description', () => {
    const raw = JSON.stringify([{ type: 'design', description: '   ' }]);
    expect(() => parseManifest(raw, 'm.json')).toThrow(/\[0\]: description must be a non-empty string/);
  });

  it('rejects a missing description', () => {
    const raw = JSON.stringify([{ type: 'design' }]);
    expect(() => parseManifest(raw, 'm.json')).toThrow(/\[0\]: description must be a non-empty string/);
  });

  it('names the offending index in the message', () => {
    const raw = JSON.stringify([{ type: 'design', description: 'ok' }, { type: 'design' }]);
    expect(() => parseManifest(raw, 'm.json')).toThrow(/\[1\]: description/);
  });

  it('rejects invalid JSON, naming the manifest path', () => {
    expect(() => parseManifest('not json at all', 'bad.json')).toThrow(/^bad\.json: not valid JSON/);
  });
});

describe('cookiePair', () => {
  it('extracts the name=value pair, dropping attributes', () => {
    const headers = ['tp_session=abc123; Path=/; HttpOnly; SameSite=Strict'];
    expect(cookiePair(headers, 'tp_session')).toBe('tp_session=abc123');
  });

  it('finds the requested cookie among several', () => {
    const headers = ['other=1; Path=/', 'tp_oauth_state=nonce; Max-Age=600', 'more=2'];
    expect(cookiePair(headers, 'tp_oauth_state')).toBe('tp_oauth_state=nonce');
  });

  it('does not confuse a prefix sibling — tp_session is not tp_session_v2', () => {
    const headers = ['tp_session_v2=wrong; Path=/'];
    expect(() => cookiePair(headers, 'tp_session')).toThrow(/did not set cookie tp_session/);
  });

  it('fails loudly when the cookie is absent', () => {
    expect(() => cookiePair(['other=1'], 'tp_session')).toThrow(/did not set cookie tp_session/);
  });

  it('fails loudly when the cookie is present but empty', () => {
    expect(() => cookiePair(['tp_session=; Path=/'], 'tp_session')).toThrow(/cookie tp_session is empty/);
  });
});

// Build a Response carrying zero or more Set-Cookie headers, the way the app's session
// endpoints answer — so login's cookie extraction runs against real Headers.getSetCookie().
const withCookies = (
  status: number,
  cookies: readonly string[],
  init: { location?: string; body?: unknown } = {},
): Response => {
  const headers = new Headers();
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  if (init.location !== undefined) headers.set('location', init.location);
  return new Response(init.body === undefined ? null : JSON.stringify(init.body), { status, headers });
};

// Route the login dance's three requests to scripted responses by URL, so each failure
// shape can be injected without a server. [LAW:behavior-not-structure]
const stubLoginFetch = (responders: {
  start: () => Response;
  callback?: () => Response;
  whoami?: () => Response;
}): void => {
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/session/login')) return Promise.resolve(responders.start());
    if (url.includes('/session/callback')) {
      return Promise.resolve((responders.callback ?? (() => withCookies(302, ['tp_session=sess'], { location: '/' })))());
    }
    if (url.endsWith('/session')) {
      return Promise.resolve((responders.whoami ?? (() => withCookies(200, [], { body: { identity: { subject: 'dev:local' } } })))());
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
};

const okStart = (): Response =>
  withCookies(302, ['tp_oauth_state=nonce'], { location: 'http://test.local/session/callback?code=c&state=nonce' });

describe('login', () => {
  it('completes the dance and returns the session cookie pair', async () => {
    stubLoginFetch({ start: okStart });
    await expect(login('http://test.local')).resolves.toBe('tp_session=sess');
  });

  it('fails loudly when the login redirect carries no location header', async () => {
    stubLoginFetch({ start: () => withCookies(302, ['tp_oauth_state=nonce']) });
    await expect(login('http://test.local')).rejects.toThrow(/redirect carried no location header/);
  });

  it('fails loudly when the state cookie is absent', async () => {
    stubLoginFetch({ start: () => withCookies(302, [], { location: 'http://test.local/session/callback' }) });
    await expect(login('http://test.local')).rejects.toThrow(/did not set cookie tp_oauth_state/);
  });

  it('fails loudly when the callback mints no session cookie', async () => {
    stubLoginFetch({ start: okStart, callback: () => withCookies(302, [], { location: '/' }) });
    await expect(login('http://test.local')).rejects.toThrow(/did not set cookie tp_session/);
  });

  it('fails loudly when whoami resolves no identity shape', async () => {
    stubLoginFetch({ start: okStart, whoami: () => withCookies(200, [], { body: { notIdentity: true } }) });
    await expect(login('http://test.local')).rejects.toThrow(/did not resolve an identity/);
  });

  it('fails loudly when a step returns the wrong status', async () => {
    stubLoginFetch({ start: () => withCookies(500, []) });
    await expect(login('http://test.local')).rejects.toThrow(/expected HTTP 302, got 500/);
  });
});

describe('resolveConfig', () => {
  const argv = (...rest: string[]): string[] => ['node', 'seed.ts', ...rest];

  it('defaults concurrency to 3 when the arg is absent', () => {
    expect(resolveConfig(argv('m.json'), {}).concurrency).toBe(3);
  });

  it('parses an explicit concurrency', () => {
    expect(resolveConfig(argv('m.json', '7'), {}).concurrency).toBe(7);
  });

  it('rejects a non-positive concurrency', () => {
    expect(() => resolveConfig(argv('m.json', '0'), {})).toThrow(UsageError);
  });

  it('rejects a non-numeric concurrency', () => {
    expect(() => resolveConfig(argv('m.json', 'lots'), {})).toThrow(/must be a positive integer/);
  });

  it('requires a manifest path', () => {
    expect(() => resolveConfig(argv(), {})).toThrow(UsageError);
  });

  it('defaults the base URL to localhost', () => {
    expect(resolveConfig(argv('m.json'), {}).base).toBe('http://localhost:8787');
  });

  it('normalizes a trailing slash off the base URL', () => {
    const config = resolveConfig(argv('m.json'), { TINKERPAD_URL: 'http://example.com/' });
    expect(config.base).toBe('http://example.com');
  });
});

// A scripted BriefDriver: `post` returns the next queued response per path, `delay` is a
// no-op so the poll loop runs at full speed. This is the injected world seam, so the
// terminal enumeration is exercised with zero fetches and zero real waits.
const scriptedDriver = (script: {
  generations?: readonly { status: number; data: unknown }[];
  poll?: readonly { status: number; data: unknown }[];
}): BriefDriver => {
  const queues: Record<string, { status: number; data: unknown }[]> = {
    '/generations': [...(script.generations ?? [{ status: 201, data: { handle: { turnId: 't1' } } }])],
    '/poll': [...(script.poll ?? [])],
  };
  return {
    post: (path) => {
      const next = queues[path]?.shift();
      if (next === undefined) throw new Error(`scripted driver exhausted for ${path}`);
      return Promise.resolve(next);
    },
    delay: () => Promise.resolve(),
  };
};

describe('generateOne — terminal enumeration', () => {
  const entry = brief('design', 'a card');

  it('returns ready with the playground id once the server reports ready', async () => {
    const driver = scriptedDriver({
      poll: [
        { status: 200, data: { state: 'pending' } },
        { status: 200, data: { state: 'running' } },
        { status: 200, data: { state: 'ready', playgroundId: 'pg-1' } },
      ],
    });
    await expect(generateOne(entry, driver)).resolves.toEqual({ state: 'ready', playgroundId: 'pg-1' });
  });

  it('fails the brief when submit is not a 201-with-handle', async () => {
    const driver = scriptedDriver({ generations: [{ status: 401, data: { error: 'auth' } }] });
    const outcome = await generateOne(entry, driver);
    expect(outcome.state).toBe('failed');
    expect((outcome as Extract<Outcome, { state: 'failed' }>).error).toMatch(/submit: HTTP 401/);
  });

  it('surfaces a server-reported failed state', async () => {
    const driver = scriptedDriver({ poll: [{ status: 200, data: { state: 'failed', error: 'timed out' } }] });
    await expect(generateOne(entry, driver)).resolves.toEqual({ state: 'failed', error: 'timed out' });
  });

  it('fails loudly on a ready without a playgroundId rather than spinning forever', async () => {
    const driver = scriptedDriver({ poll: [{ status: 200, data: { state: 'ready' } }] });
    const outcome = await generateOne(entry, driver);
    expect(outcome.state).toBe('failed');
    expect((outcome as Extract<Outcome, { state: 'failed' }>).error).toMatch(/unexpected response shape/);
  });

  it('fails loudly on an unknown terminal state — a protocol mismatch, not a wait', async () => {
    const driver = scriptedDriver({ poll: [{ status: 200, data: { state: 'exploded' } }] });
    const outcome = await generateOne(entry, driver);
    expect(outcome.state).toBe('failed');
    expect((outcome as Extract<Outcome, { state: 'failed' }>).error).toMatch(/unexpected response shape/);
  });
});

describe('runWave — worker draining', () => {
  const entries: readonly BriefEntry[] = Array.from({ length: 10 }, (_, i) => brief('design', `brief ${i}`));

  it('processes every entry exactly once and indexes results to entries', async () => {
    const seen: string[] = [];
    const generate = (entry: BriefEntry): Promise<Outcome> => {
      seen.push(entry.description);
      return Promise.resolve({ state: 'ready', playgroundId: entry.description });
    };
    const results = await runWave(entries, 3, generate);
    expect(results).toHaveLength(10);
    expect(seen.sort()).toEqual(entries.map((e) => e.description).sort());
    results.forEach((result, i) => {
      expect(result.entry).toBe(entries[i]);
      expect(result.outcome).toEqual({ state: 'ready', playgroundId: `brief ${i}` });
    });
  });

  it('never runs more than `concurrency` briefs at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const generate = async (entry: BriefEntry): Promise<Outcome> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return { state: 'ready', playgroundId: entry.description };
    };
    await runWave(entries, 3, generate);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('contains a rejected brief and finishes the rest of the wave', async () => {
    // generateOne is async, so its real failures — a fetch rejection, a non-JSON parse
    // throw — arrive as a rejected promise; that is the shape the containment seam must
    // absorb, modeled here as one brief rejecting.
    const generate = async (entry: BriefEntry): Promise<Outcome> => {
      if (entry.description === 'brief 4') throw new Error('proxy 502');
      return { state: 'ready', playgroundId: entry.description };
    };
    const results = await runWave(entries, 3, generate);
    expect(results).toHaveLength(10);
    const four = results[4];
    expect(four?.outcome.state).toBe('failed');
    expect((four?.outcome as Extract<Outcome, { state: 'failed' }>).error).toMatch(/transport: proxy 502/);
    expect(results.filter((r) => r.outcome.state === 'ready')).toHaveLength(9);
  });

  it('handles concurrency greater than the number of briefs', async () => {
    const generate = (entry: BriefEntry): Promise<Outcome> =>
      Promise.resolve({ state: 'ready', playgroundId: entry.description });
    const results = await runWave(entries, 50, generate);
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.outcome.state === 'ready')).toBe(true);
  });
});

describe('summarize — exit code contract', () => {
  const ok = (type: BriefEntry['type']): BriefResult => ({
    entry: brief(type, 'x'),
    outcome: { state: 'ready', playgroundId: 'pg' },
  });
  const bad = (type: BriefEntry['type']): BriefResult => ({
    entry: brief(type, 'x'),
    outcome: { state: 'failed', error: 'boom' },
  });

  it('returns 0 when every brief became a playground', () => {
    expect(summarize([ok('design'), ok('code-map')])).toBe(0);
  });

  it('returns 1 when any brief failed', () => {
    expect(summarize([ok('design'), bad('code-map')])).toBe(1);
  });
});
