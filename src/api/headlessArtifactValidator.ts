import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { accessSync, constants } from 'node:fs';
import puppeteer, { TimeoutError } from 'puppeteer-core';
import type { Artifact } from '../provider/index.js';
import { FunctionalDefectError } from './artifactValidation.js';
import type { ArtifactValidator } from './artifactValidation.js';

// THE LOCAL HEADLESS-CHROME ARTIFACT VALIDATOR — the concrete effect behind the ArtifactValidator seam
// on the Node steel thread. It loads the artifact in a real browser (matching the wave-1 evidence that
// found exactly the fatal-JS class with zero false positives) and rejects FunctionalDefectError when the
// page throws an uncaught exception on load. It lives in a module NOTHING in the shared app graph
// imports — only the Node composition root (src/web/nodeApp.ts) and the Node entries reach it — so
// puppeteer never enters the edge Worker bundle (the same isolation the tmux driver has). The edge wires
// passThroughValidator instead. [LAW:effects-at-boundaries] [LAW:decomposition]
//
// SECURITY POSTURE. This runs untrusted, generated HTML in a browser on the operator's own machine. It
// is acceptable HERE because generation today is local and operator-driven (the tmux provider on the
// operator's box; public edge generation is disabled), so this is the same trust context generation
// already occupies — not a new public attack surface. It is nonetheless hardened: Chrome's OS sandbox
// stays ON (no --no-sandbox); the artifact is served from a throwaway localhost origin and every request
// other than the main document is ABORTED, so untrusted code cannot load an external resource or phone
// home; and a bounded load deadline means a wedged playground cannot hang the pipeline. When public
// generation turns on at the edge, an ISOLATED render sandbox swaps in behind the seam
// (design-docs/proposals/thumbnails-rye.3.md); this local validator is not that. [LAW:single-enforcer]

// How long a self-contained file gets to load before the check treats the load as INCONCLUSIVE. A
// self-contained (<=5MB) file loads in a second or two; this is generous. A fixed, documented constant,
// not a deploy knob — how long a static file takes to parse in a browser has no per-deploy reason to
// vary (mirrors selfContainment's MAX_ARTIFACT_BYTES). [LAW:no-mode-explosion]
const LOAD_TIMEOUT_MS = 10_000;

// A brief settle after the load event, to catch an error scheduled to fire just after load (e.g. a
// setTimeout(..., 0) throw). Best-effort for asynchronous errors; the guaranteed contract is load-time
// errors. This validator is the one owner of that timing. [LAW:no-ambient-temporal-coupling]
const SETTLE_MS = 250;

export interface HeadlessValidatorConfig {
  // The Chrome/Chromium executable to drive. An environment fact (a path that differs across machines),
  // so it is supplied by the composition boundary, never probed inside this factory — see
  // resolveBrowserExecutablePath, which the Node entries call. [LAW:effects-at-boundaries]
  readonly executablePath: string;
  readonly loadTimeoutMs?: number;
  readonly settleMs?: number;
}

