// The committed front door (src/web/index.html) is bundled into the Worker as a TEXT module by
// wrangler's `Text` rule (see wrangler.toml), so `import page from './index.html'` yields the file's
// string contents. tsc doesn't know that rule, so this ambient declaration gives the import a type —
// the same string the Node entry gets from readFile, just supplied by the bundler at the edge.
// [LAW:one-source-of-truth]
declare module '*.html' {
  const content: string;
  export default content;
}
