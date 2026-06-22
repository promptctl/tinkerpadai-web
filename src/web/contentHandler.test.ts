import { describe, expect, it } from 'vitest';
import { makeMemoryArtifactStore, makeMemoryCatalog } from '../storage/index.js';
import type { ArtifactStore, Catalog, PlaygroundId } from '../storage/index.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import { makeContentHandler } from './contentHandler.js';

// The content origin's contract: serve a playground's html RAW (it is live code) under a
// strict, network-denying CSP, and fail loudly on anything it cannot serve. This is the one
// sandbox enforcement boundary, so these assertions are the ticket's security acceptance
// criteria, not incidental detail. [LAW:verifiable-goals] [LAW:single-enforcer]

const RAW_HTML = '<!doctype html><html><body><script>document.title="live"</script></body></html>';

const seed = async (
  catalog: Catalog,
  store: ArtifactStore,
  html: string,
): Promise<PlaygroundId> => {
  const version = await store.put({ html });
  const playground = await catalog.createPlayground({
    handle: { providerId: ProviderId('p'), sessionId: SessionId('s'), turnId: TurnId('t') },
    prompt: 'a thing',
    version,
    lineage: null,
  });
  return playground.id;
};

const setup = (): { handler: (request: Request) => Promise<Response>; catalog: Catalog; store: ArtifactStore } => {
  const catalog = makeMemoryCatalog();
  const store = makeMemoryArtifactStore();
  return { handler: makeContentHandler({ catalog, store }), catalog, store };
};

describe('makeContentHandler — the sandbox content origin', () => {
  it('serves the stored html byte-for-byte, unescaped, as live code', async () => {
    const { handler, catalog, store } = setup();
    const id = await seed(catalog, store, RAW_HTML);
    const res = await handler(new Request(`http://content.local/?id=${encodeURIComponent(id)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(RAW_HTML);
  });

  it('carries the deny-all, no-network CSP on the served playground', async () => {
    const { handler, catalog, store } = setup();
    const id = await seed(catalog, store, RAW_HTML);
    const res = await handler(new Request(`http://content.local/?id=${encodeURIComponent(id)}`));
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    // No phoning home / exfiltration — the real containment.
    expect(csp).toContain("connect-src 'none'");
    // ...but the self-contained playground's OWN inline code is allowed to run.
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    // It may never load an external script/style/host of any kind.
    expect(csp).not.toContain("'self'");
    expect(csp).not.toContain('http');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('fails loudly with 404 for an unknown id rather than a blank frame', async () => {
    const { handler } = setup();
    const res = await handler(new Request('http://content.local/?id=does-not-exist'));
    expect(res.status).toBe(404);
    // Even error responses stay sealed under the strict CSP.
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('rejects a request with no id as a 400', async () => {
    const { handler } = setup();
    const res = await handler(new Request('http://content.local/'));
    expect(res.status).toBe(400);
  });

  it('serves nothing but the playground route', async () => {
    const { handler } = setup();
    expect((await handler(new Request('http://content.local/anything'))).status).toBe(404);
    expect((await handler(new Request('http://content.local/?id=x', { method: 'POST' }))).status).toBe(404);
  });
});
