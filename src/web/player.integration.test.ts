import { afterEach, describe, expect, it } from 'vitest';
import { makeMemoryArtifactStore, makeMemoryCatalog } from '../storage/index.js';
import type { ArtifactStore, Catalog, PlaygroundId } from '../storage/index.js';
import { Subject } from '../identity/index.js';
import { ProviderId, ProviderRegistry, SessionId, TurnId } from '../provider/index.js';
import { makeFakeProvider } from '../provider/__fixtures__/fakeProvider.js';
import { makeGenerationService } from '../api/generationService.js';
import { makeReportService } from '../api/reportService.js';
import { makeReviewService } from '../api/reviewService.js';
import { makeHttpHandler } from '../api/httpHandler.js';
import { localIdentityResolver } from '../api/identity.js';
import { makeMemoryReportStore } from '../storage/index.js';
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
    author: Subject('ada'),
    tags: [],
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
      handler: makeSiteHandler({
        page: PAGE,
        catalog,
        contentOrigin: content.url,
        sessionHandler: async () => null,
        apiHandler,
        reviewService: makeReviewService({ reports: makeMemoryReportStore(), catalog }),
        isAdminRequest: async () => false,
      }),
      port: 0,
    });
    servers.push(site);

    // The two origins are genuinely different — that separation IS the sandbox.
    expect(site.url).not.toBe(content.url);

    // Commons lists the playground and links to its player.
    const commons = await (await fetch(`${site.url}/commons`)).text();
    expect(commons).toContain('a tiny counter');
    expect(commons).toContain(`/play?id=${encodeURIComponent(id)}`);
    // Authorship is projected over the real catalog onto the commons chrome, end to end.
    expect(commons).toContain('by ada');

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

// THE REMIX ACTION, proven over the real composed front door. The player's remix button does
// exactly one HTTP dance: POST /generations/fork with this playground's id, then drive the
// EXISTING /poll loop to ready, then navigate to /play?id=<the new fork's id>. With no DOM
// runner the script itself is not executed, so this exercises that SAME wiring through the
// composed site handler (real apiHandler) over real sockets — the integration acceptance the
// ticket names: the remix action issues the fork POST and follows the handle to a NEW,
// independent, navigable playground. [LAW:verifiable-goals]
describe('remix action over the composed front door', () => {
  it('forks a playground via /generations/fork and lands the new id at its own player', async () => {
    const catalog = makeMemoryCatalog();
    const store = makeMemoryArtifactStore();

    // A forkable provider (iterable exposes fork), wired through the real service + HTTP
    // handler, composed behind the site handler exactly as production does.
    const registry = new ProviderRegistry();
    registry.register(makeFakeProvider({ id: 'fake', label: 'Fake', outcome: 'success', iterable: true }));
    const service = makeGenerationService({ registry, store, catalog, disposeTurn: async () => undefined });
    // ONE report store behind both intake and review, mirroring production — the review queue reads
    // exactly what the report button writes. [LAW:one-source-of-truth]
    const reportStore = makeMemoryReportStore();
    const reports = makeReportService({ catalog, reports: reportStore });
    const site = await serve({
      handler: makeSiteHandler({
        page: PAGE,
        catalog,
        contentOrigin: 'http://content.local',
        sessionHandler: async () => null,
        apiHandler: makeHttpHandler(service, reports, localIdentityResolver),
        reviewService: makeReviewService({ reports: reportStore, catalog }),
        isAdminRequest: async () => false,
      }),
      port: 0,
    });
    servers.push(site);

    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${site.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const pollToReady = async (handle: unknown): Promise<string> => {
      const status = (await (await post('/poll', { handle })).json()) as { state: string; playgroundId?: string };
      expect(status.state).toBe('ready');
      return status.playgroundId as string;
    };

    // Mint a parent playground through the real service so it is genuinely catalogued and
    // forkable — the same starting point a user browses to.
    const submit = (await post('/generations', { providerId: 'fake', brief: { description: 'a tiny counter' } }));
    const { handle: submitHandle } = (await submit.json()) as { handle: unknown };
    const parentId = await pollToReady(submitHandle);

    // The remix button's call: fork by id, no brief.
    const forkRes = await post('/generations/fork', { playgroundId: parentId });
    expect(forkRes.status).toBe(201);
    const { handle: forkHandle } = (await forkRes.json()) as { handle: unknown };

    // Following the handle to ready yields the FORK's own id — an independent playground.
    const forkId = await pollToReady(forkHandle);
    expect(forkId).not.toBe(parentId);

    // The navigation target the button follows resolves to the fork's own player chrome.
    const player = await (await fetch(`${site.url}/play?id=${encodeURIComponent(forkId)}`)).text();
    expect(player).toContain(`src="http://content.local/?id=${encodeURIComponent(forkId)}"`);
    expect(player).toContain('Remix this playground');
    // Authorship threaded the WHOLE write path over real sockets: the enforcer resolved the
    // identity (localIdentityResolver -> "local"), fork recorded it as the new playground's
    // author, and the player projects it as a byline. [LAW:verifiable-goals]
    expect(player).toContain('by local');
  });
});
