/**
 * forbidden-dids.test.ts — the protected-number lists must agree with the law.
 *
 * Closes `def-forbidden-dids-list-diverges-and-omits-protected-6737-2026-08-28`,
 * where CLAUDE.md §4 protected 6737 but every code copy omitted it, so it
 * passed the draw filter, the claim refusal AND the forward-target validator.
 *
 * Design notes (CLAUDE.md §2 laws 19 and 28):
 *   - Every absence-assertion below is paired with a FIRING POSITIVE CONTROL
 *     in the same file, so a broken import or an empty set cannot make these
 *     pass vacuously.
 *   - The CLAUDE.md agreement test asserts the instrument read real content
 *     BEFORE it asserts anything about the numbers, so a moved/renamed file
 *     fails loudly instead of silently passing on an empty parse.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORBIDDEN_DIDS } from './magnus-voice';
import { validateForwardTarget } from './voice-routing';

/**
 * The CLAUDE.md §4 protected set, in full E.164 form.
 *
 * The full form is NOT derivable from the 4-digit short name — 6737 is
 * `1767295`6737, a different NPA-NXX from the `1767818` pool. Each entry was
 * looked up, not constructed.
 */
const CLAUDE_MD_PROTECTED: ReadonlyArray<{ short: string; full: string; what: string }> = [
  { short: '3742', full: '17678183742', what: "EPIC's sole public front door" },
  { short: '9043', full: '17678189043', what: 'Hermes internal owner line' },
  { short: '6737', full: '17672956737', what: 'Front Desk / Customer Zero' },
  { short: '9525', full: '17678189525', what: 'Anansi' },
  { short: '0001', full: '17678180001', what: 'Personal Line Concierge' },
];

/** Ordinary pool numbers that are deliberately NOT protected. */
const NOT_PROTECTED = ['17678185035', '17678184444', '17678187001'];

describe('FORBIDDEN_DIDS agrees with CLAUDE.md §4', () => {
  // ── positive control: the set is real and non-trivial ──
  it('CONTROL — the set is populated (guards every assertion below from a vacuous pass)', () => {
    expect(FORBIDDEN_DIDS.size).toBeGreaterThanOrEqual(CLAUDE_MD_PROTECTED.length);
  });

  it.each(CLAUDE_MD_PROTECTED)('contains $short ($full) — $what', ({ full }) => {
    expect(FORBIDDEN_DIDS.has(full)).toBe(true);
  });

  // ── FIRING NEGATIVE CONTROL ──
  // If this ever passes trivially (e.g. `has` always returns true, or the set
  // was replaced by something permissive), the assertions above mean nothing.
  it.each(NOT_PROTECTED)('NEGATIVE CONTROL — ordinary number %s is NOT forbidden', (n) => {
    expect(FORBIDDEN_DIDS.has(n)).toBe(false);
  });

  it('every entry is bare 10-15 digit E.164 with no punctuation or leading +', () => {
    for (const did of FORBIDDEN_DIDS) {
      expect(did, `${did} is not bare digits`).toMatch(/^\d{10,15}$/);
    }
  });
});

describe('CLAUDE.md §4 is the source this list tracks', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const claudeMdPath = path.resolve(here, '../../../CLAUDE.md');

  it('CONTROL — CLAUDE.md is readable and contains its protected-numbers clause', () => {
    expect(fs.existsSync(claudeMdPath), `CLAUDE.md not found at ${claudeMdPath}`).toBe(true);
    const text = fs.readFileSync(claudeMdPath, 'utf8');
    expect(text.length).toBeGreaterThan(1000);
    expect(text).toContain('**Protected numbers**');
  });

  it.each(CLAUDE_MD_PROTECTED)(
    'CLAUDE.md still names $short as protected (if this fails, reconcile BOTH files)',
    ({ short }) => {
      const text = fs.readFileSync(claudeMdPath, 'utf8');
      expect(text).toContain(short);
    },
  );
});

describe('validateForwardTarget refuses every protected number', () => {
  const base = {
    ownDid: '17678185555',
    managedDids: [] as string[],
  };

  // ── positive control: an ordinary number IS accepted ──
  // Without this, "refuses X" would also pass if the validator refused
  // everything (CLAUDE.md §2 law 28's sabotage-without-a-control corollary).
  it('CONTROL — an ordinary number is accepted', () => {
    const r = validateForwardTarget({ ...base, candidate: '17678185035' });
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe('17678185035');
  });

  it.each(CLAUDE_MD_PROTECTED)('refuses $short ($full) as a forward target', ({ full }) => {
    const r = validateForwardTarget({ ...base, candidate: full });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('forward number is a protected operational number');
  });

  it('still refuses 7536, the forward-target-only extra', () => {
    const r = validateForwardTarget({ ...base, candidate: '17678187536' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('forward number is a protected operational number');
  });

  it('still refuses the operational numbers not named in CLAUDE.md §4 (8326, 0000)', () => {
    for (const n of ['17678188326', '17678180000']) {
      const r = validateForwardTarget({ ...base, candidate: n });
      expect(r.ok, `${n} should be refused`).toBe(false);
    }
  });
});
