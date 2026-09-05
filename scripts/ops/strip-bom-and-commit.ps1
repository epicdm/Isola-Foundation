<#
.SYNOPSIS
  Strip a UTF-8 BOM from one or more named files and commit the result, with
  a proof step that would have caught the 2026-09-05 isola-portal incident.

.DESCRIPTION
  Registered per dec-c360-ops-procedure-registry-2026-09-05 and Isola Agent
  Contract rule 2.2.3 ("a procedure worked out operationally gets registered
  as part of finishing, not as cleanup").

  Incident this guards against: a BOM-strip-and-`git commit --amend`
  sequence on epicdm/isola-portal silently dropped foundation_client.py's
  staged implementation from PR #93's commit b72ca8d, leaving only the test
  file committed. The amend captured only what was freshly `git add`-ed at
  that moment rather than what the caller assumed was staged. CI ran for a
  full session against the original stub before the loss was found — by
  hand, via `git diff <parent> <commit> --stat` — because nothing had
  checked the commit's own content automatically.

  Two things this script does deliberately BECAUSE of that incident:

  1. It never touches the target file with Get-Content/Set-Content or any
     text-mode redirection. PowerShell 5.1 corrupts a UTF-8 round-trip
     through those cmdlets (see project memory
     reference_powershell_utf8_roundtrip_corruption) — that corruption is
     what forced the strip-and-amend in the first place. BOM detection and
     removal here is byte-level ([System.IO.File]::ReadAllBytes /
     WriteAllBytes), the same primitive used to verify the eventual fix.

  2. It commits as a NEW commit, never --amend, and stages exactly the
     named files (never `git add -A`). The incident was itself caused by
     an amend; reusing that operation to "fix" a BOM would reintroduce the
     exact risk this procedure exists to close.

  PROOF STEP (non-negotiable, not a nice-to-have): after committing, this
  diffs the new commit against its OWN parent and asserts every named file
  actually appears in that diff. A commit that "succeeded" is not evidence
  it contains what was intended — this is the check that was missing.
  Fails loudly (non-zero exit, explicit FAIL: line) if any named file did
  not make it into the commit.

.PARAMETER Files
  One or more repo-relative paths to strip and commit. Required. No
  wildcard default, no "whatever is dirty" — the caller names the target.

.PARAMETER Message
  Commit message. Required.

.EXAMPLE
  ./scripts/ops/strip-bom-and-commit.ps1 `
    -Files apps/isola_provisioning/foundation_client.py `
    -Message "fix: strip BOM from foundation_client.py"
#>
param(
    [Parameter(Mandatory=$true)][string[]]$Files,
    [Parameter(Mandatory=$true)][string]$Message
)

$ErrorActionPreference = "Stop"

if ($Files.Count -eq 0) {
    Write-Host "FAIL: no files given — this procedure never guesses a target."
    exit 1
}

$repoRoot = (git rev-parse --show-toplevel).Trim()
if (-not $repoRoot) {
    Write-Host "FAIL: not inside a git repository."
    exit 1
}

$parentBefore = (git rev-parse HEAD).Trim()

foreach ($f in $Files) {
    $full = Join-Path $repoRoot $f
    if (-not (Test-Path $full)) {
        Write-Host "FAIL: $f does not exist at $full"
        exit 1
    }
    $bytes = [System.IO.File]::ReadAllBytes($full)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $stripped = New-Object byte[] ($bytes.Length - 3)
        [System.Array]::Copy($bytes, 3, $stripped, 0, $bytes.Length - 3)
        [System.IO.File]::WriteAllBytes($full, $stripped)
        Write-Host "Stripped BOM: $f"
    } else {
        Write-Host "No BOM present, left unchanged: $f"
    }
}

# Stage EXACTLY the named files. Never `git add -A` — that is how an amend
# or a commit silently picks up, or fails to pick up, something the caller
# did not intend.
git add -- $Files
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: git add failed."
    exit 1
}

git commit -m $Message
if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: git commit failed — nothing to verify."
    exit 1
}

$newCommit = (git rev-parse HEAD).Trim()

# PROOF STEP — the check that was missing. A commit existing is not
# evidence of what it contains.
$diffStat = git diff $parentBefore $newCommit --stat -- $Files
$missing = @()
foreach ($f in $Files) {
    if (-not ($diffStat -match [regex]::Escape($f))) {
        $missing += $f
    }
}

if ($missing.Count -gt 0) {
    Write-Host "FAIL: commit $newCommit does not contain changes to: $($missing -join ', ')"
    Write-Host "This is exactly the failure this procedure exists to catch — the commit exists, but silently dropped a named file."
    exit 1
}

Write-Host "PASS: $newCommit contains changes to all $($Files.Count) named file(s):"
Write-Host $diffStat
