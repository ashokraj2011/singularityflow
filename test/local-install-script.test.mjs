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
  assert.match(packageJson.devDependencies?.typescript ?? '', /^\^5\./,
    'CLI-only installs need TypeScript because the mandatory schema migration check imports it');
  assert.ok((await stat(scriptPath)).mode & 0o100, 'install.sh must be executable');
  assert.match(script, /git status --porcelain/);
  assert.match(script, /git pull --ff-only/);
  assert.match(script, /npm ci --registry="\$REGISTRY"/);
  assert.match(script, /export NPM_CONFIG_REGISTRY="\$REGISTRY"/);
  assert.match(script, /npm run vscode:build/);
  assert.match(script, /scripts\/stamp-build-info\.mjs/);
  assert.match(script, /BUILD_INFO_BACKUP/);
  assert.doesNotMatch(script, /git[^\n]*checkout[^\n]*build-info\.mjs/,
    'restoration must use the byte backup rather than rewriting through Git');
  assert.match(script, /npm pack --json/);
  assert.match(script, /npm uninstall --global singularity-flow/);
  assert.match(script, /npm install --global "\$PROJECT_DIR\/\$TARBALL" --registry="\$REGISTRY"/);
  assert.match(script, /singularity-flow plugin install/);
  assert.match(script, /sflow_copilot\(\)/);
  assert.match(script, /singularity-flow copilot/);
  assert.doesNotMatch(script, /^\s*'copilot\(\) \{'/m, 'the installer must never shadow manual Copilot');
  assert.match(script, /--no-copilot-telemetry/);
  assert.match(script, /--factory-reset/);
  assert.match(script, /--clean-reinstall/);
  assert.match(script, /--no-workspace-workflow-sync/);
  assert.match(script, /refresh_registered_workspace_configurations/);
  assert.match(script, /singularity-flow workspace refresh-configuration/);
  assert.doesNotMatch(script, /singularity-flow workflow install "\$workflow_id"/);
  assert.match(script, /REINSTALL_ARGS=\(reinstall --checkout "\$PROJECT_DIR"\)/);
  assert.ok(script.indexOf('if [[ "$CLEAN_REINSTALL" == "on" ]]') < script.indexOf('REQUIRED_COMMANDS=(git node npm)'),
    'clean reinstall must delegate before the normal installer can require or execute Git');
  assert.match(script, /fresh-install-reset\.mjs --yes/);
  assert.ok(script.indexOf('fresh-install-reset.mjs --yes') < script.indexOf("git status --porcelain"));
  assert.match(script, /code --uninstall-extension singularityflow\.singularity-flow-vscode/);
  assert.match(script, /npm run vscode:package/);
  assert.match(script, /code --install-extension "\$VSIX_PATH" --force/);
  assert.match(script, /Prompt and response content capture remains disabled/);
  assert.ok(script.indexOf('git pull --ff-only') < script.indexOf('npm ci --registry="$REGISTRY"'));
  assert.ok(script.indexOf('npm ci --registry="$REGISTRY"') < script.indexOf('npm pack --json'));
  assert.ok(script.indexOf('scripts/stamp-build-info.mjs') < script.indexOf('npm pack --json'));
  assert.ok(script.indexOf('npm pack --json') < script.indexOf('npm install --global "$PROJECT_DIR/$TARBALL"'));
  assert.ok(script.indexOf('npm install --global "$PROJECT_DIR/$TARBALL"') < script.indexOf('singularity-flow plugin install'));
});

test('Windows Git Bash wrapper validates CRLF support and delegates to the canonical installer', async () => {
  const scriptPath = path.join(root, 'install-windows-git-bash.sh');
  const script = await readFile(scriptPath, 'utf8');
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['install:windows'], 'bash ./install-windows-git-bash.sh');
  assert.ok((await stat(scriptPath)).mode & 0o100, 'Windows Git Bash wrapper must be executable');
  assert.match(script, /Node\.js 20 or newer is required/);
  assert.match(script, /git -C "\$PROJECT_DIR" pull --ff-only/);
  assert.match(script, /Git for Windows commonly checks Markdown out with CRLF/);
  assert.match(script, /exec bash "\$PROJECT_DIR\/install\.sh"/);
  assert.match(script, /--registry/);
  assert.match(script, /--cli-only/);
  assert.match(script, /--no-copilot-telemetry/);
  assert.match(script, /--no-workspace-workflow-sync/);
  assert.doesNotMatch(script, /core\.autocrlf|git config|dos2unix|sed -i/,
    'the wrapper must not rewrite files or alter Git line-ending policy');
});

