import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureSmartInitSnapshot } from '../src/initialization/source-snapshot.mjs';
import { runSmartInitDetectors } from '../src/initialization/detectors.mjs';
import { buildSmartInitProposal } from '../src/initialization/proposal.mjs';
import { activateSmartInit } from '../src/initialization/activation.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { gitCommonDir } from '../src/git.mjs';

const packageRoot = path.resolve(import.meta.dirname, '..');
const executable = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function command(cwd, executableName, args, options = {}) {
  const result = spawnSync(executableName, args, { cwd, encoding: 'utf8', ...options });
  if (result.status !== 0 && !options.allowFailure) throw new Error(result.stderr || result.stdout);
  return result;
}

function git(root, args) { return command(root, 'git', args).stdout.trim(); }
function flow(root, args, options = {}) { return command(root, process.execPath, [executable, ...args], options); }

async function staticClosure(entries) {
  const visited = new Set();
  const walk = async (file) => {
    const absolute = path.resolve(packageRoot, file);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const source = await readFile(absolute, 'utf8');
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
      const candidate = path.resolve(path.dirname(absolute), match[1]);
      await walk(path.extname(candidate) ? candidate : `${candidate}.mjs`);
    }
  };
  for (const entry of entries) await walk(entry);
  return visited;
}

async function repository(files, { stageExtra = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-smart-init-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Smart Init Test']);
  git(root, ['config', 'user.email', 'smart-init@example.com']);
  for (const [relative, content] of Object.entries(files)) {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(path.join(root, relative)), { recursive: true }));
    await writeFile(path.join(root, relative), content);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  if (stageExtra) {
    await writeFile(path.join(root, 'developer-note.txt'), 'keep staged\n');
    git(root, ['add', 'developer-note.txt']);
  }
  return root;
}

test('smart init dry-run is deterministic, model-free, and effect-free', async () => {
  const root = await repository({
    'package.json': `${JSON.stringify({
      name: 'sample', packageManager: 'npm@10.0.0',
      scripts: { test: 'node --test', lint: 'eslint .', build: 'node build.mjs' }
    })}\n`,
    '.env.local': 'MUST_NOT_APPEAR=super-secret-value\n'
  });
  const beforeHead = git(root, ['rev-parse', 'HEAD']);
  const beforeStatus = git(root, ['status', '--porcelain=v1']);
  const first = flow(root, ['init', '--smart-detect', '--dry-run', '--json']);
  const second = flow(root, ['init', '--smart-detect', '--dry-run', '--json']);
  assert.equal(first.stdout, second.stdout);
  const proposal = JSON.parse(first.stdout);
  assert.deepEqual(proposal.detectedStacks, ['node']);
  assert.equal(proposal.commands.verification[0].launcher, 'npm');
  assert.deepEqual(proposal.commands.verification[0].args, ['test']);
  assert.equal(proposal.capability.id, 'repository-root');
  assert.equal(proposal.proof.readiness, 'ready');
  assert.ok(proposal.suggestions.some((entry) => entry.id === 'protect-sensitive'));
  assert.doesNotMatch(first.stdout, /super-secret-value/);
  assert.equal(git(root, ['rev-parse', 'HEAD']), beforeHead);
  assert.equal(git(root, ['status', '--porcelain=v1']), beforeStatus);
  const refusedOutput = flow(root, [
    'init', '--smart-detect', '--dry-run', '--output', 'proposal.json'
  ], { allowFailure: true });
  assert.notEqual(refusedOutput.status, 0);
  assert.match(refusedOutput.stderr, /dry-run never writes files/i);
  assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(path.join(root, 'proposal.json'))), false);
});

test('smart-init read and proposal modules cannot statically reach model or agent launchers', async () => {
  const closure = await staticClosure([
    'src/initialization/source-snapshot.mjs', 'src/initialization/detectors.mjs',
    'src/initialization/proposal.mjs', 'src/initialization/explain.mjs',
    'src/initialization/precheck.mjs'
  ]);
  for (const file of closure) assert.doesNotMatch(
    path.basename(file), /^(?:model-provider|model-runner|prompt|agent-dispatch)\.mjs$/,
    `smart initialization reaches ${path.relative(packageRoot, file)}`
  );
});

