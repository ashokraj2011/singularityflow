/** Swift planning and report handling are SDK-independent; no package manifest is executed. */
import assert from 'node:assert/strict';
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from '../src/util.mjs';
import { captureSmartInitSnapshot } from '../src/initialization/source-snapshot.mjs';
import { runSmartInitDetectors } from '../src/initialization/detectors.mjs';
import { buildRepositoryReadinessPlan, executeRepositoryReadinessPlan, inspectRepositoryReadinessReceipt,
  isEmptyRepositoryReadinessPlan } from '../src/initialization/runtime-readiness.mjs';
import { inferRepositoryTestCommands } from '../src/repository-test-command-inference.mjs';
import { inferModuleTestCommand, parseTestResult } from '../src/code-delivery-tests.mjs';
import { repositoryTestCapability } from '../src/verification/capability.mjs';
import { profileForCommand } from '../src/verification/profiles.mjs';
import { prepareInferredSwiftTestReports } from '../src/verification/swift-reports.mjs';
import { SWIFT_TEST_ARGUMENTS, SWIFT_TEST_REPORT_DIRECTORY as REPORTS, SWIFT_TEST_REPORT_NAMES } from '../src/swift-manifests.mjs';

const MANIFEST = '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "Pilot", targets: [.target(name: "Pilot"), .testTarget(name: "PilotTests", dependencies: ["Pilot"])])\n';
const xml = (name, status = '') => `<testsuites><testsuite name="PilotTests" tests="1" failures="${status === 'failure' ? 1 : 0}" skipped="${status === 'skipped' ? 1 : 0}" errors="0"><testcase classname="PilotTests" name="${name}">${status ? `<${status}/>` : ''}</testcase></testsuite></testsuites>`;

async function fixture(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-swift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries({ '.gitignore': '.build/\n', ...files })) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Swift Test'], { cwd: root });
  run('git', ['config', 'user.email', 'swift@example.test'], { cwd: root });
  commit(root);
  return root;
}
function commit(root) {
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-qm', 'fixture'], { cwd: root });
}
async function report(root, name, contents) {
  await mkdir(path.join(root, REPORTS), { recursive: true });
  await writeFile(path.join(root, REPORTS, name), contents);
}
const success = { status: 'pass', exitCode: 0, durationMs: 1 };

test('SwiftPM manifests, lockfile and declared toolchain bind intake without executing Swift', async (t) => {
  const root = await fixture(t, { 'Package.swift': MANIFEST, 'Package.resolved': '{"version":3,"pins":[]}', '.swift-version': '6.0' });
  const snapshot = await captureSmartInitSnapshot(root);
  assert.deepEqual(snapshot.entries.map((entry) => entry.path).sort(), ['.swift-version', 'Package.resolved', 'Package.swift']);
  const detection = runSmartInitDetectors(snapshot);
  assert.deepEqual(detection.stacks, ['swift']);
  assert.deepEqual(detection.commands.verification[0].args, [...SWIFT_TEST_ARGUMENTS]);
  assert.deepEqual(detection.commands.build[0].args, ['build']);
  assert.equal(detection.commands.dependency.length, 0, 'do not resolve arbitrary Package.swift merely to inspect it');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const [command] = await inferRepositoryTestCommands(root, { platform });
    assert.deepEqual(command.argv, ['swift', ...SWIFT_TEST_ARGUMENTS]);
    assert.equal(command.result.path, REPORTS);
    assert.equal(profileForCommand(command), 'module-counts-v1', 'unqualified exact Swift proof must remain disabled');
  }
  const capability = await repositoryTestCapability(root, { env: { PATH: '' } });
  assert.equal(capability.modules[0].status, 'launcher-missing');
  assert.equal(capability.modules[0].ceiling, 'module-observed');
  const before = snapshot.sourceManifestSha256;
  await writeFile(path.join(root, 'Package.resolved'), '{"version":3,"pins":[{"identity":"pilot"}]}');
  assert.notEqual((await captureSmartInitSnapshot(root)).sourceManifestSha256, before);
});

test('SwiftPM cannot receive the automatic no-command readiness receipt', async (t) => {
  const root = await fixture(t, { 'Package.swift': MANIFEST });
  for (const scope of ['dependency-test', 'full']) {
    const plan = await buildRepositoryReadinessPlan(root, { scope });
    assert.equal(plan.status, 'ready');
    assert.equal(plan.structuredTestContract.requiredForCode, true);
    assert.equal(isEmptyRepositoryReadinessPlan(plan), false);
    assert.equal(plan.commands.filter((entry) => entry.purpose === 'test').length, 1, 'no duplicate unstructured Swift verifier');
    assert.deepEqual(plan.generatedReportPaths, SWIFT_TEST_REPORT_NAMES.map((name) => `${REPORTS}/${name}`).sort());
    await assert.rejects(executeRepositoryReadinessPlan(root, { scope, emptyOnly: true, confirmation: plan.planId }),
      (error) => error.code === 'REPOSITORY_READINESS_STALE_PLAN');
  }
});

