import { readFile } from 'node:fs/promises';

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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
  if (header === undefined) throw new Error(`login: server did not set cookie ${name}`);
  const pair = header.split(';', 1)[0];
  if (pair === undefined || pair === `${name}=`) throw new Error(`login: cookie ${name} is empty`);
  return pair;
};

const expectStatus = async (response: Response, expected: number, what: string): Promise<void> => {
  if (response.status !== expected) {
    const body = await response.text();
    throw new Error(`${what}: expected HTTP ${expected}, got ${response.status}: ${body.slice(0, 300)}`);
  }
};

// The per-REQUEST transport deadline: connection-refused fails a fetch on its own, but
// a server that accepts TCP and never responds would hang it forever. This bounds one
// HTTP request's liveness and nothing more — the GENERATION deadline stays solely the
// server's; the two deadlines own different concerns and cannot disagree.
// [LAW:single-enforcer] [LAW:no-silent-failure]
const REQUEST_TIMEOUT_MS = 60 * 1000;

const request = (url: string, init: RequestInit): Promise<Response> =>
  fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

// Complete the session dance the browser performs: /session/login mints the CSRF state
// and redirects to the provider (the loopback provider redirects straight back), and
// the callback verifies state and mints the session cookie. The same round-trip as
// production, so seeding exercises the real write gate. [FRAMING:representation]
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
  const identity: unknown = await whoami.json();
  if (!isRecord(identity) || !isRecord(identity.identity)) {
    throw new Error(`login: session did not resolve an identity: ${JSON.stringify(identity)}`);
  }
  console.log(`logged in as ${String(identity.identity.subject)}`);
  return session;
};

// One JSON POST to the app, keyed to a logged-in session. The body is read once as text
// and parsed here, so a non-JSON error page (a proxy's HTML 502, a splash page) surfaces
// WITH its status and a snippet of what came back — never as a bare parse error that
// buries the real diagnosis. [LAW:no-silent-failure]
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
  const text = await response.text();
  try {
    return { status: response.status, data: JSON.parse(text) as unknown };
  } catch {
    throw new Error(`POST ${path}: HTTP ${response.status} returned non-JSON body: ${text.slice(0, 200)}`);
  }
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

// The client's LIVENESS backstop — deliberately NOT a generation deadline. The server is
// the single enforcer of how long a generation may take, and it always reports a terminal
// state within its own deadline; a client generation-deadline BELOW it would abandon a
// live turn (wave 1 lost a finished turn to exactly that). This ceiling sits FAR above any
// plausible server deadline, so it never fires for a working server — it trips only when a
// buggy server returns `pending` forever, turning a silent infinite loop into a loud
// failure. It is the loop-scope sibling of the per-request transport timeout.
// [LAW:no-silent-failure] [LAW:one-source-of-truth]
const POLL_CEILING_MS = 30 * 60 * 1000;

