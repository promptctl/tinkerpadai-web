import { describe, expect, it } from 'vitest';
import { makeMemoryCatalog, Tag, VersionId } from '../storage/index.js';
import type { Catalog, PlaygroundId, Tags } from '../storage/index.js';
import { Subject } from '../identity/index.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import { makeSiteHandler } from './siteHandler.js';

// The site handler's contract: it serves the trusted app pages (front door, commons, player
// chrome) and delegates everything else to the API. Assertions are over that composition and
// over the security-relevant shape of the player (a sandboxed iframe pointing at a foreign
// content origin) — not over styling. [LAW:behavior-not-structure]

const PAGE = '<!doctype html><title>front door</title>';
const CONTENT_ORIGIN = 'http://content.local:9999';

const seed = async (catalog: Catalog, prompt: string, tags: Tags = []): Promise<PlaygroundId> => {
  const playground = await catalog.createPlayground({
    handle: { providerId: ProviderId('p'), sessionId: SessionId('s'), turnId: TurnId('t') },
    prompt,
    version: VersionId('v1'),
    lineage: null,
    author: Subject('ada'),
    tags,
  });
  return playground.id;
};

const build = (
  catalog: Catalog,
  sessionHandler: (request: Request) => Promise<Response | null> = async () => null,
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
    handler: makeSiteHandler({ page: PAGE, catalog, contentOrigin: CONTENT_ORIGIN, sessionHandler, apiHandler }),
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

  it('lets the session handler claim its own routes before the API ever sees them', async () => {
    // A session route is answered by the session handler; the API handler is never reached for
    // it. An unclaimed route (null from the session handler) still falls through to the API.
    const sessionHandler = async (request: Request): Promise<Response | null> =>
      new URL(request.url).pathname === '/session'
        ? new Response(JSON.stringify({ identity: null }), { headers: { 'content-type': 'application/json' } })
        : null;
    const { handler, delegated } = build(makeMemoryCatalog(), sessionHandler);

    const claimed = await handler(new Request('http://front.local/session'));
    expect(await claimed.json()).toEqual({ identity: null });
    expect(delegated).toHaveLength(0);

    await handler(new Request('http://front.local/providers'));
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
    // Authorship is projected as a byline through the real catalog projection, not just stored.
    expect(body).toContain('by ada');
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

  // The commons search + tag filter, end to end through the real route: the URL's query is parsed,
  // the canonical list is narrowed, and only the surviving cards render. Both facets narrow the
  // SAME cards, never a second card shape. [LAW:one-source-of-truth]
  it('narrows the commons by the URL search text', async () => {
    const catalog = makeMemoryCatalog();
    await seed(catalog, 'a color picker');
    await seed(catalog, 'a prime sieve');
    const { handler } = build(catalog);
    const body = await (await handler(new Request('http://front.local/commons?q=color'))).text();
    expect(body).toContain('a color picker');
    expect(body).not.toContain('a prime sieve');
  });

  it('narrows the commons by a URL tag filter, matching normalized tags', async () => {
    const catalog = makeMemoryCatalog();
    await seed(catalog, 'a color picker', [Tag('css')]);
    await seed(catalog, 'a prime sieve', [Tag('math')]);
    const { handler } = build(catalog);
    // 'CSS' in the URL is normalized to match the stored 'css'.
    const body = await (await handler(new Request('http://front.local/commons?tag=CSS'))).text();
    expect(body).toContain('a color picker');
    expect(body).not.toContain('a prime sieve');
    // The filter chip row is derived from the WHOLE catalog, so the other facet stays offered — and
    // its toggle link PRESERVES the active css filter (AND semantics: adding math narrows further).
    expect(body).toContain('tag=math');
    expect(body).toContain('/commons?tag=css&amp;tag=math');
  });

  it('renders the filtered-empty state when a filter matches nothing', async () => {
    const catalog = makeMemoryCatalog();
    await seed(catalog, 'a color picker', [Tag('css')]);
    const { handler } = build(catalog);
    const body = (await (await handler(new Request('http://front.local/commons?q=nomatch'))).text()).toLowerCase();
    expect(body).toContain('no playgrounds match');
    expect(body).not.toContain('no playgrounds yet');
  });

  // The /api/playgrounds seam: the JSON projection of the commons the static homepage fetches to
  // render its preview grid. It returns the SAME PlaygroundSummary[] the commons HTML is built
  // from — the same source, so the two cannot disagree — in the catalog's insertion order, leaving
  // "recent, top N" to the client view. [LAW:one-source-of-truth]
  it('serves the commons summaries as JSON at GET /api/playgrounds, never touching the API', async () => {
    const catalog = makeMemoryCatalog();
    await seed(catalog, 'first playground');
    const id = await seed(catalog, 'second playground');
    const { handler, delegated } = build(catalog);

    const res = await handler(new Request('http://front.local/api/playgrounds'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const summaries = (await res.json()) as {
      id: string;
      prompt: string;
      author: string;
      recipe: string[];
      tags: string[];
    }[];
    // Insertion order preserved — recency is the client view's window, not the endpoint's policy.
    expect(summaries.map((s) => s.prompt)).toEqual(['first playground', 'second playground']);
    // The read-path projection the card renders from: id, author byline, and step-count source.
    // (?. keeps the access honest — a missing element fails the assertion loudly, never silently.)
    expect(summaries[1]?.id).toBe(id);
    expect(summaries[1]?.author).toBe('ada');
    expect(summaries[1]?.recipe).toEqual(['second playground']);
    // Tags cross the same seam — the JSON projection the homepage grid also reads.
    expect(summaries[1]?.tags).toEqual([]);
    expect(delegated).toHaveLength(0);
  });

  it('serves an empty commons as an empty JSON array, not a thrown special case', async () => {
    const { handler } = build(makeMemoryCatalog());
    const res = await handler(new Request('http://front.local/api/playgrounds'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
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

  // Tags flow end-to-end: a playground's stored classification reaches the reader as chips on BOTH
  // the commons list and the player chrome — the same projected value on both surfaces.
  it('renders a playground\'s topic tags as chips on the commons and the player', async () => {
    const catalog = makeMemoryCatalog();
    const id = await seed(catalog, 'a fractal explorer', [Tag('math'), Tag('interactive')]);
    const { handler } = build(catalog);

    const commons = await (await handler(new Request('http://front.local/commons'))).text();
    expect(commons).toContain('<span class="tag">math</span>');
    expect(commons).toContain('<span class="tag">interactive</span>');

    const player = await (await handler(new Request(`http://front.local/play?id=${encodeURIComponent(id)}`))).text();
    expect(player).toContain('<span class="tag">math</span>');
    expect(player).toContain('<span class="tag">interactive</span>');
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

  it('propagates a catalog read failure loudly rather than relabeling it as a 404', async () => {
    // An unknown id is simply absent from the projection (a 404); an infra/invariant failure
    // throws out of the read and must surface (serve() turns the throw into a loud 500), never
    // collapsed into "not found". The player reads through listPlaygrounds, so that is the seam
    // that fails here. [LAW:no-silent-failure]
    const brokenCatalog: Catalog = {
      createPlayground: async () => {
        throw new Error('not used');
      },
      appendTurn: async () => {
        throw new Error('not used');
      },
      getPlayground: async () => {
        throw new Error('not used');
      },
      listPlaygrounds: async () => {
        throw new Error('catalog.json is corrupt');
      },
    };
    const { handler } = build(brokenCatalog);
    await expect(handler(new Request('http://front.local/play?id=anything'))).rejects.toThrow('corrupt');
  });

  // The app-origin security seal (sandbox-bci.3, threat-model gap R1): the TRUSTED origin holds the
  // session credential, so every response leaving it — page, JSON projection, player, AND the
  // delegated session/API responses (the login page is the concrete clickjacking target) — must
  // carry the anti-framing + hardening headers. This is the app-origin counterpart to the content
  // origin's sealed-CSP test. [LAW:single-enforcer] [LAW:verifiable-goals]
  const expectHardened = (res: Response): void => {
    const csp = res.headers.get('content-security-policy') ?? '';
    // The concrete clickjacking fix: only the app may frame the app.
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
    // Legacy twin for pre-CSP3 browsers.
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  };

  it('hardens the front-door page, the JSON projection, and the player against clickjacking', async () => {
    const catalog = makeMemoryCatalog();
    const id = await seed(catalog, 'a color palette');
    const { handler } = build(catalog);
    expectHardened(await handler(new Request('http://front.local/')));
    expectHardened(await handler(new Request('http://front.local/commons')));
    expectHardened(await handler(new Request('http://front.local/api/playgrounds')));
    expectHardened(await handler(new Request(`http://front.local/play?id=${encodeURIComponent(id)}`)));
  });

  it('hardens the delegated session and API responses too — the login page is not exempt', async () => {
    // The login page is served by the session handler through the default branch. If the seal only
    // wrapped the page helpers it would MISS the highest-value clickjacking target; the single outer
    // seal is what guarantees no branch escapes. [LAW:single-enforcer]
    const loginHandler = async (request: Request): Promise<Response | null> =>
      new URL(request.url).pathname === '/session/login'
        ? new Response('<form>sign in</form>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
        : null;
    const { handler } = build(makeMemoryCatalog(), loginHandler);
    expectHardened(await handler(new Request('http://front.local/session/login')));
    // A route the session handler declines falls through to the API — still sealed.
    expectHardened(await handler(new Request('http://front.local/providers')));
  });

  it('preserves a Set-Cookie from a delegated login response through the seal', async () => {
    // The seal adds headers by mutation and never touches set-cookie, so a login that mints the
    // session cookie is not corrupted by the hardening pass. [LAW:no-silent-failure]
    const loginHandler = async (): Promise<Response | null> => {
      const res = new Response(null, { status: 302, headers: { location: '/' } });
      res.headers.append('set-cookie', '__Host-session=abc; Path=/; HttpOnly; Secure; SameSite=Strict');
      return res;
    };
    const { handler } = build(makeMemoryCatalog(), loginHandler);
    const res = await handler(new Request('http://front.local/session/callback'));
    expectHardened(res);
    expect(res.headers.getSetCookie()).toEqual(['__Host-session=abc; Path=/; HttpOnly; Secure; SameSite=Strict']);
  });

  // Fork attribution flows through the real projection: a child playground forked from a parent
  // surfaces "Forked from <parent>" linking back to the parent's player, on BOTH the commons
  // list and the child's own player chrome. A non-fork surfaces none.
  it('attributes a fork to its parent on the commons and the player, linking back', async () => {
    const catalog = makeMemoryCatalog();
    const parent = await catalog.createPlayground({
      handle: { providerId: ProviderId('p'), sessionId: SessionId('parent-session'), turnId: TurnId('t0') },
      prompt: 'the original counter',
      version: VersionId('v1'),
      lineage: null,
      author: Subject('ada'),
      tags: [],
    });
    const child = await catalog.createPlayground({
      handle: { providerId: ProviderId('p'), sessionId: SessionId('child-session'), turnId: TurnId('t1') },
      prompt: 'a remixed counter',
      version: VersionId('v2'),
      lineage: { parentSession: SessionId('parent-session'), forkedFromVersion: VersionId('v1') },
      author: Subject('grace'),
      tags: [],
    });
    const { handler } = build(catalog);

    const commons = await (await handler(new Request('http://front.local/commons'))).text();
    expect(commons).toContain('Forked from');
    expect(commons).toContain('the original counter');
    expect(commons).toContain(`/play?id=${encodeURIComponent(parent.id)}`);

    const player = await (await handler(new Request(`http://front.local/play?id=${encodeURIComponent(child.id)}`))).text();
    expect(player).toContain('Forked from');
    expect(player).toContain(`/play?id=${encodeURIComponent(parent.id)}`);
    // The remix's player credits the remixer (the forker), distinct from the parent's author.
    expect(player).toContain('by grace');

    // The parent itself is not a fork — no attribution on its player.
    const parentPlayer = await (await handler(new Request(`http://front.local/play?id=${encodeURIComponent(parent.id)}`))).text();
    expect(parentPlayer).not.toContain('Forked from');
  });
});
