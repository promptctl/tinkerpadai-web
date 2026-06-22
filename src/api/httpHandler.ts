import type { GenerationRequest, SessionHandle } from '../provider/index.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import type { GenerationService } from './generationService.js';

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

export const makeHttpHandler = (
  service: GenerationService,
): ((request: Request) => Promise<Response>) => {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      switch (route) {
        case 'GET /providers':
          return json(service.listProviders());
        // A live availability read for the generation toggle. GET, not POST: it mutates
        // nothing (unlike /poll, whose first success observation performs the store+catalog
        // write), so it is safe and cacheless-by-default. The providerId rides as a query
        // value and is branded here, at the trust boundary — the one place foreign input
        // becomes a ProviderId. [LAW:single-enforcer]
        case 'GET /availability': {
          const providerId = ProviderId(requireString(url.searchParams.get('providerId'), 'providerId'));
          return json(await service.availabilityOf(providerId));
        }
        case 'POST /generations': {
          const handle = await service.submit(parseGenerationRequest(await readJson(request)));
          return json({ handle }, 201);
        }
        // POST, not GET: a poll is not safe — the first observation of a succeeded turn
        // performs the store+catalog write — so it must not be treated as cacheable.
        case 'POST /poll':
          return json(await service.poll(parseHandle(await readJson(request))));
        default:
          return json({ error: `no route: ${route}` }, 404);
      }
    } catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, 400);
      // Any failure from the service is surfaced loudly with its message — never a 200
      // hiding an error, never a silent empty body. Finer status taxonomy (e.g. unknown
      // provider as 404) is a later refinement; the message is always carried so the
      // caller is never sent down a wrong path. [LAW:no-silent-failure]
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };
};
