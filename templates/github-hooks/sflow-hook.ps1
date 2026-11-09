# Singularity Flow's repository hook (docs/SPEC-PCR-PLAIN-CHAT-ROUTING-v1.md, P3), for PowerShell. Mirrors
# sflow-hook.sh: with SFlow's Copilot plugin on this machine it answers {} [PCR:REQ-031]; with SFlow but not its
# plugin it hands the event to SFlow's own hook launcher; without SFlow it refuses an edit or a writing command
# with the install line, unless the setting is allow, and a file named to stay on a laptop [PCR:REQ-032].
# It never fails: anything unexpected answers {}. `singularity-flow init` writes it; `doctor --repair-hooks` again.
param([string]$Action, [string]$Setting = 'record')
$ErrorActionPreference = 'Stop'
function Write-Quiet { Write-Output '{}'; exit 0 }
try {
  if ($Action -notin @('boundary-turn', 'boundary-guard', 'boundary-after', 'boundary-end', 'agent-start', 'boundary-stop', 'boundary-failure')) { Write-Quiet }
  if ($Setting -notin @('refuse', 'record', 'allow')) { $Setting = 'record' }
  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buffer)
  $bytes = $buffer.ToArray()
  $windowsHost = $IsWindows -or $env:OS -eq 'Windows_NT'
  $homeDirectory = if ($windowsHost) { $env:USERPROFILE } else { $env:HOME }

  # The plugin's own launcher leaves its folder in a marker when it runs; a Copilot CLI install is also found by its files.
  function Test-PluginInstalled {
    $mode = if ($env:SINGULARITY_FLOW_COPILOT_MODE_FILE) { $env:SINGULARITY_FLOW_COPILOT_MODE_FILE } elseif ($homeDirectory) { Join-Path $homeDirectory '.singularity-flow/copilot-mode.json' } else { $null }
    if ($mode -and [IO.Path]::IsPathRooted($mode)) {
      $marker = Join-Path (Split-Path -Parent $mode) 'copilot-plugin'
      if ([IO.File]::Exists($marker)) {
        $root = ([IO.File]::ReadAllLines($marker) | Select-Object -First 1)
        if ($root -and [IO.Path]::IsPathRooted($root) -and ([IO.File]::Exists((Join-Path $root 'hook-launcher.ps1')) -or [IO.File]::Exists((Join-Path $root 'hook-launcher.sh')))) { return $true }
      }
    }
    $copilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } elseif ($homeDirectory) { Join-Path $homeDirectory '.copilot' } else { $null }
    if (-not $copilotHome -or -not [IO.Directory]::Exists((Join-Path $copilotHome 'installed-plugins'))) { return $false }
    foreach ($source in [IO.Directory]::EnumerateDirectories((Join-Path $copilotHome 'installed-plugins'))) {
      foreach ($plugin in [IO.Directory]::EnumerateDirectories($source)) {
        $manifest = Join-Path $plugin 'plugin.json'
        if ([IO.File]::Exists($manifest) -and [IO.File]::ReadAllText($manifest).Contains('"name": "singularity-flow"') -and [IO.File]::Exists((Join-Path $plugin 'hook-launcher.ps1'))) { return $true }
      }
    }
    return $false
  }

  # SFlow's own PowerShell hook launcher: the managed engine's, else the one beside the singularity-flow command.
  function Find-SflowLauncher {
    $engine = if ($env:SINGULARITY_FLOW_ENGINE_HOME) { $env:SINGULARITY_FLOW_ENGINE_HOME } elseif ($homeDirectory) { Join-Path $homeDirectory '.singularity-flow/engine' } else { $null }
    if ($engine -and [IO.File]::Exists((Join-Path $engine 'active'))) {
      if ([IO.File]::ReadAllText((Join-Path $engine 'active')) -match '^1\|[^|]+\|([a-f0-9]{64})\r?\n?$') {
        $candidate = Join-Path $engine "releases/$($Matches[1])/node_modules/singularity-flow/plugin/hook-launcher.ps1"
        if ([IO.File]::Exists($candidate)) { return $candidate }
      }
    }
    $roots = @()
    $command = Get-Command singularity-flow -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
      $roots += Join-Path (Split-Path $command.Source -Parent) 'node_modules/singularity-flow'
      $item = Get-Item -LiteralPath $command.Source -ErrorAction SilentlyContinue
      if ($item -and $item.LinkTarget) {
        $target = if ([IO.Path]::IsPathRooted($item.LinkTarget)) { $item.LinkTarget } else { Join-Path (Split-Path $command.Source -Parent) $item.LinkTarget }
        $roots += Split-Path (Split-Path ([IO.Path]::GetFullPath($target)) -Parent) -Parent
      }
    }
    if ($env:APPDATA) { $roots += Join-Path $env:APPDATA 'npm/node_modules/singularity-flow' }
    $prefixes = if ($null -ne $env:SINGULARITY_FLOW_INSTALL_PREFIXES) { $env:SINGULARITY_FLOW_INSTALL_PREFIXES -split '\s+' } else { @('/opt/homebrew', '/usr/local', '/opt/local') }
    foreach ($prefix in $prefixes) { if ($prefix) { $roots += Join-Path $prefix 'lib/node_modules/singularity-flow' } }
    foreach ($root in $roots) {
      $launcher = Join-Path $root 'plugin/hook-launcher.ps1'
      if ([IO.File]::Exists($launcher) -and [IO.File]::Exists((Join-Path $root 'bin/singularity-flow.mjs'))) { return $launcher }
    }
    return $null
  }

  function Get-ToolName([string]$Name) { return (($Name.ToLowerInvariant() -split '[.:]')[-1] -split '__')[-1] }

  # The read-only set a read-only /sf- turn runs (readOnlyShell in src/copilot-mutation-guard.mjs).
  function Test-ReadOnlyPart([string]$Part) {
    if ($Part -ceq 'pwd') { return $true }
    if ($Part -cmatch '^ls( -[1aAlhR]+)*( [^-''"][^ ]*)*$') { return $true }
    $words = @($Part -split '\s+' | Where-Object { $_ })
    if ($words.Count -eq 0 -or $words[0] -cne 'git') { return $false }
    $index = 1
    while ($index -lt $words.Count -and $words[$index] -cin @('--no-pager', '-P')) { $index++ }
    if ($index -ge $words.Count) { return $false }
    $sub = $words[$index]; $index++
    if ($sub -ceq 'branch') { return $words.Count -eq ($index + 1) -and $words[$index] -ceq '--show-current' }
    $allowed = @{
      'status' = '^(-s|--short|-b|--branch|--porcelain(=v[12])?|--untracked-files(=(no|normal|all))?|--ignored|-z)$'
      'diff' = '^(--stat|--numstat|--shortstat|--name-only|--name-status|--cached|--staged|--no-color|--no-renames|--check|-U\d+|--unified=\d+|-z)$'
      'log' = '^(--oneline|--stat|--name-only|--name-status|--no-decorate|--decorate|--graph|-\d+|-n\d*|--max-count=\d+|\d+|--format=[A-Za-z%:() -]*|--pretty=[A-Za-z%:() -]*|--no-color|-z)$'
      'show' = '^(--stat|--name-only|--name-status|--oneline|--no-patch|-s|--no-color|--format=[A-Za-z%:() -]*|--pretty=[A-Za-z%:() -]*)$'
      'ls-files' = '^(-c|--cached|-m|--modified|-o|--others|--exclude-standard|-z|-s|--stage)$'
      'rev-parse' = '^(--show-toplevel|--abbrev-ref|--verify|--short|--git-dir|--absolute-git-dir|HEAD|HEAD\^\{tree\})$'
    }[$sub]
    if (-not $allowed) { return $false }
    $paths = $false
    for (; $index -lt $words.Count; $index++) {
      $word = $words[$index]
      if ($word -ceq '--') { $paths = $true; continue }
      if ($paths -or -not $word.StartsWith('-')) { if ($word.TrimStart('''', '"').StartsWith('-')) { return $false }; continue }
      if ($word -cnotmatch $allowed) { return $false }
    }
    return $true
  }

  function Test-ReadOnlyCommand([string]$Command) {
    if ($Command -match '[;|`$<>\r\n]') { return $false }
    foreach ($part in ($Command -split '&&')) {
      $part = $part.Trim()
      if (-not $part -or $part.Contains('&') -or -not (Test-ReadOnlyPart $part)) { return $false }
    }
    return $true
  }

  function Write-Deny([string]$Reason) {
    $answer = [ordered]@{ permissionDecision = 'deny'; permissionDecisionReason = $Reason
      hookSpecificOutput = [ordered]@{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = $Reason } }
    Write-Output ($answer | ConvertTo-Json -Compress -Depth 4); exit 0
  }

  if (Test-PluginInstalled) { Write-Quiet }
  $launcher = Find-SflowLauncher
  if ($launcher) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = (Get-Process -Id $PID).Path
    $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $launcher, $Action)
    # Windows PowerShell 5.1 has no ArgumentList: one quoted string, as hook-launcher.ps1 builds it.
    if ($info.PSObject.Properties['ArgumentList']) { foreach ($value in $arguments) { $info.ArgumentList.Add($value) } }
    else { $info.Arguments = ($arguments | ForEach-Object { if ($_ -notmatch '[\s"]') { $_ } else { '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' } }) -join ' ' }
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $process = [Diagnostics.Process]::Start($info)
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.Close()
    $output = $process.StandardOutput.ReadToEnd()
    $process.WaitForExit()
    $last = ($output -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -Last 1)
    if ($last) { Write-Output $last; exit 0 }
    Write-Quiet
  }
  if ($Action -ne 'boundary-guard') { Write-Quiet }

  # Without SFlow: what the call names, from the payload itself.
  $payload = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  $found = [regex]::Match($text, '"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"')
  if ($found.Success) { $text = $text.Remove($found.Index, $found.Length) }
  foreach ($match in [regex]::Matches($text, '(?i)(?:^|[^A-Za-z0-9_.-])(\.env(?:\.[A-Za-z0-9_.-]+)?|application-local\.(?:ya?ml|properties)|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.local\.(?:ya?ml|json|properties|toml|ini)|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:pem|key|p12|pfx|jks|keystore))(?=[^A-Za-z0-9_.-]|$)')) {
    $name = $match.Groups[1].Value
    if ($name -match '(?i)^\.env\.(?:[A-Za-z0-9_.-]+\.)?(?:example|sample|template|tmpl|dist|defaults|schema)$') { continue }
    Write-Deny "ENVIRONMENT_FILE_PRIVATE: $name is named to stay on a laptop, so Copilot does not read or edit it, and Singularity Flow, which checks such files, is not installed on this machine. Keep working without its contents. Do not retry it"
  }
  if ($Setting -eq 'allow') { Write-Quiet }
  $calls = @()
  if ($payload.toolCalls) { foreach ($call in $payload.toolCalls) { $calls += [pscustomobject]@{ name = [string]$call.name; args = $call.args } } }
  else {
    $name = if ($payload.toolName) { [string]$payload.toolName } else { [string]$payload.tool_name }
    $arguments = if ($null -ne $payload.toolArgs) { $payload.toolArgs } else { $payload.tool_input }
    $calls += [pscustomobject]@{ name = $name; args = $arguments }
  }
  $what = $null
  foreach ($call in $calls) {
    $name = Get-ToolName $call.name
    if ($name -match '(patch|edit|replace|insert|write|delete|remove|create|mkdir|move|rename).*(file|directory)' -or $name -in @('patch', 'edit', 'replace', 'insert', 'write', 'delete', 'remove', 'create', 'mkdir', 'move', 'rename', 'apply_patch', 'sflow_run')) { $what = 'this edit'; break }
    if ($name -in @('bash', 'powershell', 'run_in_terminal', 'execute', 'exec_command', 'write_stdin', 'write_bash')) {
      $arguments = $call.args
      if ($arguments -is [string]) { try { $arguments = $arguments | ConvertFrom-Json } catch { $arguments = $null } }
      $line = $null
      foreach ($field in @('command', 'cmd', 'script', 'input', 'chars')) { if ($arguments -and $arguments.$field -is [string]) { $line = $arguments.$field; break } }
      # Nothing typed, or only a key such as Ctrl-C, reads or stops a shell.
      if ($null -eq $line -or $line -match '^[\s\x00-\x1f\x7f]*$') { continue }
      if (-not (Test-ReadOnlyCommand $line.TrimEnd("`r", "`n"))) { $what = 'this command'; break }
    }
  }
  if (-not $what) { Write-Quiet }
  Write-Deny "SFLOW_NOT_INSTALLED: this repository sends a plain chat's changes through Singularity Flow (policy.plainChatEdits: $Setting), which is not installed on this machine, so $what did not run. Reading, searching and questions stay free. To work here, install Singularity Flow (its README: Install and initialize) and run singularity-flow plugin install. Do not retry it"
} catch {
  Write-Output '{}'
}
exit 0
