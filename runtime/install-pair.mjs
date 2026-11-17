#!/usr/bin/env node
/** Direct, user-selected package-pair installation. No release signature is manufactured. */
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectPair } from './updater/artifacts.mjs';
import { processCommand } from './updater/process.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function bytes(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > 512 * 1024 * 1024) throw Error('Package is not a bounded ordinary file.');
  return readFile(file);
}
export async function installPair(options, { execute = processCommand, executable = process.execPath } = {}) {
  if (![options.cliSha256, options.vsixSha256].every(value => /^[a-f0-9]{64}$/u.test(value || ''))) throw Error('Missing package content identity.');
  const [cliBytes, vsixBytes] = await Promise.all([bytes(options.tarball), bytes(options.vsix)]);
  if (sha(cliBytes) !== options.cliSha256 || sha(vsixBytes) !== options.vsixSha256) throw Error('A downloaded package changed before installation. Nothing was activated.');
  await inspectPair(options.tarball, options.vsix);
  const runtime = path.resolve(path.dirname(executable), process.platform === 'win32' ? '.' : '..');
  if (!/^node-v26\.\d+\.\d+-(darwin|linux|win32)-(arm64|x64)$/u.test(path.basename(runtime))) throw Error('Run this helper through update-sflow.sh or update-sflow.ps1 to use the private SFlow runtime.');
  const parent = path.dirname(options.tarball), candidate = path.join(parent, 'candidate'), snapshots = path.join(parent, 'install-inputs');
  await mkdir(snapshots, { mode: 0o700 }); await chmod(snapshots, 0o700);
  const tarball = path.join(snapshots, 'singularity-flow.tgz'), vsix = path.join(snapshots, 'singularity-flow.vsix');
  await writeFile(tarball, cliBytes, { flag: 'wx', mode: 0o600 });
  await writeFile(vsix, vsixBytes, { flag: 'wx', mode: 0o600 });
  const npm = path.join(runtime, ...(process.platform === 'win32' ? ['node_modules', 'npm'] : ['lib', 'node_modules', 'npm']), 'bin', 'npm-cli.js');
  const environment = { ...process.env, NPM_CONFIG_CACHE: path.join(parent, 'npm-cache'), NPM_CONFIG_GLOBAL: 'false',
    NODE_OPTIONS: undefined, NODE_COMPILE_CACHE: undefined, NODE_COMPILE_CACHE_READONLY: undefined };
  console.log('Preparing the downloaded SFlow package offline…');
  await execute(executable, [npm, 'install', '--prefix', candidate, '--offline', '--ignore-scripts',
    '--global=false', '--workspaces=false', '--no-bin-links', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false', tarball],
    { cwd: parent, env: environment, timeoutMs: 900000 });
  const packageRoot = path.join(candidate, 'node_modules', 'singularity-flow');
  const api = path.join(packageRoot, 'runtime', 'product-install.mjs');
  const info = await lstat(api).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw Error('The downloaded CLI does not include SFlow’s full-product installer. Publish a current CLI build; existing installation was preserved.');
  // This is the software the user selected for installation. Source trust is the chosen
  // HTTPS folder, as with a direct package install; this is not a signed-release claim.
  const module = await import(pathToFileURL(api).href);
  if (typeof module.installManagedProduct !== 'function') throw Error('The CLI package has no compatible full-product installer.');
  const result = await module.installManagedProduct({ tarball, sha256: options.cliSha256, vsix, nodeExecutable: executable });
  if (result?.status !== 'complete' || ['cli', 'vscode', 'copilot', 'path'].some(stage => result.stages?.[stage] !== 'verified')) {
    throw Error('The product installer did not confirm all requested surfaces. Its recovery records were preserved; no completion was claimed.');
  }
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {}, fields = { '--tarball': 'tarball', '--vsix': 'vsix', '--cli-sha256': 'cliSha256', '--vsix-sha256': 'vsixSha256' };
    for (let i = 2; i < process.argv.length; i++) {
      const field = fields[process.argv[i]];
      if (!field || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw Error('Invalid package-install helper arguments.');
      options[field] = process.argv[++i];
    }
    if (!options.tarball || !options.vsix) throw Error('Both downloaded packages are required.');
    await installPair(options);
  } catch (error) { console.error('SFlow package update did not finish: ' + error.message); process.exitCode = 1; }
}
