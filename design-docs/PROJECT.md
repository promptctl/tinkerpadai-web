# TinkerPad — Founding Document

*Read this before you build anything. This is guidance, not a spec. It exists so
that anyone — human or agent — who opens this repo builds the **right thing in the
right spirit.** When a detail here conflicts with the spirit, the spirit wins.*

---

## What TinkerPad is

There is a thing called a **playground**: a self-contained HTML file with
interactive controls on one side, a live preview on the other, and a copyable,
natural-language prompt at the bottom. You adjust the controls, explore something
visually, and walk away with a prompt (or just understanding). It's a thinking
tool for things that are easier to *fiddle with* than to type.

Today, you make one by asking an agent to generate it, and it lives on your disk.

**TinkerPad makes that public.** It is a website where:

1. Anyone can **spin up a playground at will** — describe what you want to tinker
   with, and it gets generated for you.
2. Every playground a user generates is **stored and accessible to everyone
   else.**

That's the whole idea. A one-box way to make a playground, and a growing public
**commons** of every playground anyone has ever made — browsable, usable,
remixable by all.

**The atomic primitive is a playground: one self-contained HTML file.** Everything
in this document orbits that artifact and the two pillars above — *frictionless
creation* and *the commons.*

---

## The two pillars

**Spin up at will.** Creation has to be effortless. You type what you want to
explore into a box; you get a working playground. No coding required, no setup, no
blank canvas to stare at. If making a playground feels like work, we've failed the
first pillar.

**The commons.** Every generated playground is public by default and accessible to
all users. The library *is* the product — its value compounds with every
playground added and every way we make them discoverable. One person's idle
tinkering becomes everyone's tool. The commons is the single source of truth for
what exists on TinkerPad.

---

## Self-containment is sacred

This is the load-bearing structural fact, and everything good flows from it:

**A playground is one self-contained HTML file. Inline CSS and JS. No external
dependencies. No backend. It runs anywhere, by itself.**

(This is already the contract of the playground artifact — see the `playground`
skill that generates them. TinkerPad productizes that contract; it does not
loosen it.)

Why this is non-negotiable:
- **The commons is cheap.** Storing and serving a playground is storing and
  serving a static file. No per-playground runtime, no build, no infra that scales
  with the catalog.
- **It's portable and forkable.** A self-contained file can be downloaded, copied,
  remixed, and run by anyone, forever.
- **It can be sandboxed cleanly** (see Safety) precisely because it asks nothing of
  the outside world.

The moment a playground needs a server, a shared runtime, or a live API key to
function, the model is broken. If a use case seems to need that, it's a sign the
boundary is in the wrong place — push the dependency out, or it doesn't belong as a
playground.

The platform itself is therefore small: **a generation step, a place to keep
static artifacts, and a way to find them.**

---

## The core loop

**describe → generate → store → discover → use → remix**

- **Describe** — a box. Say what you want to tinker with.
- **Generate** — an agent (Claude, via the `playground` skill) turns the
  description into a self-contained playground. This is the one "magic" step and
  the one real cost center. Keep it isolated: its output is just a file.
- **Store** — the file lands in the public commons with its generating prompt and
  metadata.
- **Discover** — browse, search, by type, trending, collections.
- **Use** — run it, sandboxed.
- **Remix** — fork any playground: tweak its prompt and regenerate, or edit the
  HTML directly. Lineage and attribution are kept.

---

## Safety is not optional, and it is designed in from day one

TinkerPad runs **arbitrary, user-generated HTML and JavaScript in other people's
browsers.** That is the central risk, and it is the equivalent of CrowdShip's
content policy: build it in from the start, never bolt it on after an incident.

- **Every playground runs sandboxed.** A sandboxed iframe with a strict CSP, with
  no access to TinkerPad's origin, cookies, storage, or the viewer's session.
  Treat every playground as hostile code, because some will be.
- **One enforcement boundary.** Sandboxing and content rules are enforced in a
  single place, not sprinkled per feature.
- Self-containment (above) is what makes this clean: a file that needs nothing
  external is a file you can wall off completely.

