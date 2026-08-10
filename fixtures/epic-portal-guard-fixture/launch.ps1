<#
.SYNOPSIS
  One-command launcher for the epic-portal PostToolUse output-projection
  fixture. Resolves every path itself from this script's own location -
  the owner never needs to edit a path or fill in an ellipsis.

.DESCRIPTION
  1. Generates mcp-config.generated.json next to this script, with the
     fixture server's ACTUAL absolute path on this checkout (never a
     hardcoded machine-specific path committed to the branch).
  2. Launches `claude` with:
       --setting-sources project   (loads ONLY this fixture's workspace/.claude,
                                     not the owner's real user/global settings -
                                     see the NOTE below on managed settings)
       --permission-mode default   (real approval prompts fire, nothing is
                                     auto-approved)
       --strict-mcp-config         (boolean flag - locks the session to ONLY
                                     the server in --mcp-config; the real
                                     epic-portal registration and token are
                                     never touched or read)
       --mcp-config <generated>    (the config path is a SEPARATE argument -
                                     --strict-mcp-config takes no argument
                                     itself)
     with the working directory set to workspace/, so the project settings
     source resolves to workspace/.claude/settings.json.

  NOTE: --setting-sources project restricts which settings FILES load, but
  managed/enterprise policy settings (if any exist on this machine) can still
  apply on top regardless of this flag. This script does not and cannot
  disable that layer.

  This script does not run the fixture's assertions or interpret results -
  see README.md for what to check once the session is open, and for the
  explicit statement that this script being ready to run is not a claim
  that it passed.
#>

$ErrorActionPreference = 'Stop'

$fixtureRoot = $PSScriptRoot
$serverPath = Join-Path $fixtureRoot 'server\epic-portal-fixture-server.js'
$workspacePath = Join-Path $fixtureRoot 'workspace'
$generatedConfigPath = Join-Path $fixtureRoot 'mcp-config.generated.json'

if (-not (Test-Path $serverPath)) {
  throw "Fixture server not found at: $serverPath"
}
if (-not (Test-Path $workspacePath)) {
  throw "Fixture workspace not found at: $workspacePath"
}

$mcpConfig = [ordered]@{
  mcpServers = [ordered]@{
    'epic-portal' = [ordered]@{
      command = 'node'
      args    = @($serverPath)
    }
  }
} | ConvertTo-Json -Depth 5

# Write without a BOM - Windows PowerShell 5.1's `-Encoding utf8` always
# emits one, and a leading BOM byte in this file would make it fail to
# parse as JSON for anything that reads it strictly.
[System.IO.File]::WriteAllText($generatedConfigPath, $mcpConfig, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Generated: $generatedConfigPath"
Write-Host "Launching claude from: $workspacePath"
Write-Host ''

Push-Location $workspacePath
try {
  claude --setting-sources project --permission-mode default --strict-mcp-config --mcp-config $generatedConfigPath
} finally {
  Pop-Location
}
