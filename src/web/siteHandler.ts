import type { Catalog } from '../storage/index.js';
import { PlaygroundId } from '../storage/index.js';
import { filterSummaries, parseCommonsQuery, tagFacets } from './commonsQuery.js';
import { renderCommons, renderNotice, renderPlayer } from './playgroundPages.js';

// THE APP-ORIGIN SURFACE — the front door's one composed Web handler. It serves the trusted
// app pages (creation page at `/`, the commons list, the player chrome) and delegates every
// other route to the generation API. A single runtime-agnostic (Request) => Promise<Response>,
// so the same handler runs behind a Node socket, a Cloudflare Worker, or a direct test call;
// binding a port is a separate edge concern (server.ts). [LAW:effects-at-boundaries]
//
// Composition, not a router with feature flags: each route is a concern joined at one seam.
// The page is content (read from disk at the edge); the commons/player pages are pure
// renderers fed by catalog reads; the rest is the API. The PLAYGROUND HTML itself is NOT
// served here — it lives on a separate content origin behind the sandbox (contentHandler).
// [LAW:decomposition]

export interface SiteHandlerDeps {
  // The front-door HTML, already loaded. A value, not a path: reading the file is an effect
  // kept at the boundary that builds this handler. [LAW:effects-at-boundaries]
  readonly page: string;
  // The read seam for the commons/use path — listed and opened, never the provider.
  readonly catalog: Catalog;
  // The CONTENT origin's base URL (a foreign origin). The player frames playground html from
  // there; this app origin never serves that html itself. Resolved after the content socket
  // binds and passed in as a value — the cross-origin link is explicit, not ambient.
  // [LAW:no-ambient-temporal-coupling]
  readonly contentOrigin: string;
  // The session lifecycle handler (login + whoami). Tried before the API on unmatched routes;
  // it returns null for anything that is not its own, so this surface stays oblivious to which
  // routes are auth routes — it composes the handler, it does not enumerate it. [LAW:decomposition]
  readonly sessionHandler: (request: Request) => Promise<Response | null>;
  // The generation API handler (makeHttpHandler) — everything that is not an app page or a
  // session route.
  readonly apiHandler: (request: Request) => Promise<Response>;
}

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

// Defense-in-depth for the TRUSTED origin — the one that actually holds the session credential.
// The content origin (contentHandler) is already sealed; this is its counterpart, and the audit's
// gap R1: the app pages (login, player, commons) shipped with only content-type, so ANY site could
// frame them → clickjacking of the login form. These directives close that and the adjacent cheap
// wins:
//   frame-ancestors 'self'  : only the app may frame the app — the concrete clickjacking fix.
//   base-uri 'none'         : no injected <base> can re-root the page's relative URLs.
//   form-action 'self'      : a form can only post back to the app, never to an attacker.
//   object-src 'none'       : no <object>/<embed> plugin surface.
// A full script-src is deliberately DEFERRED: the app runs inline scripts (index.html, player), so
// locking it needs per-script hashes/nonces — tracked separately, not smuggled in here half-done.
const APP_CSP = ["frame-ancestors 'self'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"].join('; ');

// THE ONE app-origin response seal. Every response leaving this handler — a page, the JSON
// projection, a delegated session/API response (the login page included) — passes through here and
// carries the same hardening headers, mirroring how the content origin seals every response in one
// place. Applied by MUTATION, not by rebuilding: the inner handler owns body/status/content-type
// and its own Set-Cookie; this seal only ADDS the cross-cutting security headers and never touches
// set-cookie, so cookie integrity cannot depend on Headers copy-fold behavior. X-Frame-Options is
// the legacy twin of frame-ancestors, kept for pre-CSP3 browsers. [LAW:single-enforcer]
const harden = (response: Response): Response => {
  response.headers.set('content-security-policy', APP_CSP);
  response.headers.set('x-frame-options', 'SAMEORIGIN');
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'same-origin');
  return response;
};

