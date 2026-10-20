$ErrorActionPreference = 'Stop'
$runtimeRoot = if ($env:SINGULARITY_FLOW_ENGINE_HOME) { $env:SINGULARITY_FLOW_ENGINE_HOME } else { Join-Path $env:USERPROFILE '.singularity-flow/engine' }
if (-not [IO.Path]::IsPathRooted($runtimeRoot)) { throw 'SFlow engine home must be absolute.' }
$runtimeArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($runtimeArch -notin @('arm64', 'x64')) { throw "Unsupported Node CPU architecture: $runtimeArch" }
$runtimeRows = @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'node-runtime.lock') | Where-Object { $_ -match "^win32 $runtimeArch " })
if ($runtimeRows.Count -ne 1) { throw 'Invalid pinned Node runtime lock.' }
$runtimeFields = $runtimeRows[0] -split ' '
$runtimeVersion = $runtimeFields[2]; $runtimeArchive = $runtimeFields[3]; $runtimeSha = $runtimeFields[4]
if ($runtimeFields.Count -ne 5 -or $runtimeVersion -notmatch '^26\.\d+\.\d+$' -or $runtimeSha -notmatch '^[a-f0-9]{64}$' -or $runtimeArchive -ne "node-v$runtimeVersion-win-$runtimeArch.zip") { throw 'Invalid pinned Node runtime lock.' }
$runtimeId = "node-v$runtimeVersion-win32-$runtimeArch"
$runtimeTarget = Join-Path $runtimeRoot "runtimes/$runtimeId"
$runtimeNode = Join-Path $runtimeTarget 'node.exe'
foreach ($runtimeDir in @($runtimeRoot, (Join-Path $runtimeRoot 'runtimes'))) {
  if (Test-Path -LiteralPath $runtimeDir) {
    if ((Get-Item -LiteralPath $runtimeDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SFlow runtime directories must not be reparse points.' }
  } else { [void][IO.Directory]::CreateDirectory($runtimeDir) }
}
if (Test-Path -LiteralPath $runtimeTarget) {
  if ((Get-Item -LiteralPath $runtimeTarget -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private Node must not be a reparse point.' }
  if (-not (Test-Path -LiteralPath (Join-Path $runtimeTarget '.sflow-archive-sha256')) -or (Get-Content -Raw -LiteralPath (Join-Path $runtimeTarget '.sflow-archive-sha256')).Trim() -ne $runtimeSha) { throw 'Private Node is incomplete; preserve it and repair installation.' }
  if ((& $runtimeNode --version) -ne "v$runtimeVersion" -or $LASTEXITCODE -ne 0) { throw 'Private Node version mismatch.' }
  Write-Output $runtimeNode; return
}
$runtimeStage = Join-Path $runtimeRoot "runtimes/.prepare-$([Guid]::NewGuid().ToString('N'))"
[void][IO.Directory]::CreateDirectory($runtimeStage)
try {
  $runtimeFile = Join-Path $runtimeStage $runtimeArchive
  if ($env:SINGULARITY_FLOW_NODE_ARCHIVE_DIR) {
    Copy-Item -LiteralPath (Join-Path $env:SINGULARITY_FLOW_NODE_ARCHIVE_DIR $runtimeArchive) -Destination $runtimeFile
  } else {
    $runtimeMirror = if ($env:SINGULARITY_FLOW_NODE_MIRROR) { $env:SINGULARITY_FLOW_NODE_MIRROR.TrimEnd('/') } else { 'https://nodejs.org/dist' }
    if ($runtimeMirror -notmatch '^https://' -or $runtimeMirror -match '[@?#]') { throw 'Node mirror must use HTTPS without embedded credentials.' }
    Write-Host "Preparing private Node $runtimeVersion for Windows/$runtimeArch..."
    # PowerShell 5.1 and modern PowerShell both support this bounded download.
    Invoke-WebRequest -UseBasicParsing -Uri "$runtimeMirror/v$runtimeVersion/$runtimeArchive" -OutFile $runtimeFile -TimeoutSec 600
  }
  # Use .NET primitives: office hosts may launch Windows PowerShell from PowerShell 7 with a
  # PSModulePath that cannot autoload the Get-FileHash/Expand-Archive script modules.
  $runtimeHasher = [Security.Cryptography.SHA256]::Create()
  $runtimeStream = [IO.File]::OpenRead($runtimeFile)
  try { $runtimeActual = [BitConverter]::ToString($runtimeHasher.ComputeHash($runtimeStream)).Replace('-', '').ToLowerInvariant() }
  finally { $runtimeStream.Dispose(); $runtimeHasher.Dispose() }
  if ($runtimeActual -ne $runtimeSha) { throw 'Node archive checksum mismatch; nothing was activated.' }
  [void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem')
  [IO.Compression.ZipFile]::ExtractToDirectory($runtimeFile, (Join-Path $runtimeStage 'unpack'))
  $runtimeUnpacked = Join-Path $runtimeStage "unpack/node-v$runtimeVersion-win-$runtimeArch"
  if (-not (Test-Path -LiteralPath (Join-Path $runtimeUnpacked 'LICENSE'))) { throw 'Node archive is incomplete.' }
  if ((& (Join-Path $runtimeUnpacked 'node.exe') --version) -ne "v$runtimeVersion" -or $LASTEXITCODE -ne 0) { throw 'Private Node version mismatch.' }
  [IO.File]::WriteAllText((Join-Path $runtimeUnpacked '.sflow-archive-sha256'), "$runtimeSha`n")
  # Same-filesystem Directory.Move refuses an existing target atomically. A persistent preparation
  # lock is unnecessary and would strand a machine without Node if its owner crashed.
  if (Test-Path -LiteralPath $runtimeTarget) { throw 'Another installer prepared Node; retry installation.' }
  [IO.Directory]::Move($runtimeUnpacked, $runtimeTarget)
  Write-Output $runtimeNode
} finally {
  Remove-Item -LiteralPath $runtimeStage -Recurse -Force
}
