import { readFile } from 'node:fs/promises';

// THE SEEDING DRIVER: turn a briefs manifest into commons playgrounds by driving the
// real public write path — loopback login, POST /generations, POST /poll — exactly as
// a browser session would. It deliberately knows nothing about storage, the catalog,
// or the provider: the HTTP surface is the only seam it touches, so seeding remains an
// honest stress test of the loop and works against any deployment stage reachable by
// URL. [LAW:effects-at-boundaries] [LAW:locality-or-seam]
//
// The manifest is the single source of truth for a wave's content: this driver carries
// no briefs of its own and takes the manifest path as its one required argument, so
// the next wave is a new manifest, not a new mode. [LAW:one-source-of-truth]
// [LAW:no-mode-explosion]
//
// Exit codes are a contract: 0 = every brief became a playground; 1 = at least one
// brief failed (each failure is printed, and is a quality/providers finding to file).
// [LAW:no-silent-failure]

const PLAYGROUND_TYPES = [
  'design',
  'data-explorer',
  'concept-map',
  'document-critique',
  'diff-review',
  'code-map',
] as const;
type PlaygroundType = (typeof PLAYGROUND_TYPES)[number];

interface BriefEntry {
  readonly type: PlaygroundType;
  readonly description: string;
}

// One brief's terminal outcome. Success carries the catalog id; failure carries the
// surfaced error — never an empty placeholder. [LAW:types-are-the-program]
type Outcome =
  | { readonly state: 'ready'; readonly playgroundId: string }
  | { readonly state: 'failed'; readonly error: string };