export const makeHeadlessArtifactValidator = (config: HeadlessValidatorConfig): ArtifactValidator => {
  const loadTimeoutMs = config.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
  const settleMs = config.settleMs ?? SETTLE_MS;

  return async (artifact: Artifact): Promise<void> => {
    // Serve the bytes from a throwaway localhost origin bound to an ephemeral port. localhost is a real,
    // secure-context origin, so a playground that legitimately uses secure-context APIs (crypto.subtle)
    // loads as it will at runtime; serving over HTTP (not a data: URL) also dodges Chrome's data-URL size
    // ceiling, so an artifact inlining assets up to the 5MB cap still loads. [LAW:effects-at-boundaries]
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(artifact.html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    // The server is now listening, so its close is owed on EVERY exit — including a puppeteer.launch that
    // throws (a bad executable path, Chrome missing a shared lib, a denied sandbox). The launch lives
    // INSIDE this try so the outer finally always reclaims the socket; the browser gets its own inner
    // finally so it too is closed on every post-launch path, without depending on launch having
    // succeeded. Two resources, two nested finallys, no leak on any branch. [LAW:no-ambient-temporal-coupling]
    try {
      const browser = await puppeteer.launch({
        executablePath: config.executablePath,
        headless: true,
        // NO --no-sandbox: Chrome's OS sandbox stays ON while it executes untrusted code.
        args: ['--disable-gpu'],
      });
      try {
        const page = await browser.newPage();

        // The signal. pageerror fires for BOTH wave-1 defect classes — an uncaught runtime exception AND an
        // inline-script SyntaxError — and stays silent for a clean playground and for a playground's own
        // console.error logging. It is the low-false-positive discriminator; console-level errors are NOT
        // used (they flag a playground's own console.error and offline resource failures, which are the
        // static self-containment check's concern, not this one). [LAW:types-are-the-program]
        const errors: string[] = [];
        page.on('pageerror', (error) =>
          errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
        );

        await page.setRequestInterception(true);
        page.on('request', (request) => {
          // Allow ONLY the main-frame navigation to our throwaway origin; abort everything else. A self-
          // contained playground needs no subresources, so any other request is an external load (which the
          // runtime CSP also blocks) or an exfiltration attempt — refused here. [LAW:single-enforcer]
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            void request.continue();
          } else {
            void request.abort();
          }
        });

        let timedOut = false;
        try {
          await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: loadTimeoutMs });
          // Normal load completed: a short settle to observe an error scheduled just after the load event.
          await new Promise((resolve) => setTimeout(resolve, settleMs));
        } catch (error) {
          // ONLY a load-deadline timeout is recoverable here — a heavy or wedged renderer. Any OTHER
          // navigation failure (a renderer crash, a protocol error) is an infra fault that must propagate
          // loudly rather than silently admit an unvalidated artifact — the same discrimination the service
          // makes between a typed quality failure and a real fault. [LAW:no-silent-failure]
          if (!(error instanceof TimeoutError)) throw error;
          timedOut = true;
        }

        // Decide on the errors observed through load — OR up to a timeout. This check runs on BOTH paths:
        // an uncaught error observed before a timeout is a real defect and must not be discarded by the
        // timeout (an artifact that throws and then hangs is broken, not inconclusive). [LAW:no-silent-failure]
        const [first, ...rest] = errors;
        if (first !== undefined) {
          throw new FunctionalDefectError([first, ...rest]);
        }

        // No uncaught error observed. A timeout with nothing observed is genuinely INCONCLUSIVE (a wedged
        // renderer fires no error events) — passing keeps the gate's zero-false-positive contract, but it is
        // surfaced loudly, never silently. [LAW:no-silent-failure]
        if (timedOut) {
          console.warn(
            `tinkerpad: functional validation did not finish loading within ${loadTimeoutMs}ms; passing as inconclusive`,
          );
        }
      } finally {
        // Close the browser on every post-launch path — a clean check, a thrown defect, a hang. A fresh
        // browser per check means a wedged playground's process is fully reclaimed and cannot affect the
        // next. [LAW:no-ambient-temporal-coupling]
        await browser.close();
      }
    } finally {
      // Reclaim the listening socket on every exit, INCLUDING a launch that threw before the browser
      // existed — the leak the reviewer flagged. [LAW:no-ambient-temporal-coupling]
      server.close();
    }
  };
};

// The Chrome/Chromium executables this validator can drive, probed in order when TINKERPAD_CHROME_PATH is
// not set. A closed, documented list (the common macOS and Linux install locations), extended by adding a
// path here — never by a silent auto-download. [LAW:no-mode-explosion]
const KNOWN_CHROME_PATHS: readonly string[] = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// Resolve the browser executable at the composition boundary (a filesystem effect), from an explicit
// TINKERPAD_CHROME_PATH override or, failing that, the first known install location that exists. Absence
// is a LOUD failure with actionable remediation, never a silent fallback to "no functional gate" — a
// Node generation deployment without a browser is a misconfiguration, because silently skipping
// validation is exactly the broken-artifact leak this ticket closes. An explicitly-set-but-missing path
// also fails loudly rather than falling back to a probe the operator did not ask for. [LAW:no-silent-failure]
export const resolveBrowserExecutablePath = (env: NodeJS.ProcessEnv): string => {
  const configured = env.TINKERPAD_CHROME_PATH?.trim();
  if (configured !== undefined && configured !== '') {
    if (!isExecutable(configured)) {
      throw new Error(`TINKERPAD_CHROME_PATH=${JSON.stringify(configured)} is not an executable file`);
    }
    return configured;
  }
  const found = KNOWN_CHROME_PATHS.find(isExecutable);
  if (found === undefined) {
    throw new Error(
      'functional artifact validation requires a Chrome or Chromium browser, and none was found in the ' +
        'known install locations. Install Google Chrome, or set TINKERPAD_CHROME_PATH to a Chrome/Chromium executable.',
    );
  }
  return found;
};
