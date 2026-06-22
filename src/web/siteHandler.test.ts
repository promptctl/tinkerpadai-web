import { describe, expect, it } from 'vitest';
import { makeSiteHandler } from './siteHandler.js';

// The site handler's contract: it serves the page at GET / and delegates everything else to
// the API handler, unchanged. The assertions are over that composition — which request goes
// where — not over the page's contents or the API's internals. [LAW:behavior-not-structure]

const PAGE = '<!doctype html><title>front door</title>';

const handlerWithSpy = (): {
  handler: (request: Request) => Promise<Response>;
  delegated: Request[];
} => {
  const delegated: Request[] = [];
  const apiHandler = async (request: Request): Promise<Response> => {
    delegated.push(request);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { handler: makeSiteHandler({ page: PAGE, apiHandler }), delegated };
};

describe('makeSiteHandler', () => {
  it('serves the page at GET / as HTML, never touching the API', async () => {
    const { handler, delegated } = handlerWithSpy();
    const res = await handler(new Request('http://front.local/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(PAGE);
    expect(delegated).toHaveLength(0);
  });

  it('delegates every non-root route to the API handler unchanged', async () => {
    const { handler, delegated } = handlerWithSpy();
    const res = await handler(new Request('http://front.local/providers'));
    expect(await res.json()).toEqual({ ok: true });
    expect(delegated.map((r) => new URL(r.url).pathname)).toEqual(['/providers']);
  });

  it('delegates a POST to / to the API rather than serving the page', async () => {
    const { handler, delegated } = handlerWithSpy();
    await handler(new Request('http://front.local/', { method: 'POST' }));
    expect(delegated).toHaveLength(1);
  });
});
