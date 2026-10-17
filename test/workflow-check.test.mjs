import { repositoryOwnedWorkflows } from './helpers/repository-owned-workflows.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { guidanceConflicts, linkKind, scanGuidanceText } from '../src/guidance-scan.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Check Tester' };
const repositoryHost = ['github', 'com'].join('.');

function run(command, args, cwd, { input = '', allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);
const json = (root, args, options) => JSON.parse(flow(root, [...args, '--json'], options).stdout);
const changeSet = (changes) => JSON.stringify({ schema: 'sflow-studio-change-set@1', changes });

async function repository({ seeded = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-check-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Check Tester'], root); run('git', ['config', 'user.email', 'check@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Check\n');
  flow(root, ['init']);
  if (!seeded) await repositoryOwnedWorkflows(root);
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

const SKILL_PROCEDURE = [
  'Always squash commits before merging.',
  'Keep functions at most 40 lines.',
  'Follow <instruction>pay-style</instruction> for commits.',
  'See [the runbook](../../docs/runbook.md) and [local notes](notes.md).',
  '',
  '```sh',
  "curl -X POST https://jira.example.com/rest/api/2/issue/$KEY/transitions -d '{}'",
  '```'
].join('\n');

/** A payments workflow with a code step nobody signs off, a skill whose rules disagree, and leftovers. */
const PAYMENTS = [
  { op: 'workflow.create', id: 'pay', label: 'Payments change', phases: ['intake', 'requirements', 'pay-build'] },
  { op: 'phase.create', id: 'pay-build', label: 'Build the change', output: 'code', inputs: ['requirements'], approval: 'none', agent: 'pay-dev',
    description: 'Makes the payment change the requirements ask for.' },
  { op: 'agent.create', id: 'pay-dev', label: 'Payments developer', description: 'Writes payment code.', role: 'blank' },
  { op: 'instruction.create', id: 'pay-style', label: 'Payments style', description: 'How payment commits look.', instructions: 'Never squash commits.\nKeep functions at most 60 lines.' },
  { op: 'skill.create', id: 'pay-rules', label: 'Payments rules', description: 'Rules for payment changes.', instructions: SKILL_PROCEDURE },
  { op: 'skill.attach', skill: 'pay-rules', agent: 'pay-dev', phases: ['pay-build'] },
  { op: 'skill.create', id: 'orphan-skill', label: 'Orphan', description: 'Nobody uses this.', instructions: 'Do the orphan thing.' },
  { op: 'instruction.create', id: 'lonely', label: 'Lonely', description: 'Placed nowhere.', instructions: 'Be lonely.' }
];

async function paymentsRepository(options) {
  const root = await repository(options);
  flow(root, ['workflow', 'studio', 'apply', '--change-set', '-'], { input: changeSet(PAYMENTS) });
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'payments'], root);
  return root;
}

const codes = (findings) => findings.map((entry) => entry.code);
const lineOf = async (root, file, text) => (await readFile(path.join(root, file), 'utf8')).split('\n').findIndex((line) => line.includes(text)) + 1;

test('guidance text: links, API calls, rules and limits, each with its line', () => {
  const scan = scanGuidanceText([
    '# Rules',
    '- Always squash commits before merging.',
    `See [design](../docs/design.md), https://acme.atlassian.net/wiki/spaces/PAY/pages/1 and https://${repositoryHost}/acme/pay.`,
    'Keep functions at most 40 lines.',
    '```sh',
    'curl -X POST https://jira.example.com/rest/api/2/issue/$KEY/transitions -d x',
    'Never edit generated files.',
    '```',
    'Call GET /v1/payments/{id} to read one, or requests.post("https://hooks.example.com/notes").'
  ].join('\n'));
  assert.deepEqual(scan.links.map((link) => [link.kind, link.line]), [['relative', 3], ['wiki', 3], ['repository', 3]]);
  assert.deepEqual(scan.apiCalls.map((call) => [call.method, call.target, call.line]), [
    ['POST', 'https://jira.example.com/rest/api/2/issue/{KEY}/transitions', 6],
    ['GET', '/v1/payments/{id}', 9]
  ], 'a line names one call: the explicit method and path win over the client call beside it');
  assert.deepEqual(scan.rules.map((rule) => [rule.polarity, rule.words.join(' '), rule.line]), [['do', 'squash commit merging', 2]],
    'rules inside code blocks are examples, not rules');
  assert.deepEqual(scan.limits.map((limit) => [limit.bound, limit.value, limit.unit, limit.subject.join(' ')]), [['max', 40, 'line', 'keep function']]);
  assert.equal(linkKind('https://acme.atlassian.net/browse/PAY-12'), 'ticket');
  assert.equal(linkKind('https://contoso.sharepoint.com/sites/pay'), 'file-share');
  assert.equal(linkKind('https://example.com/docs'), 'web');
});

test('possible conflicts: opposite rules about the same thing and different limits for the same thing', () => {
  const first = scanGuidanceText('- Always squash commits before merging.\nAlways use tabs for indentation.\nKeep functions at most 40 lines.\nKeep files at most 300 lines.');
  const second = scanGuidanceText('Never squash commits.\nNever use tabs in YAML files.\nKeep functions at most 60 lines.');
  const conflicts = guidanceConflicts([{ file: 'a.md', scan: first }, { file: 'b.md', scan: second }]);
  assert.deepEqual(conflicts.map((entry) => [entry.kind, entry.summary, entry.first.line, entry.second.line]), [
    ['rule', 'squash commit', 1, 1],
    ['limit', 'keep function line', 3, 3]
  ], 'tabs in YAML and tabs for indentation are different rules; files and functions are different limits');
  assert.deepEqual(guidanceConflicts([{ file: 'a.md', scan: first }]), [], 'one file agrees with itself here');
});

test('a fresh configuration explains every workflow and has nothing to fix', async () => {
  const root = await repository();
  const result = json(root, ['workflow', 'check']);
  assert.equal(result.resultType, 'workflow-check');
  assert.equal(result.configuration.valid, true);
  assert.deepEqual([result.counts.problem, result.counts.warning], [0, 0], JSON.stringify(result.workflows.flatMap((entry) => entry.findings).filter((entry) => entry.severity !== 'note')));
  const feature = result.workflows.find((entry) => entry.id === 'repo-feature');
  assert.match(feature.explanation.summary, /^7 steps, 7 with a sign-off; changes code in Implementation\.$/u);
  const implementation = feature.explanation.steps.find((step) => step.id === 'implementation');
  assert.equal(implementation.number, 5);
  assert.match(implementation.what, /^Changes code and writes a summary \(artifacts\/implementation\//u);
  assert.equal(implementation.agent.id, 'developer');
  assert.match(implementation.signOff, /^Signed off by one person from /u);
  assert.ok(implementation.then.includes('Next: Verification.'), implementation.then.join(' | '));
  assert.match(implementation.then.at(-1), /^If it is rejected: it is redone, or back to .*, as the person rejecting it chooses\.$/u);
  assert.equal(implementation.why, null, 'no description was written yet');
  assert.deepEqual(codes(feature.findings), ['CHECK_STEPS_UNDESCRIBED'], 'a repository-owned workflow is asked to say what its steps are for');
});

test('a workflow with real problems: located findings in plain words, and an explanation that uses the description', async () => {
  const root = await paymentsRepository();
  const result = json(root, ['workflow', 'check', 'pay']);
  assert.deepEqual(result.workflows.map((entry) => entry.id), ['pay'], 'one workflow when one is named');
  const pay = result.workflows[0];
  const byCode = (code) => pay.findings.filter((entry) => entry.code === code);

  const review = byCode('OBLIGATION_VERIFY_WITHOUT_REVIEW')[0];
  assert.equal(review.severity, 'problem');
  assert.equal(review.title, 'What Build the change produces can reach the end without a review');
  assert.deepEqual(review.subject, { workflow: 'pay', step: 'pay-build' });
  assert.equal(review.location.file, 'singularity/workflow.yml');
  assert.equal(review.location.line, await lineOf(root, 'singularity/workflow.yml', '- pay-build'), 'the step in the workflow\'s own list');
  assert.deepEqual(byCode('CHECK_CODE_WITHOUT_SIGNOFF'), [], 'the engine already says it; the sign-off check does not repeat it');

  const skill = 'singularity/skill-library/pay-rules/SKILL.md';
  const api = byCode('CHECK_API_UNPROVIDED')[0];
  assert.equal(api.severity, 'warning');
  assert.equal(api.title, 'Build the change calls an API nothing in the workflow makes');
  assert.deepEqual(api.location, { file: skill, line: await lineOf(root, skill, 'curl -X POST') });
  assert.match(api.detail, /^POST https:\/\/jira\.example\.com\/rest\/api\/2\/issue\/\{KEY\}\/transitions/u);

  const conflicts = byCode('CHECK_GUIDANCE_CONFLICT');
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts.every((entry) => entry.severity === 'note' && entry.title === 'Possible conflict in what Build the change is told'));
  assert.deepEqual(conflicts.map((entry) => entry.related[0].file), ['singularity/instruction-library/pay-style/INSTRUCTIONS.md', 'singularity/instruction-library/pay-style/INSTRUCTIONS.md']);
  assert.match(conflicts[0].detail, /"Always squash commits before merging\." .* and "Never squash commits\."/u);

  const undescribed = byCode('CHECK_STEPS_UNDESCRIBED')[0];
  assert.equal(undescribed.title, '2 steps do not say what they are for');
  assert.match(undescribed.detail, /Intake, Requirements\.$/u);

  const build = pay.explanation.steps.find((step) => step.id === 'pay-build');
  assert.deepEqual(build.why, { text: 'Makes the payment change the requirements ask for.', from: 'description' });
  assert.equal(build.signOff, 'Nobody signs it off: it moves on when it is submitted.');
  assert.deepEqual(build.then, ['This is the last step.'], 'a step nobody signs off is never rejected');
  assert.deepEqual(build.skills.map((entry) => entry.id), ['pay-rules']);
  assert.deepEqual(build.instructions, ['pay-style']);
  assert.deepEqual(build.apiCalls.map((call) => call.host), ['jira.example.com']);

  const repository = result.repository.findings;
  assert.ok(repository.some((entry) => entry.code === 'CHECK_SKILL_UNUSED' && entry.subject.skill === 'orphan-skill'));
  assert.ok(repository.some((entry) => entry.code === 'CHECK_INSTRUCTION_UNUSED' && entry.subject.instruction === 'lonely'));
  assert.deepEqual(repository.filter((entry) => entry.code === 'CHECK_LINK_BROKEN').map((entry) => entry.detail.split(' ')[0]).sort(), ['../../docs/runbook.md', 'notes.md']);
  assert.ok(!repository.some((entry) => entry.code === 'CHECK_SKILL_UNUSED' && entry.subject.skill === 'pay-rules'));

  const text = flow(root, ['workflow', 'check', 'pay']).stdout;
  assert.match(text, /^Payments change \(pay\): 3 steps, 2 with a sign-off; changes code in Build the change\.$/mu);
  assert.match(text, /^ {2}3\. Build the change: Changes code and writes a summary/mu);
  assert.match(text, /^ {5}Why: Makes the payment change the requirements ask for\.$/mu);
  assert.match(text, /^ {2}problem {2}What Build the change produces can reach the end without a review {2}\(singularity\/workflow\.yml:\d+\)$/mu);
  assert.match(text, /^In all: 1 problem, \d+ warnings, \d+ notes\.$/mu);
});

test('steps shared with seeded workflows are not asked for a description they cannot take', async () => {
  const root = await paymentsRepository({ seeded: true });
  const pay = json(root, ['workflow', 'check', 'pay']).workflows[0];
  assert.deepEqual(pay.findings.filter((entry) => entry.code === 'CHECK_STEPS_UNDESCRIBED'), [],
    'Intake and Requirements are seeded and read-only; Build the change already says what it is for');
  const sole = json(root, ['workflow', 'check', 'pay', '--change-set', '-'], { input: changeSet([{ op: 'phase.update', id: 'pay-build', description: '' }]) }).workflows[0];
  assert.equal(sole.findings.find((entry) => entry.code === 'CHECK_STEPS_UNDESCRIBED').title, 'Build the change does not say what it is for');
});

test('a Studio change set is checked as it would leave the configuration, and nothing is written', async () => {
  const root = await paymentsRepository();
  const before = run('git', ['status', '--porcelain'], root).stdout;
  const fixed = json(root, ['workflow', 'check', 'pay', '--change-set', '-'], { input: changeSet([
    { op: 'phase.update', id: 'pay-build', approval: { group: 'engineering-reviewers', minimum: 1 } },
    { op: 'phase.update', id: 'intake', description: 'Captures what the payment change is and who asked for it.' }
  ]) });
  assert.equal(fixed.changeSet.valid, true);
  const pay = fixed.workflows[0];
  assert.ok(!pay.findings.some((entry) => entry.code === 'OBLIGATION_VERIFY_WITHOUT_REVIEW'), 'the sign-off answers the review problem');
  assert.equal(pay.explanation.steps[0].why.text, 'Captures what the payment change is and who asked for it.');
  assert.match(pay.explanation.steps[2].signOff, /^Signed off by one person from /u);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, before, 'checking a change set writes nothing');

  const stranded = json(root, ['workflow', 'check', 'pay', '--change-set', '-'], { input: changeSet([
    { op: 'phase.create', id: 'pay-notes', label: 'Release notes', output: 'document', inputs: [], approval: 'none', agent: 'pay-dev' },
    { op: 'phase.update', id: 'pay-build', approval: { group: 'engineering-reviewers', minimum: 1 } },
    { op: 'workflow.update', id: 'pay', phases: ['intake', 'requirements', 'pay-build', 'pay-notes'], decisions: [{
      id: 'pay-after', after: 'pay-build', kind: 'branch', label: 'Ship now?', inputs: [{ name: 'ship', values: ['yes', 'no'] }],
      routes: [{ id: 'ship', label: 'Ship', when: { ship: ['yes'] }, to: 'end' }, { id: 'hold', label: 'Hold', to: 'end' }] }] }
  ]) });
  const unreachable = stranded.workflows[0].findings.find((entry) => entry.code === 'WORKFLOW_PHASE_UNREACHABLE');
  assert.equal(unreachable.title, 'Nobody can reach Release notes');
  assert.deepEqual(unreachable.subject, { workflow: 'pay', step: 'pay-notes' });
  assert.ok(!stranded.workflows[0].findings.some((entry) => entry.code === 'CHECK_LAST_STEP_NO_SIGNOFF'), 'nothing more is said about a step nobody reaches');
  const decision = stranded.workflows[0].explanation.steps.find((step) => step.id === 'pay-build');
  assert.deepEqual(decision.then.slice(0, 3), ['Ship now? (Decided by the recorded answer):', 'Ship: the end.', 'Hold: the end.']);

  const refused = json(root, ['workflow', 'check', 'pay', '--change-set', '-'], { input: changeSet([
    { op: 'workflow.update', id: 'pay', decisions: [{ id: 'pay-size', after: 'intake', kind: 'branch', label: 'How big?', inputs: [{ name: 'size', values: ['small', 'large'] }],
      routes: [{ id: 'small', label: 'Small', when: { size: ['small'] }, to: 'pay-build' }, { id: 'large', label: 'Large', to: 'pay-build' }] }] }
  ]) });
  assert.deepEqual([refused.configuration.valid, refused.changeSet.valid, refused.counts.problem], [false, false, 1]);
  assert.match(refused.repository.findings[0].detail, /skips 'requirements', which 'pay-build' reads/u);
  assert.match(flow(root, ['workflow', 'check', 'pay', '--change-set', '-'], { input: changeSet([
    { op: 'workflow.update', id: 'pay', decisions: [{ id: 'pay-size', after: 'intake', kind: 'branch', label: 'How big?', inputs: [{ name: 'size', values: ['small', 'large'] }],
      routes: [{ id: 'small', label: 'Small', when: { size: ['small'] }, to: 'pay-build' }, { id: 'large', label: 'Large', to: 'pay-build' }] }] }
  ]) }).stdout, /^These changes cannot be applied yet, so nothing else was checked:$/mu);
});

test('an unknown workflow is refused by name, and the command is a read', async () => {
  const root = await repository();
  const refused = flow(root, ['workflow', 'check', 'no-such-workflow'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /There is no workflow 'no-such-workflow'/u);
  const { resolveOperation } = await import('../src/command-registry.mjs');
  const operation = resolveOperation({ requestedCommand: 'workflow', positionals: ['workflow', 'check'], options: {} });
  assert.deepEqual([operation.id, operation.classification, operation.modelPolicy], ['workflow.check', 'read', 'never']);
});

test('a step description: Studio writes and removes it, configuration checks it, and Stories never pin it', async () => {
  const YAML = (await import('yaml')).default;
  const root = await paymentsRepository();
  const workflowText = await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8');
  assert.equal(YAML.parse(workflowText).phases['pay-build'].description, 'Makes the payment change the requirements ask for.');
  const { loadDefinition, resolveWorkType, validateDefinition } = await import('../src/config.mjs');
  const resolved = resolveWorkType(await loadDefinition(root), 'pay');
  assert.equal(Object.hasOwn(resolved.phases.find((phase) => phase.id === 'pay-build'), 'description'), false, 'a Story pins the contract, not the explanation');
  const { buildStudioModel } = await import('../src/workflow-studio.mjs');
  const model = await buildStudioModel(root);
  assert.equal(model.workflows.find((entry) => entry.id === 'pay').steps.find((step) => step.id === 'pay-build').description, 'Makes the payment change the requirements ask for.');
  assert.equal(model.phases.find((phase) => phase.id === 'intake').description, '');

  const raw = YAML.parse(workflowText);
  raw.phases['pay-build'].description = 'x'.repeat(601);
  assert.throws(() => validateDefinition(raw), /Phase 'pay-build' description must be text of 1 to 600 characters\./u);
  const tooLong = json(root, ['workflow', 'studio', 'apply', '--change-set', '-', '--dry-run'], { input: changeSet([{ op: 'phase.update', id: 'intake', description: 'y'.repeat(601) }]) });
  assert.equal(tooLong.problems[0].code, 'STUDIO_DESCRIPTION_INVALID');
  const removed = json(root, ['workflow', 'studio', 'apply', '--change-set', '-', '--dry-run'], { input: changeSet([{ op: 'phase.update', id: 'pay-build', description: '' }]) });
  assert.equal(removed.valid, true, JSON.stringify(removed.problems));
  assert.match(removed.files[0].diff, /^-\s+description: Makes the payment change the requirements ask for\.$/mu);
  assert.deepEqual(removed.summary, ['Build the change: description changed.']);
});

test('Studio\'s own check keeps the step its warnings are about', async () => {
  const root = await repository();
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', '-', '--dry-run'], { input: changeSet(PAYMENTS) });
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  const warning = plan.warnings.find((entry) => entry.code === 'OBLIGATION_VERIFY_WITHOUT_REVIEW');
  assert.deepEqual([warning.subject, warning.step], [{ kind: 'workflow', id: 'pay' }, 'pay-build']);
});

test('the Studio board asks for a check of the draft and shows it: counts, findings by area, marks on steps, the step explained', async () => {
  const root = await paymentsRepository();
  const { buildStudioModel } = await import('../src/workflow-studio.mjs');
  const { WORKFLOW_STUDIO_SCRIPT } = await import(path.join(packageRoot, 'apps/vscode/src/views/workflow-studio-page.ts'));
  const model = await buildStudioModel(root);
  const posted = [];
  const listeners = {};
  const element = (tag) => ({ tag, attributes: {}, children: [], style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} }, textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; }, appendChild(child) { this.children.push(child); return child; }, addEventListener() {} });
  const document = { getElementById: () => null, createElement: element, createElementNS: (namespace, tag) => element(tag), createTextNode: (text) => ({ text }) };
  const window = { __sfVscode: { postMessage: (message) => posted.push(message) }, addEventListener(type, listener) { listeners[type] = listener; } };
  new Function('window', 'document', WORKFLOW_STUDIO_SCRIPT)(window, document);
  listeners.message({ data: { type: 'studio.model', model } });
  const page = window.__workflowStudio;
  const state = page.state();
  const text = (node) => [node.textContent ?? node.text ?? '', ...(node.children ?? []).map(text)].join(' ');
  const all = (node) => [node, ...(node.children ?? []).flatMap(all)];
  page.openWorkflowCanvas('pay');

  // An unchanged draft is checked as published; the answer is the engine's own.
  assert.equal(page.draftKey(), '');
  const about = page.aboutSection('pay', 'pay-build', state.draft.phases['pay-build'], false);
  const explain = all(about).find((node) => node.attributes?.['data-key'] === 'step-explain');
  assert.ok(explain, 'before a check the step offers one');
  const result = json(root, ['workflow', 'check', 'pay']);
  listeners.message({ data: { type: 'studio.check', workflow: 'pay', changeSet: '', result } });
  assert.equal(page.countWords(result.workflows[0].counts), page.countWords({ problem: 1, warning: 1, note: 3 }));
  assert.deepEqual(page.stepFindings('pay', 'pay-build').map((entry) => entry.code).sort(),
    ['CHECK_API_UNPROVIDED', 'CHECK_GUIDANCE_CONFLICT', 'CHECK_GUIDANCE_CONFLICT', 'OBLIGATION_VERIFY_WITHOUT_REVIEW']);
  assert.equal(page.stepMark(page.stepFindings('pay', 'pay-build')), 'problem');
  const panel = page.renderCheckPanel('pay');
  const shown = text(panel);
  assert.match(shown, /Does it make sense\?/u);
  assert.match(shown, /3 steps, 2 with a sign-off; changes code in Build the change\./u);
  for (const area of ['Flow', 'Guidance', 'Clarity', 'Across the repository']) assert.match(shown, new RegExp(area, 'u'));
  assert.ok(all(panel).some((node) => String(node.attributes?.['data-key'] ?? '').startsWith('finding-show-')), 'a finding about a step can show it');
  const explained = text(page.aboutSection('pay', 'pay-build', state.draft.phases['pay-build'], false));
  assert.match(explained, /Changes code and writes a summary/u);
  assert.match(explained, /Nobody signs it off: it moves on when it is submitted\./u);
  assert.match(explained, /What Build the change produces can reach the end without a review/u);

  // Editing the description is a draft change; the old check is then stale and says so.
  state.draft.phases.intake.description = 'Captures what the payment change is.';
  const changes = page.changeSetFrom(model, state.draft).changes;
  assert.deepEqual(changes, [{ op: 'phase.update', id: 'intake', description: 'Captures what the payment change is.' }]);
  assert.notEqual(page.draftKey(), '');
  assert.equal(page.freshCheck('pay'), null, 'a check of the published workflow does not describe the draft');
  assert.ok(all(page.renderCheckPanel('pay')).some((node) => node.attributes?.['data-key'] === 'check-stale'));
  assert.deepEqual(page.stepFindings('pay', 'pay-build'), [], 'stale findings mark nothing');
  posted.length = 0;
  page.requestCheck('pay');
  assert.deepEqual(posted, [{ type: 'studio.check', workflow: 'pay', changeSet: page.draftKey() }], 'the draft itself is what gets checked');
  // An answer for an older draft is dropped while a newer check is on its way.
  listeners.message({ data: { type: 'studio.check', workflow: 'pay', changeSet: '', result } });
  assert.equal(state.checks.pay.loading, true);
  listeners.message({ data: { type: 'studio.checkFailed', workflow: 'pay', changeSet: page.draftKey(), message: 'The check did not run.' } });
  assert.deepEqual([state.checks.pay.loading, state.checks.pay.error], [false, 'The check did not run.']);
  assert.match(text(page.renderCheckPanel('pay')), /The check did not run\./u);
});
