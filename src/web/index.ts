// The front-door web layer: the composed site handler (page + API) and the Node↔Web socket
// bridge. The entry point (main.ts) is the only effectful consumer; tests import these
// seams directly. See design-docs/PROJECT.md for why the front door is a static page over
// the generation API, never a runtime the playground depends on.
export { makeSiteHandler } from './siteHandler.js';
export type { SiteHandlerDeps } from './siteHandler.js';
export { makeContentHandler } from './contentHandler.js';
export type { ContentHandlerDeps } from './contentHandler.js';
export { renderCommons, renderPlayer, renderNotice } from './playgroundPages.js';
export type { PlayerView } from './playgroundPages.js';
export { escapeHtml } from './escapeHtml.js';
export { serve } from './server.js';
export type { RunningServer, ServeConfig } from './server.js';
