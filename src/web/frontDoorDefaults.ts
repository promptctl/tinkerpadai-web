// The dev front door's default ORIGIN, as a neutral leaf both the server config and the
// out-of-process seeding client depend on — neither reaching into the other's internals. These
// are the stable public facts of where the dev server listens, not server logic. Keeping them
// here (rather than inside serverConfig, which also holds the server-specific resolver) is what
// lets the seed script share the one source of truth without importing server config.
// [LAW:one-source-of-truth] [LAW:locality-or-seam]

// The default port the dev front door listens on, and the single source of that number. The
// seeding script's default target URL references it so `just seed` (no TINKERPAD_URL) cannot
// drift onto a stale port if this default changes.
export const DEFAULT_PORT = 8787;

// The single source of the DEV front door's host. It governs the dev entry only: the callback
// URL default derives from it, and that default fires just when TINKERPAD_OAUTH_CALLBACK_URL is
// unset — the dev case. main.dev.ts binds and logs this same host, so the dev bind, logged URL,
// and callback origin cannot disagree. Production sets TINKERPAD_OAUTH_CALLBACK_URL explicitly
// (real GitHub OAuth) and binds via deploy config — it must not bind here, since localhost would
// be unreachable. localhost, not 127.0.0.1: cookies scope to the exact hostname, so a session
// begun on one is absent on the other — a bind/callback origin mismatch would drop the login's
// CSRF state cookie on the callback.
export const FRONT_DOOR_HOST = 'localhost';
