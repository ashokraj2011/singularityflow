/**
 * Repositories that are not one tidy module, through quick-fix Stories. With a tooling package.json
 * beside pom.xml every change is ambiguous: prepublish says so before publication and both route to
 * test setup, and an approved test command covering the source decides it. Repository metadata
 * (.gitignore) needs no module, while a build file no module owns is named by prepublish exactly as
 * publication refuses it. A Story with only covered source and metadata publishes, submits and
 * closes, its final replay agreeing with publication.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { childTimeout } from './helpers/child-timeout.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const TEST_SETUP = 'singularity-flow capability test-setup --json';
const APPROVED_TESTS = {
  id: 'approved-unit-tests', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['src', 'test'],
  modelPolicy: 'never', result: { adapter: 'node-tap', path: '.sflow/results/node-tests.tap', minimumDiscovered: 1 }
};

async function quickFix(t, id, { qualityCommands = null, supporting = [], module = '' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), `sflow-test-coverage-${id.toLowerCase()}-`));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Coverage Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Coverage Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'coverage@example.invalid' };
  const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000) });
  const must = (command, args, cwd = root) => {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  const refusal = (...args) => {
    const result = run(process.execPath, [cli, '--no-model', ...args, '--json']);
    assert.notEqual(result.status, 0, `${args.join(' ')} should be refused\n${result.stdout}`);
    return JSON.parse(result.stdout);
  };
  must('git', ['init', '-q', '-b', 'main', root], base);
  const at = (relative) => path.join(root, module, relative);
  await mkdir(at('src'), { recursive: true }); await mkdir(at('test')); await mkdir(path.join(root, 'tools'));
  // At the root: the real build is Maven; package.json only carries tooling and a unit runner.
  // In a module directory: the module is the only build, and the root owns no manifest.
  if (!module) await writeFile(path.join(root, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>\n');
  await writeFile(at('package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(path.join(root, 'tools/build.properties'), 'level=1\n');
  await writeFile(at('src/value.mjs'), 'export const value = 1;\n');
  await writeFile(at('test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n");
  const prefix = module ? `${module}/` : '';
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  if (qualityCommands) config.phases.implement.qualityCommands = qualityCommands;
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Coverage fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', id, '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, `singularity/work-items/${id}/artifacts/intake/intake.md`), [
    `# ${id} — Quick fix scope and plan`, '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${id}:AC-001] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    `| \`${id}:AC-001\` | \`${prefix}src/value.mjs\` | \`${prefix}test/value.test.mjs\` | modified | The test reads 2. |`, '',
    ...(supporting.length ? ['## Supporting files', '', ...supporting.map((file) => `- \`${file}\` — the change keeps repository settings in step.`), ''] : []),
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('resume', id);
  sflow('phase', 'begin', 'implement', '--json');
  await writeFile(at('src/value.mjs'), `// @clause:${id}:AC-001 the exported value is the approved 2\nexport const value = 2;\n`);
  await writeFile(at('test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + `import { value } from '../src/value.mjs';\n// @ac:${id}:AC-001\ntest('value', () => assert.equal(value, 2));\n`);
  for (const file of supporting) await writeFile(path.join(root, file), `${await readFile(path.join(root, file), 'utf8')}# ${id}\n`);
  sflow('prepare', 'implement');
  const prepublish = () => JSON.parse(run(process.execPath, [cli, '--no-model', 'phase', 'prepublish', 'implement', '--for-agent', '--json']).stdout);
  return { root, sflow, refusal, prepublish, workflowPath: path.join(root, `singularity/work-items/${id}/workflow.json`) };
}

const blockerCodes = (result) => JSON.stringify(result);
const planCommands = (envelope) => (envelope.remediationPlan?.steps ?? []).map((entry) => entry.command).filter(Boolean);

test('two build systems at the root: prepublish names the ambiguity and both route to test setup', { timeout: 300_000 }, async (t) => {
  const story = await quickFix(t, 'QF-3');
  const recovery = JSON.parse(story.sflow('recover', 'QF-3', '--phase', 'implement', '--json'));
  const plan = recovery.data?.plan ?? recovery.plan ?? recovery;
  const text = JSON.stringify(plan);
  assert.match(text, /TEST_MODULE_AMBIGUOUS/u, text.slice(0, 2000));
  assert.match(text, /resolve-code-delivery-test-configuration:implement/u);
  assert.match(text, /singularity-flow capability test-setup --json/u);
  assert.match(text, /story test-policy amend --reason TEXT/u);
  const ready = story.prepublish();
  assert.notEqual(ready.status, 'ready', blockerCodes(ready).slice(0, 2000));
  assert.match(JSON.stringify(ready), /TEST_MODULE_AMBIGUOUS/u);

  const refused = story.refusal('phase', 'publish', 'implement');
  assert.equal(refused.error.code, 'TEST_MODULE_AMBIGUOUS');
  assert.match(refused.error.message, /maps to multiple build systems at '\.': maven, node/u);
  assert.ok(planCommands(refused).includes(TEST_SETUP), JSON.stringify(refused.remediationPlan));
});

test('a build file no module owns is named by prepublish exactly as publication refuses it; metadata is not', { timeout: 300_000 }, async (t) => {
  const story = await quickFix(t, 'QF-4', { module: 'app', supporting: ['.gitignore', 'tools/build.properties'] });
  const ready = story.prepublish();
  const text = JSON.stringify(ready);
  assert.match(text, /TEST_MODULE_UNCOVERED/u, text.slice(0, 2000));
  assert.match(text, /No test command covers affected paths: tools\/build\.properties\. Publication would refuse them/u);
  // Its route is test setup, as publication's refusal names it.
  assert.match(text, /"kind":"runner-setup"/u);
  assert.match(text, /singularity-flow capability test-setup --json/u);
  assert.notEqual(ready.status, 'ready');

  const refused = story.refusal('phase', 'publish', 'implement');
  assert.equal(refused.error.code, 'TEST_MODULE_UNCOVERED');
  assert.match(refused.error.message, /No passing test command covers affected paths before publication: tools\/build\.properties\./u,
    'repository metadata is not held to module coverage; the build file is');
  assert.deepEqual(refused.error.details.paths, ['tools/build.properties']);
  assert.ok(planCommands(refused).includes(TEST_SETUP), JSON.stringify(refused.remediationPlan));
});

test('an approved test command decides the ambiguity; covered source and repository metadata publish, submit and close', { timeout: 300_000 }, async (t) => {
  const story = await quickFix(t, 'QF-5', { qualityCommands: [APPROVED_TESTS], supporting: ['.gitignore'] });
  const ready = story.prepublish();
  assert.doesNotMatch(JSON.stringify(ready), /TEST_MODULE_(?:AMBIGUOUS|UNCOVERED)/u);
  story.sflow('phase', 'publish', 'implement');
  story.sflow('submit', 'implement');
  const submitted = JSON.parse(await readFile(story.workflowPath, 'utf8'));
  assert.equal(submitted.phases.implement.deliveryEvidence.status, 'ready');
  assert.deepEqual(submitted.phases.implement.deliveryEvidence.testExecutions.map((entry) => [entry.commandId, entry.status]),
    [['approved-unit-tests', 'passed']]);
  story.sflow('prepare', 'verify');
  story.sflow('phase', 'publish', 'verify', '--authored', 'deterministic');
  story.sflow('submit', 'verify');
  const closing = JSON.parse(await readFile(story.workflowPath, 'utf8'));
  if (closing.phases.verify.status !== 'approved') story.sflow('approve', 'verify', '--yes');
  assert.equal(JSON.parse(await readFile(story.workflowPath, 'utf8')).status, 'closed');
});
