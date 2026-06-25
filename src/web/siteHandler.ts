import type { Catalog } from '../storage/index.js';
import { PlaygroundId } from '../storage/index.js';
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
      }),
    );
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    switch (route) {
      case 'GET /':
        return html(page);
      case 'GET /commons':
        return html(renderCommons(await catalog.listPlaygrounds()));
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
};
