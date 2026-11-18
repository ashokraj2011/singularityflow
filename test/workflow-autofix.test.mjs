/**
 * Every way of making a workflow checks it as approval will, adds what a step's template lacks only as
 * placeholders, and refuses the rest with its fix where the workflow is made [owner, 2026-11-18]:
 * "when a json is imported it should check and validate and fix the issues automatically .. this holds
 * true in every workflow creation paths" (src/workflow-autofix.mjs).
 *
 * The incident: a bundle whose first step defines the clauses and plans the code step, with a template
 * that had neither clause anchors nor a planned-claims table, previewed and proposed cleanly and was
 * refused only at approval, with advice that made no sense for an import.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { checkCandidate, checkedConfigurationSave, refuseAddedProblems } from '../src/workflow-autofix.mjs';
import { createdWithoutProblems, validateWorkflows, workflowProblems } from '../src/workflow-validation.mjs';
import { defineWorkflow } from '../src/workflow-authoring.mjs';
import { planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA } from '../src/workflow-studio.mjs';
import { applyWorkflowImport, copyWorkflow, exportWorkflowBundle, planWorkflowCopy, planWorkflowImport, readWorkflowBundle } from '../src/workflow-transfer.mjs';
import { installWorkflowChecked } from '../src/workflow-catalog.mjs';
import { importPlanText } from '../src/workflow-transfer-resolution.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const WORKFLOW = 'singularity/workflow.yml';
const ID = 'qa-web-e2e-automation';
const TEMPLATE = 'qa-web/e2e-intake.md';
const TEMPLATE_PATH = `singularity/templates/${TEMPLATE}`;
// The incident's template: every section the step checks for, guidance of its own, and no clause anchor or
// planned-claims table anywhere.
const INTAKE = [
  '# Web E2E test intake for {{work.id}}', '',
  '## Approved screenshots', '', 'Name each approved screenshot and what it shows.', '',
  '## Scope and acceptance criteria', '', 'What the web application must do, in the words of the person who asked.', '',
  '## Scenario matrix', '', '| Scenario | Steps | Expected |', '|---|---|---|', '| TODO | TODO | TODO |', '',
  '## Test environment and commands', '', 'Where the tests run and the command that runs them.', '',
  '## Planned implementation evidence', '', 'What the repair step will change and test.', '',
  '## Repair and acceptance agreement', '', 'Who accepts the result, and when a repair is done.', ''
].join('\n');

const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const problemFindings = (result, id) => (result.workflows.find((entry) => entry.id === id)?.findings ?? []).filter((entry) => entry.severity === 'problem');

async function temporary(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function configuration(t, prefix = 'sflow-autofix-') {
  const root = await temporary(t, prefix);
  await initializeDefinition(root);
  return root;
}

async function editDefinition(root, edit) {
  const file = path.join(root, WORKFLOW);
  const definition = YAML.parse(await readFile(file, 'utf8'));
  edit(definition);
  await writeFile(file, YAML.stringify(definition));
}

/** The incident's workflow: the packaged web E2E workflow, its intake step drafted from the team's own template. */
async function addIncidentWorkflow(root, { template = INTAKE } = {}) {
  await mkdir(path.dirname(path.join(root, TEMPLATE_PATH)), { recursive: true });
  await writeFile(path.join(root, TEMPLATE_PATH), template);
  await editDefinition(root, (definition) => {
    const source = structuredClone(definition.workTypes['demo-web-e2e-testing']);
    definition.workTypes[ID] = { ...source, label: 'QA web E2E automation', templateOverrides: { ...(source.templateOverrides ?? {}), 'demo-web-intake': TEMPLATE } };
  });
}

function flow(root, ...args) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Workflow Autofix Test',
      SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(root, '.git', 'test-autofix-outbox'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json') }
  });
}

async function repository(t, prefix) {
  const root = await configuration(t, prefix);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Workflow Autofix Test');
  git(root, 'config', 'user.email', 'workflow-autofix@example.test');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initialize workflow configuration');
  return root;
}

