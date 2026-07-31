/**
 * publish-gate.ts - refuse to publish anything but an exact reviewed HEAD from a
 * clean workspace.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Replit publishes the WORKSPACE FILESYSTEM, not a git branch or a commit. That
 * single fact makes every intuition borrowed from CI wrong here:
 *
 *   - An untracked file is not "not yet in the release". It IS in the release.
 *     It ships. It was simply never reviewed.
 *   - "The tests passed" is not a property of a branch, it is a property of a
 *     filesystem at a moment. If HEAD moved afterwards, the result describes
 *     something that is no longer there.
 *   - Two agent lanes sharing one workspace - observed on 2026-07-30, HEAD
 *     advanced three times during one session from a second lane - means neither
 *     lane's "tree clean, suite green" statement describes what a Publish would
 *     actually deploy. `risk-two-lanes-one-replit-workspace-2026-07-30`.
 *
 * So the gate asserts the filesystem, not the intention: empty porcelain
 * INCLUDING untracked files, HEAD equal to a full reviewed SHA, every intended
 * commit proven an ancestor, and a test result bound to that exact SHA.
 *
 * ── Why a full SHA, always ─────────────────────────────────────────────────
 *
 * A short SHA is a prefix, and a prefix is an invitation to publish a different
 * commit that happens to share it. More practically: a reviewer who writes down
 * `74f6319` and a workspace that has moved to `74f6319f...` plus three commits
 * are indistinguishable to a human eye and identical to a `startsWith` check.
 * Forty hex characters or the gate fails.
 *
 * ── This module is pure ────────────────────────────────────────────────────
 *
 * No git, no filesystem, no process. Everything here is a total function over
 * values, which is what lets the failure modes be tested without constructing a
 * repository - and, more importantly, without going anywhere near production or
 * a real secret. `scripts/publish-gate.ts` is the only thing that runs commands,
 * and it does nothing except gather these inputs and print the verdict.
 */

/** Forty lowercase hex characters. Nothing shorter is a commit identity. */
export const FULL_SHA = /^[0-9a-f]{40}$/

export function isFullSha(value: unknown): boolean {
  return typeof value === 'string' && FULL_SHA.test(value)
}

/**
 * Paths whose change alters what gets deployed or how it boots, rather than only
 * what the code does. A clean worktree already excludes all of them, but they are
 * classified separately so the failure NAMES the dangerous thing instead of
 * reporting a generic dirty tree - "`.env` is modified" and "a test fixture is
 * modified" deserve different reactions from whoever is publishing.
 */
export const DEPLOYMENT_RELEVANT_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env($|\.)/,
  /(^|\/)\.replit$/,
  /(^|\/)replit\.nix$/,
  /(^|\/)next\.config\.[cm]?[jt]s$/,
  /(^|\/)package\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Dockerfile$/,
  /(^|\/)vercel\.json$/,
]

/** Prisma migration directory and the datamodel it must stay in step with. */
export const MIGRATION_DIR_PATTERN = /(^|\/)prisma\/migrations\//
export const SCHEMA_PATTERN = /(^|\/)prisma\/schema\.prisma$/

export interface PorcelainEntry {
  /** Two-character XY status from `git status --porcelain`. */
  status: string
  path: string
  untracked: boolean
}

/**
 * Parse `git status --porcelain --untracked-files=all`.
 *
 * Rename entries (`R  old -> new`) are reduced to the destination path, which is
 * the one that will exist in the published filesystem.
 */
export function parsePorcelain(porcelain: string): PorcelainEntry[] {
  return porcelain
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => {
      const status = line.slice(0, 2)
      let path = line.slice(3)
      const arrow = path.indexOf(' -> ')
      if (arrow !== -1) path = path.slice(arrow + 4)
      return { status, path, untracked: status === '??' }
    })
}

export interface CheckEvidence {
  ok: boolean
  /** The FULL sha the checks were run against. */
  sha: string
  command: string
  timestamp: string
  summary?: string
}

export interface MigrationFacts {
  /**
   * Migration directories present in the working tree but not committed, or
   * committed but modified. Either means the deployed schema step was not
   * reviewed.
   */
  unreviewedMigrationPaths: string[]
  /** True when prisma/schema.prisma changed with no accompanying migration. */
  schemaChangedWithoutMigration: boolean
}

export interface PublishGateInput {
  branch: string
  expectedBranch: string
  /** `git rev-parse HEAD`, read BEFORE the checks. */
  head: string
  /** `git rev-parse HEAD`, read AFTER the checks - must be identical. */
  headAfterChecks?: string
  /** The reviewed SHA, supplied explicitly or from a reviewed manifest. */
  expectedSha: string
  porcelain: string
  /** Every commit the release is asserted to contain. */
  requiredAncestors: { sha: string; isAncestor: boolean }[]
  tests: CheckEvidence | null
  typecheck: CheckEvidence | null
  migrations: MigrationFacts
  /** ISO timestamp for the attestation. Passed in; never read from the clock. */
  now: string
}