// Submit one brief and poll it to a terminal Outcome. Pure orchestration over the
// injected driver: it maps the wire responses onto the Outcome union and owns the
// poll loop, knowing nothing about fetch or timers. [LAW:effects-at-boundaries]
export const generateOne = async (entry: BriefEntry, driver: BriefDriver): Promise<Outcome> => {
  const submitted = await driver.post('/generations', {
    providerId: 'claude-code-tmux',
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
    if (polled.data.state === 'ready' && typeof polled.data.playgroundId === 'string') {
      return { state: 'ready', playgroundId: polled.data.playgroundId };
    }
    if (polled.data.state === 'failed') {
      // A failed poll SHOULD carry an error message; if the server omits it, say so
      // rather than stringify undefined into the literal "undefined", which a reader
      // cannot tell from a real message. [LAW:no-silent-failure]
      const message =
        polled.data.error === undefined
          ? `(server reported failed with no error message: ${JSON.stringify(polled.data)})`
          : String(polled.data.error);
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

// A fixed pool of workers draining one shared queue, each applying `generate` to the
// brief it picks up. Concurrency is a value and the generate step is a parameter, so this
// owns exactly one thing — the draining — asking nothing about how a brief becomes an
// outcome. [LAW:composability] [LAW:dataflow-not-control-flow]
export const runWave = async (
  entries: readonly BriefEntry[],
  concurrency: number,
  generate: (entry: BriefEntry) => Promise<Outcome>,
): Promise<readonly BriefResult[]> => {
  const results: BriefResult[] = new Array<BriefResult>(entries.length);
  // One iterator shared by all workers: each worker's for-of pulls the next [index, entry]
  // via a synchronous .next(), so the lock-free draining holds and `entry` is typed
  // BriefEntry — no `entries[index]` that could be undefined, hence no guard skipping an
  // impossible case. [LAW:no-defensive-null-guards] [LAW:dataflow-not-control-flow]
  const queue = entries.entries();
  const worker = async (): Promise<void> => {
    for (const [index, entry] of queue) {
      console.log(`[${index + 1}/${entries.length}] generating (${entry.type}): ${entry.description.slice(0, 80)}...`);
      // The one containment seam for a brief: ANY escape from its generate path — a
      // fetch rejection, a non-JSON body from a proxy, a parse throw — becomes THAT
      // brief's failed outcome, so one bad response can never reject the workers'
      // Promise.all and discard the whole wave's ledger. This protects the pool, so it
      // lives here rather than inside generate. Wave-level preconditions (manifest,
      // login) sit outside the workers and still fail the wave loudly.
      // [LAW:single-enforcer] [LAW:no-silent-failure]
      const outcome = await generate(entry).catch(
        (error: unknown): Outcome => ({
          state: 'failed',
          error: `transport: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
      results[index] = { entry, outcome };
      console.log(
        outcome.state === 'ready'
          ? `[${index + 1}/${entries.length}] ready: ${outcome.playgroundId} (${entry.type})`
          : `[${index + 1}/${entries.length}] FAILED (${entry.type}): ${outcome.error}`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return results;
};

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

// Derive the wave's config from argv + env, or throw a UsageError. Pure, so the argument
// contract (concurrency default and validation, base URL normalization) is verified
// without a process. [LAW:effects-at-boundaries]
export const resolveConfig = (argv: readonly string[], env: NodeJS.ProcessEnv): WaveConfig => {
  const manifestPath = argv[2];
  if (manifestPath === undefined) {
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
  const concurrency = concurrencyRaw === undefined || concurrencyRaw === '' ? 3 : Number(concurrencyRaw);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new UsageError(`concurrency must be a positive integer, got: ${String(concurrencyRaw)}`);
  }
  // Foreign input normalized once where it crosses the boundary: a trailing slash would
  // smear '//' into every concatenated path downstream. [LAW:single-enforcer]
  const base = (env.TINKERPAD_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
  return { manifestPath, concurrency, base };
};

// Run one wave end to end against a live server: validate the manifest, complete the
// login dance, drain the briefs, and return the exit code. The effects it needs (reading
// the manifest file, the real HTTP+clock driver) are threaded from the entry, so this
// orchestration stays free of process/global reaches. [LAW:effects-at-boundaries]
export const runSeed = async (
  config: WaveConfig,
  read: (path: string) => Promise<string>,
): Promise<number> => {
  const entries = parseManifest(await read(config.manifestPath), config.manifestPath);
  console.log(`seeding ${entries.length} briefs against ${config.base} (concurrency ${config.concurrency})`);

  const cookie = await login(config.base);
  const driver: BriefDriver = {
    post: (path, body) => postJson(config.base, cookie, path, body),
    delay,
    now: () => Date.now(),
  };
  const results = await runWave(entries, config.concurrency, (entry) => generateOne(entry, driver));
  return summarize(results);
};

// The real manifest reader, handed to runSeed by the entry. Kept here beside runSeed so
// the entry stays a pure wiring shell. [LAW:effects-at-boundaries]
export const readManifest = (path: string): Promise<string> => readFile(path, 'utf8');