test('the incident: an imported workflow whose first step lacks anchors and the planned-claims table is repaired at its preview, proposed with the repair, and approved', async (t) => {
  const source = await configuration(t, 'sflow-autofix-source-');
  await addIncidentWorkflow(source);
  const base = await temporary(t, 'sflow-autofix-bundle-');
  const bundleFile = path.join(base, `${ID}.json`);
  await exportWorkflowBundle(source, [ID], bundleFile);
  const bundleBytes = await readFile(bundleFile);

  const root = await repository(t, 'sflow-autofix-target-');
  const remote = path.join(base, 'authority.git');
  git(base, 'init', '-q', '--bare', '--initial-branch=main', remote);
  git(root, 'push', '-q', remote, 'HEAD:refs/heads/main', 'HEAD:refs/heads/sflow/config');
  git(root, 'remote', 'add', 'origin', remote);

  // The preview repairs the template and says so; the plan binds the repaired bytes.
  const previewed = flow(root, 'workflow', 'import', bundleFile, '--dry-run', '--json', '--propose');
  assert.equal(previewed.status, 0, previewed.stderr);
  const plan = JSON.parse(previewed.stdout);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.problems ?? plan.conflicts));
  assert.equal(plan.problems, undefined);
  assert.equal(plan.repairs.length, 1, JSON.stringify(plan.repairs));
  const [repair] = plan.repairs;
  assert.equal(repair.path, TEMPLATE_PATH);
  assert.deepEqual(repair.codes, ['CHECK_TEMPLATE_CLAUSE_ANCHORS', 'CHECK_TEMPLATE_PLANNED_TABLE']);
  assert.equal(repair.before, sha(INTAKE));
  assert.equal(plan.added.find((entry) => entry.kind === 'template' && entry.id === TEMPLATE_PATH).sha256, repair.after,
    'the plan the person confirms names the repaired bytes');
  assert.match(repair.text, /^SFlow added to qa-web\/e2e-intake\.md \(Screenshot and web scenario intake\): two TODO clauses with anchors \[\{\{work\.id\}\}:REQ-001\] and \[\{\{work\.id\}\}:AC-001\] \(in a new section "Requirements"\); the planned-claims table, one TODO row per clause\. /u);
  const text = flow(root, 'workflow', 'import', bundleFile, '--dry-run', '--propose');
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes(`  ${repair.text}`), text.stdout);
  assert.match(text.stdout, /^Workflow import preview: ready\./u);
  assert.deepEqual(await readFile(bundleFile), bundleBytes, 'the bundle file itself is not changed');

  const applied = flow(root, 'workflow', 'import', bundleFile, '--confirm', plan.planSha256, '--propose', '--json');
  assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  const proposal = JSON.parse(applied.stdout);
  assert.equal(proposal.reviewRequired, true);
  assert.deepEqual(proposal.repairs, plan.repairs);
  const proposed = git(base, '--git-dir', remote, 'show', `${proposal.branch}:${TEMPLATE_PATH}`);
  assert.equal(sha(`${proposed}\n`), repair.after);
  // Nothing the author wrote was changed: each of their lines is still there, in order.
  const lines = proposed.split('\n');
  let at = 0;
  for (const line of INTAKE.split('\n').filter(Boolean)) { at = lines.indexOf(line, at); assert.ok(at >= 0, line); }
  assert.match(proposed, /^- TODO: one observable requirement per line\. \[\{\{work\.id\}\}:REQ-001\]$/mu);
  assert.match(proposed, /^\| `\{\{work\.id\}\}:AC-001` \| TODO/mu);

  const approved = flow(root, 'workflow', 'activate', proposal.branch, '--confirm', proposal.commit, '--acknowledge-unprotected', '--json');
  assert.equal(approved.status, 0, approved.stderr + approved.stdout);
  assert.equal(JSON.parse(approved.stdout).activated, true);
  // `workflow validate` on what landed: the imported workflow has no problem.
  const landed = await temporary(t, 'sflow-autofix-landed-');
  git(base, 'clone', '-q', '-b', 'sflow/config', remote, landed);
  const validated = await validateWorkflows(landed, { workflow: ID });
  assert.deepEqual(problemFindings(validated, ID), []);
  assert.equal(validated.workflows[0].valid, true);
});

