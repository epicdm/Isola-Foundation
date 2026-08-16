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
  {
    name: 'assignment',
    re: /\b(secret|secretkey|secret_key|password|passwd|pwd|token|api_?key|access_?token|refresh_?token|auth_?token|client_?secret|private_?key|sessionkey|session_key|accesskeyid|secretaccesskey)(\s*[:=]\s*)(?!\$\{?[A-Za-z_])(?!%[A-Za-z_])(["']?)([^\s"',;]{4,})\3/gi,
    replace: (_m, key, sep, quote) => key + sep + quote + '[REDACTED:' + key.toLowerCase() + ']' + quote,
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
if (require.main === module) {
  let carry = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const parts = (carry + chunk).split('\n');
    carry = parts.pop();
    for (const line of parts) process.stdout.write(redact(line) + '\n');
  });
  process.stdin.on('end', () => {
    if (carry) process.stdout.write(redact(carry));
  });
  // A broken downstream pipe is normal (`| head`), not an error worth a stack.
  process.stdout.on('error', () => process.exit(0));
}
