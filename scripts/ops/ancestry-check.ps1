<#
.SYNOPSIS
  scripts/ops/ancestry-check.ps1 -- verify a commit is a real ancestor of a
  target branch, from a machine that actually has git/gh history.

.DESCRIPTION
  WHY THIS EXISTS: the C360 deploy guard (dec-c360-deploy-ancestry-guard-
  2026-09-05) needs an ancestry verdict baked into a Docker image label
  BEFORE it reaches host03, because host03 has no git or gh credentials and
  cannot check its own ancestry. That check was written inline, once, inside
  remote-build.sh's own body. This is the same logic pulled out so the bff-v2
  deploy path and any future guard can call one checked, tested thing
  instead of a second hand-rolled `gh api compare` call.

  WHY POWERSHELL, NOT BASH: this script runs on the release lane's own
  Windows machine, which is where `gh` and full git history actually live --
  never on host03 or deepseek (neither has git/gh credentials, which is the
  whole reason this check exists off-host). Measured 2026-09-05: invoking
  `gh.exe` from WSL/Git-Bash on this machine via interop hung indefinitely on
  the API call with zero output, while the identical `gh api` call run
  natively from PowerShell returned in under a second. Bash is the right
  tool for the host03/deepseek side of this release lane (those are Linux
  hosts); PowerShell is the right tool here, on the machine that actually
  holds the credentials -- see reference_isola_ssh_deepseek_alias and this
  session's own established preference for PowerShell over Git Bash.

  TWO INDEPENDENT CHECKS, both must agree:
    1. `gh api repos/<owner>/<repo>/compare/<ref>...<sha>` -- status/ahead_by/
       behind_by from GitHub's own graph.
    2. `git merge-base --is-ancestor <sha> <ref>` against a local clone with
       full history -- belt-and-braces per this repo's own precedent (a
       stale local `origin/<branch>` cache has burned this lane before; see
       feedback_fetch_then_quote_the_sha_never_the_ref). `git fetch` runs
       first so a stale cache cannot produce a false pass.

  OUTPUT CONTRACT: the last line is exactly `ANCESTRY_VERIFIED=YES`,
  `ANCESTRY_VERIFIED=NO`, or `ANCESTRY_VERIFIED=UNKNOWN` -- machine-parseable
  by remote-build.sh and any deploy script. Exit code 0 only on YES; 1 on NO
  *and* on any inability to determine the answer (network failure, missing
  repo, bad sha). Per Law 23 (an ambiguous negative is not a finding): if
  this script cannot determine ancestry, it says UNKNOWN rather than
  defaulting to either YES or NO.

.PARAMETER Repo
  "owner/repo", e.g. epicdm/isolav2

.PARAMETER Sha
  Candidate commit sha to check.

.PARAMETER Ref
  Target ref/branch, e.g. main.

.PARAMETER CloneDir
  Local path to a git checkout of Repo with network access to fetch it.
  Defaults to the current directory.

.EXAMPLE
  scripts/ops/ancestry-check.ps1 -Repo epicdm/isolav2 -Sha e64cbe16... -Ref main -CloneDir C:\epic-workspace\isolav2-release-lane
#>
param(
  [Parameter(Mandatory=$true)][string]$Repo,
  [Parameter(Mandatory=$true)][string]$Sha,
  [Parameter(Mandatory=$true)][string]$Ref,
  [string]$CloneDir = "."
)

function Fail-Unknown([string]$Reason) {
  Write-Host "REASON: $Reason"
  Write-Host "ANCESTRY_VERIFIED=UNKNOWN"
  exit 1
}

Write-Host "=== ancestry-check: is $Sha an ancestor of ${Repo}@${Ref}? ==="

Write-Host "--- check 1: GitHub API compare (authoritative graph) ---"
try {
  $compareJson = gh api "repos/$Repo/compare/$Ref...$Sha" 2>&1
  if ($LASTEXITCODE -ne 0) { Fail-Unknown "gh api compare failed: $compareJson" }
} catch {
  Fail-Unknown "gh api compare threw: $_"
}
try {
  $compare = $compareJson | ConvertFrom-Json
} catch {
  Fail-Unknown "gh api compare returned non-JSON: $compareJson"
}
Write-Host "  status=$($compare.status) ahead_by=$($compare.ahead_by) behind_by=$($compare.behind_by)"
# Ref...Sha: Sha is an ancestor of Ref iff Ref is 'behind' or 'identical' to
# Sha in this comparison direction -- i.e. Sha introduces nothing Ref does
# not already have. 'ahead' or 'diverged' means it does not.
switch ($compare.status) {
  { $_ -in @('identical', 'behind') } { $apiVerdict = 'YES' }
  { $_ -in @('ahead', 'diverged') }   { $apiVerdict = 'NO' }
  default { Fail-Unknown "unrecognized compare status: '$($compare.status)'" }
}
Write-Host "  API_VERDICT=$apiVerdict"

Write-Host "--- check 2: local git merge-base --is-ancestor, against a freshly fetched clone ---"
if (-not (Test-Path (Join-Path $CloneDir ".git"))) {
  Fail-Unknown "no git checkout at '$CloneDir' -- pass -CloneDir pointing at a local clone of $Repo"
}
Push-Location $CloneDir
try {
  git fetch origin $Ref --quiet 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail-Unknown "git fetch origin $Ref failed" }
  git cat-file -e "$Sha^{commit}" 2>$null
  if ($LASTEXITCODE -ne 0) {
    git fetch origin $Sha --quiet 2>$null | Out-Null
  }
  git merge-base --is-ancestor $Sha FETCH_HEAD 2>$null
  if ($LASTEXITCODE -eq 0) {
    $gitVerdict = 'YES'
  } else {
    git merge-base --is-ancestor $Sha "origin/$Ref" 2>$null
    $gitVerdict = if ($LASTEXITCODE -eq 0) { 'YES' } else { 'NO' }
  }
} finally {
  Pop-Location
}
Write-Host "  GIT_VERDICT=$gitVerdict"

Write-Host "--- verdict ---"
if ($apiVerdict -eq $gitVerdict) {
  Write-Host "  both checks agree: $apiVerdict"
  Write-Host "ANCESTRY_VERIFIED=$apiVerdict"
  if ($apiVerdict -eq 'YES') { exit 0 } else { exit 1 }
} else {
  Fail-Unknown "checks DISAGREE (api=$apiVerdict, git=$gitVerdict) -- per Law 18 (partial agreement is more dangerous than total disagreement), do not average or pick one; re-run against a fresh clone before trusting either."
}
