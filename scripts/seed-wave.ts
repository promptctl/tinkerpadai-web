import { readFile } from 'node:fs/promises';
import { DEFAULT_PORT, FRONT_DOOR_HOST } from '../src/web/frontDoorDefaults.js';
import { DEFAULT_GENERATION_POLICY } from '../src/api/index.js';

// THE SEEDING DRIVER CORE: turn a briefs manifest into commons playgrounds by driving
// the real public write path — loopback login, POST /generations, POST /poll — exactly
// as a browser session would. It deliberately knows nothing about storage, the catalog,
// or the provider: the HTTP surface is the only seam it touches, so seeding remains an
// honest stress test of the loop and works against any deployment stage reachable by
// URL. [LAW:effects-at-boundaries] [LAW:locality-or-seam]
//
// This module is the side-effect-free core: importing it runs nothing. The one place
// that reads argv/env and exits the process is the thin entry (scripts/seed.ts), so the
// core's behavior — manifest validation, the session dance, worker draining, the poll
// terminal enumeration — is importable and testable without a running server. The pieces
// that touch the world (HTTP, the clock) are injected at their callsite, never reached
// for as globals inside the logic. [LAW:effects-at-boundaries]
//
// The manifest is the single source of truth for a wave's content: this driver carries
// no briefs of its own and takes the manifest path as its one required argument, so
// the next wave is a new manifest, not a new mode. [LAW:one-source-of-truth]
// [LAW:no-mode-explosion]
//
// Exit codes are a contract: 0 = every brief became a playground; 1 = at least one
// brief failed (each failure is printed, and is a quality/providers finding to file).
// [LAW:no-silent-failure]

export const PLAYGROUND_TYPES = [
  'design',
  'data-explorer',
  'concept-map',
  'document-critique',
  'diff-review',
  'code-map',
] as const;
export type PlaygroundType = (typeof PLAYGROUND_TYPES)[number];

export interface BriefEntry {
  readonly type: PlaygroundType;
  readonly description: string;
}

// One brief's terminal outcome. Success carries the catalog id; failure carries the
// surfaced error — never an empty placeholder. [LAW:types-are-the-program]
export type Outcome =
  | { readonly state: 'ready'; readonly playgroundId: string }
  | { readonly state: 'failed'; readonly error: string };

export interface BriefResult {
  readonly entry: BriefEntry;
  readonly outcome: Outcome;
}

// A non-array object. Arrays are excluded so the Record<string, unknown> narrowing is honest —
// every callsite means "a JSON object", never an array. [LAW:types-are-the-program]
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPlaygroundType = (value: unknown): value is PlaygroundType =>
  typeof value === 'string' && (PLAYGROUND_TYPES as readonly string[]).includes(value);

// The manifest crosses a trust boundary (a file on disk); it is validated and shaped
// here, once, so everything downstream assumes a well-formed wave. [LAW:single-enforcer]
export const parseManifest = (raw: string, path: string): readonly BriefEntry[] => {
  // JSON.parse's SyntaxError names no file; rethrow with the path so a malformed
  // manifest is diagnosable exactly like every other validation error below, rather
  // than surfacing a bare parse error the reader must trace back to a file.
  // [FRAMING:representation] [LAW:no-silent-failure]
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`${path}: manifest must be a non-empty JSON array`);
  }
  return data.map((item: unknown, index) => {
    if (!isRecord(item)) throw new Error(`${path}[${index}]: entry must be an object`);
    if (!isPlaygroundType(item.type)) {
      throw new Error(`${path}[${index}]: type must be one of ${PLAYGROUND_TYPES.join(', ')}`);
    }
    if (typeof item.description !== 'string' || item.description.trim() === '') {
      throw new Error(`${path}[${index}]: description must be a non-empty string`);
    }
    return { type: item.type, description: item.description };
  });
};

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Extract one named cookie pair ("name=value") from Set-Cookie headers. A missing
// cookie is a protocol violation by the server, surfaced loudly. The prefix includes the
// '=' separator, and a cookie name cannot contain '=', so `startsWith("name=")` is an
// exact name match — tp_session is never confused with tp_session_v2.
// [LAW:no-silent-failure]
export const cookiePair = (setCookies: readonly string[], name: string): string => {
  const header = setCookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (header === undefined) throw new Error(`server did not set cookie ${name}`);
  // The name=value pair is everything up to the first attribute delimiter; indexOf+slice
  // always yields a definite string (no split()[0] that the type widens to possibly-undefined).
  const semicolon = header.indexOf(';');
  const pair = semicolon === -1 ? header : header.slice(0, semicolon);
  if (pair === `${name}=`) throw new Error(`cookie ${name} is empty`);
  return pair;
};

