# Preview thumbnails for the commons — design proposal

**Ticket:** `tinkerpadai-discovery-rye.3` · **Status:** direction decided 2026-07-08 (see "Decision" below) · blocked on `cloudflare-8le`.

## What the ticket asks

> Capture a preview image of each playground version (headless render at store time) so the
> commons grid shows what a playground looks like, not just its prompt. Acceptance: new
> playgrounds appear in the commons with a rendered thumbnail.

The intent is right — *a grid of prompts is a card catalog; a grid of previews is a shop
window.* The mechanism named in parentheses — **"headless render at store time"** — is the
part that needs rethinking, because taken literally it collides with two load-bearing
invariants of the project.

## The trap: server-side rendering of untrusted HTML is a second sandbox

TinkerPad's founding stance ([`PROJECT.md`](../PROJECT.md) §"Safety"): *"Treat every
playground as hostile code, because some will be,"* and *"Sandboxing and content rules are
enforced in a single place, not sprinkled per feature."*

Today untrusted playground HTML executes in exactly **one** place: a sandboxed, cross-origin
iframe at view time (`src/web/playgroundPages.ts:501`, served from the foreign content origin
under a strict CSP, `src/web/contentHandler.ts:24`). That single iframe is the enforcement
boundary the whole safety model rests on — `[LAW:single-enforcer]`.

"Headless render at store time" would stand up a **second** place where hostile code runs — a
browser process inside TinkerPad's *trusted* server context, executing the same untrusted
HTML with none of the iframe's isolation. That is precisely the duplication the invariant
forbids. It also violates `[LAW:effects-at-boundaries]`: it welds a heavyweight IO effect
(spawn a browser, execute arbitrary code) into the generation-success path, which today is a
clean single effect (`store.put` → `catalog.createPlayground`, `src/api/generationService.ts`).

**Platform reality reinforces the law.** The deploy target is Cloudflare Workers, and the code
is deliberately eval-free and portable for it (`src/api/deriveTags.ts:11`). **Headless Chrome
does not run on Workers.** A server-side Puppeteer isn't just risky — it can't ship to the
target platform at all.

So the difficulty here is not in the implementation body; it's that the *part* is cut wrong.
The real question is never "how do we screenshot on our server" — it is **"where is untrusted
code allowed to run, and how do we get pixels out of that one allowed place."**

## Reframe: a thumbnail is a *derived* representation, not a source of truth

A thumbnail is pixels *derived from* a specific immutable version's HTML. It is regenerable
from the artifact at any time; it never carries information the HTML doesn't. By
`[LAW:one-source-of-truth]`, that makes it a **cache keyed by `VersionId`**, never an
authoritative record.

This settles the storage sub-question before we even pick a renderer:

- **Reject:** a thumbnail field on `SessionRecord` / `PlaygroundSummary`
  (`src/storage/types.ts:112,179`). Those carry *authoritative, classify-once* facts (author,
  tags) that must never be re-derived. A thumbnail is the opposite — pure derivation of the
  artifact. Storing it there miscategorises it and bloats the single `CatalogDoc`.
- **Accept:** a derived blob **keyed by `VersionId`**, a sibling of the artifact under the
  existing `BlobStore` seam (`src/storage/artifactStore.ts:29`). Same key space as the `.html`
  it derives from, regenerable, evictable. On Workers this is an R2 object; locally a file
  next to the `.html`. Served from the content origin, never inlined into the catalog doc.

The version's immutability makes the cache trivially correct: a `VersionId` never changes its
bytes, so its thumbnail never goes stale — no invalidation logic, no `[LAW:one-source-of-truth]`
drift risk (the derived cache cannot disagree with a source that never changes).

## Producing the pixels — the actual fork (three options)

### Option A — No render: generative placeholder (already built)
The homepage already paints a **deterministic, id-derived gradient** as its card preview
(`previewGradient`, `src/web/index.html:1001`; the brand indigo→violet→cyan band). The server
commons card (`playgroundCard`, `src/web/playgroundPages.ts:90`) has *no* image slot yet.

Promote that gradient into the shared card so the commons gains a "shop window" band
immediately — zero untrusted-code execution, zero new dependency, Workers-native, and it
**unifies the two card surfaces into one shape** (`[LAW:one-source-of-truth]`).