interface BriefResult {
  readonly entry: BriefEntry;
  readonly outcome: Outcome;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isPlaygroundType = (value: unknown): value is PlaygroundType =>
  typeof value === 'string' && (PLAYGROUND_TYPES as readonly string[]).includes(value);

// The manifest crosses a trust boundary (a file on disk); it is validated and shaped
// here, once, so everything downstream assumes a well-formed wave. [LAW:single-enforcer]
const parseManifest = (raw: string, path: string): readonly BriefEntry[] => {
  const data: unknown = JSON.parse(raw);
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Extract one named cookie pair ("name=value") from Set-Cookie headers. A missing
// cookie is a protocol violation by the server, surfaced loudly. [LAW:no-silent-failure]
const cookiePair = (setCookies: readonly string[], name: string): string => {
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

// Complete the session dance the browser performs: /session/login mints the CSRF state
// and redirects to the provider (the loopback provider redirects straight back), and
// the callback verifies state and mints the session cookie. The same round-trip as
// production, so seeding exercises the real write gate. [FRAMING:representation]
// The per-REQUEST transport deadline: connection-refused fails a fetch on its own, but
// a server that accepts TCP and never responds would hang it forever. This bounds one
// HTTP request's liveness and nothing more — the GENERATION deadline stays solely the
// server's; the two deadlines own different concerns and cannot disagree.
// [LAW:single-enforcer] [LAW:no-silent-failure]
const REQUEST_TIMEOUT_MS = 60 * 1000;

const request = (url: string, init: RequestInit): Promise<Response> =>
  fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

const login = async (base: string): Promise<string> => {
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

const postJson = async (
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
  // Read the body once as text and parse it here, so a non-JSON error page (a proxy's
  // HTML 502, a splash page) surfaces WITH its status and a snippet of what came back —
  // never as a bare parse error that buries the real diagnosis. [LAW:no-silent-failure]
  const text = await response.text();
  try {
    return { status: response.status, data: JSON.parse(text) as unknown };
  } catch {
    throw new Error(`POST ${path}: HTTP ${response.status} returned non-JSON body: ${text.slice(0, 200)}`);
  }
};

// Client-side pacing between polls; the server additionally paces a running poll, so
// this loop never spins. There is deliberately NO client-side deadline: the driver is
// the single enforcer of the generation deadline and always reports a terminal state
// within it, while a dead or misbehaving server already surfaces loudly as a failed
// fetch or a malformed poll response. A second, independent deadline here could only
// disagree with the real one — wave 1 lost a finished turn to exactly that.
// [LAW:single-enforcer] [LAW:one-source-of-truth] [LAW:no-silent-failure]
const POLL_INTERVAL_MS = 2000;

const generateOne = async (base: string, cookie: string, entry: BriefEntry): Promise<Outcome> => {
  const submitted = await postJson(base, cookie, '/generations', {
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

  for (;;) {
    const polled = await postJson(base, cookie, '/poll', { handle });
    if (polled.status !== 200 || !isRecord(polled.data) || typeof polled.data.state !== 'string') {
      return { state: 'failed', error: `poll: HTTP ${polled.status}: ${JSON.stringify(polled.data)}` };
    }
    if (polled.data.state === 'ready' && typeof polled.data.playgroundId === 'string') {
      return { state: 'ready', playgroundId: polled.data.playgroundId };
    }
    if (polled.data.state === 'failed') {
      return { state: 'failed', error: String(polled.data.error) };
    }
    // The known non-terminal states are the ONLY continue path; anything else — a
    // 'ready' missing its playgroundId, a state this client does not know — is a
    // protocol mismatch that fails this brief loudly rather than spinning forever.
    // [LAW:no-silent-failure] [LAW:types-are-the-program]
    if (polled.data.state !== 'pending' && polled.data.state !== 'running') {
      return { state: 'failed', error: `poll: unexpected response shape: ${JSON.stringify(polled.data)}` };
    }
    await delay(POLL_INTERVAL_MS);
  }
};

// A fixed pool of workers draining one shared queue: concurrency is a value, and each
// brief runs the identical submit→poll path regardless of which worker picks it up.
// [LAW:dataflow-not-control-flow] [LAW:one-type-per-behavior]
const runWave = async (
  base: string,
  cookie: string,
  entries: readonly BriefEntry[],
  concurrency: number,
): Promise<readonly BriefResult[]> => {
  const results: BriefResult[] = new Array<BriefResult>(entries.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= entries.length) return;
      const entry = entries[index];
      if (entry === undefined) return;
      console.log(`[${index + 1}/${entries.length}] generating (${entry.type}): ${entry.description.slice(0, 80)}...`);
      // The one containment seam for a brief: ANY escape from its submit/poll path — a
      // fetch rejection, a non-JSON body from a proxy, a parse throw — becomes THAT
      // brief's failed outcome, so one bad response can never reject the workers'
      // Promise.all and discard the whole wave's ledger. Wave-level preconditions
      // (manifest, login) sit outside the workers and still fail the wave loudly.
      // [LAW:single-enforcer] [LAW:no-silent-failure]
      const outcome = await generateOne(base, cookie, entry).catch(
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

const summarize = (results: readonly BriefResult[]): number => {
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

const main = async (): Promise<void> => {
  const manifestPath = process.argv[2];
  if (manifestPath === undefined) {
    console.error('usage: tsx scripts/seed-wave.ts <briefs-manifest.json> [concurrency]');
    process.exit(2);
  }
  const concurrencyRaw = process.argv[3];
  const concurrency = concurrencyRaw === undefined ? 3 : Number.parseInt(concurrencyRaw, 10);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    console.error(`concurrency must be a positive integer, got: ${String(concurrencyRaw)}`);
    process.exit(2);
  }
  // Foreign input normalized once where it crosses the boundary: a trailing slash
  // would smear '//' into every concatenated path downstream. [LAW:single-enforcer]
  const base = (process.env.TINKERPAD_URL ?? 'http://localhost:8787').replace(/\/+$/, '');

  const entries = parseManifest(await readFile(manifestPath, 'utf8'), manifestPath);
  console.log(`seeding ${entries.length} briefs against ${base} (concurrency ${concurrency})`);

  const cookie = await login(base);
  const results = await runWave(base, cookie, entries, concurrency);
  process.exit(summarize(results));
};

main().catch((error: unknown) => {
  console.error('seed wave failed:', error);
  process.exit(1);
});
