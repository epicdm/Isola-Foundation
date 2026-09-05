<#
.SYNOPSIS
  scripts/ops/lumen-foundation-token-inject.ps1 -- run the Lumen API secret
  injector (/opt/lumen/inject-secrets.sh on host03) and refuse to report
  success unless its own proof step actually passed.

.DESCRIPTION
  WHY THIS EXISTS: /opt/lumen/inject-secrets.sh used to source
  ISOLA_360_SERVICE_TOKEN from isola_isola-lumen (a sibling web service) on
  the untested assumption that it "already holds the byte-identical value" to
  Foundation's own secret. That assumption was false -- a live SHA256
  comparison on 2026-09-06 showed the two values genuinely differed -- and
  every redeploy of isola-lumen-api silently re-injected the wrong token,
  breaking the Customers screen (a 200 response carrying an "unavailable"
  envelope; foundation search/context both refused with 401). This is the
  third time in one day a value-in-two-places drift was found this way (see
  the defect entity this session filed), so per Isola Agent Contract 2.2.3
  the fix is registered here, not left as a one-off SSH session.

  The injector itself (/opt/lumen/inject-secrets.sh) is host03-local, not
  git-tracked -- Contract 2.2 puts the REGISTRY in the repositories, so this
  thin wrapper is what's registered: it runs the injector remotely and reads
  back its own PROOF PASS / PROOF FAIL / PROOF SKIPPED marker line, refusing
  to exit 0 unless a definite PASS or an explained SKIP was printed. A run
  that produces no proof line at all is treated as a failure, not a silent
  pass -- an injector that cannot prove what it injected is not a procedure.

  Never prints a secret value at any layer: inject-secrets.sh is value-blind
  by design (presence and hash-match only), and this wrapper only greps its
  stdout for literal marker text.

.PARAMETER SshTarget
  e.g. epicadmin@66.118.37.110

.EXAMPLE
  scripts/ops/lumen-foundation-token-inject.ps1 -SshTarget epicadmin@66.118.37.110
#>
param(
  [Parameter(Mandatory=$true)][string]$SshTarget
)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$remoteScript = Join-Path $here "lumen-foundation-token-inject-remote.sh"
if (-not (Test-Path $remoteScript)) {
  Write-Host "REFUSED: companion script not found at $remoteScript"
  exit 1
}

$remotePath = "/tmp/lumen-foundation-token-inject-remote-$([guid]::NewGuid().ToString('N').Substring(0,8)).sh"

Write-Host "=== copying injector-runner to ${SshTarget}:${remotePath} ==="
scp -o BatchMode=yes -o ConnectTimeout=10 $remoteScript "${SshTarget}:${remotePath}" 2>&1 | Out-String -Stream
if ($LASTEXITCODE -ne 0) {
  Write-Host "REFUSED: scp failed, cannot run the remote injector."
  exit 1
}

try {
  ssh -o BatchMode=yes -o ConnectTimeout=10 $SshTarget "bash $remotePath"
  $exitCode = $LASTEXITCODE
} finally {
  ssh -o BatchMode=yes -o ConnectTimeout=10 $SshTarget "rm -f $remotePath" 2>&1 | Out-Null
}

exit $exitCode
