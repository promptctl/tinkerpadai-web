import { fileURLToPath } from 'node:url';

// [LAW:no-silent-failure] [LAW:types-are-the-program] Number() accepts any string and
// silently produces NaN for non-numeric input, which cascades into listen() and callback URLs.
function parsePort(value: string | undefined, name: string, fallback: number): number {
  const n = value !== undefined ? Number(value) : fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > 65535) {
    // [LAW:no-silent-failure] a derived default that lands out of range (e.g. PORT=65535
    // making contentPort 65536) fails loudly and names the remedy — never clamped to a
    // different port than documented.
    const detail =
      value !== undefined
        ? `${name}=${JSON.stringify(value)} is not a valid port number (1-65535)`
        : `derived default for ${name} (${fallback}) is not a valid port number (1-65535); set ${name} explicitly`;
    throw new Error(detail);
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
  // localhost, not 127.0.0.1: browsers scope cookies to the hostname, so 127.0.0.1 and
  // localhost are distinct cookie domains. The callback must match the origin the browser
  // uses or the CSRF state cookie will be absent on the callback request. [LAW:one-source-of-truth]
  const oauthCallbackUrl =
    process.env.TINKERPAD_OAUTH_CALLBACK_URL || `http://localhost:${port}/session/callback`;
  return { dataDir, port, contentPort, oauthCallbackUrl };
}