test('an import whose problem only its author can fix is refused at its preview with the fix, never first at approval', async (t) => {
  const source = await configuration(t, 'sflow-autofix-source-');
  // Anchors are there but one is defined twice: rewriting them is the author's, so nothing is added.
  await addIncidentWorkflow(source, { template: `${INTAKE}\n## Requirements\n\n- One. [{{work.id}}:REQ-001]\n- Two. [{{work.id}}:REQ-001]\n` });
  const base = await temporary(t, 'sflow-autofix-bundle-');
  const bundleFile = path.join(base, `${ID}.json`);
  await exportWorkflowBundle(source, [ID], bundleFile);
  const root = await configuration(t, 'sflow-autofix-target-');
  const bundle = await readWorkflowBundle(bundleFile);
  const plan = await planWorkflowImport(root, bundle);
  assert.equal(plan.status, 'blocked');
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.problems.map((entry) => [entry.workflow, entry.code, entry.template]), [[ID, 'CHECK_TEMPLATE_CLAUSE_ANCHORS', TEMPLATE]]);
  assert.match(plan.problems[0].fix, /placeholder clauses, each with its anchor/u);
  const lines = importPlanText(plan, bundleFile, { propose: true });
  assert.ok(lines.includes('  Approval would refuse this problem, and SFlow cannot add a fix:'), lines.join('\n'));
  assert.ok(lines.some((line) => line.startsWith('      Fix: Give singularity/templates/qa-web/e2e-intake.md placeholder clauses')), lines.join('\n'));
  await assert.rejects(applyWorkflowImport(root, bundle, { expectedPlanSha256: plan.planSha256 }), (error) => {
    assert.equal(error.code, 'WORKFLOW_IMPORT_PROBLEMS');
    assert.deepEqual(error.details.problems, plan.problems);
    return true;
  });
  assert.equal(YAML.parse(await readFile(path.join(root, WORKFLOW), 'utf8')).workTypes[ID], undefined, 'nothing was written');
});

/** Every line of `before` is still in `after`, in order: the check only adds. */
function keepsEveryLine(before, after) {
  const lines = after.split('\n');
  let at = 0;
  for (const line of before.split('\n').filter(Boolean)) { at = lines.indexOf(line, at); assert.ok(at >= 0, `kept: ${line}`); }
}

/** A repository whose web E2E workflow is its own (no packaged one uses the demo steps), its intake template the incident's. */
async function ownDemoSteps(t, template = INTAKE) {
  const root = await configuration(t);
  await editDefinition(root, (definition) => { delete definition.workTypes['demo-web-e2e-testing']; });
  await writeFile(path.join(root, 'singularity/templates/demo-web-e2e-testing/intake.md'), template);
  return root;
}
const INTAKE_PATH = 'singularity/templates/demo-web-e2e-testing/intake.md';
const QA_FLOW = { label: 'QA flow', governs: 'story', phases: ['demo-web-intake', 'demo-web-check', 'demo-web-repair', 'demo-web-retest'],
  plannedClaims: { mode: 'required', clausePhases: ['demo-web-intake'], owners: { 'demo-web-repair': 'demo-web-intake' } } };

test('the check adds only placeholders, keeps every line of the template, and finds nothing more to add a second time', async (t) => {
  const root = await configuration(t);
  await mkdir(path.dirname(path.join(root, TEMPLATE_PATH)), { recursive: true });
  await writeFile(path.join(root, TEMPLATE_PATH), '# Intake\n\nNotes for the team.\n');
  const definition = YAML.parse(await readFile(path.join(root, WORKFLOW), 'utf8'));
  definition.workTypes[ID] = { ...structuredClone(definition.workTypes['demo-web-e2e-testing']), label: 'QA web', templateOverrides: { 'demo-web-intake': TEMPLATE } };
  const candidate = [{ path: WORKFLOW, content: YAML.stringify(definition) }];
  const first = await checkCandidate(root, candidate, { workflows: [ID] });
  assert.deepEqual(first.problems, []);
  const [repair] = first.repairs;
  assert.deepEqual(repair.codes, ['CHECK_TEMPLATE_CLAUSE_ANCHORS', 'CHECK_TEMPLATE_PLANNED_TABLE', 'CHECK_TEMPLATE_HEADING_MISSING']);
  const repaired = first.files.find((file) => file.path === TEMPLATE_PATH);
  assert.equal(repaired.repaired, true, 'a template the change did not write is added to it');
  assert.equal(String(repaired.before), '# Intake\n\nNotes for the team.\n');
  keepsEveryLine('# Intake\n\nNotes for the team.\n', repaired.content);
  for (const section of ['Approved screenshots', 'Scenario matrix', 'Repair and acceptance agreement']) assert.ok(repaired.content.includes(`## ${section}\n\nTODO`), section);
  assert.equal(await readFile(path.join(root, TEMPLATE_PATH), 'utf8'), '# Intake\n\nNotes for the team.\n', 'nothing at the configuration was written');
  await writeFile(path.join(root, TEMPLATE_PATH), repaired.content);
  const again = await checkCandidate(root, candidate, { workflows: [ID] });
  assert.deepEqual([again.repairs, again.problems], [[], []]);
});

