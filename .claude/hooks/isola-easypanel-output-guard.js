#!/usr/bin/env node
/**
 * isola-easypanel-output-guard — PostToolUse output projection for
 * mcp__epic-portal__execute_query.
 *
 * Protocol: stdin {session_id, cwd, hook_event_name, tool_name, tool_input,
 * tool_response, ...}. Output: hookSpecificOutput.updatedToolOutput replaces
 * what the model actually sees. decision:"block" is deliberately NOT used as
 * a redaction mechanism here — by PostToolUse time the tool has already run;
 * blocking does not un-execute it or change what content reaches the model.
 * updatedToolOutput is the only field that does that.
 *
 * Fails closed within successful hook execution. Claude Code hook crashes,
 * timeouts and invalid hook output are non-blocking infrastructure failures
 * and may leave the original result in place. Any parse/validation/
 * projection failure THIS PROCESS actually completes returns a constant
 * safe placeholder — never the original response, never a partial
 * best-effort reconstruction — but that guarantee only holds for a run that
 * finishes successfully; it is not a claim about what happens if the
 * process itself never gets to emit anything at all.
 *
 * NO PERSISTENT LOGGING. An earlier revision logged exception messages
 * derived from stdin/tool_input/tool_response/JSON.parse — that is exactly
 * the kind of output-security boundary where a "helpful" error message can
 * itself leak the thing being redacted (a JSON.parse error can echo a
 * fragment of the malformed text near the failure point). This is a
 * security boundary, not a debugging surface: it either emits the reviewed
 * placeholder or the reviewed projection, and nothing else, ever.
 *
 * RECORDED LIMITATIONS (mitigated by nothing in this file):
 *   - the procedure has ALREADY EXECUTED by the time this hook runs. This is
 *     output redaction for what Claude sees, not prevention — prevention is
 *     isola-guard.js (PreToolUse), a separate layer.
 *   - upstream telemetry (EasyPanel's own server logs, any provider-side
 *     capture, network-level logging) may already hold the original,
 *     unprojected result. This hook has no reach there at all.
 *   - PostToolUseFailure is a DIFFERENT hook event (a tool call that errored)
 *     — this file does not run on it and cannot replace a failed call's
 *     original error output, which may itself echo request/response detail.
 *   - Net effect: this hook mitigates what THIS agent sees in THIS
 *     conversation. It does not remediate the EasyPanel connector, and P0
 *     stays Open/mitigated regardless of whether this hook is active.
 */

'use strict';

/** The one and only thing ever returned when projection cannot proceed
 * cleanly. Never the original response, never a best-effort partial. */
const SAFE_PLACEHOLDER = Object.freeze({ status: 'output_withheld_pending_review' });

/** Bounds so neither direction can grow without limit in memory or exceed
 * Claude Code's documented hook-output cap (10,000 characters, including
 * plain stdout). 8,192 is used, not 10,000 — real margin below the
 * documented cap rather than skating against it. Checked on BOTH character
 * count and UTF-8 byte count (they diverge once any non-ASCII content is
 * involved; this project's data is expected to be ASCII, but the check
 * costs nothing and removes the assumption). */
const MAX_STDIN_BYTES = 2 * 1024 * 1024; // 2 MiB — input has no documented cap; this is a memory bound only
const MAX_OUTPUT_CHARS = 8192;
const MAX_OUTPUT_BYTES = 8192;

/**
 * Writes the hook's JSON response and sets a successful exit code WITHOUT
 * force-exiting immediately. process.stdout.write() is not guaranteed to be
 * synchronous/flushed when stdout is piped (the normal case for a hook
 * subprocess) — calling process.exit() right after can leave the write
 * incomplete or entirely unsent, silently degrading to no updatedToolOutput
 * at all (an infrastructure failure, not a security failure, but one worth
 * closing). Setting exitCode and letting the event loop drain naturally
 * (nothing else is scheduled once stdin ends) lets Node finish the write
 * before the process actually exits.
 *
 * SHAPE CONTRACT (found live, not in unit tests): for an MCP tool,
 * updatedToolOutput must be an ARRAY OF CONTENT BLOCKS
 * ([{type:'text', text}]), matching the shape MCP tool output natively has.
 * An earlier revision emitted the projection as a bare object; Claude Code
 * accepted and applied it ("replaced tool output"), then crashed consuming
 * it — `e.reduce is not a function` in its content-block length accounting —
 * so the model received an infrastructure error instead of the projection.
 * Fail-closed in direction (nothing leaked), but the reviewed projection
 * never reached the model either. The value the model sees is the text of
 * the single block: the projection JSON-serialized once.
 */
