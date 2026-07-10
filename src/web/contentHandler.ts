import type { ArtifactStore, Catalog } from '../storage/index.js';
import { PlaygroundId, PlaygroundNotFoundError, currentVersionOf } from '../storage/index.js';

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
const playgroundCsp = (appOrigin: string): string =>
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
  // The app's origin (scheme://host[:port]) — the ONE origin permitted to frame a served playground,
  // scoped into the CSP's frame-ancestors. Derived by the composition root from the OAuth callback URL
  // (appOriginOf), the canonical app-origin source; the handler takes the already-derived origin so it
  // knows "who may frame me" without knowing anything about OAuth. [LAW:decomposition]
  readonly appOrigin: string;
}

export const makeContentHandler = (deps: ContentHandlerDeps): ((request: Request) => Promise<Response>) => {
  const { catalog, store, appOrigin } = deps;
  // The CSP is a value derived once from the app origin (fixed for this handler's life), not a
  // per-request branch. [LAW:dataflow-not-control-flow]
  const csp = playgroundCsp(appOrigin);
  // Every response from the content origin — html and errors alike — carries the strict CSP
  // and nosniff. There is no path out of this handler that serves anything permissively.
  const sealed = (body: string, status: number, contentType: string): Response =>
    new Response(body, {
      status,
      headers: {
        'content-type': contentType,
        'content-security-policy': csp,
        'x-content-type-options': 'nosniff',
      },
    });
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/') {
      return sealed('not found', 404, 'text/plain; charset=utf-8');
    }
    const id = url.searchParams.get('id');
    if (id === null || id === '') {
      return sealed('missing or empty query parameter: id', 400, 'text/plain; charset=utf-8');
    }

    // Two failures with two MEANINGS, discriminated by the error TYPE — not by which call
    // threw. A genuine unknown id (PlaygroundNotFoundError) is a 404. ANYTHING else — a
    // store that can't produce the catalogued bytes, a catalog that can't be read, an
    // invariant violation — is the server being wrong, surfaced as a loud 500. Collapsing
    // the two would relabel "server is broken" as "not found", a [LAW:no-silent-failure]
    // trap. The typed not-found is what lets one catch branch on the value.
    // [LAW:types-are-the-program] [LAW:dataflow-not-control-flow]
    try {
      const playground = await catalog.getPlayground(PlaygroundId(id));
      // The takedown made concrete: an unlisted playground STOPS being served. getPlayground still
      // resolves it (existence is monotonic — the report/relist paths depend on that), so the refusal
      // is a visibility check HERE, at the one origin that serves raw html, not a deletion. Without
      // it, unlisting would hide a playground from the commons yet leave its content reachable by
      // direct content-origin URL — a takedown that doesn't take anything down. 410 Gone: the
      // resource existed and is intentionally no longer available, distinct from a 404 (never
      // existed). Still sealed under the strict CSP like every response here. [LAW:single-enforcer]
      // [LAW:no-silent-failure]
      if (playground.listing === 'unlisted') {
        return sealed('this playground has been removed', 410, 'text/plain; charset=utf-8');
      }
      const artifact = await store.get(currentVersionOf(playground.session));
      // The raw, UNESCAPED file: it is meant to be live code, contained by sandbox + origin
      // + this CSP. Escaping it would break the playground; that is the opposite mistake
      // from escaping app chrome. [FRAMING:representation]
      return sealed(artifact.html, 200, 'text/html; charset=utf-8');
    } catch (error) {
      if (error instanceof PlaygroundNotFoundError) {
        return sealed(`playground not found: ${error.message}`, 404, 'text/plain; charset=utf-8');
      }
      // A loud 500, still sealed under the strict CSP — the handler stays total (returns a
      // Response for every input, never throws) so it behaves the same behind any runtime.
      const message = error instanceof Error ? error.message : String(error);
      return sealed(`failed to load playground: ${message}`, 500, 'text/plain; charset=utf-8');
    }
  };
};
