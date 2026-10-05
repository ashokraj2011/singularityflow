import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadDefinition } from '../src/config.mjs';
import { previewTestingRepair, rejectPhase } from '../src/state.mjs';
import { evaluateCodeDeliveryPreflight } from '../src/delivery-evidence.mjs';

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

for (const workType of ['classic-delivery', 'quick-fix']) test(`${workType}: dirty review returns changed test bytes to Code with fresh evidence`, async (t) => {
  const codePhase = workType === 'quick-fix' ? 'implement' : 'implementation';
  const reviewPhase = workType === 'quick-fix' ? 'verify' : 'testing';
  const authorship = workType === 'quick-fix' ? ['deterministic', 'kernel-generator'] : ['human', 'manual-in-place'];
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
  const readyPlan = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readyPlan.planId, '--json');

  cli('start', workId, '--from-branch', 'main', '--work-type', workType,
    '--title', 'Repair a unit test during Testing', '--description', 'Keep source and refresh tests.');
  const item = path.join(root, 'singularity/work-items', workId);
  const workflow = () => readFile(path.join(item, 'workflow.json'), 'utf8').then(JSON.parse);
  // Both workflows sign off their scope and plan in Intake before any code changes.
  {
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
  if (workType === 'classic-delivery') cli('clarification', 'record', 'intake', '--question', 'Is value 2 approved?',
    '--answer', 'Yes; keep the exported interface and test it.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');
  }

  cli('prepare', codePhase);
  await writeFile(path.join(root, 'src/value.mjs'), `// @clause:${workId}:AC-001 returns the approved value 2\nexport const value = 2;\n`);
  const testPath = path.join(root, 'test/value.test.mjs');
  await writeFile(testPath, [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';",
    `// @ac:${workId}:AC-001`,
    "test('value', () => assert.equal(value, 2));", ''
  ].join('\n'));
  const summaryPath = path.join(item, `artifacts/${codePhase}/implementation-summary.md`);
  if (workType === 'classic-delivery') await writeFile(summaryPath, (await readFile(summaryPath, 'utf8')).replace(/TODO:[^\n]*/gu,
    'The module and acceptance-tagged unit test prove the approved value 2.'));
  cli('phase', 'publish', codePhase, '--authored', authorship[0], '--channel', authorship[1]);
  cli('submit', codePhase);
  if (workType === 'classic-delivery') cli('approve', codePhase, '--yes');
  const approved = await workflow();
  const originalCodeGeneration = approved.phases[codePhase].generation;
  const originalSource = await readFile(path.join(root, 'src/value.mjs'), 'utf8');
  const priorTest = await readFile(testPath, 'utf8');

  const reviewedTest = `${priorTest}// testing found an assertion fixture to correct\n`;
  await writeFile(testPath, reviewedTest);
  cli('prepare', reviewPhase);
  const draft = JSON.parse(cli('phase', 'draft-check', reviewPhase, '--json').stdout);
  assert.equal(draft.status, 'correction-required');
  assert.ok(draft.findings.some((finding) => finding.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE'));
  const repairRoute = `singularity-flow reject ${reviewPhase} --to ${codePhase} --repair --reason <REASON>`;
  assert.equal(draft.commands.next, repairRoute);
  assert.equal(draft.correction.skill, null, 'the repair command maps to the skill that owns it');
  assert.equal(draft.commands.publish, null);
  const prepublish = JSON.parse(cli('phase', 'prepublish', reviewPhase, '--json').stdout);
  assert.equal(prepublish.status, 'correction-required');
  assert.equal(prepublish.commands.next, repairRoute, 'prepublish offers the same repair as draft-check');
  assert.equal(prepublish.correction.skill, null);
  for (const [wrongPhase, wrongTarget] of [[reviewPhase, reviewPhase], [codePhase, codePhase]]) {
    const wrong = tryCli('reject', wrongPhase, '--to', wrongTarget, '--repair', '--reason', 'Wrong review scope', '--json');
    assert.notEqual(wrong.status, 0);
    assert.equal((await workflow()).currentPhase, reviewPhase);
  }
  const preview = tryCli('reject', reviewPhase, '--to', codePhase, '--repair',
    '--reason', 'Correct the unit-test fixture', '--json');
  assert.notEqual(preview.status, 0);
  const digest = `${preview.stdout}\n${preview.stderr}`.match(/sha256:[a-f0-9]{64}/u)?.[0];
  assert.ok(digest, `missing repair preview digest\n${preview.stdout}\n${preview.stderr}`);
  const definition = await loadDefinition(root);
  const unauthorized = await workflow();
  for (const authority of Object.values(unauthorized.resolution.approvalAuthorities)) {
    authority.allowAnyGitIdentity = false; authority.members = []; authority.githubTeams = [];
  }
  await assert.rejects(() => rejectPhase(root, definition, unauthorized, {
    phaseId: reviewPhase, target: codePhase, reason: 'Unauthorized early return', testingRepairConfirm: digest,
    actor: { name: 'Outsider', email: 'outsider@example.test' }
  }), /not a member of: quality-reviewers/iu);
  const exhausted = await workflow();
  exhausted.phases[codePhase].repairBudget = { maxAttempts: 1, resetOnPhase: null };
  exhausted.repairBudgets[codePhase] = { phase: codePhase, maximum: 1,
    resetPhase: null, resetGeneration: 0, attempts: [{ number: 1 }] };
  const budgetPreview = await previewTestingRepair(root, definition, exhausted);
  await assert.rejects(() => rejectPhase(root, definition, exhausted, {
    phaseId: reviewPhase, target: codePhase, reason: 'Exhausted early return', testingRepairConfirm: budgetPreview.confirmation,
    actor: { name: 'Testing Repair Reviewer', email: 'testing-repair@example.test' }
  }), (error) => error.code === 'REPAIR_BUDGET_EXHAUSTED');
  assert.equal((await workflow()).currentPhase, reviewPhase);
  await writeFile(testPath, `${reviewedTest}// changed after the preview\n`);
  const stale = tryCli('reject', reviewPhase, '--to', codePhase, '--repair',
    '--reason', 'Correct the unit-test fixture', '--confirm', digest, '--json');
  assert.notEqual(stale.status, 0, 'the earlier digest must not authorize new test bytes');
  assert.match(`${stale.stdout}\n${stale.stderr}`, /TESTING_REPAIR_CONFIRMATION_REQUIRED/u);
  assert.equal((await workflow()).currentPhase, reviewPhase);
  await writeFile(testPath, reviewedTest);
  // Each preview replays the Code evidence and diffs the tree against the Code generation commit.
  // The confirmed return previews once and hands that plan to the transition.
  const trace = path.join(root, '..', `${path.basename(root)}-reject-trace.log`);
  t.after(() => rm(trace, { force: true }));
  process.env.GIT_TRACE = trace;
  try {
    cli('reject', reviewPhase, '--to', codePhase, '--repair',
      '--reason', 'Correct the unit-test fixture', '--confirm', digest);
  } finally { delete process.env.GIT_TRACE; }
  const previews = (await readFile(trace, 'utf8')).split('\n').filter((line) =>
    /trace: built-in: git diff --raw/u.test(line) && line.includes(approved.phases[codePhase].generationCommit));
  assert.equal(previews.length, 1, 'the confirmed repair previewed its change set more than once');
  const returned = await workflow();
  assert.equal(returned.currentPhase, codePhase);
  assert.equal(returned.phases[codePhase].status, 'in_progress');
  assert.equal(returned.phases[reviewPhase].status, 'not_started');
  assert.ok(returned.changeRequests.some((entry) =>
    entry.status === 'open' && entry.testingRepair?.confirmation === digest));
  assert.equal(await readFile(path.join(root, 'src/value.mjs'), 'utf8'), originalSource);
  assert.equal(await readFile(testPath, 'utf8'), reviewedTest);

  const beginRefusal = tryCli('phase', 'begin', codePhase);
  assert.notEqual(beginRefusal.status, 0);
  const adoptionDigest = `${beginRefusal.stdout}\n${beginRefusal.stderr}`.match(/sha256:[a-f0-9]{64}/u)?.[0];
  assert.ok(adoptionDigest, `missing adoption digest\n${beginRefusal.stdout}\n${beginRefusal.stderr}`);
  cli('phase', 'begin', codePhase, '--adopt-existing', '--confirm', adoptionDigest);
  cli('prepare', codePhase);
  if (workType === 'classic-delivery') await writeFile(summaryPath, `${await readFile(summaryPath, 'utf8')}\n## Test repair\n\nCorrected the unit-test fixture without modifying approved product behavior.\n`);
  for (const sourcePhase of ['missing-review', codePhase]) {
    const forged = await workflow();
    forged.changeRequests.at(-1).sourcePhase = sourcePhase;
    await assert.rejects(() => evaluateCodeDeliveryPreflight(root, definition, forged, forged.phases[codePhase]),
      (error) => error.code === 'CODE_DELIVERY_EVIDENCE_REQUIRED');
  }
  cli('phase', 'publish', codePhase, '--authored', authorship[0], '--channel', authorship[1]);
  cli('submit', codePhase);
  if (workType === 'classic-delivery') cli('approve', codePhase, '--yes');
  const reapproved = await workflow();
  assert.equal(reapproved.phases[codePhase].generation, originalCodeGeneration + 1);
  assert.equal(reapproved.phases[codePhase].deliveryEvidence.validation.status, 'passed');
  assert.equal(reapproved.phases[codePhase].deliveryEvidence.testingRepair?.changeRequestId,
    returned.changeRequests.at(-1).id);
  assert.equal(await readFile(path.join(root, 'src/value.mjs'), 'utf8'), originalSource);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '');
});
