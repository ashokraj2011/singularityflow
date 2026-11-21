/**
 * What an approval shows a person, on a spec-driven Story like the owner's arshy (owner, 2026-11-21: "Too many approvals
 * of almost similar documents is an issue", then "Yes and tell reviewer what to check"). Real Stories on the real CLI:
 *
 * - every approval opens with "What needs your eyes": a changed file, the reviewer's finding and a weak test each named
 *   at its file and line or requirement row, and one "checked by SFlow" line for the rest;
 * - a section already approved folds to one line, agent briefs are one line ("generated from the plan"), and version 2
 *   shows only what changed since the person approved version 1;
 * - SFlow writes the verification evidence and the release conformance report from its records, and both pass every
 *   gate to the Story's end.
 *
 * The words a person is shown per approval, before and after, are printed as test diagnostics.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import * as messages from '../apps/vscode/src/views/messages.ts';
import * as webview from '../apps/vscode/src/views/webview.ts';
import { approvedSpecificationStory, implementationPlan } from './helpers/submitted-planning-story.mjs';
import { codeReport, retainStepReview, reviewStep } from './helpers/step-review.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { completeAgentResult } from '../src/agent-output.mjs';
import { approvalFocusMarkdown, comparableLine, focusSections, lineDiff, wordCount } from '../src/approval-focus.mjs';
import { writtenBySflow } from '../src/record-documents.mjs';

// The shipped spec-driven review, every authored step reviewed (the fixture turns it off).
const REVIEWED = (configuration) => {
  configuration.workTypes['spec-driven-standard'].spec.coverage = 'record';
  configuration.workTypes['spec-driven-standard'].sourceReview = { mode: 'enforce', phases: ['specification', 'planning'], reviewerAgent: 'sflow-source-reviewer' };
};
const agent = (result) => completeAgentResult(JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))));

async function reviewedStory(t, W) {
  const story = await approvedSpecificationStory(t, W, { configure: REVIEWED, review: async (phase, step) => reviewStep((args) => JSON.parse(step.cli(...args).stdout), phase) });
  const json = (...args) => JSON.parse(story.cli(...args).stdout);
  const write = async (relative, text) => {
    await mkdir(path.dirname(path.join(story.root, relative)), { recursive: true });
    await writeFile(path.join(story.root, relative), text);
  };
  return { ...story, json, write, review: (phase) => reviewStep((args) => json(...args), phase) };
}

async function submitPlan(story, W, plan = implementationPlan(W), { successor = false } = {}) {
  const { cli, item, json } = story;
  // A returned step's next version opens on the person's yes, through its rollover preview.
  if (successor) cli('phase', 'rollover', 'planning', '--confirm', json('phase', 'rollover', 'planning', '--json').confirmation, '--json');
  else cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), plan);
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  story.review('planning');
  cli('submit', 'planning');
}

/** The code: AC-001 has a test that asserts and one that asserts nothing (a weak test); the summary restates the plan's approach. */
async function submitCode(story, W, { finding = true } = {}) {
  const { cli, item, json } = story;
  cli('prepare', 'implementation');
  await story.write('src/value.mjs', `// @clause:${W}:AC-001 returns the approved value to its callers\n// @clause:${W}:REQ-002 the application returns that same approved value\nexport const value = 1;\n`);
  await story.write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value } from '../src/value.mjs';",
    `// @ac:${W}:AC-001`, "test('reads the value', () => assert.equal(value, 1));", `// @ac:${W}:AC-001`, "test('returns the value', () => { void value; });", ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), ['# Implementation summary', '', '## Agent brief', '',
    'Added the value module; both clauses are bound to it in source.', '',
    '## Approach', '', 'Export a constant from the value module and assert it in a unit test.', '',
    '## Changed components and decisions', '', '- `src/value.mjs` exports the approved value; nothing else needed changing.', '',
    '## Tests and operational notes', '', '`test/value.test.mjs` holds both tests; nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  const context = json('review-source', 'context', 'implementation', '--json');
  const value = context.sources.find((entry) => entry.path === 'src/value.mjs');
  retainStepReview((args) => json(...args), 'implementation', codeReport(context, { findings: finding ? [{ id: 'name-the-callers', severity: 'advisory', check: 'quality',
    message: 'Say which callers read the value, so a later change knows who it affects.', sourceId: value.id, line: 1, quote: `// @clause:${W}:AC-001` }] : [] }));
  cli('submit', 'implementation');
}

const kinds = (focus) => focus.eyes.items.map((item) => item.kind);