test('workflow create adds what its clause and planning step\'s template lacks instead of refusing, and the result passes approval\'s check', async (t) => {
  const root = await ownDemoSteps(t);
  const created = await createdWithoutProblems(root, 'qa-flow', () => defineWorkflow(root, 'qa-flow', QA_FLOW));
  assert.deepEqual(created.repairs.map((entry) => [entry.path, entry.codes]), [[INTAKE_PATH, ['CHECK_TEMPLATE_CLAUSE_ANCHORS', 'CHECK_TEMPLATE_PLANNED_TABLE']]]);
  keepsEveryLine(INTAKE, await readFile(path.join(root, INTAKE_PATH), 'utf8'));
  assert.equal((await workflowProblems(root, ['qa-flow'])).size, 0);
  // A packaged workflow's template is never changed: that problem is refused here with its fix, and the workflow put back.
  const requirements = await readFile(path.join(root, 'singularity/templates/feature/requirements.md'), 'utf8');
  await assert.rejects(createdWithoutProblems(root, 'thin-plan', () => defineWorkflow(root, 'thin-plan', { label: 'Thin plan', governs: 'story',
    phases: ['requirements', 'implementation'], plannedClaims: { mode: 'required', clausePhases: ['requirements'], owners: { implementation: 'requirements' } } })), (error) => {
    assert.equal(error.code, 'WORKFLOW_CREATE_PROBLEMS');
    assert.match(error.message, /Fix: Give \S+\/requirements\.md the planned-claims table[\s\S]*That template belongs to a packaged workflow, so SFlow does not change it/u);
    return true;
  });
  assert.equal(YAML.parse(await readFile(path.join(root, WORKFLOW), 'utf8')).workTypes['thin-plan'], undefined);
  assert.equal(await readFile(path.join(root, 'singularity/templates/feature/requirements.md'), 'utf8'), requirements);
});

test('Workflow Studio shows what it adds in the preview, writes it with the change, and refuses a problem it cannot fix when proposed', async (t) => {
  const root = await ownDemoSteps(t);
  const changeSet = { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [
    { op: 'workflow.create', id: 'qa-flow', label: 'QA flow', phases: QA_FLOW.phases },
    { op: 'workflow.update', id: 'qa-flow', plannedClaims: { clausePhases: QA_FLOW.plannedClaims.clausePhases, owners: QA_FLOW.plannedClaims.owners } }] };
  const preview = await planStudioChangeSet(root, changeSet);
  assert.equal(preview.valid, true, JSON.stringify(preview.problems));
  assert.deepEqual(preview.repairs.map((entry) => entry.path), [INTAKE_PATH]);
  assert.ok(preview.summary.includes(preview.repairs[0].text));
  assert.ok(preview.files.some((file) => file.path === INTAKE_PATH && file.action === 'update'));
  assert.ok(!preview.warnings.some((entry) => entry.code === 'STUDIO_WORKFLOW_PROBLEM'), JSON.stringify(preview.warnings));
  assert.equal(await readFile(path.join(root, INTAKE_PATH), 'utf8'), INTAKE, 'a preview writes nothing');
  await planStudioChangeSet(root, changeSet, { write: true });
  assert.equal(sha(await readFile(path.join(root, INTAKE_PATH), 'utf8')), preview.repairs[0].after, 'what is written is what the preview showed');
  assert.equal((await workflowProblems(root, ['qa-flow'])).size, 0);

  // Planning in a packaged workflow's step whose template has no table: SFlow does not change that template, so
  // the preview names the problem and its fix, and writing it is refused.
  const broken = { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [
    { op: 'workflow.create', id: 'thin-plan', label: 'Thin plan', phases: ['requirements', 'implementation'] },
    { op: 'workflow.update', id: 'thin-plan', plannedClaims: { clausePhases: ['requirements'], owners: { implementation: 'requirements' } } }] };
  const shown = await planStudioChangeSet(root, broken);
  assert.equal(shown.valid, true, JSON.stringify(shown.problems));
  assert.ok(shown.warnings.some((entry) => entry.code === 'STUDIO_WORKFLOW_PROBLEM' && /^Approval would refuse thin-plan: The template of Requirements has no planned-claims table/u.test(entry.message)
    && /belongs to a packaged workflow/u.test(entry.message)), JSON.stringify(shown.warnings));
  await assert.rejects(planStudioChangeSet(root, broken, { write: true, proposing: true }), (error) => {
    assert.equal(error.code, 'STUDIO_WORKFLOW_PROBLEMS');
    assert.match(error.message, /^Workflow Studio changes were not proposed: approval would refuse \d+ problems they add\. Nothing was written or proposed\.\n- thin-plan: /u);
    assert.ok(error.details.problems.some((entry) => entry.code === 'CHECK_TEMPLATE_PLANNED_TABLE'));
    return true;
  });
  assert.equal(YAML.parse(await readFile(path.join(root, WORKFLOW), 'utf8')).workTypes['thin-plan'], undefined, 'nothing was written');
});

