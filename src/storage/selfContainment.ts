import type { Artifact } from '../provider/index.js';

// THE SELF-CONTAINMENT INVARIANT, as a value. A playground is ONE self-contained HTML file — inline
// CSS/JS, no external deps, nothing fetched to run it (design-docs/PROJECT.md). This module owns the
// static, ingest-time expression of that invariant: given an artifact's bytes, does it reference
// anything outside itself, or is it absurdly large? It is a PURE predicate (it computes, never acts —
// the store that composes it owns the throw), so it can be reasoned about and tested in isolation.
// [LAW:effects-at-boundaries] [LAW:decomposition]
//
// WHAT THIS IS NOT. This is a QUALITY gate, not the security boundary. The security boundary is the
// playground CSP (src/web/contentHandler.ts): default-src 'none', connect-src 'none', inline-only
// script/style, data:/blob: images — at RUNTIME it neutralizes every external reference regardless of
// what got stored. A STATIC check over HTML/CSS/JS can never be complete (JS builds URLs at runtime),
// so this deliberately does NOT claim to catch every external reference. Its job is to reject the
// common, clear violations at INGEST — a CDN <script>, an external stylesheet, an @import — so a
// broken, non-self-contained artifact is refused (and generation can retry) instead of entering the
// commons to render broken under the CSP. Truthful about its own reach, by construction. [FRAMING:representation]

// Which resource-loading position carried the external reference — named so the refusal is actionable
// (the ticket: "an error identifying it"). This is the ENUMERATED static sink set: the standard
// elements/CSS constructs that fetch a subresource, covering the contract's script/style/font/image.
// It is deliberately a closed, documented set rather than an implied-total one — extending coverage
// (e.g. <source>, <iframe>) means adding a sink here and a row to the table, never loosening the
// closed allowlist below. [LAW:no-mode-explosion]
export type ResourceSink =
  | 'script' // <script src>
  | 'stylesheet' // <link href> with a fetch-initiating rel (stylesheet, preload, icon, manifest, …)
  | 'image' // <img src>
  | 'css-url' // url(...) in CSS — backgrounds, @font-face fonts, list-style-image, …
  | 'css-import'; // @import in CSS

// The two independent ways an artifact breaks self-containment, as a discriminated value — never a
// bare boolean that loses WHICH invariant failed and WHAT the offender was. `external-resource`
// carries the sink and the offending reference; `oversize` carries the measured size and the limit.
// The illegal states (a resource violation with no reference, a size violation with no numbers) are
// unrepresentable. [LAW:types-are-the-program]
export type SelfContainmentViolation =
  | { readonly kind: 'external-resource'; readonly sink: ResourceSink; readonly reference: string }
  | { readonly kind: 'oversize'; readonly bytes: number; readonly limit: number };

// The absurd-size ceiling. A self-contained playground legitimately inlines its assets as data: URIs
// (small images, a font), which is not free — so the cap is generous. Past it, the artifact is not a
// playground inlining a few assets but something absurd (an inlined video, a runaway generation); such
// bytes have no place in the commons. A fixed, documented constant, not a deploy knob: there is no
// per-deploy reason for "how absurd is absurd" to vary, and a knob would be a mode to enumerate and
// test for no gain. [LAW:no-mode-explosion]
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

// The one refusal the storage seam raises when an artifact fails self-containment. It carries the
// typed violation (for programmatic handling — the generation service routes it to the failed-turn
// path) AND renders it to an actionable human message once, here, so the message cannot drift from the
// violation it describes. A caller that only reads `.message` gets the actionable text; one that needs
// to branch reads `.violation`. [LAW:one-source-of-truth] [LAW:types-are-the-program]
export class SelfContainmentError extends Error {
  constructor(public readonly violation: SelfContainmentViolation) {
    super(describeViolation(violation));
    this.name = 'SelfContainmentError';
  }
}

