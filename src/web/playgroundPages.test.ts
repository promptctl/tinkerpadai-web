import { describe, expect, it } from 'vitest';
import { PlaygroundId } from '../storage/index.js';
import { renderCommons, renderNotice, renderPlayer } from './playgroundPages.js';

// The pure renderers' contract: trusted app-origin chrome with EVERY outside value escaped,
// while the playground's own html stays elsewhere (the content origin). The hostile-prompt
// cases are the security assertions. [LAW:behavior-not-structure] [LAW:single-enforcer]

const XSS = '<script>alert(1)</script>';

describe('renderCommons', () => {
  it('escapes a hostile prompt into inert text', () => {
    const html = renderCommons([
      { id: PlaygroundId('abc'), prompt: XSS, providerId: 'p' as never, currentVersion: 'v' as never },
    ]);
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders an empty list as an empty state, not a crash', () => {
    expect(renderCommons([]).toLowerCase()).toContain('no playgrounds yet');
  });
});

describe('renderPlayer', () => {
  const view = {
    id: PlaygroundId('abc'),
    prompt: XSS,
    contentSrc: 'http://c.local/?id=abc',
    providerId: 'p' as never,
  };

  it('escapes the prompt in its chrome but keeps the content src intact', () => {
    const html = renderPlayer(view);
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('src="http://c.local/?id=abc"');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin');
  });

  // The action region wires both follow-ups to the SAME generation API (continue/fork + the
  // existing poll loop), and starts hidden so the page is provider-agnostic — the client
  // reveals it only after /providers proves generation is on. [LAW:no-mode-explosion]
  it('renders the action region hidden, wired to the continue + poll endpoints', () => {
    const html = renderPlayer(view);
    expect(html).toContain('id="actions" hidden');
    expect(html).toContain('/generations/continue');
    expect(html).toContain('/poll');
    expect(html).toContain('/providers');
    expect(html).toContain('/availability');
  });

  // The remix control wires the fork action to the SAME poll loop and starts hidden behind its
  // own capability gate (the client reveals it only when the provider can fork), so a
  // non-forkable playground never shows a dead button. [LAW:no-mode-explosion]
  it('renders the remix control hidden, wired to the fork endpoint', () => {
    const html = renderPlayer(view);
    expect(html).toContain('id="remix-bar" hidden');
    expect(html).toContain('id="remix-submit"');
    expect(html).toContain('/generations/fork');
  });

  // The playground id and its provider cross into the page as DATA (escaped attributes), so a
  // hostile id can never break the attribute or become script. [LAW:single-enforcer]
  it('carries a hostile id and provider as inert escaped data, never as markup', () => {
    const html = renderPlayer({ ...view, id: PlaygroundId(XSS), providerId: '"><img src=x>' as never });
    expect(html).not.toContain(XSS);
    expect(html).not.toContain('"><img src=x>');
    expect(html).toContain('data-playground-id="&lt;script&gt;');
    expect(html).toContain('data-provider-id="&quot;&gt;&lt;img');
  });
});

describe('renderNotice', () => {
  it('escapes both heading and message and offers a way back', () => {
    const html = renderNotice(XSS, XSS);
    expect(html).not.toContain(XSS);
    expect(html).toContain('href="/commons"');
  });
});
