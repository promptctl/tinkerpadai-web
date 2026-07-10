import { describe, expect, it } from 'vitest';
import { renderPageShell, siteFooter, siteNav } from './pageShell.js';

// The shared shell's contract: it wraps trusted app-origin chrome, escapes the two outside values
// it carries (title and description) through the single enforcer, and ships the design system every
// dynamic page depends on — the token-driven theme with a pre-paint resolver so no page flashes the
// wrong mode. [LAW:behavior-not-structure] [LAW:single-enforcer]

const XSS = '<script>alert(1)</script>';

describe('renderPageShell', () => {
  it('escapes a hostile title into inert text', () => {
    const html = renderPageShell(XSS, 'a safe description', '<p>body</p>');
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;script&gt;');
  });

  // The description is the second outside value the shell carries into the head, so it crosses the
  // same single enforcer — a hostile description can never break out of the meta tag. [LAW:single-enforcer]
  it('escapes a hostile description into inert text', () => {
    const html = renderPageShell('a safe title', XSS, '<p>body</p>');
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;script&gt;');
  });

  // Every page is a first impression in a search result or a shared link, so the shell always emits
  // a meta description and the brand favicon. [LAW:types-are-the-program]
  it('emits the meta description and the brand favicon in the head', () => {
    const html = renderPageShell('Title', 'the page summary', '');
    expect(html).toContain('<meta name="description" content="the page summary" />');
    expect(html).toContain('rel="icon"');
    expect(html).toContain('data:image/svg+xml');
  });

  it('places the body inside the document', () => {
    expect(renderPageShell('Title', 'desc', '<main>hello</main>')).toContain('<main>hello</main>');
  });

  // Dark mode is resolved before first paint (localStorage → prefers-color-scheme), so the page
  // never flashes light then swap. The resolver sets data-theme on <html>; the tokens key off it.
  it('resolves the theme pre-paint and drives it off data-theme', () => {
    const html = renderPageShell('Title', 'desc', '');
    expect(html).toContain("localStorage.getItem('tp-theme')");
    expect(html).toContain('prefers-color-scheme');
    expect(html).toContain('data-theme');
    expect(html).toContain('[data-theme="dark"]');
  });

  // The private dark-only palette the renderers used to carry is gone — one token source now, the
  // approved indigo system shared with index.html. [LAW:one-source-of-truth]
  it('no longer carries the old divergent palette', () => {
    const html = renderPageShell('Title', 'desc', '');
    expect(html).not.toContain('#0b0c10');
    expect(html).not.toContain('#7c9cff');
    expect(html).toContain('--accent:           #6366f1');
  });

  // The head slot is where a page adds its own CSS/meta (the player's full-height layout uses it).
  it('emits page-specific head content in the head slot', () => {
    expect(renderPageShell('Title', 'desc', '', '<style>body{color:red}</style>')).toContain(
      '<style>body{color:red}</style>',
    );
  });
});

describe('siteNav / siteFooter', () => {
  // The chrome is real navigation, not decoration: both the build path and the commons are
  // reachable, and the toggle to change theme exists. Every href works without JS. [LAW:no-silent-failure]
  it('offers navigation to build and to the commons, plus a theme toggle', () => {
    const nav = siteNav();
    expect(nav).toContain('href="/commons"');
    expect(nav).toContain('href="/"');
    expect(nav).toContain('id="themeToggle"');
  });

  it('links back to the commons and the build page from the footer', () => {
    const footer = siteFooter();
    expect(footer).toContain('href="/commons"');
    expect(footer).toContain('href="/"');
  });

  it('links the ground rules, privacy, and copyright pages from the footer of every server page', () => {
    // The legal surface must be reachable from anywhere, not just typed as a URL. [LAW:no-silent-failure]
    const footer = siteFooter();
    expect(footer).toContain('href="/terms"');
    expect(footer).toContain('href="/privacy"');
    expect(footer).toContain('href="/copyright"');
  });
});
