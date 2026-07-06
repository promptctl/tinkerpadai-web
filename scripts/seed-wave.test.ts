import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chooseProvider,
  cookiePair,
  fetchProviders,
  generateOne,
  login,
  mapWithConcurrency,
  parseManifest,
  resolveConfig,
  runSeed,
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

  it('fails loudly when the identity carries no subject rather than logging "undefined"', async () => {
    stubLoginFetch({ start: okStart, whoami: () => withCookies(200, [], { body: { identity: {} } }) });
    await expect(login('http://test.local')).rejects.toThrow(/did not resolve an identity with a subject/);
  });

  it('fails loudly when a step returns the wrong status', async () => {
    stubLoginFetch({ start: () => withCookies(500, []) });
    await expect(login('http://test.local')).rejects.toThrow(/expected HTTP 302, got 500/);
  });
});

describe('fetchProviders', () => {
  const stubProviders = (make: () => Response): void => {
    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/providers')) return Promise.resolve(make());
      throw new Error(`unexpected fetch: ${url}`);
    });
  };

  it('parses the provider list down to ids', async () => {
    stubProviders(() => new Response(JSON.stringify([{ id: 'p1', label: 'P1' }, { id: 'p2' }]), { status: 200 }));
    await expect(fetchProviders('http://test.local')).resolves.toEqual([{ id: 'p1' }, { id: 'p2' }]);
  });

  it('rejects a non-array body', async () => {
    stubProviders(() => new Response(JSON.stringify({ not: 'an array' }), { status: 200 }));
    await expect(fetchProviders('http://test.local')).rejects.toThrow(/expected a JSON array/);
  });

  it('rejects an element without a string id', async () => {
    stubProviders(() => new Response(JSON.stringify([{ label: 'no id here' }]), { status: 200 }));
    await expect(fetchProviders('http://test.local')).rejects.toThrow(/no string id/);
  });

  it('fails loudly on a non-200', async () => {
    stubProviders(() => new Response('service unavailable', { status: 503 }));
    await expect(fetchProviders('http://test.local')).rejects.toThrow(/expected HTTP 200, got 503/);
  });
});

describe('chooseProvider', () => {
  it('uses the sole provider the server offers, unasked', () => {
    expect(chooseProvider([{ id: 'claude-code-tmux' }], {})).toBe('claude-code-tmux');
  });

  it('fails loudly when the server offers no providers', () => {
    expect(() => chooseProvider([], {})).toThrow(/no providers/);
  });

  it('uses TINKERPAD_PROVIDER when it names one the server offers', () => {
    const providers = [{ id: 'a' }, { id: 'b' }];
    expect(chooseProvider(providers, { TINKERPAD_PROVIDER: 'b' })).toBe('b');
  });

  it('rejects a TINKERPAD_PROVIDER the server does not offer', () => {
    expect(() => chooseProvider([{ id: 'a' }], { TINKERPAD_PROVIDER: 'ghost' })).toThrow(/not among the server/);
  });

  it('fails loudly on ambiguity rather than guessing among several providers', () => {
    expect(() => chooseProvider([{ id: 'a' }, { id: 'b' }], {})).toThrow(/multiple providers.*set TINKERPAD_PROVIDER/);
  });
});

