/** Fixtures shared by the run-and-test suites: an initialized repository and a quick-fix Story. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const cli = fileURLToPath(new URL('../../bin/singularity-flow.mjs', import.meta.url));

export function environment(base) {
  return { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Run Test Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Run Test Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'run.test@example.invalid' };
}

const JUNIT_WRITER = `import { mkdirSync, writeFileSync } from 'node:fs';
const count = Number(process.argv[2] ?? 2);
mkdirSync('.sflow/results', { recursive: true });
const cases = count === 2
  ? '<testcase classname="tests.test_pay" name="test_refund" file="tests/test_pay.py" line="4" time="0.01"/>'
    + '<testcase classname="tests.test_pay" name="test_round" file="tests/test_pay.py" line="8" time="0.02"><failure message="off by one">expected 2</failure></testcase>'
  : Array.from({ length: count }, (_, index) => '<testcase classname="tests.bulk" name="case_' + index + '" time="0"/>').join('');
writeFileSync(count === 2 ? '.sflow/results/junit.xml' : '.sflow/results/bulk.xml', '<?xml version="1.0"?><testsuites><testsuite name="payments">' + cases + '</testsuite></testsuites>');
process.exit(count === 2 ? 1 : 0);
`;

const PYTHON_TESTS = `import pytest

# @ac:PAY-1:AC-002
def test_refund():
    assert True


def test_round():
    assert 1 == 2
`;

export async function repository(t, { extraCommands = [], implementCommands = true } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-tests-run-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = environment(base);
  const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 240_000 });
  const must = (command, args, cwd = root) => {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  const sflowJson = (...args) => {
    const result = run(process.execPath, [cli, '--no-model', ...args, '--json']);
    assert.ok(result.stdout.trim(), `${args.join(' ')} printed nothing\n${result.stderr}`);
    return { status: result.status, value: JSON.parse(result.stdout), stderr: result.stderr };
  };
  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'test'));
  await mkdir(path.join(root, 'tests'));
  await mkdir(path.join(root, 'tools'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from '../src/value.mjs';\n\n// @ac:QF-1:AC-001\ntest('value is one', () => assert.equal(value, 1));\n\ntest('untagged arithmetic', () => assert.equal(1 + 1, 2));\n");
  await writeFile(path.join(root, 'tools/junit.mjs'), JUNIT_WRITER);
  await writeFile(path.join(root, 'tests/test_pay.py'), PYTHON_TESTS);
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  if (implementCommands) config.phases.implement.qualityCommands = [
    { id: 'module-junit', kind: 'test', argv: ['node', 'tools/junit.mjs', '2'], workingDirectory: '.', affectedRoots: ['tests'],
      modelPolicy: 'never', result: { adapter: 'junit-xml', path: '.sflow/results/junit.xml' } },
    { id: 'karma-totals', kind: 'test', argv: ['node', '-e', 'console.log("TOTAL: 3 SUCCESS")'], workingDirectory: '.', affectedRoots: ['karma'],
      modelPolicy: 'never', result: { adapter: 'karma-text', path: '.sflow/results/karma.txt' } },
    ...extraCommands
  ];
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']);
  must('git', ['commit', '-q', '-m', 'Run and test fixture']);
  return { base, root, env, must, sflow, sflowJson, run };
}

/** A quick-fix Story at its implement step, on a branch published to a local bare remote. */
export async function startQuickFix(repo) {
  const { root, sflow, must } = repo;
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
  must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), [
    '# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('resume', 'QF-1');
}