test('tracked manifest modes come from Git and do not vary with checkout executable metadata', async () => {
  const root = await repository({
    'pom.xml': '<project><modelVersion>4.0.0</modelVersion></project>\n',
    'mvnw': '#!/bin/sh\nexit 0\n'
  });
  await import('node:fs/promises').then(({ chmod }) => chmod(path.join(root, 'mvnw'), 0o755));
  git(root, ['add', 'mvnw']);
  git(root, ['commit', '-qm', 'record executable wrapper']);
  const executableSnapshot = await captureSmartInitSnapshot(root);
  await import('node:fs/promises').then(({ chmod }) => chmod(path.join(root, 'mvnw'), 0o644));
  const nonExecutableSnapshot = await captureSmartInitSnapshot(root);
  assert.equal(executableSnapshot.sourceManifestSha256, nonExecutableSnapshot.sourceManifestSha256);
  assert.equal(nonExecutableSnapshot.sourceManifest.entries.find((entry) => entry.path === 'mvnw').mode, '100755');
});

test('detectors cover conventional Maven, Python, Rust, Make, and Docker without execution', async () => {
  const root = await repository({
    'pom.xml': '<project><modelVersion>4.0.0</modelVersion></project>\n',
    'mvnw': '#!/bin/sh\n',
    'python/pyproject.toml': '[build-system]\nrequires=[]\n[tool.pytest.ini_options]\naddopts="-q"\n[tool.ruff]\n',
    'rust/Cargo.toml': '[package]\nname="sample"\nversion="0.1.0"\n',
    'tools/Makefile': 'test:\n\t@true\nbuild:\n\t@true\n',
    'container/Dockerfile': 'FROM scratch\n'
  });
  const detection = runSmartInitDetectors(await captureSmartInitSnapshot(root));
  assert.deepEqual(detection.stacks, ['container', 'java-maven', 'python', 'rust']);
  assert.ok(detection.commands.verification.some((entry) => entry.launcher === 'maven-wrapper'));
  assert.ok(detection.commands.verification.some((entry) => entry.launcher === 'python'));
  assert.ok(detection.commands.verification.some((entry) => entry.launcher === 'cargo'));
  assert.ok(detection.commands.verification.some((entry) => entry.launcher === 'make'));
  assert.ok(!detection.commands.build.some((entry) => entry.launcher === 'docker'));
});

test('conflicting Node lockfile families remain ambiguous and cannot activate with --yes', async () => {
  const root = await repository({
    'package.json': '{"name":"sample","scripts":{"test":"node --test"}}\n',
    'package-lock.json': '{}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n'
  });
  const preview = flow(root, ['init', '--smart-detect', '--dry-run', '--json']);
  assert.ok(JSON.parse(preview.stdout).ambiguities.some((entry) => entry.id === 'node-package-manager:.'));
  const activation = flow(root, ['init', '--smart-detect', '--yes'], { allowFailure: true });
  assert.notEqual(activation.status, 0);
  assert.match(activation.stderr, /unresolved detection ambiguity/i);
  assert.equal(git(root, ['status', '--porcelain=v1']), '');
});

test('Node aliases and Dockerfile variants are detected without copying script bodies into law', async () => {
  const body = 'node ./private-command-body.mjs --token never-copy-this';
  const root = await repository({
    'package.json': `${JSON.stringify({
      name: 'aliases', packageManager: 'pnpm@9',
      scripts: { 'test:ci': body, 'check:types': 'tsc --noEmit', 'format:check': 'prettier -c .' }
    })}\n`,
    'docker/Dockerfile.production': 'FROM scratch\n'
  });
  const proposal = JSON.parse(flow(root, ['init', '--smart-detect', '--dry-run', '--json']).stdout);
  assert.deepEqual(proposal.commands.verification[0].args, ['run', 'test:ci']);
  assert.ok(proposal.commands.quality.some((entry) => entry.args.at(-1) === 'check:types'));
  assert.ok(proposal.commands.quality.some((entry) => entry.args.at(-1) === 'format:check'));
  assert.ok(proposal.detectedStacks.includes('container'));
  assert.doesNotMatch(JSON.stringify(proposal.commands), /never-copy-this/);
});

test('unsafe manifest encodings, XML entities, and symlinks fail before proposal creation', async () => {
  const invalidUtf8 = await repository({ 'package.json': Buffer.from([0xff, 0xfe, 0xfd]) });
  const invalid = flow(invalidUtf8, ['init', '--smart-detect', '--dry-run'], { allowFailure: true });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /not valid UTF-8/);

  const xml = await repository({ 'pom.xml': '<!DOCTYPE p [<!ENTITY x SYSTEM "file:///etc/passwd">]><project>&x;</project>\n' });
  const entity = flow(xml, ['init', '--smart-detect', '--dry-run'], { allowFailure: true });
  assert.notEqual(entity.status, 0);
  assert.match(entity.stderr, /forbidden entity declaration/);

  const linked = await repository({ 'manifest-source.json': '{"scripts":{}}\n' });
  await symlink('manifest-source.json', path.join(linked, 'package.json'));
  git(linked, ['add', 'package.json']);
  git(linked, ['commit', '-qm', 'linked manifest']);
  const unsafe = flow(linked, ['init', '--smart-detect', '--dry-run'], { allowFailure: true });
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /regular non-symlink file/);
});

