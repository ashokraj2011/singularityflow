param([string]$Action)
$ErrorActionPreference = 'Stop'
if ($Action -notin @('boundary-turn', 'boundary-guard', 'boundary-after', 'boundary-end', 'agent-start', 'boundary-stop', 'boundary-failure')) {
  Write-Output '{}'; exit 0
}
# With no SFlow turn recorded the runtime's guard still refuses a person's own step in any prompt
# (personStepGuard in copilot-repository-boundary.mjs), and it looks only at a call that names SFlow,
# or a file that may hold secrets.
# So the guard keeps its no-Node answer only for a payload that cannot: held here as bytes, read
# once, and given to Node unchanged when it might. Over 1 MiB it is not read through; Node reads the
# rest. Mirrors hold_hook_input, hook_input_goes_to_node and run_hook in hook-launcher.sh.
$script:hookHeld = $null; $script:hookHeldCount = 0; $script:hookMore = $false; $script:hookStdin = $null
function Read-HookInput {
  $script:hookStdin = [Console]::OpenStandardInput()
  $script:hookHeld = New-Object byte[] 1048577
  while ($script:hookHeldCount -lt $script:hookHeld.Length) {
    $read = $script:hookStdin.Read($script:hookHeld, $script:hookHeldCount, $script:hookHeld.Length - $script:hookHeldCount)
    if ($read -le 0) { break }
    $script:hookHeldCount += $read
  }
  $script:hookMore = $script:hookHeldCount -gt 1048576
}
# The guard's own test, /singularity-flow|sflow/iu on the tool calls or the verified entry (which ends
# in singularity-flow.mjs), on the raw JSON less the session's folder, which the guard does not read.
# One character per byte; culture-invariant, so no locale folds I away from i. Under that test U+017F (long s,
# bytes C5 BF) is an s, and an escaped printable ASCII character or U+017F could spell either word.
function Test-HookInputGoesToNode {
  if ($script:hookMore) { return $true }
  $text = [Text.Encoding]::GetEncoding(28591).GetString($script:hookHeld, 0, $script:hookHeldCount)
  $at = $text.IndexOf('"cwd":"', [StringComparison]::Ordinal)
  if ($at -ge 0) {
    $end = $text.IndexOf('"', $at + 7, [StringComparison]::Ordinal)
    if ($end -ge 0) { $text = $text.Substring(0, $at) + $text.Substring($end + 1) }
  }
  if ([regex]::IsMatch($text, 'sflow|singularity-flow|\u00C5\u00BF|\\u00[2-7][0-9a-f]|\\u017f',
    [Text.RegularExpressions.RegexOptions]'IgnoreCase, CultureInvariant')) { return $true }
  # A file that may hold secrets goes to Node too (plainChatGuard), and a search for a credential word. Mirrors hook-launcher.sh.
  if ([regex]::IsMatch($text, 'grep|(^|[^a-z0-9_])(rg|ag|ack)($|[^a-z0-9_])', [Text.RegularExpressions.RegexOptions]'IgnoreCase, CultureInvariant') -and
    [regex]::IsMatch($text, 'pass|pwd|token|key|auth', [Text.RegularExpressions.RegexOptions]'IgnoreCase, CultureInvariant')) { return $true }
  return [regex]::IsMatch($text, '(^|[^a-z0-9_)\]])\.env|\.(env|ya?ml|properties|toml|ini|cfg|conf|json|pem|key|p12|pfx|jks|keystore)($|[^a-z0-9_.(\[])|secret|credential',
    [Text.RegularExpressions.RegexOptions]'IgnoreCase, CultureInvariant')
}
# Answered here, or the bytes go to Node as the host sent them: held ones first, then the rest.
function Complete-QuietHook {
  if ($Action -eq 'boundary-guard') {
    Read-HookInput
    if (Test-HookInputGoesToNode) { return }
  } else { [void][Console]::In.ReadToEnd() }
  Write-Output '{}'; exit 0
}
function ConvertTo-HookArgument([string]$Value) {
  if ($Value -and $Value -notmatch '[\s"]') { return $Value }
  return '"' + (($Value -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}
function Invoke-HookNode([string]$File, [string[]]$Arguments) {
  if ($null -eq $script:hookHeld) { & $File @Arguments; exit $LASTEXITCODE }
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $File
  if ($info.PSObject.Properties['ArgumentList']) { foreach ($value in $Arguments) { $info.ArgumentList.Add($value) } }
  else { $info.Arguments = ($Arguments | ForEach-Object { ConvertTo-HookArgument $_ }) -join ' ' }
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $process = [Diagnostics.Process]::Start($info)
  $sink = $process.StandardInput.BaseStream
  $sink.Write($script:hookHeld, 0, $script:hookHeldCount)
  if ($script:hookMore) { $script:hookStdin.CopyTo($sink) }
  $sink.Close()
  $process.WaitForExit()
  exit $process.ExitCode
}
# os.homedir(): USERPROFILE on Windows, HOME elsewhere (pwsh on macOS and Linux).
$windowsHost = $IsWindows -or $env:OS -eq 'Windows_NT'
$homeDirectory = if ($windowsHost) { $env:USERPROFILE } else { $env:HOME }
$managedRoot = if ($env:SINGULARITY_FLOW_ENGINE_HOME) { $env:SINGULARITY_FLOW_ENGINE_HOME } else { Join-Path $homeDirectory '.singularity-flow/engine' }
$managedActive = Join-Path $managedRoot 'active'
if (Test-Path -LiteralPath $managedActive -PathType Leaf) {
  $managedSelection = [IO.File]::ReadAllText($managedActive)
  if ($managedSelection -match '^1\|(node-v26\.\d+\.\d+-win32-(?:x64|arm64))\|([a-f0-9]{64})\r?\n?$') {
    $managedRuntime = $Matches[1]; $managedRelease = $Matches[2]
    $managedNode = Join-Path $managedRoot "runtimes/$managedRuntime/node.exe"
    $managedCli = Join-Path $managedRoot "releases/$managedRelease/node_modules/singularity-flow/bin/singularity-flow.mjs"
    if ((Test-Path -LiteralPath $managedNode -PathType Leaf) -and (Test-Path -LiteralPath $managedCli -PathType Leaf)) {
      if ($Action -in @('boundary-guard', 'boundary-after', 'boundary-end', 'boundary-stop', 'boundary-failure')) {
        $managedMode = if ($env:SINGULARITY_FLOW_COPILOT_MODE_FILE) { $env:SINGULARITY_FLOW_COPILOT_MODE_FILE } else { Join-Path $homeDirectory '.singularity-flow/copilot-mode.json' }
        if ([IO.Path]::IsPathRooted($managedMode) -and $managedMode -notmatch '[\\/]\.\.?([\\/]|$)' -and $managedMode -notmatch '[\\/]$') {
          $managedBoundaries = Join-Path (Split-Path -Parent $managedMode) 'copilot-boundaries'
          $managedOccupied = $false
          try {
            if ([IO.Directory]::Exists($managedBoundaries)) {
              foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($managedBoundaries)) {
                if (-not [IO.Path]::GetFileName($entry).StartsWith('.')) { $managedOccupied = $true; break }
              }
            }
          } catch { $managedOccupied = $true }
          if (-not $managedOccupied) { Complete-QuietHook }
        }
      }
      # The engine's PATH entry may be newer than this host's environment. Off PATH, --cli-off-path
      # has the turn name the verified Node and entry instead.
      $managedArgs = @($managedCli)
      if ($Action -eq 'boundary-turn' -and -not (Get-Command singularity-flow -CommandType Application -ErrorAction SilentlyContinue)) { $managedArgs += '--cli-off-path' }
      Invoke-HookNode $managedNode (@((Join-Path $PSScriptRoot 'hook-launcher.mjs'), $Action) + $managedArgs)
    }
  }
  if ($Action -eq 'boundary-guard') { Write-Output '{"permissionDecision":"deny","permissionDecisionReason":"SFLOW_HOOK_RUNTIME_UNAVAILABLE: The managed SFlow engine is incomplete. Repair its installation; preserve the Story.","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"SFLOW_HOOK_RUNTIME_UNAVAILABLE: The managed SFlow engine is incomplete. Repair its installation; preserve the Story."}}' }
  else { Write-Output '{}' }
  exit 0
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
  # machine the runtime's after-tool and end hooks return no decision, and so does its guard for a
  # call that names no SFlow command, so give that answer here instead of starting Node. Any entry,
  # including the marker a runtime that failed to load leaves, sends the hook to Node as before.
  # Mirrors copilotModeFile() and hook-launcher.sh.
  if ($Action -in @('boundary-guard', 'boundary-after', 'boundary-end', 'boundary-stop', 'boundary-failure')) {
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
      if (-not $occupied) { Complete-QuietHook }
    }
  }
  $cli = Get-Command singularity-flow -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $candidates = @()
  if ($cli) {
    $candidates += Join-Path (Split-Path $cli.Source -Parent) 'node_modules/singularity-flow/bin/singularity-flow.mjs'
  } else {
    # Copilot's shell shares this PATH (a host started before npm's global bin joined it, or a stale
    # environment): the marker has the turn name the verified node.exe and entry instead.
    $candidates += '--cli-off-path'
  }
  if ($env:APPDATA) { $candidates += Join-Path $env:APPDATA 'npm/node_modules/singularity-flow/bin/singularity-flow.mjs' }
  $candidates += Join-Path (Split-Path $nodePath -Parent) 'node_modules/singularity-flow/bin/singularity-flow.mjs'
  Invoke-HookNode $nodePath (@((Join-Path $PSScriptRoot 'hook-launcher.mjs'), $Action) + $candidates)
}
if ($Action -eq 'boundary-guard') {
  Write-Output '{"permissionDecision":"deny","permissionDecisionReason":"SFLOW_HOOK_RUNTIME_UNAVAILABLE: Node.js is unavailable to Copilot. Repair the SFlow installation from a human terminal, run singularity-flow plugin install, and reload VS Code. Preserve the Story; changing its ID will not repair the hook.","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"SFLOW_HOOK_RUNTIME_UNAVAILABLE: Node.js is unavailable to Copilot. Repair the SFlow installation from a human terminal, run singularity-flow plugin install, and reload VS Code. Preserve the Story; changing its ID will not repair the hook."}}'
} else { Write-Output '{}' }