test('workflow copy and duplicate repair the template their new workflow needs, and the plan names it', async (t) => {
  const root = await configuration(t);
  await addIncidentWorkflow(root);
  const plan = await planWorkflowCopy(root, { sourceId: ID, targetId: 'qa-web-copy', label: 'QA web copy' });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.problems));
  assert.deepEqual(plan.repairs.map((entry) => entry.path), [TEMPLATE_PATH]);
  assert.ok(plan.changedPaths.includes(TEMPLATE_PATH));
  assert.ok(plan.added.some((entry) => entry.kind === 'template-repair' && entry.id === TEMPLATE_PATH && entry.sha256 === plan.repairs[0].after));
  const copied = await copyWorkflow(root, { sourceId: ID, targetId: 'qa-web-copy', label: 'QA web copy', expectedPlanSha256: plan.planSha256 });
  assert.deepEqual(copied.repairs, plan.repairs);
  assert.equal(sha(await readFile(path.join(root, TEMPLATE_PATH), 'utf8')), plan.repairs[0].after);
  assert.equal((await workflowProblems(root, ['qa-web-copy'])).size, 0);

  const other = await configuration(t);
  await addIncidentWorkflow(other);
  const duplicate = await planWorkflowCopy(other, { sourceId: ID, targetId: 'qa-web-own', label: 'QA web own', independent: true });
  assert.equal(duplicate.status, 'ready', JSON.stringify(duplicate.problems ?? duplicate.conflicts));
  assert.equal(duplicate.repairs.length, 1);
  assert.deepEqual(duplicate.repairs[0].codes, ['CHECK_TEMPLATE_CLAUSE_ANCHORS', 'CHECK_TEMPLATE_PLANNED_TABLE']);
});

