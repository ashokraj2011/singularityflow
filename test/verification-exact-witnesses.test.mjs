import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const SHIM = path.join(ROOT, 'test', 'fixtures', 'verification', 'jest-shim.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Exact Verification Tester' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function governedRepository(t, workId, files, { executables = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-exact-verification-'));
  const remote = `${root}.git`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Exact Verification Tester'], root);
  run('git', ['config', 'user.email', 'exact@example.test'], root);
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  for (const relative of executables) await chmod(path.join(root, relative), 0o755);
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize exact verification fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const plan = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', plan.planId, '--json');
  return { root, cli };
}

async function intake(root, cli, workId, criteria, planned, { columns = ['Clause', 'Expected paths', 'Planned tests'], extra = [] } = {}) {
  cli('start', workId, '--from-branch', 'main', '--work-type', 'classic-delivery',
    '--title', 'Exact verification', '--description', 'Show exact test results per criterion.');
  const item = path.join(root, 'singularity/work-items', workId);
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${workId} — intake`, '', '## Request and outcome', '',
    'Return the approved values to every caller; retain the exported API.', '',
    '## Scope and constraints', '', 'Change only the value module and its tests.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    ...criteria.map(([id, text]) => `| [${workId}:${id}] | ${text} |`), '',
    '## Planned implementation evidence', '', `| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`,
    ...planned.map(([id, ...cells]) => `| \`${workId}:${id}\` | ${cells.join(' | ')} |`), '',
    ...extra,
    '## Initial evidence', '', 'The baseline module and tests at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Are the planned values approved?', '--answer', 'Yes.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');
  cli('prepare', 'implementation');
  return item;
}

async function completeSummary(item) {
  const file = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace(/TODO:[^\n]*/gu,
    'The clause-tagged module and acceptance-tagged tests now prove the approved values.'));
}

