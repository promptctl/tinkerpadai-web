import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeGitHubOAuthProvider } from './oauth.js';

// The GitHub OAuth provider's contract at the seam: authorizeUrl is a pure URL build; authenticate
// performs the code->token->user exchange and brands the STABLE numeric id as a Subject, throwing
// loudly on every failure shape rather than ever resolving tokenless or id-less. The network is
// stubbed so the wire shape is exercised without a real GitHub. [LAW:behavior-not-structure]

const CONFIG = { clientId: 'cid', clientSecret: 'secret' };
const REDIRECT = 'http://app.local/session/callback';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Stub global fetch to answer the token endpoint and the user endpoint independently, so each
// failure can be injected in isolation.
const stubFetch = (responders: { token: () => Response; user?: () => Response }): void => {
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('login/oauth/access_token')) return Promise.resolve(responders.token());
    if (url.includes('api.github.com/user')) return Promise.resolve((responders.user ?? (() => jsonResponse({})))());
    throw new Error(`unexpected fetch: ${url}`);
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('makeGitHubOAuthProvider — authorizeUrl', () => {
  it('builds the GitHub authorize URL carrying client_id, redirect_uri, scope, and state', () => {
    const provider = makeGitHubOAuthProvider(CONFIG);
    const url = new URL(provider.authorizeUrl({ state: 'nonce-123', redirectUri: REDIRECT }));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toBe('read:user');
    expect(url.searchParams.get('state')).toBe('nonce-123');
  });
});

describe('makeGitHubOAuthProvider — authenticate', () => {
  it('exchanges the code and brands the stable numeric id as the Subject', async () => {
    stubFetch({
      token: () => jsonResponse({ access_token: 'gho_token' }),
      user: () => jsonResponse({ id: 4242, login: 'octocat' }),
    });
    const subject = await makeGitHubOAuthProvider(CONFIG).authenticate({ code: 'c', redirectUri: REDIRECT });
    // The STABLE numeric id, never the renamable login handle. [LAW:one-source-of-truth]
    expect(subject).toBe('github:4242');
  });

  it('throws when the token endpoint is not ok', async () => {
    stubFetch({ token: () => jsonResponse({}, 500) });
    await expect(makeGitHubOAuthProvider(CONFIG).authenticate({ code: 'c', redirectUri: REDIRECT })).rejects.toThrow(
      /token exchange failed/,
    );
  });

  it('throws when GitHub returns an error field instead of a token', async () => {
    stubFetch({ token: () => jsonResponse({ error: 'bad_verification_code' }) });
    await expect(makeGitHubOAuthProvider(CONFIG).authenticate({ code: 'c', redirectUri: REDIRECT })).rejects.toThrow(
      /bad_verification_code/,
    );
  });

  it('throws when the token response carries no access_token', async () => {
    stubFetch({ token: () => jsonResponse({ token_type: 'bearer' }) });
    await expect(makeGitHubOAuthProvider(CONFIG).authenticate({ code: 'c', redirectUri: REDIRECT })).rejects.toThrow(
      /no access_token/,
    );
  });

  it('throws when the userinfo call is not ok', async () => {
    stubFetch({ token: () => jsonResponse({ access_token: 'tok' }), user: () => jsonResponse({}, 403) });
    await expect(makeGitHubOAuthProvider(CONFIG).authenticate({ code: 'c', redirectUri: REDIRECT })).rejects.toThrow(
      /userinfo failed/,
    );
  });

  it('throws when userinfo carries no numeric id', async () => {
    stubFetch({ token: () => jsonResponse({ access_token: 'tok' }), user: () => jsonResponse({ login: 'octocat' }) });
    await expect(makeGitHubOAuthProvider(CONFIG).authenticate({ code: 'c', redirectUri: REDIRECT })).rejects.toThrow(
      /no numeric id/,
    );
  });
});
