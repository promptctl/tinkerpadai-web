// THE PRINCIPAL ID — the stable id of an authenticated principal, as a branded value type
// with ZERO dependencies so every layer that records or resolves identity shares ONE
// definition. The api seam resolves a request to it (identity.ts); storage records it as a
// playground's author (the commons is the source of truth for who made what). Both depend on
// this module; neither owns it — a second "Subject" definition would let two of them drift,
// and putting it in either layer would force a dependency cycle the other way.
// [LAW:one-source-of-truth] [LAW:one-way-deps]

// Branded, matching the provider and storage id conventions — a bare `string` would let a
// Subject be passed where any other id is expected. [LAW:types-are-the-program]
type Brand<T, B extends string> = T & { readonly __brand: B };

// Minted only through the constructor, so foreign input becomes a Subject at exactly one
// place rather than via scattered casts. [LAW:single-enforcer]
export type Subject = Brand<string, 'Subject'>;
export const Subject = (raw: string): Subject => raw as Subject;
