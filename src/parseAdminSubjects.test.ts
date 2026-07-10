import { describe, expect, it } from 'vitest';
import { parseAdminSubjects } from './app.js';
import { Subject } from './identity/index.js';

// The admin allowlist parser's contract — the ONE place the moderation-admin config string becomes
// subjects, shared by both composition roots. Its safe default (no config → no admins) is
// load-bearing: it must never accidentally grant the console. [LAW:verifiable-goals] [LAW:no-silent-failure]
describe('parseAdminSubjects', () => {
  it('treats absent or empty config as no admins — the safe default, console reachable by no one', () => {
    expect(parseAdminSubjects(undefined)).toEqual(new Set());
    expect(parseAdminSubjects('')).toEqual(new Set());
    // Whitespace-only and comma-only are also "no admins", never a phantom empty-string subject.
    expect(parseAdminSubjects('   ')).toEqual(new Set());
    expect(parseAdminSubjects(',,')).toEqual(new Set());
  });

  it('parses a comma-separated list, trimming whitespace and dropping empty entries', () => {
    expect(parseAdminSubjects('github:1, github:2 ,,github:3,')).toEqual(
      new Set([Subject('github:1'), Subject('github:2'), Subject('github:3')]),
    );
  });

  it('recognizes exactly the configured subject, and no other', () => {
    const admins = parseAdminSubjects('github:42');
    expect(admins.has(Subject('github:42'))).toBe(true);
    expect(admins.has(Subject('github:99'))).toBe(false);
  });
});
