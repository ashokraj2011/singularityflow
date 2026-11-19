import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { processCommand } from './process.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export function runtimePathFromOutput(output, platform = process.platform) {
  const lines = String(output).trim().split(/\r?\n/u).filter(Boolean), executable = lines.pop() ?? '';
  const layout = platform === 'win32' ? path.win32 : path.posix;
  if (!layout.isAbsolute(executable) || /[\0\r\n]/u.test(executable)
    || layout.basename(executable).toLowerCase() !== (platform === 'win32' ? 'node.exe' : 'node')) {
    throw Error('Private runtime bootstrap did not return an absolute Node executable path.');
  }
  return { executable, progress: lines.join('\n') };
}
export async function managedNode(environment = process.env, execute = processCommand) {
  const runtime = path.resolve(path.dirname(process.execPath), process.platform === 'win32' ? '.' : '..');
  if (/^node-v26\.\d+\.\d+-(darwin|linux|win32)-(arm64|x64)$/u.test(path.basename(runtime))) return process.execPath;
  const command = process.platform === 'win32'
    ? path.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/bash';
  const args = process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-File', path.join(root, '..', 'bootstrap.ps1')]
    : [path.join(root, '..', 'bootstrap.sh')];
  const result = await execute(command, args, { env: environment, capture: true, timeoutMs: 660000 });
  if (result.stderr) process.stderr.write(result.stderr);
  const { executable, progress } = runtimePathFromOutput(result.stdout);
  if (progress) process.stderr.write(progress + '\n');
  const info = await lstat(executable);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Private runtime executable is not an ordinary file.');
  return executable;
}
export async function installPackages(pair, { environment = process.env, execute = processCommand, nodeResolver = managedNode,
  reinstall = false, reinstallCopilot = false } = {}) {
  const executable = await nodeResolver(environment, execute);
  await execute(executable, [path.join(root, '..', 'install-pair.mjs'), '--tarball', pair.tarball,
    '--vsix', pair.vsix, '--cli-sha256', pair.cliSha256, '--vsix-sha256', pair.vsixSha256,
    ...(reinstall ? ['--reinstall'] : reinstallCopilot ? ['--reinstall-copilot'] : [])], {
    cwd: path.dirname(pair.tarball), env: environment, timeoutMs: 3600000
  });
}