test('credential-bearing remotes and executable PATH do not enter or execute a proposal', async () => {
  const root = await repository({
    'package.json': '{"name":"safe","packageManager":"npm@10","scripts":{"test":"node --test"}}\n'
  });
  git(root, ['remote', 'add', 'origin', 'https://someone:very-secret@example.invalid/repository.git?token=also-secret']);
  const toolDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-counterfeit-tool-'));
  const marker = path.join(toolDirectory, 'executed');
  await writeFile(path.join(toolDirectory, 'npm'), `#!/bin/sh\nprintf called > "${marker}"\n`, { mode: 0o755 });
  const preview = flow(root, ['init', '--smart-detect', '--dry-run', '--json'], {
    env: { ...process.env, PATH: `${toolDirectory}${path.delimiter}${process.env.PATH}` }
  });
  assert.doesNotMatch(preview.stdout, /very-secret|also-secret|someone/);
  assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(marker)), false);
});

test('activation rechecks detector bytes inside the subject lock before its first repository write', async () => {
  const root = await repository({
    'package.json': '{"name":"race","packageManager":"npm@10","scripts":{"test":"node --test"}}\n'
  });
  const snapshot = await captureSmartInitSnapshot(root);
  const rendered = await buildSmartInitProposal(snapshot, runSmartInitDetectors(snapshot));
  await writeFile(path.join(root, 'package.json'), '{"name":"changed","packageManager":"npm@10","scripts":{"test":"node --test"}}\n');
  await assert.rejects(
    activateSmartInit(root, rendered, { confirmation: rendered.proposal.proposalSha256 }),
    (error) => error?.code === 'INI_PROPOSAL_STALE'
  );
  assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(path.join(root, 'singularity'))), false);

  const rendererRoot = await repository({
    'package.json': '{"name":"renderer","packageManager":"npm@10","scripts":{"test":"node --test"}}\n'
  });
  const rendererSnapshot = await captureSmartInitSnapshot(rendererRoot);
  const tampered = await buildSmartInitProposal(rendererSnapshot, runSmartInitDetectors(rendererSnapshot));
  tampered.files[0].bytes = Buffer.from(tampered.files[0].bytes);
  tampered.files[0].bytes[0] ^= 1;
  await assert.rejects(
    activateSmartInit(rendererRoot, tampered, { confirmation: tampered.proposal.proposalSha256 }),
    (error) => error?.code === 'INI_PROPOSAL_STALE'
  );
  assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(path.join(rendererRoot, 'singularity'))), false);
});

test('exact activation commits only declared paths and quick precheck and config explain are read-only', async () => {
  const root = await repository({
    'package.json': '{"name":"sample","packageManager":"npm@10","scripts":{"test":"node --test"}}\n'
  }, { stageExtra: true });
  const proposal = JSON.parse(flow(root, ['init', '--smart-detect', '--dry-run', '--json']).stdout);
  const result = JSON.parse(flow(root, [
    'init', '--smart-detect', '--confirm', proposal.proposalSha256, '--json'
  ]).stdout);
  assert.equal(result.status, 'activated');
  assert.equal(git(root, ['show', '--pretty=', '--name-only', 'HEAD']).split('\n').includes('developer-note.txt'), false);
  assert.match(git(root, ['status', '--porcelain=v1']), /^A  developer-note\.txt$/m);
  const workflow = await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8');
  assert.match(workflow, /defaultMode: outcome/);
  assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(path.join(root, 'singularity', 'capabilities.yml'))), false);
  assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(path.join(root, 'singularity', 'portfolio.yml'))), false);
  assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(path.join(root, 'singularity', 'templates', 'poc-workflow'))), false);
  const capability = JSON.parse(flow(root, ['capability', 'show', '--json']).stdout);
  assert.equal(capability.capability.id, 'repository-root');
  assert.equal(capability.ownership.resolution, 'repository-root-fallback');
  const before = git(root, ['status', '--porcelain=v1']);
  const precheck = JSON.parse(flow(root, ['precheck', '--quick', '--json']).stdout);
  assert.equal(precheck.data.precheck.kind, 'smart-init-precheck-receipt');
  assert.equal(precheck.data.precheck.checks.find((entry) => entry.id === 'activation-receipt').status, 'pass');
  assert.equal(precheck.data.precheck.checks.find((entry) => entry.id === 'preset-binding').status, 'pass');
  assert.equal(precheck.data.precheck.checks.find((entry) => entry.id === 'activation-recovery').status, 'pass');
  const explained = JSON.parse(flow(root, ['config', 'explain', '--json']).stdout);
  assert.ok(explained.entries.some((entry) => entry.pointer === '/commands/verification/0'));
  const recovered = JSON.parse(flow(root, [
    'init', '--recover', '--proposal', proposal.proposalSha256, '--json'
  ]).stdout);
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.activationCommit, result.activationCommit);
  assert.equal(git(root, ['status', '--porcelain=v1']), before);
  const repeated = JSON.parse(flow(root, ['init', '--smart-detect', '--yes', '--json']).stdout);
  assert.equal(repeated.status, 'no-change');
  assert.equal(git(root, ['status', '--porcelain=v1']), before);
  await writeFile(path.join(root, 'singularity', 'presets', 'sflow.outcome-standard.v1.yml'), 'tampered: true\n');
  const drifted = flow(root, ['init', '--smart-detect', '--yes'], { allowFailure: true });
  assert.notEqual(drifted.status, 0);
  assert.match(drifted.stderr, /installed preset assets no longer match/i);
});