*Honest limitation:* a gradient is a **placeholder, not a rendered preview**. It does not
satisfy the ticket's literal acceptance ("a rendered thumbnail"). It was considered as an
interim fallback — the Decision below **rejects** it: no placeholder ships, empty-until-rendered
is the honest state.

### Option B — Render in an isolated sandbox that is a *sibling* of the iframe
Render the untrusted HTML somewhere that is **itself an enforcement boundary**, never the app
server:
- **On the Workers target:** Cloudflare **Browser Rendering** (the Workers Puppeteer binding).
  A managed, isolated headless-Chrome sandbox — a sibling to the iframe, not a hole in it.
  Async, out of band from generation success.
- **On the homelab stage (before Workers):** a **separate hardened render service** (its own
  origin/container, no access to TinkerPad's data or origin), invoked async.

Store the PNG as the derived `VersionId`-keyed blob above. Critically, **decouple it from the
create path**: generation success must not wait on, or fail because of, a render
(`[LAW:no-ambient-temporal-coupling]`). Enqueue "render version X"; until the real thumbnail
exists the card's image slot stays empty. A missing thumbnail is an honest "not yet," never a
broken image or a blocked publish. (An earlier draft had this fall back to the Option-A
gradient; the Decision below rejects any placeholder interim — see there.)

*This is the only option that produces a true screenshot while respecting "untrusted code runs
isolated."* Cost: real infra that belongs to the unbuilt `cloudflare-8le` epic (Workers path)
or a new homelab service (`homelab-28m`).

### Option C — Client-side capture at view time — **rejected**
Tempting ("the iframe already runs it") but unworkable *because* the sandbox works:
- The player iframe is cross-origin and `sandbox="allow-scripts"` **without**
  `allow-same-origin` (deliberately, `src/web/playgroundPages.ts:472`). The parent **cannot
  read its pixels** — that opacity is the security guarantee, not a bug to route around.
- Injecting capture code *into* the untrusted HTML would corrupt the "generation's output is
  *just a file*, unmodified" seam and run our code in the hostile context. Non-starter.

## Workers-compat matrix

| Option | Untrusted code runs in… | New dep | Runs on Workers | True screenshot |
|---|---|---|---|---|
| A · gradient placeholder | *nowhere new* | none | ✅ native | ❌ placeholder |
| B · isolated render sandbox | managed/isolated sibling | Browser Rendering *or* a service | ✅ (Browser Rendering) | ✅ |
| B′ · **server-side Puppeteer** (ticket's literal ask) | **our trusted server** ❌ | Puppeteer/Playwright | ❌ **cannot** | ✅ |
| C · client capture | (can't read pixels) | none | ✅ | ❌ impossible |

## Decision (2026-07-08): do it right, no placeholder

The user rejected the placeholder-first phasing outright — *"I don't see any point to
implementing placeholders"* — and greenlit the real deploy. So rye.3's committed direction is
**Option B only**: true screenshots via an isolated render sandbox, with **no gradient-placeholder
interim**.

Concrete shape:

- **Renderer:** Cloudflare **Browser Rendering** (the Workers Puppeteer binding) — an isolated,
  managed headless-Chrome sandbox that is a *sibling* to the player iframe, never the app server.
  This makes rye.3 **downstream of `cloudflare-8le`** (the Workers deploy): the render capability
  is a property of the target platform, so the thumbnail feature cannot precede the deploy.
- **Trigger:** async, **out of the generation-create path** — enqueue "render version X" on
  publish; generation success never waits on or fails because of a render
  (`[LAW:no-ambient-temporal-coupling]`).
- **Store:** the PNG as a derived blob **keyed by `VersionId`** under the existing `BlobStore`
  seam (R2 on Workers), a sibling of the `.html` it derives from — regenerable, evictable, never a
  field on the catalog record (`[LAW:one-source-of-truth]`).
- **Render:** an image slot on the shared card (`playgroundCard`); until a version's thumbnail
  exists the slot shows an honest empty/neutral state, **not** a fabricated visual — a gradient
  shown *as if* it were the playground would be a representation that lies about what the
  playground looks like (`[FRAMING:representation]`).

**Backlog consequence:** rye.3 is blocked on `cloudflare-8le` and re-described to this shape; it
is no longer a standalone discovery-chrome ticket. The homelab render-service alternative is
dropped along with the homelab staging rehearsal (deploy goes straight to Cloudflare).
