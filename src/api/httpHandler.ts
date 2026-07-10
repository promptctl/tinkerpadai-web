import type { Brief, GenerationRequest, SessionHandle } from '../provider/index.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import { PlaygroundId, PlaygroundNotFoundError } from '../storage/index.js';
import type { GenerationService } from './generationService.js';
import { ProviderCannotContinueError, ProviderCannotForkError } from './generationService.js';
import { QuotaExceededError } from './generationQuota.js';
import type { ReportService } from './reportService.js';
import type { Subject } from '../identity/index.js';
import type { IdentityResolver } from './identity.js';

// THE HTTP SURFACE the front door calls (p0v.5). A runtime-agnostic Web fetch handler —
// (Request) => Promise<Response> — so it runs on a Node server, a Cloudflare Worker, or
// in a test by simply calling it with a Request; binding an actual socket is a deploy
// concern kept OUT of this layer. [LAW:effects-at-boundaries] It is a thin translation:
// parse/validate the request at this trust boundary, call the service, serialize the
// result. All the orchestration lives in the service, so this stays dumb.

// Validation failures at the trust boundary. Distinct from service errors so the handler
// maps them to 400 (bad request) without inspecting message strings. [LAW:single-enforcer]
class BadRequest extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value === '') {
    throw new BadRequest(`missing or empty field: ${field}`);
  }
  return value;
};

// The single place that validates and brands an incoming generation request. The branded
// ids are erased at runtime, so foreign JSON must be re-branded here, at the boundary —
// the one enforcer of the request's shape. [LAW:single-enforcer]
const parseGenerationRequest = (body: unknown): GenerationRequest => {
  if (!isRecord(body)) throw new BadRequest('body must be a JSON object');
  if (!isRecord(body.brief)) throw new BadRequest('missing field: brief');
  return {
    providerId: ProviderId(requireString(body.providerId, 'providerId')),
    brief: { description: requireString(body.brief.description, 'brief.description') },
  };
};

// The single place that validates and brands an incoming continue request. Symmetric with
// parseGenerationRequest: foreign JSON crosses the trust boundary here and only here, where
// the playgroundId is re-branded (its runtime brand was erased over the wire). The body
// names the target playground instead of a provider — continue resolves the provider from
// the playground's session, so the caller never restates it. [LAW:single-enforcer]
const parseContinueRequest = (body: unknown): { playgroundId: PlaygroundId; brief: Brief } => {
  if (!isRecord(body)) throw new BadRequest('body must be a JSON object');
  if (!isRecord(body.brief)) throw new BadRequest('missing field: brief');
  return {
    playgroundId: PlaygroundId(requireString(body.playgroundId, 'playgroundId')),
    brief: { description: requireString(body.brief.description, 'brief.description') },
  };
};

// The single place that validates and brands an incoming fork request. It names ONLY the
// parent playground to branch from — no brief, unlike parseContinueRequest. A fork carries
// no follow-up: the service derives the new playground's first-turn prompt from the parent's
// original describe, so the body restating one would be a second source of truth for it.
// 'Remix with a tweak' is a continue() onto the resulting fork, a separate call with its own
// brief — not a field folded in here. [LAW:single-enforcer] [LAW:one-source-of-truth]
const parseForkRequest = (body: unknown): { playgroundId: PlaygroundId } => {
  if (!isRecord(body)) throw new BadRequest('body must be a JSON object');
  return { playgroundId: PlaygroundId(requireString(body.playgroundId, 'playgroundId')) };
};

// The longest reason a report may carry. A cap at the trust boundary so a hostile client cannot post
// a multi-megabyte "reason" that bloats the reports document every reviewer then loads — the
// signal-quality equivalent of rejecting an empty field. Generous enough that a real explanation is
// never truncated. [LAW:no-silent-failure]
const MAX_REASON_LENGTH = 2000;

