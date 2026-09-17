import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { phaseRequiresCodeDelivery } from '../src/code-delivery-policy.mjs';
import { installWorkflow, simulateWorkflow, workflowCatalog } from '../src/workflow-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const PHASES = ['intake', 'implementation', 'testing', 'conformance'];

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Classic Delivery Tester' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

test('Classic delivery pins four named checkpoints and an approved test-path contract', async () => {
  const definition = validateDefinition(YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8')));
  const resolved = resolveWorkType(definition, 'classic-delivery');
  assert.deepEqual(resolved.phases.map((phase) => phase.id), PHASES);
  assert.deepEqual(resolved.phases.map((phase) => phase.label), ['Intake', 'Code', 'Testing', 'Code checking']);
  assert.match(definition.workTypes['classic-delivery'].description,
    /feedback\/rework to Code; REV feedback attachments are evidence only/u);
  assert.equal(definition.workTypes['classic-delivery'].revision, undefined,
    'Classic Delivery must not advertise an executable REV pilot');
  assert.deepEqual(resolved.plannedClaims, {
    mode: 'required', clausePhases: ['intake'], owners: { implementation: 'intake' }, reason: null
  });
  assert.equal(resolved.phases[0].artifact.kind, 'requirements');
  assert.equal(phaseRequiresCodeDelivery(resolved.phases[1]), true);
  assert.deepEqual(resolved.phases.slice(2).map((phase) => phase.testEvidenceFrom), [
    'implementation', 'implementation'
  ]);
  assert.ok(resolved.phases.slice(2).every((phase) => phase.writeScope === 'artifact-only'));
  for (const phase of resolved.phases.slice(2)) {
    assert.ok(phase.inputs.some((input) => input.phase === 'implementation'));
    assert.ok(phase.approval.rejectTo.includes('implementation'),
      'reviewers need a governed route back to Code for repairs');
  }
});

test('Classic delivery cannot be weakened by an invalid test-evidence source', async () => {
  const starter = YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
  const invalid = structuredClone(starter);
  invalid.workTypes['classic-delivery'].phaseOverrides.testing.testEvidenceFrom = 'intake';
  assert.throws(() => validateDefinition(invalid), /testEvidenceFrom must name an earlier code-delivery phase/);
  invalid.workTypes['classic-delivery'].phaseOverrides.testing.testEvidenceFrom = 'implementation';
  invalid.workTypes['classic-delivery'].phaseOverrides.testing.writeScope = 'source-and-artifact';
  assert.throws(() => validateDefinition(invalid), /must be artifact-only, non-code/);
});

test('Classic delivery is installed with its templates, agents, and UI phase labels', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-classic-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  const installed = await loadDefinition(root);
  const resolved = resolveWorkType(installed, 'classic-delivery');
  assert.deepEqual(resolved.phases.map((phase) => phase.defaultAgent), [
    'product-owner', 'developer', 'qa', 'qa'
  ]);
  assert.deepEqual((await simulateWorkflow(root, 'classic-delivery'))[0].phases.map((phase) => phase.label), [
    'Intake', 'Code', 'Testing', 'Code checking'
  ]);
  assert.equal((await workflowCatalog(root)).find((item) => item.id === 'classic-delivery').status, 'current');
  for (const file of ['intake.md', 'testing.md', 'code-checking.md']) {
    assert.match(await readFile(path.join(root, 'singularity/templates/classic-delivery', file), 'utf8'),
      /{{work.id}}/);
  }
  for (const file of ['testing.md', 'code-checking.md']) {
    const source = await readFile(path.join(root, 'singularity/templates/classic-delivery', file), 'utf8');
    assert.match(source, /## Feedback and rework decision/u);
    assert.match(source, /(?:does not revise code|do not\s+open a revision interval)/u);
  }

  const old = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  delete old.workTypes['classic-delivery'];
  await writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify(old));
  const result = await installWorkflow(root, 'classic-delivery');
  assert.ok(result.files.includes('singularity/templates/classic-delivery/intake.md') === false,
    'workflow install should preserve an existing local template rather than overwrite it');
  assert.deepEqual(resolveWorkType(await loadDefinition(root), 'classic-delivery').phases.map((phase) => phase.id), PHASES);
});