export const makeSiteHandler = (deps: SiteHandlerDeps): ((request: Request) => Promise<Response>) => {
  const { page, catalog, contentOrigin, sessionHandler, apiHandler } = deps;

  const playPage = async (id: string): Promise<Response> => {
    // The player renders the SAME projected summary the commons does — including resolved fork
    // attribution, which can only be derived against the whole catalog. So the player reads
    // through the one projection (listPlaygrounds), then selects its target. An unknown id is
    // simply absent from the list — a value (undefined), rendered as a 404, not a thrown special
    // case. A genuine read/invariant failure throws out of listPlaygrounds and propagates to
    // serve()'s loud 500, never relabeled as "not found". [LAW:dataflow-not-control-flow] [LAW:no-silent-failure]
    const target = PlaygroundId(id);
    const summary = (await catalog.listPlaygrounds()).find((s) => s.id === target);
    if (summary === undefined) {
      return html(renderNotice('Playground not found', `No playground in the commons has the id "${id}".`), 404);
    }
    const contentSrc = `${contentOrigin}/?id=${encodeURIComponent(summary.id)}`;
    return html(
      renderPlayer({
        id: summary.id,
        prompt: summary.prompt,
        contentSrc,
        providerId: summary.providerId,
        author: summary.author,
        forkedFrom: summary.forkedFrom,
        recipe: summary.recipe,
        tags: summary.tags,
      }),
    );
  };

  const dispatch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case 'GET /':
        return html(page);
      case 'GET /commons': {
        // The catalog is read ONCE as the canonical list; discovery is a pure projection over it.
        // The facets come from the WHOLE list (so filtering by one tag never hides the others),
        // the results from that same list narrowed by the URL's query. One source of truth, two
        // pure derivations — never a parallel search index. [LAW:one-source-of-truth]
        // [LAW:effects-at-boundaries]
        const all = await catalog.listPlaygrounds();
        const query = parseCommonsQuery(url.searchParams);
        const facets = tagFacets(all);
        const results = filterSummaries(all, query);
        return html(renderCommons({ results, facets, query }));
      }
      case 'GET /api/playgrounds':
        // The JSON projection of the commons — the SAME PlaygroundSummary list renderCommons
        // renders as HTML, serialized so the static homepage (index.html, which cannot import the
        // server shell) can fetch and client-render its own preview grid. One projection feeds both
        // the server- and client-rendered cards, so a playground reads identically wherever it is
        // listed. Recency and "top N" are the homepage view's concern, applied by that consumer over
        // this canonical insertion-ordered list — never baked into the endpoint, so the future
        // my-playgrounds page and discovery filters reuse the same seam. [LAW:one-source-of-truth]
        // [LAW:decomposition]
        return json(await catalog.listPlaygrounds());
      case 'GET /play': {
        const id = url.searchParams.get('id');
        if (id === null || id === '')
          return html(renderNotice('Which playground?', 'Open a playground from the commons — no id was given.'), 400);
        return playPage(id);
      }
      default: {
        // Session routes first, then the generation API. The session handler answers its own
        // routes (login, whoami) and yields null for the rest, so the API sees only what is left.
        // [LAW:dataflow-not-control-flow]
        const session = await sessionHandler(request);
        return session ?? apiHandler(request);
      }
    }
  };

  // The single exit — and it is TOTAL, exactly like the content origin's sealed handler: every
  // path returns a hardened Response, none throws. A read/invariant failure (corrupt catalog,
  // broken store) becomes a loud, SEALED 500 carrying its message here rather than propagating
  // unsealed to the origin-agnostic runtime edge — so no app-origin response, error path included,
  // ever escapes unhardened, and no raw stack leaks. It is NOT relabeled as a 404: a genuinely
  // absent resource is a 404 that dispatch RETURNS as a value, never a throw. The runtime edge's
  // try/catch stays as the last-resort backstop for a bug in this handler, the accepted
  // total-handler + edge pattern the content origin already uses — not a duplicate enforcer.
  // [LAW:single-enforcer] [LAW:no-silent-failure] [LAW:types-are-the-program]
  return async (request: Request): Promise<Response> => {
    try {
      return harden(await dispatch(request));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return harden(json({ error: message }, 500));
    }
  };
};
