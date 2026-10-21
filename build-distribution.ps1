$ErrorActionPreference = 'Stop'
$buildNode = & (Join-Path $PSScriptRoot 'runtime/bootstrap.ps1')
if ($LASTEXITCODE -ne 0 -or -not $buildNode) { throw 'Private Node preparation failed.' }
& $buildNode (Join-Path $PSScriptRoot 'runtime/build-distribution.mjs') @args
exit $LASTEXITCODE
