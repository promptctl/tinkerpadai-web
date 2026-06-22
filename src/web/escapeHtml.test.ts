import { describe, expect, it } from 'vitest';
import { escapeHtml } from './escapeHtml.js';

// The escaper's contract: the five html-significant characters become entities so a value
// can never break out of text or an attribute into markup. [LAW:single-enforcer]

describe('escapeHtml', () => {
  it('neutralizes every html-significant character', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('defuses a script-injection payload into inert text', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('a tiny counter with + and - buttons')).toBe('a tiny counter with + and - buttons');
  });
});
