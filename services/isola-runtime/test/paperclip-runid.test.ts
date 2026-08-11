/**
 * Paperclip returns a bare 500 whenever `X-Paperclip-Run-Id` names a run it cannot
 * resolve. Verified against the live instance:
 *
 *   POST /api/issues/{id}/comments, no header                -> 201
 *   POST /api/issues/{id}/comments, run id "dup-12345"       -> 500
 *   POST /api/issues/{id}/comments, unknown but valid UUID   -> 500
 *
 * In normal operation Paperclip hands the runtime a real run id, so this never fires.
 * But a stale or replayed run id would otherwise destroy the employee's output on every
 * callback — the comment, the transition and the cost event all go through this client.
 * Losing the work is worse than losing the attribution, so we retry once without it.
 */
import { describe, expect, it } from "vitest";

import { HttpPaperclipApi } from "../src/paperclip.js";
import { PaperclipApiError } from "../src/errors.js";

const CALL = { apiKey: "agent-key", runId: "not-a-real-run" };

function fetchStub(behaviour: (hasRunId: boolean, attempt: number) => number) {
  const seen: Array<{ hasRunId: boolean; url: string }> = [];
  let attempt = 0;
  const safeFetch = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const hasRunId = "x-paperclip-run-id" in headers;
    seen.push({ hasRunId, url });
    const status = behaviour(hasRunId, attempt++);
    return new Response(status === 204 ? null : JSON.stringify({ ok: status < 400 }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as never;
  return { safeFetch, seen };
}

const api = (safeFetch: never) =>
  new HttpPaperclipApi({ baseUrl: "https://paperclip.test", safeFetch });

describe("X-Paperclip-Run-Id 500 fallback", () => {
  it("sends the run id on the first attempt", async () => {
    const { safeFetch, seen } = fetchStub(() => 201);
    await api(safeFetch).postComment("issue-1", "hello", CALL);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.hasRunId).toBe(true);
  });

  it("retries once without the run id when Paperclip 500s, and succeeds", async () => {
    const { safeFetch, seen } = fetchStub((hasRunId) => (hasRunId ? 500 : 201));
    await expect(api(safeFetch).postComment("issue-1", "hello", CALL)).resolves.toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(seen[0]!.hasRunId).toBe(true);
    expect(seen[1]!.hasRunId).toBe(false);
  });

  it("applies the fallback to transitions too — the loop fix depends on it", async () => {
    const { safeFetch, seen } = fetchStub((hasRunId) => (hasRunId ? 500 : 200));
    await expect(
      api(safeFetch).patchIssueStatus("issue-1", "done", CALL),
    ).resolves.toBeUndefined();
    expect(seen.map((s) => s.hasRunId)).toEqual([true, false]);
  });

  it("gives up after the single retry rather than looping", async () => {
    const { safeFetch, seen } = fetchStub(() => 500);
    await expect(api(safeFetch).postComment("issue-1", "hello", CALL)).rejects.toBeInstanceOf(
      PaperclipApiError,
    );
    expect(seen).toHaveLength(2);
  });

  it("does not retry a 4xx — that is a real refusal, not a run-id artefact", async () => {
    const { safeFetch, seen } = fetchStub(() => 403);
    await expect(api(safeFetch).postComment("issue-1", "hello", CALL)).rejects.toBeInstanceOf(
      PaperclipApiError,
    );
    expect(seen).toHaveLength(1);
  });

  it("does not retry when there was no run id to blame", async () => {
    const { safeFetch, seen } = fetchStub(() => 500);
    await expect(
      api(safeFetch).postComment("issue-1", "hello", { apiKey: "k", runId: null }),
    ).rejects.toBeInstanceOf(PaperclipApiError);
    expect(seen).toHaveLength(1);
  });
});
