/** Safe shared build manifests and Kotlin/.NET planning; no SDK or model runs in these tests. */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from '../src/util.mjs';
import { readRepositoryManifest, repositoryManifestExists } from '../src/repository-manifest.mjs';
import { captureSmartInitSnapshot } from '../src/initialization/source-snapshot.mjs';
import { runSmartInitDetectors } from '../src/initialization/detectors.mjs';
import { buildSmartInitProposal } from '../src/initialization/proposal.mjs';
import { inferRepositoryTestCommands } from '../src/repository-test-command-inference.mjs';
import { inferModuleTestCommand, isTestSourceName, resolveAffectedModule } from '../src/code-delivery-tests.mjs';
import { repositoryTestCapability } from '../src/verification/capability.mjs';
import { buildRepositoryReadinessPlan, executeRepositoryReadinessPlan, inspectRepositoryReadinessReceipt } from '../src/initialization/runtime-readiness.mjs';

async function fixture(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-shared-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries({ '.gitignore': 'TestResults/\nbuild/\nbin/\nobj/\n', ...files })) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Manifest Test'], { cwd: root });
  run('git', ['config', 'user.email', 'manifest@example.test'], { cwd: root });
  commit(root);
  return root;
}
function commit(root) {
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-qm', 'fixture'], { cwd: root });
}
async function link(t, root, target, relative) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  try { await symlink(target, path.join(root, relative)); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Native symbolic-link privilege is required'); return false; }
    throw error;
  }
  return true;
}

test('the reported settings.gradle.kts link is accepted and its target bound into the source hash', async (t) => {
  const root = await fixture(t, { 'shared/settings.txt': 'rootProject.name = "shared"\n' });
  if (!await link(t, root, '../shared/settings.txt', 'build-dependencies/settings.gradle.kts')) return;
  commit(root);
  const first = await captureSmartInitSnapshot(root);
  const entry = first.entries.find((item) => item.path === 'build-dependencies/settings.gradle.kts');
  assert.equal(entry.content, 'rootProject.name = "shared"\n');
  assert.equal(entry.mode, '120000');
  assert.equal(entry.resolvedPath, 'shared/settings.txt');
  assert.deepEqual(entry.links.map(({ path, target }) => ({ path, target })), [{
    path: 'build-dependencies/settings.gradle.kts', target: 'build-dependencies/../shared/settings.txt'
  }]);
  assert.ok(entry.links.every((item) => /^sha256:[a-f0-9]{64}$/.test(item.linkSha256)));
  await writeFile(path.join(root, 'shared/settings.txt'), 'rootProject.name = "changed"\n');
  assert.notEqual((await captureSmartInitSnapshot(root)).sourceManifestSha256, first.sourceManifestSha256);
});

test('retargeting a link to identical bytes still changes the manifest identity', async (t) => {
  const root = await fixture(t, { 'one.txt': '{}', 'two.txt': '{}' });
  if (!await link(t, root, 'one.txt', 'package.json')) return;
  commit(root);
  const first = await captureSmartInitSnapshot(root);
  await unlink(path.join(root, 'package.json'));
  await symlink('two.txt', path.join(root, 'package.json'));
  const next = await captureSmartInitSnapshot(root);
  assert.equal(first.entries[0].sha256, next.entries[0].sha256);
  assert.notEqual(first.sourceManifestSha256, next.sourceManifestSha256);
});

test('multi-hop and parent-directory links stay within the canonical repository', async (t) => {
  const root = await fixture(t, { 'shared/package.json': '{"private":true}' });
  if (!await link(t, root, 'shared/package.json', 'middle.json')) return;
  await symlink('middle.json', path.join(root, 'package.json'));
  await symlink('shared', path.join(root, 'alias'));
  const chain = await readRepositoryManifest(root, 'package.json');
  assert.equal(chain.links.length, 2);
  assert.equal(chain.bytes.toString(), '{"private":true}');
  assert.equal((await readRepositoryManifest(root, 'alias/package.json')).resolvedPath, 'shared/package.json');
});

