/**
 * Post-run callbacks into Paperclip: the issue transition, and the comments
 * that are not the run's own write-back.
 *
 * THE LOOP FIX
 * ------------
 * One wakeup produced 53 runs. `heartbeat.enabled = false` only stops the
 * *timer*: Paperclip keeps re-scheduling an employee that still has an
 * actionable assigned issue, and the `http` adapter cannot transition an issue,
 * so the work never completes and the agent is woken again, and again.
 *
 * The fix is that this runtime transitions the issue itself, with the
 * employee's own agent key:
 *
 *   success              -> in_review   (a human reviews the output)
 *   unrecoverable failure-> blocked     (named owner + exact next action)
 *
 * Both statuses take the issue out of the actionable set, which is what
 * actually breaks the loop. Every non-success outcome is treated as
 * unrecoverable *from this runtime's point of view*: it has no retry loop of
 * its own, and leaving the issue actionable so Paperclip can retry is the exact
 * behaviour that produced the 53 runs. A human decides whether to retry.
 *
 * If no issue can be resolved from the run context, nothing is transitioned and
 * nothing is guessed — the runtime logs `no_issue_context` and returns the HTTP
 * status the model outcome earned.
 */
import type { Logger } from "./log.js";
import { PaperclipApiError } from "./errors.js";
import type { IssueStatus, PaperclipApi, PaperclipCall } from "./paperclip.js";
import type { RunStatus } from "./recorder.js";

export interface HandoffPolicy {
  successStatus: IssueStatus;
  failureStatus: IssueStatus;
  /** The human or team that picks a blocked issue up. Never invented. */
  owner: string;
}

export const DEFAULT_HANDOFF: HandoffPolicy = Object.freeze({
  successStatus: "in_review",
  failureStatus: "blocked",
  owner: "the EPIC operations on-call engineer",
});

export function statusForRun(run: RunStatus, policy: HandoffPolicy): IssueStatus {
  return run === "succeeded" ? policy.successStatus : policy.failureStatus;
}

/**
 * The exact next action for each failure category. Concrete, addressed to a
 * human, and never phrased as something this runtime has done or will do.
 */
export function nextActionFor(run: RunStatus): string {
  switch (run) {
    case "succeeded":
      return "Review the output above and move the issue on, or send it back with corrections.";
    case "timed_out":
      return "Check the model provider's status, then re-run this issue manually once it is answering. If it times out again, raise the runtime's model deadline or split the work.";
    case "provider_error":
      return "Check the model provider's status page and the runtime's MODEL_API_KEY, then re-run this issue manually.";
    case "internal_error":
      return "Read the isola-runtime log line carrying this correlation id, fix the fault, then re-run this issue manually.";
    default:
      return "Investigate the runtime log line carrying this correlation id and re-run this issue manually.";
  }
}

export interface TransitionOutcome {
  attempted: boolean;
  transitioned: boolean;
  status: IssueStatus | null;
  failureCategory: string | null;
}

const NOT_ATTEMPTED: TransitionOutcome = Object.freeze({
  attempted: false,
  transitioned: false,
  status: null,
  failureCategory: null,
});

/**
 * Move the issue. Never throws: a transition failure must not flip a successful
 * model run into a failed HTTP status, exactly as a recorder failure does not.
 */
