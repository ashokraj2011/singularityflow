/**
 * Native test layouts count as tests. `[native-test-layouts]`
 *
 * An Android Story put its acceptance test in `app/src/androidTest/`, a folder the test boundary did
 * not know, so the test was classified as product source: "no acceptance test is available", every
 * owed @ac tag reported missing, and the author's repair loop could never satisfy the gate.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { isExecutableTestSourcePath, isTestSourceName } from '../src/code-delivery-tests.mjs';
import { isTestAutomationPath } from '../src/source-boundary.mjs';
import { inferKind } from '../src/state.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin/singularity-flow.mjs');
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Layout Tester' };
delete ENV.SINGULARITY_FLOW_NO_MODEL;

test('Gradle, Android, Xcode, .NET, Go and pytest test layouts are test automation; product folders stay product', () => {
  for (const candidate of [
    'app/src/androidTest/java/com/acme/AccountLookupTest.kt', 'app/src/androidTest/java/com/acme/robots/AccountRobot.kt',
    'feature/src/integrationTest/kotlin/LookupTest.kt', 'app/src/testDebug/java/LookupTest.kt', 'shared/src/commonTest/kotlin/LookupTest.kt',
    'MyAppTests/AccountLookupTests.swift', 'MyAppUITests/Robots/LoginRobot.swift', 'MyApp.Tests/AccountLookupTests.cs',
    'MyApp.UnitTests/LookupTests.cs', 'pkg/lookup/lookup_test.go', 'test_lookup.py', 'app/lookup_test.py'
  ]) assert.equal(isTestAutomationPath(candidate), true, candidate);
  for (const candidate of [
    'app/src/main/java/com/acme/Lookup.kt', 'src/main/java/com/acme/ABTest.java', 'src/contests/Contest.java',
    'src/latest/index.ts', 'src/abtests/index.ts', 'Sources/MyApp/Tests.swift', 'cmd/testing/main.go', 'lib/latest.py'
  ]) assert.equal(isTestAutomationPath(candidate), false, candidate);
});

test('CommonJS and CommonJS TypeScript tests, and any script Jest runs below __tests__, are test sources; its support is not', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-names-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tests = ['test/value.test.cjs', 'test/value.test.cts', '__tests__/value.js', 'src/__tests__/helpers/value.tsx', 'src/__tests__/value.cjs'];
  const support = ['__tests__/fixtures/value.js', '__tests__/__mocks__/api.js', '__tests__/__fixtures__/order.ts',
    '__tests__/__snapshots__/value.js', '__tests__/types.d.ts', '__tests__/README.md'];
  for (const relative of [...tests, ...support]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), '');
  }
  for (const relative of tests) {
    assert.equal(await isExecutableTestSourcePath(root, relative), true, relative);
    assert.equal(isTestSourceName(relative), true, relative);
  }
  for (const relative of support) assert.equal(await isExecutableTestSourcePath(root, relative), false, relative);
  // Outside __tests__ a script still needs a test's name.
  assert.equal(isTestSourceName('src/value.cjs'), false);
  assert.equal(inferKind('src/__tests__/value.js'), 'test');
});

/** A classic-delivery Story whose implementation is drafted with its acceptance test at `testPath`. */
async function implementationWithTestAt(t, W, testPath, { commonjs = false } = {}) {
  const AC = `${W}:AC-001`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-layout-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8', env: ENV });
  const must = (command, args) => {
    const result = run(command, args);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const cli = (...args) => must(process.execPath, [CLI, '--no-model', ...args]);
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  const module = path.posix.relative(path.posix.dirname(testPath), 'app/src/main/value.mjs');
  const testSource = (expected, tagged) => (commonjs
    ? ["const test = require('node:test');", "const assert = require('node:assert/strict');",
      ...(tagged ? [`// @ac:${AC}`] : []), `test('value', async () => assert.equal((await import('./${module}')).value, ${expected}));`, '']
    : ["import test from 'node:test';", "import assert from 'node:assert/strict';", `import { value } from '${module}';`,
      ...(tagged ? [`// @ac:${AC}`] : []), `test('value', () => assert.equal(value, ${expected}));`, '']).join('\n');
  must('git', ['init', '-q', '-b', 'main']);
  must('git', ['config', 'user.name', 'Layout Tester']);
  must('git', ['config', 'user.email', 'layout@example.test']);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: `node --test ${testPath}` } }));
  await write('app/src/main/value.mjs', 'export const value = 1;\n');
  await write(testPath, testSource(1, false));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']);
  must('git', ['commit', '-qm', 'Initialize the native layout fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  must('git', ['remote', 'add', 'origin', remote]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');
  cli('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return 2.');
  const item = path.join(root, 'singularity/work-items', W);
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [`# ${W} — intake`, '', '## Request and outcome', '',
    'Return the approved value 2 to every caller.', '', '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${AC}] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${AC}\` | \`app/src/main/value.mjs\` | \`${testPath}\` | modified |`, '',
    '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');
  cli('prepare', 'implementation');
  await write('app/src/main/value.mjs', `// @clause:${AC} returns the approved value\nexport const value = 2;\n`);
  await write(testPath, testSource(2, true));
  const summary = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(summary, (await readFile(summary, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module returns the approved value.'));
  return { publish: () => run(process.execPath, [CLI, '--no-model', 'phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place']) };
}

test('an acceptance test in an Android androidTest source set is read and published', async (t) => {
  const { publish } = await implementationWithTestAt(t, 'LAYOUT-1', 'app/src/androidTest/value-test.mjs');
  const published = publish();
  assert.equal(published.status, 0, published.stdout + published.stderr);
});

test('a test named as one but outside every test folder is named in the refusal, not left as a silent gap', async (t) => {
  const { publish } = await implementationWithTestAt(t, 'LAYOUT-2', 'checks/value-test.mjs');
  const refused = publish();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /no acceptance test is available for the implementation: checks\/value-test\.mjs is named as tests? but not in a recognised test folder/u);
});

test('a CommonJS acceptance test is read and published', async (t) => {
  const { publish } = await implementationWithTestAt(t, 'LAYOUT-3', 'app/src/test/value.test.cjs', { commonjs: true });
  const published = publish();
  assert.equal(published.status, 0, published.stdout + published.stderr);
});

test('a script below __tests__ is an acceptance test whatever it is called, as Jest runs it', async (t) => {
  const { publish } = await implementationWithTestAt(t, 'LAYOUT-4', 'app/src/__tests__/value.js');
  const published = publish();
  assert.equal(published.status, 0, published.stdout + published.stderr);
});

test('a fixture below __tests__ is support, never the acceptance test', async (t) => {
  // Refused by the step that plans it, with the move to make, not first at the code step ("no acceptance test is
  // available"): the step responsible repairs it (office, 2026-11-11).
  await assert.rejects(() => implementationWithTestAt(t, 'LAYOUT-5', 'app/src/__tests__/fixtures/value.js'),
    (error) => /app\/src\/__tests__\/fixtures\/value\.js is test support \(a mock, fixture, setup, helper or page object\), not a test case[\s\S]*Supporting files/u.test(error.message));
});
