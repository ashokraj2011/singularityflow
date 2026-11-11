/**
 * The runner table: what each consumer reads from it, and that a row stays consistent. The behaviour each column
 * drives is pinned by that consumer's own tests; a row that drifted from them would fail there.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { isTestSourceName, parseTestResult, resolveAffectedModule, testCommandCoversPath, testCommandEcosystem } from '../src/code-delivery-tests.mjs';
import { TEST_RESULT_ADAPTERS } from '../src/external-command-policy.mjs';
import { completeWrittenTestCommand } from '../src/instruction-test-commands.mjs';
import { inferRepositoryTestCommands } from '../src/repository-test-command-inference.mjs';
import { inspectRepositoryTestSetup } from '../src/repository-test-setup.mjs';
import { commandDefinition } from '../src/test-command-pins.mjs';
import { moduleTestCommands } from '../src/test-module-markers.mjs';
import { commandFilters, pathOperands } from '../src/test-narrowing.mjs';
import { describeTestCommand, earlyTestChecks } from '../src/test-plan.mjs';
import { profileForCommand } from '../src/verification/profiles.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
import { isRunnerConfigurationName, runnerNameOfAdapter, runnerNameOfLauncher, runnerNamed, runnerOfLauncher, scriptRunnerOf, selectingRunner, TEST_RUNNERS, TOOLS_ON_PATH } from '../src/test-runners.mjs';

test('every row has a person\'s word and the programs that start it, and no two rows claim one program', () => {
  const seen = new Set();
  for (const [key, row] of Object.entries(TEST_RUNNERS)) {
    assert.ok(row.name, key);
    assert.ok(row.launchers.length, key);
    for (const launcher of row.launchers) { assert.ok(!seen.has(launcher), `${launcher} in two rows`); seen.add(launcher); }
    if (row.adapter) assert.ok(TEST_RESULT_ADAPTERS.includes(row.adapter), `${key}: ${row.adapter} is no adapter a command can name`);
    if (row.selection) assert.ok(row.selection.valueless.every((option) => row.selection.filters.includes(option)), `${key}: a valueless option it does not filter by`);
    // The path check reads a runner's operands only with both: which words are verbs, and which files are its tests.
    if (row.selection) assert.equal(Boolean(row.selection.verbs), Boolean(row.selection.testFiles), `${key}: verbs and testFiles go together`);
    if (row.module) assert.ok(row.direct, `${key}: a runner a build file implies can also be written by hand`);
    assert.equal(runnerNamed(row.name)?.key, key);
  }
});

test('what consumers ask of it', () => {
  assert.equal(runnerNameOfAdapter('vitest-json'), 'Vitest');
  assert.equal(runnerNameOfAdapter('junit-xml'), null, 'a JUnit report says nothing about who wrote it');
  assert.equal(runnerNameOfLauncher('react-scripts'), 'Jest');
  assert.equal(runnerNameOfLauncher('node'), null, '`node` alone says nothing about tests');
  assert.equal(runnerOfLauncher('mvnw').key, 'maven');
  assert.equal(selectingRunner('tox'), 'pytest', 'tox runs pytest for you');
  assert.equal(selectingRunner('nx'), null, 'a runner with no selection column reads the generic options');
  assert.equal(TOOLS_ON_PATH.mvn, 'Maven');
  assert.equal(scriptRunnerOf('bun', 'test'), 'bun');
  assert.equal(scriptRunnerOf('bun', undefined), null, 'a program with nothing after it starts no runner');
  assert.equal(scriptRunnerOf('eslint', undefined), null);
  assert.equal(isRunnerConfigurationName('playwright.config.ts'), true);
  assert.equal(isRunnerConfigurationName('conftest.py'), true);
  assert.equal(isRunnerConfigurationName('package.json'), false);
});

const makeRepository = async (t, files) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-runner-rows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  return root;
};
const gate = async (root, file) => moduleTestCommands(root, await resolveAffectedModule(root, file));
const shown = (commands) => commands.map((command) => [command.id, command.argv, command.result.adapter, command.result.path]);

test('PHPUnit: a project that names it runs it with a JUnit report, and a Composer project that does not is still refused', async (t) => {
  const root = await makeRepository(t, { 'composer.json': JSON.stringify({ 'require-dev': { 'phpunit/phpunit': '^11' } }), 'phpunit.xml': '<phpunit/>', 'src/App.php': '', 'tests/AppTest.php': '' });
  const expected = [['.-php-tests', ['vendor/bin/phpunit', '--log-junit', '.sflow/results/php-tests.xml'], 'junit-xml', '.sflow/results/php-tests.xml']];
  assert.deepEqual(shown(await gate(root, 'src/App.php')), expected);
  assert.deepEqual(shown(await inferRepositoryTestCommands(root)), expected, 'readiness and setup at the root read the same row');
  assert.equal(testCommandEcosystem((await gate(root, 'src/App.php'))[0]), 'php');
  assert.equal(testCommandCoversPath({ ...(await gate(root, 'src/App.php'))[0], provenance: 'inferred' }, 'src/App.php'), true);
  assert.equal(isTestSourceName('tests/AppTest.php'), true);
  // The configuration is pinned; the installed binary is a dependency, so installing it changes nothing.
  const [command] = await gate(root, 'src/App.php');
  assert.deepEqual((await commandDefinition(root, command)).entries.map((entry) => entry.path), ['phpunit.xml']);
  // A new Story checkout has no vendor folder: said before the first run, not found by it.
  const environment = { PATH: path.dirname(process.execPath), HOME: root };
  assert.deepEqual((await earlyTestChecks(root, [command], { environment })).filter((entry) => entry.command === 'composer install').map((entry) => entry.id), ['dependencies-not-installed']);
  assert.match((await describeTestCommand(root, command, { provenance: 'inferred' })).title, /PHPUnit/u);
  // What narrows it reads as anywhere else.
  assert.deepEqual(commandFilters(['vendor/bin/phpunit', '--filter', 'one', '--log-junit', 'r.xml']).map((entry) => [entry.option, entry.value]), [['--filter', 'one']]);
  const plain = await makeRepository(t, { 'composer.json': JSON.stringify({ require: { php: '^8' } }), 'src/App.php': '' });
  await assert.rejects(gate(plain, 'src/App.php'), /a PHP Composer build with no supported structured test runner/u);
  // Beside a package.json it owns only PHP files.
  const both = await makeRepository(t, { 'composer.json': JSON.stringify({ 'require-dev': { 'phpunit/phpunit': '^11' } }), 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'src/App.php': '', 'src/a.js': '' });
  assert.equal((await gate(both, 'src/App.php'))[0].id, '.-php-tests');
  assert.equal((await gate(both, 'src/a.js'))[0].id, '.-node-tests');
});

test('Bun: `bun test` in a package script gets its JUnit report, and a watching script is no gate\'s', async (t) => {
  const manifest = (test) => JSON.stringify({ name: 'x', scripts: { test } });
  const root = await makeRepository(t, { 'package.json': manifest('bun test'), 'bun.lock': '', 'src/a.test.ts': '' });
  const [command] = await gate(root, 'src/a.test.ts');
  assert.deepEqual([command.id, command.argv, command.result.adapter, command.result.path],
    ['.-node-tests', ['bun', 'run', 'test', '--', '--reporter=junit', '--reporter-outfile=.sflow/results/node-tests.xml'], 'junit-xml', '.sflow/results/node-tests.xml']);
  assert.equal(testCommandEcosystem(command), 'node');
  assert.equal(profileForCommand(command), 'module-counts-v1', 'its report has no profile yet, so a criterion rests on the whole suite, and it says so');
  assert.deepEqual(await gate(await makeRepository(t, { 'package.json': manifest('bun test --watch'), 'src/a.test.ts': '' }), 'src/a.test.ts'), []);
  const npm = await makeRepository(t, { 'package.json': manifest('bun test'), 'package-lock.json': '{}', 'src/a.test.ts': '' });
  assert.deepEqual((await gate(npm, 'src/a.test.ts'))[0].argv, ['npm', 'test', '--', '--reporter=junit', '--reporter-outfile=.sflow/results/node-tests.xml']);
  // A filter the Story adds to the script reads as a filter, and a path as a path.
  assert.deepEqual(commandFilters(['bun', 'test', '-t', 'one']).map((entry) => entry.option), ['-t']);
  assert.deepEqual(pathOperands(['bun', 'test', 'src/one']).operands, ['src/one']);
});

test('Deno: a deno.json runs its own test task when it has one, with a JUnit report; package.json beside it keeps Node', async (t) => {
  const plain = await makeRepository(t, { 'deno.json': '{ "imports": {} }', 'src/a_test.ts': '' });
  assert.deepEqual(shown(await gate(plain, 'src/a_test.ts')), [['.-deno-tests', ['deno', 'test', '--junit-path=.sflow/results/deno-tests.xml'], 'junit-xml', '.sflow/results/deno-tests.xml']]);
  const task = await makeRepository(t, { 'deno.jsonc': '{ // comment\n "tasks": { "test": "deno test --allow-read" } }', 'src/a_test.ts': '' });
  assert.deepEqual((await gate(task, 'src/a_test.ts'))[0].argv, ['deno', 'task', 'test', '--junit-path=.sflow/results/deno-tests.xml']);
  assert.deepEqual((await commandDefinition(task, (await gate(task, 'src/a_test.ts'))[0])).entries.map((entry) => entry.path), ['deno.jsonc']);
  const both = await makeRepository(t, { 'deno.json': '{}', 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'src/a.test.ts': '' });
  assert.equal((await gate(both, 'src/a.test.ts'))[0].id, '.-node-tests');
});

test('RSpec, minitest, Bazel, cargo and @nx/vite:test are proposals: setup shows the command and what a person must add, and nothing is guessed', async (t) => {
  const setup = async (files) => (await inspectRepositoryTestSetup(await makeRepository(t, files))).diagnostics.find((entry) => entry.proposal);
  const rspec = await setup({ Gemfile: "gem 'rspec-rails'\n", '.rspec': '--require spec_helper\n', 'spec/a_spec.rb': '' });
  assert.deepEqual([rspec.code, rspec.proposal.argv.slice(0, 5), rspec.proposal.missing], ['TEST_RUNNER_PROPOSED', ['bundle', 'exec', 'rspec', '--format', 'RspecJunitFormatter'], ['the rspec_junit_formatter gem']]);
  assert.match(rspec.message, /I found RSpec \(Gemfile\)\. SFlow reads results from JUnit reports.*Add rspec_junit_formatter.*Nothing was run\./u);
  const minitest = await setup({ Gemfile: "gem 'minitest'\n", 'test/a_test.rb': '' });
  assert.deepEqual([minitest.proposal.argv, minitest.proposal.missing], [['bundle', 'exec', 'rake', 'test'], ['the minitest-reporters gem with its JUnitReporter']]);
  const bazel = await setup({ 'MODULE.bazel': 'module(name = "x")\n' });
  assert.deepEqual([bazel.proposal.argv, bazel.proposal.result.path], [['bazel', 'test', '//...', '--test_output=errors'], 'bazel-testlogs']);
  const cargo = await setup({ 'Cargo.toml': '[package]\nname = "x"\n' });
  assert.equal(cargo.code, 'RUST_TEST_ADAPTER_REQUIRED');
  assert.deepEqual([cargo.proposal.env, cargo.proposal.choices.length], [{ RUSTC_BOOTSTRAP: '1' }, 2], 'a person\'s choice between the two');
  // At a gate a Gemfile was already refused: the same refusal now says what it found and offers the command.
  const ruby = await makeRepository(t, { Gemfile: "gem 'rspec'\n", 'lib/a.rb': '' });
  await assert.rejects(gate(ruby, 'lib/a.rb'), (error) => error.code === 'TEST_MODULE_UNCOVERED' && /I found RSpec there/u.test(error.message) && error.details.proposal.argv[2] === 'rspec');
  const vite = await makeRepository(t, { 'nx.json': '{}', 'package.json': '{}', 'apps/web/project.json': JSON.stringify({ name: 'web', targets: { test: { executor: '@nx/vite:test' } } }) });
  const { diagnostics } = await inspectRepositoryTestSetup(vite, { sourceRoots: ['apps/web'] });
  const proposed = diagnostics.find((entry) => entry.proposal);
  assert.deepEqual(proposed?.proposal.argv.slice(0, 5), ['npx', '--no-install', 'nx', 'run', 'web:test'], JSON.stringify(diagnostics));
});

test('a written command: phpunit and deno test complete from their rows; bundle exec rspec says what it needs, not that bundle is no runner', async (t) => {
  const php = await makeRepository(t, { 'composer.json': JSON.stringify({ 'require-dev': { 'phpunit/phpunit': '^11' } }) });
  const written = await completeWrittenTestCommand(php, { text: 'vendor/bin/phpunit' });
  assert.deepEqual([written.command?.argv, written.command?.result.path, written.command?.affectedRoots], [['vendor/bin/phpunit', '--log-junit', '.sflow/results/phpunit-tests.xml'], '.sflow/results/phpunit-tests.xml', ['.']], JSON.stringify(written));
  const deno = await makeRepository(t, { 'deno.json': '{}' });
  assert.deepEqual((await completeWrittenTestCommand(deno, { text: 'deno test --allow-read' })).command.argv, ['deno', 'test', '--allow-read', '--junit-path=.sflow/results/deno-tests.xml']);
  assert.match((await completeWrittenTestCommand(php, { text: 'bundle exec rspec' })).reason, /rspec_junit_formatter/u);
  assert.match((await completeWrittenTestCommand(php, { text: 'bazel test //...' })).reason, /bazel-testlogs/u);
});

test('the JUnit a runner with no installed tool writes, as its documentation shows it, reads per file: nested suites, no root count', async (t) => {
  // Hand-written from each tool's documentation, so a shape change there would not be seen here; test/real-test-tools.test.mjs runs the tools where installed.
  const reports = {
    phpunit: '<?xml version="1.0"?><testsuites><testsuite name="" tests="2" assertions="2" errors="0" failures="1" skipped="0" time="0.1"><testsuite name="AppTest" file="tests/AppTest.php" tests="2" assertions="2" errors="0" failures="1" skipped="0" time="0.1"><testcase name="testA" file="tests/AppTest.php" line="5" class="AppTest" classname="AppTest" assertions="1" time="0.01"/><testcase name="testB" file="tests/AppTest.php" line="9" class="AppTest" classname="AppTest" assertions="1" time="0.01"><failure type="x">boom</failure></testcase></testsuite></testsuite></testsuites>',
    bun: '<?xml version="1.0" encoding="UTF-8"?><testsuites name="bun test" tests="2" assertions="2" failures="1" skipped="0" time="0.1"><testsuite name="a.test.ts" file="a.test.ts" tests="2" assertions="2" failures="1" skipped="0" time="0.1" hostname="h"><testcase name="one" classname="" time="0.01" file="a.test.ts" assertions="1"/><testcase name="two" classname="" time="0.01" file="a.test.ts" assertions="1"><failure type="AssertionError"/></testcase></testsuite></testsuites>',
    deno: '<?xml version="1.0" encoding="UTF-8"?><testsuites name="deno test" tests="2" failures="1" errors="0" time="0.1"><testsuite name="./a_test.ts" tests="2" disabled="0" errors="0" failures="1"><testcase name="one" classname="./a_test.ts" time="0.01" line="1" col="1"/><testcase name="two" classname="./a_test.ts" time="0.01" line="2" col="1"><failure message="boom">boom</failure></testcase></testsuite></testsuites>'
  };
  for (const [runner, xml] of Object.entries(reports)) {
    const root = await makeRepository(t, { 'r.xml': xml });
    const parsed = await parseTestResult(root, { id: runner, kind: 'test', argv: [runner], workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'junit-xml', path: 'r.xml', minimumDiscovered: 1 } }, { startedAt: '2000-01-01T00:00:00.000Z' });
    assert.deepEqual([parsed.tests.discovered, parsed.tests.passed, parsed.tests.failed], [2, 1, 1], runner);
  }
});

// A stand-in for a runner not installed here: it writes the JUnit report its documented flag names.
const STAND_IN = (flag) => `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const given = process.argv.find((word) => word.startsWith('${flag}='));
const report = given ? given.split('=')[1] : process.argv[process.argv.indexOf('${flag}') + 1];
fs.mkdirSync(path.dirname(report), { recursive: true });
fs.writeFileSync(report, '<testsuites><testsuite name="s" tests="1" failures="0" errors="0"><testcase classname="s" name="value"/></testsuite></testsuites>');
`;

/** A quick-fix Story of the given files, walked through its code step's publication and submission. */
async function storyThroughGates(t, { files, source, testFile, sourceText, testText, executable = [], pathFolder = null }) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-runner-story-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Runner Tester', SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Runner Tester', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'runner.tester@example.invalid' };
  delete env.NODE_TEST_CONTEXT;
  if (pathFolder) env.PATH = `${pathFolder}${path.delimiter}${env.PATH}`;
  const must = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(240_000) });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  must('git', ['init', '-q', '-b', 'main', root], base);
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  for (const relative of executable) await chmod(path.join(root, relative), 0o755);
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'A repository of this runner']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), ['# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '', '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|', `| \`QF-1:AC-001\` | \`${source}\` | \`${testFile}\` | modified | The test reads 2. |`, '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('resume', 'QF-1');
  sflow('phase', 'begin', 'implement', '--json');
  await writeFile(path.join(root, source), sourceText);
  await writeFile(path.join(root, testFile), testText);
  sflow('prepare', 'implement');
  sflow('phase', 'publish', 'implement');
  sflow('submit', 'implement');
  return JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
}

