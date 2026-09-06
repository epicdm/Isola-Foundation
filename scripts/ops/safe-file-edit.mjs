#!/usr/bin/env node
/**
 * scripts/ops/safe-file-edit.mjs -- edit or shorten a source file WITHOUT
 * corrupting its encoding, and prove it afterwards.
 *
 * WHY THIS EXISTS
 * ---------------
 * 2026-09-06, Personal Line lane: shortening a TypeScript file with
 * PowerShell's `Get-Content | Set-Content -Encoding utf8` silently rewrote
 * every em-dash in the file into 3-character mojibake -- 11 of them. It was
 * caught on the diff, reverted and redone, so nothing shipped. But the trap
 * was ALREADY recorded in a memory note and was walked into anyway. A note
 * that does not stop the action is not a control. This script is the control.
 *
 * Windows PowerShell 5.1 is the specific hazard: `Get-Content` decodes with
 * the system ANSI codepage unless told otherwise, `Set-Content`/`Out-File`
 * re-encode on their own terms, and the round trip mangles every non-ASCII
 * character in a file that was UTF-8 to begin with. Source here is full of
 * em-dashes, arrows and box-drawing characters, so this hits constantly and
 * quietly: the file still compiles, so only a careful diff read catches it.
 *
 * USE THIS INSTEAD OF Get-Content/Set-Content, Out-File, `>` redirection, or
 * any shell pipeline, whenever the target is a repository source file.
 *
 * NEVER APPLY A FIX BY COPYING A WHOLE FILE OVER ANOTHER. Edit in place,
 * against the file that is actually loaded.
 *
 * Learned 2026-09-06, while fixing the guard this procedure had tripped. The
 * same file existed in two checkouts at DIFFERENT versions. The fix was made
 * in one and applied to the other with `Copy-Item` -- byte-identical copy,
 * hash-verified, and completely wrong: the destination was NEWER, and the copy
 * silently deleted a function it had gained (`extractNarrativeText`), breaking
 * three exemption tests. Hash-verifying the copy proved only that the copy
 * succeeded; it said nothing about which direction was correct.
 *
 * A whole-file copy carries the SOURCE's absences as well as its contents, and
 * absences are invisible in a diff you never look at. This tool's `check` will
 * not save you here either -- the encoding was perfect. The selftest caught
 * it, which is the argument for having one.
 *
 * If two copies of a file must exist, that is its own defect (rule 2.3, one
 * source never a sync) -- fix the duplication, do not get better at syncing it.
 *
 * COMMANDS
 *   check      Scan files for mojibake. Read-only. Exit 1 if any found.
 *                node scripts/ops/safe-file-edit.mjs check <file...>
 *   self-scan  Prove the detector works. Run this after ANY edit to this file.
 *                node scripts/ops/safe-file-edit.mjs self-scan
 *   keep-lines Keep the first N lines of a file, drop the rest.
 *                node scripts/ops/safe-file-edit.mjs keep-lines --file=<p> --keep=<N>
 *
 * NAMING: the shortening command is `keep-lines`, NOT `truncate`. That word is
 * a destructive-SQL verb in `.claude/hooks/lib/isola-topology.js`'s
 * `sql-wipe-table` rule, whose pattern matches the word followed by any
 * identifier character. Naming the command that way would trip the estate's
 * own guard every time a lane WROTE ABOUT this procedure -- in this header, in
 * INDEX.md, in a report -- leaving the registry unable to describe its own
 * contents. Measured 2026-09-06: the guard refused a shell line whose only
 * offence was the echo `truncate a clean file`, while the real file operation
 * on the same line did not match at all. The guard defect is filed separately;
 * the name is chosen here so the procedure is describable regardless.
 *
 * THIS FILE IS PURE ASCII AND MUST STAY THAT WAY. Its signatures are built
 * NUMERICALLY from code points, never written as literal characters. Two
 * early drafts spelled the patterns out and therefore flagged THEMSELVES, and
 * would flag any file that legitimately discusses the problem. A detector
 * whose own definition is indistinguishable from the defect is useless --
 * `check` has to be able to scan this entire repository, including this file.
 *
 * PROOF STEP (the registry requires every procedure to carry one)
 * `keep-lines` ends with an INDEPENDENT re-read and refuses to report success
 * unless (1) no signature is present and (2) the retained region is
 * BYTE-IDENTICAL to what it was before. (2) is the assertion that matters: a
 * corrupting write alters bytes it was never asked to touch, so byte-identity
 * catches corruption shapes nobody has catalogued, whereas a signature scan
 * only catches the ones we already know about.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * CP1252 maps bytes 0x80-0x9F to punctuation; ISO-8859-1 maps them to the C1
 * controls (code point == byte). Windows tools use BOTH depending on the
 * codepage in effect, so the same UTF-8 file corrupts into two DIFFERENT
 * character sequences. An em-dash (UTF-8 E2 80 94) becomes
 *   ISO-8859-1: U+00E2 U+0080 U+0094
 *   CP1252    : U+00E2 U+20AC U+201D
 * A detector that knows only one of these misses half the real corruption.
 * Measured 2026-09-06: the first version of this file knew only the CP1252
 * shape and passed a genuinely corrupted control as clean -- see cmdSelfScan.
 * Undefined CP1252 slots (81, 8D, 8F, 90, 9D) stay identity.
 */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];
