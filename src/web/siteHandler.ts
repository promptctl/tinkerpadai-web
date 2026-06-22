// THE SITE HANDLER — the front door's one composed Web surface. It serves the creation
// page at `GET /` and delegates every other route to the generation API handler. A single
// runtime-agnostic (Request) => Promise<Response>, so the same handler runs behind a Node
// socket, a Cloudflare Worker, or a test that just calls it — binding a port is a separate
// edge concern (see server.ts). [LAW:effects-at-boundaries]
//
// Composition, not a router with feature flags: the page route and the API are two
// concerns joined at one seam. The page is passed in as content (read from disk at the
// server edge), never read here — this handler stays pure. [LAW:decomposition]

export interface SiteHandlerDeps {
  // The front-door HTML, already loaded. A value, not a path: reading the file is an
  // effect kept at the boundary that builds this handler. [LAW:effects-at-boundaries]
  readonly page: string;
  // The generation API handler (makeHttpHandler) — everything that is not the page.
  readonly apiHandler: (request: Request) => Promise<Response>;
}

const html = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

export const makeSiteHandler = (
  deps: SiteHandlerDeps,
): ((request: Request) => Promise<Response>) => {
  const { page, apiHandler } = deps;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return html(page);
    return apiHandler(request);
  };
};
