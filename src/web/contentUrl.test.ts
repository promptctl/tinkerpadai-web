import { describe, expect, it } from 'vitest';
import { PlaygroundId, VersionId } from '../storage/index.js';
import { playgroundContentUrl, playgroundThumbnailUrl } from './contentUrl.js';

// The two content-origin URL formulas — the SINGLE source both the player/renderer and the commons card
// derive their URLs from. These assertions fix the shape the content handler routes on: `/?id=…` for the
// raw playground and `/thumb?id=…&v=…` for its preview. If either drifts, a card frames a URL the serve
// route does not answer. [LAW:one-source-of-truth] [FRAMING:representation]

const ID = PlaygroundId('pg-1');
const VERSION = VersionId('v-9');

describe('playgroundContentUrl', () => {
  it('joins the id onto the content origin as the routed /?id= path', () => {
    expect(playgroundContentUrl('https://content.example', ID)).toBe('https://content.example/?id=pg-1');
  });

  it('url-encodes a hostile id so it cannot break out of the query', () => {
    expect(playgroundContentUrl('https://content.example', PlaygroundId('a b&c'))).toBe(
      'https://content.example/?id=a%20b%26c',
    );
  });

  // A configured origin with a trailing slash must NOT produce a `//?id=…` double-slash pathname the
  // content handler routes as 404 — the origin is normalized at the single shared enforcer. [LAW:single-enforcer]
  it('strips a trailing slash on the origin so the pathname stays single-slash', () => {
    expect(playgroundContentUrl('https://content.example/', ID)).toBe('https://content.example/?id=pg-1');
    expect(playgroundContentUrl('https://content.example///', ID)).toBe('https://content.example/?id=pg-1');
  });
});

describe('playgroundThumbnailUrl', () => {
  it('joins the id and current version onto the content origin as the routed /thumb path', () => {
    expect(playgroundThumbnailUrl('https://content.example', ID, VERSION)).toBe(
      'https://content.example/thumb?id=pg-1&v=v-9',
    );
  });

  it('url-encodes a hostile id and version so neither can break out of the query', () => {
    expect(playgroundThumbnailUrl('https://content.example', PlaygroundId('a&b'), VersionId('x y'))).toBe(
      'https://content.example/thumb?id=a%26b&v=x%20y',
    );
  });

  // Same single-enforcer normalization as the content URL — a trailing-slash origin would otherwise 404
  // every card's preview img (no preview even for rendered playgrounds). [LAW:single-enforcer]
  it('strips a trailing slash on the origin so the preview path stays single-slash', () => {
    expect(playgroundThumbnailUrl('https://content.example/', ID, VERSION)).toBe(
      'https://content.example/thumb?id=pg-1&v=v-9',
    );
  });
});