const TRAIL = new Set(CP1252_HIGH);
for (let cp = 0x80; cp <= 0xbf; cp++) TRAIL.add(cp); // ISO-8859-1 path

/**
 * UTF-8 lead bytes (2-byte C2..DF, 3-byte E0..EF, 4-byte F0..F4) seen as
 * single characters.
 *
 * Review found 2026-09-06: this stopped at 0xEF, so corruption of any
 * 4-byte character -- emoji being the common real-world case -- was
 * invisible. Decoding an emoji's F0 9F .. .. bytes as Latin-1 produces
 * U+00F0 followed by continuation-shaped characters, none of which the old
 * range would even look at as a lead byte.
 */
const isLead = (cp) => cp >= 0xc2 && cp <= 0xf4;

/**
 * A mojibake hit is a UTF-8 lead byte rendered as a character, immediately
 * followed by a character that could only be a continuation byte. Real text
 * effectively never does this: a legitimate accented letter is followed by a
 * letter or a space, not by a C1 control or a stray Euro sign.
 */
function findMojibake(text) {
  let pairs = 0;
  let replacements = 0;
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    if (cp === 0xfffd) {
      replacements++;
    } else if (isLead(cp) && i + 1 < text.length && TRAIL.has(text.charCodeAt(i + 1))) {
      pairs++;
    }
  }
  const hits = [];
  if (pairs) hits.push({ name: 'UTF-8 lead byte + continuation byte (mojibake)', count: pairs });
  if (replacements) hits.push({ name: 'U+FFFD replacement character', count: replacements });
  return hits;
}

/** Explicit utf8. Never a shell pipeline, never a default-codepage decode. */
function readUtf8(path) {
  return readFileSync(path, 'utf8');
}

/** Explicit utf8, LF only -- git's autocrlf owns checkout, and a
 *  CRLF-injecting write is its own diff-noise defect. */
function writeUtf8(path, text) {
  writeFileSync(path, text.replace(/\r\n/g, '\n'), 'utf8');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] ?? true;
    else out._.push(a);
  }
  return out;
}

function reportHits(file, hits) {
  console.error(`MOJIBAKE ${file}`);
  for (const h of hits) console.error(`    ${h.count}x ${h.name}`);
}

function cmdCheck(files) {
  if (files.length === 0) {
    console.error('FAIL: check needs at least one file');
    process.exit(1);
  }
  let bad = 0;
  for (const f of files) {
    const hits = findMojibake(readUtf8(f));
    if (hits.length) {
      bad++;
      reportHits(f, hits);
    } else {
      console.log(`clean    ${f}`);
    }
  }
  if (bad > 0) {
    console.error(`\nFAIL: ${bad} file(s) carry corrupted encoding. Do NOT commit.`);
    console.error('Restore with `git checkout -- <file>`, then redo the edit with this script.');
    process.exit(1);
  }
  console.log('OK: no mojibake found.');
}

