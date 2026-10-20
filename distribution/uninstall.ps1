$ErrorActionPreference = 'Stop'
function Invoke-DistributionNode([string]$Executable, [string[]]$Arguments) {
  # Windows PowerShell 5.1's native splatting drops embedded quotes. Serialize each argv once
  # using CreateProcess/MSCRT escaping, without cmd.exe, evaluation or environment expansion.
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
$releaseDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or newer is required.' }
$previousEntrypoint = $env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT
try {
  $env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT = $MyInvocation.MyCommand.Path
  $nodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop).Source
  $status = Invoke-DistributionNode $nodeExecutable (@((Join-Path $releaseDirectory 'bootstrap.mjs'), 'uninstall') + $args)
} finally {
  if ($null -eq $previousEntrypoint) { Remove-Item Env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT -ErrorAction SilentlyContinue }
  else { $env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT = $previousEntrypoint }
}
exit $status
