/**
 * Coverage truth `[TCE:REQ-050]`: a test command counts only for the code it actually tests.
 *
 * A changed path walked up to the nearest build file SFlow could run, so a Python folder with only
 * requirements.txt, or an Xcode project, under a root package.json was "covered" by the root's
 * `npm test`; any `.py` file below an inferred Node command was covered by it too, and mocha tests
 * were run by the `node --test` fallback. These run the real CLI on fixture repositories.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  configuredTestModuleOverrides, resolveAffectedModule, TEST_SETUP_COMMAND, testCommandCoversPath
} from '../src/code-delivery-tests.mjs';
import { resolveDeliveryQualityCommands, testCommandProvenance, uncoveredTestDeliveryPaths } from '../src/delivery-evidence.mjs';
import { normalizeTrpDeliveryCommands } from '../src/trp-delivery-selection.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin/singularity-flow.mjs');
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Coverage Tester',
  SINGULARITY_FLOW_AGENT_OUTPUT: 'full' };
delete ENV.NODE_TEST_CONTEXT;

async function repository(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-tce-coverage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
  return root;
}

const NODE_PACKAGE = JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test test/value.test.mjs' } });
const codePhase = (deliveryEvidence, qualityCommands = []) => ({ id: 'implement', generationPolicy: { task: 'code' }, qualityCommands, deliveryEvidence });
/** The commands publication would run for these paths, with the provenance it judges coverage by. */
async function gateCommands(root, phase) {
  return (await resolveDeliveryQualityCommands(root, phase)).map((command) => ({ ...command, provenance: testCommandProvenance(phase, command) }));
}

test('a foreign build file stops the walk to the module: Python infers pytest, Xcode, CMake and conda refuse', async (t) => {
  const root = await repository(t, {
    'package.json': NODE_PACKAGE, 'src/value.mjs': 'export const value = 1;\n',
    'services/api/requirements.txt': 'flask\n', 'services/api/app.py': 'VALUE = 1\n',
    'services/worker/setup.cfg': '[metadata]\n', 'services/worker/job.py': '',
    'ios/App.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n', 'ios/App/AppDelegate.swift': 'import UIKit\n',
    'native/CMakeLists.txt': 'project(native)\n', 'native/codec.cpp': '',
    'science/environment.yml': 'name: science\ndependencies:\n  - numpy\n', 'science/model.py': '',
    'config/environment.yml': 'stage: production\n', 'config/settings.json': '{}\n',
    'Pipfile': '[packages]\n', 'tool.py': '',
    'addon/package.json': NODE_PACKAGE, 'addon/CMakeLists.txt': 'project(addon)\n', 'addon/src/binding.cc': ''
  });
  assert.deepEqual(await resolveAffectedModule(root, 'services/api/app.py'),
    { root: 'services/api', system: 'python', manifest: 'requirements.txt', configured: false });
  assert.equal((await resolveAffectedModule(root, 'services/worker/job.py')).root, 'services/worker');
  for (const [changed, manifest] of [['ios/App/AppDelegate.swift', 'ios/App.xcodeproj'], ['native/codec.cpp', 'native/CMakeLists.txt'],
    ['science/model.py', 'science/environment.yml']]) {
    await assert.rejects(resolveAffectedModule(root, changed), (error) => {
      assert.equal(error.code, 'TEST_MODULE_UNCOVERED', changed);
      assert.equal(error.details.manifest, manifest);
      assert.deepEqual(error.details.nextAction, { command: TEST_SETUP_COMMAND });
      return true;
    });
  }
  // Beside the root package.json a Pipfile owns only Python files; an environment.yml that declares no
  // dependencies is not a conda build.
  assert.equal((await resolveAffectedModule(root, 'tool.py')).system, 'python');
  assert.equal((await resolveAffectedModule(root, 'src/value.mjs')).system, 'node');
  assert.equal((await resolveAffectedModule(root, 'config/settings.json')).system, 'node');
  // A native build beside a package is that package's to build and test (cmake-js, scikit-build).
  assert.deepEqual(await resolveAffectedModule(root, 'addon/src/binding.cc'),
    { root: 'addon', system: 'node', manifest: 'package.json', configured: false });
  // An approved command for the Xcode project covers it, as it does for any native build.
  const xcode = { id: 'ios-tests', kind: 'test', argv: ['xcodebuild', 'test'], workingDirectory: 'ios', affectedRoots: ['ios'],
    modelPolicy: 'never', result: { adapter: 'junit-xml', path: 'build/reports', minimumDiscovered: 1 } };
  assert.equal((await resolveAffectedModule(root, 'ios/App/AppDelegate.swift', { overrides: configuredTestModuleOverrides([xcode]) })).configured, true);

  const delivery = { sourcePaths: ['services/api/app.py', 'src/value.mjs'], configurationPaths: [], testPaths: [] };
  const commands = await gateCommands(root, codePhase(delivery));
  assert.deepEqual(commands.map((command) => [command.id, command.affectedRoots]),
    [['services/api-python-tests', ['services/api']], ['.-node-tests', ['.']]]);
  assert.deepEqual(uncoveredTestDeliveryPaths(delivery, 'unrestricted', commands), []);
});