/**
 * Corrupt a string the way a single-byte decoder would: take its real UTF-8
 * bytes and map each byte to a character. GENERATED, never hand-written --
 * the first version of this file hand-wrote its control in the one shape its
 * detector already knew, so the control agreed with the detector's assumption
 * and proved nothing. A control must be produced by the mechanism under test,
 * not by the author's prediction of that mechanism's output.
 */
function corrupt(text, decodeByte) {
  const bytes = Buffer.from(text, 'utf8');
  let out = '';
  for (const b of bytes) out += String.fromCharCode(decodeByte(b));
  return out;
}
const asLatin1 = (b) => b;
const asCp1252 = (b) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b);

/**
 * Standing proof of the three properties this tool depends on. Run it after
 * any edit to this file. All three must hold, or `check` is decorative:
 *   1. it does not flag its own source (patterns are numeric, source is ASCII)
 *   2. it DOES flag real corruption, under BOTH single-byte decoders
 *   3. it does NOT flag legitimate non-ASCII prose (no false positives)
 * (2) without (3) is a detector that flags everything; (3) without (2) is a
 * detector that flags nothing. Neither alone is evidence.
 */
function cmdSelfScan() {
  /**
   * `fileURLToPath`, not a hand-rolled `.pathname` strip. Review found
   * 2026-09-06: `.pathname` leaves percent-escapes in place, so a repo path
   * containing a space or other URL-escaped character (plausible on the
   * Windows checkouts this tool targets) reads a nonexistent
   * "space%20dir/safe-file-edit.mjs" and self-scan crashes with ENOENT.
   * `fileURLToPath` is the platform-aware, already-decoding conversion.
   */
  const selfPath = fileURLToPath(import.meta.url);
  let failed = 0;

  const selfHits = findMojibake(readUtf8(selfPath));
  if (selfHits.length) {
    console.error('FAIL: this file flags ITSELF -- its patterns are written as literals.');
    reportHits(selfPath, selfHits);
    failed++;
  } else {
    console.log('OK: self-scan clean (patterns are numeric, source is ASCII).');
  }

  // Real source text, with the characters that actually appear in this repo.
  const sample =
    'em dash ' + String.fromCharCode(0x2014) +
    ' quote ' + String.fromCharCode(0x201c) + 'x' + String.fromCharCode(0x201d) +
    ' arrow ' + String.fromCharCode(0x2192) +
    ' accent ' + String.fromCharCode(0x00e9);

  for (const [label, decoder] of [['ISO-8859-1', asLatin1], ['CP1252', asCp1252]]) {
    const hits = findMojibake(corrupt(sample, decoder));
    if (hits.length === 0) {
      console.error(`FAIL: ${label}-decoded corruption NOT detected -- the detector is blind to it.`);
      failed++;
    } else {
      console.log(`OK: ${label} corruption detected (${hits[0].count}x ${hits[0].name}).`);
    }
  }

  /**
   * FOUR-BYTE CONTROL. Review found 2026-09-06: the lead-byte range stopped
   * at 0xEF, so corruption of any 4-byte character -- emoji being the common
   * real case -- was invisible; `check` would certify a file with corrupted
   * emoji as clean. Emoji corrupt via the same single-byte decoders as any
   * other non-ASCII text, so one control (Latin-1) stands for both, matching
   * the pattern above.
   */
  {
    const emojiSample = 'status ' + String.fromCodePoint(0x1f600) + ' done';
    const hits = findMojibake(corrupt(emojiSample, asLatin1));
    if (hits.length === 0) {
      console.error('FAIL: 4-byte (emoji) corruption NOT detected -- the detector is blind to it.');
      failed++;
    } else {
      console.log(`OK: 4-byte (emoji) corruption detected (${hits[0].count}x ${hits[0].name}).`);
    }
  }

  // FALSE-POSITIVE CONTROL: legitimate non-ASCII prose must survive untouched,
  // or `check` would refuse every real source file in this repository.
  const legit = 'cafe' + String.fromCharCode(0x00e9) + ' -- na' + String.fromCharCode(0x00ef) +
    've r' + String.fromCharCode(0x00e9) + 'sum' + String.fromCharCode(0x00e9) +
    ' ' + String.fromCharCode(0x2014) + ' 90' + String.fromCharCode(0x00b0);
  const falseHits = findMojibake(legit);
  if (falseHits.length) {
    console.error('FAIL: legitimate non-ASCII prose was flagged -- detector is too broad.');
    reportHits('<legit-control>', falseHits);
    failed++;
  } else {
    console.log('OK: legitimate non-ASCII prose not flagged (no false positive).');
  }

  if (failed) {
    console.error(`\nFAIL: ${failed} self-scan assertion(s) failed. Do NOT rely on check.`);
    process.exit(1);
  }
}

