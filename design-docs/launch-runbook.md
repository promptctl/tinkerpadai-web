# TinkerPad launch runbook

The concrete sequence that turns the built platform into a publicly-reachable site. It exists because
launching is the moment untrusted code meets the open internet — every step is written down so the
exposure is a deliberate, reviewable event, not folklore. `tinkerpadai-launch-nkn` closes when the
last step here is done and the site answers on its public host.

**Status of the gate:** all nine dependency edges are CLOSED (sandbox audit, report+unlist,
terms/privacy/DMCA, economics, commons seeded, Cloudflare foundation, app-origin headers). The
Cloudflare stores are provisioned and the commons is migrated to production; the hosts are decided
(app `tinkerpad.ai`, content `content.tinkerpad.ai`). What remains is the one operator-only blocker —
the GitHub OAuth app — and the final deploy. See `design-docs/deploy-cloudflare.md` for the commands.

---

## The split: done vs. remaining

**Done — code prepared in-repo AND the Cloudflare stores provisioned/populated on the account
(brandon.fryslie.signup@gmail.com, where `tinkerpad.ai` is an active zone):**

- The Worker runs the same app as Node; boots under `wrangler dev` with R2/D1, two origins enforced,
  sessions in D1, cookies hardened (`cloudflare-8le.1`). Sandbox boundary audited sound; app-origin
  security headers ship (`sandbox-bci.*`).
- **Stores provisioned:** R2 bucket `tinkerpad-artifacts` created; D1 db `tinkerpad`
  (id `4c0c7651-3a48-4f41-b1d5-59f1ab2c7048`) created, schema applied `--remote`.
- **Commons migrated to production** via `pnpm migrate --remote` — verified in prod: D1 catalog holds
  119 playgrounds (116 listed), 123 artifacts in R2, byte-identical to local. The tool is idempotent
  and safe to re-run.
- **`wrangler.toml` is filled** with the real hosts (app `tinkerpad.ai`, content
  `content.tinkerpad.ai`), the provisioned `database_id`, and the two custom-domain routes.

**Remaining — the operator-held blocker plus the final public-exposure step:**

1. **GitHub OAuth app (BLOCKER, operator-only).** `src/web/worker.ts` requires GITHUB_CLIENT_ID/SECRET
   or it 500s on every request, and GitHub has no API to create an OAuth app — it is created in the web
   UI. Create one at <https://github.com/settings/developers> with Authorization callback URL
   `https://tinkerpad.ai/session/callback`, then set the secrets:
   - `wrangler secret put GITHUB_CLIENT_ID`
   - `wrangler secret put GITHUB_CLIENT_SECRET`
2. **Admin subject (optional at launch, required to action takedowns).** Uncomment
   `TINKERPAD_ADMIN_SUBJECTS = "github:<numeric-id>"` in `wrangler.toml [vars]` with the operator's
   GitHub id. Empty = no admins (safe default), but reports/DMCA can't be actioned until set.
3. **Deploy + go live (the irreversible public-exposure step):**
   `pnpm build && pnpm typecheck && pnpm test && wrangler deploy`. Deploy creates the two custom
   domains from the `routes` block, binding `tinkerpad.ai` and `content.tinkerpad.ai` to the Worker —
   this is what makes the site publicly reachable. Do NOT deploy before step 1's secrets are set, or
   the domains bind to a Worker that 500s.

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
