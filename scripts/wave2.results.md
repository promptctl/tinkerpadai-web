# Wave 2 seeding results — scaling the commons to 100+

Ticket: `tinkerpadai-seeding-bw1.2` — "Scale to one hundred after first-wave fixes land".
Manifest: [`wave2.briefs.json`](./wave2.briefs.json) — 86 briefs, 14–15 per type across
all six PROJECT.md playground types, zero overlap with [`wave1.briefs.json`](./wave1.briefs.json).
Driven through the real loop with `just seed scripts/wave2.briefs.json 3` against a running
`just dev` (Node two-server dev entry, `claude-code-tmux` provider). Date: 2026-07-10.

## Generation success rate (the recorded acceptance metric)

Over the 86-brief manifest, **88 briefs reached generation** (the remaining were
quota-deferred, see below) and **85 became catalogued playgrounds**:

| Metric | Count |
| --- | --- |
| Briefs that reached generation | 88 |
| Catalogued as playgrounds (`ready`) | 85 |
| Rejected by the functional gate (built-but-broken) | 3 |
| Rejected by the self-containment gate | 0 |
| **Generation success rate** | **85 / 88 = 96.6%** |

All 3 failures were the ppu.3 functional gate correctly *rejecting* artifacts that
loaded with an uncaught JavaScript error (2× `data-explorer`, 1× `diff-review`) — they
were never silently catalogued. Zero artifacts tripped the ppu.1 self-containment gate:
every brief was phrased to be satisfiable with embedded data, canvas/SVG, and Web Audio,
so nothing referenced an external network resource.

## The run, in two passes

The wave was authored and driven in one manifest but completed in two passes because of a
per-user daily quota:

1. **Pass A** — 46/86 catalogued, then the run hit TinkerPad's own
   `TINKERPAD_MAX_DAILY_GENERATIONS` (default 50/day) abuse guard: 2 probe + 48 wave
   generations = 50, and every remaining submit returned `HTTP 429`. The quota is a
   per-user guard, not a Claude limit.
2. **Pass B** — the dev server was restarted with the documented operator override
   (`TINKERPAD_MAX_DAILY_GENERATIONS` raised) — the sanctioned way to tune the single
   quota enforcer for a legitimate commons-seeding run — and the exact 40 un-catalogued
   briefs were re-driven from a remaining-only manifest (never re-running the 46 successes,
   which would duplicate). 39/40 catalogued (the 1 failure was a functional-gate reject).

## Commons state

- Pre-wave: 32 playgrounds.
- Post-wave, post-curation: **116 listed playgrounds**, all six types represented
  (design, data-explorer, concept-map, document-critique, diff-review, code-map).

## Curation

The loop's own gates (self-containment + functional load) guarantee the whole population
loads and runs without uncaught errors and pulls no external dependency — so curation did
not re-check that class (the wave-1 throwaway grep + headless scan are now redundant).
Curation instead verified genuine quality: a representative sample across all six types was
loaded in a real browser and confirmed to honour the playground contract (controls + live
preview + copyable prompt) and match its brief. Three exact-duplicate playgrounds were
unlisted through the moderation route (`POST /admin/listing`): two probe artifacts whose
briefs coincided with real manifest entries, and one redundant pre-existing "tiny counter".

## Known deferred

- 3 briefs never became playgrounds (the functional-gate rejects). Not re-driven: the
  commons is well past 100 with strong per-type balance, so no coverage gap remains. A
  future wave could refine those three briefs if desired.