const expectStatus = async (response: Response, expected: number, what: string): Promise<void> => {
  if (response.status !== expected) {
    const body = await response.text();
    throw new Error(`${what}: expected HTTP ${expected}, got ${response.status}: ${body.slice(0, 300)}`);
  }
};

// The one place a response body becomes JSON: read it as text and parse here, so a non-JSON
// body (a proxy's HTML 502, a splash page) surfaces WITH its status and a snippet rather than
// a bare parse error that buries the diagnosis. Every JSON read goes through this.
// [LAW:single-enforcer] [LAW:no-silent-failure]
const readJsonBody = async (response: Response, what: string): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${what}: HTTP ${response.status} returned non-JSON body: ${text.slice(0, 200)}`);
  }
};

// The per-REQUEST transport deadline: connection-refused fails a fetch on its own, but
// a server that accepts TCP and never responds would hang it forever. This bounds one
// HTTP request's liveness and nothing more — the GENERATION deadline stays solely the
// server's; the two deadlines own different concerns and cannot disagree.
// [LAW:single-enforcer] [LAW:no-silent-failure]
const REQUEST_TIMEOUT_MS = 60 * 1000;

// The signal is the function's to set — it always installs the transport timeout — so the
// parameter type excludes signal rather than accepting one it would silently discard.
// [LAW:types-are-the-program]
const request = (url: string, init: Omit<RequestInit, 'signal'>): Promise<Response> =>
  fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

// Complete the session dance the browser performs: /session/login mints the CSRF state
// and redirects to the provider (the loopback provider redirects straight back), and
// the callback verifies state and mints the session cookie. The same round-trip as
// production, so seeding exercises the real write gate. [FRAMING:representation]
// One session is minted here and shared across the whole wave; this assumes the server's
// session lifetime exceeds the wave's duration (the dev TTL is 6h, far beyond even a
// hundred-brief wave). If a session ever did expire mid-wave, each remaining brief fails
// loudly on its 401 rather than silently — the wave is never left in a false-success state.
// [LAW:no-silent-failure]
export const login = async (base: string): Promise<string> => {
  const start = await request(`${base}/session/login`, { redirect: 'manual' });
  await expectStatus(start, 302, 'GET /session/login');
  const location = start.headers.get('location');
  if (location === null) throw new Error('login: redirect carried no location header');
  const stateCookie = cookiePair(start.headers.getSetCookie(), 'tp_oauth_state');

  const callback = await request(location, { redirect: 'manual', headers: { cookie: stateCookie } });
  await expectStatus(callback, 302, 'GET /session/callback');
  const session = cookiePair(callback.headers.getSetCookie(), 'tp_session');

  const whoami = await request(`${base}/session`, { headers: { cookie: session } });
  await expectStatus(whoami, 200, 'GET /session');
  const identity: unknown = await readJsonBody(whoami, 'GET /session');
  // Require the subject the log and the session depend on, not merely that identity is an
  // object — otherwise {identity:{}} passes and logs "logged in as undefined". [LAW:no-silent-failure]
  if (!isRecord(identity) || !isRecord(identity.identity) || typeof identity.identity.subject !== 'string') {
    throw new Error(`login: session did not resolve an identity with a subject: ${JSON.stringify(identity)}`);
  }
  console.log(`logged in as ${identity.identity.subject}`);
  return session;
};

// One JSON POST to the app, keyed to a logged-in session. The response body is read through
// readJsonBody, so a non-JSON error page surfaces with its status and a snippet.
export const postJson = async (
  base: string,
  cookie: string,
  path: string,
  body: unknown,
): Promise<{ readonly status: number; readonly data: unknown }> => {
  const response = await request(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await readJsonBody(response, `POST ${path}`) };
};

// The world-touching seam one brief drives: an HTTP POST, the poll clock (delay), and a
// wall clock (now). Injected so generateOne is pure orchestration over them — a test
// scripts `post`, passes a no-op `delay`, and drives `now` to exercise the terminal
// enumeration and the liveness ceiling without a server or real waits.
// [LAW:effects-at-boundaries]
export interface BriefDriver {
  readonly post: (path: string, body: unknown) => Promise<{ readonly status: number; readonly data: unknown }>;
  readonly delay: (ms: number) => Promise<void>;
  readonly now: () => number;
}

// Client-side pacing between polls; the server additionally paces a running poll, so this
// loop never spins. [LAW:single-enforcer]
const POLL_INTERVAL_MS = 2000;

// The client's LIVENESS backstop — deliberately NOT a generation deadline. The server is the single
// enforcer of how long a generation may take, and it always reports a terminal state within its own
// bound; a client deadline BELOW that would abandon a live turn (wave 1 lost a finished turn to
// exactly that). The server's worst case is its RETRY budget times its per-attempt deadline
// (quality-ppu.2 added transparent retry, so a request that uses every attempt keeps reporting
// `running` for the sum). It is DERIVED from DEFAULT_GENERATION_POLICY rather than hardcoded, so the
// backstop tracks the same defaults the server ships with — change a default and the ceiling follows,
// never silently drifting to zero margin. The margin covers per-attempt startup/settle overhead and a
// deploy that widened one env override above the default. It trips only when a buggy server returns
// `pending` forever, turning a silent infinite loop into a loud failure — the loop-scope sibling of
// the per-request transport timeout. [LAW:no-silent-failure] [LAW:one-source-of-truth]
const POLL_CEILING_MARGIN = 1.5;
const POLL_CEILING_MS = DEFAULT_GENERATION_POLICY.timeoutMs * DEFAULT_GENERATION_POLICY.maxAttempts * POLL_CEILING_MARGIN;

// Submit one brief against a chosen provider and poll it to a terminal Outcome. Pure
// orchestration over the injected driver: it maps the wire responses onto the Outcome
// union and owns the poll loop, knowing nothing about fetch or timers. The providerId is
// a value threaded in (discovered from the server, never hardcoded), so this body does
// not mirror the app's provider registry. [LAW:effects-at-boundaries] [LAW:one-source-of-truth]
export const generateOne = async (
  entry: BriefEntry,
  providerId: string,
  driver: BriefDriver,
): Promise<Outcome> => {
  const submitted = await driver.post('/generations', {
    providerId,
    brief: { description: entry.description },
  });
  if (submitted.status !== 201 || !isRecord(submitted.data) || !isRecord(submitted.data.handle)) {
    return { state: 'failed', error: `submit: HTTP ${submitted.status}: ${JSON.stringify(submitted.data)}` };
  }
  const handle = submitted.data.handle;
  // The handle is the only key to a live turn; print it so a wave interrupted at the
  // client (crash, ctrl-C) can still be recovered by polling the handle by hand — a
  // turn's store+catalog write happens on the first poll that observes success.
  // [LAW:no-silent-failure]
  console.log(`  handle: ${JSON.stringify(handle)}`);

  const ceiling = driver.now() + POLL_CEILING_MS;
  for (;;) {
    if (driver.now() > ceiling) {
      return { state: 'failed', error: `poll: server never reported a terminal state within ${POLL_CEILING_MS}ms` };
    }
    const polled = await driver.post('/poll', { handle });
    if (polled.status !== 200 || !isRecord(polled.data) || typeof polled.data.state !== 'string') {
      return { state: 'failed', error: `poll: HTTP ${polled.status}: ${JSON.stringify(polled.data)}` };
    }
    if (polled.data.state === 'ready' && typeof polled.data.playgroundId === 'string' && polled.data.playgroundId !== '') {
      return { state: 'ready', playgroundId: polled.data.playgroundId };
    }
    if (polled.data.state === 'failed') {
      // A failed poll SHOULD carry a string error message; if it is missing or not a string,
      // emit the whole payload rather than stringify it into "undefined"/"[object Object]",
      // which a reader cannot tell from a real message. One check covers both. [LAW:no-silent-failure]
      const message =
        typeof polled.data.error === 'string'
          ? polled.data.error
          : `(server reported failed with a non-string error: ${JSON.stringify(polled.data)})`;
      return { state: 'failed', error: message };
    }
    // The known non-terminal states are the ONLY continue path; anything else — a
    // 'ready' missing its playgroundId, a state this client does not know — is a
    // protocol mismatch that fails this brief loudly rather than spinning forever.
    // [LAW:no-silent-failure] [LAW:types-are-the-program]
    if (polled.data.state !== 'pending' && polled.data.state !== 'running') {
      return { state: 'failed', error: `poll: unexpected response shape: ${JSON.stringify(polled.data)}` };
    }
    await driver.delay(POLL_INTERVAL_MS);
  }
};

// The reusable concurrency primitive: apply `fn` to every item with at most `concurrency`
// in flight, returning the results in INPUT order. All workers share the ONE `queue` iterator,
// so each for-of pulls the next [index, item] via a synchronous .next() — lock-free draining,
// and `item` is typed T, never a possibly-undefined indexed access. The sharing is load-bearing:
// a worker must iterate `queue`, never a fresh `items.entries()`, or each worker would get its
// own copy and process every item N times. Results are pushed into a dense (append-only, never
// sparse) array and reordered by index at the end, so the R[] type never describes a hole. It
// knows nothing about what fn does; if fn rejects, that rejection propagates (the caller owns any
// per-item containment). [LAW:composability] [LAW:decomposition] [LAW:types-are-the-program]
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> => {
  // A general primitive defends its own contract: 0 (or less) would spawn no workers and
  // return [] — silent data loss — so it fails loudly instead. [LAW:no-silent-failure]
  if (concurrency < 1) {
    throw new Error(`mapWithConcurrency: concurrency must be >= 1, got ${concurrency}`);
  }
  const collected: { readonly index: number; readonly result: R }[] = [];
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) {
      collected.push({ index, result: await fn(item, index) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return collected.sort((a, b) => a.index - b.index).map((entry) => entry.result);
};

// Drain a wave's briefs through mapWithConcurrency, supplying the brief-specific mapper:
// progress logging and the containment seam. The try/catch is the one place ANY escape from a
// brief's generate path — a synchronous throw OR an async rejection (a fetch failure, a
// non-JSON proxy body, a parse throw) — becomes THAT brief's failed outcome, so one bad
// response can never reject the pool and discard the wave's ledger. try/catch (not
// generate(entry).catch) is deliberate: it also contains a synchronous throw, which .catch
// would miss because the throw escapes before .catch attaches. Containment lives here (the
// caller), not in the generic primitive, and not in generate; wave-level preconditions
// (manifest, login) sit outside and still fail the wave loudly.
// [LAW:single-enforcer] [LAW:no-silent-failure]
export const runWave = (
  entries: readonly BriefEntry[],
  concurrency: number,
  generate: (entry: BriefEntry) => Promise<Outcome>,
): Promise<readonly BriefResult[]> =>
  mapWithConcurrency(entries, concurrency, async (entry, index): Promise<BriefResult> => {
    console.log(`[${index + 1}/${entries.length}] generating (${entry.type}): ${entry.description.slice(0, 80)}...`);
    let outcome: Outcome;
    try {
      outcome = await generate(entry);
    } catch (error) {
      outcome = { state: 'failed', error: `transport: ${error instanceof Error ? error.message : String(error)}` };
    }
    console.log(
      outcome.state === 'ready'
        ? `[${index + 1}/${entries.length}] ready: ${outcome.playgroundId} (${entry.type})`
        : `[${index + 1}/${entries.length}] FAILED (${entry.type}): ${outcome.error}`,
    );
    return { entry, outcome };
  });

// The wave's summary and exit code: 0 iff every brief became a playground. Pure over the
// results — it prints the per-type tally and each failure, and returns the code the entry
// exits with. [LAW:no-silent-failure]
export const summarize = (results: readonly BriefResult[]): number => {
  const ready = results.filter((result) => result.outcome.state === 'ready');
  const failed = results.filter(
    (result): result is BriefResult & { outcome: Extract<Outcome, { state: 'failed' }> } =>
      result.outcome.state === 'failed',
  );
  console.log(`\nwave complete: ${ready.length}/${results.length} playgrounds created`);
  for (const type of PLAYGROUND_TYPES) {
    const count = ready.filter((result) => result.entry.type === type).length;
    console.log(`  ${type}: ${count}`);
  }
  for (const failure of failed) {
    console.log(`  FAILED (${failure.entry.type}): ${failure.entry.description.slice(0, 80)}...`);
    console.log(`    ${failure.outcome.error}`);
  }
  return failed.length === 0 ? 0 : 1;
};

export interface WaveConfig {
  readonly manifestPath: string;
  readonly concurrency: number;
  readonly base: string;
}

// A usage/validation failure of the invocation itself (bad args, bad env). Typed so the
// entry maps it to exit code 2 — distinct from a wave that ran but had failures (1) or a
// mid-run fault (1). [LAW:types-are-the-program]
export class UsageError extends Error {}

// The default number of briefs generated at once when concurrency is unspecified — the one
// source of that default, named like the other config defaults rather than inlined. [LAW:one-source-of-truth]
export const DEFAULT_CONCURRENCY = 3;

// Derive the wave's config from argv + env, or throw a UsageError. Pure, so the argument
// contract (concurrency default and validation, base URL normalization) is verified
// without a process. [LAW:effects-at-boundaries]
export const resolveConfig = (argv: readonly string[], env: NodeJS.ProcessEnv): WaveConfig => {
  // Absent OR empty is a missing manifest path — an empty string would otherwise slip into
  // readFile('') as an opaque failure instead of the usage message. [LAW:no-silent-failure]
  const manifestPath = argv[2];
  if (manifestPath === undefined || manifestPath === '') {
    throw new UsageError('usage: tsx scripts/seed.ts <briefs-manifest.json> [concurrency]');
  }
  // Concurrency unspecified — absent, or the empty string — uses the default; the fallback
  // here is the single source of that default. Treating '' as unspecified makes the result
  // independent of whether a given `just` version omits the empty default token or passes
  // it through as '', so `just seed <manifest>` yields 3 either way. [LAW:one-source-of-truth]
  // Number(), not parseInt, for a supplied value: parseInt('7foo')=7 and parseInt('3.14')=3
  // would slip garbage and floats past the guard as a silently-wrong concurrency; Number()
  // yields NaN/3.14, both of which the isSafeInteger check rejects loudly. [LAW:no-silent-failure]
  const concurrencyRaw = argv[3];
  const concurrency =
    concurrencyRaw === undefined || concurrencyRaw === '' ? DEFAULT_CONCURRENCY : Number(concurrencyRaw);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new UsageError(`concurrency must be a positive integer, got: ${String(concurrencyRaw)}`);
  }
  // Foreign input canonicalized once where it crosses the boundary: the base must be an
  // ORIGIN (scheme://host:port), since every route below is concatenated onto it root-relative
  // (`${base}/session/login`). new URL(..).origin drops any path and trailing slashes and
  // throws on a malformed URL — so junk fails loudly here rather than silently routing to the
  // wrong endpoint. The default's host and port derive from the server's own constants so the
  // seeder's default origin tracks the front door. [LAW:single-enforcer] [LAW:no-silent-failure]
  const rawUrl = env.TINKERPAD_URL ?? `http://${FRONT_DOOR_HOST}:${DEFAULT_PORT}`;
  let base: string;
  try {
    base = new URL(rawUrl).origin;
  } catch {
    throw new UsageError(`TINKERPAD_URL is not a valid URL: ${rawUrl}`);
  }
  return { manifestPath, concurrency, base };
};

