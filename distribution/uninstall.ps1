$ErrorActionPreference = 'Stop'
$releaseDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20 or newer is required.' }
$previousEntrypoint = $env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT
try {
  $env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT = $MyInvocation.MyCommand.Path
  & node (Join-Path $releaseDirectory 'bootstrap.mjs') uninstall @args
  $status = $LASTEXITCODE
} finally {
  if ($null -eq $previousEntrypoint) { Remove-Item Env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT -ErrorAction SilentlyContinue }
  else { $env:SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT = $previousEntrypoint }
}
exit $status
