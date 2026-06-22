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
  it('escapes the prompt in its chrome but keeps the content src intact', () => {
    const html = renderPlayer({ id: PlaygroundId('abc'), prompt: XSS, contentSrc: 'http://c.local/?id=abc' });
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('src="http://c.local/?id=abc"');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin');
  });
});

describe('renderNotice', () => {
  it('escapes both heading and message and offers a way back', () => {
    const html = renderNotice(XSS, XSS);
    expect(html).not.toContain(XSS);
    expect(html).toContain('href="/commons"');
  });
});
