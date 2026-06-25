import type { ForkAttribution, ParentRef, PlaygroundId, PlaygroundSummary } from '../storage/index.js';
import { escapeHtml } from './escapeHtml.js';

// THE APP-ORIGIN "USE" PAGES, as pure string builders. Given already-read data they return
// html; they read no files, touch no catalog, bind no socket — the effects live in the
// handler that calls them. That purity is what makes them trivially testable: feed values,
// assert markup. [LAW:effects-at-boundaries] [LAW:dataflow-not-control-flow]
//
// These render TRUSTED chrome on the APP origin, so every value that came from outside
// (a prompt, an id) is escaped through the single enforcer. The playground's own html is
// NOT here — it is served raw on a foreign origin behind the sandbox (contentHandler).

// A playground id placed into an href: URL-encode for the query slot, then html-escape for
// the attribute. One value, both boundaries it crosses. [LAW:single-enforcer]
const playHref = (id: PlaygroundId): string => `/play?id=${escapeHtml(encodeURIComponent(id))}`;

// The fork-attribution label — the fork axis rendered as inline html. It is the SAME on every
// surface (a link to the parent where it still resolves, plain text once the parent has left),
// so it lives once; the surfaces below differ only in the wrapper they put around it. The
// parent's prompt is server data and crosses through the single enforcer, like every other
// outside value on this trusted origin. [LAW:single-enforcer] [LAW:one-source-of-truth]
const forkedFromLabel = (parent: ParentRef | null): string =>
  parent === null
    ? 'Forked from a playground no longer in the commons'
    : `Forked from <a href="${playHref(parent.id)}">${escapeHtml(parent.prompt)}</a>`;

// The author byline — "by <author>", the visible half of provenance (the fork label is the
// other half). It is the SAME on every surface, so it lives once; the author is server data and
// crosses the single enforcer like every other outside value on this trusted origin. Unlike the
// fork label, authorship is never absent — every playground has an author — so this is a total
// string, not a nullable fragment. [LAW:one-source-of-truth] [LAW:single-enforcer]
const byline = (author: PlaygroundSummary['author']): string => `by ${escapeHtml(author)}`;

// The step-count label — iteration depth as a pluralized phrase, shared by the commons row and
// the player's recipe block so "how many steps" reads identically wherever a playground appears.
// A pure count of the recipe; the plural suffix is a value, never a branch over whether markup
// renders. [LAW:one-source-of-truth] [LAW:dataflow-not-control-flow]
const stepLabel = (recipe: PlaygroundSummary['recipe']): string =>
  `${recipe.length} step${recipe.length === 1 ? '' : 's'}`;

// The recipe block (history layer A) — the ordered prompts that built this playground, the
// describe->refine story made visible. Collapsed by default so provenance enriches the chrome
// without crowding the live preview; the summary carries the step count. Every prompt is server
// data crossing the single enforcer, like every other outside value on this trusted origin. The
// non-empty recipe always lists at least the original describe, so the list is never an empty
// special case. [LAW:single-enforcer] [LAW:one-source-of-truth] [LAW:dataflow-not-control-flow]
const recipeBlock = (recipe: PlaygroundSummary['recipe']): string => {
  const steps = recipe.map((prompt) => `    <li>${escapeHtml(prompt)}</li>`).join('\n');
  return `<details class="recipe">
  <summary>Built in ${stepLabel(recipe)}</summary>
  <ol>
${steps}
  </ol>
</details>`;
};

// Per-surface attribution fragments: a non-fork is the empty string (a value, never a branch
// that skips markup), a fork is the shared label inside the surface's own element. The commons
// row carries it as a meta line; the player header as its own row. [LAW:dataflow-not-control-flow]
const commonsForkedFrom = (forkedFrom: ForkAttribution | null): string =>
  forkedFrom === null ? '' : `<div class="meta fork">↳ ${forkedFromLabel(forkedFrom.parent)}</div>`;
const playerForkedFrom = (forkedFrom: ForkAttribution | null): string =>
  forkedFrom === null ? '' : `<p class="forked-from">↳ ${forkedFromLabel(forkedFrom.parent)}</p>`;

