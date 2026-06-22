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

// The Content-Security-Policy carried on every served playground. The intent the ticket
// states — deny-all baseline, no network — at full resolution:
//   default-src 'none'   : nothing is allowed unless re-permitted below.
//   script-src/style-src 'unsafe-inline' : a self-contained playground IS inline code; this
//                          is what lets it RUN. It still cannot load any EXTERNAL script or
//                          style (no 'self', no host, no https:) — only its own inline code.
//   img-src/font-src data:: self-contained assets are data: URIs; allow those, nothing more.
//   connect-src 'none'   : the real containment — no fetch/XHR/WebSocket/beacon, so a
//                          hostile playground cannot phone home or exfiltrate.
//   form-action/base-uri 'none' : no posting out, no <base> hijack.
// frame-ancestors is deliberately left unset: the app's player MUST be able to frame this.
const PLAYGROUND_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

export interface ContentHandlerDeps {
  readonly catalog: Catalog;
  readonly store: ArtifactStore;
}

// Every response from the content origin — html and errors alike — carries the strict CSP
// and nosniff. There is no path out of this handler that serves anything permissively.
const sealed = (body: string, status: number, contentType: string): Response =>
  new Response(body, {
    status,
    headers: {
      'content-type': contentType,
      'content-security-policy': PLAYGROUND_CSP,
      'x-content-type-options': 'nosniff',
    },
  });

export const makeContentHandler = (deps: ContentHandlerDeps): ((request: Request) => Promise<Response>) => {
  const { catalog, store } = deps;
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
