import { escapeHtml } from './escapeHtml.js';
import { renderPageShell, siteFooter, siteNav } from './pageShell.js';

// THE LEGAL SURFACE — the "ground rules" and "privacy" pages, as pure string builders, a sibling
// of playgroundPages: given a doc value they return html, reading no files and touching no catalog.
// [LAW:effects-at-boundaries]
//
// A legal page and a privacy page have IDENTICAL behaviour — a titled document of headed prose
// sections rendered in the site shell. So there is ONE renderer and the two pages are DATA
// (GROUND_RULES_DOC, PRIVACY_DOC), not two renderers that can drift. [LAW:one-type-per-behavior]
//
// TRUST CONTRACT: a LegalDoc's text is AUTHORED here as constants — no outside value ever enters
// these pages — so block text is trusted markup, injected verbatim exactly like siteNav/siteFooter,
// which is what lets a paragraph carry an authored <a>/<strong>. Headings pass through escapeHtml so
// the idiom matches the rest of the layer and stays safe if a heading ever gains a metacharacter. If
// any part of a doc ever came to hold an OUTSIDE value, that value must cross escapeHtml at the point
// it enters, same single-enforcer contract as every other app-origin page. [LAW:single-enforcer]

// The one contact address, referenced by both docs — a single source of truth, so changing where
// removal/privacy requests land is a one-line edit. A real role mailbox on the production domain.
// [LAW:one-source-of-truth]
export const CONTACT_EMAIL = 'hello@tinkerpad.ai';

const contactLink = `<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`;

// A block of a section's body: a paragraph or a bullet list. A discriminated union folded by
// exhaustive match, so "does this section have a list" is a value, never a branch that can forget a
// case. [LAW:types-are-the-program] [LAW:dataflow-not-control-flow]
type Block = { readonly kind: 'p'; readonly text: string } | { readonly kind: 'ul'; readonly items: readonly string[] };

interface LegalSection {
  readonly heading: string;
  readonly blocks: readonly Block[];
}

interface LegalDoc {
  readonly title: string;
  // The meta description AND the page's first impression — required, like every server page's.
  readonly description: string;
  // The "last updated" line — content of a legal doc, set when the doc's text last changed.
  readonly updated: string;
  readonly sections: readonly LegalSection[];
}

const renderBlock = (block: Block): string => {
  switch (block.kind) {
    case 'p':
      return `<p>${block.text}</p>`;
    case 'ul':
      return `<ul>\n${block.items.map((item) => `  <li>${item}</li>`).join('\n')}\n</ul>`;
  }
};

const renderSection = (section: LegalSection): string =>
  `<section>
<h2>${escapeHtml(section.heading)}</h2>
${section.blocks.map(renderBlock).join('\n')}
</section>`;

export const renderLegalDoc = (doc: LegalDoc): string =>
  renderPageShell(
    `${doc.title} — TinkerPad`,
    doc.description,
    `${siteNav()}
<main class="container legal">
  <div class="page-head">
    <h1>${escapeHtml(doc.title)}</h1>
    <p class="lede">${escapeHtml(doc.updated)}</p>
  </div>
  ${doc.sections.map(renderSection).join('\n')}
</main>
${siteFooter()}`,
  );

