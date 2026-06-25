import { describe, expect, it } from 'vitest';
import { readCookie, serializeCookie } from './cookies.js';

// The codec's contract: read a named value out of a Cookie header, and serialize a Set-Cookie
// with the security attributes. Pure string in, pure string out — asserted as behavior, never
// internals. [LAW:behavior-not-structure]

describe('readCookie', () => {
  it('returns null when there is no Cookie header at all', () => {
    expect(readCookie(null, 'tp_session')).toBeNull();
  });

  it('reads the value of a single named cookie', () => {
    expect(readCookie('tp_session=abc123', 'tp_session')).toBe('abc123');
  });

  it('finds the right cookie among several, trimming whitespace around pairs', () => {
    expect(readCookie('a=1; tp_session=tok; b=2', 'tp_session')).toBe('tok');
  });

  it('returns null for a name that is absent from a populated header', () => {
    expect(readCookie('a=1; b=2', 'tp_session')).toBeNull();
  });

  it('keeps everything after the first = so a value may itself contain =', () => {
    expect(readCookie('tp_session=a=b=c', 'tp_session')).toBe('a=b=c');
  });

  it('does not match a cookie whose name is a prefix of the requested one', () => {
    expect(readCookie('tp_sess=nope', 'tp_session')).toBeNull();
  });
});

describe('serializeCookie', () => {
  it('emits the value with Path, SameSite, and HttpOnly — and never a Domain (host-scoped)', () => {
    const cookie = serializeCookie('tp_session', 'tok', { httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(cookie).toBe('tp_session=tok; Path=/; SameSite=Strict; HttpOnly');
    // Host-scoping is the absence of Domain — the property the credential-free boundary rests on.
    expect(cookie).not.toContain('Domain');
  });

  it('omits HttpOnly when not requested but keeps the other attributes', () => {
    const cookie = serializeCookie('tp_session', 'tok', { httpOnly: false, sameSite: 'Lax', path: '/' });
    expect(cookie).toBe('tp_session=tok; Path=/; SameSite=Lax');
  });

  it('round-trips: a serialized cookie value is readable back out of a Cookie header', () => {
    const setCookie = serializeCookie('tp_session', 'tok-xyz', { httpOnly: true, sameSite: 'Strict', path: '/' });
    const cookieHeader = setCookie.split(';')[0]!;
    expect(readCookie(cookieHeader, 'tp_session')).toBe('tok-xyz');
  });
});
