import { describe, expect, it } from 'vitest';
import { makeHeadlessArtifactValidator, resolveBrowserExecutablePath } from './headlessArtifactValidator.js';
import { FunctionalDefectError } from './artifactValidation.js';

// A LIVE test of the REAL headless-Chrome validator: it launches an actual browser and loads real
// artifacts, so it is gated behind TINKERPAD_LIVE=1 (needs a Chrome/Chromium install and takes a couple
// seconds per launch) and never runs in the normal suite or CI:
// `TINKERPAD_LIVE=1 npx vitest run headlessArtifactValidator.live`. It is the on-demand proof that the
// gate accepts a clean playground and rejects exactly the wave-1 defect classes (an uncaught TypeError,
// a script SyntaxError) with zero false positives — the ticket's evidence, made a repeatable test.
// [LAW:verifiable-goals] [LAW:behavior-not-structure]

const live = process.env.TINKERPAD_LIVE === '1';

describe.runIf(live)('headless artifact validator (live, real Chrome)', () => {
  const validator = makeHeadlessArtifactValidator({ executablePath: resolveBrowserExecutablePath(process.env) });

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