test('an inferred command covers only its own ecosystem; a configured one keeps the roots a person gave it', async (t) => {
  const root = await repository(t, {
    'package.json': NODE_PACKAGE, 'src/value.mjs': '', 'src/styles.css': '', 'src/messages.json': '{}\n', 'tools/generate.py': '',
    'services/api/pom.xml': '<project/>\n', 'services/api/src/main/java/App.java': '', 'services/api/src/main/resources/app.js': ''
  });
  const delivery = { sourcePaths: ['services/api/src/main/java/App.java', 'services/api/src/main/resources/app.js',
    'src/messages.json', 'src/styles.css', 'src/value.mjs', 'tools/generate.py'], configurationPaths: [], testPaths: [] };
  const inferred = await gateCommands(root, codePhase(delivery));
  assert.deepEqual(inferred.map((command) => command.id).sort(), ['.-node-tests', 'services/api-maven-tests']);
  assert.deepEqual(uncoveredTestDeliveryPaths(delivery, 'unrestricted', inferred), ['tools/generate.py'], 'npm test is not evidence for Python');
  const maven = { sourcePaths: ['services/api/src/main/java/App.java', 'services/api/src/main/resources/app.js'], configurationPaths: [], testPaths: [] };
  assert.deepEqual(uncoveredTestDeliveryPaths(maven, 'unrestricted', await gateCommands(root, codePhase(maven))),
    ['services/api/src/main/resources/app.js'], 'nor Maven for JavaScript');
  // The whole-repository suite publication adds in its broad scope covers only Node files too [TCE:REQ-053].
  const broad = (await resolveDeliveryQualityCommands(root, codePhase(delivery), { executionMode: 'all-configured' }))
    .filter((command) => command.affectedRoots.includes('.')).map((command) => ({ ...command, provenance: 'inferred' }));
  assert.equal(broad.some((command) => testCommandCoversPath(command, 'tools/generate.py')), false);
  assert.equal(broad.some((command) => testCommandCoversPath(command, 'src/value.mjs')), true);
  // The same command, configured or accepted for the Story, keeps its roots.
  const node = inferred.find((command) => command.id === '.-node-tests');
  for (const provenance of ['configured', 'story-decision']) {
    assert.equal(testCommandCoversPath({ ...node, provenance }, 'tools/generate.py'), true, provenance);
  }
  const configured = { ...node, id: 'approved-tests' };
  assert.deepEqual(uncoveredTestDeliveryPaths(delivery, 'unrestricted', await gateCommands(root, codePhase(delivery, [configured]))), []);
  // Test recovery's own command list keeps a Story-only command's provenance too.
  const accepted = { ...node, id: 'story-tests', storyDecision: { id: 'TCD-001', sha256: `sha256:${'0'.repeat(64)}` } };
  const [trp] = normalizeTrpDeliveryCommands({ resolution: {} }, codePhase(delivery), [accepted]);
  assert.equal(trp.provenance, 'story-decision');
  assert.equal(testCommandCoversPath(trp, 'tools/generate.py'), true);
});

