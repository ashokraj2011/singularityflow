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
if ($env:SINGULARITY_FLOW_MANAGED_DISTRIBUTION -eq '1' -or ($args.Count -gt 0 -and $args[0] -eq '--managed-runtime')) {
  $managedNode = & (Join-Path $releaseDirectory 'node-bootstrap.ps1')
  if ($LASTEXITCODE -ne 0 -or -not $managedNode) { throw 'Private Node preparation failed.' }
  $managedArguments = @('--managed-runtime') + @($args | Where-Object { $_ -ne '--managed-runtime' })
  exit (Invoke-DistributionNode $managedNode (@((Join-Path $releaseDirectory 'bootstrap.mjs'), 'install') + $managedArguments))
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22.17 or newer is required.' }
$previousEntrypoint = $env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT
try {
  $env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT = $MyInvocation.MyCommand.Path
  $nodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop).Source
  $status = Invoke-DistributionNode $nodeExecutable (@((Join-Path $releaseDirectory 'bootstrap.mjs'), 'install') + $args)
} finally {
  if ($null -eq $previousEntrypoint) { Remove-Item Env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT -ErrorAction SilentlyContinue }
  else { $env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT = $previousEntrypoint }
}
exit $status
