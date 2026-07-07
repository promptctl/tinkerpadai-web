// THE SHARED FRONT-DOOR CHROME PRIMITIVES — the ONE authoritative definition of the design
// pieces that must read identically on the static homepage (index.html) AND every server-rendered
// page (pageShell). Before this module those pieces lived in two hand-kept copies that could
// silently drift; now they live here once, and both surfaces DERIVE from this source:
//   - pageShell.ts imports the token/theme/favicon strings and the format functions directly (server render).
//   - generateIndexHtml.ts splices the same token/theme/favicon strings — and CARD_FORMAT_JS, the
//     client-source twin of the format functions — into index.html at build time (`pnpm build`). The
//     shipped index.html is a complete, self-contained static file; nothing here is fetched at runtime.
// [LAW:one-source-of-truth] [LAW:decomposition]
//
// This is the dependency LEAF: it imports nothing from the web layer, so pageShell, playgroundPages,
// and the generator can all depend on it without a cycle. [LAW:one-way-deps]
//
// (Self-containment is sacred for a PLAYGROUND — one HTML file, no backend, per design-docs/PROJECT.md.
// The front door is platform chrome, not a playground, so generating it from this source at build
// time does not touch that invariant: the artifact it emits is still a self-contained static file.)

// The design tokens — the two custom-property blocks (light default, dark override). Every color on
// every TinkerPad surface flows from one of these; no hex value appears outside them. Shared verbatim
// by index.html's <style> and pageShell's SHELL_STYLES, so a token edit lands on both at once.
// [LAW:one-source-of-truth]
export const TOKENS_CSS = `:root {
    color-scheme: light;
    --bg:               #ffffff;
    --surface:          #f8fafc;
    --border:           #e2e8f0;
    --border-2:         #cbd5e1;
    --text:             #0f172a;
    --text-2:           #334155;
    --muted:            #64748b;
    --muted-2:          #94a3b8;
    --accent:           #6366f1;
    --accent-dark:      #4f46e5;
    --accent-light:     #818cf8;
    --bad:              #ef4444;
    --good:             #10b981;
    --nav-bg:           rgba(255,255,255,0.92);
    --widget-bg:        #ffffff;
    --input-bg:         #f8fafc;
    --input-focus-bg:   #ffffff;
    --step-icon-bg:     rgba(99,102,241,0.08);
    --step-icon-border: rgba(99,102,241,0.15);
    --footer-bg:        #0f172a;
    --footer-border:    #1e293b;
    --footer-text:      #ffffff;
    --footer-link:      #94a3b8;
    --footer-dim:       #475569;
    --shadow-widget:    0 4px 24px rgba(99,102,241,0.08), 0 1px 4px rgba(0,0,0,0.05);
    --shadow-btn:       0 2px 8px rgba(99,102,241,0.3);
    --shadow-btn-h:     0 4px 16px rgba(99,102,241,0.4);
    --radius-sm: 6px;
    --radius-md: 12px;
    --radius-lg: 16px;
  }

  [data-theme="dark"] {
    color-scheme: dark;
    --bg:               #0d1117;
    --surface:          #161b27;
    --border:           #21293a;
    --border-2:         #30363d;
    --text:             #e6edf3;
    --text-2:           #c9d1d9;
    --muted:            #8b949e;
    --muted-2:          #6e7681;
    --accent:           #818cf8;
    --accent-dark:      #6366f1;
    --accent-light:     #a5b4fc;
    --bad:              #f87171;
    --good:             #34d399;
    --nav-bg:           rgba(13,17,23,0.92);
    --widget-bg:        #161b27;
    --input-bg:         #0d1117;
    --input-focus-bg:   #0d1117;
    --step-icon-bg:     rgba(129,140,248,0.1);
    --step-icon-border: rgba(129,140,248,0.2);
    --footer-bg:        #010409;
    --footer-border:    #21293a;
    --footer-text:      #e6edf3;
    --footer-link:      #8b949e;
    --footer-dim:       #6e7681;
    --shadow-widget:    0 4px 24px rgba(129,140,248,0.1), 0 1px 4px rgba(0,0,0,0.3);
    --shadow-btn:       0 2px 8px rgba(99,102,241,0.4);
    --shadow-btn-h:     0 4px 16px rgba(99,102,241,0.5);
  }`;

// The pre-paint theme resolver — the preference waterfall (localStorage → prefers-color-scheme →
// light) inlined in <head> so data-theme is set BEFORE first paint and no page flashes the wrong
// theme. The single resolver of the active token set, shared by both surfaces. It sets the theme
// once at load; the toggle wiring (which lives per-surface) persists later changes.
// [LAW:no-ambient-temporal-coupling] [LAW:one-source-of-truth]
export const THEME_RESOLVER = `<script>(function(){var t=localStorage.getItem('tp-theme');if(!t)t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t)})()</script>`;

// The favicon — the brand mark (the nav-logo-icon: a 135deg #6366f1→#8b5cf6 rounded square with a
// white "TP") expressed as an inline SVG data URI. The SAME mark, not a second asset that can drift
// from it; it travels in the head as source, needing no binary file and no static-file route. Shared
// by both surfaces, so both wear one icon. [LAW:one-source-of-truth]
export const FAVICON_LINK = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%236366f1'/%3E%3Cstop offset='1' stop-color='%238b5cf6'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='7' fill='url(%23g)'/%3E%3Ctext x='16' y='22' font-family='system-ui,-apple-system,sans-serif' font-size='14' font-weight='700' fill='white' text-anchor='middle'%3ETP%3C/text%3E%3C/svg%3E" />`;

// The card format — the byline ("by <author>") and the pluralized step count ("N step(s)"), the two
// presentation formats that must read identically wherever a playground is listed. Both format
// ALREADY-SAFE inputs: the server passes an escaped author and lets its single enforcer own escaping;
// the homepage passes the raw value through textContent, which escapes structurally. So escaping is
// the caller's concern and the FORMAT is the shared thing.
//
// The format exists in two forms that are kept in lockstep by a test (frontDoorChrome.test.ts): the
// TYPED FUNCTIONS below, which the server imports and calls directly, and CARD_FORMAT_JS, the exact
// client source the generator inlines verbatim into the self-contained homepage (which cannot import
// this module at runtime). Two forms rather than one because neither true single-representation path
// is open: emitting the functions via .toString() makes the artifact depend on the ambient
// transpiler's formatting, and evaluating a source string on the server is forbidden on the
// Cloudflare Workers target (no runtime eval). So the format is "derived and explicitly synchronized"
// — the test fails loudly the instant the two forms disagree, which is the whole point.
// [LAW:one-source-of-truth] [LAW:dataflow-not-control-flow] [LAW:no-ambient-temporal-coupling]
export const bylineText = (author: string): string => `by ${author}`;
export const stepText = (count: number): string => `${count} step${count === 1 ? '' : 's'}`;

// The client-inline twin of the two functions above — a byte-stable literal (no transpile step
// touches it), indented to sit under the homepage script's `/*tp:formats*/` marker. Kept identical in
// behaviour to bylineText/stepText by frontDoorChrome.test.ts. [LAW:one-source-of-truth]
export const CARD_FORMAT_JS =
  'const bylineText = (author) => `by ${author}`;\n' +
  "      const stepText = (count) => `${count} step${count === 1 ? '' : 's'}`;";
