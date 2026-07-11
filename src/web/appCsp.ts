import { createHash } from 'node:crypto';
import { THEME_RESOLVER } from './frontDoorChrome.js';
import { CARD_PREVIEW_FALLBACK_SCRIPT, THEME_TOGGLE_SCRIPT } from './pageShell.js';
import { PLAYER_SCRIPT } from './playgroundPages.js';

// THE APP-ORIGIN CSP, derived — the script-src backstop for gap R1 of the sandbox threat model.
// The trusted origin holds the __Host- session credential, so if a V6 escaping callsite ever
// regressed and injected markup into an app-origin page, an injected inline <script> would run
// with that credential. A hash-based script-src closes that: only scripts whose SHA-256 is in the
// allowlist may run; an injected script has a different body, so a different hash, so it is blocked.
// Defense-in-depth behind V6 escaping (the primary control), not a replacement for it.
//
// Hashes, not a nonce, because every app inline script is STATIC — its bytes are fixed at author
// time. A hash is a pure function of those bytes: no per-response state, no randomness to thread
// from header to markup, and the script body is its own single source of truth (the header and the
// served markup both derive from it). A nonce would inject a per-response effect and couple the
// header to the markup to protect scripts that never change — the wrong tool here.
// [LAW:effects-at-boundaries] [LAW:no-ambient-temporal-coupling] [LAW:one-source-of-truth]

// The framing/injection directives that are independent of the inline scripts (sandbox-bci.3, gap
// R1's cheap wins): only the app frames the app, no injected <base> can re-root relative URLs, forms
// post only back to the app, no plugin surface. script-src is appended to these, derived below.
const APP_CSP_BASE = ["frame-ancestors 'self'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"];

// The exact text a browser hashes for an inline script is the content BETWEEN <script> and </script>
// — tags excluded, whitespace and newlines included. This pulls those bodies out of a trusted markup
// source (a static file or an authored fragment), so the hash is taken over the very bytes that get
// served. It is applied ONLY to trusted, request-independent markup (the front-door file, the shell
// resolver) — never a rendered response carrying user data, which would bless an injected script.
// [FRAMING:representation]
const INLINE_SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const extractScriptBodies = (markup: string): readonly string[] =>
  [...markup.matchAll(INLINE_SCRIPT)].map((match) => match[1] ?? '');

// One inline-script body → its CSP source expression. Standard base64 (not base64url) is what the
// 'sha256-...' grammar expects; the body is hashed as UTF-8, matching how the browser reads it.
const scriptSrcHash = (body: string): string => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

// The app's COMPLETE inline-script inventory, as the exact bodies the browser sees. Every app-origin
// inline script must be reachable from here or the CSP blocks it — loudly, as a console violation and
// a dead feature — which is the point: the allowlist is closed by construction. The front-door page
// carries the pre-paint theme resolver + the front-door module; the shell's resolver repeats that same
// theme body (deduped by hash below); the shell and player each add their one module script.
// [LAW:one-source-of-truth] [LAW:no-silent-failure]
const inlineScriptBodies = (page: string): readonly string[] => [
  ...extractScriptBodies(page),
  ...extractScriptBodies(THEME_RESOLVER),
  THEME_TOGGLE_SCRIPT,
  CARD_PREVIEW_FALLBACK_SCRIPT,
  PLAYER_SCRIPT,
];

// The one app-origin CSP string, built once from the served front-door page. A pure derivation: same
// page in, same policy out. script-src lists only the app's inline-script hashes and no host or
// 'unsafe-inline' source, so an inline script that is not one of these — and every external script —
// is refused. Identical script bodies (the two theme resolvers) collapse to one hash via the Set.
export const buildAppCsp = (page: string): string => {
  const hashes = [...new Set(inlineScriptBodies(page).map(scriptSrcHash))];
  return [...APP_CSP_BASE, `script-src ${hashes.join(' ')}`].join('; ');
};