describe('resolveConfig', () => {
  const argv = (...rest: string[]): string[] => ['node', 'seed.ts', ...rest];

  it('defaults concurrency to 3 when the arg is absent', () => {
    expect(resolveConfig(argv('m.json'), {}).concurrency).toBe(3);
  });

  it('defaults concurrency to 3 for an empty string, independent of how just passes the token', () => {
    expect(resolveConfig(argv('m.json', ''), {}).concurrency).toBe(3);
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

  it('rejects a garbage-suffixed concurrency rather than silently truncating it', () => {
    expect(() => resolveConfig(argv('m.json', '7foo'), {})).toThrow(/must be a positive integer/);
  });

  it('rejects a fractional concurrency rather than flooring it', () => {
    expect(() => resolveConfig(argv('m.json', '3.14'), {})).toThrow(/must be a positive integer/);
  });

  it('requires a manifest path', () => {
    expect(() => resolveConfig(argv(), {})).toThrow(UsageError);
  });

  it('treats an empty-string manifest path as missing', () => {
    expect(() => resolveConfig(argv(''), {})).toThrow(UsageError);
  });

  it('defaults the base URL to localhost', () => {
    expect(resolveConfig(argv('m.json'), {}).base).toBe('http://localhost:8787');
  });

  it('normalizes a trailing slash off the base URL', () => {
    const config = resolveConfig(argv('m.json'), { TINKERPAD_URL: 'http://example.com/' });
    expect(config.base).toBe('http://example.com');
  });

  it('reduces a base URL with a path to its origin, so routes stay root-relative', () => {
    const config = resolveConfig(argv('m.json'), { TINKERPAD_URL: 'http://example.com:9000/path//' });
    expect(config.base).toBe('http://example.com:9000');
  });

  it('fails loudly on a malformed base URL rather than routing silently', () => {
    expect(() => resolveConfig(argv('m.json'), { TINKERPAD_URL: 'not a url' })).toThrow(UsageError);
  });
});

// A scripted BriefDriver: `post` returns the next queued response per path, `delay` is a
// no-op so the poll loop runs at full speed. This is the injected world seam, so the
// terminal enumeration is exercised with zero fetches and zero real waits.
const scriptedDriver = (script: {
  generations?: readonly { status: number; data: unknown }[];
  poll?: readonly { status: number; data: unknown }[];
  now?: () => number;
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
    now: script.now ?? ((): number => 0),
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
    await expect(generateOne(entry, 'claude-code-tmux', driver)).resolves.toEqual({ state: 'ready', playgroundId: 'pg-1' });
  });

  it('fails the brief when submit is not a 201-with-handle', async () => {
    const driver = scriptedDriver({ generations: [{ status: 401, data: { error: 'auth' } }] });
    const outcome = await generateOne(entry, 'claude-code-tmux', driver);
    expect(outcome.state).toBe('failed');
    expect((outcome as Extract<Outcome, { state: 'failed' }>).error).toMatch(/submit: HTTP 401/);
  });

  it('surfaces a server-reported failed state', async () => {
    const driver = scriptedDriver({ poll: [{ status: 200, data: { state: 'failed', error: 'timed out' } }] });
    await expect(generateOne(entry, 'claude-code-tmux', driver)).resolves.toEqual({ state: 'failed', error: 'timed out' });
  });

  it('says so when a failed state carries no error message rather than reporting "undefined"', async () => {
    const driver = scriptedDriver({ poll: [{ status: 200, data: { state: 'failed' } }] });
    const outcome = await generateOne(entry, 'claude-code-tmux', driver);
    expect(outcome.state).toBe('failed');
    const error = (outcome as Extract<Outcome, { state: 'failed' }>).error;
    expect(error).toMatch(/non-string error/);
    expect(error).not.toBe('undefined');
  });

  it('emits the payload when a failed state carries an object error rather than "[object Object]"', async () => {
    const driver = scriptedDriver({ poll: [{ status: 200, data: { state: 'failed', error: { code: 42 } } }] });
    const outcome = await generateOne(entry, 'claude-code-tmux', driver);
    expect(outcome.state).toBe('failed');
    const error = (outcome as Extract<Outcome, { state: 'failed' }>).error;
    expect(error).toMatch(/non-string error/);
    expect(error).not.toContain('[object Object]');
  });

  it('fails loudly on a ready without a playgroundId rather than spinning forever', async () => {
    const driver = scriptedDriver({ poll: [{ status: 200, data: { state: 'ready' } }] });
    const outcome = await generateOne(entry, 'claude-code-tmux', driver);
    expect(outcome.state).toBe('failed');
    expect((outcome as Extract<Outcome, { state: 'failed' }>).error).toMatch(/unexpected response shape/);
  });

  it('rejects a ready with an empty-string playgroundId rather than reporting a hollow success', async () => {
    const driver = scriptedDriver({ poll: [{ status: 200, data: { state: 'ready', playgroundId: '' } }] });
    const outcome = await generateOne(entry, 'claude-code-tmux', driver);
    expect(outcome.state).toBe('failed');
    expect((outcome as Extract<Outcome, { state: 'failed' }>).error).toMatch(/unexpected response shape/);
  });

  it('fails loudly on an unknown terminal state — a protocol mismatch, not a wait', async () => {
    const driver = scriptedDriver({ poll: [{ status: 200, data: { state: 'exploded' } }] });
    const outcome = await generateOne(entry, 'claude-code-tmux', driver);
    expect(outcome.state).toBe('failed');
    expect((outcome as Extract<Outcome, { state: 'failed' }>).error).toMatch(/unexpected response shape/);
  });

  it('trips the liveness ceiling when the server returns pending forever', async () => {
    // The clock jumps past the ceiling on the second reading, while the server keeps
    // answering pending — the loop must fail loudly rather than spin forever.
    let tick = 0;
    const driver = scriptedDriver({
      poll: Array.from({ length: 5 }, () => ({ status: 200, data: { state: 'pending' } })),
      now: () => (tick++ === 0 ? 0 : 60 * 60 * 1000),
    });
    const outcome = await generateOne(entry, 'claude-code-tmux', driver);
    expect(outcome.state).toBe('failed');
    expect((outcome as Extract<Outcome, { state: 'failed' }>).error).toMatch(/never reported a terminal state/);
  });
});

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    // Later items resolve sooner, so completion order is reversed from input order.
    const items = [0, 1, 2, 3, 4];
    const results = await mapWithConcurrency(items, 3, async (n) => {
      await new Promise((resolve) => setTimeout(resolve, (items.length - n) * 2));
      return n * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40]);
  });

  it('caps in-flight work at the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('propagates a rejection — containment is the caller\'s job, not the primitive\'s', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, (n) => (n === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(n))),
    ).rejects.toThrow('boom');
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

