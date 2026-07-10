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

// Parse an origin to its hostname, failing with a NAMED error when the value is not a valid absolute
// URL. This guard is the first place the edge parses these config values, so a malformed one must
// surface as a clear config error naming the culprit, not a bare "Invalid URL". [LAW:no-silent-failure]
const hostnameOf = (role: string, origin: string): string => {
  try {
    return new URL(origin).hostname;
  } catch {
    throw new Error(`${role} must be a valid absolute URL (e.g. https://host.example), but got "${origin}".`);
  }
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
