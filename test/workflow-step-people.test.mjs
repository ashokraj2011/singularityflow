/**
 * Who does what, where, in each step (src/workflow-step-people.mjs), and whether questions are asked
 * in the right steps (workflow-check.mjs questionPlacementFindings): on every packaged workflow, and on
 * a team's custom workflow like the one whose requirements approval had to run in the approver's own
 * terminal, which nobody knew until the agent said so mid-approval (2026-11-11).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { OWN_TERMINAL_STEPS } from '../src/person-step-catalog.mjs';
import { approverId, emptyPresenceChain, foldPresenceChain, nextPresenceEvent, PRESENCE_CHAIN_PATH, presenceChainText, presenceEventStatement } from '../src/presence/chain.mjs';
import { presenceNonce, statementText } from '../src/presence/statement.mjs';
import { STEP_PEOPLE_ITEMS, workflowStepPeople } from '../src/workflow-step-people.mjs';
import { softwarePresenceKey } from './helpers/presence-keys.mjs';

const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const WORKFLOW = 'singularity/workflow.yml';
const QUESTION_CODES = ['CHECK_SCOPE_NOT_CLARIFIED', 'CHECK_MARKERS_UNANSWERABLE', 'CHECK_CLARIFICATION_INVALID',
  'CHECK_QUESTIONS_SETTLED_BY_SCOPE', 'CHECK_CODE_STEP_ALWAYS_ASKS', 'CHECK_SOURCE_STEP_ASKS_ONLY_WHEN_NEEDED'];
const LINE_WORDS = ['Author:', 'Questions:', 'Review:', 'Approval:', 'Approvers:', 'Tests:', 'Sign-offs:'];

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function flow(root, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: path.join(root, '..', `${path.basename(root)}-builds`) }
  });
}
const json = (root, args) => {
  const result = flow(root, [...args, '--json']);
  return { status: result.status, stderr: result.stderr, report: JSON.parse(result.stdout) };
};

/** A starter repository; `change` edits the parsed workflow.yml or its text, and adds files. */
async function repository(change = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-people-'));
  await initializeDefinition(root);
  const file = path.join(root, WORKFLOW);
  const original = await readFile(file, 'utf8');
  const files = {};
  const edited = await change({ definition: YAML.parse(original), text: original, files, root });
  await writeFile(file, edited ?? original, 'utf8');
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text, 'utf8');
  }
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'People Checker'); git(root, 'config', 'user.email', 'people-checker@example.invalid');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'people');
  return root;
}

/**
 * A team's copy of Feature that leaves every question before the scope off, blocks on markers it
 * cannot answer, asks for markers in a template, makes its code step always ask and asks its test
 * step about the scope; and a second copy whose intake asks only when needed.
 */
async function teamRepository() {
  return repository(async ({ definition, files, root }) => {
    const fmly = structuredClone(definition.workTypes.feature);
    fmly.label = 'Family requirements flow';
    const overrides = fmly.phaseOverrides;
    overrides.intake = { ...(overrides.intake ?? {}), clarification: { mode: 'off' } };
    overrides.requirements = { ...overrides.requirements, clarification: { mode: 'off', markers: { mode: 'block' } } };
    overrides.design = { ...overrides.design, clarification: { mode: 'off' } };
    overrides.implementation = { ...overrides.implementation, clarification: { mode: 'required', maxQuestions: 3 } };
    overrides.verification = { ...overrides.verification, clarification: { mode: 'when-needed', maxQuestions: 3, topics: ['scope', 'acceptance criteria', 'environment'] } };
    fmly.templateOverrides = { ...fmly.templateOverrides, design: 'fmly/design.md' };
    const sources = structuredClone(definition.workTypes.feature);
    sources.label = 'Family sources flow';
    sources.phaseOverrides.intake = { clarification: { mode: 'when-needed', maxQuestions: 3, topics: ['problem', 'scope'] } };
    // Only the scope goes unasked: a warning, and the workflow stays valid.
    const quiet = structuredClone(definition.workTypes.feature);
    quiet.label = 'Family quiet flow';
    quiet.phaseOverrides.intake = { clarification: { mode: 'off' } };
    quiet.phaseOverrides.requirements = { ...quiet.phaseOverrides.requirements, clarification: { mode: 'off' } };
    definition.workTypes['fmly-quiet'] = quiet;
    definition.workTypes.fmly = fmly;
    definition.workTypes['fmly-sources'] = sources;
    files['singularity/templates/fmly/design.md'] = `${await readFile(path.join(root, 'singularity/templates/feature/design.md'), 'utf8')}\n`
      + 'Where the sources leave something open, write [NEEDS CLARIFICATION: <one question>] instead of guessing.\n';
    return YAML.stringify(definition);
  });
}