function emit(projectedValue) {
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: [{ type: 'text', text: JSON.stringify(projectedValue) }],
    },
  });
  // If the reviewed projection itself would exceed either bound, fall back
  // to the (much smaller, constant-size) safe placeholder rather than emit
  // a response Claude Code's own hook-output cap might cut off.
  const overChars = payload.length > MAX_OUTPUT_CHARS;
  const overBytes = Buffer.byteLength(payload, 'utf8') > MAX_OUTPUT_BYTES;
  if ((overChars || overBytes) && projectedValue !== SAFE_PLACEHOLDER) {
    return emit(SAFE_PLACEHOLDER);
  }
  process.stdout.write(payload);
  process.exitCode = 0;
}

/** Not our tool — no stdout, harness leaves the original response untouched. */
function passthrough() {
  process.exitCode = 0;
}

// ---------------------------------------------------------------- projectors
//
// A Map, not a plain object — never bracket-indexed on an untrusted string.
// A plain-object registry accessed as REGISTRY[userControlledKey] is a real
// prototype-chain bypass: REGISTRY['constructor'] resolves to
// Object.prototype.constructor (a real, callable, non-throwing function)
// even though 'constructor' was never an own key. Map.get() has no
// prototype-chain lookup semantics at all — an absent key always returns
// undefined, full stop.
//
// Only a procedure whose real output shape has actually been reviewed gets a
// projector here. Every other allowlisted procedure — including ones whose
// INPUT is already allowlisted by isola-guard.js but whose live OUTPUT has
// never successfully been observed (blocked so far by the unresolved
// parameterized-input serialization issue) — intentionally has NO entry and
// falls through to SAFE_PLACEHOLDER. Do not invent fields for an unreviewed
// shape.

const MAX_ROWS = 100;
/** EasyPanel's own real schema constrains project/service names to this
 * pattern (seen directly in multiple procedures' inputSchema this session):
 * ^[a-z0-9-_]+$. Reuse it here as an output-side bound too. */
const NAME_PATTERN = /^[a-z0-9-_]{1,100}$/;
/** Bounded fractional-seconds precision (1-6 digits — the real observed
 * value this session was 3-digit milliseconds, e.g. ".605Z"; 6 covers
 * microsecond precision some ISO-8601 producers use, still bounded). The
 * regex alone already bounds length structurally, but an explicit length
 * check is kept alongside it (belt and suspenders, and it documents the
 * bound in one place rather than relying on regex-reading alone) — the
 * longest string this pattern can match is 30 characters
 * ("YYYY-MM-DDTHH:MM:SS.dddddd" + "Z" = 20 + 1 + 6 + 1 = 28, rounded up).
 */
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;
const MAX_TIMESTAMP_LENGTH = 30;

/** Structural (regex) validity is not calendar validity — "2026-02-30" and
 * "2026-13-01" both match ISO_TIMESTAMP_PATTERN's digit-count shape. This
 * checks the captured components against real calendar rules by hand:
 * explicit range/leap-year arithmetic, never `new Date(str)` — Date silently
 * NORMALIZES an out-of-range date (e.g. "2026-02-30" becomes March 2) rather
 * than rejecting it, which would make invalid input pass this check by
 * accident. */
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isValidCalendarTimestamp(match) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > maxDay) return false;
  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 59) return false;
  return true;
}

