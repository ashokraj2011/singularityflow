import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { chmod, copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('local installer performs a safe ordered pull, pack, global install, and plugin replacement', async () => {
  const scriptPath = path.join(root, 'install.sh');
  const script = await readFile(scriptPath, 'utf8');
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['install:local'], 'bash ./install.sh');
  assert.ok((await stat(scriptPath)).mode & 0o100, 'install.sh must be executable');
  assert.match(script, /git status --porcelain/);
  assert.match(script, /git pull --ff-only/);
  assert.match(script, /npm ci --registry="\$REGISTRY"/);
  assert.match(script, /npm run desktop:build/);
  assert.match(script, /npm pack --json/);
  assert.match(script, /npm uninstall --global singularity-flow/);
  assert.match(script, /npm install --global "\$PROJECT_DIR\/\$TARBALL" --registry="\$REGISTRY"/);
  assert.match(script, /singularity-flow plugin install/);
  assert.ok(script.indexOf('git pull --ff-only') < script.indexOf('npm ci --registry="$REGISTRY"'));
  assert.ok(script.indexOf('npm ci --registry="$REGISTRY"') < script.indexOf('npm pack --json'));
  assert.ok(script.indexOf('npm pack --json') < script.indexOf('npm install --global "$PROJECT_DIR/$TARBALL"'));
  assert.ok(script.indexOf('npm install --global "$PROJECT_DIR/$TARBALL"') < script.indexOf('singularity-flow plugin install'));
});

test('single installer supports Artifactory without accepting credentials in URLs', async () => {
  const script = await readFile(path.join(root, 'install.sh'), 'utf8');
  assert.match(script, /--registry=\*/);
  assert.match(script, /SINGULARITY_FLOW_NPM_REGISTRY/);
  assert.match(script, /registry\.username \|\| registry\.password/);
  assert.match(script, /configure authentication in \.npmrc/);
  assert.match(script, /registry\.search \|\| registry\.hash/);
  assert.match(script, /http:/);
  assert.match(script, /https:/);
});

test('standalone install script executes the complete workflow with one invocation', async () => {
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sflow-single-installer-'));
  const bin = path.join(fixture, 'bin');
  const log = path.join(fixture, 'commands.log');
  await mkdir(bin, { recursive: true });
  await copyFile(path.join(root, 'install.sh'), path.join(fixture, 'install.sh'));
  await chmod(path.join(fixture, 'install.sh'), 0o755);

  const fake = async (name, body) => {
    const file = path.join(bin, name);
    await writeFile(file, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "${name} $*" >> "$INSTALL_TEST_LOG"\n${body}\n`);
    await chmod(file, 0o755);
  };
  await fake('git', 'if [[ "$*" == "status --porcelain" ]]; then exit 0; fi');
  await fake('npm', `
if [[ "$*" == "config get registry" ]]; then printf '%s\\n' 'https://registry.npmjs.org/'; exit 0; fi
if [[ "$*" == "pack --json" ]]; then printf '%s\\n' '[{"filename":"singularity-flow-test.tgz"}]'; exit 0; fi`);
  await fake('copilot', 'if [[ "$*" == "plugin list" ]]; then printf "%s\\n" "Installed plugins: singularity-flow@singularity-flow"; fi');
  await fake('singularity-flow', `if [[ "$*" == "--version" ]]; then printf "%s\\n" "${version}"; fi`);

  const registry = 'https://artifacts.example.com/api/npm/npm-virtual/';
  const result = spawnSync('bash', [path.join(fixture, 'install.sh'), '--registry', registry], {
    cwd: fixture,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALL_TEST_LOG: log }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`Installed Singularity Flow ${version.replaceAll('.', '\\.')}`));
  const commands = await readFile(log, 'utf8');
  for (const expected of [
    'git pull --ff-only',
    `npm ci --registry=${registry}`,
    'npm run desktop:build',
    'npm test',
    'npm run check',
    'npm pack --json',
    'npm uninstall --global singularity-flow',
    `npm install --global ${fixture}/singularity-flow-test.tgz --registry=${registry}`,
    'singularity-flow plugin install',
    'copilot plugin list'
  ]) assert.match(commands, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(commands.indexOf('git pull --ff-only') < commands.indexOf('npm ci --registry='));
  assert.ok(commands.indexOf('npm pack --json') < commands.indexOf('npm install --global'));
  assert.ok(commands.indexOf('npm install --global') < commands.indexOf('singularity-flow plugin install'));
});
