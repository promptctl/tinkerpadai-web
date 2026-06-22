import { afterEach, describe, expect, it } from 'vitest';
import { makeMemoryArtifactStore, makeMemoryCatalog } from '../storage/index.js';
import type { ArtifactStore, Catalog, PlaygroundId } from '../storage/index.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import { makeSiteHandler } from './siteHandler.js';
import { makeContentHandler } from './contentHandler.js';
import { serve } from './server.js';
import type { RunningServer } from './server.js';

// THE STEEL THREAD'S "USE" END, proven over real sockets: two separate origins, a seeded
// playground browsed from the commons, opened in the player, and its raw html actually
// fetched from the FOREIGN content origin under the sandbox CSP — with the provider never
// touched. This is the ticket's end-to-end acceptance criterion. [LAW:verifiable-goals]

const RAW_HTML = '<!doctype html><html><body><h1>hello</h1><script>void 0</script></body></html>';
const PAGE = '<!doctype html><title>front door</title>';

const seed = async (catalog: Catalog, store: ArtifactStore): Promise<PlaygroundId> => {
  const version = await store.put({ html: RAW_HTML });
  const playground = await catalog.createPlayground({
    handle: { providerId: ProviderId('p'), sessionId: SessionId('s'), turnId: TurnId('t') },
    prompt: 'a tiny counter',
    version,
    lineage: null,
  });
  return playground.id;
};

const servers: RunningServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('commons + sandboxed player over two real origins', () => {
  it('browses, opens the player, and serves the raw playground from the separate content origin', async () => {
    const catalog = makeMemoryCatalog();
    const store = makeMemoryArtifactStore();
    const id = await seed(catalog, store);

    const content = await serve({ handler: makeContentHandler({ catalog, store }), port: 0 });
    servers.push(content);

    const apiHandler = async (): Promise<Response> => new Response('nope', { status: 404 });
    const site = await serve({
      handler: makeSiteHandler({ page: PAGE, catalog, contentOrigin: content.url, apiHandler }),
      port: 0,
    });
    servers.push(site);

    // The two origins are genuinely different — that separation IS the sandbox.
    expect(site.url).not.toBe(content.url);

    // Commons lists the playground and links to its player.
    const commons = await (await fetch(`${site.url}/commons`)).text();
    expect(commons).toContain('a tiny counter');
    expect(commons).toContain(`/play?id=${encodeURIComponent(id)}`);

    // The player frames the foreign content origin in an allow-scripts (NOT same-origin) sandbox.
    const player = await (await fetch(`${site.url}/play?id=${encodeURIComponent(id)}`)).text();
    expect(player).toContain('sandbox="allow-scripts"');
    expect(player).not.toContain('allow-same-origin');
    const expectedSrc = `${content.url}/?id=${encodeURIComponent(id)}`;
    expect(player).toContain(`src="${expectedSrc}"`);

    // Following that src to the content origin yields the raw html under the strict CSP.
    const framed = await fetch(expectedSrc);
    expect(framed.status).toBe(200);
    expect(framed.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(await framed.text()).toBe(RAW_HTML);
  });
});
