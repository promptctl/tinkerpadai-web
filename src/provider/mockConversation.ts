import type { MockConversation } from './mockProvider.js';

// The canned conversation the mock provider serves when a composition root registers it (the
// edge, behind TINKERPAD_MOCK_PROVIDER). It is DATA, kept apart from the provider mechanism:
// an ordered create → refine walk whose artifacts are real, self-contained, error-free HTML —
// error-free on purpose, so that when the edge's real ArtifactValidator (the Browser Rendering
// gate) turns on, normal mock generation PASSES it rather than always tripping the functional
// gate. A validation-FAILING artifact is deliberately NOT here — that case is constructed
// inline by the validator seam's own tests. [LAW:decomposition] [LAW:no-silent-failure]

// A minimal but genuinely interactive, self-contained playground: inline CSS/JS, no external
// deps, no uncaught errors on load. Two live channels wired to one slider.
const COLOR_MIXER_V1 = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hue Explorer</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font: 16px/1.5 system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; }
    main { width: min(90vw, 420px); text-align: center; }
    #swatch { height: 160px; border-radius: 12px; margin: 16px 0; transition: background-color .1s linear; }
    input[type="range"] { width: 100%; }
    output { font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <main>
    <h1>Hue Explorer</h1>
    <div id="swatch"></div>
    <label>Hue <input id="hue" type="range" min="0" max="360" value="200" /></label>
    <p>hue = <output id="readout">200</output>&deg;</p>
  </main>
  <script>
    const hue = document.getElementById('hue');
    const swatch = document.getElementById('swatch');
    const readout = document.getElementById('readout');
    const paint = () => {
      swatch.style.backgroundColor = 'hsl(' + hue.value + ' 70% 55%)';
      readout.textContent = hue.value;
    };
    hue.addEventListener('input', paint);
    paint();
  </script>
</body>
</html>`;

// The refined version: the same playground with a second control added, so a `continue` turn
// visibly produces a NEW version rather than replaying the first.
const COLOR_MIXER_V2 = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hue &amp; Lightness Explorer</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font: 16px/1.5 system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; }
    main { width: min(90vw, 420px); text-align: center; }
    #swatch { height: 160px; border-radius: 12px; margin: 16px 0; transition: background-color .1s linear; }
    input[type="range"] { width: 100%; }
    output { font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <main>
    <h1>Hue &amp; Lightness Explorer</h1>
    <div id="swatch"></div>
    <label>Hue <input id="hue" type="range" min="0" max="360" value="200" /></label>
    <label>Lightness <input id="light" type="range" min="10" max="90" value="55" /></label>
    <p>hsl(<output id="readout">200 70% 55%</output>)</p>
  </main>
  <script>
    const hue = document.getElementById('hue');
    const light = document.getElementById('light');
    const swatch = document.getElementById('swatch');
    const readout = document.getElementById('readout');
    const paint = () => {
      const color = hue.value + ' 70% ' + light.value + '%';
      swatch.style.backgroundColor = 'hsl(' + color + ')';
      readout.textContent = color;
    };
    for (const control of [hue, light]) control.addEventListener('input', paint);
    paint();
  </script>
</body>
</html>`;

export const defaultMockConversation: MockConversation = {
  turns: [
    {
      progress: [
        'Reading the playground skill…',
        'Sketching a single hue slider with a live swatch…',
        'Writing the self-contained HTML…',
      ],
      runningPolls: 1,
      outcome: { kind: 'artifact', html: COLOR_MIXER_V1 },
    },
    {
      progress: [
        'Re-reading the current version…',
        'Adding a lightness slider alongside the hue control…',
        'Rewiring both controls to one paint step…',
      ],
      runningPolls: 1,
      outcome: { kind: 'artifact', html: COLOR_MIXER_V2 },
    },
  ],
};
