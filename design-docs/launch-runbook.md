# TinkerPad launch runbook

The concrete sequence that turns the built platform into a publicly-reachable site. It exists because
launching is the moment untrusted code meets the open internet — every step is written down so the
exposure is a deliberate, reviewable event, not folklore. `tinkerpadai-launch-nkn` closes when the
last step here is done and the site answers on its public host.

**Status of the gate:** all nine dependency edges are CLOSED (sandbox audit, report+unlist,
terms/privacy/DMCA, economics, commons seeded, Cloudflare foundation, app-origin headers). What
remains is not code — it is account-bound provisioning only the operator can do, plus the two
decisions below. See `design-docs/deploy-cloudflare.md` for the exact commands.

---

## The split: prepared vs. operator-held

**Prepared and verified in-repo (no account needed) — DONE:**

- The Worker runs the same app as Node; boots under `wrangler dev` with R2/D1, two origins enforced,
  sessions in D1, cookies hardened (`cloudflare-8le.1`).
- The sandbox boundary is audited sound; app-origin security headers (anti-framing, CSP, nosniff)
  ship (`sandbox-bci.*`).
- **The commons migration tool** (`pnpm migrate`) is built, unit-tested, and verified end-to-end
  against local miniflare: the migrated catalog lists 116 playgrounds through the real D1 adapter and
  the content origin serves each artifact byte-identical to the local copy through the real R2
  adapter. The only change at launch is `--remote`.

**Operator-held — each step below touches the operator's Cloudflare account, GitHub, DNS, or a real
secret. These are IRREVERSIBLE public-exposure actions and are the operator's to run.**

---

## Decisions required before executing (see the questions raised alongside this runbook)

1. **App host** — `tinkerpad.ai` (already confirmed in the legal/privacy pages and prior launch
   notes). Not re-opened here.
2. **Content host** — MUST be a different hostname from the app; this is the sandbox boundary, not a
   preference. Recommended: `content.tinkerpad.ai` (a distinct origin is sufficient; the session
   cookie is `__Host-`-prefixed with no `Domain`, so it is never sent to the content host regardless).
   A wholly separate domain is also fine if the operator prefers stronger separation.
3. **Admin subject(s)** — `TINKERPAD_ADMIN_SUBJECTS` must be set to the operator's `github:<numeric-id>`
   for the moderation console (`/admin`) to be reachable; empty means no one can action takedowns.
   Optional to set at first deploy, but required before the platform can honor a report/DMCA notice.

---

## Sequence

Run from a clean checkout with `wrangler` authenticated (`wrangler login`).

1. **Provision stores** (`deploy-cloudflare.md` §One-time provisioning):
   - `wrangler r2 bucket create tinkerpad-artifacts`
   - `wrangler d1 create tinkerpad` → paste the printed `database_id` into `wrangler.toml`
   - `wrangler d1 migrations apply tinkerpad --remote`

2. **Create the GitHub OAuth app** (callback `https://tinkerpad.ai/session/callback`) and store the
   credentials as Worker secrets:
   - `wrangler secret put GITHUB_CLIENT_ID`
   - `wrangler secret put GITHUB_CLIENT_SECRET`

3. **Set config in `wrangler.toml`** to the real hosts (decisions 1–3):
   - `database_id` (from step 1)
   - `[vars] TINKERPAD_OAUTH_CALLBACK_URL = "https://tinkerpad.ai/session/callback"`
   - `[vars] TINKERPAD_CONTENT_ORIGIN = "https://content.tinkerpad.ai"`
   - `[vars] TINKERPAD_ADMIN_SUBJECTS = "github:<your-id>"`
   - uncomment `routes` and bind BOTH hosts to the Worker

4. **Migrate the commons** (`deploy-cloudflare.md` §Migrate the commons):
   - `pnpm migrate` (dry-run, confirm the plan) then `pnpm migrate --remote`

5. **Deploy:** `pnpm build && pnpm typecheck && pnpm test && wrangler deploy`

6. **Point DNS:** both `tinkerpad.ai` and the content host as records resolving to the Worker
   (custom domains in the Cloudflare dashboard, matching the `routes` block).

---

## Post-launch verification (the gate's acceptance — "publicly reachable")

- `https://tinkerpad.ai/commons` lists the seeded playgrounds.
- Opening a playground frames its raw HTML from the content host (view-source shows the sandbox CSP;
  the iframe is a distinct origin).
- Sign in with GitHub round-trips to `/session/callback` and back.
- `https://tinkerpad.ai/admin` is reachable by the configured admin subject and no one else.
- Generation UI is ABSENT (the first deploy runs generation disabled by design — public generation
  arrives with `providers-u1h` + the credits ledger).
- The app host is NOT frameable; the content host refuses an unlisted id with 410.

## Reversal

The deploy is a Worker + DNS; taking the site down is removing the routes / DNS records. The commons
migration is reversible per `deploy-cloudflare.md`. Nothing here writes state that cannot be undone by
the operator.
