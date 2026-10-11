<#
20-host04-verify-external.ps1  --  EXTERNAL exposure verification for host04 (66.118.37.29).
Runs from the Lane A WORKSTATION (PowerShell 5.1+). Read-only: TCP connects and one HTTP GET per probe,
no payloads, no credentials. Never run it from host04 itself (loopback proves nothing).

VANTAGES (what each one can and cannot prove)
  local        = this workstation, egress 66.118.37.10. It is the ADMIN source in the firewall plan.
                 It is in the SAME /22 as host04 (66.118.36.0/22): it proves HOST rules, not the upstream path.
  ssh <alias>  = a second machine reached with `ssh -o BatchMode=yes <alias>`; it runs bash /dev/tcp probes.
                 Default: `deepseek` (66.118.37.12, NON-admin). It is ALSO in 66.118.36.0/22 and also has
                 global IPv6 in the same /64, so it proves "a non-admin source is refused by the host",
                 not "the internet cannot reach it". Per host03 precedent (defect-host03-easypanel-console-world-
                 reachable-2026-08-12) a same-subnet probe is NOT proof of internet exposure.
                 For an off-net vantage add one with -SshVantages (a cloud shell/VM you control) or ask the
                 owner to run the one-liner printed at the end from a phone hotspot.

CONTROLS (law 13/19/23: a block means nothing unless the same vantage can reach something)
  Every vantage must reach a CONTROL port. WebMode public: 443. WebMode restricted: 22 for the admin vantage.
  If the control is not OPEN from a vantage, that vantage's rows are INCONCLUSIVE, not PASS.

USAGE
  pwsh/powershell -File .\20-host04-verify-external.ps1 -Phase Baseline     # before any change
  pwsh/powershell -File .\20-host04-verify-external.ps1 -Phase After        # after apply/confirm
  Options: -SshVantages deepseek,othervm  -AdminIps 66.118.37.10  -WebMode public|restricted
#>
[CmdletBinding()]
param(
  [ValidateSet('Baseline','After')][string]$Phase = 'Baseline',
  [string]$Target  = '66.118.37.29',
  [string]$Target6 = '2602:fc3a:1:0:250:56ff:fea4:b47d',
  [string]$TailscaleIp = '100.116.115.19',
  [string[]]$SshVantages = @('deepseek'),
  [string[]]$AdminIps = @('66.118.37.10'),
  [ValidateSet('public','restricted')][string]$WebMode = 'public',
  [string]$OutDir = '',
  [int]$TimeoutMs = 4000
)
$ErrorActionPreference = 'Stop'
if (-not $OutDir) { $OutDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { (Get-Location).Path } }
$ports = @(
  @{Port=22;   Name='ssh';           Policy='admin'},
  @{Port=3000; Name='easypanel-console'; Policy='admin'},
  @{Port=2377; Name='swarm-manager'; Policy='none'},
  @{Port=7946; Name='swarm-gossip';  Policy='none'},
  @{Port=80;   Name='traefik-http';  Policy='web'},
  @{Port=443;  Name='traefik-https'; Policy='web'}
)

function Test-TcpLocal([string]$ip,[int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect($ip,$port,$null,$null)
    if (-not $ar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return 'TIMEOUT' }
    try { $c.EndConnect($ar); return 'OPEN' } catch [System.Net.Sockets.SocketException] {
      if ($_.Exception.SocketErrorCode -eq 'ConnectionRefused') { return 'REFUSED' } else { return 'ERROR:' + $_.Exception.SocketErrorCode }
    }
  } finally { $c.Close() }
}

