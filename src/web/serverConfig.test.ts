import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveServerConfig } from './serverConfig.js';

// The Node front door resolves two socket ports — the app origin and the playground-content origin.
// They must be different ports: on Node that IS the two-origin sandbox split (same host, distinct
// port). resolveServerConfig owns that invariant so both Node entries inherit it. [LAW:behavior-not-structure]
describe('resolveServerConfig — two-origin port split', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.PORT;
    delete process.env.TINKERPAD_CONTENT_PORT;
    delete process.env.TINKERPAD_OAUTH_CALLBACK_URL;
    delete process.env.TINKERPAD_DATA_DIR;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults the content port to one above the app port — distinct by construction', () => {
    process.env.PORT = '4000';
    const { port, contentPort } = resolveServerConfig(import.meta.url);
    expect(port).toBe(4000);
    expect(contentPort).toBe(4001);
  });

  it('throws when PORT and TINKERPAD_CONTENT_PORT are the same port', () => {
    process.env.PORT = '4000';
    process.env.TINKERPAD_CONTENT_PORT = '4000';
    expect(() => resolveServerConfig(import.meta.url)).toThrow(/must be different ports/);
  });

  it('throws when PORT is unset (defaults to 8787) and TINKERPAD_CONTENT_PORT is set to that default', () => {
    // The default-vs-explicit collision reaches port === contentPort through parsePort's fallback
    // branch (PORT undefined), a different route than the explicit-vs-explicit case above.
    process.env.TINKERPAD_CONTENT_PORT = '8787';
    expect(() => resolveServerConfig(import.meta.url)).toThrow(/must be different ports/);
  });

  it('names both ports and the remedy env var in the collision error', () => {
    process.env.PORT = '5000';
    process.env.TINKERPAD_CONTENT_PORT = '5000';
    expect(() => resolveServerConfig(import.meta.url)).toThrow(/5000[\s\S]*TINKERPAD_CONTENT_PORT/);
  });

  it('accepts explicitly distinct ports', () => {
    process.env.PORT = '4000';
    process.env.TINKERPAD_CONTENT_PORT = '9999';
    const { port, contentPort } = resolveServerConfig(import.meta.url);
    expect(port).toBe(4000);
    expect(contentPort).toBe(9999);
  });
});
