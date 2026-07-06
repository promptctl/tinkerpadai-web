import { describe, expect, it } from 'vitest';
import { PlaygroundId } from '../storage/index.js';
import { playgroundCard, renderCommons, renderNotice, renderPlayer } from './playgroundPages.js';

// The pure renderers' contract: trusted app-origin chrome with EVERY outside value escaped,
// while the playground's own html stays elsewhere (the content origin). The hostile-prompt
// cases are the security assertions. [LAW:behavior-not-structure] [LAW:single-enforcer]

const XSS = '<script>alert(1)</script>';

const summary = (over: Partial<Parameters<typeof renderCommons>[0][number]> = {}) => ({
  id: PlaygroundId('abc'),
  prompt: 'a tiny counter',
  providerId: 'p' as never,
  currentVersion: 'v' as never,
  forkedFrom: null,
  author: 'ada' as never,
  recipe: ['a tiny counter'] as const,
  ...over,
});

describe('renderCommons', () => {
  it('escapes a hostile prompt into inert text', () => {
    const html = renderCommons([summary({ prompt: XSS })]);
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders an empty list as an empty state, not a crash', () => {
    expect(renderCommons([]).toLowerCase()).toContain('no playgrounds yet');
  });

  // Attribution is data flow: a fork shows "forked from <parent>" linking back, a non-fork
  // shows nothing — not a special case, just the empty value rendered as the empty fragment.
  it('attributes a fork to its browsable parent and links back', () => {
    const html = renderCommons([
      summary({ id: PlaygroundId('child'), prompt: 'a remixed counter', forkedFrom: { parent: { id: PlaygroundId('parent'), prompt: 'the original counter' } } }),
    ]);
    expect(html).toContain('Forked from');
    expect(html).toContain('the original counter');
    expect(html).toContain(`/play?id=${encodeURIComponent('parent')}`);
  });

  it('shows no attribution for a playground that is not a fork', () => {
    expect(renderCommons([summary()])).not.toContain('Forked from');
  });

  // Authorship is the other half of provenance — every row credits its author as a byline.
  it('credits the author as a "by <author>" byline', () => {
    expect(renderCommons([summary({ author: 'grace' as never })])).toContain('by grace');
  });

  it('escapes a hostile author in the byline rather than emitting it as markup', () => {
    const html = renderCommons([summary({ author: XSS as never })]);
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;script&gt;');
  });

  // A fork whose parent has left the commons keeps the durable fork fact, but offers no link
  // to a parent that is no longer browsable. [LAW:no-silent-failure]
  it('states the fork fact without a link when the parent is gone', () => {
    const html = renderCommons([summary({ forkedFrom: { parent: null } })]);
    expect(html).toContain('Forked from a playground no longer in the commons');
  });

  it('escapes a hostile parent prompt in the attribution', () => {
    const html = renderCommons([summary({ forkedFrom: { parent: { id: PlaygroundId('parent'), prompt: XSS } } })]);
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;script&gt;');
  });

  // The recipe surfaces as a step count on the row — iteration depth made visible (history
  // layer A), pluralized as a value so a one-shot reads "1 step" and an iterated one "3 steps".
  it('shows the iteration step count, pluralized, on the row', () => {
    expect(renderCommons([summary({ recipe: ['describe'] })])).toContain('1 step');
    expect(renderCommons([summary({ recipe: ['describe', 'refine', 'again'] })])).toContain('3 steps');
  });

  // The commons is now the design-system page: the site chrome wraps it so a viewer can navigate
  // away (build, discover), and the theme system rides along so the page honors dark mode.
  it('wraps the list in the shared site chrome with a way to build and browse', () => {
    const html = renderCommons([summary()]);
    expect(html).toContain('nav-logo');
    expect(html).toContain('site-footer');
    expect(html).toContain('id="themeToggle"');
  });

  it('links each playground to its player from the card', () => {
    expect(renderCommons([summary({ id: PlaygroundId('xyz') })])).toContain(
      `/play?id=${encodeURIComponent('xyz')}`,
    );
  });
});

