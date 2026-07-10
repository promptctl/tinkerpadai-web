import { describe, expect, it } from 'vitest';
import type { SelfContainmentViolation } from './selfContainment.js';
import { findSelfContainmentViolation, MAX_ARTIFACT_BYTES, SelfContainmentError } from './selfContainment.js';

// The accept/reject table made executable — one row per case, derived by perturbing each invariant
// independently rather than probing the happy path. A row that must ACCEPT asserts null; a row that
// must REJECT asserts the sink/kind AND that the offending reference is named (the ticket: "an error
// identifying it"). [LAW:behavior-not-structure]
const ok = (html: string): SelfContainmentViolation | null => findSelfContainmentViolation({ html });

describe('self-containment: accepts artifacts that depend on nothing external', () => {
  it('accepts a minimal inline document', () => {
    expect(ok('<!doctype html><html><body><h1>hi</h1></body></html>')).toBeNull();
  });

  it('accepts inline <script> and <style> with no src/href', () => {
    expect(ok('<style>.a{color:red}</style><script>console.log(1)</script>')).toBeNull();
  });

  it('accepts a data: image', () => {
    expect(ok('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBeNull();
  });

  it('accepts a blob: image', () => {
    expect(ok('<img src="blob:https://x/abc-123">')).toBeNull();
  });

  it('accepts a data: favicon link', () => {
    expect(ok('<link rel="icon" href="data:image/x-icon;base64,AAAB">')).toBeNull();
  });

  it('accepts an inlined @font-face via a data: URI', () => {
    expect(ok('<style>@font-face{font-family:x;src:url(data:font/woff2;base64,d09GMg==)}</style>')).toBeNull();
  });

  it('accepts a data: background image', () => {
    expect(ok('<style>.a{background:url("data:image/svg+xml,<svg/>")}</style>')).toBeNull();
  });

  it('accepts fragment references (SVG use, url(#id), in-page anchors)', () => {
    expect(ok('<svg><use href="#sym"/></svg><div style="fill:url(#grad)"></div><a href="#top">top</a>')).toBeNull();
  });

  it('accepts an external NAVIGATION link — an <a href> is not a resource fetch', () => {
    expect(ok('<a href="https://example.com/docs">learn more</a>')).toBeNull();
  });

  it('accepts a plain-text URL that is not in a resource position', () => {
    expect(ok('<p>See https://example.com for details.</p>')).toBeNull();
  });

  it('accepts a metadata <link> (canonical) — not a fetch-initiating rel', () => {
    expect(ok('<link rel="canonical" href="https://example.com/page">')).toBeNull();
  });

  it('accepts an empty src (no fetch happens)', () => {
    expect(ok('<script src=""></script>')).toBeNull();
  });

  it('accepts a whitespace-padded data: value', () => {
    expect(ok('<img src="  data:image/gif;base64,R0lGOD  ">')).toBeNull();
  });

  it('accepts a reference inside an HTML comment — inert, never fetched by the browser', () => {
    expect(ok('<!-- <script src="https://cdn.example.com/x.js"></script> --><h1>hi</h1>')).toBeNull();
  });

  it('accepts a reference inside a CSS comment inside <style> — inert, never fetched', () => {
    expect(ok('<style>/* background: url(https://cdn.example.com/x.png) */ .a{color:red}</style>')).toBeNull();
  });

  it('accepts a speculative preconnect/dns-prefetch hint — the page renders identically without it', () => {
    expect(ok('<link rel="preconnect" href="https://fonts.gstatic.com">')).toBeNull();
    expect(ok('<link rel="dns-prefetch" href="https://fonts.gstatic.com">')).toBeNull();
  });

  it('accepts new URL(...) in inline JS — a URL parser, not a resource load (css-url must not reach into <script>)', () => {
    expect(ok('<script>const u = new URL("https://api.example.com/data"); render(u);</script>')).toBeNull();
  });

  it('accepts a url(https://...) substring inside a JS string literal — not a CSS resource load', () => {
    expect(ok('<script>const s = "background: url(https://cdn.example.com/x.png)"; label(s);</script>')).toBeNull();
  });

  it('accepts a url(https://...) shown as body text — not a CSS resource load', () => {
    expect(ok('<p>To add a background, write <code>url(https://example.com/img.png)</code> in your CSS.</p>')).toBeNull();
  });

  it('accepts an inline style with a data: url()', () => {
    expect(ok('<div style="background:url(data:image/gif;base64,R0lGOD)"></div>')).toBeNull();
  });

  it('accepts the real href even when a data-href attribute precedes it (attribute-boundary read)', () => {
    expect(
      ok('<link rel="stylesheet" data-href="https://cdn.example.com/x.css" href="data:text/css,body{margin:0}">'),
    ).toBeNull();
  });
});

describe('self-containment: rejects external resource references, naming the sink and reference', () => {
  it('rejects an external <script src> — the acceptance case', () => {
    const v = findSelfContainmentViolation({ html: '<script src="https://cdn.example.com/x.js"></script>' });
    expect(v).toEqual({ kind: 'external-resource', sink: 'script', reference: 'https://cdn.example.com/x.js' });
  });

  it('rejects a protocol-relative script src', () => {
    const v = findSelfContainmentViolation({ html: '<script src="//cdn.example.com/x.js"></script>' });
    expect(v).toEqual({ kind: 'external-resource', sink: 'script', reference: '//cdn.example.com/x.js' });
  });

  it('rejects a relative sibling script (a "multiple files" dependency in disguise)', () => {
    const v = findSelfContainmentViolation({ html: '<script src="app.js"></script>' });
    expect(v).toEqual({ kind: 'external-resource', sink: 'script', reference: 'app.js' });
  });

  it('rejects a root-absolute script path', () => {
    const v = findSelfContainmentViolation({ html: '<script src="/js/app.js"></script>' });
    expect(v).toEqual({ kind: 'external-resource', sink: 'script', reference: '/js/app.js' });
  });

  it('rejects an external stylesheet <link>', () => {
    const v = findSelfContainmentViolation({
      html: '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto">',
    });
    expect(v).toEqual({
      kind: 'external-resource',
      sink: 'stylesheet',
      reference: 'https://fonts.googleapis.com/css?family=Roboto',
    });
  });

  it('rejects an external <img src>', () => {
    const v = findSelfContainmentViolation({ html: '<img src="https://i.imgur.com/x.png">' });
    expect(v).toEqual({ kind: 'external-resource', sink: 'image', reference: 'https://i.imgur.com/x.png' });
  });

  it('rejects a CSS @import url(...)', () => {
    const v = findSelfContainmentViolation({ html: '<style>@import url(https://x.example.com/y.css);</style>' });
    expect(v).toEqual({ kind: 'external-resource', sink: 'css-import', reference: 'https://x.example.com/y.css' });
  });

  it('rejects a CSS @import "..."', () => {
    const v = findSelfContainmentViolation({ html: '<style>@import "https://x.example.com/y.css";</style>' });
    expect(v).toEqual({ kind: 'external-resource', sink: 'css-import', reference: 'https://x.example.com/y.css' });
  });

  it('rejects an external CSS url() background', () => {
    const v = findSelfContainmentViolation({ html: '<style>.a{background:url(https://x.example.com/bg.png)}</style>' });
    expect(v).toEqual({ kind: 'external-resource', sink: 'css-url', reference: 'https://x.example.com/bg.png' });
  });

  it('rejects an external @font-face src url()', () => {
    const v = findSelfContainmentViolation({
      html: '<style>@font-face{font-family:x;src:url(https://x.example.com/f.woff2)}</style>',
    });
    expect(v).toEqual({ kind: 'external-resource', sink: 'css-url', reference: 'https://x.example.com/f.woff2' });
  });

  it('rejects regardless of tag/attribute/scheme case', () => {
    const v = findSelfContainmentViolation({ html: '<SCRIPT SRC="HTTPS://CDN.EXAMPLE.COM/X.JS"></SCRIPT>' });
    expect(v).toEqual({ kind: 'external-resource', sink: 'script', reference: 'HTTPS://CDN.EXAMPLE.COM/X.JS' });
  });

  it('reports the EARLIEST external reference in the document, deterministically', () => {
    const html = '<img src="https://a.example.com/1.png"><script src="https://b.example.com/2.js"></script>';
    const v = findSelfContainmentViolation({ html });
    expect(v).toEqual({ kind: 'external-resource', sink: 'image', reference: 'https://a.example.com/1.png' });
  });

  it('rejects an external url() in an inline style="" attribute', () => {
    const v = findSelfContainmentViolation({ html: '<div style="background:url(https://x.example.com/bg.png)"></div>' });
    expect(v).toEqual({ kind: 'external-resource', sink: 'css-url', reference: 'https://x.example.com/bg.png' });
  });

  it('rejects an external script even when an earlier attribute value contains a > (quote-aware tag scan)', () => {
    const v = findSelfContainmentViolation({ html: '<script data-note="a>b" src="https://evil.example.com/x.js"></script>' });
    expect(v).toEqual({ kind: 'external-resource', sink: 'script', reference: 'https://evil.example.com/x.js' });
  });

  it('rejects an external stylesheet whose href value itself contains a > (quote-aware tag scan)', () => {
    const v = findSelfContainmentViolation({ html: '<link rel="stylesheet" href="https://evil.example.com/s.css?a=>b">' });
    expect(v).toEqual({ kind: 'external-resource', sink: 'stylesheet', reference: 'https://evil.example.com/s.css?a=>b' });
  });
});

describe('self-containment: size cap', () => {
  it('accepts an artifact at the limit', () => {
    expect(ok('a'.repeat(MAX_ARTIFACT_BYTES))).toBeNull();
  });

  it('rejects an artifact over the limit, carrying the measured size and limit', () => {
    const bytes = MAX_ARTIFACT_BYTES + 1;
    const v = findSelfContainmentViolation({ html: 'a'.repeat(bytes) });
    expect(v).toEqual({ kind: 'oversize', bytes, limit: MAX_ARTIFACT_BYTES });
  });

  it('measures UTF-8 bytes, not code units — a multibyte body over the limit is rejected', () => {
    // '€' is 3 UTF-8 bytes; enough of them exceed the byte cap while the string length (code units)
    // would not, proving the gate measures bytes.
    const count = Math.floor(MAX_ARTIFACT_BYTES / 3) + 1;
    const html = '€'.repeat(count);
    expect(html.length).toBeLessThanOrEqual(MAX_ARTIFACT_BYTES);
    expect(findSelfContainmentViolation({ html })).toEqual({
      kind: 'oversize',
      bytes: count * 3,
      limit: MAX_ARTIFACT_BYTES,
    });
  });
});

describe('SelfContainmentError: renders an actionable message from the violation', () => {
  it('names the sink and the offending reference for an external resource', () => {
    const error = new SelfContainmentError({
      kind: 'external-resource',
      sink: 'script',
      reference: 'https://cdn.example.com/x.js',
    });
    expect(error.message).toContain('script');
    expect(error.message).toContain('https://cdn.example.com/x.js');
    expect(error.violation.kind).toBe('external-resource');
  });

  it('states the size and limit for an oversize artifact', () => {
    const error = new SelfContainmentError({ kind: 'oversize', bytes: 9_000_000, limit: MAX_ARTIFACT_BYTES });
    expect(error.message).toContain('9000000');
    expect(error.message).toContain(String(MAX_ARTIFACT_BYTES));
  });
});
