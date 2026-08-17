/**
 * X-Paperclip-Run-Id — PROVENANCE, NOT RETRY.
 *
 * REWRITTEN 2026-08-17. This file used to assert a fallback: send the run id,
 * and if Paperclip 500s, retry once without it. That fallback is gone, and the
 * reason it is gone is the whole point of the file.
 *
 * The header lands in `req.actor.runId` and is written into
 * `issue_comments.created_by_run_id` and `cost_events.heartbeat_run_id`. Both
 * are FOREIGN KEYS into `heartbeat_runs`, a table only Paperclip populates. So
 * an id Paperclip did not issue is not "attribution that might not resolve" —
 * it is a value the database is guaranteed to reject.
 *
 * MEASURED ON THE LIVE ESTATE, 2026-08-17:
 *   · 53 × HTTP 500 on the comments endpoint in one window — the gateway path
 *     sent its own delivery id, so EVERY customer reply cost a guaranteed 500.
 *   · The retry usually rescued it, which is why this looked healthy.
 *   · At 20:18:43 the RETRY ITSELF failed with a transport error, and the
 *     model's answer was generated, billed, and WITHHELD from the customer.
 *
 * The old file's own comment said "losing the work is worse than losing the
 * attribution". Correct — and the conclusion should have been to stop sending a
 * value that could never work, not to build a rescue for it. A retry that
 * changes the request is a different request wearing a retry's clothes.
 *
 * `call.runId` is now only ever a Paperclip-issued id (see app.ts's
 * `paperclipRunId`), so there is nothing to strip and nothing to rescue.
 */
import { describe, expect, it } from "vitest";

import { HttpPaperclipApi } from "../src/paperclip.js";
import { PaperclipApiError } from "../src/errors.js";

function fetchStub(status: (attempt: number) => number) {
  const seen: Array<{ hasRunId: boolean; runId: string | undefined; url: string }> = [];
  let attempt = 0;
  const safeFetch = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    seen.push({
      hasRunId: "x-paperclip-run-id" in headers,
      runId: headers["x-paperclip-run-id"],
      url,
    });
    const code = status(attempt++);
    return new Response(code === 204 ? null : JSON.stringify({ ok: code < 400 }), {
      status: code,
      headers: { "content-type": "application/json" },
    });
  }) as never;
  return { safeFetch, seen };
}

const api = (safeFetch: never) =>
  new HttpPaperclipApi({ baseUrl: "https://paperclip.test", safeFetch });

describe("the header is sent only when Paperclip issued the id", () => {
  it("sends it when there IS a Paperclip run id", async () => {
    const { safeFetch, seen } = fetchStub(() => 201);
    await api(safeFetch).postComment("issue-1", "hello", {
      apiKey: "agent-key",
      runId: "real-paperclip-run",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.runId).toBe("real-paperclip-run");
  });

  /**
   * THE CUSTOMER PATH. The gateway supplies its own delivery id, so app.ts
   * resolves `paperclipRunId` to null and the header is omitted entirely.
   * Paperclip then writes `created_by_run_id: null`, which the column allows —
   * that is why omitting is a supported shape and not a workaround.
   */
  it("omits it entirely when there is none — null is the honest value", async () => {
    const { safeFetch, seen } = fetchStub(() => 201);
    await api(safeFetch).postComment("issue-1", "hello", { apiKey: "agent-key", runId: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.hasRunId).toBe(false);
  });
});

describe("NO retry-that-mutates", () => {
  /**
   * The removed behaviour, asserted as removed. A 500 is now a 500: it is
   * reported, not silently re-attempted with a different request.
   */
  it("does not retry a 500 with the header stripped", async () => {
    const { safeFetch, seen } = fetchStub(() => 500);
    await expect(
      api(safeFetch).postComment("issue-1", "hello", {
        apiKey: "agent-key",
        runId: "real-paperclip-run",
      }),
    ).rejects.toBeInstanceOf(PaperclipApiError);
    expect(seen, "exactly one attempt — no second, mutated request").toHaveLength(1);
    expect(seen[0]!.hasRunId).toBe(true);
  });

  it("does not retry a 4xx either", async () => {
    const { safeFetch, seen } = fetchStub(() => 403);
    await expect(
      api(safeFetch).postComment("issue-1", "hello", { apiKey: "agent-key", runId: "r" }),
    ).rejects.toBeInstanceOf(PaperclipApiError);
    expect(seen).toHaveLength(1);
  });

  it("a transition behaves identically — one attempt, header per provenance", async () => {
    const { safeFetch, seen } = fetchStub(() => 200);
    await api(safeFetch).patchIssueStatus("issue-1", "done", { apiKey: "k", runId: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.hasRunId).toBe(false);
  });
});