// The single place that validates and brands an incoming report request. Symmetric with the parsers
// above: foreign JSON crosses the trust boundary here and only here, where the playgroundId is
// re-branded (its runtime brand was erased over the wire) and the reason is checked non-empty and
// bounded. The reporter is NOT in the body — it is the authenticated Subject the write gate resolves,
// so a client cannot forge who raised a report. [LAW:single-enforcer] [LAW:types-are-the-program]
const parseReportRequest = (body: unknown): { playgroundId: PlaygroundId; reason: string } => {
  if (!isRecord(body)) throw new BadRequest('body must be a JSON object');
  // Trim at the boundary and store the trimmed value: the server enforces non-empty INDEPENDENTLY of
  // the client's own trim(), so a direct POST of "   " is semantically empty signal and rejected here
  // rather than sailing through because the browser happened to trim first. The cap applies to the
  // stored (trimmed) reason. [LAW:single-enforcer]
  const reason = requireString(body.reason, 'reason').trim();
  if (reason === '') throw new BadRequest('missing or empty field: reason');
  if (reason.length > MAX_REASON_LENGTH) throw new BadRequest(`reason exceeds ${MAX_REASON_LENGTH} characters`);
  return {
    playgroundId: PlaygroundId(requireString(body.playgroundId, 'playgroundId')),
    reason,
  };
};

// The single place that validates and brands an incoming handle (what `poll` receives).
const parseHandle = (body: unknown): SessionHandle => {
  if (!isRecord(body)) throw new BadRequest('body must be a JSON object');
  if (!isRecord(body.handle)) throw new BadRequest('missing field: handle');
  const handle = body.handle;
  return {
    providerId: ProviderId(requireString(handle.providerId, 'handle.providerId')),
    sessionId: SessionId(requireString(handle.sessionId, 'handle.sessionId')),
    turnId: TurnId(requireString(handle.turnId, 'handle.turnId')),
  };
};

const readJson = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new BadRequest('body is not valid JSON');
  }
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// The write path: every route that drives generation or performs the store+catalog write
// (POST /poll's first success observation). Membership in this set is the SINGLE source of
// truth for "this route requires an authenticated identity"; the read/use path (GET /providers,
// /availability — and the separate content origin) is absent and stays credential-free. Adding
// a write route means adding it here, not adding another auth check at a callsite.
// [LAW:single-enforcer] [LAW:one-source-of-truth]
const WRITE_ROUTES: ReadonlySet<string> = new Set([
  'POST /generations',
  'POST /generations/continue',
  'POST /generations/fork',
  'POST /poll',
  'POST /reports',
]);

