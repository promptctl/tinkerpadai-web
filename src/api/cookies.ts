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
// `Secure` and a `__Host-` name prefix are the production hardening (they require HTTPS, which
// local dev over http://127.0.0.1 cannot offer) and land with deployment. [LAW:single-enforcer]
export interface CookieAttributes {
  readonly httpOnly: boolean;
  readonly sameSite: 'Strict' | 'Lax' | 'None';
  readonly path: string;
}

// Serialize a Set-Cookie header value. SameSite + Path + HttpOnly are always present; Domain is
// never emitted (host-scoping, see above). SameSite=Strict is the CSRF defense — the browser
// withholds this cookie from cross-site requests, so a forged write from another origin arrives
// without it and is gated. No separate CSRF token is needed. [LAW:single-enforcer]
export const serializeCookie = (name: string, value: string, attrs: CookieAttributes): string => {
  const parts = [`${name}=${value}`, `Path=${attrs.path}`, `SameSite=${attrs.sameSite}`];
  if (attrs.httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
};
