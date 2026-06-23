import type { PlaygroundId, PlaygroundSummary } from '../storage/index.js';
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
        )}</div></li>`,
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
  // The provider that owns this playground's session. The refine box does NOT let the user
  // pick a provider — continue resolves it from the session — so this is carried only to gate
  // the box on that one provider's live availability, exactly as the front door gates submit
  // on the selected provider. It rides into the page as escaped data, never as JS. [LAW:decomposition]
  readonly providerId: PlaygroundSummary['providerId'];
}

// The refine client, inlined into the player chrome. It drives the SAME generation API the
// front door does (continue + the existing poll loop) and renders from what it reads, so the
// box's every visible state is a server value, not an assumption. It is GATED entirely at
// runtime: the page itself is provider-agnostic (the read/use path stays provider-free), and
// this script reveals the box only after /providers proves generation is on. With an empty
// registry the box stays hidden and browse/use are untouched. [LAW:decomposition]
//
// On ready it reloads the page: currentVersionOf already serves the newest version, so a plain
// reload re-frames the refined playground with no read-path change. A follow-up never re-asks
// for a provider — continue resolves it from the playground's session. [LAW:no-mode-explosion]
const REFINE_SCRIPT = `
  const $ = (id) => document.getElementById(id);
  const bar = $('refine-bar');
  const form = $('refine');
  const input = $('refine-input');
  const submitBtn = $('refine-submit');
  const note = $('refine-note');

  // The playground and its provider arrive as DATA on the form, escaped at render time and
  // read here as plain strings — never interpolated into this script, so a hostile id can
  // never become code. [FRAMING:representation]
  const playgroundId = form.dataset.playgroundId;
  const providerId = form.dataset.providerId;

  // The one client-side HTML escaper for anything that becomes innerHTML in the note region,
  // mirroring the front door's single enforcer. Server strings (a failure message) pass
  // through this so "<img onerror=…>" renders as text, never an element.
  const esc = (value) =>
    String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

  const setNote = (html, kind) => {
    note.innerHTML = html;
    note.className = 'refine-note' + (kind ? ' ' + kind : '');
  };

  // The shared JSON+ok helper for the symmetric calls (/providers, /availability, /poll).
  // The continue POST is handled separately because its 422 must be read off the status, not
  // collapsed into a generic error. A body that does not parse is a real fault — let it reject.
  const api = async (path, init) => {
    const res = await fetch(path, init);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? ('request failed (' + res.status + ')'));
    return body;
  };

  // Drive the follow-up turn to a terminal state over the EXISTING poll loop — no new progress
  // surface. The running poll blocks on the server, so this never spins.
  const refine = async (description) => {
    setNote('<span class="spin"></span>Submitting…', 'muted');
    const res = await fetch('/generations/continue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playgroundId, brief: { description } }),
    });
    const body = await res.json();
    // 422 is the one client-actionable semantic case: this playground's provider is one-shot
    // and cannot iterate. Surface it as an unavailable state and stand the box down — not a
    // crash. Every other non-201 is a loud failure carrying the server's message.
    if (res.status === 422) {
      submitBtn.disabled = true;
      input.disabled = true;
      setNote('Refine is unavailable for this playground: ' + esc(body.error), 'bad');
      return;
    }
    if (res.status !== 201) throw new Error(body.error ?? ('refine failed (' + res.status + ')'));

    const handle = body.handle;
    for (;;) {
      const status = await api('/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle }),
      });
      if (status.state === 'pending' || status.state === 'running') {
        setNote('<span class="spin"></span>Refining… (' + esc(status.state) + ')', 'muted');
        continue;
      }
      if (status.state === 'ready') {
        // The newest version is now current; a reload re-frames it. No read-path change.
        setNote('<span class="good">Updated. Reloading…</span>', 'good');
        location.reload();
        return;
      }
      throw new Error(status.error);
    }
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const description = input.value.trim();
    if (description === '') return;
    submitBtn.disabled = true;
    input.disabled = true;
    try {
      await refine(description);
    } catch (error) {
      setNote('<span class="bad">' + esc(error.message) + '</span>', 'bad');
      submitBtn.disabled = false;
      input.disabled = false;
    }
  });

  // Boot gate. /providers decides whether the box exists at all: an empty registry means
  // generation is off, so the box stays hidden and browse/use are untouched. When a provider
  // exists, reveal the box, then check THIS playground's provider's live availability and gate
  // submit on it — the same two-level gate the front door uses, minus the provider picker.
  (async () => {
    try {
      const providers = await api('/providers');
      if (providers.length === 0) return;
      bar.hidden = false;
      const availability = await api('/availability?providerId=' + encodeURIComponent(providerId));
      const ok = availability.state === 'available';
      submitBtn.disabled = !ok;
      input.disabled = !ok;
      if (!ok) setNote('Refine unavailable: ' + esc(availability.reason), 'bad');
    } catch (error) {
      // Generation could not be read (or this playground's provider is gone): leave the box
      // hidden if it never opened, or stand it down with a reason. Never a dead, live-looking
      // control. [LAW:no-silent-failure]
      submitBtn.disabled = true;
      input.disabled = true;
      if (!bar.hidden) setNote('Refine unavailable: ' + esc(error.message), 'bad');
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
  header { padding:0.6rem 1rem; border-bottom:1px solid var(--line); display:flex; gap:1rem; align-items:baseline; }
  header h1 { font-size:0.95rem; font-weight:600; margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  header a { font-size:0.85rem; white-space:nowrap; }
  iframe { flex:1 1 auto; width:100%; border:0; background:#fff; }
  footer { border-top:1px solid var(--line); padding:0.6rem 1rem; display:flex; flex-direction:column; gap:0.4rem; }
  footer form { display:flex; gap:0.6rem; }
  footer input { flex:1 1 auto; background:#0f1218; color:var(--fg); border:1px solid var(--line); border-radius:0.5rem; padding:0.5rem 0.7rem; font:inherit; }
  footer button { background:var(--accent); color:#0b1020; border:0; border-radius:0.5rem; padding:0.5rem 1.1rem; font:inherit; font-weight:600; cursor:pointer; }
  footer button:disabled { opacity:0.45; cursor:not-allowed; }
  .refine-note { font-size:0.8rem; color:var(--muted); min-height:1.1em; }
  .refine-note.bad { color:#ff8a8a; }
  .refine-note.good { color:#7ee2a8; }
  .spin { display:inline-block; width:0.85em; height:0.85em; vertical-align:-1px; border:2px solid var(--line); border-top-color:var(--accent); border-radius:50%; animation:spin 0.8s linear infinite; margin-right:0.4rem; }
  @keyframes spin { to { transform:rotate(360deg); } }
</style>
<header>
  <a href="/commons">← Commons</a>
  <h1>${escapeHtml(view.prompt)}</h1>
</header>
<iframe
  title="${escapeHtml(view.prompt)}"
  src="${escapeHtml(view.contentSrc)}"
  sandbox="allow-scripts"
  referrerpolicy="no-referrer"
></iframe>
<footer id="refine-bar" hidden>
  <form id="refine" data-playground-id="${escapeHtml(view.id)}" data-provider-id="${escapeHtml(view.providerId)}">
    <input id="refine-input" type="text" placeholder="Refine this playground — describe a change…" required />
    <button type="submit" id="refine-submit">Refine</button>
  </form>
  <div class="refine-note" id="refine-note" role="status" aria-live="polite"></div>
</footer>
<script type="module">${REFINE_SCRIPT}</script>`,
  );
