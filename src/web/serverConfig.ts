import { fileURLToPath } from 'node:url';

// Single source of truth for runtime config shared by main.ts and main.dev.ts.
// [LAW:one-source-of-truth] [LAW:effects-at-boundaries]
export function resolveServerConfig(importMetaUrl: string) {
  const dataDir =
    process.env.TINKERPAD_DATA_DIR ??
    fileURLToPath(new URL('../../.tinkerpad-data', importMetaUrl));
  const port = Number(process.env.PORT ?? 8787);
  const contentPort = Number(process.env.TINKERPAD_CONTENT_PORT ?? port + 1);
  const oauthCallbackUrl =
    process.env.TINKERPAD_OAUTH_CALLBACK_URL || `http://127.0.0.1:${port}/session/callback`;
  return { dataDir, port, contentPort, oauthCallbackUrl };
}
