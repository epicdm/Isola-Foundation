/**
 * A deterministic, test-only failpoint.
 *
 * WHY THIS EXISTS
 * ---------------
 * One durability property cannot be proven by timing: the crash window between
 * "Chatwoot has committed the message" and "the ledger has recorded that it
 * did". Four attempts to hit that window with wall-clock fault injection all
 * failed, each for a different reason, because every lever available acts more
 * slowly than a delivery completes. Racing a 200ms window with a 10s tool is
 * not a proof.
 *
 * So the window is made explicit instead. `GATEWAY_FAILPOINT` names one exact
 * point in the pipeline; when armed, the process terminates there.
 *
 * WHAT KEEPS THIS OUT OF PRODUCTION
 * ---------------------------------
 *  - It is inert unless `GATEWAY_FAILPOINT` is set to an exactly-matching known
 *    name. Absent, misspelt, empty or unknown values all disarm it, and an
 *    unknown value is refused at boot rather than ignored.
 *  - When armed it is impossible to miss: an error-level boot line, a boot
 *    warning, and a `failpoint` field on `/healthz`.
 *  - `test/failpoint.test.ts` asserts a production-shaped environment yields
 *    `null`, and that the disarmed failpoint is a pure no-op.
 *  - Production behaviour is UNCHANGED when disarmed: the call site is a single
 *    `await failpoint.trip(...)` that returns immediately. Nothing in the
 *    non-failpoint path was loosened, delayed or made more permissive to make
 *    the test reproducible.
 *
 * It is deliberately NOT compiled out, because a failpoint that only exists in
 * a special build proves a property about a binary nobody deploys.
 */
import type { Logger } from "./log.js";

/**
 * The one supported failpoint.
 *
 * `after_chatwoot_commit_before_ledger_complete` fires in
 * `sendGuardedMessage` after `postMessage` has RETURNED — so Chatwoot has
 * durably accepted the message and its id is known — and before
 * `ledger.complete()` records it. That is exactly the ambiguity that
 * reconciliation exists to resolve.
 */
export const FAILPOINTS = ["after_chatwoot_commit_before_ledger_complete"] as const;
export type FailpointName = (typeof FAILPOINTS)[number];

export function isFailpointName(value: unknown): value is FailpointName {
  return typeof value === "string" && (FAILPOINTS as readonly string[]).includes(value);
}

export interface Failpoint {
  /** The armed failpoint, or null. Reported on /healthz. */
  readonly armed: FailpointName | null;
  /**
   * Trip if `name` is the armed failpoint. When it trips it does NOT return —
   * the process terminates. When disarmed it returns immediately.
   */
  trip(name: FailpointName, context: Record<string, unknown>): Promise<void>;
}

/** The production object: armed is null, `trip` is a no-op. */
export const DISARMED: Failpoint = {
  armed: null,
  async trip(): Promise<void> {
    /* no-op */
  },
};

export interface FailpointOptions {
  armed: FailpointName | null;
  logger: Logger;
  /** Injected in tests so terminating can be observed instead of performed. */
  terminate?: (code: number) => void;
}

export function createFailpoint(options: FailpointOptions): Failpoint {
  if (options.armed === null) return DISARMED;
  const terminate = options.terminate ?? ((code: number) => process.exit(code));
  const armed = options.armed;

  return {
    armed,
    async trip(name, context): Promise<void> {
      if (name !== armed) return;
      options.logger.error({
        event: "failpoint",
        alert: true,
        alertCode: "failpoint_tripped",
        outcome: "terminating",
        failpoint: name,
        ...context,
      });
      // Terminate hard. Not SIGTERM: a graceful shutdown would drain the very
      // work this failpoint exists to interrupt.
      terminate(97);
      // Reached only under an injected `terminate` in tests. Never resolve, so
      // a test cannot accidentally observe the post-failpoint path as if the
      // process had survived.
      await new Promise<never>(() => {});
    },
  };
}