/** The VS Code approval page, with a stub `vscode`, as review-finding-dispute.test.mjs loads it. */
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
const measured = [];
function measure(t, step, focus) {
  measured.push({ step, full: focus.words.full, shown: focus.words.shown });
  t.diagnostic(`words shown at the ${step} approval: ${focus.words.shown} of ${focus.words.full} before`);
  for (const document of focus.documents) t.diagnostic(`  ${document.line}: ${document.words.shown} of ${document.words.full}`);
  t.diagnostic(`  What needs your eyes: ${focus.eyes.items.length} items`);
}

test('section folding and diffs read the document a person approved, line by line', () => {
  const v1 = ['# Plan', '', '## Approach', '', 'We add the value module and export one constant to callers.', '',
    '## Test strategy', '', 'A unit test reads the value and asserts it equals one.', '', '## Risks and rollback', '', 'Rolling back removes the module; no data changes at all.', ''].join('\n');
  const v2 = v1.replace('asserts it equals one.', 'asserts it equals two.\nA second test checks the error path returns nothing.');
  const sections = focusSections(v2, { previous: v1, previousLabel: 'Planning v1' });
  assert.deepEqual(sections.map((section) => [section.title, section.state]), [['Approach', 'unchanged'], ['Test strategy', 'changed'], ['Risks and rollback', 'unchanged']]);
  assert.equal(sections[0].folded, 'already approved in Planning v1');
  assert.deepEqual(sections[1].diff.map((entry) => `${entry.op} ${entry.text}`), ['- A unit test reads the value and asserts it equals one.',
    '+ A unit test reads the value and asserts it equals two.', '+ A second test checks the error path returns nothing.']);
  // A section another approved document already says, word for word, folds to where it was approved.
  const approved = new Map([[comparableLine('Rolling back removes the module; no data changes at all.'), 'Planning v1']]);
  assert.deepEqual(focusSections(v1, { approved }).map((section) => section.state), ['new', 'new', 'restated']);
  assert.deepEqual(lineDiff([], [{ n: 1, text: 'only' }]), [{ op: '+', text: 'only', line: 1 }]);
  assert.equal(wordCount('Two words'), 2);
});

