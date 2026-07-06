import { escapeHtml } from './escapeHtml.js';

// THE SHARED SERVER-RENDERED PAGE SHELL. Every app-origin page the server builds as a STRING
// (the commons, the notice/error pages, the player) is wrapped here, so the design tokens, the
// theme resolver, the reset, and the site chrome (nav + footer) are defined EXACTLY ONCE for the
// dynamic surfaces. Before this file each renderer carried its own divergent token block; now
// they share one. [LAW:one-source-of-truth] [LAW:decomposition]
//
// index.html is the deliberate, documented TWIN of these tokens — a hand-authored static file
// that must be self-contained and paint pre-request with no build step, so it inlines its own
// copy rather than importing this one. That is the single marked exception to the source-of-truth
// above; the token blocks below are kept byte-identical to index.html's on purpose, and an edit
// to one is an edit to both. [LAW:one-source-of-truth] exception: static file, no build step.
//
// This module knows NOTHING about playgrounds — it is generic chrome that any page composes.
// The playground-shaped fragments (cards, bylines, recipes) live in playgroundPages, which
// depends on this file and never the reverse. [LAW:one-way-deps]

// The design-token stylesheet: the two token blocks (light default, dark override) copied
// verbatim from index.html, then the reset, base type, and the reusable component classes the
// content pages share — nav, footer, the container/page-head, and the card grid. Every color
// flows from a token; no hex values appear outside :root / [data-theme="dark"].
// [LAW:one-source-of-truth]
const SHELL_STYLES = `
  :root {
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
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    transition: background 0.2s ease, color 0.2s ease;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { color: var(--accent-dark); }

  /* ── NAV ───────────────────────────────────── */
  .nav {
    position: sticky;
    top: 0;
    z-index: 100;
    background: var(--nav-bg);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    padding: 0 2rem;
    height: 60px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2rem;
    transition: background 0.2s ease, border-color 0.2s ease;
  }
  .nav-logo { display: flex; align-items: center; gap: 0.6rem; text-decoration: none; flex-shrink: 0; }
  .nav-logo-icon {
    width: 30px; height: 30px;
    border-radius: 8px;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    display: flex; align-items: center; justify-content: center;
    color: white; font-size: 0.75rem; font-weight: 700; letter-spacing: -0.5px;
    flex-shrink: 0;
  }
  .nav-logo-text { font-weight: 600; font-size: 1rem; color: var(--text); letter-spacing: -0.3px; }
  .nav-links { display: flex; align-items: center; gap: 0.25rem; list-style: none; }
  .nav-links a {
    color: var(--muted); font-size: 0.9rem; font-weight: 500;
    padding: 0.4rem 0.75rem; border-radius: var(--radius-sm);
    transition: color 0.15s, background 0.15s;
  }
  .nav-links a:hover { color: var(--text); background: var(--surface); }
  .nav-actions { display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0; }
  .theme-toggle {
    width: 34px; height: 34px;
    border-radius: var(--radius-sm);
    background: transparent; border: 1px solid var(--border); color: var(--muted);
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    font-size: 1rem; line-height: 1; padding: 0;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .theme-toggle:hover { background: var(--surface); color: var(--text); border-color: var(--border-2); }
  .icon-sun  { display: none; }
  .icon-moon { display: block; }
  [data-theme="dark"] .icon-sun  { display: block; }
  [data-theme="dark"] .icon-moon { display: none; }
  .btn-primary {
    background: var(--accent); color: white; border: none;
    border-radius: 8px; padding: 0.45rem 1rem; font: 500 0.9rem inherit;
    cursor: pointer; text-decoration: none; display: inline-block;
    transition: background 0.15s, transform 0.1s;
  }
  .btn-primary:hover { background: var(--accent-dark); color: white; transform: translateY(-1px); }

  /* ── CONTENT PAGE ──────────────────────────── */
  .container { max-width: 1100px; margin: 0 auto; padding: 3rem 2rem 4rem; }
  .page-head { margin-bottom: 2rem; }
  .page-head h1 { font-size: clamp(1.7rem, 3vw, 2.3rem); font-weight: 800; letter-spacing: -0.02em; color: var(--text); }
  .page-head .lede { color: var(--muted); font-size: 1rem; margin-top: 0.4rem; }
  .page-head .lede a { font-weight: 500; }

  /* ── CARD GRID ─────────────────────────────── */
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1.25rem;
  }
  .card {
    display: block;
    background: var(--widget-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 1.1rem 1.2rem;
    box-shadow: var(--shadow-widget);
    text-decoration: none;
    transition: border-color 0.15s, box-shadow 0.15s, transform 0.1s;
  }
  .card:hover { border-color: var(--border-2); box-shadow: var(--shadow-btn); transform: translateY(-2px); }
  .card-title { font-weight: 600; font-size: 1rem; color: var(--text); line-height: 1.4; word-break: break-word; }
  .card:hover .card-title { color: var(--accent); }
  .card-meta { color: var(--muted); font-size: 0.8rem; margin-top: 0.55rem; }
  .card-fork { color: var(--muted); font-size: 0.78rem; margin-top: 0.4rem; }
  .card-fork a { font-weight: 600; }
  .empty {
    color: var(--muted);
    background: var(--surface);
    border: 1px dashed var(--border-2);
    border-radius: var(--radius-lg);
    padding: 3rem 1.5rem;
    text-align: center;
  }

  /* ── FOOTER ────────────────────────────────── */
  .site-footer { background: var(--footer-bg); padding: 2.5rem 2rem 1.5rem; transition: background 0.2s ease; }
  .footer-inner { max-width: 1100px; margin: 0 auto; }
  .footer-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2rem; gap: 1rem; flex-wrap: wrap; }
  .footer-brand { display: flex; align-items: center; gap: 0.6rem; text-decoration: none; }
  .footer-brand-icon { width: 26px; height: 26px; border-radius: 7px; background: linear-gradient(135deg, #6366f1, #8b5cf6); flex-shrink: 0; }
  .footer-brand-text { font-weight: 600; font-size: 0.9rem; color: var(--footer-text); }
  .footer-links { display: flex; gap: 1.5rem; list-style: none; flex-wrap: wrap; }
  .footer-links a { color: var(--footer-link); font-size: 0.85rem; text-decoration: none; transition: color 0.15s; }
  .footer-links a:hover { color: var(--footer-text); }
  .footer-bottom { border-top: 1px solid var(--footer-border); padding-top: 1.25rem; font-size: 0.78rem; color: var(--footer-dim); }
`;

