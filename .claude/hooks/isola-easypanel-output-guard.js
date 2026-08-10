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
 * FAIL-CLOSED ON EVERYTHING: any parse/validation/projection failure returns
 * a constant safe placeholder — never the original response, never a partial
 * best-effort reconstruction.
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

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', 'state');
const LOG = path.join(STATE_DIR, 'output-guard.log');

/** The one and only thing ever returned when projection cannot proceed
 * cleanly. Never the original response, never a best-effort partial. */
const SAFE_PLACEHOLDER = Object.freeze({ status: 'output_withheld_pending_review' });

function log(line) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Never write raw tool_response content here — only short status lines.
    fs.appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n');
  } catch (_) {
    /* never fail on logging */
  }
}

function emit(updatedToolOutput) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: updatedToolOutput,
      },
    })
  );
  process.exit(0);
}

/** Not our tool — exit 0 with no stdout, harness leaves the original response untouched. */
function passthrough() {
  process.exit(0);
}

// ---------------------------------------------------------------- projectors
//
// Only a procedure whose real output shape has actually been reviewed gets a
// projector here. Every other allowlisted procedure — including ones whose
// INPUT is already allowlisted by isola-guard.js but whose live OUTPUT has
// never successfully been observed (blocked so far by the unresolved
// parameterized-input serialization issue) — intentionally has NO entry and
// falls through to SAFE_PLACEHOLDER. Do not invent fields for an unreviewed
// shape.

const PROJECTORS = {
  listProjects: projectListProjects,
  // listPorts, listMounts, getComposeDockerServices: deliberately absent.
};

/** Recursively constructs a NEW object containing only reviewed fields —
 * never spread/rest, so an unknown sibling field can never ride along. */
function projectListProjects(result) {
  if (!Array.isArray(result)) throw new Error('listProjects result is not an array');
  return result.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('listProjects row is not a plain object');
    }
    const projected = {};
    if (typeof row.name === 'string') projected.name = row.name;
    if (typeof row.createdAt === 'string') projected.createdAt = row.createdAt;
    return projected;
  });
}

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
    if (!textBlock) throw new Error('no text content block found in tool_response');
    let parsed;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch (e) {
      throw new Error('content block text is not valid JSON: ' + e.message);
    }
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
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let inp;
  try {
    inp = JSON.parse(raw || '{}');
  } catch (_) {
    // Malformed hook stdin itself. We cannot confirm this wasn't our tool,
    // so fail closed rather than exit silently.
    log('MALFORMED-STDIN fail-closed');
    return emit(SAFE_PLACEHOLDER);
  }

  const tool = inp.tool_name || '';
  if (tool !== 'mcp__epic-portal__execute_query') {
    return passthrough();
  }

  try {
    const procedure = extractProcedureFromToolInput(inp.tool_input || {});
    const unwrapped = unwrapToolResponse(inp.tool_response);
    const projector = PROJECTORS[procedure];
    if (!projector) {
      log('NO-REVIEWED-PROJECTOR procedure=' + procedure);
      return emit(SAFE_PLACEHOLDER);
    }
    const projected = projector(unwrapped.result);
    log('PROJECTED procedure=' + procedure);
    return emit({ procedure: procedure, result: projected });
  } catch (e) {
    log('PROJECTION-ERROR fail-closed: ' + (e && e.message));
    return emit(SAFE_PLACEHOLDER);
  }
});