test('an arshy-like spec-driven Story: each approval says what needs the person\'s eyes and shows only what is new, and SFlow writes its record documents', slowLane({ timeout: 900_000 }), async (t) => {
  const W = 'ARSHY-1';
  const story = await reviewedStory(t, W);
  const { cli, item, root, json } = story;

  // Planning, with the specification it covers: the three downstream briefs are one line each, and the plan's test table,
  // which restates the specification's, folds to it.
  await submitPlan(story, W);
  const planning = json('phase', 'show', 'planning', '--json').approvalFocus;
  assert.equal(planning.eyes.title, 'What needs your eyes');
  const briefs = planning.documents.filter((document) => document.kind === 'brief');
  assert.equal(briefs.length, 3, 'implementation, convergence and verification each get a brief of the plan');
  for (const brief of briefs) assert.match(brief.line, /: generated from the plan$/u);
  const plan = planning.documents.find((document) => document.step === 'planning' && document.kind === 'document');
  assert.equal(plan.sections.find((section) => section.title === 'Test strategy').folded, 'already approved in Specification v1');
  assert.ok(planning.documents.some((document) => document.covered && document.step === 'specification'), 'the covered specification is read here');
  assert.match(planning.eyes.checked, /^checked by SFlow: .*3 agent briefs generated from the plan/u);
  measure(t, 'planning', planning);
  // Copilot's packet leads with it, links its page, and pastes no section or diff.
  const packet = agent(cli('choices', 'begin', 'approve', W, '--for-agent', '--json', '--review-packet'));
  assert.equal(packet.act.read[0], 'approvalPacket.review.approvalFocus');
  assert.match(packet.act.ask.how, /^Lead with approvalPacket\.review\.approvalFocus: eyes\.title as a heading/u);
  const shown = packet.approvalPacket.review.approvalFocus;
  assert.ok(shown.documents.every((document) => (document.sections ?? []).every((section) => section.text === undefined && section.diff === undefined)), 'no section text for a chat');
  const page = await readFile(path.join(root, shown.page.path), 'utf8');
  assert.match(page, /^# What needs your eyes\n/u);
  assert.match(page, /- Already approved in Specification v1: Test strategy/u);
  cli('approve', 'planning', '--yes');

  // Implementation: the reviewer's finding, a changed file and the weak test, each at its file and line or requirement row;
  // the summary's restated approach folds to the plan. The terminal's approve leads with the same list.
  await submitCode(story, W);
  const code = json('phase', 'show', 'implementation', '--json').approvalFocus;
  const finding = code.eyes.items.find((entry) => entry.kind === 'finding');
  assert.deepEqual(finding.at, { path: 'src/value.mjs', line: 1, finding: 'name-the-callers' });
  assert.match(finding.words, /Say which callers read the value/u);
  const changed = code.eyes.items.find((entry) => entry.kind === 'changed' && entry.at.path === 'src/value.mjs');
  assert.match(changed.words, /^src\/value\.mjs: added \(\+3 −0\)\.$/u);
  const weak = code.eyes.items.find((entry) => entry.kind === 'weak-test');
  assert.equal(weak.at.requirement, `${W}:AC-001`);
  assert.equal(weak.at.path, `singularity/work-items/${W}/artifacts/specification/spec.md`, 'the requirement row, in the specification');
  assert.ok(Number.isInteger(weak.at.line));
  assert.match(weak.words, /'returns the value'.* asserts nothing/u);
  assert.ok(kinds(code).indexOf('finding') < kinds(code).indexOf('weak-test') && kinds(code).indexOf('weak-test') < kinds(code).indexOf('changed'), kinds(code).join(', '));
  assert.ok(code.eyes.items.length >= 3 && code.eyes.items.length <= 8);
  const summary = code.documents.find((document) => document.step === 'implementation' && document.kind === 'document');
  assert.equal(summary.sections.find((section) => section.title === 'Approach').folded, 'already approved in Planning v1');
  measure(t, 'implementation', code);
  const terminal = cli('approve', 'implementation', '--yes').stdout;
  assert.ok(terminal.indexOf('What needs your eyes') >= 0 && terminal.indexOf('What needs your eyes') < terminal.indexOf('Test evidence:'), terminal.slice(0, 2000));
  assert.match(terminal, /E1\. Reviewer's note name-the-callers: .*\[src\/value\.mjs:1\]/u);

  cli('prepare', 'convergence');
  cli('phase', 'publish', 'convergence', '--authored', 'deterministic', '--channel', 'kernel-generator');
  cli('story', 'advance', '--work-id', W, '--confirm', json('story', 'advance', '--work-id', W, '--json').confirmationDigest);
  measure(t, 'convergence', json('phase', 'show', 'convergence', '--json').approvalFocus);
  cli('approve', 'convergence', '--yes');

  // Verification: SFlow wrote its evidence from its records; it passes publication, its review and submission untouched,
  // and the approval shows it as one line.
  cli('prepare', 'verification');
  const evidenceFile = path.join(item, 'artifacts/verification/test-evidence.md');
  const evidence = await readFile(evidenceFile, 'utf8');
  assert.ok(await writtenBySflow(evidence), 'sealed as SFlow\'s');
  assert.doesNotMatch(evidence, /\bTODO\b/u);
  assert.match(evidence, new RegExp(`\\| \`${W}:AC-001\` \\| 'reads the value' in test/value\\.test\\.mjs, run \`TA-[a-f0-9]{20}\`: passed;`, 'u'));
  assert.match(evidence, /- Tests: .*'returns the value'.* asserts nothing/u);
  cli('phase', 'publish', 'verification', '--authored', 'human', '--channel', 'manual-in-place');
  assert.ok(await writtenBySflow(await readFile(evidenceFile, 'utf8')), 'still SFlow\'s after publication wrote it again');
  story.review('verification');
  cli('submit', 'verification');
  const verification = json('phase', 'show', 'verification', '--json').approvalFocus;
  const record = verification.documents.find((document) => document.kind === 'record');
  assert.equal(record.line, 'Verification v1: written by SFlow from its records; checked by SFlow, kept for audit');
  assert.ok(record.words.shown < record.words.full / 5);
  // The weak test still needs the person's eyes here: SFlow wrote the record, it did not judge the test.
  assert.ok(verification.eyes.items.some((entry) => entry.kind === 'weak-test' && entry.at.requirement === `${W}:AC-001`), JSON.stringify(verification.eyes));
  measure(t, 'verification', verification);
  cli('approve', 'verification', '--yes');

  // Release: SFlow wrote the conformance report and its evidence index; every gate passes and the Story ends.
  cli('prepare', 'release');
  const report = await readFile(path.join(item, 'artifacts/release/conformance.md'), 'utf8');
  assert.ok(await writtenBySflow(report));
  assert.match(report, new RegExp(`\\| \`${W}:AC-001\` \\| .+ \\| matched \\|`, 'u'));
  assert.match(report, new RegExp(`\\| \`${W}:REQ-002\` \\| .+ \\| matched \\|`, 'u'));
  assert.match(report, /## Self-approval disclosures\n\nRecorded from the retained approvals\. Keep every line\.\n\n- `planning`: self-approved by/u);
  const index = await readFile(path.join(item, 'artifacts/release/verification/evidence-index.md'), 'utf8');
  assert.ok(await writtenBySflow(index));
  assert.match(index, /Verification v1 is approved by History Tester\./u);
  cli('artifact', 'scan', '--phase', 'release');
  cli('phase', 'publish', 'release', '--authored', 'human', '--channel', 'manual-in-place');
  story.review('release');
  cli('submit', 'release');
  const ended = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  if (ended.phases.release.status === 'awaiting_approval') cli('approve', 'release', '--yes');
  assert.equal(JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).status, 'closed', 'the Story ends on the documents SFlow wrote');

  const total = measured.reduce((sum, entry) => ({ full: sum.full + entry.full, shown: sum.shown + entry.shown }), { full: 0, shown: 0 });
  t.diagnostic(`words shown across ${measured.length} approvals: ${total.shown} of ${total.full} before`);
  assert.ok(total.shown < total.full);
});

test('version 2 of the plan shows only what changed since the person approved version 1', slowLane({ timeout: 600_000 }), async (t) => {
  const W = 'ARSHY-2';
  const story = await reviewedStory(t, W);
  const { cli, json } = story;
  await submitPlan(story, W);
  cli('approve', 'planning', '--yes');
  await submitCode(story, W, { finding: false });
  cli('reject', 'implementation', '--to', 'planning', '--reason', 'Roll back by flag instead of restoring the module.');
  const v2 = implementationPlan(W).replace('Risk is a wrong constant; rollback restores the previous module.',
    'Risk is a wrong constant; a feature flag turns the new value off.\nRollback switches the flag; the module stays.');
  await submitPlan(story, W, v2, { successor: true });
  const focus = json('phase', 'show', 'planning', '--json').approvalFocus;
  assert.equal(focus.version, 2);
  assert.deepEqual(focus.since, { label: 'Planning v1', yours: true });
  const plan = focus.documents.find((document) => document.step === 'planning' && document.kind === 'document');
  assert.match(plan.line, /^Planning v2: 1 section changed since Planning v1 \("Risks and rollback"\); 4 sections already approved$/u);
  for (const title of ['Agent brief', 'Approach', 'Affected surfaces', 'Test strategy']) {
    assert.equal(plan.sections.find((section) => section.title === title).folded, 'already approved in Planning v1', title);
  }
  const risks = plan.sections.find((section) => section.title === 'Risks and rollback');
  assert.deepEqual(risks.diff.map((entry) => `${entry.op} ${entry.text}`), ['- Risk is a wrong constant; rollback restores the previous module.',
    '+ Risk is a wrong constant; a feature flag turns the new value off.', '+ Rollback switches the flag; the module stays.']);
  const item = focus.eyes.items.find((entry) => entry.kind === 'changed');
  assert.equal(item.at.section, 'Risks and rollback');
  assert.equal(item.at.path, `singularity/work-items/${W}/artifacts/planning/plan.md`);
  assert.match(item.words, /"Risks and rollback" in Planning changed since Planning v1: 2 lines added, 1 removed\./u);
  // Only the diff is read, and the specification Planning v1's approval covered is one line.
  assert.ok(plan.words.shown < plan.words.full, JSON.stringify(plan.words));
  assert.deepEqual(focus.documents.filter((document) => document.covered).map((document) => document.line), ['Specification v1: already approved with Planning v1']);
  measure(t, 'planning v2', focus);
  assert.match(approvalFocusMarkdown(focus), /```diff\n- Risk is a wrong constant; rollback restores the previous module\.\n\+ Risk is a wrong constant; a feature flag/u);

  // VS Code's approval page opens with the same list, each file opening at its line, and only the diff open.
  const page = await approvalPage();
  const read = page.focusOf(json('phase', 'show', 'planning', '--json'));
  const html = page.approvalReviewBody({ title: 'Approve Planning', expected: 'planning', workId: W, phaseId: 'planning', phaseLabel: 'Planning', generation: 2,
    artifact: null, articles: [], findings: [], witnessedClauses: null, witnessMappings: [], priorExceptions: [], selfApproval: false, focus: read, repository: story.root });
  assert.ok(html.indexOf('<h2>What needs your eyes</h2>') > 0 && html.indexOf('<h2>What needs your eyes</h2>') < html.indexOf('review-binding'), 'first, before the binding');
  assert.match(html, new RegExp(`data-open="singularity/work-items/${W}/artifacts/planning/plan\\.md" data-line="\\d+"`, 'u'));
  assert.match(html, /<span class="focus-del">- Risk is a wrong constant; rollback restores the previous module\.<\/span>/u);
  assert.match(html, /<details><summary>Approach: already approved in Planning v1<\/summary>/u);
  assert.equal(page.focusOf({}), null);
});