// THE GROUND RULES — not a "terms of service" contract. There is no operating entity, no contract,
// and no jurisdiction to assert, so this page tells that truth in plain language rather than
// fabricating a contract that does not exist. [FRAMING:representation] Ownership/licensing collapses
// (AI-generated work is generally not copyrightable, so nobody owns a playground); what remains is
// conduct, safety, and a liability disclaimer that protects the anonymous operator. [LAW:decomposition]
export const GROUND_RULES_DOC: LegalDoc = {
  title: 'Ground rules',
  description:
    'How TinkerPad works and the few ground rules for using it — no company, no contract, just a public commons.',
  updated: 'Last updated 9 July 2026',
  sections: [
    {
      heading: 'There are no formal terms',
      blocks: [
        {
          kind: 'p',
          text: "TinkerPad has no terms of service in the usual sense. There's no company behind it, and there's no contract you're agreeing to — it's just a website people use to make and share playgrounds. What follows is how it works and a few ground rules, in plain language.",
        },
      ],
    },
    {
      heading: 'Everything you make is public',
      blocks: [
        {
          kind: 'p',
          text: "Every playground you create on the free tier is public, automatically. There's no privacy toggle and no way to keep a free playground to yourself — the public commons is the entire point of TinkerPad.",
        },
        {
          kind: 'p',
          text: "If you don't want something to be public, don't make it here. (Keeping playgrounds private may be offered later as a paid feature.)",
        },
      ],
    },
    {
      heading: 'Nobody owns the playgrounds',
      blocks: [
        {
          kind: 'p',
          text: "Playgrounds are generated by AI from a prompt. Work generated by AI generally isn't owned by anyone — not by you, and not by TinkerPad. So treat every playground in the commons as shared: anyone can open, copy, remix, and build on anything here, and so can you.",
        },
        {
          kind: 'p',
          text: 'When you remix a playground, TinkerPad keeps the lineage so the chain of ideas stays visible. That is provenance and courtesy, not a legal claim.',
        },
      ],
    },
    {
      heading: 'The ground rules',
      blocks: [
        { kind: 'p', text: 'TinkerPad is provided as-is, with no warranties of any kind.' },
        {
          kind: 'p',
          text: 'Playgrounds are made by other people and by AI, and they run as live code in your browser. We sandbox them, but you still run them at your own risk — never type passwords, secrets, or sensitive information into a playground.',
        },
        {
          kind: 'p',
          text: "Don't create or upload anything illegal, infringing, or built to harm or deceive other people.",
        },
        {
          kind: 'p',
          text: "We can remove any playground and block anyone, at any time, for any reason. TinkerPad isn't responsible for what user-made playgrounds do.",
        },
      ],
    },
    {
      heading: 'Reporting something',
      blocks: [
        {
          kind: 'p',
          text: `Found a playground that's harmful, illegal, or shouldn't be here? Email ${contactLink}. We review reports and take down anything that breaks the ground rules.`,
        },
      ],
    },
    {
      heading: 'Contact',
      blocks: [{ kind: 'p', text: `Questions or requests: ${contactLink}.` }],
    },
  ],
};

// THE PRIVACY POLICY — this one is real regardless of the "no terms" stance: disclosure duties
// attach by law the moment personal data is collected, not by any contract. Every claim below is
// grounded in what the code actually does (GitHub OAuth identity, one session cookie, public
// prompts/playgrounds, a theme preference in localStorage) rather than boilerplate. [FRAMING:representation]
export const PRIVACY_DOC: LegalDoc = {
  title: 'Privacy',
  description: 'What TinkerPad collects, why, and your choices. The short version: as little as possible.',
  updated: 'Last updated 9 July 2026',
  sections: [
    {
      heading: 'The short version',
      blocks: [
        {
          kind: 'p',
          text: 'TinkerPad collects as little as it can. You can browse, open, and remix the public commons without an account or signing in. You only sign in when you want to generate a new playground.',
        },
      ],
    },
    {
      heading: 'What we collect',
      blocks: [
        {
          kind: 'ul',
          items: [
            '<strong>Your GitHub identity, if you sign in.</strong> Signing in uses GitHub. We receive your GitHub username, account id, and avatar — enough to sign you in and attribute the playgrounds you make. We never receive your GitHub password, and we don’t post anything to GitHub on your behalf.',
            '<strong>The playgrounds and prompts you create.</strong> These are stored in the public commons along with your username as the author. They are public by design — see the <a href="/terms">ground rules</a>.',
            '<strong>Basic request information.</strong> Like almost every website, our servers and content network may record standard request data such as your IP address and a timestamp, to keep the service running and to investigate abuse.',
          ],
        },
      ],
    },
    {
      heading: 'Cookies and local storage',
      blocks: [
        {
          kind: 'p',
          text: "When you sign in, we set a single session cookie so the site knows you're logged in. It is first-party (this site only), and we don't use it for advertising or to track you across other sites.",
        },
        {
          kind: 'p',
          text: "We also remember your light/dark theme choice in your browser's local storage. That never leaves your device.",
        },
      ],
    },
    {
      heading: "What we don't do",
      blocks: [
        {
          kind: 'ul',
          items: [
            'No third-party analytics or advertising trackers.',
            'No selling or renting your data to anyone.',
            'No tracking you across other websites.',
          ],
        },
      ],
    },
    {
      heading: 'Your choices',
      blocks: [
        {
          kind: 'p',
          text: "Browse without signing in and you're anonymous to us. When you do sign in with GitHub, you can revoke TinkerPad's access at any time from your GitHub account settings.",
        },
        {
          kind: 'p',
          text: `Want a playground you made taken down, or have a question about your data? Email ${contactLink}.`,
        },
      ],
    },
    {
      heading: 'Changes to this policy',
      blocks: [
        { kind: 'p', text: 'If this policy changes, the updated version will be posted on this page.' },
      ],
    },
    {
      heading: 'Contact',
      blocks: [{ kind: 'p', text: `Privacy questions and requests: ${contactLink}.` }],
    },
  ],
};