test('the node --test fallback runs only node:test files; mocha, jasmine and tap tests are refused', async (t) => {
  const root = await repository(t, {
    'lib/value.js': 'module.exports = 1;\n', 'lib/value.mjs': 'export default 1;\n',
    'test/value.test.js': "const assert = require('assert');\ndescribe('value', () => it('is one', () => assert.equal(require('../lib/value'), 1)));\n",
    'test/native.test.mjs': "import test from 'node:test';\ntest('value', () => {});\n",
    'test/required.test.cjs': "const { test } = require('node:test');\ntest('value', () => {});\n"
  });
  const phase = (testPaths) => codePhase({ sourcePaths: ['lib/value.mjs'], configurationPaths: [], testPaths });
  assert.deepEqual((await resolveDeliveryQualityCommands(root, phase(['test/native.test.mjs', 'test/required.test.cjs'])))
    .map((command) => command.argv), [['node', '--test', 'test/native.test.mjs', 'test/required.test.cjs']]);
  await assert.rejects(resolveDeliveryQualityCommands(root, phase(['test/native.test.mjs', 'test/value.test.js'])), (error) => {
    assert.equal(error.code, 'TEST_MODULE_UNCOVERED');
    assert.deepEqual(error.details.paths, ['test/value.test.js']);
    assert.match(error.message, /do not import node:test/u);
    assert.deepEqual(error.details.nextAction, { command: TEST_SETUP_COMMAND });
    return true;
  });
  // A planned test not written yet does not decide.
  assert.equal((await resolveDeliveryQualityCommands(root, phase(['test/planned.test.mjs'])))[0].argv[1], '--test');
});