test('workflow install, a whole workflow.yml save and a confirmed workflow package each run the same check', async (t) => {
  // Install: a repository whose own copy of the packaged intake template lacks the anchors and table. A packaged
  // workflow's template is not SFlow's to add to, so the install is refused with its fix, and --replace takes the packaged one.
  const root = await configuration(t);
  await editDefinition(root, (definition) => { delete definition.workTypes['demo-web-e2e-testing']; });
  const intake = 'singularity/templates/demo-web-e2e-testing/intake.md';
  await writeFile(path.join(root, intake), INTAKE);
  const configured = await readFile(path.join(root, WORKFLOW), 'utf8');
  const dry = await installWorkflowChecked(root, 'demo-web-e2e-testing', { dryRun: true });
  assert.deepEqual([dry.repairs, dry.problems.map((entry) => entry.code).sort()], [[], ['CHECK_TEMPLATE_CLAUSE_ANCHORS', 'CHECK_TEMPLATE_PLANNED_TABLE']]);
  await assert.rejects(installWorkflowChecked(root, 'demo-web-e2e-testing'), (error) => {
    assert.equal(error.code, 'WORKFLOW_INSTALL_PROBLEMS');
    assert.equal(error.details.nextAction.command, 'singularity-flow workflow install demo-web-e2e-testing --replace');
    return true;
  });
  assert.deepEqual([await readFile(path.join(root, WORKFLOW), 'utf8'), await readFile(path.join(root, intake), 'utf8')], [configured, INTAKE], 'nothing is left written');
  const installed = await installWorkflowChecked(root, 'demo-web-e2e-testing', { replace: true });
  assert.deepEqual(installed.repairs ?? [], []);
  assert.equal((await workflowProblems(root, ['demo-web-e2e-testing'])).size, 0);

  // A whole-file save of workflow.yml (Configuration Center, `configuration save`).
  const saved = await configuration(t);
  await mkdir(path.dirname(path.join(saved, TEMPLATE_PATH)), { recursive: true });
  await writeFile(path.join(saved, TEMPLATE_PATH), INTAKE);
  const text = YAML.parse(await readFile(path.join(saved, WORKFLOW), 'utf8'));
  text.workTypes[ID] = { ...structuredClone(text.workTypes['demo-web-e2e-testing']), label: 'QA web', templateOverrides: { 'demo-web-intake': TEMPLATE } };
  const content = YAML.stringify(text);
  const result = await checkedConfigurationSave(saved, WORKFLOW, content, async () => { await writeFile(path.join(saved, WORKFLOW), content); return { saved: true }; });
  assert.deepEqual(result.repairs.map((entry) => entry.path), [TEMPLATE_PATH]);
  assert.equal((await workflowProblems(saved, [ID])).size, 0);
  const broken = YAML.parse(content);
  broken.workTypes['code-only'] = { label: 'Code only', phases: ['implementation'] };
  const brokenText = YAML.stringify(broken);
  await assert.rejects(checkedConfigurationSave(saved, WORKFLOW, brokenText, async () => { await writeFile(path.join(saved, WORKFLOW), brokenText); return {}; }),
    (error) => error.code === 'CONFIGURATION_SAVE_WORKFLOW_PROBLEMS');
  assert.equal(await readFile(path.join(saved, WORKFLOW), 'utf8'), content, 'the save is put back');

  // A workflow package whose exact files a person confirmed cannot be added to: the problem is refused before proposing.
  const confirmed = await configuration(t);
  await mkdir(path.dirname(path.join(confirmed, TEMPLATE_PATH)), { recursive: true });
  await writeFile(path.join(confirmed, TEMPLATE_PATH), INTAKE);
  await assert.rejects(refuseAddedProblems(confirmed, [{ path: WORKFLOW, content }], { label: 'Workflow package d-1' }), (error) => {
    assert.equal(error.code, 'WORKFLOW_PACKAGE_PROBLEMS');
    assert.deepEqual(error.details.problems.map((entry) => entry.code).sort(), ['CHECK_TEMPLATE_CLAUSE_ANCHORS', 'CHECK_TEMPLATE_PLANNED_TABLE']);
    return true;
  });
});

test('the import preview names who an approval group it brings puts in or takes out, you included (owner, 2026-11-18)', async (t) => {
  const source = await configuration(t, 'sflow-autofix-source-');
  await addIncidentWorkflow(source);
  await editDefinition(source, (definition) => { definition.approvalAuthorities['product-approvers'].members = [{ email: 'importer@example.test' }]; });
  const base = await temporary(t, 'sflow-autofix-bundle-');
  const bundleFile = path.join(base, `${ID}.json`);
  await exportWorkflowBundle(source, [ID], bundleFile);
  const root = await configuration(t, 'sflow-autofix-target-');
  const bundle = await readWorkflowBundle(bundleFile);
  const me = { name: 'Importer', email: 'importer@example.test' };
  // The repository's group differs, so it is a choice; the preview says what replacing it would do.
  const asked = await planWorkflowImport(root, bundle);
  assert.deepEqual(asked.memberships, [{ scope: 'story', group: 'product-approvers', existed: true, ifReplaced: true, adds: [{ email: 'importer@example.test' }], removes: [] }]);
  const askedText = importPlanText(asked, bundleFile, { identity: me });
  assert.ok(askedText.includes('  Approval group product-approvers (if you replace it): adds importer@example.test.'), askedText.join('\n'));
  assert.ok(askedText.includes('  Replacing it puts you in product-approvers.'));
  const replaced = await planWorkflowImport(root, bundle, { resolutions: { 'approval-group:product-approvers': { action: 'replace' } } });
  const text = importPlanText(replaced, bundleFile, { identity: me });
  assert.ok(text.includes('  This import puts you in product-approvers.'), text.join('\n'));
  assert.ok(text.includes("    Keep this repository's product-approvers instead: --resolve approval-group:product-approvers=keep"), text.join('\n'));
  const kept = await planWorkflowImport(root, bundle, { resolutions: { 'approval-group:product-approvers': { action: 'keep' } } });
  assert.equal(kept.memberships, undefined, 'keeping the repository\'s group changes nobody');
});
