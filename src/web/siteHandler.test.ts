import { describe, expect, it } from 'vitest';
import { makeMemoryCatalog, VersionId } from '../storage/index.js';
import type { Catalog, PlaygroundId } from '../storage/index.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import { makeSiteHandler } from './siteHandler.js';

// The site handler's contract: it serves the trusted app pages (front door, commons, player
// chrome) and delegates everything else to the API. Assertions are over that composition and
// over the security-relevant shape of the player (a sandboxed iframe pointing at a foreign
// content origin) — not over styling. [LAW:behavior-not-structure]

const PAGE = '<!doctype html><title>front door</title>';
const CONTENT_ORIGIN = 'http://content.local:9999';

const seed = async (catalog: Catalog, prompt: string): Promise<PlaygroundId> => {
  const playground = await catalog.createPlayground({
    handle: { providerId: ProviderId('p'), sessionId: SessionId('s'), turnId: TurnId('t') },
    prompt,
    version: VersionId('v1'),
    lineage: null,
  });
  return playground.id;
};

const build = (
  catalog: Catalog,
): { handler: (request: Request) => Promise<Response>; delegated: Request[] } => {
  const delegated: Request[] = [];
  const apiHandler = async (request: Request): Promise<Response> => {
    delegated.push(request);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    handler: makeSiteHandler({ page: PAGE, catalog, contentOrigin: CONTENT_ORIGIN, apiHandler }),
    delegated,
  };
};

describe('makeSiteHandler', () => {
  it('serves the page at GET / as HTML, never touching the API', async () => {
    const { handler, delegated } = build(makeMemoryCatalog());
    const res = await handler(new Request('http://front.local/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(PAGE);
    expect(delegated).toHaveLength(0);
  });

  it('delegates every unclaimed route to the API handler unchanged', async () => {
    const { handler, delegated } = build(makeMemoryCatalog());
    const res = await handler(new Request('http://front.local/providers'));
    expect(await res.json()).toEqual({ ok: true });
    expect(delegated.map((r) => new URL(r.url).pathname)).toEqual(['/providers']);
  });

  it('delegates a POST to / to the API rather than serving the page', async () => {
    const { handler, delegated } = build(makeMemoryCatalog());
    await handler(new Request('http://front.local/', { method: 'POST' }));
    expect(delegated).toHaveLength(1);
  });

  it('lists catalogued playgrounds at /commons, each linking to its player', async () => {
    const catalog = makeMemoryCatalog();
    const id = await seed(catalog, 'a tiny counter');
    const { handler } = build(catalog);
    const body = await (await handler(new Request('http://front.local/commons'))).text();
    expect(body).toContain('a tiny counter');
    expect(body).toContain(`/play?id=${encodeURIComponent(id)}`);
  });

  it('renders an empty commons as data, not a thrown special case', async () => {
    const { handler } = build(makeMemoryCatalog());
    const res = await handler(new Request('http://front.local/commons'));
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain('no playgrounds yet');
  });

  it('escapes a hostile prompt in the commons rather than emitting it as markup', async () => {
    const catalog = makeMemoryCatalog();
    await seed(catalog, '<img src=x onerror=alert(1)>');
    const { handler } = build(catalog);
    const body = await (await handler(new Request('http://front.local/commons'))).text();
    expect(body).not.toContain('<img src=x onerror=alert(1)>');
    expect(body).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('serves a sandboxed player at /play that frames the FOREIGN content origin', async () => {
    const catalog = makeMemoryCatalog();
    const id = await seed(catalog, 'a color palette');
    const { handler } = build(catalog);
    const body = await (await handler(new Request(`http://front.local/play?id=${encodeURIComponent(id)}`))).text();
    // allow-scripts so the playground runs; NEVER allow-same-origin, or the frame could
    // reach the app's origin. This is the load-bearing assertion of the whole ticket.
    expect(body).toContain('sandbox="allow-scripts"');
    expect(body).not.toContain('allow-same-origin');
    // The iframe points at the separate content origin, carrying the id — the app origin
    // never serves the playground html itself.
    expect(body).toContain(`src="${CONTENT_ORIGIN}/?id=${encodeURIComponent(id)}"`);
  });

  it('returns a 404 for an unknown playground id rather than a blank player', async () => {
    const { handler } = build(makeMemoryCatalog());
    const res = await handler(new Request('http://front.local/play?id=nope'));
    expect(res.status).toBe(404);
    expect((await res.text()).toLowerCase()).toContain('not found');
  });

  it('returns a 400 when /play is opened with no id', async () => {
    const { handler } = build(makeMemoryCatalog());
    const res = await handler(new Request('http://front.local/play'));
    expect(res.status).toBe(400);
  });
});
