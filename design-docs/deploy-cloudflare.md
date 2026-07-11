# Deploying TinkerPad to Cloudflare Workers

The Worker runs the **same app** the Node entry runs — only the adapters differ (R2 for
artifacts, D1 for the catalog + sessions). The code is in place and verified under a local
`wrangler dev`; the steps below are the account-bound provisioning only the account owner can do.
See `src/web/worker.ts` (edge composition root) and `wrangler.toml` (bindings).

## Load-bearing invariant: two origins

The app and the raw playground content **must** stay on separate hosts — this is the sandbox
boundary, not a deploy detail. `TINKERPAD_CONTENT_ORIGIN` is a distinct host from the app; the
Worker's `fetch` splits them by host (`src/web/frontDoorRouter.ts`). Never collapse them to one host.

## One-time provisioning

```sh
# 1. R2 bucket for artifact html
wrangler r2 bucket create tinkerpad-artifacts

# 2. D1 database — copy the printed database_id into wrangler.toml (replaces the placeholder)
wrangler d1 create tinkerpad

# 3. Apply the schema (catalog + sessions tables)
wrangler d1 migrations apply tinkerpad --remote

# 4. GitHub OAuth app: create at https://github.com/settings/developers with
#    Authorization callback URL = https://<app-host>/session/callback
#    then store the credentials as Worker secrets:
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
```

## Config to set in `wrangler.toml`

- `database_id` — from `wrangler d1 create` (step 2).
- `[vars] TINKERPAD_OAUTH_CALLBACK_URL` — `https://<app-host>/session/callback` (must match the
  GitHub app's registered callback exactly; `request.url` behind the CDN is not the public origin,
  so this is pinned config, not derived).
- `[vars] TINKERPAD_CONTENT_ORIGIN` — `https://<content-host>` (a different host from the app).
- `routes` — bind both `<app-host>` and `<content-host>` to this Worker (uncomment the block).

## Migrate the commons

Production starts EMPTY and the first deploy runs generation DISABLED, so the briefs cannot be
re-driven at the edge. The seeded commons (the local `.tinkerpad-data/`) is carried into the edge
stores by a one-shot migration — this is the ONLY path to a populated production commons. It needs
only steps 1–3 above (R2 bucket + D1 created and migrated); it writes R2/D1 directly via `wrangler`,
independent of the Worker deploy, so it can run before or after `wrangler deploy`.

```sh
# Dry-run first — prints the plan (playgrounds + artifact versions), writes nothing:
pnpm migrate
# Then write to the real account:
pnpm migrate --remote
```

The migration is faithful by construction (it moves the exact catalog document into D1 row `id=1`
and each `<versionId>.html` artifact into R2, the same representations the edge adapters read) and
**idempotent** — the catalog is a single-row upsert and R2 puts are keyed by immutable version, so a
re-run converges to the same state and is safe to repeat after an interruption. The whole path is
verified end-to-end account-free with `--local` + `wrangler dev` (the app lists the migrated commons;
the content origin serves each artifact byte-identical to the local copy). To seed from a different
machine's data, point `TINKERPAD_DATA_DIR` at the exported dir; `TINKERPAD_D1_DATABASE` /
`TINKERPAD_R2_BUCKET` override the store names. Reversal of a botched run: `wrangler d1 execute
tinkerpad --remote --command "DELETE FROM catalog WHERE id = 1;"` (the unreferenced R2 objects are
harmless and overwritten by the next run).

## Deploy

```sh
pnpm build       # regenerate the committed front door (src/web/index.html) before bundling
pnpm typecheck && pnpm test
wrangler deploy
```

## What this first deploy does and does NOT do

- **Serves:** browse the commons, open a playground (raw html from R2 on the content origin),
  sign in with GitHub. Reads come from D1; artifact bytes from R2; sessions live in D1 (durable
  across cold starts).
- **Generation is DISABLED at the edge** — the Worker registers no provider, so the front door
  shows no generation UI and a hand-crafted `POST /generations` returns `unknown provider`. Public
  generation turns on later with the credits ledger + API driver (`tinkerpadai-providers-u1h`);
  the commons is seeded separately (`tinkerpadai-seeding-bw1.2`).

## Local verification (no account needed)

```sh
# dummy vars + a local D1/R2; the two origins are told apart by the Host header
printf 'GITHUB_CLIENT_ID=dev\nGITHUB_CLIENT_SECRET=dev\nTINKERPAD_OAUTH_CALLBACK_URL=http://localhost:8787/session/callback\nTINKERPAD_CONTENT_ORIGIN=http://content.localhost:8787\n' > .dev.vars
wrangler d1 migrations apply tinkerpad --local
wrangler dev --port 8787
# app host:      curl http://127.0.0.1:8787/api/playgrounds
# content host:  curl -H 'Host: content.localhost:8787' 'http://127.0.0.1:8787/?id=<playground-id>'
```

The router splits the two origins by the request's **host**, and `wrangler dev` binds only one
socket, so the content host is driven with an explicit `Host:` header rather than DNS — the header
sets `request.url`'s host to `content.localhost:8787`, which the router matches against
`TINKERPAD_CONTENT_ORIGIN`. No `/etc/hosts` entry or DNS setup is needed locally; the two hosts are
distinguished purely by name. In a real deploy the two hostnames are separate DNS records both
pointing at the Worker.

## Known limitation, stated not hidden

`makeD1Catalog` stores the whole catalog document as one row (the `CatalogStore` seam is
document-oriented), so a concurrent read-modify-write from two isolates could lose one edge write.
The first deploy runs generation disabled, so no app write reaches it — the durable edge path is
reads. Concurrent edge writes are unblocked by normalizing the catalog into per-playground rows
**behind the same seam**, when generation-at-the-edge lands.