test('nested-only packages and Xcode projects block with a named contract gap, not an empty receipt', async (t) => {
  for (const [manifest, contents, code] of [
    ['Modules/Pilot/Package.swift', MANIFEST, 'REPOSITORY_READINESS_STRUCTURED_TEST_REQUIRED'],
    ['Pilot.xcodeproj/project.pbxproj', '// project', 'REPOSITORY_READINESS_DETECTION_AMBIGUOUS'],
    ['Pilot.xcworkspace/contents.xcworkspacedata', '<Workspace/>', 'REPOSITORY_READINESS_DETECTION_AMBIGUOUS']
  ]) {
    const root = await fixture(t, { [manifest]: contents });
    const plan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
    assert.equal(plan.status, 'blocked');
    assert.ok(plan.blockers.some((entry) => entry.code === code));
    assert.equal(isEmptyRepositoryReadinessPlan(plan), false);
    if (!manifest.endsWith('Package.swift')) {
      const capability = await repositoryTestCapability(root, { env: { PATH: '' } });
      assert.equal(capability.modules[0].code, 'XCODE_TEST_TARGET_REQUIRED');
    }
  }
});

test('a Node tooling package does not hide the colocated SwiftPM test command', async (t) => {
  const root = await fixture(t, { 'Package.swift': MANIFEST, 'package.json': '{"scripts":{"test":"node --test"}}' });
  const commands = await inferRepositoryTestCommands(root, { unitOnly: true });
  assert.deepEqual(commands.map((entry) => entry.result.adapter), ['node-tap', 'junit-xml']);
  const plan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
  assert.equal(plan.structuredTestContract.commands.length, 2);
});

test('one confirmed plan collects fresh XCTest and Swift Testing reports and remains reusable', async (t) => {
  const root = await fixture(t, { 'Package.swift': MANIFEST, 'Package.resolved': '{"version":3,"pins":[]}' });
  const options = { scope: 'dependency-test' };
  const plan = await buildRepositoryReadinessPlan(root, options);
  const runCommand = async () => {
    await report(root, 'tests.xml', xml('testXCTest'));
    await report(root, 'tests-swift-testing.xml', xml('swiftTestingExample'));
    return success;
  };
  const result = await executeRepositoryReadinessPlan(root, { ...options, confirmation: plan.planId, runCommand });
  assert.deepEqual(result.receipt.testObservations[0].counts, { discovered: 2, passed: 2, failed: 0, skipped: 0 });
  assert.equal(result.receipt.testObservations[0].report.files.length, 2);
  assert.equal((await inspectRepositoryReadinessReceipt(root, options)).status, 'pass');
  assert.equal((await buildRepositoryReadinessPlan(root, options)).planId, plan.planId, 'exact generated report pair is not source drift');
  await writeFile(path.join(root, 'Package.resolved'), '{"version":3,"pins":[{"identity":"changed"}]}');
  assert.equal((await inspectRepositoryReadinessReceipt(root, options)).status, 'stale');
});

test('Swift Testing-only and XCTest-only output are collected without requiring an empty companion', async (t) => {
  for (const name of SWIFT_TEST_REPORT_NAMES) {
    const root = await fixture(t, { 'Package.swift': MANIFEST });
    const [command] = await inferRepositoryTestCommands(root);
    await prepareInferredSwiftTestReports(root, command);
    await report(root, name, xml('example'));
    const parsed = await parseTestResult(root, command);
    assert.equal(parsed.tests.passed, 1);
    assert.equal(parsed.result.files.length, 1);
  }
});

test('a companion failure cannot be hidden, and a companion skip stays explicitly skipped', async (t) => {
  for (const outcome of ['failure', 'skipped']) {
    const root = await fixture(t, { 'Package.swift': MANIFEST });
    const plan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
    const execution = executeRepositoryReadinessPlan(root, { scope: 'dependency-test', confirmation: plan.planId,
      runCommand: async () => {
        await report(root, 'tests.xml', xml('testPassing'));
        await report(root, 'tests-swift-testing.xml', xml('mustNotBeIgnored', outcome));
        return success;
      }
    });
    if (outcome === 'failure') await assert.rejects(execution,
      (error) => error.code === 'REPOSITORY_READINESS_COMMAND_FAILED'
        && error.details.testObservations[0].counts.failed === 1);
    else {
      // The existing readiness policy allows disclosed skips alongside passing cases. A skipped
      // test is not a failed suite, not a passed case, and not exact evidence for its criterion.
      const result = await execution;
      assert.deepEqual(result.receipt.testObservations[0].counts, { discovered: 2, passed: 1, failed: 0, skipped: 1 });
    }
  }
});