function projectListProjects(result) {
  if (!Array.isArray(result)) throw new Error('listProjects result is not an array');
  if (result.length > MAX_ROWS) throw new Error('listProjects row count exceeds bound');
  return result.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('listProjects row is not a plain object');
    }
    if (typeof row.name !== 'string' || !NAME_PATTERN.test(row.name)) {
      throw new Error('listProjects row.name failed validation');
    }
    const tsMatch = typeof row.createdAt === 'string' ? ISO_TIMESTAMP_PATTERN.exec(row.createdAt) : null;
    if (
      typeof row.createdAt !== 'string' ||
      row.createdAt.length > MAX_TIMESTAMP_LENGTH ||
      !tsMatch ||
      !isValidCalendarTimestamp(tsMatch)
    ) {
      throw new Error('listProjects row.createdAt failed validation');
    }
    // Recursively constructed from validated primitives only — never
    // spread/rest, so an unknown or malformed sibling value can never ride
    // along merely for occupying an allowed field name.
    return { name: row.name, createdAt: row.createdAt };
  });
}

const PROJECTORS = new Map([['listProjects', projectListProjects]]);

// ------------------------------------------------------------- unwrapping
//
// Defensive against multiple plausible tool_response shapes: an already-
// parsed plain object (observed directly this session for successful
// calls: {procedure, result}), an MCP content-block array
// ([{type:'text', text: '...json...'}]), or that array nested under
// tool_response.content.

function unwrapToolResponse(toolResponse) {
  if (
    toolResponse &&
    typeof toolResponse === 'object' &&
    !Array.isArray(toolResponse) &&
    Object.prototype.hasOwnProperty.call(toolResponse, 'result')
  ) {
    return toolResponse;
  }

  const blocks = Array.isArray(toolResponse)
    ? toolResponse
    : toolResponse && Array.isArray(toolResponse.content)
      ? toolResponse.content
      : null;

  if (Array.isArray(blocks)) {
    const textBlock = blocks.find((b) => b && b.type === 'text' && typeof b.text === 'string');
    if (!textBlock) throw new Error('no text content block found');
    const parsed = JSON.parse(textBlock.text); // caller catches; no message ever logged
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('parsed content block text is not a plain object');
    }
    return parsed;
  }

  throw new Error('tool_response did not match any recognized shape');
}

function extractProcedureFromToolInput(toolInput) {
  if (toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput) && typeof toolInput.procedure === 'string') {
    return toolInput.procedure;
  }
  throw new Error('could not determine procedure from tool_input');
}

// ------------------------------------------------------------------- main

let raw = '';
let rawBytes = 0;
let oversized = false;
process.stdin.on('data', (d) => {
  if (oversized) return; // already decided; stop accumulating further
  rawBytes += Buffer.byteLength(d);
  if (rawBytes > MAX_STDIN_BYTES) {
    oversized = true;
    raw = ''; // release whatever was buffered — never hold an oversized payload in memory
    return;
  }
  raw += d;
});
process.stdin.on('end', () => {
  if (oversized) {
    // Cannot safely inspect tool_name from an oversized payload (would mean
    // parsing something already discarded), so this cannot be narrowed to
    // "not our tool" — fail closed rather than assume either way.
    return emit(SAFE_PLACEHOLDER);
  }

  let inp;
  try {
    inp = JSON.parse(raw || '{}');
  } catch (_) {
    // Malformed hook stdin itself. We cannot confirm this wasn't our tool,
    // so fail closed rather than exit silently. No message logged.
    return emit(SAFE_PLACEHOLDER);
  }

  const tool = inp.tool_name || '';
  if (tool !== 'mcp__epic-portal__execute_query') {
    return passthrough();
  }

  try {
    const requestedProcedure = extractProcedureFromToolInput(inp.tool_input || {});
    const unwrapped = unwrapToolResponse(inp.tool_response);

    // The response's own procedure field, where present in the reviewed
    // real shape, must exactly match what was requested. A mismatch is
    // itself a reason to fail closed, not something to reconcile.
    if (Object.prototype.hasOwnProperty.call(unwrapped, 'procedure')) {
      if (unwrapped.procedure !== requestedProcedure) {
        return emit(SAFE_PLACEHOLDER);
      }
    }

    const projector = PROJECTORS.get(requestedProcedure);
    if (!projector) {
      return emit(SAFE_PLACEHOLDER);
    }
    const projected = projector(unwrapped.result);
    return emit({ procedure: requestedProcedure, result: projected });
  } catch (_) {
    // No message ever logged — see file header.
    return emit(SAFE_PLACEHOLDER);
  }
});
