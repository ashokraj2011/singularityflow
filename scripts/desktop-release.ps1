$ErrorActionPreference = 'Stop'

$releaseScript = Join-Path $PSScriptRoot 'desktop-release.mjs'
& node $releaseScript @args
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
