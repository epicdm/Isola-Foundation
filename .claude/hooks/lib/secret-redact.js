#!/usr/bin/env node
/**
 * secret-redact — credential-shape redaction for command OUTPUT.
 *
 * WHY THIS EXISTS, AND WHAT IT HONESTLY CANNOT DO
 * ------------------------------------------------
 * Four credential exposures have now gone through isola-guard, and none of them
 * looked like a secret read at the command layer:
 *
 *   1. `git remote -v`                    -> printed a live GitHub PAT embedded
 *                                            in /opt/lk-voice-agent/.git/config
 *   2. `sed -n '10340,10380p' sip_*.conf` -> printed two plaintext SIP secrets
 *   3. epic-portal listProjectsAndServices -> whole env blobs
 *   4. listStorageProviders                -> S3 accessKeyId + secretAccessKey
 *
 * The layer was the bug: a PreToolUse hook sees the COMMAND, and a command does
 * not announce what it will print.
 *
 * THE CONSTRAINT, MEASURED NOT ASSUMED (verified against the Claude Code hooks
 * reference, 2026-08-16): **no hook can redact tool OUTPUT.** PostToolUse fires
 * after the tool has already run and has no field that rewrites, replaces or
 * suppresses the result — `suppressOutput` is accepted and ignored. There is no
 * hook event anywhere that filters output. Claiming otherwise would build a
 * security control that does nothing, which is worse than none at all.
 *
 * WHAT IS ACTUALLY POSSIBLE: PreToolUse *can* rewrite tool INPUT via
 * `hookSpecificOutput.updatedInput`. So for the specific surfaces known to carry
 * credentials, the guard rewrites the command to pipe its own output through
 * this filter before it is ever emitted. That is targeted output redaction
 * achieved on the input side — not universal coverage, and this file does not
 * pretend to be.
 *
 * COVERAGE BOUNDARY, STATED PLAINLY:
 *   - covers: Bash/PowerShell commands the guard chose to wrap
 *   - does NOT cover: Read/Grep/Glob results, MCP tool responses, or any shell
 *     command the wrap heuristic did not match
 * Anything outside that boundary can still leak. The structural fix is that a
 * runtime host should not hold a write-capable credential in the first place.
 *
 * Pure function + entry-point-gated main(), per scripts/src/guard-not-prod-db.ts.
 */

'use strict';

const PLACEHOLDER = '[REDACTED:%s]';

/**
 * Ordered most-specific-first. A generic rule that ran first would swallow the
 * distinctive prefix and cost us the label that says WHICH credential leaked.
 *
 * Every pattern replaces the credential WHOLESALE. A prefix is still a usable
 * correlation handle and a suffix is still secret material, so nothing is
 * "partially" redacted — same rule meta-graph-policy.js already applies.
 */
