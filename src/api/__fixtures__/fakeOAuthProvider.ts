import { Subject } from '../identity.js';
import type { OAuthProvider } from '../oauth.js';

// A SCRIPTED OAuthProvider for tests: the delegated-identity seam with the network removed. It
// plays the identity provider's role deterministically — authorizeUrl echoes state+redirect into
// a stub authorize URL (so a test can read back exactly what the session route sent), and
// authenticate returns a configured Subject for any code EXCEPT a designated failing one, which
// throws to model a rejected exchange. This is what lets the whole login flow — state CSRF
// round-trip, cookie minting, the gate flipping to authenticated — be proven without a real
// GitHub. [LAW:effects-at-boundaries] [LAW:one-type-per-behavior]
export interface FakeOAuthProviderConfig {
  // The principal a successful exchange grants.
  readonly subject: Subject;
  // A code value that makes authenticate THROW, so a test can drive the failed-exchange path.
  // Absent ⇒ every code succeeds.
  readonly failingCode?: string;
}

export const makeFakeOAuthProvider = (config: FakeOAuthProviderConfig): OAuthProvider => ({
  authorizeUrl: ({ state, redirectUri }) => {
    const params = new URLSearchParams({ redirect_uri: redirectUri, state });
    return `https://idp.test/authorize?${params.toString()}`;
  },
  authenticate: async ({ code }) => {
    if (config.failingCode !== undefined && code === config.failingCode) {
      throw new Error('oauth exchange failed');
    }
    return config.subject;
  },
});
