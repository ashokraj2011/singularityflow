import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nodeTestReporterEnvironment, nodeTestObservation } from '../src/verification/node-test-observation.mjs';
import { scanJavaScriptDeclarations } from '../src/verification/javascript-declarations.mjs';
import { replayTestReports, persistedOccurrences } from '../src/code-delivery-tests.mjs';
import { witnessResult } from '../src/verification/witness-results.mjs';
import { resolveDeliveryQualityCommands } from '../src/delivery-evidence.mjs';

test('native Node results bind file, suite, name and line; skips and other tests cannot prove a criterion', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-node-witness-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const source = `import { test, describe, it } from 'node:test';
// @ac:NATIVE:AC-001
test('same', () => {});
describe('group', () => {
  // @ac:NATIVE:AC-002
  it.skip('skipped', () => {});
  // @ac:NATIVE:AC-003
  it('nested', () => {});
});
// @ac:NATIVE:AC-004
test.todo('later');
`;
  await writeFile(path.join(root, 'sample.test.mjs'), source);
  await writeFile(path.join(root, 'other.test.mjs'), "import { test } from 'node:test';\ntest('same', () => {});\n");
  const result = spawnSync(process.execPath, ['--test', 'sample.test.mjs', 'other.test.mjs'], {
    cwd: root, encoding: 'utf8', env: await nodeTestReporterEnvironment(process.env, root)
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const parsed = replayTestReports('node-tap', [{ contents: result.stdout }]);
  assert.deepEqual(parsed.tests, { discovered: 5, passed: 3, failed: 0, skipped: 2 });
  const attempt = { status: 'passed', exitCode: 0, tests: parsed.tests, occurrences: persistedOccurrences(parsed) };
  const declarations = scanJavaScriptDeclarations(source, { sourcePath: 'sample.test.mjs', framework: 'node:test' }).declarations;
  const witness = (declaration) => ({ profile: 'node-test-v1', resultAdapter: 'node-tap',
    identity: declaration, testSource: declaration.sourcePath, line: declaration.line, gaps: declaration.gaps.map((entry) => entry.code) });
  assert.deepEqual(declarations.map((entry) => witnessResult(witness(entry), attempt).status), ['met', 'missing', 'met', 'missing']);
  const first = witness(declarations[0]);
  assert.equal(witnessResult(first, { ...attempt, occurrences: attempt.occurrences.filter((entry) => entry.file === 'other.test.mjs') }).status, 'missing');
  assert.equal(witnessResult(first, { ...attempt, occurrences: attempt.occurrences.map(({ file, ...entry }) => entry) }).status, 'missing');
  assert.equal(witnessResult(first, { ...attempt, occurrences: attempt.occurrences.map((entry) => ({ ...entry, line: entry.line + 1 })) }).status, 'missing');
  assert.throws(() => nodeTestObservation(result.stdout, { ...parsed.tests, discovered: 99 }), /counts/);
});

test('misplaced tags, duplicate declarations and counts-only Node receipts never earn exact credit', () => {
  const misplaced = scanJavaScriptDeclarations("// @ac:N:AC-001\nimport test from 'node:test';\ntest('unrelated', () => {});", { sourcePath: 't.mjs', framework: 'node:test' });
  assert.equal(misplaced.unattachedTags.length, 1);
  assert.deepEqual(misplaced.declarations[0].clauseIds, []);
  const duplicate = scanJavaScriptDeclarations("import test from 'node:test';\n// @ac:N:AC-001\ntest('same',()=>{});\n// @ac:N:AC-001\ntest('same',()=>{});", { sourcePath: 't.mjs', framework: 'node:test' });
  assert.ok(duplicate.declarations.every((entry) => entry.gaps.some((gap) => gap.code === 'DUPLICATE_DECLARATION')));
  const forged = scanJavaScriptDeclarations("function test() {}\n// @ac:N:AC-001\ntest('not native',()=>{});", { sourcePath: 't.mjs', framework: 'node:test' });
  assert.ok(forged.declarations[0].gaps.some((gap) => gap.code === 'NODE_TEST_IMPORT_UNSUPPORTED'));
  assert.equal(witnessResult({ profile: 'module-counts-v1', resultAdapter: 'node-tap', identity: null }, {
    status: 'passed', tests: { passed: 1, failed: 0, skipped: 0 }
  }).status, 'inconclusive');
  assert.equal(witnessResult({ profile: 'module-counts-v1', identity: null }, {
    adapter: 'node-tap', status: 'passed', tests: { passed: 1, failed: 0, skipped: 0 }
  }).status, 'inconclusive', 'legacy bindings cannot hide the Node adapter stored in the attempt');
});

test('manifest-free Node tests infer the exact adapter, not counts-only JUnit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-node-no-manifest-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, 'sample.test.mjs'), "import test from 'node:test'; test('ok', () => {});");
  const commands = await resolveDeliveryQualityCommands(root, {
    generation: { task: 'code' }, qualityCommands: [], deliveryEvidence: { testPaths: ['sample.test.mjs'] }
  });
  assert.equal(commands[0].result.adapter, 'node-tap');
  assert.deepEqual(commands[0].argv, ['node', '--test', 'sample.test.mjs']);
});

