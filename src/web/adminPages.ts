import type { ReviewItem } from '../api/reviewService.js';
import type { Listing, PlaygroundId } from '../storage/index.js';
import { escapeHtml } from './escapeHtml.js';
import { renderPageShell, siteNav } from './pageShell.js';

// THE MODERATION CONSOLE — the admin-only review surface (moderation-5g7.2), as a pure string
// builder like the public pages: given the already-read review queue it returns html, reads no store
// and binds no socket — the effects live in the admin handler that calls it. It renders TRUSTED
// chrome on the APP origin, so every value that came from outside (a report's reason, a reporter id,
// a playground title/id) crosses the single escaping enforcer. The moderation ACTIONS are plain
// same-origin form POSTs — no client JS — so the console works like the commons search: a button is a
// real form submit that redirects back, never a dead live-looking control. [LAW:effects-at-boundaries]
// [LAW:single-enforcer] [LAW:no-silent-failure]

// The playground-id link into the player, so a reviewer can open a still-listed playground to judge
// it. (An already-unlisted one shows the "removed" notice there — the reviewer relists to inspect.)
// The id crosses TWO boundaries here, the same idiom playgroundPages.playHref documents: URL-encode
// for the query slot, then html-escape for the attribute. So the escapeHtml is not redundant with the
// encodeURIComponent — it is the one attribute-boundary enforcer applied to EVERY value entering an
// attribute (the same one actionForm applies to the id in its hidden input, which needs no
// URL-encoding because there the id is a plain value, not a URL). [LAW:single-enforcer]
const playHref = (id: PlaygroundId): string => `/play?id=${escapeHtml(encodeURIComponent(id))}`;

// The visibility badge — the current listing rendered as a labelled pill, so the reviewer sees at a
// glance whether an item is already actioned. The state is a value that selects the label and class,
// never a branch that skips markup. [LAW:dataflow-not-control-flow]
const listingBadge = (listing: Listing): string =>
  `<span class="badge badge-${listing}">${listing === 'unlisted' ? 'Unlisted' : 'Listed'}</span>`;

// The one moderation action, as a same-origin form: a single button whose submitted `listing` value
// is the OPPOSITE of the current state — a listed item offers "Unlist", an unlisted one "Relist". The
// target state is a value on the button, so unlist and relist are one form parameterized by data, not
// two code paths. The playground id rides as a hidden field, escaped into the attribute like every
// outside value. POST → the handler flips the state and 303-redirects back here (post-redirect-get),
// so a refresh never re-submits. [LAW:dataflow-not-control-flow] [LAW:single-enforcer]
const actionForm = (id: PlaygroundId, listing: Listing): string => {
  const next: Listing = listing === 'unlisted' ? 'listed' : 'unlisted';
  const label = next === 'unlisted' ? 'Unlist' : 'Relist';
  return `<form class="admin-action" method="post" action="/admin/listing">
    <input type="hidden" name="playgroundId" value="${escapeHtml(id)}" />
    <button type="submit" name="listing" value="${next}" class="action-${next}">${label}</button>
  </form>`;
};

// One reported report, rendered for the reviewer: the reason (why it was flagged), who raised it, and
// when. All three are escaped — the reason is user free text, the reporter and timestamp are
// server-minted but still cross the enforcer as defense in depth on this trusted origin.
// [LAW:single-enforcer]
const reportLine = (reason: string, reporter: string, at: string): string =>
  `<li class="report-line">
    <p class="report-reason">${escapeHtml(reason)}</p>
    <p class="report-meta">${escapeHtml(reporter)} · <time>${escapeHtml(at)}</time></p>
  </li>`;

// One reported playground as a review card: title (linked to the player), its current visibility, the
// toggle action, and every report against it. The report count is a pluralized value, not a branch.
const reviewCard = (item: ReviewItem): string => {
  const reports = item.reports.map((r) => reportLine(r.reason, r.reporter, r.at)).join('\n');
  const count = item.reports.length;
  return `  <article class="card review-card">
    <div class="review-head">
      <a class="card-title" href="${playHref(item.id)}">${escapeHtml(item.title)}</a>
      <div class="review-controls">${listingBadge(item.listing)}${actionForm(item.id, item.listing)}</div>
    </div>
    <div class="card-meta">${count} ${count === 1 ? 'report' : 'reports'}</div>
    <ul class="report-list">
${reports}
    </ul>
  </article>`;
};

