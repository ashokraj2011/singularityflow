import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTrpNodeCaseInventory, matchTrpNodeReport, trpNodeExecutionEnvironment } from '../src/test-recovery-node.mjs';
import { runQualityCommand } from '../src/quality-command-runner.mjs';
import { parseNativeNodeJunitReport } from '../src/code-delivery-tests.mjs';

async function fixture(source = 'import test from "node:test";import assert from "node:assert/strict";test("first case",()=>assert.equal(1,2));\n') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-trp-node-')));
  await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'test/example.test.mjs'), source);
  const command = { id: 'native-tests', kind: 'test', workingDirectory: '.', affectedRoots: ['.'],
    argv: [process.execPath, '--test', '--test-reporter=junit', 'test/example.test.mjs'],
    result: { adapter: 'junit-xml', path: 'report.xml', minimumDiscovered: 1, minimumPassed: 1 } };
  const workflow = { resolution: { testRecovery: { caseInventory: [{ phaseId: 'implementation', commandId: command.id,
    dependencyScope: 'repository-and-node-builtins-only',
    tests: [{ id: 'first', path: 'test/example.test.mjs', name: 'first case' }] }] } } };
  return { root, command, workflow, phase: { id: 'implementation' } };
}

test('approved inventory precedes a native executed failing report and binds source semantics', async () => {
  const { root, command, workflow, phase } = await fixture();
  const inventory = await readTrpNodeCaseInventory(root, workflow, phase, command);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = await runQualityCommand(command.argv[0], command.argv.slice(1), { cwd: root, env, timeoutMs: 5000 });
  assert.equal(result.status, 1);
  const report = await matchTrpNodeReport(root, inventory, Buffer.from(result.stdout));
  assert.deepEqual(report.counts, { discovered: 1, passed: 0, failed: 1, skipped: 0, notRun: 0 });
  assert.equal(report.cases[0].id, 'first');
  assert.equal(report.cases[0].semanticsSha256, inventory.tests[0].semanticsSha256);
  assert.match(report.cases[0].causeSha256, /^sha256:[a-f0-9]{64}$/u);
  await writeFile(path.join(root, 'test/example.test.mjs'), 'changed assertion');
  assert.notEqual((await readTrpNodeCaseInventory(root, workflow, phase, command)).tests[0].semanticsSha256, inventory.tests[0].semanticsSha256);
});

test('independent expected cases reject missing, extra, skipped and duplicate native report cases', async () => {
  const { root, command, workflow, phase } = await fixture();
  const inventory = await readTrpNodeCaseInventory(root, workflow, phase, command);
  for (const cases of [
    '', '<testcase name="other" classname="test"><failure/></testcase>',
    '<testcase name="first case" classname="test"><skipped/></testcase>',
    '<testcase name="first case" classname="test"><failure/></testcase>'.repeat(2)
  ]) await assert.rejects(matchTrpNodeReport(root, inventory, Buffer.from(`<testsuites>${cases}</testsuites>`)));
  const olderNode = Buffer.from('<testsuites><testcase name="first case" classname="test"><failure message="assertion"/></testcase></testsuites>');
  assert.equal((await matchTrpNodeReport(root, inventory, olderNode)).cases[0].outcome, 'failed');
  await assert.rejects(matchTrpNodeReport(root, { tests: [...inventory.tests, { id: 'second', path: 'test/other.test.mjs', name: 'second case' }] },
    Buffer.from('<testsuites><testcase name="first case" classname="test"><failure/></testcase><testcase name="second case" classname="test"/></testsuites>')),
  /unambiguous test source/);
});

test('native inventory rejects wrappers, unapproved files and focused commands', async () => {
  const { root, command, workflow, phase } = await fixture();
  for (const argv of [
    [process.execPath, '-e', 'fake report'],
    [process.execPath, '--test', '--test-reporter=junit', '--test-name-pattern=first', 'test/example.test.mjs'],
    [process.execPath, '--test', '--test-reporter=junit', 'test/other.test.mjs']
  ]) await assert.rejects(readTrpNodeCaseInventory(root, workflow, phase, { ...command, argv }));
  await assert.rejects(readTrpNodeCaseInventory(root, workflow, phase, { ...command,
    result: { ...command.result, minimumDiscovered: 2 } }), /minimum discovery/);
  const badScope = structuredClone(workflow);
  badScope.resolution.testRecovery.caseInventory[0].dependencyScope = 'live-network';
  await assert.rejects(readTrpNodeCaseInventory(root, badScope, phase, command), /dependency declaration/);
  await symlink(path.join(root, 'test/example.test.mjs'), path.join(root, 'test/link.test.mjs'));
  workflow.resolution.testRecovery.caseInventory[0].tests[0].path = 'test/link.test.mjs';
  await assert.rejects(readTrpNodeCaseInventory(root, workflow, phase, { ...command,
    argv: [process.execPath, '--test', '--test-reporter=junit', 'test/link.test.mjs'] }));
});

test('native report parser decodes exact identity entities and refuses nested or hostile XML', () => {
  const parsed = parseNativeNodeJunitReport(Buffer.from('<testsuites><testcase name="a &amp; b &quot;c&quot;" classname="test"><failure/></testcase></testsuites>'));
  assert.equal(parsed.cases[0].name, 'a & b "c"');
  for (const xml of [
    '<testsuites><testsuite><testcase name="a" classname="test"/></testsuite></testsuites>',
    '<!DOCTYPE a><testsuites/>',
    '<testsuites><testcase name="&unknown;" classname="test"/></testsuites>'
  ]) assert.throws(() => parseNativeNodeJunitReport(Buffer.from(xml)));
});

test('native file arguments cannot turn absolute or parent paths into an approved relative inventory', async () => {
  const { root, command, workflow, phase } = await fixture();
  for (const file of ['/test/example.test.mjs', 'test/../test/example.test.mjs',
    'C:/test/example.test.mjs', '\\\\server\\test\\example.test.mjs', 'test\\example.test.mjs']) {
    await assert.rejects(readTrpNodeCaseInventory(root, workflow, phase, { ...command,
      argv: [process.execPath, '--test', '--test-reporter=junit', file] }));
  }
  await mkdir(path.join(root, 'module'));
  await assert.rejects(readTrpNodeCaseInventory(root, workflow, phase, { ...command,
    workingDirectory: 'module', argv: [process.execPath, '--test', '--test-reporter=junit', '../test/example.test.mjs'] }));
  const safe = await readTrpNodeCaseInventory(root, workflow, phase, { ...command,
    argv: [process.execPath, '--test', '--test-reporter=junit', './test/example.test.mjs'] });
  assert.deepEqual(safe.files, ['test/example.test.mjs'], 'The planner’s ordinary ./ prefix preserves the same source identity.');
});

test('the effective risk child environment preserves application inputs and removes only host transport controls', () => {
  assert.deepEqual(trpNodeExecutionEnvironment({ NODE_ENV: 'production', TZ: 'UTC', SERVICE_TOKEN: 'secret',
    NODE_TEST_CONTEXT: 'child-v8', NODE_TEST_WORKER_ID: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'actor', _: 'shell', SHLVL: '2' }),
  { NODE_ENV: 'production', TZ: 'UTC', SERVICE_TOKEN: 'secret' });
});
