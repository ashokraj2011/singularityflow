$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install.ps1') --managed-runtime @args
exit $LASTEXITCODE
