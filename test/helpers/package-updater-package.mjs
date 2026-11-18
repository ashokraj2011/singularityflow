import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildPackageUpdater } from '../../scripts/build-package-updater.mjs';

const execute = promisify(execFile);
export async function standaloneUpdater(directory) {
  const built = await buildPackageUpdater({ outDirectory: path.join(directory, 'distribution') });
  const extracted = path.join(directory, 'extracted');
  await mkdir(extracted);
  if (process.platform === 'win32') {
    await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-Command',
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:SFLOW_UPDATER_TEST_ZIP,$env:SFLOW_UPDATER_TEST_DESTINATION)"],
    { env: { ...process.env, SFLOW_UPDATER_TEST_ZIP: built.archive, SFLOW_UPDATER_TEST_DESTINATION: extracted } });
  } else await execute('/usr/bin/unzip', ['-q', built.archive, '-d', extracted]);
  return path.join(extracted, built.folderName);
}
