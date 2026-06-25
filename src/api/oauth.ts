import { Subject } from '../identity/index.js';

// THE DELEGATED-IDENTITY SEAM. "Who is this principal, proven by a third-party identity
// provider" expressed as one boundary, behind which a concrete provider (GitHub today) lives
// entirely. The session handler runs the OAuth dance — mint state, redirect, verify the
// callback, set the cookie — without knowing a single GitHub URL or JSON shape; those are this
// provider's concern alone. So the provider swaps (GitHub -> Google -> …) by wiring a different
// instance at the composition root, and nothing in the session flow changes. [LAW:decomposition]
// [LAW:locality-or-seam]
export interface OAuthProvider {
  // PURE: build the provider's authorize-redirect URL for this state and callback. No effect —
  // it is a string transform, so the session route can construct the redirect and the provider
  // owns only the URL's shape. `state` is the caller's CSRF nonce, echoed back to the callback;
  // `redirectUri` is where the provider returns the browser. [LAW:effects-at-boundaries]
  authorizeUrl(params: { readonly state: string; readonly redirectUri: string }): string;
  // EFFECT, at this boundary: exchange the one-time `code` the callback received for the
  // authenticated principal, returned as the STABLE Subject (e.g. a provider's immutable user
  // id, never a renamable handle — that id is what attribution and lineage key on). The single
  // place the provider's token + userinfo HTTP and JSON shape live. It THROWS on any failure
  // (provider error, bad code, missing id): a failed exchange must never resolve to a session,
  // so there is no null-means-anonymous path here. [LAW:no-silent-failure] [LAW:effects-at-boundaries]
  authenticate(params: { readonly code: string; readonly redirectUri: string }): Promise<Subject>;
}

// GitHub's OAuth endpoints. Constants, one place: the authorize page the browser is sent to, the
// token endpoint the code is exchanged at, and the userinfo endpoint the principal is read from.
const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';

// The scope requested. read:user is the minimum that yields the stable numeric id; TinkerPad
// needs identity, not repo or write access, so it asks for nothing more. [LAW:carrying-cost]
const GITHUB_SCOPE = 'read:user';

export interface GitHubOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// THE GITHUB OAUTH PROVIDER — the one place GitHub's wire shape is known. authorizeUrl is a pure
// URL build; authenticate performs the two real HTTP hops (code -> access token -> user) and
// brands the stable id as a Subject. Every failure is surfaced loudly with context, never
// swallowed into a silent "no identity" that would mint an anonymous session. [LAW:no-silent-failure]
export const makeGitHubOAuthProvider = (config: GitHubOAuthConfig): OAuthProvider => {
  const { clientId, clientSecret } = config;
  return {
    authorizeUrl: ({ state, redirectUri }) => {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: GITHUB_SCOPE,
        state,
      });
      return `${GITHUB_AUTHORIZE}?${params.toString()}`;
    },
    authenticate: async ({ code, redirectUri }) => {
      // 1. Exchange the one-time code for an access token. Accept: application/json so GitHub
      //    returns JSON (its default is form-encoded). A non-2xx, an `error` field, or a missing
      //    token are all real failures surfaced loudly — never a path that proceeds tokenless.
      const tokenResponse = await fetch(GITHUB_TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      });
      if (!tokenResponse.ok) {
        throw new Error(`github token exchange failed: ${tokenResponse.status}`);
      }
      const tokenBody: unknown = await tokenResponse.json();
      if (!isRecord(tokenBody)) throw new Error('github token response was not a JSON object');
      if (typeof tokenBody.error === 'string') {
        throw new Error(`github token exchange rejected: ${tokenBody.error}`);
      }
      if (typeof tokenBody.access_token !== 'string' || tokenBody.access_token === '') {
        throw new Error('github token response carried no access_token');
      }
      const accessToken = tokenBody.access_token;

      // 2. Read the authenticated user. The numeric `id` is GitHub's STABLE principal id — the
      //    `login` handle can be renamed, the id cannot — so it is what we brand as the Subject,
      //    exactly the stable key attribution and lineage already record. User-Agent is required
      //    by the GitHub API or it 403s. [LAW:one-source-of-truth]
      const userResponse = await fetch(GITHUB_USER, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'tinkerpad' },
      });
      if (!userResponse.ok) {
        throw new Error(`github userinfo failed: ${userResponse.status}`);
      }
      const userBody: unknown = await userResponse.json();
      if (!isRecord(userBody) || typeof userBody.id !== 'number') {
        throw new Error('github userinfo carried no numeric id');
      }
      return Subject(`github:${userBody.id}`);
    },
  };
};
