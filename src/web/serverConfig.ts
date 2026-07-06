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

// The default port the dev front door listens on, and the single source of that number.
// The seeding script's default target URL references this so `just seed` (no TINKERPAD_URL)
// cannot drift onto a stale port if this default changes. [LAW:one-source-of-truth]
export const DEFAULT_PORT = 8787;

// The single source of the DEV front door's host. It governs the dev entry only: the callback
// URL default derives from it, and that default fires just when TINKERPAD_OAUTH_CALLBACK_URL is
// unset — the dev case. main.dev.ts binds and logs this same host, so the dev bind, logged URL,
// and callback origin cannot disagree. Production sets TINKERPAD_OAUTH_CALLBACK_URL explicitly
// (real GitHub OAuth) and binds via deploy config — it must not bind here, since localhost would
// be unreachable. localhost, not 127.0.0.1: cookies scope to the exact hostname, so a session
// begun on one is absent on the other — a bind/callback origin mismatch would drop the login's
// CSRF state cookie on the callback. [LAW:one-source-of-truth]
export const FRONT_DOOR_HOST = 'localhost';

// Single source of truth for runtime config shared by main.ts and main.dev.ts.
// [LAW:one-source-of-truth] [LAW:effects-at-boundaries]
export function resolveServerConfig(importMetaUrl: string) {
  const dataDir =
    process.env.TINKERPAD_DATA_DIR ??
    fileURLToPath(new URL('../../.tinkerpad-data', importMetaUrl));
  const port = parsePort(process.env.PORT, 'PORT', DEFAULT_PORT);
  const contentPort = parsePort(process.env.TINKERPAD_CONTENT_PORT, 'TINKERPAD_CONTENT_PORT', port + 1);
  // The callback origin is FRONT_DOOR_HOST — the same host the dev entry binds and logs — so
  // the CSRF state cookie set at login is present on the callback request. [LAW:one-source-of-truth]
  const oauthCallbackUrl =
    process.env.TINKERPAD_OAUTH_CALLBACK_URL || `http://${FRONT_DOOR_HOST}:${port}/session/callback`;
  return { dataDir, port, contentPort, oauthCallbackUrl, frontDoorHost: FRONT_DOOR_HOST };
}
