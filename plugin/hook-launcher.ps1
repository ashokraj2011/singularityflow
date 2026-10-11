param([string]$Action)
$ErrorActionPreference = 'Stop'
if ($Action -notin @('boundary-turn', 'boundary-guard', 'boundary-after', 'boundary-end', 'agent-start')) {
  Write-Output '{}'; exit 0
}
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$nodePath = if ($node) { $node.Source } else { $null }
if (-not $nodePath) {
  foreach ($prefix in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if ($prefix) {
      $candidate = Join-Path $prefix 'nodejs/node.exe'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $nodePath = $candidate; break }
    }
  }
}
if ($nodePath) {
  $cli = Get-Command singularity-flow -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $candidates = @()
  if ($cli) {
    $candidates += Join-Path (Split-Path $cli.Source -Parent) 'node_modules/singularity-flow/bin/singularity-flow.mjs'
  }
  if ($env:APPDATA) { $candidates += Join-Path $env:APPDATA 'npm/node_modules/singularity-flow/bin/singularity-flow.mjs' }
  $candidates += Join-Path (Split-Path $nodePath -Parent) 'node_modules/singularity-flow/bin/singularity-flow.mjs'
  & $nodePath (Join-Path $PSScriptRoot 'hook-launcher.mjs') $Action @candidates
  exit $LASTEXITCODE
}
if ($Action -eq 'boundary-guard') {
  Write-Output '{"permissionDecision":"deny","permissionDecisionReason":"SFLOW_HOOK_RUNTIME_UNAVAILABLE: Node.js is unavailable to Copilot. Repair the SFlow installation from a human terminal, run singularity-flow plugin install, and reload VS Code. Preserve the Story; changing its ID will not repair the hook."}'
} else { Write-Output '{}' }