// The pre-paint theme resolver — the SAME preference waterfall index.html runs (localStorage →
// prefers-color-scheme → light), inlined in <head> so it sets data-theme BEFORE first paint and
// no page flashes the wrong theme. It is the single resolver of the active token set on a
// server-rendered page. [LAW:no-ambient-temporal-coupling] [LAW:one-source-of-truth]
const THEME_RESOLVER = `<script>(function(){var t=localStorage.getItem('tp-theme');if(!t)t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t)})()</script>`;

// The theme-toggle wiring — flips and persists the choice, and keeps mirroring the system
// preference for users who never chose. The toggle button lives in siteNav, so a page without a
// nav (the player) simply has no button to bind; the lookup returning null is genuine optionality
// at the DOM boundary, not a swallowed error. [LAW:no-defensive-null-guards]
const THEME_TOGGLE_SCRIPT = `
  const root = document.documentElement;
  const PREF = 'tp-theme';
  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      localStorage.setItem(PREF, next);
    });
  }
  window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem(PREF)) root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
  });
`;

// The sticky site nav — logo home, the two read/build entry points, the theme toggle, and a real
// "Get started" anchor to the front door. Every destination is a plain href that works without JS
// (the read path is auth-free), so nothing here is a dead, live-looking control. [LAW:no-silent-failure]
export const siteNav = (): string => `<nav class="nav">
  <a class="nav-logo" href="/">
    <div class="nav-logo-icon">TP</div>
    <span class="nav-logo-text">TinkerPad</span>
  </a>
  <ul class="nav-links">
    <li><a href="/commons">Discover</a></li>
    <li><a href="/">Build</a></li>
  </ul>
  <div class="nav-actions">
    <button class="theme-toggle" id="themeToggle" aria-label="Toggle dark mode">
      <span class="icon-moon">🌙</span>
      <span class="icon-sun">☀️</span>
    </button>
    <a class="btn-primary" href="/">Get started</a>
  </div>
</nav>`;

// The site footer — brand home, the same destinations the nav offers, and the public-by-default
// note. Static chrome, the counterpart to siteNav; the two travel together on content pages.
export const siteFooter = (): string => `<footer class="site-footer">
  <div class="footer-inner">
    <div class="footer-top">
      <a class="footer-brand" href="/">
        <div class="footer-brand-icon"></div>
        <span class="footer-brand-text">TinkerPad</span>
      </a>
      <ul class="footer-links">
        <li><a href="/commons">Commons</a></li>
        <li><a href="/">Build</a></li>
      </ul>
    </div>
    <div class="footer-bottom">© 2026 TinkerPad. All playgrounds are public by default.</div>
  </div>
</footer>`;

// The page shell — doctype, head (title, tokens, theme resolver), and body. Callers compose the
// body from siteNav + their content + siteFooter (the player omits the chrome and passes its own
// full-height layout). `head` is the one per-page slot for page-specific CSS/meta.
//
// TRUST CONTRACT: `title` is the ONE raw value the shell receives, so the shell escapes it through
// the single enforcer. `body` and `head` are TRUSTED app-origin markup — every outside value they
// contain has ALREADY crossed escapeHtml at the point it was interpolated by the caller — so the
// shell injects them verbatim. That asymmetry is the invariant, not an oversight: the escape lives
// once, at the boundary where the outside value enters, never a second time here. This contract is
// carried in prose rather than a branded `SafeHtml` type on purpose — escapeHtml returns `string`
// and every fragment builder in this layer returns `string`, so a brand at this one seam would be
// laundered by casts (false safety); a real brand would have to span the whole layer as an
// html-tagged-template enforcer, which would duplicate the single escape mechanism. That is a
// deliberate, separate decision. [LAW:types-are-the-program] [LAW:single-enforcer] [LAW:one-source-of-truth]
export const renderPageShell = (title: string, body: string, head = ''): string =>
  `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
${THEME_RESOLVER}
<style>${SHELL_STYLES}</style>
${head}
</head>
<body>
${body}
<script type="module">${THEME_TOGGLE_SCRIPT}</script>
</body>
</html>
`;