function Test-TcpRemote([string]$vantage,[string[]]$targets,[int[]]$ps) {
  $secs = [math]::Max(2,[int]($TimeoutMs/1000))
  $sh = @"
for t in $($targets -join ' '); do for p in $($ps -join ' '); do
  out=`$(timeout $secs bash -c "exec 3<>/dev/tcp/`$t/`$p" 2>&1); rc=`$?
  if [ `$rc -eq 0 ]; then r=OPEN; elif [ `$rc -eq 124 ]; then r=TIMEOUT; elif echo "`$out" | grep -qi refused; then r=REFUSED; else r=ERROR; fi
  echo "`$t `$p `$r"
done; done
echo "SRC `$(curl -4 -s -m 6 https://api.ipify.org)"
"@
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($sh -replace "`r`n","`n")))
  $raw = & ssh -o BatchMode=yes -o ConnectTimeout=8 $vantage "echo $b64 | base64 -d | bash" 2>$null
  return $raw
}

function Classify($policy,$role,$result,$phase,$webMode) {
  if ($phase -eq 'Baseline') { return 'RECORD' }
  $expectOpen = switch ($policy) {
    'admin' { $role -eq 'admin' }
    'none'  { $false }
    'web'   { ($webMode -eq 'public') }
  }
  if ($expectOpen) { if ($result -eq 'OPEN') { 'PASS' } else { 'FAIL(expected OPEN)' } }
  else { if ($result -in 'TIMEOUT','REFUSED') { 'PASS' } elseif ($result -eq 'OPEN') { 'FAIL(expected blocked)' } else { 'INCONCLUSIVE' } }
}