Content moderation (abuse, malicious prompts, NSFW, illegal) is a separate concern
from execution sandboxing, and also needs a home — but the sandbox is what keeps a
bad playground from being *dangerous* while moderation catches what's merely
*unwanted.*

---

## What TinkerPad is NOT

- **Not CodePen / Replit.** Those are blank editors where you write code. TinkerPad
  is *generative* (you describe; it builds) and *topic-focused* (a playground
  explores one thing) and requires no coding to create.
- **Not a general web host or app platform.** It hosts self-contained playgrounds,
  not arbitrary apps with backends.
- **Not private-by-default.** The commons is the point. (Private playgrounds may
  someday be a paid exception — but the default is public.)
- **Not dependent on any external runtime.** A playground that needs a live API to
  work is not a TinkerPad playground.

---

## Principles for whoever builds this

- **Self-containment is sacred.** Never let a playground require a backend or an
  external dependency. This is the rule the whole model rests on.
- **The commons first.** Public and shareable by default; discovery is a feature,
  not an afterthought.
- **Sandbox everything.** Every playground is untrusted code and runs isolated.
- **Generation is one isolated step.** The agent makes a file; the rest of the
  system just stores and serves files.
- **Keep creation frictionless.** A box and a result. The instant making a
  playground feels like work, stop and fix it.
- **Remix is a right.** Every playground is forkable, with lineage preserved.

---

## Decisions made

- **Who pays for generation → a credit system.** *(decided 2026-07-08)* Every account
  gets a free allotment of generations; beyond it, users buy or earn credits. The
  public commons — browse, use, remix of existing self-contained files — stays free
  and open, because serving static playgrounds costs almost nothing; the credit meter
  applies only to *generation*, the one expensive step. This was chosen over
  platform-pays (unbounded cost/abuse exposure at public scale) and bring-your-own-key
  (which breaks frictionless creation — the load-bearing pillar — since most visitors
  have no API key). A credit balance presumes a persistent account to hold it, and that
  already exists — authentication is real GitHub OAuth (the session carries identity; every
  playground has an author). So the credit model resolves the *creation* half of the still-open
  "accounts vs. anonymous" decision: **generating requires signing in**, while browsing/using/
  remixing the commons stays open to anonymous visitors. Consequences that now follow: the API
  provider driver debits credits per generation, rate-limit semantics are expressed in credits
  rather than raw request caps, and the accounts surface must carry a credit balance.
  The first public deploy ships with generation disabled/tunneled at the edge (browse/
  use/remix only); public generation turns on once the API driver and the credit ledger
  exist. (This does not contradict the Status section's "verified end-to-end": the loop is
  code-complete and verified in *dev*; gating generation at the public edge is a
  launch-safety and economics choice, not an incompleteness — it stays off in production
  only until the credit meter that governs its cost is built.)

---

## Open decisions (not yet made)

- **Accounts vs. anonymous** creation, and how attribution/lineage is tracked.
- **Monetization, if any.** Free commons as the default; possible paid edges
  (private playgrounds, pro generation limits, teams) — or it stays a loss-leader /
  showcase. Undecided on purpose.
- **Editing model.** Regenerate-from-prompt only, direct HTML editing, or both.
- **Discovery surface.** Tags, the playground *types* (design / data-explorer /
  concept-map / document-critique / diff-review / code-map), trending, curated
  collections — which of these exist at launch.
- **Relationship to CrowdShip.** Latent synergy (a builder could spin up a
  TinkerPad to explore an idea live), but treat TinkerPad as standalone for now.

---

## Status

Building. The core loop — describe → generate → store → discover → use → remix —
is implemented and verified end-to-end; `design-docs/2YEARPLAN.mnd` carries the
roadmap narrative and the lit backlog holds the live queue, so status detail
lives there, not here. The `playground` skill defines the
artifact contract (self-contained HTML, controls + live preview + copyable prompt);
TinkerPad is the public commons and frictionless front door around that artifact.
This document is the source of truth for *intent* — build toward it, and update it
when intent changes; never let it drift from what we're actually building.
