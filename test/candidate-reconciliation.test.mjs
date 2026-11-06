import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { unreconciledCandidatePaths } from '../src/candidate-scope.mjs';
import YAML from 'yaml';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';

async function draft(t) {
  const repo = await repository(t, { implementCommands: false });
  const configPath = path.join(repo.root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.implement.approval = { mode: 'required', authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake'] };
  await writeFile(configPath, YAML.stringify(config));
  repo.must('git', ['add', 'singularity/workflow.yml']);
  repo.must('git', ['commit', '-m', 'Require a human implementation review in this fixture']);
  await startQuickFix(repo);
  repo.sflow('prepare', 'implement');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
  await writeFile(path.join(repo.root, 'index.html'), '<!-- @clause:QF-1:AC-001 show the approved value -->\n<title>Calendar</title>\n');
  repo.sflow('prepare', 'implement');
  return repo;
}

test('one decision on a test setup is one amendment that names each file, by the command a /sf-decide turn runs', async t => {
  const repo = await draft(t);
  const reason = 'Adding the browser runner needs all of these.';
  repo.sflow('decision', 'plan', 'QF-1', '--fetch', '--add-supporting', 'package-lock.json=dependency-lock', '--supporting-reason', reason,
    '--add-supporting', 'playwright.config.js=build-configuration', '--supporting-reason', reason, '--add-location', 'QF-1:AC-001=test/setup.mjs', '--reason', reason);
  const { planAmendments } = JSON.parse(await readFile(path.join(repo.root, 'singularity/work-items/QF-1/workflow.json')));
  assert.equal(planAmendments.length, 1);
  assert.deepEqual(planAmendments[0].changes.map((change) => [change.kind, change.path, change.class ?? change.clauseId]), [
    ['add-location', 'test/setup.mjs', 'QF-1:AC-001'], ['add-supporting', 'package-lock.json', 'dependency-lock'], ['add-supporting', 'playwright.config.js', 'build-configuration']]);
});

test('publication and prepublish detect excluded HTML before committing; narrow accounting keeps the current phase', async t => {
  const repo = await draft(t);
  const workflowFile = path.join(repo.root, 'singularity/work-items/QF-1/workflow.json');
  const before = await readFile(workflowFile);
  const head = repo.must('git', ['rev-parse', 'HEAD']);
  const html = await readFile(path.join(repo.root, 'index.html'));
  const gate = repo.sflowJson('phase', 'prepublish', 'implement');
  assert.equal(gate.status, 0, JSON.stringify(gate));
  assert.equal(gate.value.status, 'correction-required');
  assert.ok(JSON.stringify(gate.value).includes('GENERATION_EXCLUDED_CHANGES_UNRESOLVED'));
  assert.ok(JSON.stringify(gate.value).includes('decision plan QF-1'));
  const publish = repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.notEqual(publish.status, 0);
  assert.match(JSON.stringify(publish), /GENERATION_EXCLUDED_CHANGES_UNRESOLVED/);
  assert.equal(repo.must('git', ['rev-parse', 'HEAD']), head);
  assert.deepEqual(await readFile(workflowFile), before);
  assert.deepEqual(await readFile(path.join(repo.root, 'index.html')), html);
  repo.sflow('decision', 'plan', '--add-location', 'QF-1:AC-001=index.html', '--reason', 'The entry page belongs to this approved value display and must ship with its code.');
  repo.sflow('prepare', 'implement');
  const included = repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.equal(included.status, 0, JSON.stringify(included));
  const after = JSON.parse(await readFile(workflowFile));
  assert.deepEqual(after.phases.intake, JSON.parse(before).phases.intake, 'earlier approved planning bytes remain unchanged');
  // The amendment binds what the person accounted for, by the hash reconciliation reads a file with.
  assert.equal(after.planAmendments[0].contentHashes['index.html'], createHash('sha256').update(await readFile(path.join(repo.root, 'index.html'))).digest('hex'));
  assert.equal(after.currentPhase, 'implement');
  assert.ok(after.phases.implement.deliveryEvidence.sourcePaths.includes('index.html'));
  assert.equal(repo.must('git', ['status', '--porcelain', '--', 'index.html']), '');
  repo.sflow('submit', 'implement');
  await writeFile(path.join(repo.root, 'index.html'), '<title>Edited after submission</title>\n');
  const recovery = repo.sflowJson('recover', 'QF-1');
  assert.equal(recovery.status, 0, JSON.stringify(recovery));
  assert.equal(recovery.value.reviewRequired, true);
  assert.ok(!recovery.value.actions.some(action => action.id === 'commit-reviewed-worktree'));
  const correction = recovery.value.actions.find(action => action.id === 'return-current-phase-for-edits');
  assert.equal(correction.commandGuidance.copilotCommand, '/sf-reject');
  assert.ok(correction.command.includes('--to implement'));
  assert.equal(agentAct(recovery.value).state, 'await-human');
  assert.equal(JSON.parse(await readFile(workflowFile)).phases.implement.status, 'awaiting_approval');
  // Exercise the offered return with dirty files, not just its display. A clean-checkout requirement
  // here would send the person straight back to the approval/recovery loop.
  const editedHtml = await readFile(path.join(repo.root, 'index.html'));
  repo.sflow('reject', 'implement', '--work-id', 'QF-1', '--to', 'implement',
    '--reason', 'Include the reviewed entry-page edits in a successor of this same code phase.');
  const returned = JSON.parse(await readFile(workflowFile));
  assert.equal(returned.currentPhase, 'implement');
  assert.equal(returned.phases.implement.status, 'in_progress');
  assert.deepEqual(returned.phases.intake, after.phases.intake);
  assert.deepEqual(await readFile(path.join(repo.root, 'index.html')), editedHtml);
  assert.deepEqual(returned.phases.implement.approvalPolicy.rejectTo, ['intake']);
});

test('unrelated edits have an exact private-preservation route before publication, without sweeping in Story code', async t => {
  const repo = await draft(t);
  const workflowFile = path.join(repo.root, 'singularity/work-items/QF-1/workflow.json');
  const before = JSON.parse(await readFile(workflowFile));
  const plan = repo.sflowJson('recover', 'QF-1');
  assert.equal(plan.status, 0, JSON.stringify(plan));
  const aside = plan.value.actions.find(action => action.id === 'set-aside-worktree');
  assert.deepEqual(aside.paths, ['index.html']);
  assert.equal(aside.humanOnly, true);
  const source = await readFile(path.join(repo.root, 'src/value.mjs'));
  const html = await readFile(path.join(repo.root, 'index.html'));
  const saved = repo.sflowJson(...aside.commandGuidance.argv);
  assert.equal(saved.status, 0, JSON.stringify(saved));
  assert.equal(saved.value.setAside.lifecycleAdvanced, false);
  assert.deepEqual(saved.value.setAside.removed, ['index.html']);
  assert.deepEqual(await readFile(path.join(repo.root, 'src/value.mjs')), source);
  assert.deepEqual(JSON.parse(await readFile(workflowFile)).phases.intake, before.phases.intake);
  const copy = repo.sflowJson('appeal', 'checkpoint-show', saved.value.setAside.checkpoint, '--work-id', 'QF-1', '--phase', 'implement');
  assert.equal(copy.status, 0, JSON.stringify(copy));
  assert.ok(JSON.stringify(copy.value).includes('index.html'), 'the private copy retains the excluded file');
  assert.deepEqual(await readFile(copy.value.data.files.find(file => file.path === 'index.html').recoveryCopy), html);
  const published = repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.equal(published.status, 0, JSON.stringify(published));
});

test('an always-local file needs no accounting, and publication leaves it on this laptop', async t => {
  const repo = await draft(t);
  repo.sflow('decision', 'plan', '--add-location', 'QF-1:AC-001=index.html', '--reason', 'The entry page belongs to the approved value display.');
  // A checkout from before this rule: nothing has told Git about the name yet.
  await writeFile(path.join(repo.root, '.git/info/exclude'), '');
  const env = path.join(repo.root, '.env');
  await writeFile(env, 'API_KEY=abc123xyz987LMNopq456\n');
  repo.sflow('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.equal(repo.must('git', ['ls-files', '--', '.env']).trim(), '');
  assert.equal(await readFile(env, 'utf8'), 'API_KEY=abc123xyz987LMNopq456\n');
  assert.match(await readFile(path.join(repo.root, '.git/info/exclude'), 'utf8'), /^\.env$/mu);
});

test('publication rechecks files generated by a passing test run before consuming the generation', async t => {
  const repo = await draft(t);
  repo.sflow('decision', 'plan', '--add-location', 'QF-1:AC-001=index.html', '--reason', 'The entry page belongs to the approved value display.');
  const testFile = path.join(repo.root, 'test/value.test.mjs');
  await writeFile(testFile, await readFile(testFile, 'utf8')
    + "\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('generated-note.html', '<title>Unexpected test output</title>');\n");
  repo.sflow('prepare', 'implement');
  const workflowFile = path.join(repo.root, 'singularity/work-items/QF-1/workflow.json');
  const before = JSON.parse(await readFile(workflowFile));
  const head = repo.must('git', ['rev-parse', 'HEAD']);
  const published = repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.notEqual(published.status, 0, JSON.stringify(published));
  assert.match(JSON.stringify(published), /GENERATION_EXCLUDED_CHANGES_UNRESOLVED/);
  assert.match(JSON.stringify(published), /generated-note\.html/);
  assert.equal(await readFile(path.join(repo.root, 'generated-note.html'), 'utf8'), '<title>Unexpected test output</title>');
  const after = JSON.parse(await readFile(workflowFile));
  assert.equal(after.phases.implement.generation, before.phases.implement.generation);
  assert.equal(after.phases.implement.generationIntent.status, 'open');
  assert.deepEqual(after.phases.intake, before.phases.intake);
  assert.equal(repo.must('git', ['rev-parse', 'HEAD']), head);
});

test('the installed finding offers narrow accounting in the current phase, not a risk waiver or Planning reset', () => {
  const phase = { id: 'team-build', status: 'in_progress', generationPolicy: { task: 'code' }, writeScope: 'source-and-artifact',
    generationIntent: { status: 'open' }, approvalPolicy: { mode: 'required', rejectTo: ['outline'] } };
  const workflow = { workItem: { id: 'TEAM' }, status: 'in_progress', currentPhase: phase.id, phaseOrder: ['outline', phase.id],
    phases: { outline: { id: 'outline', status: 'approved' }, [phase.id]: phase } };
  const result = phaseResolutionChoices(workflow, phase, { code: 'code.delivery.incomplete', category: 'code-delivery',
    details: { sourceCode: 'GENERATION_EXCLUDED_CHANGES_UNRESOLVED', paths: ['index.html'] } });
  assert.equal(result.policy.riskEligible, false);
  assert.equal(result.status, 'needs-human');
  assert.equal(result.choices[0].kind, 'plan-amendment');
  assert.ok(result.choices[0].command.includes('<CLAUSE>=index.html'));
  assert.ok(!result.choices.some(choice => choice.argv?.[0] === 'reject'));
});

test('reconciliation uses declared candidate ownership for any code phase and all file types', async t => {
  const repo = await repository(t);
  for (const relative of ['index.html', 'api.schema.graphql', 'notes.txt', 'build.local.json']) await writeFile(path.join(repo.root, relative), 'local change\n');
  const paths = await unreconciledCandidatePaths(repo.root, {}, { workItem: { id: 'CUSTOM' } }, { id: 'custom-deliver' }, { allows: () => false });
  for (const relative of ['index.html', 'api.schema.graphql', 'notes.txt', 'build.local.json']) assert.ok(paths.includes(relative), relative);
  assert.deepEqual(await unreconciledCandidatePaths(repo.root, {}, { workItem: { id: 'CUSTOM' } }, { id: 'custom-deliver' }, null), [], 'unscoped legacy candidates still contain every application change');
});