// The card is exported because the profile "my playgrounds" page (blocked on this ticket) renders
// the SAME unit, so a playground reads identically wherever it is listed. Its safety contract
// travels with it: every outside value is escaped. [LAW:one-source-of-truth] [LAW:single-enforcer]
describe('playgroundCard', () => {
  it('renders the prompt as a link to its player', () => {
    const html = playgroundCard(summary({ id: PlaygroundId('xyz'), prompt: 'a tiny counter' }));
    expect(html).toContain('a tiny counter');
    expect(html).toContain(`/play?id=${encodeURIComponent('xyz')}`);
  });

  it('escapes a hostile prompt into inert text', () => {
    const html = playgroundCard(summary({ prompt: XSS }));
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;script&gt;');
  });

  // The card's provenance contract, tested directly on the reusable unit (not only via
  // renderCommons) so a future direct consumer keeps the safety net. [LAW:behavior-not-structure]
  it('credits the author as a "by <author>" byline', () => {
    expect(playgroundCard(summary({ author: 'grace' as never }))).toContain('by grace');
  });

  it('shows the provider and the pluralized iteration step count', () => {
    expect(playgroundCard(summary({ providerId: 'claude' as never, recipe: ['describe'] }))).toContain('claude');
    expect(playgroundCard(summary({ recipe: ['describe'] }))).toContain('1 step');
    expect(playgroundCard(summary({ recipe: ['a', 'b', 'c'] }))).toContain('3 steps');
  });

  it('links a fork back to its browsable parent, and states the fork fact when the parent is gone', () => {
    const linked = playgroundCard(
      summary({ forkedFrom: { parent: { id: PlaygroundId('parent'), prompt: 'the original' } } }),
    );
    expect(linked).toContain('Forked from');
    expect(linked).toContain('the original');
    expect(linked).toContain(`/play?id=${encodeURIComponent('parent')}`);
    expect(playgroundCard(summary({ forkedFrom: { parent: null } }))).toContain(
      'Forked from a playground no longer in the commons',
    );
  });

  it('shows no attribution for a card that is not a fork', () => {
    expect(playgroundCard(summary())).not.toContain('Forked from');
  });

  it('escapes a hostile author and a hostile parent prompt rather than emitting markup', () => {
    const badAuthor = playgroundCard(summary({ author: XSS as never }));
    expect(badAuthor).not.toContain(XSS);
    expect(badAuthor).toContain('&lt;script&gt;');
    const badParent = playgroundCard(
      summary({ forkedFrom: { parent: { id: PlaygroundId('parent'), prompt: XSS } } }),
    );
    expect(badParent).not.toContain(XSS);
    expect(badParent).toContain('&lt;script&gt;');
  });
});

describe('renderPlayer', () => {
  const view = {
    id: PlaygroundId('abc'),
    prompt: XSS,
    contentSrc: 'http://c.local/?id=abc',
    providerId: 'p' as never,
    author: 'ada' as never,
    forkedFrom: null,
    recipe: [XSS] as const,
  };

  // A shared player link is a first impression, so its meta description names THIS playground —
  // and the prompt is outside data, so it crosses the single enforcer on the way in.
  it('describes the specific playground in an escaped meta description', () => {
    const html = renderPlayer({ ...view, prompt: 'a tiny counter' });
    expect(html).toContain('<meta name="description"');
    expect(html).toContain('a tiny counter');
    const hostile = renderPlayer(view);
    expect(hostile).not.toContain(XSS);
    expect(hostile).toContain('&lt;script&gt;');
  });

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

  // The player carries the SAME fork attribution the commons does: a forked playground links
  // back to its parent in the chrome, a non-fork shows none — data flow, not a special case.
  it('attributes a forked playground to its parent in the chrome', () => {
    const html = renderPlayer({ ...view, prompt: 'a remix', forkedFrom: { parent: { id: PlaygroundId('parent'), prompt: 'the original' } } });
    expect(html).toContain('Forked from');
    expect(html).toContain('the original');
    expect(html).toContain(`/play?id=${encodeURIComponent('parent')}`);
  });

  it('shows no attribution for a player that is not a fork', () => {
    expect(renderPlayer(view)).not.toContain('Forked from');
  });

  // The player chrome carries the SAME byline the commons row does. [LAW:one-source-of-truth]
  it('credits the author as a "by <author>" byline in the chrome', () => {
    expect(renderPlayer({ ...view, author: 'grace' as never })).toContain('by grace');
  });

  // The recipe (history layer A) surfaces the ordered prompts that built the playground in the
  // chrome — the describe->refine story made visible, every prompt in order with its step count.
  it('surfaces the ordered recipe prompts and their step count in the chrome', () => {
    const html = renderPlayer({
      ...view,
      prompt: 'a color picker',
      recipe: ['a color picker', 'add a hex readout', 'add a copy button'],
    });
    expect(html).toContain('Built in 3 steps');
    const first = html.indexOf('add a hex readout');
    const second = html.indexOf('add a copy button');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
  });

  // Every recipe prompt is outside data crossing the single enforcer, like every other value on
  // this trusted origin — a hostile follow-up prompt renders as inert text, never as markup.
  // [LAW:single-enforcer]
  it('escapes a hostile recipe prompt rather than emitting it as markup', () => {
    const html = renderPlayer({ ...view, prompt: 'safe title', recipe: ['safe title', XSS] });
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;script&gt;');
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

  // The notice's message is also its page summary — it rides into the meta description, escaped.
  it('carries the message as the page meta description', () => {
    const html = renderNotice('Playground not found', 'No playground has that id.');
    expect(html).toContain('<meta name="description" content="No playground has that id." />');
  });
});