describe('runSeed — the on-ramp wiring', () => {
  // Stub the whole HTTP surface a wave touches, so runSeed's composition
  // (parseManifest -> fetchProviders -> chooseProvider -> login -> runWave -> summarize) is
  // exercised end to end without a server. A wiring regression fails here.
  const stubWave = (): void => {
    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/providers')) return Promise.resolve(new Response(JSON.stringify([{ id: 'p1' }]), { status: 200 }));
      if (url.endsWith('/session/login')) {
        return Promise.resolve(withCookies(302, ['tp_oauth_state=nonce'], { location: 'http://test.local/session/callback?code=c&state=nonce' }));
      }
      if (url.includes('/session/callback')) return Promise.resolve(withCookies(302, ['tp_session=sess'], { location: '/' }));
      if (url.endsWith('/session')) return Promise.resolve(withCookies(200, [], { body: { identity: { subject: 'dev' } } }));
      if (url.endsWith('/generations')) return Promise.resolve(new Response(JSON.stringify({ handle: { turnId: 't1' } }), { status: 201 }));
      if (url.endsWith('/poll')) return Promise.resolve(new Response(JSON.stringify({ state: 'ready', playgroundId: 'pg1' }), { status: 200 }));
      throw new Error(`unexpected fetch: ${url}`);
    });
  };

  it('drives a manifest through the full loop to exit code 0', async () => {
    stubWave();
    const config = { manifestPath: 'm.json', concurrency: 1, base: 'http://test.local' };
    const read = (): Promise<string> => Promise.resolve(JSON.stringify([{ type: 'design', description: 'a card' }]));
    await expect(runSeed(config, {}, read)).resolves.toBe(0);
  });

  it('returns exit code 1 when a brief fails in the loop', async () => {
    vi.stubGlobal('fetch', (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/providers')) return Promise.resolve(new Response(JSON.stringify([{ id: 'p1' }]), { status: 200 }));
      if (url.endsWith('/session/login')) {
        return Promise.resolve(withCookies(302, ['tp_oauth_state=nonce'], { location: 'http://test.local/session/callback?code=c&state=nonce' }));
      }
      if (url.includes('/session/callback')) return Promise.resolve(withCookies(302, ['tp_session=sess'], { location: '/' }));
      if (url.endsWith('/session')) return Promise.resolve(withCookies(200, [], { body: { identity: { subject: 'dev' } } }));
      if (url.endsWith('/generations')) return Promise.resolve(new Response(JSON.stringify({ handle: { turnId: 't1' } }), { status: 201 }));
      if (url.endsWith('/poll')) return Promise.resolve(new Response(JSON.stringify({ state: 'failed', error: 'generation timed out' }), { status: 200 }));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const config = { manifestPath: 'm.json', concurrency: 1, base: 'http://test.local' };
    const read = (): Promise<string> => Promise.resolve(JSON.stringify([{ type: 'design', description: 'a card' }]));
    await expect(runSeed(config, {}, read)).resolves.toBe(1);
  });
});