export interface GateFailure {
  condition: string
  detail: string
}

export interface PublishGateResult {
  pass: boolean
  failures: GateFailure[]
  lines: string[]
}

function bindsTo(evidence: CheckEvidence | null, head: string): boolean {
  return evidence !== null && evidence.ok === true && evidence.sha === head
}

/**
 * Evaluate the gate. Collects EVERY failure rather than stopping at the first,
 * so one run tells whoever is publishing everything they have to fix.
 */
export function evaluatePublishGate(input: PublishGateInput): PublishGateResult {
  const failures: GateFailure[] = []
  const entries = parsePorcelain(input.porcelain)

  // ── Exact reviewed SHA ────────────────────────────────────────────────────
  if (!isFullSha(input.expectedSha)) {
    failures.push({
      condition: 'expected_sha_not_full',
      detail: `expected SHA must be 40 hex characters, got ${JSON.stringify(input.expectedSha)}`,
    })
  }
  if (!isFullSha(input.head)) {
    failures.push({ condition: 'head_not_full_sha', detail: `HEAD is not a full SHA: ${JSON.stringify(input.head)}` })
  }
  if (isFullSha(input.expectedSha) && isFullSha(input.head) && input.head !== input.expectedSha) {
    failures.push({
      condition: 'head_is_not_the_reviewed_sha',
      detail: `HEAD ${input.head} != reviewed ${input.expectedSha} - the workspace advanced after review`,
    })
  }

  // ── Clean filesystem, untracked included ─────────────────────────────────
  const deploymentRelevant = entries.filter((e) =>
    DEPLOYMENT_RELEVANT_PATTERNS.some((re) => re.test(e.path)),
  )
  if (deploymentRelevant.length > 0) {
    // Named separately and FIRST: this is the class that changes what boots.
    failures.push({
      condition: 'deployment_config_not_clean',
      detail: deploymentRelevant.map((e) => `${e.status} ${e.path}`).join(', '),
    })
  }
  const untracked = entries.filter((e) => e.untracked)
  if (untracked.length > 0) {
    failures.push({
      condition: 'untracked_files_present',
      detail: `${untracked.length} untracked file(s) would be PUBLISHED unreviewed: ${untracked
        .map((e) => e.path)
        .join(', ')}`,
    })
  }
  const modified = entries.filter((e) => !e.untracked)
  if (modified.length > 0) {
    failures.push({
      condition: 'tracked_files_modified',
      detail: modified.map((e) => `${e.status} ${e.path}`).join(', '),
    })
  }

  // ── Branch ───────────────────────────────────────────────────────────────
  if (input.expectedBranch && input.branch !== input.expectedBranch) {
    failures.push({
      condition: 'unexpected_branch',
      detail: `on ${input.branch}, expected ${input.expectedBranch}`,
    })
  }

  // ── Intended ancestry ────────────────────────────────────────────────────
  if (input.requiredAncestors.length === 0) {
    failures.push({
      condition: 'no_required_ancestry_asserted',
      detail: 'the release must state which commits it contains - assert them or supply a manifest',
    })
  }
  for (const a of input.requiredAncestors) {
    if (!isFullSha(a.sha)) {
      failures.push({
        condition: 'required_ancestor_not_full_sha',
        detail: `required ancestor must be a full SHA: ${JSON.stringify(a.sha)}`,
      })
      continue
    }
    if (!a.isAncestor) {
      failures.push({
        condition: 'required_commit_missing',
        detail: `${a.sha} is not an ancestor of HEAD`,
      })
    }
  }

  // ── Checks, bound to THIS head ───────────────────────────────────────────
  if (!input.typecheck) {
    failures.push({ condition: 'typecheck_missing', detail: 'no typecheck result' })
  } else if (!input.typecheck.ok) {
    failures.push({ condition: 'typecheck_failed', detail: input.typecheck.summary ?? 'typecheck failed' })
  } else if (input.typecheck.sha !== input.head) {
    failures.push({
      condition: 'typecheck_result_belongs_to_another_head',
      detail: `typecheck ran at ${input.typecheck.sha}, HEAD is ${input.head}`,
    })
  }

  if (!input.tests) {
    failures.push({ condition: 'tests_missing', detail: 'no test result' })
  } else if (!input.tests.ok) {
    failures.push({ condition: 'tests_failed', detail: input.tests.summary ?? 'tests failed' })
  } else if (input.tests.sha !== input.head) {
    failures.push({
      condition: 'test_result_belongs_to_another_head',
      detail: `tests ran at ${input.tests.sha}, HEAD is ${input.head}`,
    })
  }

  // HEAD must not have moved while the checks ran. In a workspace shared by two
  // lanes this is not paranoia - it is the observed behaviour.
  if (input.headAfterChecks !== undefined && input.headAfterChecks !== input.head) {
    failures.push({
      condition: 'head_moved_during_checks',
      detail: `HEAD was ${input.head} before the checks and ${input.headAfterChecks} after - another lane committed`,
    })
  }

  // ── Migrations ───────────────────────────────────────────────────────────
  if (input.migrations.unreviewedMigrationPaths.length > 0) {
    failures.push({
      condition: 'unreviewed_migration_change',
      detail: input.migrations.unreviewedMigrationPaths.join(', '),
    })
  }
  if (input.migrations.schemaChangedWithoutMigration) {
    failures.push({
      condition: 'schema_changed_without_migration',
      detail: 'prisma/schema.prisma changed with no committed migration - a Publish would diff dev against prod and emit DROPs',
    })
  }

  const lines = renderAttestation(input, failures)
  return { pass: failures.length === 0, failures, lines }
}

