import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function installTestTarball(version) {
  const body = Buffer.from(`${JSON.stringify({ name: 'singularity-flow', version })}\n`);
  const header = Buffer.alloc(512);
  header.write('package/package.json', 0, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  const checksum = [...header].reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return gzipSync(Buffer.concat([
    header,
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
    Buffer.alloc(1024)
  ]));
}

function installTestVsix(version) {
  const name = Buffer.from('extension/package.json');
  const body = Buffer.from(`${JSON.stringify({
    publisher: 'singularityflow',
    name: 'singularity-flow-vscode',
    version
  })}\n`);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralOffset = local.length + name.length + body.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}

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
  assert.match(script, /npm uninstall --global singularity-flow/,
    'rollback must remove a CLI that the failed transaction introduced onto an initially fresh machine');
  assert.match(script, /npm install --global "\$TARBALL_PATH" --cache "\$ACTIVATION_TRANSACTION_CACHE" --registry="\$REGISTRY"/);
  assert.match(script, /INSTALLED_CLI_VERSION="\$\(singularity-flow --version\)"/);
  assert.match(script, /node "\$CANDIDATE_CLI_EXECUTABLE" plugin install/);
  assert.match(script, /sflow_copilot\(\)/);
  assert.match(script, /singularity-flow copilot/);
  assert.doesNotMatch(script, /^\s*'copilot\(\) \{'/m, 'the installer must never shadow manual Copilot');
  assert.match(script, /--no-copilot-telemetry/);
  assert.match(script, /--factory-reset/);
  assert.match(script, /--clean-reinstall/);
  assert.match(script, /--skip-tests/);
  assert.match(script, /--skip-copilot/);
  assert.match(script, /--vscode-only/);
  assert.match(script, /--no-update/);
  assert.match(script, /--from-staged-artifacts/);
  assert.match(script, /Node\.js 20 or newer is required/);
  assert.match(script, /HOSTED_AUTOMATION_FILES="\$\(git ls-files -- '\.github\/workflows\/\*'/);
  assert.match(script, /hosted GitHub workflow assets are unsupported by this installer/);
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
  assert.match(script, /WARNING: full test suite skipped by request/);
  assert.match(script, /code --install-extension "\$VSIX_PATH" --force/);
  assert.match(script, /activation-current\.json/);
  assert.match(script, /INSTALL_RECOVERY_COMMAND/);
  assert.match(script, /lease-acquire/);
  assert.match(script, /lease-heartbeat/);
  assert.match(script, /lease-release/);
  assert.match(script, /INSTALL_ACTIVATION_OWNER_PID="\$\(node -p 'process\.ppid'/);
  assert.doesNotMatch(script, /INSTALL_ACTIVATION_OWNER_PID="\$\$"/);
  assert.match(script, /--owner-pid "\$INSTALL_ACTIVATION_OWNER_PID"/);
  assert.match(script, /--operation-id "\$INSTALL_ACTIVATION_OPERATION_ID"/);
  assert.match(script, /--expected-revision "\$INSTALL_ACTIVATION_JOURNAL_REVISION"/);
  assert.ok(script.indexOf('acquire_activation_lease create') < script.indexOf('node "$INSTALL_ARTIFACT_HELPER" create'));
  assert.ok(script.indexOf('write_activation_journal complete complete') < script.lastIndexOf('release_activation_lease'));
  const cliPreflight = script.slice(script.indexOf('preflight_private_cli()'), script.indexOf('\nrestore_vscode_surface()'));
  assert.match(cliPreflight, /npm install --prefix "\$temporary"/);
  assert.match(cliPreflight, /rm -rf -- "\$target"/,
    'a prior private CLI prefix must be discarded and rebuilt from the retained tarball');
  assert.match(script, /trap activation_failed ERR/);
  assert.match(script, /trap 'activation_signal INT 130' INT/);
  assert.match(script, /trap 'activation_signal TERM 143' TERM/);
  assert.match(script, /trap 'activation_signal HUP 129' HUP/);
  const trappedActivation = script.slice(
    script.indexOf('trap activation_failed ERR'),
    script.indexOf('\ntrap - ERR', script.indexOf('trap activation_failed ERR'))
  );
  assert.doesNotMatch(trappedActivation, /exit 1/,
    'post-staging verification refusals must persist failed recovery state before exiting');
  assert.match(trappedActivation, /singularity-flow is not available[\s\S]*activation_failed 1/);
  assert.match(trappedActivation, /installed CLI reports[\s\S]*activation_failed 1/);
  assert.match(trappedActivation, /VS Code did not report[\s\S]*activation_failed 1/);
  assert.match(script, /Prompt and response content capture remains disabled/);
  assert.ok(script.indexOf('git pull --ff-only') < script.indexOf('npm ci --registry="$REGISTRY"'));
  assert.ok(script.indexOf('npm ci --registry="$REGISTRY"') < script.indexOf('npm pack --json'));
  assert.ok(script.indexOf('scripts/stamp-build-info.mjs') < script.indexOf('npm pack --json'));
  assert.ok(script.indexOf('npm pack --json') < script.indexOf('npm install --global "$TARBALL_PATH"'));
  assert.ok(script.indexOf('node "$INSTALL_ARTIFACT_HELPER" create') < script.indexOf('code --install-extension "$VSIX_PATH" --force'),
    'the exact artifacts and previous identities must be journaled before an active surface changes');
  assert.ok(script.indexOf('code --install-extension "$VSIX_PATH" --force') < script.indexOf('npm install --global "$TARBALL_PATH"'),
    'the globally callable CLI must be the final active product surface replaced');
  assert.ok(script.indexOf('node "$CANDIDATE_CLI_EXECUTABLE" plugin install') < script.indexOf('npm install --global "$TARBALL_PATH"'));
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
  assert.match(script, /--skip-copilot/);
  assert.match(script, /--vscode-only/);
  assert.match(script, /--no-update/);
  assert.match(script, /--from-staged-artifacts/);
  assert.match(script, /--skip-tests/);
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
    await writeFile(file, `#!/usr/bin/env bash\nprintf '%s\\n' '${command} '"$*" >> "$INSTALL_TEST_LOG"\n${command === 'node' ? '[[ "${1:-}" == "-p" ]] && printf "%s\\n" 20\n' : ''}${command === 'git' ? 'exit 97' : 'exit 0'}\n`);
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
  await mkdir(path.join(fixture, 'scripts'), { recursive: true });
  await copyFile(path.join(root, 'install.sh'), path.join(fixture, 'install.sh'));
  await copyFile(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
  await copyFile(
    path.join(root, 'scripts', 'install-staged-artifacts.mjs'),
    path.join(fixture, 'scripts', 'install-staged-artifacts.mjs')
  );
  const stagedTarball = path.join(fixture, 'fixture-singularity-flow.tgz');
  const stagedVsix = path.join(fixture, 'fixture-singularity-flow.vsix');
  const tarballBytes = installTestTarball(version);
  const vsixBytes = installTestVsix(version);
  await writeFile(stagedTarball, tarballBytes);
  await writeFile(stagedVsix, vsixBytes);
  // The fixture starts with managed CLI, VSIX, and Copilot surfaces. Seed the exact prior retained
  // artifacts and receipt that a prior successful installer would have written; activation must
  // refuse a mere observed version with no rollback material.
  const installations = path.join(fixture, '.singularity-flow', 'installations');
  const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const priorTarballDigest = digest(tarballBytes);
  const priorVsixDigest = digest(vsixBytes);
  const priorTarball = path.join(
    installations, 'versions', 'sha256', priorTarballDigest.slice('sha256:'.length), 'singularity-flow.tgz'
  );
  const priorVsix = path.join(
    installations, 'versions', 'sha256', priorVsixDigest.slice('sha256:'.length), 'singularity-flow.vsix'
  );
  await mkdir(path.dirname(priorTarball), { recursive: true });
  await mkdir(path.dirname(priorVsix), { recursive: true });
  await writeFile(priorTarball, tarballBytes, { mode: 0o600 });
  await writeFile(priorVsix, vsixBytes, { mode: 0o600 });
  await writeFile(path.join(installations, 'current.json'), `${JSON.stringify({
    schemaVersion: 2,
    status: 'complete',
    version,
    artifacts: {
      tarball: {
        path: priorTarball, sha256: priorTarballDigest, package: 'singularity-flow', version
      },
      vsix: {
        path: priorVsix, sha256: priorVsixDigest,
        extensionId: 'singularityflow.singularity-flow-vscode', version
      }
    }
  }, null, 2)}\n`, { mode: 0o600 });
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
if [[ "$*" == "pack --json" ]]; then
  cp "$INSTALL_TEST_TARBALL" "$PWD/singularity-flow-test.tgz"
  printf '%s\\n' '[{"filename":"singularity-flow-test.tgz"}]'
  exit 0
fi
if [[ "$*" == "run vscode:package" ]]; then
  mkdir -p "$PWD/apps/vscode"
  cp "$INSTALL_TEST_VSIX" "$PWD/apps/vscode/singularity-flow-vscode-${version}.vsix"
  exit 0
fi
if [[ " $* " == *" --prefix "* ]]; then
  prefix=''
  while (($#)); do
    if [[ "$1" == "--prefix" ]]; then prefix="$2"; shift 2; else shift; fi
  done
  mkdir -p "$prefix/node_modules/singularity-flow/bin"
  printf '%s\\n' '{"name":"singularity-flow","version":"${version}"}' > "$prefix/node_modules/singularity-flow/package.json"
  printf '%s\\n' \\
    'import { appendFileSync } from "node:fs";' \\
    'if (process.argv[2] === "--version") console.log("${version}");' \\
    'else if (process.env.INSTALL_TEST_LOG) appendFileSync(process.env.INSTALL_TEST_LOG, "private-cli " + process.argv.slice(2).join(" ") + "\\\\n");' \\
    > "$prefix/node_modules/singularity-flow/bin/singularity-flow.mjs"
  exit 0
fi
if [[ " $* " == *" --global "* && "\${INSTALL_TEST_REMOVE_CLI_AFTER_GLOBAL:-}" == "1" ]]; then
  rm -f "$INSTALL_TEST_BIN/singularity-flow"
fi
if [[ " $* " == *" --global "* && "\${INSTALL_TEST_FAIL_AFTER_GLOBAL:-}" == "1" ]]; then
  if [[ -f "$HOME/.sflow-global-failed-once" ]]; then
    rm -f "$HOME/.sflow-cli-version-mismatch"
  else
    : > "$HOME/.sflow-global-failed-once"
    : > "$HOME/.sflow-cli-version-mismatch"
  fi
fi`);
  await fake('node', `exec ${JSON.stringify(process.execPath)} "$@"`);
  await fake('copilot', 'if [[ "$*" == "plugin list" ]]; then printf "%s\\n" "Installed plugins: singularity-flow@singularity-flow"; fi');
  await fake('code', `
if [[ "$*" == --install-extension* && "\${INSTALL_TEST_FAIL_CODE:-}" == "1" && ! -f "$HOME/.sflow-code-failed-once" ]]; then
  : > "$HOME/.sflow-code-failed-once"
  exit 17
fi
if [[ "$*" == "--list-extensions --show-versions" ]]; then
  if [[ "\${INSTALL_TEST_VSCODE_VERSION_MISMATCH:-}" == "1" ]]; then
    printf "%s\\r\\n" "singularityflow.singularity-flow-vscode@0.0.1"
  else
    printf "%s\\r\\n" "singularityflow.singularity-flow-vscode@${version}"
  fi
fi`);
  const singularityFlowFake = `
if [[ "$*" == "--version" ]]; then
  if [[ "\${INSTALL_TEST_CLI_VERSION_MISMATCH:-}" == "1" || -f "$HOME/.sflow-cli-version-mismatch" ]]; then
    printf "%s\\n" "0.0.1"
  else
    printf "%s\\n" "${version}"
  fi
fi
if [[ "$*" == "workflow list --json" ]]; then
  printf '%s\\n' '[{"id":"benchmarking-a","status":"available","installed":false},{"id":"feature","status":"current","installed":true}]'
fi`;
  await fake('singularity-flow', singularityFlowFake);

  const registry = 'https://artifacts.example.com/api/npm/npm-virtual/';
  const activeWorkspace = path.join(fixture, '.singularity-flow', 'active-workspace.json');
  const result = spawnSync('bash', [path.join(fixture, 'install.sh'), '--registry', registry], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:/usr/bin:/bin`,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_TARBALL: stagedTarball,
      INSTALL_TEST_VSIX: stagedVsix,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`Installed Singularity Flow ${version.replaceAll('.', '\\.')}`));
  assert.match(result.stdout, /SFlow Copilot launcher helper: enabled/);
  assert.match(result.stdout, /Prompt and response content capture remains disabled/);
  assert.match(result.stdout, /Use sflow copilot for consented, story-scoped local usage capture/);
  const activation = JSON.parse(await readFile(path.join(fixture, '.singularity-flow', 'installations', 'activation-current.json'), 'utf8'));
  assert.equal(activation.status, 'complete');
  assert.match(activation.operationId, /^install-[0-9a-f-]+$/u);
  assert.ok(activation.revision > 1);
  assert.match(activation.recoveryCommand, /install\.sh.*--from-staged-artifacts/);
  assert.match(activation.artifacts.tarball.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(activation.artifacts.vsix.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(activation.artifacts.tarball.path, /[/\\]versions[/\\]sha256[/\\][a-f0-9]{64}[/\\]singularity-flow\.tgz$/);
  assert.match(activation.artifacts.vsix.path, /[/\\]versions[/\\]sha256[/\\][a-f0-9]{64}[/\\]singularity-flow\.vsix$/);
  assert.notEqual(activation.artifacts.tarball.path, path.join(fixture, 'singularity-flow-test.tgz'));
  assert.notEqual(activation.artifacts.vsix.path, path.join(fixture, 'apps', 'vscode', `singularity-flow-vscode-${version}.vsix`));
  assert.deepEqual(activation.completedSurfaces, ['vscode', 'copilot-plugin', 'telemetry', 'cli', 'manifest']);
  assert.deepEqual(activation.skippedSurfaces, []);
  assert.equal(activation.previous.cliPresent, true);
  assert.equal(activation.previous.vscodePresent, true);
  assert.equal(activation.previous.copilotPresent, true);
  assert.equal(activation.previous.cli.version, version);
  assert.equal(activation.previous.vscode.version, version);
  assert.equal(activation.previous.manifest.existed, true);
  await assert.rejects(
    stat(path.join(fixture, '.singularity-flow', 'installations', 'activation-current.json.lock')),
    (error) => error?.code === 'ENOENT'
  );
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
    'npm install --prefix',
    `npm install --global ${activation.artifacts.tarball.path}`,
    'singularity-flow --version',
    'npm run vscode:package',
    `code --install-extension ${activation.artifacts.vsix.path} --force`,
    'code --list-extensions --show-versions',
    'private-cli plugin install',
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
  assert.ok(commands.indexOf('npm install --prefix') < commands.indexOf('npm install --global'),
    'the packaged CLI must execute from an isolated digest-bound prefix before global replacement');
  assert.doesNotMatch(commands, /npm uninstall --global/);
  assert.ok(commands.indexOf('code --install-extension') < commands.indexOf('npm install --global'),
    'the globally callable CLI must be installed after the IDE surface');
  assert.ok(commands.indexOf('private-cli plugin install') < commands.indexOf('npm install --global'));

  await writeFile(log, '');
  const standardEnvironment = spawnSync('bash', [path.join(fixture, 'install.sh'), '--cli-only'], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:/usr/bin:/bin`,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_TARBALL: stagedTarball,
      INSTALL_TEST_VSIX: stagedVsix,
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

  await writeFile(log, '');
  const skipped = spawnSync('bash', [
    path.join(fixture, 'install.sh'), '--skip-tests', '--no-workspace-configuration-refresh'
  ], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:/usr/bin:/bin`,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_TARBALL: stagedTarball,
      INSTALL_TEST_VSIX: stagedVsix,
      NPM_CONFIG_REGISTRY: registry,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace
    }
  });
  assert.equal(skipped.status, 0, `${skipped.stdout}\n${skipped.stderr}`);
  assert.match(skipped.stderr, /full test suite skipped by request/);
  const skippedCommands = await readFile(log, 'utf8');
  assert.match(skippedCommands, /npm run check/);
  assert.match(skippedCommands, /npm run vscode:build/);
  assert.doesNotMatch(skippedCommands, /^npm test(?:\s|$)/m);
  assert.doesNotMatch(skippedCommands, /npm run test:cli/);

  await writeFile(log, '');
  await rm(path.join(bin, 'copilot'));
  const withoutCopilot = spawnSync('bash', [
    path.join(fixture, 'install.sh'), '--skip-copilot', '--no-update', '--skip-tests',
    '--no-workspace-configuration-refresh'
  ], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:/usr/bin:/bin`,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_TARBALL: stagedTarball,
      INSTALL_TEST_VSIX: stagedVsix,
      NPM_CONFIG_REGISTRY: registry,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace
    }
  });
  assert.equal(withoutCopilot.status, 0, `${withoutCopilot.stdout}\n${withoutCopilot.stderr}`);
  assert.match(withoutCopilot.stdout, /no Git fetch or pull was run/);
  const withoutCopilotCommands = await readFile(log, 'utf8');
  assert.doesNotMatch(withoutCopilotCommands, /git pull --ff-only/);
  assert.doesNotMatch(withoutCopilotCommands, /^copilot /m);
  assert.doesNotMatch(withoutCopilotCommands, /singularity-flow plugin install/);
  assert.match(withoutCopilotCommands, /code --install-extension/);

  await writeFile(log, '');
  const vscodeOnly = spawnSync('bash', [
    path.join(fixture, 'install.sh'), '--vscode-only', '--no-update', '--skip-tests'
  ], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:/usr/bin:/bin`,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_TARBALL: stagedTarball,
      INSTALL_TEST_VSIX: stagedVsix,
      NPM_CONFIG_REGISTRY: registry,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace
    }
  });
  assert.equal(vscodeOnly.status, 0, `${vscodeOnly.stdout}\n${vscodeOnly.stderr}`);
  assert.match(vscodeOnly.stdout, /VS Code-only installation complete/);
  const vscodeOnlyCommands = await readFile(log, 'utf8');
  assert.match(vscodeOnlyCommands, /npm run vscode:package/);
  assert.match(vscodeOnlyCommands, /code --install-extension/);
  assert.match(vscodeOnlyCommands, /code --list-extensions --show-versions/);
  assert.doesNotMatch(vscodeOnlyCommands, /npm pack --json/);
  assert.doesNotMatch(vscodeOnlyCommands, /npm install --global/);
  assert.doesNotMatch(vscodeOnlyCommands, /singularity-flow plugin install/);
  assert.doesNotMatch(vscodeOnlyCommands, /singularity-flow workspace refresh-configuration/);
  assert.doesNotMatch(vscodeOnlyCommands, /^singularity-flow /m);
  assert.doesNotMatch(vscodeOnlyCommands, /^copilot /m);
  await fake('copilot', 'if [[ "$*" == "plugin list" ]]; then printf "%s\\n" "Installed plugins: singularity-flow@singularity-flow"; fi');

  const journalPath = path.join(fixture, '.singularity-flow', 'installations', 'activation-current.json');
  const currentManifestPath = path.join(fixture, '.singularity-flow', 'installations', 'current.json');
  const beforeCompensation = {
    manifest: await readFile(currentManifestPath),
    telemetry: await readFile(path.join(fixture, '.singularity-flow', 'copilot-otel.sh')),
    profile: await readFile(path.join(fixture, '.zshrc'))
  };
  await rm(path.join(fixture, '.sflow-global-failed-once'), { force: true });
  await rm(path.join(fixture, '.sflow-cli-version-mismatch'), { force: true });
  await writeFile(log, '');
  const compensated = spawnSync('bash', [
    path.join(fixture, 'install.sh'), '--no-update', '--skip-tests', '--no-workspace-configuration-refresh'
  ], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:/usr/bin:/bin`,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_FAIL_AFTER_GLOBAL: '1',
      INSTALL_TEST_TARBALL: stagedTarball,
      INSTALL_TEST_VSIX: stagedVsix,
      NPM_CONFIG_REGISTRY: registry,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace
    }
  });
  assert.notEqual(compensated.status, 0);
  assert.match(compensated.stderr, /every touched surface was restored/);
  const compensatedJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(compensatedJournal.status, 'rolled-back');
  assert.deepEqual(compensatedJournal.rollbackFailures, []);
  assert.deepEqual(compensatedJournal.surfaceStates, {
    vscode: 'restored', copilot: 'restored', telemetry: 'restored', cli: 'restored', manifest: 'pending'
  });
  assert.deepEqual(await readFile(currentManifestPath), beforeCompensation.manifest);
  assert.deepEqual(await readFile(path.join(fixture, '.singularity-flow', 'copilot-otel.sh')), beforeCompensation.telemetry);
  assert.deepEqual(await readFile(path.join(fixture, '.zshrc')), beforeCompensation.profile);

  await writeFile(log, '');
  const missingCli = spawnSync('bash', [
    path.join(fixture, 'install.sh'), '--cli-only', '--no-update', '--skip-tests'
  ], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:/usr/bin:/bin`,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_BIN: bin,
      INSTALL_TEST_REMOVE_CLI_AFTER_GLOBAL: '1',
      INSTALL_TEST_TARBALL: stagedTarball,
      INSTALL_TEST_VSIX: stagedVsix,
      NPM_CONFIG_REGISTRY: registry,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace
    }
  });
  assert.notEqual(missingCli.status, 0);
  assert.match(missingCli.stderr, /singularity-flow is not available on PATH/);
  assert.match(missingCli.stderr, /--from-staged-artifacts/);
  const missingCliJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(missingCliJournal.status, 'rollback-failed');
  assert.equal(missingCliJournal.failureStep, 'Installing the CLI globally');
  assert.deepEqual(missingCliJournal.rollbackFailures, ['cli']);

  await fake('singularity-flow', singularityFlowFake);
  await writeFile(log, '');
  const repairedRollback = spawnSync('bash', [
    path.join(fixture, 'install.sh'), '--from-staged-artifacts'
  ], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:/usr/bin:/bin`,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_TARBALL: stagedTarball,
      INSTALL_TEST_VSIX: stagedVsix,
      NPM_CONFIG_REGISTRY: registry,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace
    }
  });
  assert.equal(repairedRollback.status, 0, `${repairedRollback.stdout}\n${repairedRollback.stderr}`);
  const repairedRollbackJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(repairedRollbackJournal.operationId, missingCliJournal.operationId);
  assert.equal(repairedRollbackJournal.status, 'complete');

  await writeFile(log, '');
  const mismatchedCli = spawnSync('bash', [
    path.join(fixture, 'install.sh'), '--cli-only', '--no-update', '--skip-tests'
  ], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:/usr/bin:/bin`,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_CLI_VERSION_MISMATCH: '1',
      INSTALL_TEST_TARBALL: stagedTarball,
      INSTALL_TEST_VSIX: stagedVsix,
      NPM_CONFIG_REGISTRY: registry,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace
    }
  });
  assert.notEqual(mismatchedCli.status, 0);
  assert.match(mismatchedCli.stderr, /installed tarball version 0\.0\.1 does not match retained rollback version/);
  const mismatchedCliJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(mismatchedCliJournal.operationId, repairedRollbackJournal.operationId,
    'prior-state admission must refuse before replacing the existing journal');
  assert.equal(mismatchedCliJournal.revision, repairedRollbackJournal.revision);

  await writeFile(log, '');
  const mismatchedVsix = spawnSync('bash', [
    path.join(fixture, 'install.sh'), '--vscode-only', '--no-update', '--skip-tests'
  ], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:/usr/bin:/bin`,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_VSCODE_VERSION_MISMATCH: '1',
      INSTALL_TEST_TARBALL: stagedTarball,
      INSTALL_TEST_VSIX: stagedVsix,
      NPM_CONFIG_REGISTRY: registry,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace
    }
  });
  assert.notEqual(mismatchedVsix.status, 0);
  assert.match(mismatchedVsix.stderr, /installed vsix version 0\.0\.1 does not match retained rollback version/);
  const mismatchedVsixJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(mismatchedVsixJournal.operationId, repairedRollbackJournal.operationId);
  assert.equal(mismatchedVsixJournal.revision, repairedRollbackJournal.revision);

  await writeFile(log, '');
  await rm(path.join(fixture, '.sflow-code-failed-once'), { force: true });
  const interrupted = spawnSync('bash', [
    path.join(fixture, 'install.sh'), '--skip-copilot', '--no-update', '--skip-tests'
  ], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:/usr/bin:/bin`,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_TARBALL: stagedTarball,
      INSTALL_TEST_VSIX: stagedVsix,
      INSTALL_TEST_FAIL_CODE: '1',
      NPM_CONFIG_REGISTRY: registry,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace
    }
  });
  assert.notEqual(interrupted.status, 0);
  assert.match(interrupted.stderr, /--from-staged-artifacts/);
  const interruptedJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(interruptedJournal.status, 'rolled-back');
  assert.deepEqual(interruptedJournal.completedSurfaces, []);
  assert.equal(interruptedJournal.surfaceStates.vscode, 'restored');
  assert.equal(interruptedJournal.previous.cli.version, version);
  assert.equal(interruptedJournal.previous.vscode.version, version);
  assert.match(interruptedJournal.artifacts.tarball.path, /[/\\]versions[/\\]sha256[/\\]/);
  assert.match(interruptedJournal.artifacts.vsix.path, /[/\\]versions[/\\]sha256[/\\]/);

  // A digest-named prefix is still mutable machine state. Poison the retained prefix after the
  // interruption: recovery must reconstruct it from the exact retained tarball and never execute
  // this previously cached binary.
  const poisonedPrefix = path.join(
    fixture, '.singularity-flow', 'installations', 'transactions', interruptedJournal.operationId,
    'private-cli-candidate'
  );
  await writeFile(
    path.join(poisonedPrefix, 'node_modules', 'singularity-flow', 'bin', 'singularity-flow.mjs'),
    'console.log("poisoned mutable prefix");\n'
  );

  // Recovery must not depend on the mutable checkout archives or the test's packaging inputs.
  // Recovery starts from a verified rolled-back state and rebuilds the private candidate from the
  // retained archive; it never trusts this mutable per-operation prefix.
  await rm(path.join(fixture, 'singularity-flow-test.tgz'), { force: true });
  await rm(path.join(fixture, 'apps', 'vscode', `singularity-flow-vscode-${version}.vsix`), { force: true });
  await rm(stagedTarball, { force: true });
  await rm(stagedVsix, { force: true });

  await writeFile(log, '');
  const resumed = spawnSync('bash', [path.join(fixture, 'install.sh'), '--from-staged-artifacts'], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture,
      SHELL: '/bin/zsh',
      PATH: `${bin}:/usr/bin:/bin`,
      INSTALL_TEST_LOG: log,
      NPM_CONFIG_REGISTRY: 'https://unreviewed.example.invalid/',
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace
    }
  });
  assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
  assert.match(resumed.stdout, /source preparation and packaging are skipped/);
  const resumedCommands = await readFile(log, 'utf8');
  assert.match(resumedCommands, /npm install --global/);
  assert.match(resumedCommands, /code --install-extension/);
  assert.match(resumedCommands, new RegExp(interruptedJournal.artifacts.tarball.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(resumedCommands, new RegExp(interruptedJournal.artifacts.vsix.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(resumedCommands, /^git /m);
  assert.doesNotMatch(resumedCommands, /npm ci|npm test|npm run check|npm pack|npm run vscode:/);
  assert.match(resumedCommands, /singularity-flow workspace refresh-configuration/);
  assert.doesNotMatch(resumedCommands, /^singularity-flow plugin install/m);
  const resumedNpm = resumedCommands.split('\n').filter((line) => line.startsWith('npm '));
  assert.ok(resumedNpm.some((line) => line.includes(' install --prefix ')),
    'recovery must rebuild the isolated CLI from the retained tarball instead of trusting its cache');
  for (const command of resumedNpm) {
    assert.match(command, new RegExp(` registry=${registry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      `recovery must retain the journal-bound registry: ${command}`);
  }
  const completedJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(completedJournal.status, 'complete');
  const completedManifest = JSON.parse(await readFile(
    path.join(fixture, '.singularity-flow', 'installations', 'current.json'), 'utf8'
  ));
  assert.equal(completedManifest.status, 'complete');
  assert.equal(completedManifest.workspaceRefresh, 'complete');
});

test('Unix installer rejects Node older than 20 before checkout or package mutation', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sflow-old-node-installer-'));
  const bin = path.join(fixture, 'bin');
  await mkdir(bin, { recursive: true });
  await copyFile(path.join(root, 'install.sh'), path.join(fixture, 'install.sh'));
  await chmod(path.join(fixture, 'install.sh'), 0o755);
  for (const command of ['git', 'npm', 'copilot']) {
    const file = path.join(bin, command);
    await writeFile(file, '#!/usr/bin/env bash\nexit 99\n');
    await chmod(file, 0o755);
  }
  const node = path.join(bin, 'node');
  await writeFile(node, '#!/usr/bin/env bash\nif [[ "${1:-}" == "-p" ]]; then printf "18\\n"; else printf "v18.20.8\\n"; fi\n');
  await chmod(node, 0o755);
  const result = spawnSync('bash', [path.join(fixture, 'install.sh')], {
    cwd: fixture, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/bin:/usr/bin` }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node\.js 20 or newer is required; found v18\.20\.8/);
});

test('--skip-tests is refused for destructive or isolated reinstall modes', () => {
  for (const mode of ['--factory-reset', '--clean-reinstall']) {
    const result = spawnSync('bash', [path.join(root, 'install.sh'), mode, '--skip-tests'], {
      cwd: root, encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /valid only for a normal non-destructive install/);
  }
});

test('--vscode-only refuses overlapping product-surface modes', () => {
  for (const overlapping of ['--cli-only', '--skip-vscode', '--skip-copilot']) {
    const result = spawnSync('bash', [path.join(root, 'install.sh'), '--vscode-only', overlapping], {
      cwd: root, encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--vscode-only is mutually exclusive/);
  }
});

test('--from-staged-artifacts is an exact standalone recovery mode', () => {
  const result = spawnSync('bash', [
    path.join(root, 'install.sh'), '--from-staged-artifacts', '--no-update'
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot be combined with any other installer option/);
});
