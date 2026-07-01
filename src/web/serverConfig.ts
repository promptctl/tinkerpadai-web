import { fileURLToPath } from 'node:url';

// [LAW:no-silent-failure] [LAW:types-are-the-program] Number() accepts any string and
// silently produces NaN for non-numeric input, which cascades into listen() and callback URLs.
function parsePort(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${name}=${JSON.stringify(value)} is not a valid port number (0-65535)`);
  }
  return n;
}

// Single source of truth for runtime config shared by main.ts and main.dev.ts.
// [LAW:one-source-of-truth] [LAW:effects-at-boundaries]
export function resolveServerConfig(importMetaUrl: string) {
  const dataDir =
    process.env.TINKERPAD_DATA_DIR ??
    fileURLToPath(new URL('../../.tinkerpad-data', importMetaUrl));
  const port = parsePort(process.env.PORT, 'PORT', 8787);
  const contentPort = parsePort(process.env.TINKERPAD_CONTENT_PORT, 'TINKERPAD_CONTENT_PORT', port + 1);
  const oauthCallbackUrl =
    process.env.TINKERPAD_OAUTH_CALLBACK_URL || `http://127.0.0.1:${port}/session/callback`;
  return { dataDir, port, contentPort, oauthCallbackUrl };
}