/** Derive the migration facts from a porcelain listing. */
export function migrationFactsFromPorcelain(porcelain: string): MigrationFacts {
  const entries = parsePorcelain(porcelain)
  const migrationPaths = entries.filter((e) => MIGRATION_DIR_PATTERN.test(e.path)).map((e) => `${e.status} ${e.path}`)
  const schemaTouched = entries.some((e) => SCHEMA_PATTERN.test(e.path))
  return {
    unreviewedMigrationPaths: migrationPaths,
    // A dirty schema with no dirty migration is the dangerous shape: the
    // datamodel moved and no reviewed migration accompanies it.
    schemaChangedWithoutMigration: schemaTouched && migrationPaths.length === 0,
  }
}

/**
 * The release attestation.
 *
 * On failure it states the failed conditions and never prints a partial pass -
 * there is no line that could be read as approval. No value from any
 * deployment-config file is echoed, only its path, so the attestation can be
 * pasted into Port without leaking a secret.
 */
export function renderAttestation(input: PublishGateInput, failures: GateFailure[]): string[] {
  const ok = failures.length === 0
  const lines: string[] = [
    '── Isola publish gate ────────────────────────────────────',
    `branch            ${input.branch}${input.expectedBranch ? ` (expected ${input.expectedBranch})` : ''}`,
    `HEAD              ${input.head}`,
    `reviewed SHA      ${input.expectedSha}`,
    `clean worktree    ${parsePorcelain(input.porcelain).length === 0 ? 'yes (untracked included)' : 'NO'}`,
    `required ancestry ${
      input.requiredAncestors.length === 0
        ? 'NONE ASSERTED'
        : input.requiredAncestors.map((a) => `${a.sha.slice(0, 12)}=${a.isAncestor ? 'ok' : 'MISSING'}`).join(' ')
    }`,
    `tests             ${input.tests ? `${input.tests.ok ? 'pass' : 'FAIL'} @ ${input.tests.sha} ${input.tests.summary ?? ''}`.trim() : 'MISSING'}`,
    `typescript        ${input.typecheck ? `${input.typecheck.ok ? 'pass' : 'FAIL'} @ ${input.typecheck.sha}` : 'MISSING'}`,
    `migrations/config ${
      input.migrations.unreviewedMigrationPaths.length === 0 && !input.migrations.schemaChangedWithoutMigration
        ? 'clean'
        : 'NOT CLEAN'
    }`,
    `timestamp         ${input.now}`,
  ]
  if (!ok) {
    lines.push('── failed conditions ─────────────────────────────────────')
    for (const f of failures) lines.push(`  ${f.condition}: ${f.detail}`)
  }
  lines.push(`PUBLISH_GATE=${ok ? 'PASS' : 'FAIL'}`)
  return lines
}

// ── Reviewed release manifest ───────────────────────────────────────────────

export interface ReleaseManifest {
  branch: string
  expectedSha: string
  requiredAncestors: string[]
}

/**
 * Parse a reviewed manifest. Refuses anything it cannot fully validate, because
 * a manifest that silently drops a required ancestor is worse than no manifest:
 * the gate would pass while proving less than the reviewer asked for.
 */
export function parseReleaseManifest(raw: unknown): { ok: true; manifest: ReleaseManifest } | { ok: false; why: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, why: 'manifest must be an object' }
  const m = raw as Record<string, unknown>
  const branch = typeof m.branch === 'string' ? m.branch.trim() : ''
  if (!branch) return { ok: false, why: 'manifest.branch is required' }
  if (!isFullSha(m.expectedSha)) return { ok: false, why: 'manifest.expectedSha must be a full 40-char SHA' }
  if (!Array.isArray(m.requiredAncestors) || m.requiredAncestors.length === 0) {
    return { ok: false, why: 'manifest.requiredAncestors must be a non-empty array' }
  }
  for (const a of m.requiredAncestors) {
    if (!isFullSha(a)) return { ok: false, why: `manifest.requiredAncestors contains a non-full SHA: ${String(a)}` }
  }
  return {
    ok: true,
    manifest: {
      branch,
      expectedSha: m.expectedSha as string,
      requiredAncestors: m.requiredAncestors as string[],
    },
  }
}