test('outside, dangling, cyclic, directory and oversized link targets remain refusals', async (t) => {
  const root = await fixture(t, { 'small.txt': '123456789' });
  const external = await fixture(t, { 'outside.txt': 'external-private-content' });
  if (!await link(t, root, path.join(external, 'outside.txt'), 'external.json')) return;
  await symlink('missing.txt', path.join(root, 'broken.json'));
  await symlink('cycle-b.json', path.join(root, 'cycle-a.json'));
  await symlink('cycle-a.json', path.join(root, 'cycle-b.json'));
  await symlink('.', path.join(root, 'directory.json'));
  await symlink('small.txt', path.join(root, 'large.json'));
  for (const [relative, reason] of [
    ['external.json', /escapes/], ['broken.json', /broken/], ['cycle-a.json', /cycle/], ['directory.json', /regular file/]
  ]) await assert.rejects(readRepositoryManifest(root, relative), (error) =>
    error.code === 'INI_MANIFEST_UNSAFE' && reason.test(error.message) && !error.message.includes('external-private-content'));
  await assert.rejects(readRepositoryManifest(root, 'large.json', { maxBytes: 4 }), (error) => error.code === 'INI_DETECTION_BOUND_EXCEEDED');
  await assert.rejects(readRepositoryManifest(root, '../outside.txt'), (error) => error.code === 'INI_MANIFEST_UNSAFE');
  assert.equal(await repositoryManifestExists(root, 'absent.json'), false);
  await assert.rejects(repositoryManifestExists(root, 'broken.json'), (error) => error.code === 'INI_MANIFEST_UNSAFE');
});

test('an outside intermediate directory is refused even if another link would return inside', async (t) => {
  const root = await fixture(t, { 'settings.txt': 'safe' });
  const external = await fixture(t);
  if (!await link(t, external, path.join(root, 'settings.txt'), 'return.json')) return;
  await symlink(external, path.join(root, 'escape'));
  await assert.rejects(readRepositoryManifest(root, 'escape/return.json'), (error) => error.code === 'INI_MANIFEST_UNSAFE');
  await symlink('escape/../settings.txt', path.join(root, 'package.json'));
  await assert.rejects(readRepositoryManifest(root, 'package.json'), (error) => error.code === 'INI_MANIFEST_UNSAFE');
});

test('link parents are resolved physically before dot-dot, matching the build tool bytes', async (t) => {
  const root = await fixture(t, { 'shared/nested/keep': '', 'shared/manifest.txt': '{"private":true}', 'manifest.txt': 'wrong bytes' });
  if (!await link(t, root, 'shared/nested', 'alias')) return;
  await symlink('alias/../manifest.txt', path.join(root, 'package.json'));
  const resolved = await readRepositoryManifest(root, 'package.json');
  assert.equal(resolved.resolvedPath, 'shared/manifest.txt');
  assert.deepEqual(resolved.bytes, await readFile(path.join(root, 'package.json')));
  await unlink(path.join(root, 'package.json'));
  await symlink(`${root}/alias/../manifest.txt`, path.join(root, 'package.json'));
  assert.equal((await readRepositoryManifest(root, 'package.json')).resolvedPath, 'shared/manifest.txt');
});

test('readiness and capability inference both recognize an internal package-manifest link', async (t) => {
  const root = await fixture(t, { 'shared/manifest.txt': '{"private":true,"scripts":{"test":"node --test"}}' });
  if (!await link(t, root, 'shared/manifest.txt', 'package.json')) return;
  commit(root);
  assert.equal((await inferRepositoryTestCommands(root, { unitOnly: true }))[0].result.adapter, 'node-tap');
  const capability = await repositoryTestCapability(root, { env: { PATH: '' } });
  assert.equal(capability.modules[0].root, '.');
  assert.equal(capability.modules[0].resultAdapter, 'node-tap');
  const plan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
  assert.equal(plan.status, 'ready');
});

test('Kotlin JVM plugins are detected; Kotlin DSL alone does not imply Kotlin source', async (t) => {
  for (const [build, stack] of [
    ['plugins { kotlin("jvm") version "2.0.0" }', 'kotlin-gradle'],
    ['plugins { id("org.jetbrains.kotlin.jvm") }', 'kotlin-gradle'],
    ['plugins { java }', 'java-gradle']
  ]) {
    const root = await fixture(t, { 'build.gradle.kts': build, gradlew: '#!/bin/sh\nexit 0\n' });
    await chmod(path.join(root, 'gradlew'), 0o755); commit(root);
    const detection = runSmartInitDetectors(await captureSmartInitSnapshot(root));
    assert.deepEqual(detection.stacks, [stack]);
    assert.equal(detection.commands.verification[0].launcher, 'gradle-wrapper');
    for (const platform of ['darwin', 'win32']) {
      const command = (await inferRepositoryTestCommands(root, { unitOnly: true, platform }))[0];
      assert.equal(command.result.adapter, 'junit-xml');
      assert.ok(['./gradlew', 'gradle'].includes(command.argv[0]));
    }
    const plan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
    assert.equal(plan.status, 'ready');
    assert.equal(plan.commands.find((item) => item.purpose === 'test').argv[0], './gradlew');
  }
});