// The "act on any playground by id" form — for takedowns that arrive OUTSIDE the report queue: a
// /copyright or /terms notice by email names a playground that may have no user report. It hits the
// SAME POST /admin/listing action with an explicit target state chosen on the clicked button, so the
// email-takedown path and the report-queue path converge on one enforcer, never a second channel.
// [LAW:single-enforcer]
const byIdForm = (): string => `<form class="admin-byid" method="post" action="/admin/listing">
  <label for="byid-input">Act on a playground by id</label>
  <div class="byid-row">
    <input id="byid-input" type="text" name="playgroundId" required placeholder="playground id (from a takedown notice)" />
    <button type="submit" name="listing" value="unlisted" class="action-unlisted">Unlist</button>
    <button type="submit" name="listing" value="listed" class="action-listed">Relist</button>
  </div>
</form>`;

// The moderation console page: the shared nav, the by-id takedown form, and the report queue as
// review cards. An empty queue is a value (a friendly empty state), never a crash. [LAW:dataflow-not-control-flow]
export const renderReviewQueue = (items: readonly ReviewItem[]): string => {
  const queue =
    items.length === 0
      ? `<div class="empty">No reports yet. Playgrounds flagged from the player will appear here.</div>`
      : `<div class="review-grid">\n${items.map(reviewCard).join('\n')}\n</div>`;
  return renderPageShell(
    'Moderation — TinkerPad',
    'The moderation review queue: reported playgrounds and takedown controls.',
    `${siteNav()}
<main class="container">
  <div class="page-head">
    <h1>Moderation</h1>
    <p class="lede">Reported playgrounds, newest-reported last. Unlist takes a playground down from the commons; relist puts it back.</p>
  </div>
  ${byIdForm()}
  ${queue}
</main>`,
    ADMIN_STYLES,
  );
};

// The console-only styling, passed as the page's head CSS — kept off the shared shell because these
// controls live only on this surface. It reads only shared design tokens, so the console tracks
// light/dark like every page and the action buttons echo the product's control language; the unlist
// action reuses the "bad" token as a destructive affordance, relist the "good" one. [LAW:one-source-of-truth]
const ADMIN_STYLES = `<style>
  .admin-byid { margin-bottom: 2rem; max-width: 640px; }
  .admin-byid label { display: block; font-size: 0.85rem; font-weight: 500; color: var(--muted); margin-bottom: 0.4rem; }
  .byid-row { display: flex; gap: 0.6rem; flex-wrap: wrap; }
  .byid-row input {
    flex: 1 1 240px; background: var(--input-bg); color: var(--text);
    border: 1px solid var(--border); border-radius: var(--radius-md);
    padding: 0.55rem 0.9rem; font: inherit; outline: none;
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }
  .byid-row input:focus { border-color: var(--accent-light); box-shadow: var(--focus-ring); background: var(--input-focus-bg); }

  .review-grid { display: flex; flex-direction: column; gap: 1.1rem; }
  .review-card { display: block; }
  .review-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .review-controls { display: flex; align-items: center; gap: 0.6rem; flex-shrink: 0; }

  .badge { font-size: 0.72rem; font-weight: 600; border-radius: 100px; padding: 0.15rem 0.6rem; line-height: 1.5; }
  .badge-listed { color: var(--good); background: var(--step-icon-bg); border: 1px solid var(--step-icon-border); }
  .badge-unlisted { color: var(--bad); background: var(--surface); border: 1px solid var(--border-2); }

  .admin-action { margin: 0; }
  .admin-action button, .byid-row button {
    border-radius: 8px; padding: 0.45rem 1rem; font: 600 0.85rem inherit; cursor: pointer;
    border: 1px solid transparent; transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .action-unlisted { background: transparent; color: var(--bad); border-color: var(--bad); }
  .action-unlisted:hover { background: var(--bad); color: #fff; }
  .action-listed { background: transparent; color: var(--good); border-color: var(--good); }
  .action-listed:hover { background: var(--good); color: #fff; }

  .report-list { list-style: none; margin: 0.8rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .report-line { border-top: 1px solid var(--border); padding-top: 0.6rem; }
  .report-reason { color: var(--text-2); font-size: 0.9rem; margin: 0; white-space: pre-wrap; word-break: break-word; }
  .report-meta { color: var(--muted); font-size: 0.78rem; margin: 0.25rem 0 0; }
  .report-meta time { font-variant-numeric: tabular-nums; }
</style>`;
