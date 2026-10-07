/**
 * releaseTrain01.ts
 *
 * IMPORTANT CONTEXT: the Isola Port organization has NO `release_gate`
 * blueprint. There is no first-class "release board" entity type in
 * Port at all. What follows is a server-side DERIVED view: a static list
 * of gate definitions for "Release Train 01," each mapped to real,
 * already-confirmed-live Port entity ids (build_task / requirement).
 * get_release_board (in tools.ts) merges this static list with live
 * status lookups for the mapped entity ids to produce the board.
 *
 * The entity ids below were confirmed to exist in Port by a prior
 * session's live read (do not re-derive/re-query to "confirm" them
 * again — this file just encodes that known-good mapping):
 *   - bt-release-control-implementation (build_task, status Backlog)
 *   - bt-device-b-external-p8 (build_task, status Backlog)
 *   - req-p00-external-p8-evidence (requirement, status Blocked)
 *   - bt-clawith-staging-credential (build_task, status Backlog)
 *   - bt-pr22-disposition (build_task, status Backlog)
 *   - req-p00-unified-wa-send-gate (requirement, status Verified)
 *   - bt-pilot-consent-execution (build_task, status Backlog)
 */

export interface GateEntityRef {
  id: string;
  blueprint: "build_task" | "requirement" | "decision" | "defect";
}

export interface GateDefinition {
  gateId: string;
  gateName: string;
  entities: GateEntityRef[];
  /** Free-text note on gaps/limitations for this gate, surfaced in evidence lookups. */
  note?: string;
}

export const RELEASE_TRAIN_01: GateDefinition[] = [
  {
    gateId: "gate-1-release-boundary-enforcement",
    gateName: "§9 release-boundary enforcement",
    entities: [{ id: "bt-release-control-implementation", blueprint: "build_task" }]
  },
  {
    gateId: "gate-2-device-b-external-p8",
    gateName: "Device B external P8",
    entities: [
      { id: "bt-device-b-external-p8", blueprint: "build_task" },
      { id: "req-p00-external-p8-evidence", blueprint: "requirement" }
    ]
  },
  {
    gateId: "gate-3-clawith-staging-parity",
    gateName: "Clawith staging parity",
    entities: [{ id: "bt-clawith-staging-credential", blueprint: "build_task" }]
  },
  {
    gateId: "gate-4-p0-0-pr-review-merge",
    gateName: "P0-0 PR review+merge",
    entities: [
      { id: "bt-pr22-disposition", blueprint: "build_task" },
      { id: "req-p00-unified-wa-send-gate", blueprint: "requirement" }
    ]
  },
  {
    gateId: "gate-5-consent-rollout-execution",
    gateName: "Consent-rollout execution",
    entities: [{ id: "bt-pilot-consent-execution", blueprint: "build_task" }]
  },
  {
    gateId: "gate-6-production-deploy-approval",
    gateName: "Production deploy approval",
    entities: [],
    note: "No dedicated Port entity exists yet for this gate. evidenceRefs is intentionally empty and status is derived/unknown until a tracking entity (e.g. a build_task or requirement) is created in Port for production deploy approval. This is a known documentation gap, not a bug in this server."
  }
];

export function findGate(gateId: string): GateDefinition | undefined {
  return RELEASE_TRAIN_01.find((g) => g.gateId === gateId || g.gateName === gateId);
}

