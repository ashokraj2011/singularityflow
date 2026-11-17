$ErrorActionPreference = 'Stop'
function Invoke-UpdaterNode([string]$Executable, [string[]]$Arguments) {
  # Pass argv through CreateProcess, never cmd.exe or Invoke-Expression.
  $quoted = @($Arguments | ForEach-Object {
    $value = [regex]::Replace($_, '(\\*)"', '$1$1\"')
    $value = [regex]::Replace($value, '(\\+)$', '$1$1')
    '"' + $value + '"'
  })
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $Executable
  $start.Arguments = $quoted -join ' '
  $start.UseShellExecute = $false
  $start.WorkingDirectory = (Get-Location).Path
  $child = New-Object Diagnostics.Process
  $child.StartInfo = $start
  try { [void]$child.Start(); $child.WaitForExit(); return $child.ExitCode }
  finally { $child.Dispose() }
}
$updaterNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
$updaterCompatible = $false
if ($updaterNode) {
  $updaterProbe = 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>=22&&!(process.platform==="win32"&&((a===22&&b<17)||a===23))?0:1)'
  $updaterCompatible = (Invoke-UpdaterNode $updaterNode.Source @('-e', $updaterProbe)) -eq 0
}
if ($updaterCompatible) {
  $updaterExecutable = $updaterNode.Source
} else {
  $updaterExecutable = & (Join-Path $PSScriptRoot 'runtime/bootstrap.ps1')
  if ($LASTEXITCODE -ne 0 -or -not $updaterExecutable) { throw 'Private Node preparation failed.' }
}
exit (Invoke-UpdaterNode $updaterExecutable (@((Join-Path $PSScriptRoot 'runtime/update.mjs')) + $args))