test('Classic delivery commits passing test results before Testing and Code checking', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-classic-story-'));
  const remote = `${root}.git`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  const workId = 'CLASSIC-1';
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Classic Delivery Tester'], root);
  run('git', ['config', 'user.email', 'classic@example.test'], root);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    type: 'module', private: true, scripts: { test: 'node --test' }
  }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';",
    "test('value', () => assert.equal(value, 1));", ''
  ].join('\n'));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize Classic delivery fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const base = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  cli('start', workId, '--from-branch', 'main', '--work-type', 'classic-delivery',
    '--title', 'Change the value', '--description', 'Prove committed executable-test evidence.');
  const item = path.join(root, 'singularity/work-items', workId);
  const workflow = () => readFile(path.join(item, 'workflow.json'), 'utf8').then(JSON.parse);
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${workId} — Classic delivery intake`, '',
    '## Request and outcome', '',
    'Return the approved new value 2 to every caller; retain the exported API.', '',
    '## Scope and constraints', '',
    'Change only the value module and its executable unit test. Preserve the module interface.', '',
    '## Acceptance criteria', '',
    `| Clause | Observable outcome |`, '|---|---|',
    `| [${workId}:AC-001] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${workId}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Initial evidence', '', 'The baseline module and executable test at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is the new value 2 the approved outcome?',
    '--answer', 'Yes; keep the exported interface and add the matching unit test.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');

  cli('prepare', 'implementation');
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 2;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), [
    `// @ac:${workId}:AC-001`,
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';",
    "test('value', () => assert.equal(value, 2));", ''
  ].join('\n'));
  const codeArtifact = path.join(item, 'artifacts/implementation/implementation-summary.md');
  const codeText = await readFile(codeArtifact, 'utf8');
  await writeFile(codeArtifact, codeText.replace(/TODO:[^\n]*/gu,
    'The value module and acceptance-tagged unit test now prove the approved value 2.'));
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  cli('approve', 'implementation', '--yes');
  const code = (await workflow()).phases.implementation;
  assert.equal(code.status, 'approved');
  assert.equal(code.deliveryEvidence.validation.status, 'passed');
  assert.ok(code.deliveryEvidence.testExecutions.length > 0);
  assert.ok(code.deliveryEvidence.testExecutions.every((entry) => entry.status === 'passed'));
  const receiptPath = code.deliveryEvidence.receiptPath;
  const receipt = JSON.parse(run('git', ['show', `HEAD:${receiptPath}`], root).stdout);
  assert.equal(receipt.status, 'ready');
  for (const entry of code.deliveryEvidence.testExecutions) {
    const testReceipt = JSON.parse(run('git', ['show', `HEAD:${entry.receiptPath}`], root).stdout);
    assert.ok(testReceipt.tests.discovered >= 1);
    assert.ok(testReceipt.tests.passed >= 1);
    assert.equal(testReceipt.status, 'passed');
  }

  for (const phase of ['testing', 'conformance']) {
    cli('prepare', phase);
    const current = (await workflow()).phases[phase];
    const artifact = path.join(item, current.requiredArtifact.path);
    let text = await readFile(artifact, 'utf8');
    text = text.replace(/TODO:[^\n]*/gu,
      `Verified ${workId}:AC-001 against ${receiptPath} and the committed passing unit-test receipt.`);
    text = text.replace(/\bTODO\b/gu, 'matched');
    await writeFile(artifact, text);
    if (phase === 'testing') {
      await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 3;\n');
      const refused = run(process.execPath, [CLI, '--no-model', 'phase', 'publish', phase,
        '--authored', 'human', '--channel', 'manual-in-place', '--json'], root, { allowFailure: true });
      assert.notEqual(refused.status, 0);
      assert.match(refused.stdout + refused.stderr, /PRIOR_CODE_TEST_EVIDENCE_REQUIRED|application source or tests changed after the approved execution/u);
      await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 2;\n');
    }
    cli('phase', 'publish', phase, '--authored', 'human', '--channel', 'manual-in-place');
    cli('submit', phase);
    cli('approve', phase, '--yes');
  }
  const finished = await workflow();
  assert.equal(finished.currentPhase, null);
  assert.equal(finished.phases.conformance.status, 'approved');
  assert.equal(run('git', ['rev-parse', 'refs/remotes/origin/CLASSIC-1'], root).stdout.trim(),
    run('git', ['rev-parse', 'HEAD'], root).stdout.trim());
  assert.equal(run('git', ['rev-parse', 'refs/remotes/origin/main'], root).stdout.trim(), base);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '');
});