const shell = (title: string, body: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; --bg:#0b0c10; --fg:#e8e8ea; --muted:#9aa0a6; --card:#16181d; --line:#272b33; --accent:#7c9cff; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui,sans-serif; background:var(--bg); color:var(--fg); }
  a { color:var(--accent); }
  .wrap { max-width:46rem; margin:0 auto; padding:2rem 1.25rem; }
  h1 { font-size:1.4rem; margin:0 0 0.25rem; }
  .lede { color:var(--muted); margin:0 0 1.5rem; }
  ul { list-style:none; margin:0; padding:0; display:grid; gap:0.75rem; }
  li { background:var(--card); border:1px solid var(--line); border-radius:0.6rem; padding:0.9rem 1rem; }
  li a { font-weight:600; text-decoration:none; }
  li a:hover { text-decoration:underline; }
  .meta { color:var(--muted); font-size:0.8rem; margin-top:0.3rem; }
  .meta.fork a { font-weight:600; }
  .empty { color:var(--muted); }
</style>
</head>
<body>
${body}
</body>
</html>
`;

// The commons listing — the product surface. An empty catalog is a value (an empty list),
// rendered as an empty state, never a thrown special case. [LAW:dataflow-not-control-flow]
export const renderCommons = (summaries: readonly PlaygroundSummary[]): string => {
  const items = summaries
    .map(
      (s) =>
        `  <li><a href="${playHref(s.id)}">${escapeHtml(s.prompt)}</a><div class="meta">${escapeHtml(
          s.providerId,
        )} · ${byline(s.author)} · ${stepLabel(s.recipe)}</div>${commonsForkedFrom(s.forkedFrom)}</li>`,
    )
    .join('\n');
  const list =
    summaries.length === 0
      ? `<p class="empty">No playgrounds yet. <a href="/">Describe one →</a></p>`
      : `<ul>\n${items}\n</ul>`;
  return shell(
    'The Commons — TinkerPad',
    `<div class="wrap">
  <h1>The Commons</h1>
  <p class="lede">Every playground anyone has made. Open one to tinker. <a href="/">Make your own →</a></p>
  ${list}
</div>`,
  );
};

// A plain notice page — for the read path's loud-but-friendly dead ends (unknown id,
// missing id). Both values are escaped; the page always offers a way back. [LAW:no-silent-failure]
export const renderNotice = (heading: string, message: string): string =>
  shell(
    `${heading} — TinkerPad`,
    `<div class="wrap">
  <h1>${escapeHtml(heading)}</h1>
  <p class="lede">${escapeHtml(message)}</p>
  <p><a href="/commons">← The Commons</a> · <a href="/">Make your own →</a></p>
</div>`,
  );

export interface PlayerView {
  readonly id: PlaygroundId;
  readonly prompt: string;
  // The iframe's src on the CONTENT origin (a foreign origin). The player page never holds
  // the playground html itself — it points the sandbox at where that html is served raw.
  readonly contentSrc: string;
  // The provider that owns this playground's session. Neither action box lets the user pick a
  // provider — continue and fork both resolve it from the session — so this is carried only to
  // gate the boxes on that one provider's live availability (and, for remix, its fork
  // capability), exactly as the front door gates submit on the selected provider. It rides
  // into the page as escaped data, never as JS. [LAW:decomposition]
  readonly providerId: PlaygroundSummary['providerId'];
  // The principal who made this playground, rendered as a "by <author>" byline in the chrome —
  // the SAME projected value the commons row carries, so attribution reads identically wherever a
  // playground appears. Escaped chrome (text), never interpolated into the client script.
  // [LAW:one-source-of-truth]
  readonly author: PlaygroundSummary['author'];
  // The fork-axis attribution — null when this playground is not a fork, else the parent it was
  // remixed from (linked where the parent still browses). The SAME projected value the commons
  // row carries, so attribution reads identically wherever a playground appears. It is rendered
  // as escaped chrome (a link/text), never interpolated into the client script. [LAW:one-source-of-truth]
  readonly forkedFrom: PlaygroundSummary['forkedFrom'];
  // The iteration recipe — the ordered prompts that built this playground (history layer A),
  // rendered as the "how this was built" block in the chrome. The SAME projected value the
  // commons row counts, so provenance reads consistently wherever a playground appears. Escaped
  // chrome (text), never interpolated into the client script. [LAW:one-source-of-truth]
  readonly recipe: PlaygroundSummary['recipe'];
}

// The player client, inlined into the player chrome. It wires TWO actions onto the SAME
// generation API the front door uses — refine (continue) and remix (fork) — each driven to a
// terminal state over the EXISTING poll loop. Both flows are ONE behavior (submit a turn, poll
// it to ready, act on the result) parameterized by VALUES: the endpoint, the request payload,
// the progress noun, the stand-down on an unsupported provider, and the terminal action. The
// poll loop and the JSON helpers live exactly once (runTurn/api) — refine and remix differ in
// data, never in a copied loop. [LAW:dataflow-not-control-flow] [LAW:one-source-of-truth]
//
// It is GATED entirely at runtime: the page itself is provider-agnostic (the read/use path
// stays provider-free), and this script reveals each box only after /providers proves
// generation is on. With an empty registry both boxes stay hidden and browse/use are untouched.
// Refine reloads in place on ready (currentVersionOf already serves the newest version); remix
// NAVIGATES to the new fork's own player, since fork yields an INDEPENDENT playground whose
// id is the poll's terminal value. Neither action ever re-asks for a provider — continue and
// fork resolve it from the session. [LAW:decomposition] [LAW:no-mode-explosion]
const PLAYER_SCRIPT = `
  const $ = (id) => document.getElementById(id);
  const actions = $('actions');
  const form = $('refine');
  const refineInput = $('refine-input');
  const refineBtn = $('refine-submit');
  const refineNote = $('refine-note');
  const remixBar = $('remix-bar');
  const remixBtn = $('remix-submit');
  const remixNote = $('remix-note');

  // The playground and its provider arrive as DATA on the form, escaped at render time and
  // read here as plain strings — never interpolated into this script, so a hostile id can
  // never become code. One source for both actions; remix reads the same values refine does.
  // [FRAMING:representation] [LAW:one-source-of-truth]
  const playgroundId = form.dataset.playgroundId;
  const providerId = form.dataset.providerId;

  // The one client-side HTML escaper for anything that becomes innerHTML in a note region,
  // mirroring the front door's single enforcer. Server strings (a failure message) pass
  // through this so "<img onerror=…>" renders as text, never an element. [LAW:single-enforcer]
  const esc = (value) =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

  // A note writer bound to one status element — refine and remix each get their own, so a
  // running turn's progress never overwrites the other control's message.
  const noteWriter = (el) => (html, kind) => {
    el.innerHTML = html;
    el.className = 'refine-note' + (kind ? ' ' + kind : '');
  };
  const setRefineNote = noteWriter(refineNote);
  const setRemixNote = noteWriter(remixNote);

  // The shared JSON+ok helper for the symmetric reads (/providers, /availability, /poll).
  // A turn's POST is handled inside runTurn instead, because its 201/422 must be read off the
  // status, not collapsed into a generic error. A body that does not parse is a real fault —
  // let it reject.
  const api = async (path, init) => {
    const res = await fetch(path, init);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? ('request failed (' + res.status + ')'));
    return body;
  };

  // The lifted turn runner — the single poll loop both actions share. It POSTs the turn,
  // then drives the returned handle to a terminal state over the EXISTING poll loop (no new
  // progress surface; the running poll blocks on the server, so this never spins). What
  // varies between refine and remix is passed as VALUES, never branched on:
  //   path/payload : which endpoint and body (continue carries a brief; fork carries none)
  //   noun         : the progress verb shown while polling
  //   onUnsupported: stand the action down when the provider can't perform this turn (422)
  //   onReady      : what to do with the terminal playgroundId (reload vs navigate)
  // [LAW:dataflow-not-control-flow] [LAW:composability]
  const runTurn = async (config) => {
    config.setNote('<span class="spin"></span>Submitting…', 'muted');
    const res = await fetch(config.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config.payload),
    });
    const body = await res.json();
    // 422 is the one client-actionable semantic case: this playground's provider can't perform
    // this turn (one-shot for continue, non-forkable for fork). Stand the action down with the
    // reason — not a crash. Every other non-201 is a loud failure carrying the server's message.
    if (res.status === 422) {
      config.onUnsupported(body.error);
      return;
    }
    if (res.status !== 201) throw new Error(body.error ?? ('request failed (' + res.status + ')'));

    const handle = body.handle;
    for (;;) {
      const status = await api('/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle }),
      });
      if (status.state === 'pending' || status.state === 'running') {
        config.setNote('<span class="spin"></span>' + config.noun + '… (' + esc(status.state) + ')', 'muted');
        continue;
      }
      if (status.state === 'ready') {
        config.onReady(status);
        return;
      }
      throw new Error(status.error);
    }
  };

  // Refine: a follow-up brief onto THIS playground. On ready the newest version is current, so
  // a reload re-frames it with no read-path change. [LAW:no-mode-explosion]
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const description = refineInput.value.trim();
    if (description === '') return;
    refineBtn.disabled = true;
    refineInput.disabled = true;
    try {
      await runTurn({
        path: '/generations/continue',
        payload: { playgroundId, brief: { description } },
        noun: 'Refining',
        setNote: setRefineNote,
        onUnsupported: (reason) => {
          refineBtn.disabled = true;
          refineInput.disabled = true;
          setRefineNote('Refine is unavailable for this playground: ' + esc(reason), 'bad');
        },
        onReady: () => {
          setRefineNote('<span class="good">Updated. Reloading…</span>', 'good');
          location.reload();
        },
      });
    } catch (error) {
      setRefineNote('<span class="bad">' + esc(error.message) + '</span>', 'bad');
      refineBtn.disabled = false;
      refineInput.disabled = false;
    }
  });

  // Remix: branch THIS playground into a NEW independent fork. fork carries no brief — the
  // service derives the new playground's first-turn prompt from the parent's original describe.
  // On ready the terminal playgroundId is the FORK's own id (distinct from this one), so we
  // navigate there: the user lands on the copy they now own. [LAW:one-source-of-truth]
  remixBtn.addEventListener('click', async () => {
    remixBtn.disabled = true;
    try {
      await runTurn({
        path: '/generations/fork',
        payload: { playgroundId },
        noun: 'Remixing',
        setNote: setRemixNote,
        onUnsupported: (reason) => {
          remixBtn.disabled = true;
          setRemixNote('Remix is unavailable for this playground: ' + esc(reason), 'bad');
        },
        onReady: (status) => {
          setRemixNote('<span class="good">Forked. Opening your copy…</span>', 'good');
          location.assign('/play?id=' + encodeURIComponent(status.playgroundId));
        },
      });
    } catch (error) {
      setRemixNote('<span class="bad">' + esc(error.message) + '</span>', 'bad');
      remixBtn.disabled = false;
    }
  });

  // Boot gate. /providers decides whether the action region exists at all: an empty registry
  // means generation is off, so it stays hidden and browse/use are untouched. When a provider
  // exists, reveal the region, then check THIS playground's provider's live availability ONCE
  // and gate both actions on it — the same two-level gate the front door uses, minus the picker.
  // Remix carries one extra gate: it is offered only when this provider can FORK (a static
  // capability read off the descriptor), so the 422 path stays unreachable from the happy path.
  // [LAW:no-silent-failure]
  (async () => {
    try {
      const providers = await api('/providers');
      if (providers.length === 0) return;
      actions.hidden = false;
      const availability = await api('/availability?providerId=' + encodeURIComponent(providerId));
      const ok = availability.state === 'available';

      refineBtn.disabled = !ok;
      refineInput.disabled = !ok;
      if (!ok) setRefineNote('Refine unavailable: ' + esc(availability.reason), 'bad');

      // Capability gate: only offer remix when this playground's provider implements fork.
      // A provider absent from the list (deregistered) is treated as not forkable — remix
      // stays hidden, never a dead live-looking button.
      const descriptor = providers.find((p) => p.id === providerId);
      const forkable = descriptor !== undefined && descriptor.capabilities.fork === true;
      if (forkable) {
        remixBar.hidden = false;
        remixBtn.disabled = !ok;
        if (!ok) setRemixNote('Remix unavailable: ' + esc(availability.reason), 'bad');
      }
    } catch (error) {
      // Generation could not be read (or this playground's provider is gone): leave the region
      // hidden if it never opened, or stand both actions down with a reason. Never a dead,
      // live-looking control. [LAW:no-silent-failure]
      refineBtn.disabled = true;
      refineInput.disabled = true;
      remixBtn.disabled = true;
      if (!actions.hidden) {
        setRefineNote('Refine unavailable: ' + esc(error.message), 'bad');
        if (!remixBar.hidden) setRemixNote('Remix unavailable: ' + esc(error.message), 'bad');
      }
    }
  })();