// The server's provider registry is the single source of truth for which providers exist;
// the seeder reads it rather than mirroring app.ts's default id. Choosing among the list is
// PURE, so the selection contract is verified without a server: zero providers is a loud
// misconfiguration; an explicit TINKERPAD_PROVIDER must be one the server actually offers;
// a lone provider is used unasked; genuine ambiguity fails loudly rather than guessing.
// [LAW:one-source-of-truth] [LAW:no-silent-failure]
export const chooseProvider = (
  providers: readonly { readonly id: string }[],
  env: NodeJS.ProcessEnv,
): string => {
  const ids = providers.map((provider) => provider.id);
  if (ids.length === 0) {
    throw new Error('the server exposes no providers to generate with (GET /providers was empty)');
  }
  const configured = env.TINKERPAD_PROVIDER;
  if (configured !== undefined) {
    if (!ids.includes(configured)) {
      throw new Error(`TINKERPAD_PROVIDER=${configured} is not among the server's providers: ${ids.join(', ')}`);
    }
    return configured;
  }
  if (ids.length === 1) return ids[0] as string;
  throw new Error(`the server exposes multiple providers (${ids.join(', ')}); set TINKERPAD_PROVIDER to choose one`);
};

// The effect behind chooseProvider: read the server's provider list from the credential-free
// GET /providers — the same surface the front door reads. [LAW:effects-at-boundaries]
export const fetchProviders = async (base: string): Promise<readonly { readonly id: string }[]> => {
  const response = await request(`${base}/providers`, { headers: { accept: 'application/json' } });
  await expectStatus(response, 200, 'GET /providers');
  const data: unknown = await readJsonBody(response, 'GET /providers');
  if (!Array.isArray(data)) throw new Error(`GET /providers: expected a JSON array, got ${JSON.stringify(data)}`);
  return data.map((provider: unknown, index) => {
    if (!isRecord(provider) || typeof provider.id !== 'string') {
      throw new Error(`GET /providers[${index}]: provider has no string id: ${JSON.stringify(provider)}`);
    }
    return { id: provider.id };
  });
};

