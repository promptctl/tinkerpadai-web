// The identity primitive shared across layers: the Subject principal id. The request->Identity
// resolver seam lives in src/api/identity.ts (it depends on the web Request type); only the
// dependency-free value type lives here, where both api and storage can reach it. See
// design-docs/PROJECT.md.
export { Subject } from './subject.js';
