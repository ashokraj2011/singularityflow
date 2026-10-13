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
  # Copilot runs the guard before every tool, in every chat. With no SFlow turn recorded on this
  # machine the runtime's guard, after-tool and end hooks return no decision, so give that answer
  # here instead of starting Node. Any entry, including the marker a runtime that failed to load
  # leaves, sends the hook to Node as before. Mirrors copilotModeFile() and hook-launcher.sh.
  if ($Action -in @('boundary-guard', 'boundary-after', 'boundary-end')) {
    $windowsHost = $IsWindows -or $env:OS -eq 'Windows_NT'
    $homeDirectory = if ($windowsHost) { $env:USERPROFILE } else { $env:HOME }
    $modeFile = if ($env:SINGULARITY_FLOW_COPILOT_MODE_FILE) { $env:SINGULARITY_FLOW_COPILOT_MODE_FILE }
      elseif ($homeDirectory) { Join-Path $homeDirectory '.singularity-flow/copilot-mode.json' } else { $null }
    if ($modeFile -and [System.IO.Path]::IsPathRooted($modeFile) -and $modeFile -notmatch '[\\/]\.\.?([\\/]|$)' -and $modeFile -notmatch '[\\/]$') {
      $boundaries = Join-Path (Split-Path -Parent $modeFile) 'copilot-boundaries'
      # One exact directory, never a search. Dot entries are in-flight writes, as in the shell glob.
      $occupied = $false
      try {
        if ([System.IO.Directory]::Exists($boundaries)) {
          foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($boundaries)) {
            if (-not [System.IO.Path]::GetFileName($entry).StartsWith('.')) { $occupied = $true; break }
          }
        }
      } catch { $occupied = $true }
      if (-not $occupied) {
        [void][Console]::In.ReadToEnd()
        Write-Output '{}'
        exit 0
      }
    }
  }
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
