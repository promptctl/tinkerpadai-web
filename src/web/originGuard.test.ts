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

  // The contract for a non-web origin is a LOUD rejection as invalid config — not a specific branch.
  // Either named-config error is a correct rejection: a WHATWG parser accepts data:/javascript: and
  // the protocol/hostname check rejects them; a stricter parser throws at construction. Matching both
  // keeps the test on the behavior, not the branch. [LAW:behavior-not-structure]
  const rejectedAsBadOrigin = /must be (a valid absolute URL|an http\(s\) URL with a hostname)/;

  it('rejects a data: app origin — it has no hostname, so it must not pass silently', () => {
    expect(() =>
      assertDistinctOriginHosts('data:text/html,hello', 'https://content.tinkerpad.test'),
    ).toThrow(rejectedAsBadOrigin);
  });

  it('rejects a javascript: content origin — no hostname is not a valid web origin', () => {
    expect(() => assertDistinctOriginHosts('https://app.tinkerpad.test', 'javascript:void(0)')).toThrow(
      rejectedAsBadOrigin,
    );
  });

  it('rejects a non-http(s) scheme even when it carries a host (e.g. ftp)', () => {
    expect(() => assertDistinctOriginHosts('https://app.tinkerpad.test', 'ftp://content.tinkerpad.test')).toThrow(
      rejectedAsBadOrigin,
    );
  });
});