const RULES = [
  // --- GitHub -------------------------------------------------------------
  // Fine-grained PATs are long; classic ghp_/gho_/ghu_/ghs_/ghr_ are 36+.
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },

  // --- Credential embedded in a URL ---------------------------------------
  // https://user:SECRET@host -> keep the user and host, kill the secret. This
  // is the exact shape that leaked the PAT via `git remote -v`.
  {
    name: 'url-userinfo',
    re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi,
    replace: (_m, prefix) => prefix + ':[REDACTED:url-password]@',
  },

  // --- Private keys -------------------------------------------------------
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },

  // --- Well-known vendor shapes -------------------------------------------
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'groq-key', re: /\bgsk_[A-Za-z0-9]{20,}/g },
  { name: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'meta-token', re: /\bEA[A-Za-z0-9]{28,}\b/g },
  // Segment floor is deliberately low (6). A real JWT's segments are far longer,
  // but an {8,} floor missed a short-header token in test and a miss here is a
  // leaked session credential.
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g },

  // --- Authorization headers ----------------------------------------------
  {
    name: 'bearer',
    re: /\b(Authorization\s*:\s*)?(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: (m) => (/authorization/i.test(m) ? 'Authorization: ' : '') + 'Bearer [REDACTED:bearer]',
  },

  // --- key=value assignments ----------------------------------------------
  // This is the one that catches asterisk `secret=`, `.env`-style lines, DB
  // URLs and connection strings. An env-var REFERENCE ($FOO / ${FOO} / %FOO%)
  // is deliberately preserved: it is not a secret, and blanking it destroys the
  // readability that makes a config diff reviewable at all.
  // Vendor-prefixed opaque tokens. `rtp_` is FIRST because it is ours: the
  // Paperclip runtime bearer leaked on 2026-08-16 (register C-04). The earlier
  // version of this file would NOT have caught our own real leak unless it
  // happened to sit behind `Bearer` — worth stating plainly.
  { name: 'prefixed-token', re: /\b(rtp|glpat|xoxe|shpat|dop_v1|rnd|npm|pypi|dckr_pat)[_-][A-Za-z0-9_-]{16,}/g },
  { name: 'stripe-key', re: /\bsk_(live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },

  {
    // PROPERTY-NAME RULE 2026-09-22 — redact by PROPERTY, not by shape.
    // Real exposure the same night: a gateway bindings store read through this
    // pipe printed two `agentBotSecret` / `agentBotAccessToken` values in the
    // clear. Two of four entries happened to be long hex and were caught by
    // `long-hex`; the other two were short mixed-alnum and matched NO shape
    // rule. The `assignment` rule below could not help either: it anchors the
    // keyword with `\b`, and a camelCase key (`agentBotSecret`) has no word
    // boundary before "Secret"; a JSON-quoted key (`"agentBotSecret": "…"`)
    // also carries a closing quote between key and colon that the rule never
    // skips. So the only thing standing between a short opaque secret and the
    // transcript was luck about its shape. This rule keys on the NAME: any
    // property whose name CONTAINS a credential keyword — quoted or bare,
    // camelCase or snake_case, JSON, YAML or env — has its value redacted
    // regardless of what the value looks like. Runs before `assignment` so the
    // label is the keyword. Env-var references are still preserved. The value
    // alternation handles a quoted value with spaces (previously a miss) and
    // stops at JSON delimiters for a bare one. Over-redaction of a non-secret
    // whose name merely contains "token" (tokenCount) is accepted only when the
    // value is 4+ chars — the failure direction is towards redaction.
    name: 'property',
    // The env-reference guard sits INSIDE each value alternative: a quoted
    // reference (`"$BOT_SECRET"`) must survive too, and a guard placed before
    // the opening quote never sees the `$`.
    // The leading lookbehind anchors the key at a non-key character: without
    // it every position inside a long identifier is a candidate start and the
    // lazy prefix scan goes quadratic (the adversarial-input test caught it at
    // 14.8 s on a 100k-char run).
    //
    // ESCAPED QUOTES INSIDE THE VALUE, found in review 2026-09-22 and it is a
    // real leak, not a cosmetic one. The quoted alternatives used to be
    // `[^"\r\n]{4,}`, which treats the FIRST quote as the terminator even when
    // it is escaped. So `{"agentBotSecret":"abc\"TAIL"}` redacted only up to the
    // escape and emitted `"[REDACTED:secret]"TAIL"` — leaking the suffix AND
    // producing invalid JSON. A redactor that leaks the tail of the secret it
    // just labelled is worse than none, because the label says it was handled.
    //
    // Each alternative now consumes escape sequences before it will accept a
    // closing quote. `(?:\\.|[^"\\\r\n])` stays linear: the two branches are
    // mutually exclusive on their first character, so there is no ambiguity to
    // backtrack over — the adversarial-input test in this suite is the control.
    re: /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]*?(secret|password|passwd|pwd|token|api_?key|access_?key|private_?key|signing_?key|client_?secret|credential|bearer)[A-Za-z0-9_.-]*)\1(\s*[:=]\s*)(?:"(?!\$\{?[A-Za-z_])(?!%[A-Za-z_])((?:\\.|[^"\\\r\n]){4,})"|'(?!\$\{?[A-Za-z_])(?!%[A-Za-z_])((?:\\.|[^'\\\r\n]){4,})'|(?!\$\{?[A-Za-z_])(?!%[A-Za-z_])([^\s"',;}\]]{4,}))/gi,
    replace: (_m, q, key, kw, sep, dq, sq, bare) => {
      const label = '[REDACTED:' + kw.toLowerCase() + ']';
      const value = dq != null ? '"' + label + '"' : sq != null ? "'" + label + "'" : label;
      return q + key + q + sep + value;
    },
  },

  {
    // KEY NAMES: `[A-Z0-9_]*` prefix and suffix are load-bearing. Without them
    // `\b(secret)` never matches AWS_SECRET_ACCESS_KEY, because `_` is a word
    // character so there is no boundary before SECRET. That miss was found by
    // review, not by the tests here — `AWS_SECRET_ACCESS_KEY=` is not an
    // attack, it is Tuesday.
    //
    // MULTI-SEGMENT PREFIX FIX 2026-08-16 — the single `_?` above only tolerates
    // ONE underscore-delimited segment before the keyword. PAPERCLIP_API_TOKEN
    // has two ("PAPERCLIP_" + "API_") and leaked in plaintext because of it —
    // `\b` never anchors between them since `_` is a word character throughout,
    // so the regex could never reach "TOKEN" as the keyword. Any real two-plus
    // segment key name (STRIPE_WEBHOOK_SECRET, SERVICE_ACCOUNT_KEY, ...) had the
    // same hole. `(?:[A-Za-z0-9]+_)*` allows zero or more such segments.
    name: 'assignment',
    re: /\b((?:[A-Za-z0-9]+_)*)(secret|secretkey|secret_key|password|passwd|pwd|token|api_?key|access_?key|access_?token|refresh_?token|auth_?token|client_?secret|private_?key|sessionkey|session_key|accesskeyid|secretaccesskey)([A-Za-z0-9_]*)(\s*[:=]\s*)(?!\$\{?[A-Za-z_])(?!%[A-Za-z_])(["']?)([^\s"',;]{4,})\5/gi,
    replace: (_m, pre, key, post, sep, quote) =>
      pre + key + post + sep + quote + '[REDACTED:' + key.toLowerCase() + ']' + quote,
  },

  // --- Long opaque hex ----------------------------------------------------
  // 32+ hex chars is a hash or a key. Runs LAST so labelled shapes win, and is
  // deliberately not shorter: 8-16 hex is a git sha, which must stay readable.
  { name: 'long-hex', re: /\b[0-9a-f]{32,}\b/gi },
];

/**
 * Redact credential shapes from arbitrary text.
 *
 * Never throws: a redactor that crashes on malformed input would take the
 * command's whole output with it. Non-string input returns ''.
 */
function redact(text) {
  if (text == null) return '';
  let s = String(text);
  for (const rule of RULES) {
    try {
      s = s.replace(rule.re, rule.replace || PLACEHOLDER.replace('%s', rule.name));
    } catch (_) {
      /* one bad rule must not void the rest */
    }
  }
  return s;
}

/** True if redaction would change the text — used by tests and the self-test. */
function hasSecret(text) {
  return redact(text) !== String(text == null ? '' : text);
}

module.exports = { redact, hasSecret, RULES };

// --- entry point ---------------------------------------------------------
// Streams stdin -> stdout, redacting as it goes. Line-buffered so a long-running
// command still streams rather than blocking until EOF.
// CRITICAL FIX 2026-08-16 — the streaming path did NOT redact what redact() does.
//
// It split on newline and redacted each line INDEPENDENTLY. The private-key rule
// is multi-line, so a PEM block streamed through the pipe was emitted verbatim,
// body line by body line. The unit tests passed the whole time because they call
// redact() on a complete string — which is not how the caller uses it.
//
//   LAW: A UNIT TEST THAT CALLS THE FUNCTION DIFFERENTLY FROM THE CALLER TESTS A
//   DIFFERENT PROGRAM.
//
// This matters more than any single regex: the redactor is the entire basis on
// which credential surfaces are read at all, and it was failing on the
// highest-value shape we handle.
//
// Fix: hold lines back while inside a BEGIN/END block and redact the whole block
// at once. Both buffers are capped — an unterminated block or a single enormous
// line must not grow memory without bound, since this sits in the output path of
// real commands and a hang is a denial of service against the operator.
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const MAX_BLOCK_LINES = 200;   // a PEM key is ~30-70 lines
const MAX_LINE_BYTES = 1 << 20; // 1 MiB

if (require.main === module) {
  let carry = '';
  let block = null; // non-null while inside a PEM block

  // An OPEN block must never be released verbatim. redact() alone is not enough
  // here: the private-key rule needs BEGIN *and* END, so an unterminated block
  // passes through it untouched — which is failing toward release, on a key.
  // So a forced flush replaces the body outright.
  const flushOpenBlock = () => {
    if (!block) return;
    process.stdout.write(block[0] + '\n[REDACTED:private-key]\n');
    block = null;
  };

  const emit = (line) => {
    if (block) {
      block.push(line);
      if (PEM_END.test(line)) {
        // Complete block — redact it as ONE string so the multi-line rule sees it.
        process.stdout.write(redact(block.join('\n')) + '\n');
        block = null;
      } else if (block.length > MAX_BLOCK_LINES) {
        flushOpenBlock();
      }
      return;
    }
    if (PEM_BEGIN.test(line)) { block = [line]; return; }
    process.stdout.write(redact(line) + '\n');
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    carry += chunk;
    if (carry.length > MAX_LINE_BYTES) {
      // A single line longer than the cap: flush it redacted rather than buffer
      // forever. Splitting mid-token is acceptable — the alternative is OOM.
      process.stdout.write(redact(carry));
      carry = '';
      return;
    }
    const parts = carry.split('\n');
    carry = parts.pop();
    for (const line of parts) emit(line);
  });
  process.stdin.on('end', () => {
    if (carry) emit(carry);
    flushOpenBlock(); // EOF inside a block: replace, never release
  });
  // A broken downstream pipe is normal (`| head`), not an error worth a stack.
  process.stdout.on('error', () => process.exit(0));
}
