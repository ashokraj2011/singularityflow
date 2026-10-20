$ErrorActionPreference = 'Stop'
$releaseDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($env:SINGULARITY_FLOW_MANAGED_DISTRIBUTION -eq '1' -or ($args.Count -gt 0 -and $args[0] -eq '--managed-runtime')) {
  $managedNode = & (Join-Path $releaseDirectory 'node-bootstrap.ps1')
  if ($LASTEXITCODE -ne 0 -or -not $managedNode) { throw 'Private Node preparation failed.' }
  $managedArguments = @('--managed-runtime') + @($args | Where-Object { $_ -ne '--managed-runtime' })
  & $managedNode (Join-Path $releaseDirectory 'bootstrap.mjs') install @managedArguments
  exit $LASTEXITCODE
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or newer is required.' }
$previousEntrypoint = $env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT
try {
  $env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT = $MyInvocation.MyCommand.Path
  & node (Join-Path $releaseDirectory 'bootstrap.mjs') install @args
  $status = $LASTEXITCODE
} finally {
  if ($null -eq $previousEntrypoint) { Remove-Item Env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT -ErrorAction SilentlyContinue }
  else { $env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT = $previousEntrypoint }
}
exit $status