test('old Swift report pair and zero-test output cannot manufacture a passing receipt', async (t) => {
  const root = await fixture(t, { 'Package.swift': MANIFEST });
  await report(root, 'tests.xml', xml('oldXCTest'));
  await report(root, 'tests-swift-testing.xml', xml('oldSwiftTesting'));
  const plan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
  await assert.rejects(executeRepositoryReadinessPlan(root, { scope: 'dependency-test', confirmation: plan.planId,
    runCommand: async () => {
      for (const name of SWIFT_TEST_REPORT_NAMES) await assert.rejects(access(path.join(root, REPORTS, name)));
      await report(root, 'tests-swift-testing.xml', '<testsuites><testsuite tests="0" failures="0" errors="0" skipped="0"/></testsuites>');
      return success;
    }
  }), (error) => error.code === 'REPOSITORY_READINESS_COMMAND_FAILED');
  assert.notEqual((await inspectRepositoryReadinessReceipt(root, { scope: 'dependency-test' })).status, 'pass');
});

test('generated-output treatment never exempts arbitrary source, XML or nested files', async (t) => {
  const root = await fixture(t, { 'Package.swift': MANIFEST });
  await report(root, 'source.swift', 'let hiddenSource = true');
  await assert.rejects(buildRepositoryReadinessPlan(root, { scope: 'dependency-test' }),
    (error) => error.code === 'REPOSITORY_READINESS_UNTRACKED_SOURCE');
  await rm(path.join(root, REPORTS, 'source.swift'));
  const [command] = await inferRepositoryTestCommands(root);
  await report(root, 'tests.xml', xml('preserve'));
  await report(root, 'unrecognized.xml', xml('notInferred'));
  await assert.rejects(prepareInferredSwiftTestReports(root, command, { clear: true }),
    (error) => error.code === 'SWIFT_TEST_REPORT_TARGET_UNSAFE');
  assert.equal(await readFile(path.join(root, REPORTS, 'tests.xml'), 'utf8'), xml('preserve'));
});

test('tracked reports and an SDK/license failure leave no passing readiness receipt', async (t) => {
  const root = await fixture(t, { 'Package.swift': MANIFEST });
  const [command] = await inferRepositoryTestCommands(root);
  await report(root, 'tests.xml', xml('trackedOld'));
  commit(root);
  await assert.rejects(prepareInferredSwiftTestReports(root, command, { clear: true }),
    (error) => error.code === 'SWIFT_TEST_REPORT_TARGET_UNSAFE');
  assert.equal(await readFile(path.join(root, REPORTS, 'tests.xml'), 'utf8'), xml('trackedOld'));
  const clean = await fixture(t, { 'Package.swift': MANIFEST });
  const plan = await buildRepositoryReadinessPlan(clean, { scope: 'dependency-test' });
  await assert.rejects(executeRepositoryReadinessPlan(clean, { scope: 'dependency-test', confirmation: plan.planId,
    runCommand: async () => ({ status: 'failed', exitCode: 69, durationMs: 1, stderr: 'Xcode license not accepted' })
  }), (error) => error.code === 'REPOSITORY_READINESS_COMMAND_FAILED');
  assert.notEqual((await inspectRepositoryReadinessReceipt(clean, { scope: 'dependency-test' })).status, 'pass');
});

test('Swift readiness never unlinks a hard-linked report or follows a report-directory link', async (t) => {
  const root = await fixture(t, { 'Package.swift': MANIFEST, 'source.xml': xml('sourceMustSurvive') });
  const [command] = await inferRepositoryTestCommands(root);
  await mkdir(path.join(root, REPORTS), { recursive: true });
  await link(path.join(root, 'source.xml'), path.join(root, REPORTS, 'tests.xml'));
  await assert.rejects(prepareInferredSwiftTestReports(root, command, { clear: true }),
    (error) => error.code === 'SWIFT_TEST_REPORT_TARGET_UNSAFE');
  assert.equal(await readFile(path.join(root, 'source.xml'), 'utf8'), xml('sourceMustSurvive'));
  await rm(path.join(root, REPORTS), { recursive: true });
  try { await symlink(root, path.join(root, REPORTS), 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Native symlink privilege required'); return; }
    throw error;
  }
  await assert.rejects(prepareInferredSwiftTestReports(root, command, { clear: true }));
  assert.equal(await readFile(path.join(root, 'source.xml'), 'utf8'), xml('sourceMustSurvive'));
});

test('linked Swift package manifests use the same contained-path checks as other languages', async (t) => {
  const root = await fixture(t, { 'shared/manifest.txt': MANIFEST });
  const outside = await fixture(t, { 'Package.swift': MANIFEST });
  try { await symlink('shared/manifest.txt', path.join(root, 'Package.swift')); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Native symlink privilege required'); return; }
    throw error;
  }
  commit(root);
  assert.equal((await inferRepositoryTestCommands(root)).length, 1);
  assert.equal((await captureSmartInitSnapshot(root)).entries[0].resolvedPath, 'shared/manifest.txt');
  await rm(path.join(root, 'Package.swift'));
  await symlink(path.join(outside, 'Package.swift'), path.join(root, 'Package.swift'));
  await assert.rejects(inferModuleTestCommand(root, { root: '.', system: 'swift', manifest: 'Package.swift' }),
    (error) => error.code === 'INI_MANIFEST_UNSAFE');
});
