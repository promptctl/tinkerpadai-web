import { describe, expect, it } from 'vitest';
import { currentVersionOf, makeMemoryArtifactStore, makeMemoryCatalog, makeMemoryThumbnailStore, VersionId } from '../storage/index.js';
import type { ArtifactStore, Catalog, PlaygroundId, ThumbnailStore } from '../storage/index.js';
import { Subject } from '../identity/index.js';
import { ProviderId, SessionId, TurnId } from '../provider/index.js';
import { makeContentHandler } from './contentHandler.js';
import { AppOrigin } from './originGuard.js';

// The content origin's contract: serve a playground's html RAW (it is live code) under a
// strict, network-denying CSP, and fail loudly on anything it cannot serve. This is the one
// sandbox enforcement boundary, so these assertions are the ticket's security acceptance
// criteria, not incidental detail. [LAW:verifiable-goals] [LAW:single-enforcer]

const RAW_HTML = '<!doctype html><html><body><script>document.title="live"</script></body></html>';

// The app origin scoped into the content CSP's frame-ancestors — the ONE origin allowed to frame a
// playground. Minted through the validating AppOrigin brand, a distinct host from the content origin.
const APP_ORIGIN = AppOrigin('https://app.tinkerpad.test');

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
    author: Subject('ada'),
    tags: [],
  });
  return playground.id;
};

