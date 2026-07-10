import { describe, expect, it } from 'vitest';
import { assertDistinctOriginHosts } from './originGuard.js';

// The two-origin distinctness invariant, asserted as behavior: distinct hostnames pass, a shared
// hostname is rejected loudly with a message that names the collapse and the remedy. Distinctness is
// at the HOSTNAME granularity because cookies (the asset at risk) ignore the port. This is the
// config-safety gate the sandbox rests on. [LAW:behavior-not-structure]
describe('assertDistinctOriginHosts', () => {
  it('passes when the content origin is a different hostname from the app origin', () => {
    expect(() =>
      assertDistinctOriginHosts('https://app.tinkerpad.test', 'https://content.tinkerpad.test'),
    ).not.toThrow();
  });

  it('accepts the app origin given as a full callback URL — it compares hostnames, not whole URLs', () => {
    expect(() =>
      assertDistinctOriginHosts('https://app.tinkerpad.test/session/callback', 'https://content.tinkerpad.test'),
    ).not.toThrow();
  });

  it('throws when the content origin shares the app origin hostname', () => {
    expect(() =>
      assertDistinctOriginHosts('https://app.tinkerpad.test/session/callback', 'https://app.tinkerpad.test'),
    ).toThrow(/must be different hostnames/);
  });

  it('rejects a shared hostname that differs only by port — cookies ignore the port', () => {
    // A same-hostname:different-port config would still leak the __Host- session cookie to the
    // untrusted content, so it must be rejected even though the router would route the two apart.
    expect(() => assertDistinctOriginHosts('https://tp.example', 'https://tp.example:8443')).toThrow(
      /must be different hostnames/,
    );
  });

  it('names the shared hostname and the remedy in the error', () => {
    expect(() => assertDistinctOriginHosts('https://tp.example', 'https://tp.example')).toThrow(
      /tp\.example[\s\S]*TINKERPAD_CONTENT_ORIGIN/,
    );
  });

  it('treats same hostname on a different scheme as a collision — non-Secure cookies cross schemes', () => {
    expect(() => assertDistinctOriginHosts('https://tp.example', 'http://tp.example')).toThrow(
      /must be different hostnames/,
    );
  });

  it('rejects a malformed app origin with a named config error, not a bare Invalid URL', () => {
    expect(() => assertDistinctOriginHosts('tp.example/callback', 'https://content.tinkerpad.test')).toThrow(
      /The app origin must be a valid absolute URL/,
    );
  });

  it('rejects a malformed content origin with a named config error', () => {
    expect(() => assertDistinctOriginHosts('https://app.tinkerpad.test', 'not a url')).toThrow(
      /The playground content origin must be a valid absolute URL/,
    );
  });
});
