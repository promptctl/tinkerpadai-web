import type { Tags } from '../storage/index.js';
import { Tag } from '../storage/index.js';

// THE POST-GENERATION TAG EXTRACTION STEP — turns a playground's describe prompt into a small set of
// normalized topic tags for the commons' facets and the player chrome. It is the generation side's
// classifier (the ticket's "post-generation extraction step"), called once when a playground is
// created and handed to the catalog as a value; the catalog stores what it is given and never knows
// this taxonomy. [LAW:decomposition]
//
// Pure and deterministic: no LLM call, no clock, no IO — so it runs identically on every deploy
// target (including the eval-free Cloudflare Workers target) and is trivially testable.
// [LAW:effects-at-boundaries] It is the SINGLE home for prompt->tags; a richer future classifier
// (e.g. the agent emitting semantic tags from what it actually built) replaces THIS function behind
// the same NewPlayground.tags seam, touching neither the catalog nor the read path.
// [LAW:one-source-of-truth] [LAW:locality-or-seam]

// One vocabulary entry as authored: the tag and the keywords that imply it.
interface Topic {
  readonly tag: string;
  readonly keywords: readonly string[];
}

// The topic vocabulary, in PRIORITY order (specific → generic). When a prompt matches more topics
// than the cap, earlier entries win and the generic 'interactive' tag falls off first. Each keyword
// is matched at a word boundary so 'color' catches 'colorful' but 'art' never fires inside 'start'.
const TOPICS: readonly Topic[] = [
  { tag: 'math', keywords: ['math', 'algebra', 'calculus', 'geometr', 'equation', 'formula', 'fibonacci', 'prime', 'trigonom', 'sine', 'cosine', 'vector', 'matrix', 'bezier', 'fractal', 'probabilit', 'arithmetic'] },
  { tag: 'physics', keywords: ['physic', 'gravity', 'pendulum', 'orbit', 'projectile', 'collision', 'momentum', 'velocity', 'kinematic', 'newton'] },
  { tag: 'game', keywords: ['game', 'puzzle', 'maze', 'snake', 'tetris', 'chess', 'sudoku', 'arcade', 'platformer', 'quiz'] },
  { tag: 'audio', keywords: ['audio', 'sound', 'music', 'synth', 'oscillator', 'melody', 'chord', 'rhythm', 'piano', 'waveform'] },
  { tag: 'graphics', keywords: ['canvas', 'svg', 'webgl', 'shader', 'pixel', 'sprite', 'particle', '3d', 'draw', 'paint'] },
  { tag: 'chart', keywords: ['chart', 'plot', 'histogram', 'dashboard', 'visualiz', 'visualis', 'dataset', 'statistic'] },
  { tag: 'text', keywords: ['text', 'markdown', 'typewriter', 'typing', 'ascii', 'unicode', 'regex', 'cipher', 'encode'] },
  { tag: 'color', keywords: ['color', 'colour', 'palette', 'gradient', 'swatch', 'rgb', 'hsl'] },
  { tag: 'css', keywords: ['css', 'flexbox', 'keyframe', 'stylesheet', 'tailwind'] },
  { tag: 'design', keywords: ['design', 'typography', 'font', 'theme', 'icon', 'logo', 'wireframe', 'mockup', 'interface'] },
  { tag: 'tools', keywords: ['tool', 'calculator', 'converter', 'generator', 'timer', 'clock', 'stopwatch', 'counter', 'picker', 'editor', 'tracker', 'planner'] },
  { tag: 'simulation', keywords: ['simulat', 'cellular', 'automaton', 'boids', 'flock', 'ecosystem'] },
  { tag: 'map', keywords: ['map', 'geograph', 'globe', 'latitude', 'terrain'] },
  { tag: 'interactive', keywords: ['interactive', 'explore', 'explorer', 'playground', 'slider', 'toggle', 'adjust', 'tweak'] },
];

// The vocabulary compiled once at module load: each topic paired with a single boundary-anchored
// regex over its keywords. Minting the tag through the single normalizer here means a malformed
// vocabulary entry fails loudly at load, not in production. [LAW:single-enforcer] [LAW:no-silent-failure]
const VOCABULARY: readonly { readonly tag: Tag; readonly re: RegExp }[] = TOPICS.map(({ tag, keywords }) => ({
  tag: Tag(tag),
  re: new RegExp(`\\b(?:${keywords.join('|')})`),
}));

// Every playground is interactive by the artifact contract (controls + live preview), so this is a
// TRUE floor, not a junk-drawer default: a prompt that matched no topic still gets one honest tag.
// [LAW:no-silent-failure]
const INTERACTIVE = Tag('interactive');

// The most tags a single card should wear — a documented cap, so more matches never fragment a card
// into a wall of chips. [LAW:no-mode-explosion]
const CAP = 5;

export const deriveTags = (prompt: string): Tags => {
  const text = prompt.toLowerCase();
  const matched = VOCABULARY.filter((v) => v.re.test(text))
    .map((v) => v.tag)
    .slice(0, CAP);
  // Variability lives in the value (matched vs the floor), not in whether a new playground gets
  // tagged: the result is always non-empty. [LAW:dataflow-not-control-flow]
  return matched.length === 0 ? [INTERACTIVE] : matched;
};