const setup = (): {
  handler: (request: Request) => Promise<Response>;
  catalog: Catalog;
  store: ArtifactStore;
  thumbnails: ThumbnailStore;
} => {
  const catalog = makeMemoryCatalog();
  const store = makeMemoryArtifactStore();
  const thumbnails = makeMemoryThumbnailStore();
  return { handler: makeContentHandler({ catalog, store, thumbnails, appOrigin: APP_ORIGIN }), catalog, store, thumbnails };
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

  it('refuses an unlisted playground with a sealed 410 — the takedown actually stops serving content', async () => {
    const { handler, catalog, store } = setup();
    const id = await seed(catalog, store, RAW_HTML);
    // Take it down.
    await catalog.setListing(id, 'unlisted');
    const res = await handler(new Request(`http://content.local/?id=${encodeURIComponent(id)}`));
    // 410 Gone — it existed and is intentionally no longer available, distinct from a 404.
    expect(res.status).toBe(410);
    // The raw html is NOT served.
    expect(await res.text()).not.toContain('<script>');
    // Still sealed under the strict CSP like every response from this origin.
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    // Relisting serves it again — the refusal is a state check, not a deletion.
    await catalog.setListing(id, 'listed');
    const relisted = await handler(new Request(`http://content.local/?id=${encodeURIComponent(id)}`));
    expect(relisted.status).toBe(200);
    expect(await relisted.text()).toBe(RAW_HTML);
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
    // No RESOURCE-load directive re-permits a host — the app origin appears ONLY in frame-ancestors
    // (a framing-control directive, not a subresource one), so strip it before asserting no host leaks
    // into a fetch/subresource directive. [LAW:behavior-not-structure]
    const withoutFrameAncestors = csp.replace(`frame-ancestors ${APP_ORIGIN}`, '');
    expect(withoutFrameAncestors).not.toContain("'self'");
    expect(withoutFrameAncestors).not.toContain('http');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('scopes frame-ancestors to exactly the app origin — only the app may frame a playground', async () => {
    const { handler, catalog, store } = setup();
    const id = await seed(catalog, store, RAW_HTML);
    const res = await handler(new Request(`http://content.local/?id=${encodeURIComponent(id)}`));
    const csp = res.headers.get('content-security-policy') ?? '';
    // The app's player may frame content; a third party cannot hotlink/embed it as their own.
    expect(csp).toContain(`frame-ancestors ${APP_ORIGIN}`);
    // Not left open (formerly unset) and not a wildcard — the scope is the anti-embedding defense.
    expect(csp).not.toContain('frame-ancestors *');
  });

  it('fails loudly with 404 for an unknown id rather than a blank frame', async () => {
    const { handler } = setup();
    const res = await handler(new Request('http://content.local/?id=does-not-exist'));
    expect(res.status).toBe(404);
    // Even error responses stay sealed under the strict CSP.
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('surfaces a store failure as a loud 500, never relabeled as a 404', async () => {
    // A catalogued playground whose bytes the store cannot produce is the server being
    // broken (corruption / infra), NOT the resource being absent. [LAW:no-silent-failure]
    const catalog = makeMemoryCatalog();
    const playground = await catalog.createPlayground({
      handle: { providerId: ProviderId('p'), sessionId: SessionId('s'), turnId: TurnId('t') },
      prompt: 'a thing',
      version: VersionId('v1'),
      lineage: null,
      author: Subject('ada'),
      tags: [],
    });
    const failingStore: ArtifactStore = {
      put: async () => {
        throw new Error('should not be called');
      },
      get: async () => {
        throw new Error('disk on fire');
      },
    };
    const handler = makeContentHandler({ catalog, store: failingStore, thumbnails: makeMemoryThumbnailStore(), appOrigin: APP_ORIGIN });
    const res = await handler(new Request(`http://content.local/?id=${encodeURIComponent(playground.id)}`));
    expect(res.status).toBe(500);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('treats a catalog read failure as a 500, never a 404', async () => {
    // A non-not-found error from the catalog (disk failure reading catalog.json, an
    // invariant violation) is the server being broken, not a missing resource. Only the
    // typed PlaygroundNotFoundError is a 404. [LAW:no-silent-failure] [LAW:types-are-the-program]
    const brokenCatalog: Catalog = {
      createPlayground: async () => {
        throw new Error('not used');
      },
      appendTurn: async () => {
        throw new Error('not used');
      },
      setListing: async () => {
        throw new Error('not used');
      },
      getPlayground: async () => {
        throw new Error('catalog.json is corrupt');
      },
      listPlaygrounds: async () => [],
    };
    const handler = makeContentHandler({
      catalog: brokenCatalog,
      store: makeMemoryArtifactStore(),
      thumbnails: makeMemoryThumbnailStore(),
      appOrigin: APP_ORIGIN,
    });
    const res = await handler(new Request('http://content.local/?id=anything'));
    expect(res.status).toBe(500);
  });

  it('rejects a request with no id as a 400', async () => {
    const { handler } = setup();
    const res = await handler(new Request('http://content.local/'));
    expect(res.status).toBe(400);
  });

  it('serves nothing but the playground and thumbnail routes', async () => {
    const { handler } = setup();
    expect((await handler(new Request('http://content.local/anything'))).status).toBe(404);
    expect((await handler(new Request('http://content.local/?id=x', { method: 'POST' }))).status).toBe(404);
    expect((await handler(new Request('http://content.local/thumb?id=x', { method: 'POST' }))).status).toBe(404);
  });
});

// The derived-preview route (discovery-rye.3): serve the current version's PNG for the commons card, with
// the SAME visibility model as the html route (a takedown hides the preview too), and an honest "not yet"
// for a version that has not been rendered — never a fabricated image, never a broken frame.
// [LAW:verifiable-goals] [LAW:single-enforcer] [FRAMING:representation]
describe('makeContentHandler — the /thumb preview route', () => {
  // A tiny valid-enough PNG stand-in — the route serves whatever bytes the store holds verbatim; these
  // assertions are about the SEAM (content-type, cache, visibility, absence), not PNG encoding.
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  it('serves a stored thumbnail as an immutably-cacheable image/png', async () => {
    const { handler, catalog, store, thumbnails } = setup();
    const id = await seed(catalog, store, RAW_HTML);
    const version = currentVersionOf((await catalog.getPlayground(id)).session);
    await thumbnails.put(version, PNG);

    const res = await handler(new Request(`http://content.local/thumb?id=${encodeURIComponent(id)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    // Cached hard (long max-age) but NOT immutable: a version's thumbnail can be re-rendered to different
    // bytes, so the URL is not truly content-stable — immutable would pin stale pixels for a year. The `v` in
    // the card's URL refreshes the common case (a new version is a new URL).
    const cache = res.headers.get('cache-control') ?? '';
    expect(cache).toContain('max-age=');
    expect(cache).not.toContain('immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it('returns an honest, revalidating 404 for a version with no thumbnail yet — never a fabricated image', async () => {
    const { handler, catalog, store } = setup();
    const id = await seed(catalog, store, RAW_HTML);
    // No thumbnail stored: pending or failed render. The card turns this into a neutral slot.
    const res = await handler(new Request(`http://content.local/thumb?id=${encodeURIComponent(id)}`));
    expect(res.status).toBe(404);
    // MUST NOT be heuristically cached: the URL is identical before and after the thumbnail lands (same
    // version), so a cached 404 would pin the neutral slot even once the preview exists. no-cache forces a
    // revalidation that picks up the newly-rendered PNG. [FRAMING:representation]
    expect(res.headers.get('cache-control')).toBe('no-cache');
    // Still sealed under the strict CSP like every response from this origin.
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('hides an unlisted playground’s preview with a 410 — the takedown covers pixels too', async () => {
    const { handler, catalog, store, thumbnails } = setup();
    const id = await seed(catalog, store, RAW_HTML);
    const version = currentVersionOf((await catalog.getPlayground(id)).session);
    await thumbnails.put(version, PNG);
    await catalog.setListing(id, 'unlisted');

    const res = await handler(new Request(`http://content.local/thumb?id=${encodeURIComponent(id)}`));
    // 410 Gone, NOT the stored PNG: a takedown that hid the page but leaked its preview would be a
    // takedown that doesn't take anything down. [LAW:single-enforcer]
    expect(res.status).toBe(410);
    expect(res.headers.get('content-type')).not.toContain('image/png');
  });

  it('404s an unknown id and 400s a missing id, like the html route', async () => {
    const { handler } = setup();
    expect((await handler(new Request('http://content.local/thumb?id=nope'))).status).toBe(404);
    expect((await handler(new Request('http://content.local/thumb'))).status).toBe(400);
  });
});
