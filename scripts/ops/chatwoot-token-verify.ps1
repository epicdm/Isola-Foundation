<#
.SYNOPSIS
  scripts/ops/chatwoot-token-verify.ps1 -- prove CHATWOOT_SERVICE_TOKEN
  actually resolved and works on a live Foundation/C360 stack, on host03.

.DESCRIPTION
  WHY THIS EXISTS: during the PR #121/#122 promotion this was checked three
  separate ad hoc ways in one sitting -- a one-off `docker service logs |
  grep` for the boot line, a one-off psql query for seeded bindings, and a
  one-off curl against Chatwoot's API -- each run once, none re-run
  together, so a token that resolved at boot but was since revoked (or a
  seed that ran against the wrong Chatwoot instance -- see
  reference_chatwoot_two_instances_mcp_points_at_old) could pass any ONE
  layer while the real path stays broken. This runs all three together,
  every time, and refuses to report success unless all three agree.

  DESIGN: this script is a thin local orchestrator. It scp's
  chatwoot-token-verify-remote.sh to host03 and runs it there with simple
  positional args, then deletes the copy. All three layers execute ENTIRELY
  on host03 in one bash process. Measured 2026-09-05: building the layered
  psql/curl command as a single string nested across PowerShell -> ssh ->
  remote-bash corrupted in transit (parentheses and quotes stripped crossing
  the hop -- same family as reference_isola_ssh_deepseek_alias). Shipping
  one file and invoking it plainly avoids the whole class of problem, same
  as this lane's precedent for other complex remote scripts this session.

  THREE LAYERS, per Law 27(a) ("a field's name is a claim; its write-site is
  the truth"): boot log (token was present at container start -- historical),
  DB rows (seeder used it at seed time -- historical), live API call (token
  authenticates RIGHT NOW -- the only layer that proves current liveness).

  Per this repo's own rules: NEVER read .env or /run/secrets/* directly and
  print it. The remote script reads the secret file's bytes only to build a
  curl Authorization header inside its own process; the value never crosses
  back into this script's own output, only the resulting HTTP status.

.PARAMETER SshTarget
  e.g. epicadmin@66.118.37.110

.PARAMETER StackName
  e.g. isola360uat

.PARAMETER ChatwootBaseUrl
  e.g. https://isola-chat.saas00.epic.dm

.PARAMETER InboxIds
  Comma-separated inbox ids to check binding rows for, e.g. "8,12"

.EXAMPLE
  scripts/ops/chatwoot-token-verify.ps1 -SshTarget epicadmin@66.118.37.110 -StackName isola360uat -ChatwootBaseUrl https://isola-chat.saas00.epic.dm -InboxIds "8,12"
#>
param(
  [Parameter(Mandatory=$true)][string]$SshTarget,
  [Parameter(Mandatory=$true)][string]$StackName,
  [Parameter(Mandatory=$true)][string]$ChatwootBaseUrl,
  [Parameter(Mandatory=$true)][string]$InboxIds
)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$remoteScript = Join-Path $here "chatwoot-token-verify-remote.sh"
if (-not (Test-Path $remoteScript)) {
  Write-Host "REFUSED: companion script not found at $remoteScript"
  exit 1
}

$remotePath = "/tmp/chatwoot-token-verify-remote-$([guid]::NewGuid().ToString('N').Substring(0,8)).sh"

Write-Host "=== copying check script to ${SshTarget}:${remotePath} ==="
scp -o BatchMode=yes -o ConnectTimeout=10 $remoteScript "${SshTarget}:${remotePath}" 2>&1 | Out-String -Stream
if ($LASTEXITCODE -ne 0) {
  Write-Host "REFUSED: scp failed, cannot run the remote check."
  exit 1
}

try {
  ssh -o BatchMode=yes -o ConnectTimeout=10 $SshTarget "bash $remotePath '$StackName' '$ChatwootBaseUrl' '$InboxIds'"
  $exitCode = $LASTEXITCODE
} finally {
  ssh -o BatchMode=yes -o ConnectTimeout=10 $SshTarget "rm -f $remotePath" 2>&1 | Out-Null
}

exit $exitCode