test('explicit TAP reporters still run once and retain exact identities, directly and via npm', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-node-explicit-reporter-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, 'case.test.mjs'), "import test from 'node:test';\ntest('one', () => {});\n");
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test --test-reporter=tap case.test.mjs' } }));
  for (const argv of [[process.execPath, '--test', '--test-reporter=tap', 'case.test.mjs'], ['npm', 'test']]) {
    const result = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8',
      env: await nodeTestReporterEnvironment(process.env, root, { argv }) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const observed = replayTestReports('node-tap', [{ contents: result.stdout }]);
    assert.deepEqual(observed.tests, { discovered: 1, passed: 1, failed: 0, skipped: 0 });
    assert.equal(observed.testcaseObservation.occurrences[0].file, 'case.test.mjs');
    assert.equal(observed.testcaseObservation.occurrences[0].line, 2);
  }
});

test('a TAP reporter behind npm run chains and workspaces gets its destinations, so the run starts (review, 2026-11-01)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-node-chain-reporter-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, 'packages/a'), { recursive: true });
  const testFile = "import test from 'node:test';\ntest('one', () => {});\n";
  await writeFile(path.join(root, 'case.test.mjs'), testFile);
  await writeFile(path.join(root, 'packages/a/case.test.mjs'), testFile);
  await writeFile(path.join(root, 'packages/a/package.json'), JSON.stringify({ name: 'a', scripts: { test: 'node --test --test-reporter=tap case.test.mjs' } }));
  // test → npm run unit → node --test --test-reporter=tap: plain `npm test` passed, and the gate's run exited before any test.
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'], scripts: {
    test: 'npm run unit', unit: 'node --test --test-reporter=tap case.test.mjs', 'test:a': 'npm --workspace a test',
    'test:both': 'node --test --test-reporter=tap case.test.mjs && node --test case.test.mjs' } }));
  // Identities are the repository's paths, so a workspace's test reads under its directory.
  for (const [argv, file] of [[['npm', 'test'], 'case.test.mjs'], [['npm', 'run', 'test:a'], 'packages/a/case.test.mjs'],
    [['npm', '--workspace', 'a', 'test'], 'packages/a/case.test.mjs']]) {
    const cwd = root;
    const env = await nodeTestReporterEnvironment(process.env, root, { argv, cwd });
    assert.match(env.NODE_OPTIONS, /--test-reporter-destination=stdout --test-reporter-destination=stdout$/u, argv.join(' '));
    const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', env });
    assert.equal(result.status, 0, `${argv.join(' ')}\n${result.stdout}${result.stderr}`);
    const observed = replayTestReports('node-tap', [{ contents: result.stdout }]);
    assert.deepEqual(observed.tests, { discovered: 1, passed: 1, failed: 0, skipped: 0 }, argv.join(' '));
    assert.equal(observed.testcaseObservation.occurrences[0].file, file);
  }
  // Two runs that install different reporters cannot share one NODE_OPTIONS: refused before anything runs.
  await assert.rejects(nodeTestReporterEnvironment(process.env, root, { argv: ['npm', 'run', 'test:both'], cwd: root }), { code: 'NODE_TEST_REPORTER_UNSUPPORTED' });
});