test('Kotlin Maven and target-specific Kotlin builds are disclosed without guessing JVM tests', async (t) => {
  const maven = await fixture(t, { 'pom.xml': '<project><build><plugins><plugin><artifactId>kotlin-maven-plugin</artifactId></plugin></plugins></build></project>' });
  const detection = runSmartInitDetectors(await captureSmartInitSnapshot(maven));
  assert.deepEqual(detection.stacks, ['kotlin-maven']);
  assert.ok(detection.commands.verification[0].evidence.every((id) => detection.facts.some((entry) => entry.id === id)));
  for (const target of ['multiplatform', 'android']) {
    const root = await fixture(t, { 'build.gradle.kts': `plugins { kotlin("${target}") }` });
    const planned = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
    assert.equal(planned.status, 'blocked');
    assert.ok(planned.ambiguities.some((item) => /explicit test target/.test(item.reason)));
    await assert.rejects(inferModuleTestCommand(root, { root: '.', system: 'gradle' }),
      (error) => error.code === 'GRADLE_TEST_TARGET_REQUIRED');
    const capability = await repositoryTestCapability(root, { env: { PATH: '' } });
    assert.equal(capability.modules[0].status, 'unsupported');
    assert.equal(capability.modules[0].code, 'GRADLE_TEST_TARGET_REQUIRED');
    const configured = await repositoryTestCapability(root, { env: { PATH: '' }, configuredCommands: [{
      id: 'explicit-kotlin-target', kind: 'test', argv: ['gradle', 'jvmTest'], workingDirectory: '.',
      affectedRoots: ['.'], modelPolicy: 'never', result: { adapter: 'junit-xml', path: 'build/test-results/jvmTest', minimumDiscovered: 1 }
    }] });
    assert.equal(configured.modules[0].source, 'configured', 'an approved explicit target remains usable');
  }
});

test('.NET C#, F#, VB, legacy solutions and XML solutions have structured readiness plans', async (t) => {
  for (const name of ['App.csproj', 'App.fsproj', 'App.vbproj', 'App.sln', 'App.slnx']) {
    const root = await fixture(t, { [name]: name.endsWith('.sln') ? 'Microsoft Visual Studio Solution File' : '<Project/>',
      'global.json': '{"sdk":{"version":"8.0.100"}}', 'NuGet.Config': '<configuration/>',
      'Directory.Build.props': '<Project/>', 'Directory.Packages.props': '<Project/>' });
    const snapshot = await captureSmartInitSnapshot(root);
    for (const config of ['global.json', 'NuGet.Config', 'Directory.Build.props', 'Directory.Packages.props']) {
      assert.ok(snapshot.entries.some((entry) => entry.path === config));
    }
    const detection = runSmartInitDetectors(snapshot);
    assert.deepEqual(detection.stacks, ['dotnet']);
    assert.deepEqual(detection.commands.dependency[0].args, ['restore', name]);
    const plan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
    assert.equal(plan.status, 'ready');
    assert.equal(plan.structuredTestContract.commands[0].adapter, 'dotnet-trx');
    assert.deepEqual(plan.commands.map((item) => item.purpose), ['dependency', 'test']);
    assert.deepEqual(plan.commands[1].argv, ['dotnet', 'test', name, '--logger', 'trx', '--results-directory', 'TestResults']);
    const capability = await repositoryTestCapability(root, { env: { PATH: '' } });
    assert.equal(capability.modules[0].ceiling, 'module-observed', '.NET is not advertised as exact clause-level proof');
    assert.equal(capability.modules[0].status, 'launcher-missing');
    const rendered = await buildSmartInitProposal(snapshot, detection);
    assert.ok(rendered.proposal.commands.verification.some((command) => command.launcher === 'dotnet'));
  }
});

