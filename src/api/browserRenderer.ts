import puppeteer, { TimeoutError } from '@cloudflare/puppeteer';
import type { BrowserWorker } from '@cloudflare/puppeteer';

// THE ISOLATED RENDER SANDBOX, on the Workers target. It loads a playground in Cloudflare Browser
// Rendering — a managed, isolated headless Chrome that is a SIBLING to the player iframe, never this
// trusted Worker's isolate — and extracts two observations from the one load:
//
//   - `png`: a screenshot, the derived preview the commons grid shows (thumbnails, discovery-rye.3).
//   - `pageErrors`: the ordered uncaught exceptions thrown during load, the signal the functional gate
//     rejects on (the edge ArtifactValidator, providers-u1h) when public generation turns on.
//
// One capability, two extractions from a single render — so the validator reuses this exact driver
// instead of standing up a second browser. [LAW:decomposition] [LAW:composability]
//
// THE INPUT IS A URL, not raw HTML. A playground must render in a SECURE CONTEXT: served over https from
// the content origin, exactly as it runs for real users, so secure-context APIs (crypto.subtle) work.
// (Verified: rendering via page.setContent leaves the page on an insecure/opaque origin where
// crypto.subtle is undefined — a crypto-using playground would throw, which for the validator is a FALSE
// POSITIVE it must never produce.) So both callers supply a secure served URL: the thumbnail path the
// version's live content URL; the validator (providers-u1h) a temporary secure URL serving its pre-store
// bytes. Rendering the SERVED page also makes the preview faithful to what users see, through the real CSP.
//
// SECURITY POSTURE. The untrusted code runs in Browser Rendering's managed isolate, never here. It is
// hardened, mirroring the local Node validator (src/api/headlessArtifactValidator.ts): request
// interception allows ONLY the main-frame navigation to the target's own origin and ABORTS everything
// else — a subresource, an iframe, and (the load-bearing case) a main-frame navigation AWAY from our
// origin that untrusted code triggers with `window.location='https://evil'`; a self-contained artifact
// needs no other request. A bounded load deadline stops a wedged playground hanging the pipeline. This
// module imports @cloudflare/puppeteer, so ONLY the edge graph reaches it. [LAW:single-enforcer]
// [LAW:effects-at-boundaries]
//
// BROWSER LIFECYCLE. Browser Rendering rate-limits how fast browsers launch, so a batch (backfilling the
// commons) CANNOT launch one browser per render. `withSession` owns ONE browser for a batch; each
// `render` opens a FRESH ISOLATED browser context (its own storage/cookies) so one playground cannot see
// another's — every playground is served from the SAME content origin, so a shared context WOULD leak
// state between them. One launch, N storage-isolated renders. [LAW:effects-at-boundaries] [LAW:no-ambient-temporal-coupling]

// The observations from one render. `pageErrors` is empty for a clean load; each entry is the browser's
// error string (name + message), in the order thrown — the same shape LoadErrors carries in the
// ArtifactValidator seam, so the future edge validator maps directly onto it. [LAW:types-are-the-program]
export interface RenderResult {
  readonly png: Uint8Array;
  readonly pageErrors: readonly string[];
}

// One open browser, on which many playgrounds render — each in its own isolated context. Handed to the
// caller by withSession, valid only for that callback's duration.
export interface RenderSession {
  render(targetUrl: string): Promise<RenderResult>;
}

export interface BrowserRenderer {
  // Launch one browser, run the batch on it, close it on every exit. The callback renders as many
  // playgrounds as it wants through the session; the single-render case (the validator) is just one call.
  withSession<T>(run: (session: RenderSession) => Promise<T>): Promise<T>;
}

// How long the artifact gets to load before the render treats the load as done anyway. A self-contained
// (<=5MB) file loads in a second or two; this is generous. It plays the SAME role as the Node validator's
// LOAD_TIMEOUT_MS but is INDEPENDENTLY tuned for this target (edge Browser Rendering) — the two are not one
// value with two copies, they are separate knobs (this 15s is deliberately more generous than the
// validator's 10s), so they are NOT shared: forcing them equal would couple two renderers that legitimately
// differ. A fixed, documented constant, not a deploy knob. [LAW:no-mode-explosion] [LAW:one-type-per-behavior]
const LOAD_TIMEOUT_MS = 15_000;

// A brief settle after load so first paint and any just-after-load error are captured before the shot.
// This driver is the one owner of that timing. [LAW:no-ambient-temporal-coupling]
const SETTLE_MS = 600;

// A fixed preview viewport: every thumbnail is rendered at the same size so the commons grid is uniform.
// The screenshot is viewport-only (not fullPage) — a preview is the "above the fold" first impression.
const VIEWPORT = { width: 1200, height: 900 } as const;