$rows = New-Object System.Collections.ArrayList
$now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')   # real clock, never typed
$localIp = (& curl.exe -4 -s -m 8 https://api.ipify.org)
$localRole = if ($AdminIps -contains $localIp) { 'admin' } else { 'non-admin' }
Write-Host "== host04 external verification  phase=$Phase  webMode=$WebMode  at $now"
Write-Host "   local egress=$localIp role=$localRole (same /22 as target: $($localIp -like '66.118.3[6-9].*'))"

# ---- local vantage (IPv4 only; this workstation has no IPv6) ----
foreach ($p in $ports) {
  $r = Test-TcpLocal $Target $p.Port
  [void]$rows.Add([pscustomobject]@{Vantage="local($localIp)";Role=$localRole;Family='v4';Port=$p.Port;Name=$p.Name;Result=$r;Verdict=(Classify $p.Policy $localRole $r $Phase $WebMode)})
}
# HTTP evidence (what answers when the TCP connect is open)
$http3000 = (& curl.exe -s -o NUL -m 6 -w '%{http_code}' "http://${Target}:3000/" 2>$null)
$https443 = (& curl.exe -k -s -o NUL -m 6 -w '%{http_code}' "https://${Target}/" 2>$null)
$http80   = (& curl.exe -s -o NUL -m 6 -w '%{http_code}' "http://${Target}/" 2>$null)
# Is the EasyPanel UI ALSO served on the bare IP through Traefik (serveOnIp)? Closing :3000 does not close this.
$body443 = (& curl.exe -k -s -m 6 "https://${Target}/" 2>$null) -join ' '
$panelOn443 = [bool]($body443 -match '<title>\s*Easypanel')
Write-Host "   EasyPanel UI served on https://$Target/ (bare IP, Traefik): $panelOn443   (must be False once 'serve on IP' is disabled; 3000 rules do NOT affect this)"
Write-Host "   HTTP evidence from local: :3000=$http3000  :80=$http80  :443(-k, default cert)=$https443   (000 = no HTTP answer)"
# tailscale path (admin fallback; must be OPEN in both phases)
$ts3000 = Test-TcpLocal $TailscaleIp 3000; $ts22 = Test-TcpLocal $TailscaleIp 22
Write-Host "   tailscale path ($TailscaleIp): :22=$ts22 :3000=$ts3000   (expect OPEN after the guard; tailscale0 is never filtered)"

# ---- remote vantages ----
foreach ($v in $SshVantages) {
  Write-Host "== vantage ssh:$v"
  foreach ($fam in @(@{N='v4';T=$Target},@{N='v6';T=$Target6})) {
    $raw = Test-TcpRemote $v @($fam.T) ($ports | ForEach-Object { $_.Port })
    if (-not $raw) { Write-Host "   $v/$($fam.N): no output (ssh failed?) -> rows INCONCLUSIVE"; continue }
    $src = ($raw | Where-Object { $_ -like 'SRC *' } | Select-Object -First 1) -replace '^SRC ',''
    foreach ($line in $raw) {
      if ($line -match '^\S+ (\d+) (OPEN|TIMEOUT|REFUSED|ERROR)$') {
        $port=[int]$Matches[1]; $res=$Matches[2]; $pol=($ports | Where-Object { $_.Port -eq $port }).Policy
        $role = if ($AdminIps -contains $src) { 'admin' } else { 'non-admin' }
        [void]$rows.Add([pscustomobject]@{Vantage="ssh:$v($src)";Role=$role;Family=$fam.N;Port=$port;Name=($ports | Where-Object { $_.Port -eq $port }).Name;Result=$res;Verdict=(Classify $pol $role $res $Phase $WebMode)})
      }
    }
  }
}

# ---- controls: a vantage whose control is not OPEN cannot vouch for its blocks ----
foreach ($g in ($rows | Group-Object Vantage,Family)) {
  $ctrlPort = if ($WebMode -eq 'public') { 443 } else { 22 }
  $ctrl = $g.Group | Where-Object { $_.Port -eq $ctrlPort }
  $ctrlOpen = $ctrl -and ($ctrl.Result -eq 'OPEN')
  if (-not $ctrlOpen -and ($g.Group[0].Role -eq 'admin' -or $WebMode -eq 'public')) {
    foreach ($r in $g.Group) { if ($r.Verdict -like 'PASS*') { $r.Verdict = 'INCONCLUSIVE(control closed)' } }
  }
}

$rows | Sort-Object Vantage,Family,Port | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
Write-Host "UDP 7946 / 4789: NOT verifiable by a probe (no reply == open|filtered). Evidence for UDP is the rule counters on host04:"
Write-Host ('   ssh epicadmin@' + $Target + ' "sudo nft list chain inet host04_guard input | grep udp"   (After phase; packets > 0 only if something sent)')

$out = Join-Path $OutDir ("host04-exposure-{0}-{1}.json" -f $Phase.ToLower(), (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
[pscustomobject]@{captured_at=$now;phase=$Phase;webMode=$WebMode;target=$Target;target6=$Target6;localEgress=$localIp;http3000=$http3000;http80=$http80;https443=$https443;panelServedOnBareIp443=$panelOn443;tailscale22=$ts22;tailscale3000=$ts3000;rows=$rows} | ConvertTo-Json -Depth 5 | Set-Content -Path $out -Encoding utf8
Write-Host "wrote $out"
$bad = @($rows | Where-Object { $_.Verdict -like 'FAIL*' }).Count
$inc = @($rows | Where-Object { $_.Verdict -like 'INCONCLUSIVE*' }).Count
Write-Host ("SUMMARY phase={0}: rows={1} fail={2} inconclusive={3}" -f $Phase,$rows.Count,$bad,$inc)
Write-Host ""
Write-Host "OFF-NET VANTAGE (owner, 30 seconds): from a phone on mobile data / a cloud shell run:"
Write-Host "   for p in 22 3000 2377 7946; do timeout 4 bash -c ""</dev/tcp/$Target/`$p"" && echo `$p OPEN || echo `$p blocked; done; curl -s -m5 -o /dev/null -w '443=%{http_code}\n' -k https://$Target/"
Write-Host "   expect (After): 22/3000/2377/7946 blocked; 443 = 200 while 'serve on IP' is still on, 404 after it is off (Traefik default). Run it ALSO before the guard to prove the vantage can see OPEN ports."
if ($Phase -eq 'After' -and ($bad -gt 0)) { exit 1 }