test('single installer supports Artifactory without accepting credentials in URLs', async () => {
  const script = await readFile(path.join(root, 'install.sh'), 'utf8');
  assert.match(script, /--registry=\*/);
  assert.match(script, /SINGULARITY_FLOW_NPM_REGISTRY/);
  assert.match(script, /NPM_CONFIG_REGISTRY/);
  assert.match(script, /registry\.username \|\| registry\.password/);
  assert.match(script, /configure authentication in \.npmrc/);
  assert.match(script, /registry\.search \|\| registry\.hash/);
  assert.match(script, /http:/);
  assert.match(script, /https:/);
});

test('clean reinstall delegates before any Git requirement or repository operation', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sflow-clean-reinstall-script-'));
  const bin = path.join(fixture, 'bin');
  const log = path.join(fixture, 'commands.log');
  await mkdir(bin, { recursive: true });
  for (const command of ['node', 'git']) {
    const file = path.join(bin, command);
    await writeFile(file, `#!/usr/bin/env bash\nprintf '%s\\n' '${command} '"$*" >> "$INSTALL_TEST_LOG"\n${command === 'git' ? 'exit 97' : 'exit 0'}\n`);
    await chmod(file, 0o755);
  }
  const registry = 'https://artifacts.example.test/api/npm/npm-virtual/';
  const result = spawnSync('bash', [path.join(root, 'install.sh'), '--clean-reinstall', '--registry', registry], {
    cwd: fixture,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:/bin:/usr/bin`, INSTALL_TEST_LOG: log }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const commands = await readFile(log, 'utf8');
  assert.doesNotMatch(commands, /^git /m);
  assert.match(commands, /node .*bin\/singularity-flow\.mjs reinstall --checkout/);
  assert.match(commands, new RegExp(`--registry ${registry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(commands, /--dry-run/);
});

test('standalone install script executes the complete workflow with one invocation', async () => {
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sflow-single-installer-'));
  const bin = path.join(fixture, 'bin');
  const log = path.join(fixture, 'commands.log');
  await mkdir(bin, { recursive: true });
  const activeRepository = path.join(fixture, 'active-repository');
  await mkdir(path.join(fixture, '.singularity-flow'), { recursive: true });
  await mkdir(activeRepository, { recursive: true });
  await writeFile(path.join(fixture, '.singularity-flow', 'active-workspace.json'), JSON.stringify({
    repositoryPath: activeRepository
  }));
  await copyFile(path.join(root, 'install.sh'), path.join(fixture, 'install.sh'));
  await chmod(path.join(fixture, 'install.sh'), 0o755);

  const fake = async (name, body) => {
    const file = path.join(bin, name);
    await writeFile(file, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "${name} $* registry=\${NPM_CONFIG_REGISTRY:-}" >> "$INSTALL_TEST_LOG"\n${body}\n`);
    await chmod(file, 0o755);
  };
  await fake('git', `
if [[ "$*" == "status --porcelain" ]]; then exit 0; fi
if [[ "\${1:-}" == "-C" && "\${3:-}" == "rev-parse" && "\${4:-}" == "--show-toplevel" ]]; then printf '%s\\n' "\${2}"; exit 0; fi
if [[ "\${1:-}" == "-C" && "\${3:-}" == "status" && "\${4:-}" == "--porcelain" ]]; then exit 0; fi`);
  await fake('npm', `
if [[ "$*" == "config get registry" ]]; then printf '%s\\n' 'https://registry.npmjs.org/'; exit 0; fi
if [[ "$*" == "pack --json" ]]; then printf '%s\\n' '[{"filename":"singularity-flow-test.tgz"}]'; exit 0; fi
if [[ "$*" == "run vscode:package" ]]; then mkdir -p "$PWD/apps/vscode"; touch "$PWD/apps/vscode/singularity-flow-vscode-${version}.vsix"; fi`);
  await fake('copilot', 'if [[ "$*" == "plugin list" ]]; then printf "%s\\n" "Installed plugins: singularity-flow@singularity-flow"; fi');
  await fake('code', 'true');
  await fake('singularity-flow', `
if [[ "$*" == "--version" ]]; then printf "%s\\n" "${version}"; fi
if [[ "$*" == "workflow list --json" ]]; then
  printf '%s\\n' '[{"id":"benchmarking-a","status":"available","installed":false},{"id":"feature","status":"current","installed":true}]'
fi`);

  const registry = 'https://artifacts.example.com/api/npm/npm-virtual/';
  const activeWorkspace = path.join(fixture, '.singularity-flow', 'active-workspace.json');
  const result = spawnSync('bash', [path.join(fixture, 'install.sh'), '--registry', registry], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:${process.env.PATH}`,
      INSTALL_TEST_LOG: log,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`Installed Singularity Flow ${version.replaceAll('.', '\\.')}`));
  assert.match(result.stdout, /SFlow Copilot launcher helper: enabled/);
  assert.match(result.stdout, /Prompt and response content capture remains disabled/);
  assert.match(result.stdout, /Use sflow copilot for consented, story-scoped local usage capture/);
  const telemetryEnv = await readFile(path.join(fixture, '.singularity-flow', 'copilot-otel.sh'), 'utf8');
  const shellProfile = await readFile(path.join(fixture, '.zshrc'), 'utf8');
  assert.match(telemetryEnv, /sflow_copilot\(\)/);
  assert.match(telemetryEnv, /singularity-flow copilot/);
  assert.doesNotMatch(telemetryEnv, /COPILOT_OTEL_|OTEL_EXPORTER_|^copilot\(\)/m);
  assert.match(shellProfile, /\.singularity-flow\/copilot-otel\.sh/);
  const commands = await readFile(log, 'utf8');
  for (const expected of [
    'git pull --ff-only',
    `npm ci --registry=${registry}`,
    'npm run vscode:build',
    'npm test',
    'npm run check',
    'npm pack --json',
    'npm uninstall --global singularity-flow',
    `npm install --global ${fixture}/singularity-flow-test.tgz --registry=${registry}`,
    'npm run vscode:package',
    `code --install-extension ${fixture}/apps/vscode/singularity-flow-vscode-${version}.vsix --force`,
    'singularity-flow plugin install',
    'singularity-flow workspace refresh-configuration',
    'copilot plugin list'
  ]) assert.match(commands, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const npmCommands = commands.split('\n').filter((line) => line.startsWith('npm '));
  assert.ok(npmCommands.length >= 8, 'the complete install exercises every npm subprocess');
  for (const command of npmCommands) {
    if (command.startsWith('npm config get registry')) continue;
    assert.match(command, new RegExp(` registry=${registry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      `selected Artifactory registry must reach: ${command}`);
  }
  assert.ok(commands.indexOf('git pull --ff-only') < commands.indexOf('npm ci --registry='));
  assert.ok(commands.indexOf('npm pack --json') < commands.indexOf('npm install --global'));
  assert.ok(commands.indexOf('npm install --global') < commands.indexOf('singularity-flow plugin install'));

  await writeFile(log, '');
  const standardEnvironment = spawnSync('bash', [path.join(fixture, 'install.sh'), '--cli-only'], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:${process.env.PATH}`,
      INSTALL_TEST_LOG: log,
      NPM_CONFIG_REGISTRY: registry,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace
    }
  });
  assert.equal(standardEnvironment.status, 0, `${standardEnvironment.stdout}\n${standardEnvironment.stderr}`);
  assert.match(standardEnvironment.stdout, new RegExp(`Using npm registry: ${registry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const environmentCommands = (await readFile(log, 'utf8')).split('\n').filter((line) => line.startsWith('npm '));
  assert.ok(environmentCommands.length >= 6);
  for (const command of environmentCommands) {
    assert.match(command, new RegExp(` registry=${registry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      `NPM_CONFIG_REGISTRY must reach: ${command}`);
  }
});