// The TOTAL, fail-closed same-origin test for an intercepted request URL. The request handler's whole job
// is to allow ONLY the main-frame navigation to the target's own origin and abort everything else, so the
// decision must be a value that never throws: a URL the browser hands us that `new URL()` cannot parse is
// not PROVABLY same-origin, and under deny-by-default that means "not allowed" (aborted), never an
// exception escaping the listener that would leave the request hanging. Parse-failure maps to false, not
// to a swallowed error that changes meaning. [LAW:dataflow-not-control-flow] [LAW:no-silent-failure]
const sameOrigin = (url: string, origin: string): boolean => {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
};

export const makeBrowserRenderer = (binding: BrowserWorker): BrowserRenderer => ({
  async withSession<T>(run: (session: RenderSession) => Promise<T>): Promise<T> {
    const browser = await puppeteer.launch(binding);
    try {
      const session: RenderSession = {
        async render(targetUrl: string): Promise<RenderResult> {
          const targetOrigin = new URL(targetUrl).origin;
          // A fresh isolated context per render: its own storage/cookies, so one playground cannot read
          // another's despite sharing the content origin. Disposed in the finally below. [LAW:effects-at-boundaries]
          const context = await browser.createBrowserContext();
          try {
            const page = await context.newPage();
            await page.setViewport(VIEWPORT);

            // The functional signal for the (future) validator: pageerror fires for an uncaught runtime
            // exception AND an inline-script SyntaxError, staying silent for a clean playground and for
            // its own console.error — the low-false-positive discriminator. [LAW:types-are-the-program]
            const pageErrors: string[] = [];
            page.on('pageerror', (error) =>
              pageErrors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
            );

            // Allow ONLY the main-frame navigation to the target's own origin; abort everything else — a
            // subresource, an iframe, or a main-frame navigation AWAY from our origin (the exfiltration
            // path). A self-contained playground needs no other request. The abort/continue promise
            // rejects only on a benign CDP lifecycle race carrying no signal about the artifact; swallow
            // it so it cannot crash the render. [LAW:single-enforcer] [LAW:no-silent-failure]
            await page.setRequestInterception(true);
            page.on('request', (request) => {
              const allow =
                request.isNavigationRequest() &&
                request.frame() === page.mainFrame() &&
                sameOrigin(request.url(), targetOrigin);
              void (allow ? request.continue() : request.abort()).catch((error) =>
                // The abort/continue promise rejects on a benign CDP lifecycle race carrying no artifact
                // signal — swallowed so it cannot crash the render. But a NON-benign rejection (an
                // interceptor logic bug: double-abort, continue-after-handle) would be swallowed just as
                // silently; surface it at debug so it is visible when debugging without adding noise to the
                // frequent benign case. [LAW:no-silent-failure]
                console.debug(`tinkerpad render: request interception rejected (benign lifecycle race unless repeated): ${error instanceof Error ? error.message : String(error)}`),
              );
            });

            let timedOut = false;
            try {
              await page.goto(targetUrl, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
              await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
            } catch (error) {
              // ONLY a load-deadline timeout is tolerated — a heavy playground still yields a best-effort
              // preview and whatever it threw before stalling. Any OTHER failure (a renderer crash, a
              // protocol error) is an infra fault that must propagate loudly. [LAW:no-silent-failure]
              if (!(error instanceof TimeoutError)) throw error;
              timedOut = true;
            }

            const shot = await page.screenshot({ type: 'png' });
            if (timedOut) {
              console.warn(`tinkerpad: render of ${targetUrl} did not finish loading within ${LOAD_TIMEOUT_MS}ms; captured best-effort preview`);
            }
            return { png: new Uint8Array(shot), pageErrors };
          } finally {
            // Dispose the context on every path — a clean render, a thrown fault, a hang — so a wedged or
            // malicious playground leaves nothing behind for the next render. Best-effort: a close() that
            // throws must NOT shadow the successful `return` above (JS finally semantics would discard the
            // captured screenshot and turn a valid render into a failure/retry), so its own fault is logged,
            // not propagated. [LAW:no-ambient-temporal-coupling] [LAW:no-silent-failure]
            await context.close().catch((error) =>
              console.warn(`tinkerpad render: context close failed (screenshot already captured): ${error instanceof Error ? error.message : String(error)}`),
            );
          }
        },
      };
      return await run(session);
    } finally {
      // Close the browser on every exit, so the batch's one launch is always reclaimed. Best-effort for the
      // same reason as the context close: a close() fault must not shadow the batch's return value.
      // [LAW:no-ambient-temporal-coupling] [LAW:no-silent-failure]
      await browser.close().catch((error) =>
        console.warn(`tinkerpad render: browser close failed: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  },
});