function cliIn(root, env = ENV) {
  const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8', env, timeout: childTimeout(180_000) });
  const must = (command, args) => {
    const result = run(command, args);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  return { run, must, sflow: (...args) => must(process.execPath, [CLI, '--no-model', ...args]) };
}

test('capability test-setup suggests a module the gate would count, never a root command for another language', async (t) => {
  const root = await repository(t, {
    'package.json': JSON.stringify({ private: true, scripts: { test: 'jest' } }), 'src/value.ts': '',
    'services/api/requirements.txt': 'flask\n', 'services/api/app.py': '', 'scripts/python/generate.py': '',
    'ios/App.xcodeproj/project.pbxproj': '', 'ios/App/AppDelegate.swift': ''
  });
  const { must, sflow } = cliIn(root);
  must('git', ['init', '-q']);
  const inspect = (directory) => JSON.parse(sflow('capability', 'test-setup', '--source-root', directory, '--json').stdout);
  const api = inspect('services/api');
  assert.deepEqual(api.suggestions.map((entry) => [entry.id, entry.workingDirectory, entry.affectedRoots]),
    [['services/api-python-tests', 'services/api', ['services/api']]]);
  const scripts = inspect('scripts/python');
  assert.deepEqual(scripts.suggestions, [], 'the root jest command does not test a Python folder');
  assert.equal(scripts.diagnostics[0].code, 'TEST_MODULE_UNCOVERED');
  assert.match(scripts.diagnostics[0].message, /scripts\/python holds python source, which \.-node-tests \(inferred for \.\) does not cover/u);
  assert.equal(inspect('ios').diagnostics[0].code, 'TEST_MODULE_UNCOVERED');
  assert.deepEqual(inspect('src').suggestions.map((entry) => entry.id), ['.-node-tests'], 'a TypeScript folder still borrows the root jest');
});

/**
 * A classic-delivery Story whose intake plans `expected` paths and `tests` for one criterion, opened at
 * its implementation step. `files` is the repository at main; `readiness: false` skips the intake
 * readiness run, which already blocks on an Xcode project's test target or a runner it cannot infer.
 */
async function implementationStory(t, W, { files, expected, tests, readiness = true }) {
  const AC = `${W}:AC-001`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-tce-story-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const { run, must, sflow } = cliIn(root);
  const write = async (relative, contents, mode) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
    if (mode) await chmod(path.join(root, relative), mode);
  };
  must('git', ['init', '-q', '-b', 'main']);
  must('git', ['config', 'user.name', 'Coverage Tester']);
  must('git', ['config', 'user.email', 'coverage@example.test']);
  for (const [relative, contents] of Object.entries(files)) await write(relative, ...[contents].flat());
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']);
  must('git', ['commit', '-qm', 'Initialize the coverage fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  must('git', ['remote', 'add', 'origin', remote]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  if (readiness) {
    const plan = JSON.parse(sflow('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
    sflow('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', plan.planId, '--json');
  }
  sflow('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return 2.');
  const item = path.join(root, 'singularity/work-items', W);
  sflow('prepare', 'intake');
  const list = (paths) => paths.map((entry) => `\`${entry}\``).join(', ');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [`# ${W} — intake`, '', '## Request and outcome', '',
    'Return the approved value 2 from every module that holds it.', '', '## Scope and constraints', '',
    'Change only the value modules and their tests.', '', '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${AC}] | Every module's value equals 2. |`, '', '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|', `| \`${AC}\` | ${list(expected)} | ${list(tests)} | modified |`, '',
    '## Initial evidence', '', 'The baseline modules and tests at the pinned main revision.', ''].join('\n'));
  sflow('wm', 'compose', '--phase', 'intake');
  sflow('clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.');
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('prepare', 'implementation');
  const summary = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(summary, (await readFile(summary, 'utf8')).replace(/TODO:[^\n]*/gu, 'Every value module returns the approved value.'));
  const json = (...args) => {
    const result = run(process.execPath, [CLI, '--no-model', ...args, '--json']);
    return { status: result.status, body: JSON.parse(result.stdout), text: result.stdout + result.stderr };
  };
  return {
    root, AC, write, must, json,
    publish: () => json('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place'),
    planned: () => { const { body } = json('recover', W, '--phase', 'implementation'); return body.testExecution ?? body.data?.testExecution; }
  };
}

const nodeTest = (AC, expected) => ["import test from 'node:test';", "import assert from 'node:assert/strict';",
  "import { value } from '../src/value.mjs';", ...(AC ? [`// @ac:${AC}`] : []), `test('value', () => assert.equal(value, ${expected}));`, ''].join('\n');
// A project interpreter that records one passing pytest case wherever --junitxml points.
const FAKE_PYTHON = ['#!/bin/sh', 'for argument in "$@"; do case "$argument" in --junitxml=*) report="${argument#--junitxml=}";; esac; done',
  'mkdir -p "$(dirname "$report")"', 'printf \'<testsuites><testsuite name="pytest" tests="1" failures="0" errors="0" skipped="0">'
  + '<testcase classname="tests.test_app" name="test_value" file="tests/test_app.py"/></testsuite></testsuites>\\n\' > "$report"', ''].join('\n');

test('a polyglot Story runs pytest for its requirements-only Python service and refuses a Python file npm test cannot cover',
  { ...slowLane({ timeout: 300_000 }), skip: process.platform === 'win32' ? 'POSIX project interpreter fixture' : slowLane().skip }, async (t) => {
    const story = await implementationStory(t, 'TCE-1', {
      files: {
        '.gitignore': '.venv/\n', 'package.json': NODE_PACKAGE, 'src/value.mjs': 'export const value = 1;\n', 'test/value.test.mjs': nodeTest(null, 1),
        'services/api/requirements.txt': 'pytest\n', 'services/api/app.py': 'VALUE = 1\n',
        'services/api/tests/test_app.py': 'from app import VALUE\n\ndef test_value():\n    assert VALUE == 1\n',
        'services/api/.venv/pyvenv.cfg': 'home = /usr/bin\nversion = 3.12.0\n', 'services/api/.venv/bin/python3': [FAKE_PYTHON, 0o755],
        'tools/generate.py': 'VALUE = 1\n'
      },
      expected: ['src/value.mjs', 'services/api/app.py', 'tools/generate.py'],
      tests: ['test/value.test.mjs', 'services/api/tests/test_app.py']
    });
    // Before any code is written, the planned paths already show the file no inferred command covers.
    const early = story.planned();
    assert.deepEqual({ ...early?.planned, commands: early?.planned?.commands.sort() },
      { runner: 'missing', commands: ['.-node-tests', 'services/api-python-tests'], uncovered: ['tools/generate.py'] }, JSON.stringify(early));
    assert.equal(early.reason, 'TEST_MODULE_UNCOVERED');
    const { AC } = story;
    await story.write('src/value.mjs', `// @clause:${AC} returns the approved value\nexport const value = 2;\n`);
    await story.write('test/value.test.mjs', nodeTest(AC, 2));
    await story.write('services/api/app.py', `# @clause:${AC} returns the approved value\nVALUE = 2\n`);
    await story.write('services/api/tests/test_app.py', `from app import VALUE\n\n# @ac:${AC}\ndef test_value():\n    assert VALUE == 2\n`);
    await story.write('tools/generate.py', `# @clause:${AC} generates the approved value\nVALUE = 2\n`);

    // A loose Python file below the root package.json: npm test is not evidence for it [TCE:REQ-052].
    const refused = story.publish();
    assert.notEqual(refused.status, 0, refused.text);
    assert.equal(refused.body.error.code, 'TEST_MODULE_UNCOVERED', refused.text);
    assert.match(refused.body.error.message, /No passing test command covers affected paths before publication: tools\/generate\.py\./u);
    // The pytest run for the requirements-only service is what covers its file [TCE:REQ-051].
    const executions = story.json('phase', 'prepublish', 'implementation').body.testExecution.commands.map((entry) => entry.id).sort();
    assert.deepEqual(executions, ['.-node-tests', 'services/api-python-tests']);
    // Recovery names the same path before another attempt.
    const recovery = story.json('recover', 'TCE-1', '--phase', 'implementation').body;
    const blocker = (recovery.blockers ?? recovery.data?.blockers ?? []).find((entry) => entry.details?.sourceCode === 'TEST_MODULE_UNCOVERED');
    assert.deepEqual(blocker?.details?.paths, ['tools/generate.py'], JSON.stringify(recovery.blockers ?? recovery.data?.blockers));

    // Without it, publication runs both suites, and the service's file is covered by pytest.
    story.must('git', ['checkout', '--', 'tools/generate.py']);
    const published = story.publish();
    assert.equal(published.status, 0, published.text);
    const attempts = path.join(story.root, 'singularity/work-items/TCE-1/context/code-delivery/tests/attempts/implementation');
    const passed = new Set();
    for (const name of await readdir(attempts)) {
      const attempt = JSON.parse(await readFile(path.join(attempts, name), 'utf8'));
      if (attempt.status === 'passed') passed.add(`${attempt.commandId} covers ${attempt.affectedRoots.join(', ')}`);
    }
    assert.deepEqual([...passed].sort(), ['.-node-tests covers .', 'services/api-python-tests covers services/api']);
    // Submission binds each criterion's test to the command that ran its module.
    story.must(process.execPath, [CLI, '--no-model', 'submit', 'implementation']);
    const receipt = JSON.parse(await readFile(path.join(story.root, 'singularity/work-items/TCE-1/context/code-delivery/implementation-gen1.json'), 'utf8'));
    assert.deepEqual(receipt.traceability.bindings.map((binding) => [binding.testSource, binding.commandId, binding.moduleRoot]).sort(), [
      ['services/api/tests/test_app.py', 'services/api-python-tests', 'services/api'], ['test/value.test.mjs', '.-node-tests', '.']]);
  });

test('an Xcode project under a root package.json is refused before code is written and at publication, not covered by npm test',
  slowLane({ timeout: 300_000 }), async (t) => {
    const story = await implementationStory(t, 'TCE-2', {
      files: {
        'package.json': NODE_PACKAGE, 'src/value.mjs': 'export const value = 1;\n', 'test/value.test.mjs': nodeTest(null, 1),
        'ios/App.xcodeproj/project.pbxproj': '// !$*UTF8*$!\n', 'ios/App/Value.swift': 'let value = 1\n'
      },
      expected: ['src/value.mjs', 'ios/App/Value.swift'], tests: ['test/value.test.mjs'], readiness: false
    });
    // The planned paths already show what publication will refuse [TCE:REQ-051].
    const early = story.planned();
    assert.equal(early?.planned?.runner, 'missing', JSON.stringify(early));
    assert.equal(early.reason, 'TEST_MODULE_UNCOVERED');
    const { AC } = story;
    await story.write('src/value.mjs', `// @clause:${AC} returns the approved value\nexport const value = 2;\n`);
    await story.write('test/value.test.mjs', nodeTest(AC, 2));
    await story.write('ios/App/Value.swift', `// @clause:${AC} returns the approved value\nlet value = 2\n`);
    const refused = story.publish();
    assert.notEqual(refused.status, 0, refused.text);
    assert.equal(refused.body.error.code, 'TEST_MODULE_UNCOVERED', refused.text);
    assert.match(refused.body.error.message,
      /'ios\/App\/Value\.swift' belongs to ios\/App\.xcodeproj, an Xcode project, whose tests need a scheme and a destination/u);
    assert.equal(refused.body.remediationPlan.steps[0].command, TEST_SETUP_COMMAND);
  });

test('mocha tests with no runner script are refused instead of being run by the node --test fallback', slowLane({ timeout: 300_000 }), async (t) => {
  const mocha = (AC, expected) => ["const assert = require('assert');", "const { value } = require('../lib/value.js');", '',
    "describe('value', () => {", ...(AC ? [`  // @ac:${AC}`] : []), `  it('is approved', () => assert.equal(value, ${expected}));`, '});', ''].join('\n');
  const story = await implementationStory(t, 'TCE-3', {
    files: {
      // A package script running mocha now infers mocha itself (test/tce-ecosystems.test.mjs); without one,
      // only the node --test fallback is left, and it refuses a file that does not import node:test.
      'package.json': JSON.stringify({ private: true }),
      'lib/value.js': 'exports.value = 1;\n', 'test/value.test.js': mocha(null, 1)
    },
    expected: ['lib/value.js'], tests: ['test/value.test.js'], readiness: false
  });
  const { AC } = story;
  await story.write('lib/value.js', `// @clause:${AC} returns the approved value\nexports.value = 2;\n`);
  await story.write('test/value.test.js', mocha(AC, 2));
  const refused = story.publish();
  assert.notEqual(refused.status, 0, refused.text);
  assert.equal(refused.body.error.code, 'TEST_MODULE_UNCOVERED', refused.text);
  assert.match(refused.body.error.message, /^Test files test\/value\.test\.js do not import node:test/u);
  assert.equal(refused.body.remediationPlan.steps[0].command, TEST_SETUP_COMMAND);
  assert.doesNotMatch(refused.text, /node --test test\/value\.test\.js/u, 'the mocha file never ran under node --test');
});