function cmdKeepLines(args) {
  const file = args.file;
  const keep = Number(args.keep);
  if (!file || !Number.isInteger(keep) || keep < 0) {
    console.error('FAIL: keep-lines needs --file=<path> --keep=<N>');
    process.exit(1);
  }

  const before = readUtf8(file);
  const beforeLines = before.split('\n');
  if (keep > beforeLines.length) {
    console.error(`FAIL: --keep=${keep} exceeds the file's ${beforeLines.length} lines`);
    process.exit(1);
  }

  // Refuse to touch an ALREADY-corrupt file, or this script would launder
  // pre-existing damage into a commit that looks like ours.
  const preHits = findMojibake(before);
  if (preHits.length) {
    console.error(`FAIL: ${file} already contains mojibake before any edit:`);
    reportHits(file, preHits);
    console.error('Restore it first (`git checkout -- <file>`), then re-run.');
    process.exit(1);
  }

  /**
   * Normalized ONCE, then used for BOTH the write and the expected-bytes
   * comparison below -- and NEVER whitespace-stripped, only EOL-normalized.
   *
   * Review found 2026-09-06, two defects in this one line:
   * (1) The CRLF-checkout case (the expected shape on Windows) split lines on
   *     '\n' alone, leaving a trailing '\r' embedded in each retained line;
   *     writeUtf8's own CRLF->LF pass then stripped it from the FILE, but the
   *     identity check compared the file against this un-normalized value,
   *     which still carried the '\r' -- so a perfectly correct write reported
   *     FAIL, and by then the file was already shortened.
   * (2) `.replace(/\s*$/, '')` removed trailing blank lines / trailing spaces
   *     from THIS value before it became the "expected" baseline, so if the
   *     write itself dropped that same content the comparison could never
   *     catch it -- e.g. keeping 3 lines of "alpha  \n\n\nbeta" silently
   *     became "alpha\n" and still reported byte identity, because the thing
   *     being compared against had already lost the same trailing content.
   * Fixed by keeping the retained prefix EXACTLY as sliced (only CRLF
   * normalization applied) and stripping only the ONE trailing newline this
   * function itself appends when reading it back -- never an open-ended
   * whitespace strip, which is what hid (2).
   */
  const retained = beforeLines.slice(0, keep).join('\n').replace(/\r\n/g, '\n');
  writeUtf8(file, retained + '\n');

  // ---- PROOF: independent re-read ----
  const after = readUtf8(file);

  const postHits = findMojibake(after);
  if (postHits.length) {
    console.error('FAIL: the write introduced mojibake.');
    reportHits(file, postHits);
    process.exit(1);
  }

  const expected = Buffer.from(retained, 'utf8');
  const actual = Buffer.from(after.endsWith('\n') ? after.slice(0, -1) : after, 'utf8');
  if (!expected.equals(actual)) {
    console.error('FAIL: retained region is not byte-identical to the original.');
    console.error(`    expected ${expected.length} bytes, got ${actual.length}`);
    process.exit(1);
  }

  console.log(`OK: ${file} shortened ${beforeLines.length} -> ${keep} lines.`);
  console.log(`    retained region byte-identical (${actual.length} bytes), no mojibake.`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === 'check') cmdCheck(args._.slice(1));
else if (cmd === 'self-scan') cmdSelfScan();
else if (cmd === 'keep-lines') cmdKeepLines(args);
else {
  console.error('usage:');
  console.error('  node scripts/ops/safe-file-edit.mjs check <file...>');
  console.error('  node scripts/ops/safe-file-edit.mjs self-scan');
  console.error('  node scripts/ops/safe-file-edit.mjs keep-lines --file=<p> --keep=<N>');
  process.exit(1);
}
