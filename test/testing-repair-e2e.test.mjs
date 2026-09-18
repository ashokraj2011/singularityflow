import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Testing Repair Reviewer' }
  });
  if (!allowFailure) assert.equal(result.status, 0,
    `${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('a dirty Testing review returns changed test bytes to Code and publishes new exact evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-testing-repair-'));
  const remote = `${root}.git`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  const workId = 'REPAIR-1';
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const tryCli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Testing Repair Reviewer'], root);
  run('git', ['config', 'user.email', 'testing-repair@example.test'], root);
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
  run('git', ['commit', '-m', 'Initialize repair fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);

  cli('start', workId, '--from-branch', 'main', '--work-type', 'classic-delivery',
    '--title', 'Repair a unit test during Testing', '--description', 'Keep source and refresh tests.');
  const item = path.join(root, 'singularity/work-items', workId);
  const workflow = () => readFile(path.join(item, 'workflow.json'), 'utf8').then(JSON.parse);
  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${workId} — Classic delivery intake`, '',
    '## Request and outcome', '', 'Return the approved value 2 to every caller.', '',
    '## Scope and constraints', '', 'Change the value module and its executable test only.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${workId}:AC-001] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${workId}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Initial evidence', '', 'Baseline module and executable test at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is value 2 approved?',
    '--answer', 'Yes; keep the exported interface and test it.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');

  cli('prepare', 'implementation');
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 2;\n');
  const testPath = path.join(root, 'test/value.test.mjs');
  await writeFile(testPath, [
    `// @ac:${workId}:AC-001`,
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';",
    "test('value', () => assert.equal(value, 2));", ''
  ].join('\n'));
  const summaryPath = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(summaryPath, (await readFile(summaryPath, 'utf8')).replace(/TODO:[^\n]*/gu,
    'The module and acceptance-tagged unit test prove the approved value 2.'));
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  cli('approve', 'implementation', '--yes');
  const approved = await workflow();
  const originalCodeGeneration = approved.phases.implementation.generation;
  const originalSource = await readFile(path.join(root, 'src/value.mjs'), 'utf8');
  const priorTest = await readFile(testPath, 'utf8');

  const reviewedTest = `${priorTest}// testing found an assertion fixture to correct\n`;
  await writeFile(testPath, reviewedTest);
  const preview = tryCli('reject', 'testing', '--to', 'implementation', '--repair',
    '--reason', 'Correct the unit-test fixture', '--json');
  assert.notEqual(preview.status, 0);
  const digest = `${preview.stdout}\n${preview.stderr}`.match(/sha256:[a-f0-9]{64}/u)?.[0];
  assert.ok(digest, `missing repair preview digest\n${preview.stdout}\n${preview.stderr}`);
  await writeFile(testPath, `${reviewedTest}// changed after the preview\n`);
  const stale = tryCli('reject', 'testing', '--to', 'implementation', '--repair',
    '--reason', 'Correct the unit-test fixture', '--confirm', digest, '--json');
  assert.notEqual(stale.status, 0, 'the earlier digest must not authorize new test bytes');
  assert.match(`${stale.stdout}\n${stale.stderr}`, /TESTING_REPAIR_CONFIRMATION_REQUIRED/u);
  assert.equal((await workflow()).currentPhase, 'testing');
  await writeFile(testPath, reviewedTest);
  cli('reject', 'testing', '--to', 'implementation', '--repair',
    '--reason', 'Correct the unit-test fixture', '--confirm', digest);
  const returned = await workflow();
  assert.equal(returned.currentPhase, 'implementation');
  assert.equal(returned.phases.implementation.status, 'in_progress');
  assert.equal(returned.phases.testing.status, 'not_started');
  assert.ok(returned.changeRequests.some((entry) =>
    entry.status === 'open' && entry.testingRepair?.confirmation === digest));
  assert.equal(await readFile(path.join(root, 'src/value.mjs'), 'utf8'), originalSource);
  assert.equal(await readFile(testPath, 'utf8'), reviewedTest);

  const beginRefusal = tryCli('phase', 'begin', 'implementation');
  assert.notEqual(beginRefusal.status, 0);
  const adoptionDigest = `${beginRefusal.stdout}\n${beginRefusal.stderr}`.match(/sha256:[a-f0-9]{64}/u)?.[0];
  assert.ok(adoptionDigest, `missing adoption digest\n${beginRefusal.stdout}\n${beginRefusal.stderr}`);
  cli('phase', 'begin', 'implementation', '--adopt-existing', '--confirm', adoptionDigest);
  cli('prepare', 'implementation');
  await writeFile(summaryPath, `${await readFile(summaryPath, 'utf8')}\n## Test repair\n\nCorrected the unit-test fixture without modifying approved product behavior.\n`);
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  cli('approve', 'implementation', '--yes');
  const reapproved = await workflow();
  assert.equal(reapproved.phases.implementation.generation, originalCodeGeneration + 1);
  assert.equal(reapproved.phases.implementation.deliveryEvidence.validation.status, 'passed');
  assert.equal(reapproved.phases.implementation.deliveryEvidence.testingRepair?.changeRequestId,
    returned.changeRequests.at(-1).id);
  assert.equal(await readFile(path.join(root, 'src/value.mjs'), 'utf8'), originalSource);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '');
});