export const makeHttpHandler = (
  service: GenerationService,
  reports: ReportService,
  resolveIdentity: IdentityResolver,
): ((request: Request) => Promise<Response>) => {
  // The credential-free read/use path: providers and the live availability toggle. No identity
  // is resolved for these, so this dispatch never receives one — the read path stays
  // credential-free by construction, not by a runtime check. An unmapped read is a 404.
  const handleRead = async (route: string, request: Request): Promise<Response> => {
    switch (route) {
      case 'GET /providers':
        return json(service.listProviders());
      // A live availability read for the generation toggle. GET, not POST: it mutates
      // nothing (unlike /poll, whose first success observation performs the store+catalog
      // write), so it is safe and cacheless-by-default. The providerId rides as a query
      // value and is branded here, at the trust boundary — the one place foreign input
      // becomes a ProviderId. [LAW:single-enforcer]
      case 'GET /availability': {
        const providerId = ProviderId(requireString(new URL(request.url).searchParams.get('providerId'), 'providerId'));
        return json(await service.availabilityOf(providerId));
      }
      default:
        return json({ error: `no route: ${route}` }, 404);
    }
  };

  // The write/generation path. It is reached ONLY past the single guard below, so `author` is a
  // resolved Subject by TYPE, not by folklore — the create paths (submit, fork) record it as the
  // new playground's author, while continue/poll act on a turn whose author was captured at
  // create time and so take none. [LAW:types-are-the-program] [LAW:single-enforcer]
  const handleWrite = async (route: string, request: Request, author: Subject): Promise<Response> => {
    switch (route) {
      case 'POST /generations': {
        const handle = await service.submit(parseGenerationRequest(await readJson(request)), author);
        return json({ handle }, 201);
      }
      // The continue path: a follow-up brief onto an existing playground. Symmetric with
      // POST /generations — it returns a fresh SessionHandle (201) the client drives with
      // the EXISTING POST /poll; no new poll surface. continue resolves and rejects the
      // target (unknown playground, non-iterable provider) synchronously before any handle
      // exists, so the catch below maps those failures and there is no half-state to poll.
      case 'POST /generations/continue': {
        const { playgroundId, brief } = parseContinueRequest(await readJson(request));
        // `author` here is the resolved requester the write gate produced — continue takes it as
        // this turn's quota subject, not as an author (the playground keeps its own author).
        const handle = await service.continue(playgroundId, brief, author);
        return json({ handle }, 201);
      }
      // The fork path: branch an existing playground at its current version into a NEW,
      // independent session. Symmetric with POST /generations/continue — returns a fresh
      // SessionHandle (201) the client drives with the EXISTING POST /poll; no new poll
      // surface. fork takes no brief (see parseForkRequest). It resolves and rejects the
      // target (unknown playground -> 404, non-forkable provider -> 422) synchronously
      // before any handle exists, so the catch maps those and there is no half-state to poll.
      case 'POST /generations/fork': {
        const { playgroundId } = parseForkRequest(await readJson(request));
        const handle = await service.fork(playgroundId, author);
        return json({ handle }, 201);
      }
      // POST, not GET: a poll is not safe — the first observation of a succeeded turn
      // performs the store+catalog write — so it must not be treated as cacheable.
      case 'POST /poll':
        return json(await service.poll(parseHandle(await readJson(request))));
      // The report path: record a moderation signal against a playground. It rides the SAME single
      // write gate as generation (WRITE_ROUTES above), so the reporter is the resolved `author`
      // Subject — the authenticated principal, never a client-supplied field — recorded exactly as a
      // playground's author is. An unknown playground surfaces the service's PlaygroundNotFoundError,
      // mapped to 404 by the catch below like continue/fork. 201: the signal is now durably recorded.
      case 'POST /reports': {
        const { playgroundId, reason } = parseReportRequest(await readJson(request));
        const report = await reports.report({ playgroundId, reason, reporter: author });
        return json({ report }, 201);
      }
      default:
        return json({ error: `no route: ${route}` }, 404);
    }
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      // THE SINGLE WRITE-PATH GUARD. WRITE_ROUTES is the one authority on what needs auth: a
      // write route resolves identity once and gates here, before any parse or service call, so
      // an unauthenticated write is a 401 even with a malformed body. The resolved Subject is
      // then handed to the write dispatch, which therefore never sees an absent identity — the
      // gate's early return narrows it, so authorship threads through WITHOUT a second null check
      // or a non-null assertion. Read routes never reach the resolver. The MECHANISM is wholly
      // behind resolveIdentity; this enforcer never changes when it is swapped.
      // [LAW:single-enforcer] [LAW:dataflow-not-control-flow] [LAW:locality-or-seam]
      if (WRITE_ROUTES.has(route)) {
        const identity = await resolveIdentity(request);
        if (identity === null) return json({ error: 'authentication required' }, 401);
        return await handleWrite(route, request, identity.subject);
      }
      return await handleRead(route, request);
    } catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, 400);
      // A well-formed request naming a playground that doesn't exist: a client error, not
      // infra. The typed PlaygroundNotFoundError carries the id in its message. [LAW:no-silent-failure]
      if (error instanceof PlaygroundNotFoundError) return json({ error: error.message }, 404);
      // The request is well-formed AND the playground exists, but its provider cannot iterate
      // (no continueSession). The input is unprocessable on semantic, not infra, grounds — so
      // 422, distinct from both the 404 (no such playground) and the generic 500 (real
      // failure). Surfacing it as 500 would misrepresent a client-actionable condition as a
      // server fault and send the caller down the wrong path. [LAW:no-silent-failure]
      if (error instanceof ProviderCannotContinueError) return json({ error: error.message }, 422);
      // The remix sibling: the playground exists but its provider cannot fork (no fork method).
      // Unprocessable on semantic grounds, exactly like the continue case above — 422, never a
      // 500 that misreads a client-actionable condition as a server fault. [LAW:no-silent-failure]
      if (error instanceof ProviderCannotForkError) return json({ error: error.message }, 422);
      // The identity is over its concurrent or daily generation budget: a rate limit, not a fault.
      // 429 (Too Many Requests) is the honest status — distinct from the 422s (a per-playground
      // capability gap) and never a 500 (a server fault). The message states the limit and when it
      // resets; the create UI surfaces it verbatim through its generic error path. [LAW:no-silent-failure]
      if (error instanceof QuotaExceededError) return json({ error: error.message }, 429);
      // Any other failure from the service is surfaced loudly with its message — never a 200
      // hiding an error, never a silent empty body. Finer status taxonomy for the remaining
      // 500s (e.g. unknown provider as 404) is a later refinement; the message is always
      // carried so the caller is never sent down a wrong path. [LAW:no-silent-failure]
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };
};
