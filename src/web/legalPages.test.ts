import { describe, expect, it } from 'vitest';
import { CONTACT_EMAIL, GROUND_RULES_DOC, PRIVACY_DOC, renderLegalDoc } from './legalPages.js';

// The legal pages' contract is their MEANING, not their markup: the ground rules must tell the
// honest "no company, no contract" truth and still carry the disclaimer that protects the operator;
// the privacy policy must disclose what is actually collected. Assertions are over that meaning and
// over the shell being present, never over exact styling. [LAW:behavior-not-structure]

describe('renderLegalDoc', () => {
  it('renders a doc inside the full page shell with nav and footer', () => {
    const html = renderLegalDoc(GROUND_RULES_DOC);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Ground rules — TinkerPad</title>');
    // The chrome travels with it — the footer that links the whole legal surface must be present.
    expect(html).toContain('href="/privacy"');
  });

  it('turns headings into h2s and bullet blocks into lists', () => {
    const html = renderLegalDoc(PRIVACY_DOC);
    expect(html).toContain('<h2>What we collect</h2>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>');
  });
});

describe('GROUND_RULES_DOC — the honest ground rules', () => {
  const html = renderLegalDoc(GROUND_RULES_DOC);

  it('states plainly that there is no contract, rather than fabricating one', () => {
    expect(html).toContain('no company behind it');
    expect(html).toContain("no contract you're agreeing to");
  });

  it('carries the public-by-default and AI-not-owned facts', () => {
    expect(html).toContain('public, automatically');
    expect(html).toContain("isn't owned by anyone");
  });

  it('keeps the operator-protecting disclaimer the user approved', () => {
    expect(html).toContain('provided as-is, with no warranties');
    expect(html).toContain('run them at your own risk');
    expect(html).toContain('remove any playground and block anyone');
  });

  it('offers a real contact channel for reports and requests', () => {
    expect(html).toContain(`mailto:${CONTACT_EMAIL}`);
  });
});

describe('PRIVACY_DOC — grounded in what the code collects', () => {
  const html = renderLegalDoc(PRIVACY_DOC);

  it('discloses the GitHub identity, the session cookie, and request logs it actually collects', () => {
    expect(html).toContain('GitHub username');
    expect(html).toContain('session cookie');
    expect(html).toContain('IP address');
  });

  it('discloses the browser-local theme preference and denies third-party tracking', () => {
    expect(html).toContain('local storage');
    expect(html).toContain('No third-party analytics');
  });

  it('routes data and takedown requests to the one contact address', () => {
    expect(html).toContain(`mailto:${CONTACT_EMAIL}`);
  });
});
