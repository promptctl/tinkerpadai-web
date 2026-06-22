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
}

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
></iframe>`,
  );
