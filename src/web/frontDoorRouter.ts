import type { App } from '../app.js';
import { makeSiteHandler } from './siteHandler.js';
import { makeContentHandler } from './contentHandler.js';

// THE TWO-ORIGIN ROUTER — one fetch handler standing in front of BOTH origins, dispatching each
// request to the right one by its host. On Node the two origins are two sockets (serve() twice); on
// a single Cloudflare Worker they are two ROUTES on one fetch entry, told apart here. Either way the
// load-bearing property is identical and enforced in ONE place: a request to the content host gets
// ONLY the sandboxed raw-html handler under the strict CSP — never an app page, never a session
// route, never the API — so a playground's opaque-origin frame can reach nothing of the app's. This
// host split IS the sandbox boundary made concrete on the edge; it is pure logic over an already-
// built App, so it is unit-testable with a memory-backed app and has no knowledge of R2/D1/env.
// [LAW:single-enforcer] [LAW:decomposition] [LAW:effects-at-boundaries]

export interface FrontDoorRouterDeps {
  // The assembled app graph (catalog, store, handlers) — built by the entry from whatever backends
  // the deployment uses. The router reads only the seams it exposes.
  readonly app: App;
  // The front-door HTML, already loaded (imported as a text module at the edge, read from disk on
  // Node). A value, not a path — reading it is the entry's effect, not the router's.
  readonly page: string;
  // The content origin's public base URL. Its HOST is the discriminator the router splits on, and
  // its full value is what the player frames as the playground iframe src. One value, two uses, so
  // the host a request is matched against and the origin the player links to cannot drift apart.
  // [LAW:one-source-of-truth]
  readonly contentOrigin: string;
}

export const makeFrontDoorRouter = (
  deps: FrontDoorRouterDeps,
): ((request: Request) => Promise<Response>) => {
  const { app, page, contentOrigin } = deps;
  const contentHost = new URL(contentOrigin).host;
  const site = makeSiteHandler({
    page,
    catalog: app.catalog,
    contentOrigin,
    sessionHandler: app.sessionHandler,
    apiHandler: app.handler,
  });
  const content = makeContentHandler({ catalog: app.catalog, store: app.store });
  return (request: Request): Promise<Response> => {
    const host = new URL(request.url).host;
    return host === contentHost ? content(request) : site(request);
  };
};
