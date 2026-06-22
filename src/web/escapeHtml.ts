// THE ONE SERVER-SIDE HTML-TEXT ESCAPER. Any server-originating value (a playground's
// prompt, an id) placed into APP-ORIGIN html goes through here, exactly once, so escaping
// can never drift between callsites. This mirrors the client-side esc() the front door
// established (p0v.5); the rule is identical, the boundary is just the server now.
// [LAW:single-enforcer] [LAW:framing:representation]
//
// This is the OPPOSITE concern from serving a playground's own html: that html is MEANT to
// be live code and is contained by the iframe sandbox + a foreign origin, never escaped.
// Escaping is only for text we inject into our OWN trusted chrome. The ticket's XSS note
// draws exactly this line.

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch);