export async function transitionIssue(args: {
  api: PaperclipApi | null;
  issueId: string | null;
  status: IssueStatus;
  call: PaperclipCall | null;
  logger: Logger;
  correlationId: string;
  runId: string | null;
  agentId: string | null;
}): Promise<TransitionOutcome> {
  if (args.api === null || args.call === null) return { ...NOT_ATTEMPTED };
  if (args.issueId === null || args.issueId.length === 0) {
    args.logger.warn({
      event: "transition",
      outcome: "no_issue_context",
      correlationId: args.correlationId,
      runId: args.runId,
      agentId: args.agentId,
      detail:
        "no issue id could be resolved from the run context; nothing was transitioned and no issue id was guessed",
    });
    return { ...NOT_ATTEMPTED };
  }

  try {
    await args.api.patchIssueStatus(args.issueId, args.status, args.call);
    args.logger.info({
      event: "transition",
      outcome: "issue_transitioned",
      correlationId: args.correlationId,
      runId: args.runId,
      agentId: args.agentId,
      issueId: args.issueId,
      issueStatus: args.status,
    });
    return { attempted: true, transitioned: true, status: args.status, failureCategory: null };
  } catch (err) {
    const detail =
      err instanceof PaperclipApiError ? err.detail : "issue transition failed";
    args.logger.error({
      event: "transition",
      outcome: "issue_transition_failed",
      correlationId: args.correlationId,
      runId: args.runId,
      agentId: args.agentId,
      issueId: args.issueId,
      issueStatus: args.status,
      failureCategory: detail,
    });
    return { attempted: true, transitioned: false, status: args.status, failureCategory: detail };
  }
}

/**
 * The 80% budget alert, as a clearly-marked comment. Rendered separately from
 * the run's own write-back so it can never be mistaken for the model's answer.
 */
export function renderBudgetAlertComment(args: {
  usedPct: number;
  budgetCents: number;
  alertPct: number;
  agentId: string | null;
  correlationId: string;
}): string {
  const pct = Math.round(args.usedPct * 10) / 10;
  return [
    `> **BUDGET ALERT — this is not model output.**`,
    "",
    `This employee has used **${pct}%** of its monthly budget of ${args.budgetCents} cents (alert threshold ${args.alertPct}%).`,
    "",
    `Runs continue until 100%. At 100% the Isola runtime rejects the invocation **before** calling the model provider and pauses the employee through the Paperclip API.`,
    "",
    `Owner action: raise the budget in Paperclip, or let the employee stop. No spend has been suppressed and no figure here was estimated — this is measured usage priced at the configured provider rates.`,
    "",
    `agentId \`${args.agentId ?? "unknown"}\` · correlationId \`${args.correlationId}\``,
  ].join("\n");
}

/** The 100% rejection comment. Posted only when an issue is resolvable. */
export function renderBudgetExhaustedComment(args: {
  usedPct: number;
  budgetCents: number;
  agentId: string | null;
  owner: string;
  correlationId: string;
  paused: boolean;
}): string {
  const pct = Math.round(args.usedPct * 10) / 10;
  return [
    `> **BUDGET EXHAUSTED — this is not model output.**`,
    "",
    `This run was rejected **before the model provider was called**. Nothing was spent on it.`,
    "",
    `Monthly budget: ${args.budgetCents} cents. Committed: **${pct}%**, including cost this runtime has measured but Paperclip has not yet confirmed.`,
    "",
    args.paused
      ? `The employee has been paused through the Paperclip API.`
      : `The employee could not be paused automatically — pause it in Paperclip.`,
    "",
    `Owner: ${args.owner}.`,
    `Next action: raise this employee's monthly budget in Paperclip, or leave it paused and reassign the issue to a human.`,
    "",
    `agentId \`${args.agentId ?? "unknown"}\` · correlationId \`${args.correlationId}\``,
  ].join("\n");
}

/**
 * Post a comment that is not the run write-back. Never throws — an alert that
 * could not be posted is logged and the run carries on.
 */
export async function postNoticeComment(args: {
  api: PaperclipApi | null;
  issueId: string | null;
  body: string;
  call: PaperclipCall | null;
  logger: Logger;
  correlationId: string;
  outcome: string;
}): Promise<boolean> {
  if (args.api === null || args.call === null) return false;
  if (args.issueId === null || args.issueId.length === 0) return false;
  try {
    await args.api.postComment(args.issueId, args.body, args.call);
    return true;
  } catch (err) {
    args.logger.warn({
      event: "notice_comment",
      outcome: `${args.outcome}_comment_failed`,
      correlationId: args.correlationId,
      issueId: args.issueId,
      failureCategory:
        err instanceof PaperclipApiError ? err.detail : "notice comment failed",
    });
    return false;
  }
}