const byCode = (findings, code) => findings.filter((entry) => entry.code === code);

test('every packaged workflow: each step says who does what and where, and its questions sit in the right steps', async () => {
  const root = await repository();
  const { status, report, stderr } = json(root, ['workflow', 'check']);
  assert.equal(status, 0, stderr);
  assert.deepEqual([report.counts.problem, report.counts.warning], [0, 0],
    JSON.stringify(report.workflows.flatMap((entry) => entry.findings).filter((entry) => entry.severity !== 'note')));
  const questions = report.workflows.flatMap((workflow) => workflow.findings.filter((entry) => QUESTION_CODES.includes(entry.code))
    .map((entry) => [workflow.id, entry.code, entry.subject.step, entry.severity]));
  // Two packaged steps define the scope from the Story's own sources and ask only when needed: worth a note, never a problem.
  assert.deepEqual(questions.sort(), [
    ['findings-remediation', 'CHECK_SOURCE_STEP_ASKS_ONLY_WHEN_NEEDED', 'findings-intake', 'note'],
    ['quick-fix', 'CHECK_SOURCE_STEP_ASKS_ONLY_WHEN_NEEDED', 'intake', 'note']
  ]);
  for (const workflow of report.workflows) {
    for (const step of workflow.explanation.steps) {
      const people = step.people;
      assert.ok(people, `${workflow.id} ${step.id} has its map`);
      assert.deepEqual(people.lines.map((line) => line.split(' ')[0]), LINE_WORDS, `${workflow.id} ${step.id}`);
      assert.equal(people.approval.where === 'none', people.approval.mode === 'none', `${workflow.id} ${step.id}`);
      assert.equal(people.questions.asked, people.questions.mode !== 'off' && people.author.by !== 'sflow', `${workflow.id} ${step.id}`);
    }
  }
  assert.equal(STEP_PEOPLE_ITEMS.length, LINE_WORDS.length);

  // Feature: documents are approved in the chat; the code step only in the approver's own terminal when it
  // confirms evidence or decides a test result, as the guard's own person-step catalog says.
  const feature = report.workflows.find((entry) => entry.id === 'feature');
  const step = (id) => feature.explanation.steps.find((entry) => entry.id === id).people;
  assert.deepEqual([step('requirements').approval.where, step('requirements').approval.ownTerminalWhen], ['chat', []]);
  assert.deepEqual(step('requirements').approval.groups.map((group) => [group.id, group.status, group.canApprove]), [['product-approvers', 'auto', true]]);
  assert.deepEqual(step('requirements').questions.answeredBy, { groups: ['product-approvers'], where: 'chat-or-own-terminal' });
  const implementation = step('implementation');
  assert.deepEqual([implementation.author.by, implementation.author.agent.id, implementation.author.writesCode], ['agent', 'developer', true]);
  assert.deepEqual([implementation.review.reviewed, implementation.review.kind, implementation.review.reviewer.id], [true, 'code', 'sflow-source-reviewer']);
  assert.equal(implementation.approval.where, 'own-terminal-when-needed');
  assert.deepEqual(implementation.approval.ownTerminalWhen.map((entry) => [entry.reason, entry.ownTerminalStep]),
    [['evidence-sign-off', 'approval-evidence-confirmation'], ['test-decision', 'test-run-risk']]);
  const own = new Map(OWN_TERMINAL_STEPS.map((entry) => [entry.id, entry]));
  assert.ok(own.get('approval-evidence-confirmation').matches(['approve', 'implementation'], { 'confirm-evidence': true }));
  assert.ok(own.get('test-run-risk').matches(['decision', 'test-risk'], {}));
  assert.deepEqual(implementation.signOffs.map((entry) => [entry.kind, entry.methods, entry.where]), [['evidence', ['inspection', 'visual'], 'own-terminal']]);
  assert.deepEqual([implementation.tests.runs, implementation.tests.from], [true, 'found']);
  assert.match(implementation.approval.text, /^Approval: one person from Engineering reviewers \(its author may approve it\), in the chat with \/sf-approve, but only in the approver's own terminal when it also confirms/u);
  assert.equal(step('verification').approval.ownTerminalWhen.map((entry) => entry.reason).join(), 'test-decision', 'it runs the repository\'s tests');
  // A visual verification step answers for the visual sign-offs; its code step for inspections only.
  const figma = report.workflows.find((entry) => entry.id === 'figma-mobile').explanation.steps;
  assert.deepEqual(figma.filter((entry) => entry.people.signOffs.length).map((entry) => [entry.id, entry.people.signOffs[0].methods]),
    [['implementation', ['inspection']], ['visual-verification', ['visual']]]);
  // A step Singularity Flow builds asks nobody; a workflow that omits the scope owes that decision at its end.
  const lite = report.workflows.find((entry) => entry.id === 'poc-lite').explanation.steps;
  assert.deepEqual(lite.map((entry) => entry.people.author.by), ['sflow', 'sflow', 'sflow', 'sflow']);
  assert.deepEqual(lite.at(-1).people.signOffs, [{ kind: 'applicability', responsibility: 'scope', group: 'quality-reviewers', where: 'chat',
    text: 'before the Story finishes, someone from Quality reviewers records why scope does not apply (singularity-flow decision applicability, or /sf-decide)' }]);
  // A test step that reads the code step's receipt runs no tests itself.
  const classic = report.workflows.find((entry) => entry.id === 'classic-delivery').explanation.steps.find((entry) => entry.id === 'testing').people;
  assert.deepEqual([classic.tests.runs, classic.tests.from, classic.tests.evidenceFrom], [false, 'code-step', 'implementation']);
  // The specification's markers block, and it asks: nothing to report.
  const spec = report.workflows.find((entry) => entry.id === 'spec-driven-standard').explanation.steps.find((entry) => entry.id === 'specification').people;
  assert.deepEqual([spec.questions.mode, spec.questions.markersBlock, spec.questions.asked], ['required', true, true]);

  // validate carries the same map on each step it lists.
  const validated = json(root, ['workflow', 'validate', 'feature']);
  assert.equal(validated.status, 0, validated.stderr);
  assert.deepEqual(validated.report.workflows[0].roles.map((entry) => entry.people), feature.explanation.steps.map((entry) => entry.people));
});

test('a team\'s custom workflow: questions before the scope, markers nobody can answer, settled topics and an always-asking code step, each located', async () => {
  const root = await teamRepository();
  const lines = (await readFile(path.join(root, WORKFLOW), 'utf8')).split('\n');
  const fmlyLine = lines.findIndex((line) => line === '  fmly:') + 1;
  const { report } = json(root, ['workflow', 'check', 'fmly']);
  const [fmly] = report.workflows;
  const at = (entry) => lines[entry.location.line - 1].trim();
  const inFmly = (entry) => entry.location.file === WORKFLOW && entry.location.line > fmlyLine;

  const [scope] = byCode(fmly.findings, 'CHECK_SCOPE_NOT_CLARIFIED');
  assert.deepEqual([scope.severity, scope.area, scope.subject.step, scope.blocksStart, scope.stopsAt], ['warning', 'clarity', 'requirements', false, undefined]);
  assert.equal(scope.title, 'Nobody is asked about the scope before Requirements defines it');
  assert.match(scope.detail, /, and neither it nor any step before it \(Intake\) asks the person a question: clarification is off\./u);
  assert.match(scope.fix.text, /clarification: \{ mode: required, maxQuestions: 5, topics: \[scope, acceptance criteria, constraints\] \}/u);
  assert.ok(inFmly(scope) && at(scope) === 'mode: off', at(scope));
  // Each finding carries what a fixer applies: the setting's key path and line, and each change from its value to the new one.
  const override = (step, ...keys) => ['workTypes', 'fmly', 'phaseOverrides', step, 'clarification', ...keys];
  const line = (...keys) => scope.fix.data.edits.find((edit) => edit.path.join('.') === override('requirements', ...keys).join('.'))?.line;
  assert.deepEqual({ ...scope.fix.data, edits: scope.fix.data.edits.map(({ line: _line, ...edit }) => edit), alternatives: scope.fix.data.alternatives.map((entry) => entry.id),
    setting: { ...scope.fix.data.setting, line: undefined } }, {
    step: 'requirements', workflow: 'fmly', file: WORKFLOW, decidedBy: 'fixer', question: null, earlierSteps: ['intake'],
    setting: { path: override('requirements'), line: undefined, scope: 'workflow', sharedWith: [], workflowPath: override('requirements') },
    edits: [{ path: override('requirements', 'mode'), from: 'off', to: 'required' },
      { path: override('requirements', 'topics'), from: null, to: ['scope', 'acceptance criteria', 'constraints'] }],
    alternatives: ['when-needed']
  });
  assert.equal(line('mode'), scope.location.line);

  const markers = byCode(fmly.findings, 'CHECK_MARKERS_UNANSWERABLE');
  assert.deepEqual(markers.map((entry) => [entry.subject.step, entry.severity, entry.stopsAt ?? null]), [
    ['requirements', 'problem', { step: 'requirements', when: 'publication' }],
    ['design', 'problem', null]
  ]);
  assert.ok(inFmly(markers[0]) && at(markers[0]) === 'markers:', at(markers[0]));
  assert.match(markers[0].detail, /no answer can ever be recorded/u);
  // On the scope step nobody is asked about, its fix is the scope finding's own change; markers can also be eased instead.
  assert.deepEqual(markers[0].fix.data.edits.map((edit) => [edit.path.at(-1), edit.from, edit.to]), [['mode', 'off', 'required']]);
  assert.match(markers[0].fix.text, /^Turn clarification on for Requirements: clarification: \{ mode: required, maxQuestions: 5, markers: \{ mode: block \} \}; or set its markers mode to warn or off\.$/u);
  assert.deepEqual(markers[0].fix.data.alternatives.map((entry) => [entry.id, entry.edits[0].from, entry.edits[0].to]),
    [['markers-warn', { mode: 'block' }, { mode: 'warn' }], ['markers-off', { mode: 'block' }, { mode: 'off' }]]);
  assert.deepEqual(markers[1].fix.data.edits.map((edit) => [edit.path.at(-1), edit.from, edit.to]), [['mode', 'off', 'when-needed']]);
  assert.deepEqual(markers[1].fix.data.template, markers[1].related[0]);
  const template = (await readFile(path.join(root, 'singularity/templates/fmly/design.md'), 'utf8')).split('\n');
  assert.deepEqual(markers[1].related, [{ file: 'singularity/templates/fmly/design.md', line: template.findIndex((line) => line.includes('[NEEDS CLARIFICATION')) + 1 }]);
  assert.equal(markers[1].title, "Architecture and design's template asks for [NEEDS CLARIFICATION] markers that nobody can answer");

  const [settled] = byCode(fmly.findings, 'CHECK_QUESTIONS_SETTLED_BY_SCOPE');
  assert.deepEqual([settled.severity, settled.subject.step], ['warning', 'verification']);
  assert.equal(settled.title, 'Verification asks about scope and acceptance criteria, which the approved scope already settles');
  assert.match(settled.fix.text, /topics: \[test gaps, environment, evidence, deviations\]/u);
  assert.deepEqual([settled.fix.data.drop, settled.fix.data.suggested, settled.fix.data.scopeStep], [['scope', 'acceptance criteria'], ['test gaps', 'environment', 'evidence', 'deviations'], 'implementation-spec']);
  assert.deepEqual(settled.fix.data.edits.map((edit) => [edit.path.join('.'), edit.from, edit.to]),
    [[override('verification', 'topics').join('.'), ['scope', 'acceptance criteria', 'environment'], ['environment', 'test gaps', 'evidence', 'deviations']]]);
  assert.ok(inFmly(settled) && at(settled) === 'topics:', at(settled));

  const [code] = byCode(fmly.findings, 'CHECK_CODE_STEP_ALWAYS_ASKS');
  assert.deepEqual([code.severity, code.subject.step], ['warning', 'implementation']);
  assert.ok(inFmly(code) && at(code) === 'mode: required', at(code));
  assert.deepEqual(code.fix.data.edits.map((edit) => [edit.path.join('.'), edit.line, edit.from, edit.to]), [[override('implementation', 'mode').join('.'), code.location.line, 'required', 'when-needed']]);
  assert.deepEqual(byCode(fmly.findings, 'CHECK_SOURCE_STEP_ASKS_ONLY_WHEN_NEEDED'), []);
  assert.ok(fmly.findings.filter((entry) => QUESTION_CODES.includes(entry.code)).every((entry) => entry.blocksStart === false));

  // The map says it too: nobody is asked at Requirements, and a marker stops its publication.
  const requirements = fmly.explanation.steps.find((entry) => entry.id === 'requirements').people;
  assert.deepEqual([requirements.questions.mode, requirements.questions.asked, requirements.questions.markersBlock, requirements.questions.answeredBy],
    ['off', false, true, null]);
  assert.match(requirements.questions.text, /^Questions: asks no questions \(off\)\. An unanswered \[NEEDS CLARIFICATION\] marker in its document stops its publication\.$/u);

  // The second copy defines its scope from an intake that asks only when needed: a note, nothing more.
  const sources = json(root, ['workflow', 'check', 'fmly-sources']).report.workflows[0];
  assert.deepEqual(sources.findings.filter((entry) => QUESTION_CODES.includes(entry.code)).map((entry) => [entry.code, entry.subject.step, entry.severity]),
    [['CHECK_SOURCE_STEP_ASKS_ONLY_WHEN_NEEDED', 'intake', 'note']]);
  // Whether to confirm the reading every time is the team's call: the fixer asks a person.
  const choice = sources.findings.find((entry) => entry.code === 'CHECK_SOURCE_STEP_ASKS_ONLY_WHEN_NEEDED').fix.data;
  assert.deepEqual([choice.decidedBy, choice.edits, choice.question.choices.map((entry) => [entry.id, entry.edits.map((edit) => [edit.from, edit.to])])],
    ['person', [], [['required', [['when-needed', 'required']]], ['when-needed', []]]]);

  // A scope nobody is asked about is a warning: a workflow that runs today stays valid.
  const quiet = json(root, ['workflow', 'validate', 'fmly-quiet']);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.deepEqual([quiet.report.valid, quiet.report.workflows[0].findings.filter((entry) => QUESTION_CODES.includes(entry.code)).map((entry) => [entry.code, entry.severity, entry.fix.data.decidedBy])],
    [true, [['CHECK_SCOPE_NOT_CLARIFIED', 'warning', 'fixer']]]);

  // validate: not valid, every question finding listed with why and how to fix it, and who does what in each step.
  const validated = flow(root, ['workflow', 'validate', 'fmly']);
  assert.equal(validated.status, 1, validated.stderr);
  assert.match(validated.stdout, /^ {2}warning {2}Nobody is asked about the scope before Requirements defines it {2}\(singularity\/workflow\.yml:\d+\)$/mu);
  assert.match(validated.stdout, /^ {2}warning {2}Implementation stops for a person's answer before every change {2}\(singularity\/workflow\.yml:\d+\)$/mu);
  assert.match(validated.stdout, /^Who does what, where, in Family requirements flow \(fmly\):$/mu);
  assert.match(validated.stdout, /^ {5}Approval: one person from Product approvers \(its author may approve it\), in the chat with \/sf-approve/mu);
  const checked = flow(root, ['workflow', 'check', 'fmly']);
  assert.match(checked.stdout, /^ {5}Who does what, where:\n {7}Author: Product owner \(an agent\) drafts it, or a person writes it\. It changes no code\.$/mu);
});

test('a questions setting that does not load is named at its own line, for the step and the workflow that set it', async () => {
  let verificationLine = 0;
  let quickFixLine = 0;
  let designLine = 0;
  const root = await repository(({ text }) => {
    const verification = '    clarification: { mode: when-needed, maxQuestions: 3, topics: [test gaps, environment, evidence, deviations] }';
    const quickFix = '        clarification: { mode: when-needed, maxQuestions: 3, topics: [acceptance criteria, changed paths, tests] }';
    assert.ok(text.includes(verification) && text.includes(quickFix));
    const edited = text.replace(verification, verification.replace('mode: when-needed, maxQuestions: 3', 'mode: required, maxQuestions: 0'))
      .replace(quickFix, quickFix.replace('mode: when-needed', 'mode: sometimes'));
    const typo = '      maxQuestions: 5\n      topics: [boundaries, contracts';
    assert.ok(edited.includes(typo));
    const misspelled = edited.replace(typo, typo.replace('maxQuestions', 'maxQuestion'));
    const lines = misspelled.split('\n');
    designLine = lines.findIndex((line) => line === '      maxQuestion: 5') + 1;
    verificationLine = lines.findIndex((line) => line.includes('mode: required, maxQuestions: 0')) + 1;
    quickFixLine = lines.findIndex((line) => line.includes('mode: sometimes')) + 1;
    return misspelled;
  });
  const { report } = json(root, ['workflow', 'check']);
  assert.equal(report.configuration.valid, false);
  assert.deepEqual(report.repository.findings.map((entry) => [entry.code, entry.subject.step, entry.subject.workflow ?? null, entry.location?.line, entry.blocksStart]), [
    ['CHECK_CLARIFICATION_INVALID', 'design', null, designLine, true],
    ['CHECK_CLARIFICATION_INVALID', 'verification', null, verificationLine, true],
    ['CHECK_CLARIFICATION_INVALID', 'intake', 'quick-fix', quickFixLine, true]
  ], 'the validator\'s bare refusal is replaced, never shown twice');
  const [typo, maximum, mode] = report.repository.findings;
  // A misspelled field: a person says what was meant, the near field offered first.
  assert.equal(typo.detail, "Its clarification has a field 'maxQuestion' this release does not know; it knows mode, maxQuestions, topics and markers.");
  assert.deepEqual([typo.fix.data.decidedBy, typo.fix.data.question.choices.map((entry) => [entry.id, entry.edits.map((edit) => [edit.path.at(-1), edit.from, edit.to, edit.remove ?? false])])],
    ['person', [['rename', [['maxQuestion', 5, null, true], ['maxQuestions', null, 5, false]]], ['remove', [['maxQuestion', 5, null, true]]]]]);
  // A step's own setting: every workflow that uses it without an override shares the change.
  assert.deepEqual([maximum.fix.data.decidedBy, maximum.fix.data.setting.scope, maximum.fix.data.setting.sharedWith.includes('feature'), maximum.fix.data.edits.map((edit) => [edit.path.join('.'), edit.line, edit.from, edit.to])],
    ['fixer', 'step', true, [['phases.verification.clarification.maxQuestions', verificationLine, 0, 5]]]);
  assert.deepEqual([mode.fix.data.decidedBy, mode.fix.data.setting.scope, mode.fix.data.question.choices.map((entry) => [entry.id, entry.edits[0].from, entry.edits[0].to])],
    ['person', 'workflow', [['off', 'sometimes', 'off'], ['when-needed', 'sometimes', 'when-needed'], ['required', 'sometimes', 'required']]]);
  assert.equal(maximum.detail, 'Its clarification is required but may ask at most 0 questions, so it must stop for an answer it can never ask for.');
  assert.equal(mode.title, 'The questions setting of Scope and plan cannot be read');
  assert.match(mode.fix.text, /^Set Scope and plan's clarification mode to off, when-needed or required\.$/u);
  const validated = flow(root, ['workflow', 'validate']);
  assert.equal(validated.status, 1);
  assert.match(validated.stdout, /^The workflow configuration cannot be read until these are fixed:\n {2}problem {2}The questions setting of Architecture and design cannot be read/mu);
  assert.match(validated.stdout, /^ {11}Fix: Rename 'maxQuestion' in Architecture and design's clarification to maxQuestions, or remove it\.$/mu);
});

/** SF Guard's policy chain with one approver's presence key registered and the guard turned on, every event signed. */
function enabledPresenceChain(email) {
  const key = softwarePresenceKey();
  const approver = approverId({ email });
  const chain = emptyPresenceChain();
  const signed = (fields) => {
    const event = nextPresenceEvent(chain, fields);
    const entry = { signer: approver, keyId: key.keyId, nonce: presenceNonce() };
    event.signatures.push({ ...entry, signature: key.sign(statementText(presenceEventStatement(chain.chainId, event, entry))) });
    chain.events.push(event);
  };
  signed({ kind: 'register', approver, keyId: key.keyId, key: key.line,
    github: { listed: true, snapshotSha256: `sha256:${'0'.repeat(64)}`, fetchedAt: new Date().toISOString() } });
  signed({ kind: 'enable', remoteCheck: null, exceptions: [] });
  return chain;
}

test('with SF Guard on, every approval is signed in the approver\'s own terminal, and the map says so', async () => {
  const chain = enabledPresenceChain('people-checker@example.invalid');
  const folded = foldPresenceChain(chain);
  assert.deepEqual([folded.enabled, folded.problems], [true, []], 'the fixture chain verifies as the guard reads it');
  const root = await repository(({ files }) => { files[PRESENCE_CHAIN_PATH] = presenceChainText(chain); });
  const { status, report, stderr } = json(root, ['workflow', 'check', 'feature']);
  assert.equal(status, 0, stderr);
  assert.equal(report.sfGuard, 'on');
  const steps = report.workflows[0].explanation.steps;
  for (const step of steps) {
    const approval = step.people.approval;
    assert.equal(approval.sfGuard, 'on', step.id);
    assert.equal(approval.where, 'own-terminal', step.id);
    assert.deepEqual(approval.ownTerminalWhen[0], { reason: 'sf-guard', ownTerminalStep: null, command: `singularity-flow approve ${step.id} --work-id <WORK-ID>`,
      text: 'always: SF Guard is on, so every approval is signed there' });
    assert.match(approval.text, /^Approval: one person from [^.]*\(its author may approve it\)\. SF Guard is on: every approval is signed in the approver's own terminal \(the chat and VS Code hand them the command\)\.$/u, step.id);
  }
  // The code step still names what else its approver decides there.
  assert.deepEqual(steps.find((step) => step.id === 'implementation').people.approval.ownTerminalWhen.map((entry) => entry.reason), ['sf-guard', 'evidence-sign-off', 'test-decision']);
  // Without the policy file nothing is read, and approvals stay in the chat.
  const off = json(await repository(), ['workflow', 'check', 'feature']).report;
  assert.deepEqual([off.sfGuard, off.workflows[0].explanation.steps[0].people.approval.where], ['off', 'chat']);
});

test('the map reads people from the groups and producers a step really has', () => {
  const resolved = {
    phases: [{ id: 'sign', generation: { allowedProducers: ['human'], defaultProducer: 'human' },
      clarification: { mode: 'required', maxQuestions: 2, topics: [], markers: { mode: 'warn' } },
      approval: { mode: 'required', authorities: ['g1', 'g2', 'g3', 'g4'], minimum: 2, requiredAuthorities: ['g1'], allowSelfApproval: false } }],
    approvalAuthorities: {
      g1: { label: 'Leads', members: [{ email: 'lead@example.invalid' }, { email: 'deputy@example.invalid' }], githubTeams: [], allowAnyGitIdentity: false },
      g2: { label: 'Anyone', members: [], githubTeams: [], allowAnyGitIdentity: true },
      g3: { label: 'Team', members: [], githubTeams: ['@example/reviewers'], allowAnyGitIdentity: false },
      g4: { label: 'Empty', members: [], githubTeams: [], allowAnyGitIdentity: false }
    },
    approvalSecurity: { allowAnyGitIdentity: false, autoEnrollNewIdentities: false },
    sourceReview: { mode: 'off', phases: [], reviewerAgent: null },
    obligationGraph: { nodes: [], endpoints: [] }
  };
  const workflow = { steps: [{ id: 'sign', label: 'Sign', output: 'document', agent: 'writer' }] };
  const people = workflowStepPeople({ agents: [{ id: 'writer', label: 'Writer' }] }, workflow, resolved).get('sign');
  assert.deepEqual([people.author.by, people.author.personMayWrite], ['person', false]);
  assert.equal(people.questions.asked, false, 'only an agent\'s draft is asked about');
  assert.match(people.questions.text, /Nobody asks, though: no agent drafts it\. An unanswered \[NEEDS CLARIFICATION\] marker in its document is a warning at publication\.$/u);
  assert.deepEqual(people.approval.groups.map((group) => [group.status, group.canApprove]), [['people', true], ['anyone', true], ['teams', true], ['blocked', false]]);
  assert.equal(people.approval.text, 'Approval: 2 people from Leads, Anyone, Team or Empty, including someone from Leads (someone other than its author approves it), '
    + 'in the chat with /sf-approve (or VS Code\'s Approve, or the approver\'s own terminal).');
  assert.equal(people.approval.groupsText, 'Approvers: Leads: 2 people; Anyone: any Git identity; Team: the members of @example/reviewers; '
    + 'Empty: nobody (no people, no teams, and nobody is added automatically), so nobody can approve.');
  assert.deepEqual([people.review.reviewed, people.review.reason], [false, 'review-off']);
  assert.equal(workflowStepPeople({ agents: [] }, workflow, null).size, 0, 'a workflow that does not resolve has no map');
  // A policy chain that cannot be read here is said, and nothing is claimed about signatures.
  const unread = workflowStepPeople({ agents: [] }, workflow, resolved, { sfGuard: 'unknown' }).get('sign').approval;
  assert.deepEqual([unread.sfGuard, unread.where], ['unknown', 'chat']);
  assert.match(unread.text, / SF Guard's policy cannot be read here, so whether approvals are signed is not known\.$/u);
});
