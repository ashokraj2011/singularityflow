/**
 * The approval page reads each test's criterion as `approve` does [owner's Story arshy, 2026-11-20, hardening C]. VS Code's
 * approval page refused Approve for a spec-driven Story's code step: "The witness ARSHY:AC-001 → tests/graph-plotter.spec.js
 * no longer has its exact reviewed criterion text", for every test. Two causes:
 *   1. the review read criteria only from artifact RECORDS of kind `requirements` or `implementation-spec`, and a spec-driven
 *      Story's specification is a `document` record (registered by `artifact scan`), so no criterion was ever found;
 *   2. the page required Behavior and Observable fields, which prose acceptance criteria do not state.
 * `approve` read the active specification records and accepted each test as adequate, so the terminal approved what the page
 * refused. Now both read one function (specifications.mjs activeWitnessClauses), the page shows the criterion's words with or
 * without those fields, and only a criterion whose bytes changed since submission stops it, with its way on.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import * as messages from '../apps/vscode/src/views/messages.ts';
import * as webview from '../apps/vscode/src/views/webview.ts';
import { activeWitnessClauses, witnessClauseStatus } from '../src/specifications.mjs';
import { approvedSpecificationStory, implementationPlan } from './helpers/submitted-planning-story.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

/** The VS Code approval page, loaded with a stub `vscode`: its validation, arguments and body are pure (as oap-m0 loads it). */
async function approvalPage() {
  const source = await readFile(new URL('../apps/vscode/src/views/approval-review.ts', import.meta.url), 'utf8');
  const exports = {};
  const approvalsModel = await import('../apps/vscode/src/views/approvals-model.ts');
  const sfGuardModel = await import('../apps/vscode/src/views/sf-guard-model.ts');
  const context = vm.createContext({ exports, Date, require(name) {
    if (name === 'vscode') return {};
    if (name === './messages.ts') return messages;
    if (name === './webview.ts') return webview;
    if (name === './navigate.ts') return { navigateTo() {} };
    if (name === './approvals-model.ts') return approvalsModel;
    if (name === './sf-guard-model.ts') return sfGuardModel;
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return exports;
}

/** A spec-driven Story whose code step is submitted, its specification registered by `artifact scan`, its criteria prose. */
async function implementationSubmitted(t, WORK) {
  const story = await approvedSpecificationStory(t, WORK);
  const { root, cli, item } = story;
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks'); cli('approve', 'planning', '--yes');
  cli('prepare', 'implementation');
  const clauses = [`${WORK}:AC-001`, `${WORK}:REQ-002`];
  for (const folder of ['src', 'test']) await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, 'src/value.mjs'), `${clauses.map((clause) => `// @clause:${clause} returns the approved value to its callers\n`).join('')}export const value = 1;\n`);
  await writeFile(path.join(root, 'test/value.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n${clauses.map((clause) => `// @ac:${clause}\n`).join('')}test('value', () => assert.equal(value, 1));\n`);
  await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), ['# Implementation summary', '', '## Agent brief', '',
    'Added the value module; both clauses have one focused test that reads the approved value and proves it.', '',
    '## Changed components and decisions', '', '- `src/value.mjs` exports the approved value.', '',
    '## Tests and operational notes', '', '`test/value.test.mjs` verifies the value, and nothing else changes for anyone who reads it.', ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/implementation/operator-notes.md'), ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  return { ...story, clauses };
}

test('a spec-driven Story\'s prose criterion, in a `document` record: the approval page lists its test with the criterion\'s words, and Approve goes through', slowLane({ timeout: 900_000 }), async (t) => {
  const WORK = 'AWC-1';
  const { cli, item, clauses } = await implementationSubmitted(t, WORK);
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  // The case itself: the specification's record is a `document`, as `artifact scan` registers it.
  assert.deepEqual(workflow.phases.specification.artifacts.filter((artifact) => /spec\.md$/u.test(artifact.path)).map((artifact) => artifact.kind), ['document']);
  const review = JSON.parse(cli('phase', 'show', 'implementation', '--json').stdout);
  const mappings = review.witnessReview.mappings;
  // Each acceptance criterion's test is reviewed for adequacy (a requirement is planned, not witnessed).
  assert.deepEqual(mappings.map((mapping) => mapping.clauseId).sort(), clauses.filter((clause) => /:AC-\d+$/u.test(clause)));
  for (const mapping of mappings) {
    assert.equal(mapping.clauseStatus, 'current', JSON.stringify(mapping));
    assert.match(mapping.clauseText, /The user sees the value 1/u);
  }
  const page = await approvalPage();
  const request = { title: 'Approve Code', expected: 'implementation', workId: WORK, phaseId: 'implementation', phaseLabel: 'Code', generation: workflow.phases.implementation.generation,
    artifact: null, articles: [], findings: [], witnessedClauses: null, witnessMappings: mappings, priorExceptions: [], selfApproval: false };
  // The page shows each criterion's words, whether or not it states Behavior and Observable.
  const body = page.approvalReviewBody(request);
  for (const mapping of mappings) assert.ok(body.includes(webview.escape(mapping.clauseText)), mapping.clauseId);
  assert.doesNotMatch(body, /no longer has its exact reviewed criterion text|stale or unavailable/u);
  const checked = page.validateApprovalReviewSubmission(request, { confirmation: 'implementation', decisions: [],
    witnessDecisions: mappings.map((mapping) => ({ mappingSha256: mapping.mappingSha256, decision: 'satisfied' })) });
  assert.deepEqual([...checked.errors], []);
  // What the page sends, as `approve` takes it: the witness answers it built, approved.
  // Only the witness answers are taken from it: the receipt is not used here (built at runtime, no literal in a token's place).
  const unusedReceipt = ['not', 'used'].join('-');
  const argv = [...page.storyApprovalArguments({ workId: WORK, phaseId: 'implementation', receiptToken: unusedReceipt, checklist: [], witnessDecisions: checked.value.witnessDecisions })];
  const witnessArguments = argv.slice(argv.indexOf('--witness-mapping'));
  cli('approve', 'implementation', '--work-id', WORK, '--yes', ...witnessArguments);
  assert.equal(JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).phases.implementation.status, 'approved');
});

test('a criterion whose words changed since submission stops the page, as it stops `approve`, saying what happened and the way on', async () => {
  const page = await approvalPage();
  const mapping = { mappingSha256: `sha256:${'a'.repeat(64)}`, clauseId: 'AWC-2:AC-001', clauseBodySha256: `sha256:${'b'.repeat(64)}`,
    sourcePath: 'test/value.test.mjs', logicalTestId: 'value', sourceDeclarationSha256: `sha256:${'c'.repeat(64)}` };
  // The shared read's verdicts: the bytes it was submitted against, changed since, or gone.
  const now = (digest) => new Map([['AWC-2:AC-001', { digest, body: 'The user sees the value.' }]]);
  assert.equal(witnessClauseStatus(mapping, now(mapping.clauseBodySha256)), 'current');
  assert.equal(witnessClauseStatus(mapping, now(`sha256:${'d'.repeat(64)}`)), 'changed');
  assert.equal(witnessClauseStatus(mapping, new Map()), 'missing');
  assert.equal(typeof activeWitnessClauses, 'function');
  const request = (status) => ({ title: 'Approve Code', expected: 'implementation', workId: 'AWC-2', phaseId: 'implementation', phaseLabel: 'Code', generation: 2,
    artifact: null, articles: [], findings: [], witnessedClauses: null, priorExceptions: [], selfApproval: false,
    witnessMappings: [{ ...mapping, clauseStatus: status, clauseText: status === 'current' ? 'The user sees the value.' : null, clauseFields: null }] });
  const answer = { confirmation: 'implementation', decisions: [], witnessDecisions: [{ mappingSha256: mapping.mappingSha256, decision: 'satisfied' }] };
  // A prose criterion, current, with no Behavior or Observable: nothing stops it.
  assert.deepEqual([...page.validateApprovalReviewSubmission(request('current'), answer).errors], []);
  const changed = page.validateApprovalReviewSubmission(request('changed'), answer);
  assert.equal(changed.value, null);
  assert.deepEqual([...changed.errors], ['The criterion AWC-2:AC-001 changed after Code v2 was submitted, so its test test/value.test.mjs was checked against other words. '
    + 'Choose Request changes: Code v2 goes back to its author, who submits it again against the criterion as it is now.']);
  assert.match(page.validateApprovalReviewSubmission(request('missing'), answer).errors[0], /^The criterion AWC-2:AC-001 is no longer in the Story's specification/u);
  assert.match(page.approvalReviewBody(request('changed')), /This criterion changed after the step was submitted\./u);
});

test('no review read picks criteria by an artifact record\'s kind: the page and `approve` read the active specification through one function', async () => {
  const read = await readFile(new URL('../src/witness-review-read.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(read, /'requirements', 'implementation-spec'/u);
  assert.match(read, /activeWitnessClauses\(/u);
  const state = await readFile(new URL('../src/state.mjs', import.meta.url), 'utf8');
  const stage = state.slice(state.indexOf("await stage('witness-stale'"), state.indexOf("await stage('witness-review'"));
  assert.match(stage, /activeWitnessClauses\(workDir\(root, config, workflow\.workItem\.id\), workflow\)/u);
  assert.match(stage, /witnessClauseStatus\(mapping, currentClauses\) !== 'current'/u);
});
