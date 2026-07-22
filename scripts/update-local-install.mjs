#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptFile), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

function run(command, args, { capture = false } = {}) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit'
  });
  if (result.error) throw new Error(`Unable to run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = capture ? result.stderr.trim() || result.stdout.trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ` with exit ${result.status}`}`);
  }
  return result.stdout?.trim() ?? '';
}

function requireCleanCheckout() {
  const status = run('git', ['status', '--porcelain'], { capture: true });
  if (status) throw new Error(`The checkout has uncommitted changes. Commit or stash them before updating:\n${status}`);
}

export function normalizeRegistry(value) {
  let registry;
  try {
    registry = new URL(String(value).trim());
  } catch {
    throw new Error(`Invalid npm registry URL: ${value}`);
  }
  if (!['http:', 'https:'].includes(registry.protocol)) throw new Error('The npm registry must use http:// or https://.');
  if (registry.username || registry.password) throw new Error('Do not place registry credentials in the URL; configure authentication in .npmrc.');
  if (registry.search || registry.hash) throw new Error('The npm registry URL cannot contain a query string or fragment.');
  if (!registry.pathname.endsWith('/')) registry.pathname += '/';
  return registry.toString();
}

export function registryArgument(args = process.argv.slice(2)) {
  const equals = args.find((item) => item.startsWith('--registry='));
  if (equals) return equals.slice('--registry='.length);
  const index = args.indexOf('--registry');
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--registry requires a URL.');
  return args[index + 1];
}

async function chooseRegistry() {
  const configuredValue = run(npm, ['config', 'get', 'registry'], { capture: true });
  const configured = /^https?:\/\//i.test(configuredValue) ? normalizeRegistry(configuredValue) : PUBLIC_REGISTRY;
  const supplied = registryArgument() ?? process.env.SINGULARITY_FLOW_NPM_REGISTRY;
  if (supplied) {
    const registry = normalizeRegistry(supplied);
    console.log(`Using npm registry: ${registry}`);
    return registry;
  }
  if (!input.isTTY || !output.isTTY) {
    console.log(`Using configured npm registry: ${configured}`);
    return configured;
  }
  const io = readline.createInterface({ input, output });
  try {
    console.log('\nChoose npm registry:');
    console.log(`  1. Configured registry — ${configured}`);
    console.log(`  2. Public npm registry — ${PUBLIC_REGISTRY}`);
    console.log('  3. Custom company registry / Artifactory');
    const choice = (await io.question('Enter 1-3 [1]: ')).trim() || '1';
    if (choice === '1') return configured;
    if (choice === '2') return PUBLIC_REGISTRY;
    if (choice === '3') return normalizeRegistry(await io.question('Registry URL: '));
    throw new Error('Registry selection must be 1, 2, or 3.');
  } finally {
    io.close();
  }
}

function pack() {
  const output = run(npm, ['pack', '--json'], { capture: true });
  let result;
  try {
    result = JSON.parse(output);
  } catch (error) {
    throw new Error(`npm pack did not return valid JSON: ${error.message}`);
  }
  const filename = result?.[0]?.filename;
  if (!filename) throw new Error('npm pack did not report a tarball filename.');
  console.log(`Created ${filename}`);
  return path.join(root, filename);
}

async function main() {
  console.log('Updating Singularity Flow from the current tracked branch.');
  requireCleanCheckout();
  run('copilot', ['--version']);
  run('git', ['pull', '--ff-only']);
  const registry = await chooseRegistry();
  run(npm, ['install', `--registry=${registry}`]);
  const tarball = pack();
  run(npm, ['install', '--global', tarball, `--registry=${registry}`]);
  // The installer removes both the legacy direct identity and any previous
  // marketplace identity before installing one current marketplace copy.
  run('singularity-flow', ['plugin', 'install']);
  run('singularity-flow', ['--version']);
  run('copilot', ['plugin', 'list']);
  console.log(`\nUpdate complete. Distribution tarball: ${tarball}`);
  console.log(`Registry: ${registry}`);
  console.log('Start a new Copilot session so it loads the refreshed skills.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  try {
    await main();
  } catch (error) {
    console.error(`\nSingularity Flow update failed: ${error.message}`);
    process.exitCode = 1;
  }
}
