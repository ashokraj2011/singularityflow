$ErrorActionPreference = 'Stop'
$managedNode = & (Join-Path $PSScriptRoot 'runtime/bootstrap.ps1')
if ($LASTEXITCODE -ne 0 -or -not $managedNode) { throw 'Private Node preparation failed.' }
& $managedNode (Join-Path $PSScriptRoot 'runtime/source-install.mjs') @args
exit $LASTEXITCODE