test('an interrupted fresh activation blocks another proposal and rolls back only exact managed bytes', async () => {
  const root = await repository({
    'package.json': '{"name":"recover","packageManager":"npm@10","scripts":{"test":"node --test"}}\n',
    'keep.txt': 'untouched\n'
  });
  const snapshot = await captureSmartInitSnapshot(root);
  const rendered = await buildSmartInitProposal(snapshot, runSmartInitDetectors(snapshot));
  const managed = rendered.files[0];
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(path.join(root, managed.path)), { recursive: true }));
  await writeFile(path.join(root, managed.path), managed.bytes);
  const journalDirectory = path.join(gitCommonDir(root), 'singularity-flow', 'journals', 'init');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(journalDirectory, { recursive: true }));
  await writeFile(path.join(journalDirectory, `${rendered.proposal.proposalSha256.slice(7, 19)}.json`), `${JSON.stringify({
    schemaVersion: currentSchemaVersion('smart-init-activation-journal'),
    kind: 'smart-init-activation-journal',
    status: 'planned',
    proposalSha256: rendered.proposal.proposalSha256,
    baseCommit: rendered.proposal.subject.baseCommit,
    checkedOutRef: rendered.proposal.subject.checkedOutRef,
    writeSet: rendered.proposal.writeSet
  }, null, 2)}\n`);
  const blocked = flow(root, ['init', '--smart-detect', '--dry-run'], { allowFailure: true });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /incomplete exact transaction/);
  const recovery = JSON.parse(flow(root, [
    'init', '--recover', '--proposal', rendered.proposal.proposalSha256, '--json'
  ]).stdout);
  assert.equal(recovery.status, 'rolled-back');
  assert.equal(await import('node:fs').then(({ existsSync }) => existsSync(path.join(root, managed.path))), false);
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'untouched\n');
  assert.equal(git(root, ['status', '--porcelain=v1']), '');
});

test('accepted proposal becomes stale when a manifest changes and unknown verification is explicit', async () => {
  const root = await repository({ 'README.md': '# unknown\n' });
  const snapshot = await captureSmartInitSnapshot(root);
  const detection = runSmartInitDetectors(snapshot);
  const { proposal } = await buildSmartInitProposal(snapshot, detection);
  assert.equal(proposal.proof.readiness, 'unavailable');
  assert.equal(proposal.commands.verification.length, 0);
  const output = 'review/init-proposal.json';
  flow(root, ['init', '--smart-detect', '--activation', 'proposal-only', '--output', output]);
  await writeFile(path.join(root, 'go.mod'), 'module example.invalid/new\n');
  const stale = flow(root, [
    'init', '--smart-detect', '--accept-proposal', output, '--confirm', proposal.proposalSha256,
    '--allow-unavailable-verification'
  ], { allowFailure: true });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /no longer matches current repository/i);
});

test('INI durable record families are registered before writers use them', () => {
  for (const family of [
    'smart-init-proposal', 'smart-init-policy', 'smart-init-preset-snapshot',
    'smart-init-activation', 'smart-init-activation-journal', 'configuration-origin-map',
    'smart-init-precheck-receipt'
  ]) assert.equal(currentSchemaVersion(family), 1);
});