test('§12 #7 and #8 through a real Story: only a criterion\'s own passing Jest test verifies it', async (t) => {
  const workId = 'EXACT-1';
  const { root, cli } = await governedRepository(t, workId, {
    // A stand-in for Jest with its CLI flags and JSON report; the readiness plan runs it as a unit-test runner.
    'package.json': JSON.stringify({ type: 'module', private: true, scripts: { test: 'node tools/jest-shim.mjs --runner jest' } }),
    // The runner's report is tool output, never source, so the Story starts in this checkout.
    '.gitignore': '.sflow/\n',
    'tools/jest-shim.mjs': await readFile(SHIM, 'utf8'),
    'src/value.js': 'export const value = 1;\nexport const half = 0;\n',
    'test/value.test.js': "import { value } from '../src/value.js';\ntest('baseline value', () => { expect(value).toBe(1); });\n"
  });
  const matrix = () => JSON.parse(cli('evidence', 'matrix', '--json').stdout).data.matrix;
  const item = await intake(root, cli, workId, [
    ['AC-001', 'The exported value equals 2.'],
    ['AC-002', 'Half of the value is 1.'],
    ['AC-003', 'A refund returns the balance.'],
    ['AC-004', 'The value is stable across reads.'],
    ['AC-005', 'A spec file proves the value.']
  ], [
    ['AC-001', '`src/value.js`', '`test/value.test.js`'],
    ['AC-002', '`src/value.js`', '`test/value.test.js`'],
    ['AC-003', '`src/value.js`', '`test/refund.test.js`'],
    ['AC-004', '`src/value.js`', '`test/value.test.js`'],
    ['AC-005', '`src/value.js`', '`test/value.spec.js`']
  ]);
  await writeFile(path.join(root, 'src/value.js'), [
    ...['AC-001', 'AC-002', 'AC-003', 'AC-004', 'AC-005'].map((id) => `// @clause:${workId}:${id} the value module returns the approved values`),
    'export const value = 2;', 'export const half = value / 2;', ''
  ].join('\n'));
  await writeFile(path.join(root, 'test/value.test.js'), [
    "import { value, half } from '../src/value.js';", '',
    `// @ac:${workId}:AC-001`, "test('exported value is two', () => { expect(value).toBe(2); });", '',
    `// @ac:${workId}:AC-002`, "test.skip('half is one', () => { expect(half).toBe(1); });", '',
    "describe('reads', () => {",
    `  // @ac:${workId}:AC-004`, "  test('stable', () => { expect(value).toBe(2); });",
    "  test('stable', () => { expect(value).toBe(2); });",
    '});', ''
  ].join('\n'));
  // §12 #7: a tag at the top of a file sits on no test; the unrelated passing test there cannot verify AC-003.
  await writeFile(path.join(root, 'test/refund.test.js'), [
    `// @ac:${workId}:AC-003`, "import { value } from '../src/value.js';", '',
    "test('an unrelated passing test', () => { expect(value).toBe(2); });",
    "test.skip('the real refund test', () => { expect(value).toBe(0); });", ''
  ].join('\n'));
  await writeFile(path.join(root, 'test/value.spec.js'), [
    "import { value } from '../src/value.js';",
    `// @ac:${workId}:AC-005`, "test('spec proves the value', () => { expect(value).toBe(2); });", ''
  ].join('\n'));
  await completeSummary(item);
  const refused = run(process.execPath, [CLI, '--no-model', 'phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place', '--json'], root, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, new RegExp(`@ac:${workId}:AC-003 is not on a test: test/refund\\.test\\.js:1`));
  // Move the tag onto the test that should verify it, which is skipped.
  await writeFile(path.join(root, 'test/refund.test.js'), [
    "import { value } from '../src/value.js';", '',
    "test('an unrelated passing test', () => { expect(value).toBe(2); });",
    `// @ac:${workId}:AC-003`, "test.skip('the real refund test', () => { expect(value).toBe(0); });", ''
  ].join('\n'));
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');

  const evaluation = matrix().evaluation;
  const rows = Object.fromEntries(matrix().page.rows.map((entry) => [entry.id.split(':').at(-1), entry]));
  const verify = (id) => rows[id].obligations.find((entry) => entry.responsibility === 'verify');
  // AC-001: its own Jest test passed in the attempt of the published candidate.
  assert.equal(verify('AC-001').status, 'met');
  assert.equal(verify('AC-001').facets.assurance, 'exact-local-observed');
  assert.deepEqual(verify('AC-001').assuranceFacets, { identity: 'source-bound', execution: 'exact-local-observed' });
  // AC-002 and AC-003: skipped tests verify nothing, though the module command passed (#8, #7).
  for (const id of ['AC-002', 'AC-003']) {
    assert.equal(verify(id).status, 'missing', id);
    assert.equal(rows[id].verification.witnesses[0].outcome, 'unverified-skipped', id);
  }
  // AC-004: two tests share its title in one describe block, so neither can be credited (#8).
  assert.equal(verify('AC-004').status, 'inconclusive');
  assert.ok(rows['AC-004'].verification.witnesses[0].reasons.includes('DUPLICATE_DECLARATION'));
  // AC-005: the runner never ran the spec file, so the test has no result (#8 missing/filtered).
  assert.equal(verify('AC-005').status, 'missing');
  assert.equal(rows['AC-005'].verification.witnesses[0].outcome, 'missing');
  assert.equal(evaluation.decision.gate, 'block');

  // The approver is shown the same per-criterion results, each in words.
  const review = JSON.parse(cli('phase', 'show', 'implementation', '--json').stdout);
  const criteria = Object.fromEntries(review.testEvidence.acceptance.criteria.map((entry) => [entry.clauseId.split(':').at(-1), entry]));
  assert.equal(criteria['AC-001'].status, 'met');
  assert.match(criteria['AC-002'].witnesses[0].words, /was skipped, so it verified nothing/);
  assert.match(review.testEvidence.acceptance.statement, /^1 of 5 acceptance criteria verified \(1 by their own test result, 0 by a module test command\); 4 not verified yet\.$/);

  // Every run is an immutable attempt: the preflight and the submission, never overwritten.
  const directory = path.join(item, 'context/code-delivery/tests/attempts/implementation');
  const names = (await readdir(directory)).filter((name) => /^TA-[a-f0-9]{20}\.json$/.test(name));
  const purposes = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8')).purpose));
  assert.ok(purposes.includes('preflight') && purposes.includes('submission'), purposes.join(', '));
});