test('a Story runs through its gates under the PHPUnit, Deno and Bun rows, with a stand-in for each tool: pinned, reported and counted', slowLane({ timeout: 900_000 }), async (t) => {
  const installedAt = await mkdtemp(path.join(os.tmpdir(), 'sflow-runner-bin-'));
  t.after(() => rm(installedAt, { recursive: true, force: true }));
  for (const [name, flag] of [['deno', '--junit-path'], ['bun', '--reporter-outfile']]) {
    await writeFile(path.join(installedAt, name), STAND_IN(flag));
    await chmod(path.join(installedAt, name), 0o755);
  }
  const ignored = { '.gitignore': 'vendor/\n.sflow/results/\n', '.gitattributes': '* text=auto eol=lf\n' };
  const walked = (story, id, adapter) => {
    const pin = story.testCommandPins.find((entry) => entry.commandId === id);
    assert.ok(pin, JSON.stringify(story.testCommandPins?.map((entry) => entry.commandId)));
    assert.equal(pin.adapter, adapter);
    return pin;
  };
  const php = await storyThroughGates(t, { executable: ['vendor/bin/phpunit'],
    files: { ...ignored, 'composer.json': JSON.stringify({ 'require-dev': { 'phpunit/phpunit': '^11' } }), 'phpunit.xml': '<phpunit/>', 'src/Value.php': '<?php\nfunction value() { return 1; }\n', 'tests/ValueTest.php': '<?php\n// a test\n', 'vendor/bin/phpunit': STAND_IN('--log-junit') },
    source: 'src/Value.php', testFile: 'tests/ValueTest.php',
    sourceText: '<?php\n// @clause:QF-1:AC-001 the exported value is the approved 2\nfunction value() { return 2; }\n', testText: '<?php\n// @ac:QF-1:AC-001\n// a test that reads 2\n' });
  const phpPin = walked(php, '.-php-tests', 'junit-xml');
  assert.deepEqual(phpPin.definition.map((entry) => entry.path), ['phpunit.xml'], 'the binary is a dependency, and only the configuration is bound');
  const deno = await storyThroughGates(t, { pathFolder: installedAt,
    // Deno's other name, value_test.ts, is a test to Deno and product source to SFlow's path boundary outside a test folder.
    files: { ...ignored, 'deno.json': '{ "tasks": { "test": "deno test --allow-read" } }', 'src/value.ts': 'export const value = 1;\n', 'src/value.test.ts': '// a test\n' },
    source: 'src/value.ts', testFile: 'src/value.test.ts',
    sourceText: '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n', testText: '// @ac:QF-1:AC-001\nDeno.test("value", () => {});\n' });
  assert.deepEqual(walked(deno, '.-deno-tests', 'junit-xml').argv, ['deno', 'task', 'test', '--junit-path=.sflow/results/deno-tests.xml']);
  const bun = await storyThroughGates(t, { pathFolder: installedAt,
    files: { ...ignored, 'package.json': JSON.stringify({ private: true, name: 'x', scripts: { test: 'bun test' } }), 'bun.lock': '', 'src/value.ts': 'export const value = 1;\n', 'src/value.test.ts': '// a test\n' },
    source: 'src/value.ts', testFile: 'src/value.test.ts',
    sourceText: '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n', testText: '// @ac:QF-1:AC-001\nimport { test } from "bun:test";\ntest("value", () => {});\n' });
  assert.deepEqual(walked(bun, '.-node-tests', 'junit-xml').argv, ['bun', 'run', 'test', '--', '--reporter=junit', '--reporter-outfile=.sflow/results/node-tests.xml']);
});