// Run one wave end to end against a live server: validate the manifest, discover the
// provider from the server, complete the login dance, drain the briefs, and return the exit
// code. The effects it needs (reading the manifest file, discovering providers, the real
// HTTP+clock driver) are threaded from the entry, so this orchestration stays free of
// process/global reaches. [LAW:effects-at-boundaries]
export const runSeed = async (
  config: WaveConfig,
  env: NodeJS.ProcessEnv,
  read: (path: string) => Promise<string>,
): Promise<number> => {
  const entries = parseManifest(await read(config.manifestPath), config.manifestPath);
  const providerId = chooseProvider(await fetchProviders(config.base), env);
  console.log(
    `seeding ${entries.length} briefs against ${config.base} via ${providerId} (concurrency ${config.concurrency})`,
  );

  const cookie = await login(config.base);
  const driver: BriefDriver = {
    post: (path, body) => postJson(config.base, cookie, path, body),
    delay,
    now: () => Date.now(),
  };
  const results = await runWave(entries, config.concurrency, (entry) => generateOne(entry, providerId, driver));
  return summarize(results);
};

// The real manifest reader, handed to runSeed by the entry. Kept here beside runSeed so
// the entry stays a pure wiring shell. [LAW:effects-at-boundaries]
export const readManifest = (path: string): Promise<string> => readFile(path, 'utf8');