test('§12 #8 for JUnit 5 through a real Story: skipped, filtered, missing and duplicate results stay unverified', async (t) => {
  const workId = 'EXACT-2';
  const report = [
    '<testsuite name="example.OrderTest" tests="4" failures="0" errors="0" skipped="1">',
    '  <testcase classname="example.OrderTest" name="totalsTheOrder" time="0.01"/>',
    '  <testcase classname="example.OrderTest" name="refundsTheOrder" time="0.01"><skipped/></testcase>',
    '  <testcase classname="example.OrderTest" name="cachesTheTotal" time="0.01"/>',
    '  <testcase classname="example.OrderTest" name="cachesTheTotal" time="0.01"/>',
    '</testsuite>', ''
  ].join('\n');
  const { root, cli } = await governedRepository(t, workId, {
    'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>order</artifactId><version>1</version></project>\n',
    '.gitignore': 'target/\n',
    // A stand-in Maven wrapper: it writes the Surefire report a real run of this module produces.
    mvnw: `#!/bin/sh\nmkdir -p target/surefire-reports\ncat > target/surefire-reports/TEST-example.OrderTest.xml <<'XML'\n${report}XML\n`,
    'src/main/java/example/Order.java': 'package example;\nfinal class Order { int total() { return 1; } }\n',
    'src/test/java/example/OrderTest.java': 'package example;\nimport org.junit.jupiter.api.Test;\nfinal class OrderTest {\n  @Test void totalsTheOrder() {}\n}\n'
  }, { executables: ['mvnw'] });
  const item = await intake(root, cli, workId, [
    ['AC-001', 'The order total is computed.'],
    ['AC-002', 'A refund returns the order total.'],
    ['AC-003', 'The total is cached.'],
    ['AC-004', 'A spec proves the total.']
  ], [
    ['AC-001', '`src/main/java/example/Order.java`', '`src/test/java/example/OrderTest.java`'],
    ['AC-002', '`src/main/java/example/Order.java`', '`src/test/java/example/OrderTest.java`'],
    ['AC-003', '`src/main/java/example/Order.java`', '`src/test/java/example/OrderTest.java`'],
    ['AC-004', '`src/main/java/example/Order.java`', '`src/test/java/example/OrderSpec.java`']
  ]);
  await writeFile(path.join(root, 'src/main/java/example/Order.java'), [
    'package example;', ...['AC-001', 'AC-002', 'AC-003', 'AC-004'].map((id) => `// @clause:${workId}:${id} the order computes and caches its total`),
    'final class Order { int total() { return 2; } }', ''
  ].join('\n'));
  await writeFile(path.join(root, 'src/test/java/example/OrderTest.java'), [
    'package example;', 'import org.junit.jupiter.api.BeforeEach;', 'import org.junit.jupiter.api.Disabled;', 'import org.junit.jupiter.api.Test;',
    'final class OrderTest {', '  @BeforeEach void setUp() {}',
    `  // @ac:${workId}:AC-001`, '  @Test void totalsTheOrder() {}',
    `  // @ac:${workId}:AC-002`, '  @Disabled @Test void refundsTheOrder() {}',
    `  // @ac:${workId}:AC-003`, '  @Test void cachesTheTotal() {}', '}', ''
  ].join('\n'));
  // Surefire's default includes do not run *Spec classes: the tagged test exists but never runs.
  await writeFile(path.join(root, 'src/test/java/example/OrderSpec.java'), [
    'package example;', 'import org.junit.jupiter.api.Test;', 'final class OrderSpec {',
    `  // @ac:${workId}:AC-004`, '  @Test void provesTheTotal() {}', '}', ''
  ].join('\n'));
  await completeSummary(item);
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  const rows = Object.fromEntries(JSON.parse(cli('evidence', 'matrix', '--json').stdout).data.matrix.page.rows
    .map((entry) => [entry.id.split(':').at(-1), entry]));
  const outcome = (id) => rows[id].verification.witnesses[0].outcome;
  assert.equal(outcome('AC-001'), 'passed');
  assert.equal(rows['AC-001'].obligations.find((entry) => entry.responsibility === 'verify').facets.assurance, 'exact-local-observed');
  assert.equal(outcome('AC-002'), 'unverified-skipped');
  assert.equal(outcome('AC-003'), 'ambiguous');
  assert.equal(outcome('AC-004'), 'missing');
  for (const id of ['AC-002', 'AC-003', 'AC-004']) {
    assert.notEqual(rows[id].obligations.find((entry) => entry.responsibility === 'verify').status, 'met', id);
  }
});

