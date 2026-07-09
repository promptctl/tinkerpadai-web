// THE COOKIE CODEC — pure string functions for the one place HTTP carries the session token:
// reading a named value out of a request's Cookie header, and serializing a Set-Cookie line
// with the security attributes that make the credential safe. No state, no IO — just the two
// representations (a Cookie header string ↔ a name/value with attributes) and the transform
// between them, so it composes into the resolver (read) and the login route (write) alike and
// is testable in isolation. [LAW:effects-at-boundaries] [LAW:decomposition]

// Read the value of a single named cookie out of a Cookie header, or null when it is absent.
// The header is `name=value; name2=value2`; only the FIRST `=` separates a pair, so a value
// may itself contain `=`. Absence is a value (null) the caller matches, never an exception.
// [LAW:dataflow-not-control-flow]
export const readCookie = (header: string | null, name: string): string | null => {
  if (header === null) return null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
};

// The security attributes of a Set-Cookie. There is no `Domain` field on purpose: omitting it
// makes the cookie HOST-SCOPED — bound to the exact host that set it (the app origin), so it is
// unreachable from a different-host content origin by construction, not by a runtime guard.
// `secure` is REQUIRED, not defaulted: every caller states its transport posture explicitly, so
// there is no silent "forgot to mark it Secure". It is a VALUE the composition root supplies (true
// on the HTTPS edge, false on http loopback dev), never an ambient read of the environment — the
// `__Host-` name prefix that pairs with it is chosen the same way. [LAW:types-are-the-program]
// [LAW:dataflow-not-control-flow]
export interface CookieAttributes {
  readonly httpOnly: boolean;
  readonly sameSite: 'Strict' | 'Lax' | 'None';
  readonly path: string;
  // Emit the `Secure` attribute — the browser then withholds the cookie from any non-HTTPS
  // request. Required for a `__Host-`-prefixed name and for any credential behind TLS; false only
  // where the transport genuinely cannot offer HTTPS (http://127.0.0.1 dev). [LAW:single-enforcer]
  readonly secure: boolean;
  // The cookie's max age in seconds, or absent for a SESSION cookie that the browser drops when it
  // closes. Genuine optionality — its absence is the session-cookie semantics the login relies on,
  // and Max-Age=0 is how logout tells the browser to drop the cookie immediately. The store owns
  // server-side lifetime; this attribute is only the browser's hint, never the source of truth.
  readonly maxAge?: number;
}

// Serialize a Set-Cookie header value. SameSite + Path + HttpOnly are always present; Max-Age is
// emitted only when given (a session cookie omits it); Secure is emitted when the transport is
// HTTPS; Domain is never emitted (host-scoping, see above). SameSite=Strict is the CSRF defense —
// the browser withholds this cookie from cross-site requests, so a forged write from another origin
// arrives without it and is gated. No separate CSRF token is needed. [LAW:single-enforcer]
export const serializeCookie = (name: string, value: string, attrs: CookieAttributes): string => {
  const parts = [`${name}=${value}`, `Path=${attrs.path}`];
  if (attrs.maxAge !== undefined) parts.push(`Max-Age=${attrs.maxAge}`);
  parts.push(`SameSite=${attrs.sameSite}`);
  if (attrs.httpOnly) parts.push('HttpOnly');
  if (attrs.secure) parts.push('Secure');
  return parts.join('; ');
};
