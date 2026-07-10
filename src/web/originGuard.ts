// THE TWO-ORIGIN DISTINCTNESS INVARIANT — one definition of the config-safety rule the whole
// sandbox rests on: the app origin and the playground-content origin MUST be different hostnames. The
// two-origin split tells the two apart by host; if they share one, the split collapses — every
// request routes to the content side, and, worse, raw untrusted playground HTML would be served
// where it can reach the app's cookies, storage, and a viewer's session. This is the security
// boundary, not a deployment nicety, so a same-hostname config must be unrepresentable at composition
// time, never a silent runtime collapse. [LAW:single-enforcer] [LAW:no-silent-failure]
//
// A pure check over two origin URLs, framework-agnostic (URL exists on Node and at the edge alike),
// so the ONE composition root that reads two INDEPENDENT origin values — the Cloudflare Worker, whose
// content origin and app (callback) origin are separate env entries that can be misconfigured to
// collide — calls it before it assembles the front door. The Node entry does NOT: it derives the
// content origin from the socket it binds, on a host basis distinct from the app's, so distinctness
// there is a distinct-PORT invariant enforced where the ports are resolved, not a hostname comparison
// this function could meaningfully make. [LAW:decomposition]

// Parse an origin to its hostname, failing with a NAMED error for anything that is not a real web
// origin. This guard is the first place the edge parses these config values, so a bad one must surface
// as a clear config error naming the culprit — not a bare "Invalid URL", and never a SILENT pass. The
// strongest true shape for a two-origin web deployment is an http(s) URL with a non-empty hostname:
// schemes like data:/javascript:/file: parse without throwing but yield an empty hostname, which would
// otherwise slip past the distinctness check (an empty host differs from any real one). Reject them.
// [LAW:no-silent-failure] [LAW:types-are-the-program]
const hostnameOf = (role: string, origin: string): string => {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`${role} must be a valid absolute URL (e.g. https://host.example), but got "${origin}".`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') {
    throw new Error(`${role} must be an http(s) URL with a hostname (e.g. https://host.example), but got "${origin}".`);
  }
  return url.hostname;
};

export const assertDistinctOriginHosts = (appOrigin: string, contentOrigin: string): void => {
  // hostname, not host: browser cookies — the __Host- session cookie especially — are scoped to the
  // hostname and IGNORE the port, so two origins on the same hostname differing only by port still
  // share the app's cookies and a viewer's session. Requiring different hostnames is the granularity
  // that makes the isolation real, and it strictly implies a different host:port, so the router's host
  // split cannot collapse either. [LAW:types-are-the-program]
  const appHost = hostnameOf('The app origin', appOrigin);
  const contentHost = hostnameOf('The playground content origin', contentOrigin);
  if (appHost === contentHost) {
    throw new Error(
      `The playground content origin and the app origin must be different hostnames, but both resolve to "${contentHost}". ` +
        'The two-origin sandbox depends on this split: if they share a hostname, untrusted playground HTML is served ' +
        "where it can reach the app's cookies, storage, and a viewer's session (cookies ignore the port). " +
        'Set TINKERPAD_CONTENT_ORIGIN to a hostname distinct from the app origin.',
    );
  }
};