test('a verification contract through a real Story: an inspection-only criterion needs no tag, and the reviewer decides adequacy', async (t) => {
  const workId = 'EXACT-3';
  const { root, cli } = await governedRepository(t, workId, {
    'package.json': JSON.stringify({ type: 'module', private: true, scripts: { test: 'node tools/jest-shim.mjs --runner jest' } }),
    '.gitignore': '.sflow/\n',
    'tools/jest-shim.mjs': await readFile(SHIM, 'utf8'),
    'src/value.js': 'export const value = 1;\n',
    'test/value.test.js': "import { value } from '../src/value.js';\ntest('baseline value', () => { expect(value).toBe(1); });\n"
  });
  const item = await intake(root, cli, workId, [
    ['AC-001', 'The exported value equals 2.'],
    ['AC-002', 'The runbook states the approved value.']
  ], [
    ['AC-001', '`src/value.js`', '`test/value.test.js`', 'modified'],
    ['AC-002', '`docs/runbook.md`', 'not-applicable: a reviewer inspects the runbook', 'document']
  ], {
    columns: ['Clause', 'Expected paths', 'Planned tests', 'Fulfillment'],
    extra: [
      '## Verification contracts', '', '| Criterion | Slot | Method | Witness |', '|---|---|---|---|',
      `| \`${workId}:AC-001\` | unit | test | \`test/value.test.js\` |`,
      `| \`${workId}:AC-002\` | runbook | inspection | \`docs/runbook.md\` |`, ''
    ]
  });
  await writeFile(path.join(root, 'src/value.js'), `// @clause:${workId}:AC-001 returns the approved value two\nexport const value = 2;\n`);
  await writeFile(path.join(root, 'test/value.test.js'), [
    "import { value } from '../src/value.js';", '', `// @ac:${workId}:AC-001`, "test('exported value is two', () => { expect(value).toBe(2); });", ''
  ].join('\n'));
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs/runbook.md'), '# Runbook\n\nThe exported value is two.\n');
  await completeSummary(item);
  // AC-002 is verified by inspection, so no test needs an @ac tag for it.
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  const review = JSON.parse(cli('phase', 'show', 'implementation', '--json').stdout);
  assert.equal(review.witnessReview.mappings.length, 1, 'one exact test is proposed for review');
  const [mapping] = review.witnessReview.mappings;
  assert.equal(mapping.clauseId, `${workId}:AC-001`);
  assert.equal(mapping.slot, 'unit');
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  cli('approve', 'implementation', '--yes', '--witness-mapping', `${mapping.mappingSha256}=exception:boundaries`,
    '--witness-mapping-reason', 'No negative value case yet; it is tracked as follow-up work.', '--witness-mapping-expires', expires);
  const rows = Object.fromEntries(JSON.parse(cli('evidence', 'matrix', '--json').stdout).data.matrix.page.rows
    .map((entry) => [entry.id.split(':').at(-1), entry]));
  const verify = (id) => rows[id].obligations.find((entry) => entry.responsibility === 'verify');
  assert.equal(verify('AC-001').status, 'excepted');
  assert.equal(verify('AC-001').facets.exception, 'witness-exception');
  assert.equal(verify('AC-001').facets.execution, 'passed', 'the exception never rewrites what was observed');
  assert.equal(rows['AC-002'].verification.contract.slots[0].method, 'inspection');
  assert.equal(verify('AC-002').status, 'missing', 'the runbook still needs its inspection record');

  // A reviewer inspects the runbook: the slot is witnessed by its exact bytes, and only while they hold.
  cli('decision', 'witness', '--criterion', `${workId}:AC-002`, '--slot', 'runbook', '--file', 'docs/runbook.md',
    '--confirm', 'states-the-outcome', '--confirm', 'matches-the-criterion', '--confirm', 'current-for-this-change',
    '--reason', 'The runbook states that the exported value is two.');
  const matrixRows = () => Object.fromEntries(JSON.parse(cli('evidence', 'matrix', '--json').stdout).data.matrix.page.rows
    .map((entry) => [entry.id.split(':').at(-1), entry]));
  const inspected = matrixRows();
  assert.equal(inspected['AC-002'].obligations.find((entry) => entry.responsibility === 'verify').status, 'met');
  assert.equal(inspected['AC-002'].assurance, 'source-bound');
  await writeFile(path.join(root, 'docs/runbook.md'), '# Runbook\n\nThe exported value is three.\n');
  const changed = matrixRows();
  assert.equal(changed['AC-002'].obligations.find((entry) => entry.responsibility === 'verify').status, 'missing');
  assert.ok(changed['AC-002'].findings.some((entry) => /changed after its inspection/.test(entry.message)));
});