test('.NET solution selection, ambiguity and NuGet lockfiles are explicit and deterministic', async (t) => {
  const root = await fixture(t, { 'App.sln': 'solution', 'App.csproj': '<Project/>', 'packages.lock.json': '{}' });
  const detection = runSmartInitDetectors(await captureSmartInitSnapshot(root));
  assert.deepEqual(detection.commands.dependency[0].args, ['restore', 'App.sln', '--locked-mode']);
  assert.equal((await inferRepositoryTestCommands(root))[0].argv[2], 'App.sln');
  assert.equal((await resolveAffectedModule(root, 'AppTests.cs')).manifest, 'App.sln');
  const ambiguous = await fixture(t, { 'One.csproj': '<Project/>', 'Two.csproj': '<Project/>' });
  await assert.rejects(inferRepositoryTestCommands(ambiguous), (error) => error.code === 'DOTNET_MANIFEST_AMBIGUOUS');
  assert.equal((await buildRepositoryReadinessPlan(ambiguous, { scope: 'dependency-test' })).status, 'blocked');
  const capability = await repositoryTestCapability(ambiguous, { env: { PATH: '' } });
  assert.equal(capability.modules[0].code, 'DOTNET_MANIFEST_AMBIGUOUS');
  assert.equal(capability.modules[0].ceiling, 'none');
  for (const name of ['ExampleTests.cs', 'ExampleTests.fs', 'ExampleTests.vb']) assert.equal(isTestSourceName(name), true);
});

test('new XML build manifests keep entity declarations refused before detection', async (t) => {
  for (const name of ['App.csproj', 'App.slnx', 'Directory.Build.targets', 'NuGet.Config']) {
    const root = await fixture(t, { [name]: '<!DOCTYPE project [<!ENTITY secret SYSTEM "file:///private/never-read">]><Project/>' });
    await assert.rejects(captureSmartInitSnapshot(root), (error) => error.code === 'INI_MANIFEST_UNSAFE');
  }
});

test('module-level .NET inference also validates linked project targets before returning a command', async (t) => {
  const root = await fixture(t, { 'shared/project.txt': '<Project/>' });
  const external = await fixture(t, { 'project.txt': '<Project/>' });
  if (!await link(t, root, 'shared/project.txt', 'App.csproj')) return;
  const module = { root: '.', system: 'dotnet', manifest: 'App.csproj' };
  assert.equal((await inferModuleTestCommand(root, module)).argv[2], 'App.csproj');
  await unlink(path.join(root, 'App.csproj'));
  await symlink(path.join(external, 'project.txt'), path.join(root, 'App.csproj'));
  await assert.rejects(inferModuleTestCommand(root, module), (error) => error.code === 'INI_MANIFEST_UNSAFE');
});

test('a confirmed .NET plan records fresh TRX observations, and SDK/config edits invalidate it', async (t) => {
  const root = await fixture(t, { 'App.csproj': '<Project/>', 'global.json': '{"sdk":{"version":"8.0.100"}}' });
  const options = { scope: 'dependency-test' };
  const plan = await buildRepositoryReadinessPlan(root, options);
  const runCommand = async (command) => {
    if (command.purpose === 'test') {
      await mkdir(path.join(root, 'TestResults'), { recursive: true });
      await writeFile(path.join(root, 'TestResults', 'fresh.trx'), '<TestRun><ResultSummary><Counters total="2" executed="2" passed="2" failed="0" notExecuted="0" /></ResultSummary></TestRun>');
    }
    return { status: 'pass', exitCode: 0, durationMs: 1 };
  };
  const result = await executeRepositoryReadinessPlan(root, { ...options, confirmation: plan.planId, runCommand });
  assert.equal(result.receipt.testObservations[0].adapter, 'dotnet-trx');
  assert.equal(result.receipt.testObservations[0].counts.passed, 2);
  assert.equal((await inspectRepositoryReadinessReceipt(root, options)).status, 'pass');
  await writeFile(path.join(root, 'global.json'), '{"sdk":{"version":"9.0.100"}}');
  assert.equal((await inspectRepositoryReadinessReceipt(root, options)).status, 'stale');
  assert.notEqual((await captureSmartInitSnapshot(root)).sourceManifestSha256, plan.sourceManifestSha256);
});
