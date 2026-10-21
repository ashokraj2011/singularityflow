/** Per-user command discovery. Never adds private Node/npm or edits a system-wide PATH. */
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { installerProcess } from './install.mjs';
import { resolveWindowsSystemTool } from '../src/platform-process.mjs';

const START = '# >>> SFlow managed commands >>>';
const END = '# <<< SFlow managed commands <<<';
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function managedPathProfile(original, root) {
  if (/[\0\r\n]/u.test(root) || root.includes(path.delimiter)) throw new Error('Managed engine path cannot contain control or PATH separator characters.');
  const begin = original.indexOf(START), end = original.indexOf(END);
  if ((begin < 0) !== (end < 0) || (begin >= 0 && (end < begin
    || original.indexOf(START, begin + START.length) >= 0 || original.indexOf(END, end + END.length) >= 0))) {
    throw new Error('SFlow PATH profile markers are incomplete or duplicated; existing profile was preserved.');
  }
  const bin = quote(path.join(root, 'bin'));
  const block = `${START}\nexport SINGULARITY_FLOW_ENGINE_HOME=${quote(root)}\ncase ":$PATH:" in\n  *:${bin}:*) ;;\n  *) export PATH=${bin}:"$PATH" ;;\nesac\n${END}`;
  if (begin >= 0) return original.slice(0, begin) + block + original.slice(end + END.length);
  return `${original}${original && !original.endsWith('\n') ? '\n' : ''}\n${block}\n`;
}

/** Use the user's registry, preserving unexpanded entries and refusing concurrent PATH edits. */
export async function windowsUserPath({ root, environment = process.env, execute = installerProcess,
  registryKey = 'Environment' } = {}) {
  if (!/^Environment(?:\\SFlowTest-[a-z0-9-]+)?$/iu.test(registryKey)) throw new Error('Invalid user environment registry target.');
  const script = `
$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SFLOW_USER_PATH_PAYLOAD)) | ConvertFrom-Json
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($payload.key)
try {
  $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { throw 'User PATH has an unsupported registry type; preserved.' }
  $entries = @($old -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $payload.bin.TrimEnd('\\') })
  $updated = (@($payload.bin) + $entries) -join ';'
  if ([string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $old) { throw 'User PATH changed concurrently; retry setup.' }
  $key.SetValue('Path', $updated, $kind)
  $key.SetValue('SINGULARITY_FLOW_ENGINE_HOME', [string]$payload.root, [Microsoft.Win32.RegistryValueKind]::String)
  if ([string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $updated) { throw 'User PATH update could not be verified.' }
  if ([string]$key.GetValue('SINGULARITY_FLOW_ENGINE_HOME') -cne $payload.root) { throw 'User engine selection could not be verified.' }
} finally { $key.Dispose() }
`;
  // The system-tool helper accepts basenames only; join the fixed PowerShell subpath explicitly.
  const powershell = path.join(path.dirname(resolveWindowsSystemTool(environment, 'cmd.exe')), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    capture: true, timeoutMs: 30_000, env: { ...environment,
      SFLOW_USER_PATH_PAYLOAD: Buffer.from(JSON.stringify({ key: registryKey, root, bin: path.join(root, 'bin') })).toString('base64') }
  });
  return { scope: 'current-user', registryKey, bin: path.join(root, 'bin'), restartTerminal: true };
}

export async function installUserPath({ root, homeDirectory = os.homedir(), environment = process.env,
  platform = process.platform, updateWindows = windowsUserPath } = {}) {
  if (platform === 'win32') return updateWindows({ root, environment });
  const zsh = path.basename(environment.SHELL || '/bin/zsh') === 'zsh';
  const bash = path.basename(environment.SHELL || '') === 'bash';
  const directory = zsh && environment.ZDOTDIR ? path.resolve(environment.ZDOTDIR) : homeDirectory;
  const names = zsh ? ['.zprofile', '.zshrc'] : bash ? ['.bash_profile', '.bashrc'] : ['.profile'];
  const files = [];
  for (const name of names) {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const before = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (before && (!before.isFile() || before.isSymbolicLink() || before.size > 2 * 1024 * 1024)) throw new Error(`Shell profile is not a bounded ordinary file; preserved: ${file}`);
    const original = before ? await readFile(file, 'utf8') : '';
    const updated = managedPathProfile(original, root);
    if (updated !== original) {
      const temporary = `${file}.sflow-${randomUUID()}`;
      try {
        await writeFile(temporary, updated, { flag: 'wx', mode: before ? before.mode & 0o777 : 0o600 });
        const now = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (Boolean(now) !== Boolean(before) || (now && (!now.isFile() || now.isSymbolicLink()
          || (before.ino && (now.ino !== before.ino || now.dev !== before.dev)) || await readFile(file, 'utf8') !== original))) {
          throw new Error(`Shell profile changed concurrently; retry setup: ${file}`);
        }
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
    }
    files.push(file);
  }
  return { scope: 'current-user', files, bin: path.join(root, 'bin'), restartTerminal: true };
}