`;

// The player: trusted chrome (title from the original describe, a way back) wrapping ONE
// sandboxed iframe. The iframe is `allow-scripts` and DELIBERATELY NOT `allow-same-origin`,
// so the framed document gets a unique opaque origin with no access to the app's origin,
// cookies, storage, or DOM — and no top-navigation. That, plus the foreign content origin
// and its CSP (contentHandler), is the whole sandbox. The src is a URL value, not html, so
// nothing untrusted is interpolated into this trusted page. [LAW:single-enforcer]
export const renderPlayer = (view: PlayerView): string =>
  shell(
    `${view.prompt} — TinkerPad`,
    `<style>
  body { display:flex; flex-direction:column; height:100vh; }
  header { padding:0.6rem 1rem; border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:0.25rem 1rem; align-items:baseline; }
  header h1 { font-size:0.95rem; font-weight:600; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  header a { font-size:0.85rem; white-space:nowrap; }
  header .byline { font-size:0.85rem; color:var(--muted); white-space:nowrap; }
  .forked-from { flex-basis:100%; margin:0; font-size:0.8rem; color:var(--muted); }
  .forked-from a { font-weight:600; }
  .recipe { flex-basis:100%; margin:0; font-size:0.8rem; color:var(--muted); }
  .recipe summary { cursor:pointer; }
  .recipe ol { margin:0.4rem 0 0; padding-left:1.4rem; display:block; }
  .recipe li { background:none; border:0; border-radius:0; padding:0.1rem 0; }
  iframe { flex:1 1 auto; width:100%; border:0; background:#fff; }
  footer { border-top:1px solid var(--line); padding:0.6rem 1rem; display:flex; flex-direction:column; gap:0.5rem; }
  footer form { display:flex; gap:0.6rem; }
  footer input { flex:1 1 auto; background:#0f1218; color:var(--fg); border:1px solid var(--line); border-radius:0.5rem; padding:0.5rem 0.7rem; font:inherit; }
  footer button { background:var(--accent); color:#0b1020; border:0; border-radius:0.5rem; padding:0.5rem 1.1rem; font:inherit; font-weight:600; cursor:pointer; }
  footer button:disabled { opacity:0.45; cursor:not-allowed; }
  #remix-bar { display:flex; align-items:center; gap:0.6rem; }
  /* Remix is a DIFFERENT kind of action from refine (branch off vs change in place), so it
     reads as a secondary, outlined control rather than the primary accent button. */
  #remix-submit { background:transparent; color:var(--accent); border:1px solid var(--accent); }
  .refine-note { font-size:0.8rem; color:var(--muted); min-height:1.1em; }
  .refine-note.bad { color:#ff8a8a; }
  .refine-note.good { color:#7ee2a8; }
  .spin { display:inline-block; width:0.85em; height:0.85em; vertical-align:-1px; border:2px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:spin 0.8s linear infinite; margin-right:0.4rem; }
  @keyframes spin { to { transform:rotate(360deg); } }
</style>
<header>
  <a href="/commons">← Commons</a>
  <h1>${escapeHtml(view.prompt)}</h1>
  <span class="byline">${byline(view.author)}</span>
  ${playerForkedFrom(view.forkedFrom)}
  ${recipeBlock(view.recipe)}
</header>
<iframe
  title="${escapeHtml(view.prompt)}"
  src="${escapeHtml(view.contentSrc)}"
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
></iframe>
<footer id="actions" hidden>
  <div id="remix-bar" hidden>
    <button type="button" id="remix-submit">Remix this playground →</button>
    <div class="refine-note" id="remix-note" role="status" aria-live="polite"></div>
  </div>
  <form id="refine" data-playground-id="${escapeHtml(view.id)}" data-provider-id="${escapeHtml(view.providerId)}">
    <input id="refine-input" type="text" placeholder="Refine this playground — describe a change…" required />
    <button type="submit" id="refine-submit">Refine</button>
  </form>
  <div class="refine-note" id="refine-note" role="status" aria-live="polite"></div>
</footer>
<script type="module">${PLAYER_SCRIPT}</script>`,
  );