// The single home for turning a violation into prose — so the wording lives once, beside the type it
// describes. [LAW:one-source-of-truth]
const describeViolation = (v: SelfContainmentViolation): string => {
  switch (v.kind) {
    case 'external-resource':
      return `not self-contained: ${sinkLabel(v.sink)} points outside the file ("${truncate(v.reference)}"). A playground is one self-contained HTML file — inline the asset as a data: URI or remove the reference.`;
    case 'oversize':
      return `not self-contained: the artifact is ${v.bytes} bytes, over the ${v.limit}-byte limit. Inline assets more compactly or split into a smaller playground.`;
    default: {
      const unreachable: never = v;
      return unreachable;
    }
  }
};

// A human phrase per sink — the ACTUAL element/CSS construct, so the message names the real thing to
// fix (a <link>, not the internal 'stylesheet' label; an @import, not a made-up tag). [FRAMING:representation]
const sinkLabel = (sink: ResourceSink): string => {
  switch (sink) {
    case 'script':
      return 'an external script (<script src>)';
    case 'stylesheet':
      return 'an external stylesheet or icon (<link href>)';
    case 'image':
      return 'an external image (<img src>)';
    case 'css-url':
      return 'an external CSS url() reference';
    case 'css-import':
      return 'an external CSS @import';
    default: {
      const unreachable: never = sink;
      return unreachable;
    }
  }
};

// Keep a reported reference readable in a one-line error — a relative path or URL is short, but nothing
// guarantees it, and a wall of text buries the signal. [LAW:comments-explain-why-only]
const truncate = (ref: string): string => (ref.length > 120 ? `${ref.slice(0, 117)}...` : ref);

// THE CLOSED ALLOWLIST — the crux of rejecting external references without an enumeration gap. A
// resource reference is self-contained iff it embeds its own bytes (a data: or blob: URI) or points
// nowhere external (empty, or a #fragment into this same document). EVERYTHING ELSE is rejected by
// construction: an http(s)/protocol-relative/ws(s) URL phones home; a relative or root-absolute path
// (`app.js`, `/x.png`) names a sibling file the one-file commons never serves — a "multiple files"
// violation in disguise. Because the accept-set is closed, a novel external form (a new scheme, a
// typo'd host) is rejected by default rather than slipping through a blocklist's gaps.
// [LAW:types-are-the-program]
const referenceIsSelfContained = (raw: string): boolean => {
  const ref = raw.trim();
  if (ref === '' || ref.startsWith('#')) return true;
  const lower = ref.toLowerCase();
  return lower.startsWith('data:') || lower.startsWith('blob:');
};

// Read one attribute's value out of a single element's opening tag, tolerating double/single/unquoted
// forms and case. Returns null when the attribute is absent — a value the caller handles, not a throw.
// The tag string is one already-matched `<... >`, so this never spans elements. The `(?<![-\w])`
// lookbehind anchors the name to a real attribute boundary: without it, a plain `\b${name}` matches
// INSIDE a hyphenated attribute (`href` within `data-href`, `rel` within `data-rel`) — a `\b` fires at
// the '-'→letter transition — so a `data-*` attribute would hijack the read and a self-contained file
// be wrongly refused. [LAW:types-are-the-program] [LAW:no-defensive-null-guards]
const attrValue = (tag: string, name: string): string | null => {
  const m = new RegExp(`(?<![-\\w])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  if (m === null) return null;
  return m[1] ?? m[2] ?? m[3] ?? '';
};

// A rel token set for links that load a SUBRESOURCE THIS page renders with — a stylesheet, a preloaded
// asset, a favicon, a manifest. A <link> with any other rel loads nothing that affects this page:
// metadata rels (canonical, alternate, author) load nothing, and speculative hints (preconnect,
// dns-prefetch, prefetch, prerender) only warm a connection or fetch for a FUTURE navigation — the page
// renders identically without them. Neither is a broken dependency, so neither is flagged: this stays
// precision-biased, refusing artifacts that would render broken, not perf hints that render fine.
// [FRAMING:representation]
const FETCH_INITIATING_LINK_RELS = new Set([
  'stylesheet',
  'preload',
  'modulepreload',
  'icon',
  'shortcut',
  'apple-touch-icon',
  'mask-icon',
  'manifest',
]);

const linkFetchesHref = (tag: string): boolean => {
  const rel = attrValue(tag, 'rel');
  if (rel === null) return false;
  return rel
    .toLowerCase()
    .split(/\s+/)
    .some((token) => FETCH_INITIATING_LINK_RELS.has(token));
};

// One offending reference found by a detector: its sink and value, plus WHERE it sits in the document,
// so the caller can report the EARLIEST violation deterministically rather than an arbitrary one.
interface SinkHit {
  readonly sink: ResourceSink;
  readonly reference: string;
  readonly index: number;
}

// The value captured from a quoted-or-unquoted attribute/url regex — the first defined group.
const captured = (m: RegExpMatchArray, groups: readonly number[]): string => {
  for (const g of groups) {
    const value = m[g];
    if (value !== undefined) return value;
  }
  return '';
};

// The opening-tag interior, modelled so a '>' INSIDE a quoted attribute value does not end the tag: a
// quoted run ("…" or '…') is consumed as a UNIT, and only outside quotes does '>' terminate. A plain
// `[^>]` would truncate `<link href="…?a=>">` at the query-string '>' and lose the rest of the tag —
// a real external ref then slips through. The three alternatives are disjoint on their first character
// (", ', or neither), so there is no ambiguity to backtrack over. Modelling this much of HTML's grammar
// is the honest floor for a parser-less scan. [FRAMING:representation]
const TAG_INNER = `(?:"[^"]*"|'[^']*'|[^>"'])`;
const openTag = (name: string): RegExp => new RegExp(`<${name}\\b${TAG_INNER}*>`, 'gi');
// The reference of a src-style attribute, quoted or unquoted — groups [1,2,3]. The `${TAG_INNER}*?`
// prefix skips earlier attributes (quote-aware) to reach `src`.
const srcAttr = (name: string): RegExp =>
  new RegExp(`<${name}\\b${TAG_INNER}*?\\ssrc\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'gi');

const SCRIPT_SRC = srcAttr('script');
const IMG_SRC = srcAttr('img');
const LINK_TAG = openTag('link');
// A <script> element split into its opening tag, body, and close — matched to the FIRST </script> (or
// end of input for a malformed unclosed script), the same boundary a browser uses since inline JS
// cannot contain a literal </script>. Used to BLANK the BODY while KEEPING both tags: script content is
// raw text (not HTML, not CSS), so blanking it makes it inert for comment stripping and CSS scanning
// alike, while the preserved <script src> opening tag stays visible to the script-src scan.
const SCRIPT_ELEMENT = new RegExp(`(<script\\b${TAG_INNER}*>)([\\s\\S]*?)(</script>|$)`, 'gi');
const STYLE_BLOCK = new RegExp(`<style\\b${TAG_INNER}*>([\\s\\S]*?)</style>`, 'gi');
// A style="" / style='' / style=unquoted attribute value, anchored to a real attribute boundary (see
// attrValue) so it is not read out of `data-style`. All three legal quoting forms are covered — the
// same shape attrValue reads — so an unquoted `style=background:url(…)` (legal, spaceless) is not a gap.
// Groups [1]/[2]/[3] carry the inline CSS (double / single / unquoted). [LAW:one-type-per-behavior]
const STYLE_ATTR = /(?<![-\w])style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
// The value-carrying groups differ per pattern (quoted / single-quoted / unquoted / url-wrapped).
const CSS_IMPORT = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)|"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi;

// A src-attribute detector (script, img): scan the html for the sink and yield every hit whose
// reference is NOT self-contained. [LAW:dataflow-not-control-flow]
const scanSrc = (html: string, sink: ResourceSink, pattern: RegExp): SinkHit[] => {
  const hits: SinkHit[] = [];
  for (const m of html.matchAll(pattern)) {
    const reference = captured(m, [1, 2, 3]);
    if (!referenceIsSelfContained(reference)) hits.push({ sink, reference, index: m.index ?? 0 });
  }
  return hits;
};

// <link> needs two attributes read together (rel decides whether href is a fetch), so it is scanned as
// whole tags rather than a single attribute regex.
const scanLinks = (html: string): SinkHit[] => {
  const hits: SinkHit[] = [];
  for (const m of html.matchAll(LINK_TAG)) {
    const tag = m[0];
    if (!linkFetchesHref(tag)) continue;
    const href = attrValue(tag, 'href');
    if (href !== null && !referenceIsSelfContained(href)) {
      hits.push({ sink: 'stylesheet', reference: href, index: m.index ?? 0 });
    }
  }
  return hits;
};

// One CSS region and where it sits in the document, so a url()/@import hit's position stays in document
// space for deterministic earliest-reporting. Its own /* */ comments are stripped for the same reason
// HTML comments are: a commented-out url() is never fetched.
interface CssRegion {
  readonly text: string;
  readonly offset: number;
}

// Strip CSS /* */ comments, but ONLY those that open OUTSIDE a string. A naive regex cannot tell a
// comment opener from the bytes `/*` sitting inside a quoted value — `url("https://x/*/y.png")` — and
// would swallow the whole url() to the next `*/`, SILENTLY HIDING a real external reference from the
// scan. A single left-to-right pass that tracks string state draws the line correctly: inside a
// "…"/'…' string, `/*` is data; only outside is it a comment. Escapes are honored so a `\"` does not
// close a string early. [LAW:no-silent-failure] [LAW:types-are-the-program]
const stripCssComments = (css: string): string => {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (quote !== null) {
      out += c;
      if (c === '\\' && i + 1 < css.length) {
        out += css[i + 1];
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      if (end === -1) return out; // an unterminated comment runs to end of the CSS
      i = end + 1; // resume after the '*/'; the loop's i += 1 lands on the next char
      continue;
    }
    out += c;
  }
  return out;
};

// THE CSS DOMAIN, extracted. url()/@import are CSS constructs — they mean "load this" only inside CSS,
// which in HTML is exactly <style> block contents and style="" attribute values. Scanning ONLY these,
// never the whole file, keeps the CSS detectors out of <script> JS (where `new URL(...)` is a URL
// parser, not a resource load) and out of body text. The caller additionally blanks <script> bodies
// before calling in (see findSelfContainmentViolation), so a <style> element written as a string
// literal inside JS is not extracted either — together, CSS detectors never see <script> content. The
// detector's input is cut to match its domain; scanning the whole file would be a seam cut in the wrong
// place. [LAW:decomposition]
const cssRegions = (html: string): CssRegion[] => {
  const regions: CssRegion[] = [];
  for (const m of html.matchAll(STYLE_BLOCK)) {
    const inner = m[1] ?? '';
    const offset = (m.index ?? 0) + (m[0].length - inner.length - '</style>'.length);
    regions.push({ text: stripCssComments(inner), offset });
  }
  for (const m of html.matchAll(STYLE_ATTR)) {
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    // A quoted value (groups 1/2) ends one char before the match end (the closing quote); an unquoted
    // value (group 3) ends AT the match end. The offset points at the value's start either way.
    const trailingQuote = m[3] === undefined ? 1 : 0;
    const offset = (m.index ?? 0) + (m[0].length - trailingQuote - value.length);
    // Strip CSS comments here too — a /* */ is valid CSS in an inline style and the browser never
    // fetches a url() inside one, so comment handling must be uniform across every CSS region.
    regions.push({ text: stripCssComments(value), offset });
  }
  return regions;
};

const scanCss = (html: string): SinkHit[] => {
  const hits: SinkHit[] = [];
  for (const region of cssRegions(html)) {
    for (const m of region.text.matchAll(CSS_IMPORT)) {
      const reference = captured(m, [1, 2, 3, 4, 5]);
      if (!referenceIsSelfContained(reference)) {
        hits.push({ sink: 'css-import', reference, index: region.offset + (m.index ?? 0) });
      }
    }
    for (const m of region.text.matchAll(CSS_URL)) {
      const reference = captured(m, [1, 2, 3]);
      if (!referenceIsSelfContained(reference)) {
        hits.push({ sink: 'css-url', reference, index: region.offset + (m.index ?? 0) });
      }
    }
  }
  return hits;
};

// THE PURE INVARIANT over an artifact: return the FIRST violation (or null when self-contained). Size
// is checked before the resource scan so an absurd blob is refused without running regexes over
// megabytes — the cheap, bounding gate goes first. Among resource sinks the EARLIEST by document
// position is reported: the most intuitive "the first external reference in the file", and
// deterministic for tests. Returning ONE violation is sufficient — generation regenerates the whole
// file on retry — and keeps this a value-returning function, not a branchy report builder.
// [LAW:dataflow-not-control-flow] [LAW:no-silent-failure]
export const findSelfContainmentViolation = (artifact: Artifact): SelfContainmentViolation | null => {
  // Size is measured on the RAW bytes — a comment is still bytes on disk. Anything past the cap is
  // refused before the scan, so an absurd blob is never regex-walked.
  const bytes = new TextEncoder().encode(artifact.html).length;
  if (bytes > MAX_ARTIFACT_BYTES) {
    return { kind: 'oversize', bytes, limit: MAX_ARTIFACT_BYTES };
  }
  // Preprocess in the same order a browser resolves structure, so the scan judges what the browser
  // actually fetches. ORDER IS LOAD-BEARING:
  // 1. Blank <script> BODIES (keeping both tags, length-preserving). Script content is raw text — a
  //    `<!--` inside it is NOT a comment opener to a browser — so this MUST run before comment
  //    stripping: otherwise a `<!--` in a script body, with its matching `-->` further down, would let
  //    the comment strip swallow a real <script src> in between and evade the gate. Blanking bodies also
  //    keeps a <style> literal written inside JS from being extracted as CSS. The <script src> opening
  //    tag is preserved for the script-src scan; blanking is length-preserving so hit indices stay in
  //    one coordinate space for earliest-reporting.
  // 2. Strip HTML comments — now `<!--` appears only where a browser parses a comment. A reference
  //    inside a real <!-- --> is inert and never fetched, so flagging it would falsely reject a
  //    self-contained playground. Comments do not nest, so one non-greedy strip is exact.
  // Residual, documented limits of a parser-less scan (a `<script src=…>` built dynamically at runtime)
  // are out of static reach — the CSP neutralizes those at runtime. [LAW:decomposition] [FRAMING:representation]
  const bodyBlanked = artifact.html.replace(
    SCRIPT_ELEMENT,
    (_m, open: string, body: string, close: string) => open + ' '.repeat(body.length) + close,
  );
  const scannable = bodyBlanked.replace(/<!--[\s\S]*?-->/g, '');
  const hits = [
    ...scanSrc(scannable, 'script', SCRIPT_SRC),
    ...scanLinks(scannable),
    ...scanSrc(scannable, 'image', IMG_SRC),
    ...scanCss(scannable),
  ];
  const earliest = hits.reduce<SinkHit | null>((best, hit) => (best === null || hit.index < best.index ? hit : best), null);
  if (earliest === null) return null;
  return { kind: 'external-resource', sink: earliest.sink, reference: earliest.reference };
};
