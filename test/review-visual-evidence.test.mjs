/**
 * A code step whose plan proves a criterion with a screenshot is reviewed, and its author's turn starts that review
 * [incident 2026-11-16]. On a real Story, two dead ends:
 *   - The plan row was `fulfillment: evidence` with a PNG as its expected path. The code review offered only the
 *     changed code: no visual source, and a row template with nowhere to put the image. The reviewer could not cite
 *     it, so every version's review held the step (`clause-implementation-uncited`), and rewriting code could not help.
 *     Now the packet offers the image (its committed bytes, pinned to the digest the delivery recorded, also when an
 *     earlier version published it), the reviewer inspects and attests it in the row's `evidence`, and that counts.
 *   - The `/sf-code` turn published, read the result before the CLI had refreshed the turn to the Story it changed,
 *     started the reviewer the result named, and was refused PHASE_MUTATION_CONTRACT_REQUIRED. Now that start, and
 *     only that start, by the turn that just published that version, passes; any other call is still refused.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { codeSourceId, evaluateSourceGroundedReview, sourceReviewBinding } from '../src/source-grounded-review.mjs';
import { sourceReviewCitationGuide, sourceReviewReportTemplate, validateSourceReviewReport } from '../src/source-review-contract.mjs';
import { checkSourceReviewReport } from '../src/source-review-lifecycle.mjs';
import { repository, cli as CLI } from './helpers/run-and-test-fixture.mjs';
import { documentReport, retainStepReview } from './helpers/step-review.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const W = 'QF-1';
const SHOT = `singularity/work-items/${W}/evidence/value-screen.png`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG7sAAAAASUVORK5CYII=', 'base64');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const codes = (findings) => findings.map((entry) => entry.code).sort();

// ---- The evaluator and contract, on a code step whose criterion is proved by a screenshot ----

const CODE = ['// @clause:QF-1:REQ-001 return the approved value', 'export const value = 2;', ''].join('\n');
const TESTS = ["import test from 'node:test';", "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001',
  "test('returns two', () => assert.equal(value, 2));", ''].join('\n');

function context() {
  const sources = [{ id: codeSourceId('src/value.mjs'), path: 'src/value.mjs', text: CODE },
    { id: codeSourceId('test/value.test.mjs'), path: 'test/value.test.mjs', text: TESTS }];
  const visualSources = [{ id: codeSourceId(SHOT), name: 'value-screen.png', path: SHOT, originalSha256: sha256(PNG), mimeType: 'image/png',
    absolutePath: `/checkout/${SHOT}`, bytes: PNG.length }];
  const code = { deliveredClauses: ['QF-1:AC-001', 'QF-1:REQ-001'],
    planned: { 'QF-1:AC-001': { expectedPaths: [SHOT], tests: ['test/value.test.mjs'], testDisposition: 'applicable', fulfillment: 'evidence' },
      'QF-1:REQ-001': { expectedPaths: ['src/value.mjs'], tests: ['test/value.test.mjs'], testDisposition: 'applicable', fulfillment: 'modified' } },
    changedPaths: ['src/value.mjs', 'test/value.test.mjs'], passedTests: ['test/value.test.mjs'], quality: [] };
  const input = { kind: 'code', workId: W, phase: 'implement', generation: 2, sources, visualSources, code,
    artifact: { path: `singularity/work-items/${W}/artifacts/implement/implementation-summary.md`, text: '# Implementation summary\n' },
    plan: { path: `singularity/work-items/${W}/artifacts/intake/intake.md`, text: '# Plan\n' },
    authorAgentId: 'sflow-coder', reviewerAgentId: 'sflow-source-reviewer', reviewerReadOnly: true };
  return { ...input, binding: sourceReviewBinding(input) };
}

const at = (ctx, relative, quote) => {
  const source = ctx.sources.find((entry) => entry.path === relative);
  return { sourceId: source.id, line: source.text.split('\n').findIndex((line) => line.includes(quote)) + 1, quote };
};
const inspected = (ctx) => ctx.visualSources.map((source) => ({ sourceId: source.id, method: 'image-tool', locator: 'whole screen',
  observations: 'The display reads 2 and the binary result reads 10.' }));

function report(ctx, { evidence = [], implementation = [], visual = inspected(ctx), findings = [], assessment = 'implemented' } = {}) {
  const template = sourceReviewReportTemplate(ctx);
  return { ...template, visualSourcesReviewed: visual,
    rows: [{ clauseId: 'QF-1:AC-001', implementation, tests: [at(ctx, 'test/value.test.mjs', "test('returns two'")], evidence, assessment, testAssessment: 'proves' },
      { clauseId: 'QF-1:REQ-001', implementation: [at(ctx, 'src/value.mjs', 'export const value = 2;')],
        tests: [at(ctx, 'test/value.test.mjs', "test('returns two'")], assessment: 'implemented', testAssessment: 'proves' }],
    qualityReviewed: [], findings };
}
const attested = (ctx) => [{ sourceId: codeSourceId(SHOT), attestation: 'Whole screen: the display shows 2 and the binary result 10.' }];

test('an evidence row\'s screenshot is offered, attested in the row and counts; unattested it holds the step', () => {
  const ctx = context();
  assert.deepEqual(ctx.binding.visualSources, [{ id: codeSourceId(SHOT), path: SHOT, originalSha256: sha256(PNG), mimeType: 'image/png' }],
    'the review binds the screenshot\'s exact bytes');
  const template = sourceReviewReportTemplate(ctx);
  assert.deepEqual(template.rows.map((row) => [row.clauseId, Object.hasOwn(row, 'evidence')]), [['QF-1:AC-001', true], ['QF-1:REQ-001', false]],
    'only the row the screenshot proves has an evidence list to fill');
  assert.deepEqual(template.visualSourcesReviewed, []);
  assert.ok(template.sourcesReviewed.includes(codeSourceId(SHOT)));
  const guide = sourceReviewCitationGuide(ctx);
  assert.deepEqual(guide.evidenceFiles, [{ clauseId: 'QF-1:AC-001', sourceId: codeSourceId(SHOT), path: SHOT }]);
  assert.match(guide.evidenceRule, /proved by a file the plan keeps as evidence, such as a screenshot, not by code/u);
  assert.match(guide.evidenceRule, /add it to evidence: \{ "sourceId": "<its id>", "attestation": "<the part you looked at and what it shows>" \}/u);
  assert.match(guide.visualRule, /attest it in its clause row's evidence/u);

  // Attested: ready. The test still counts for the row's tests.
  const ready = report(ctx, { evidence: attested(ctx) });
  assert.equal(validateSourceReviewReport(ready, 'code').status, 'ready');
  assert.equal(evaluateSourceGroundedReview(ready, ctx).status, 'ready', JSON.stringify(evaluateSourceGroundedReview(ready, ctx).findings));
  assert.equal(checkSourceReviewReport(ready, ctx).retentionReady, true);
  // Code cited for the row as context is no change outside its plan, and does not replace the attestation.
  const withContext = report(ctx, { evidence: attested(ctx), implementation: [at(ctx, 'src/value.mjs', 'export const value = 2;')] });
  assert.equal(evaluateSourceGroundedReview(withContext, ctx).status, 'ready');

  // Not attested: the honest review is retained and holds the step, with what the row lacks.
  for (const unattested of [report(ctx), report(ctx, { implementation: [at(ctx, 'src/value.mjs', 'export const value = 2;')] })]) {
    const checked = checkSourceReviewReport(unattested, ctx);
    assert.equal(checked.retentionReady, true);
    assert.equal(checked.evaluation.status, 'correction-required');
    const [uncited] = checked.evaluation.findings.filter((entry) => entry.clauseId === 'QF-1:AC-001');
    assert.equal(uncited.code, 'clause-implementation-uncited');
    assert.match(uncited.message, /QF-1:AC-001 is shown by its evidence file \(singularity\/work-items\/QF-1\/evidence\/value-screen\.png\), and no row attests it/u);
  }

  // A screenshot that does not show the criterion: a blocking finding cites it by attestation, as no line exists.
  const wrong = report(ctx, { assessment: 'not-implemented', findings: [{ id: 'screen-shows-three', severity: 'blocking', check: 'plan', clauseId: 'QF-1:AC-001',
    message: 'The screenshot shows 3, not 2.', sourceId: codeSourceId(SHOT), attestation: 'Display region: it reads 3.' }] });
  const held = checkSourceReviewReport(wrong, ctx);
  assert.equal(held.retentionReady, true, JSON.stringify(held.findings));
  assert.deepEqual(codes(held.evaluation.findings), ['clause-not-implemented', 'reviewer-blocker']);
});

test('a reviewer cannot attest an image it was not given, the wrong clause\'s image or one it did not inspect', () => {
  const ctx = context();
  const other = report(ctx, { evidence: [{ sourceId: codeSourceId(`singularity/work-items/${W}/evidence/other.png`), attestation: 'It shows 2.' }] });
  const unknown = checkSourceReviewReport(other, ctx);
  assert.equal(unknown.retentionReady, false);
  const [slip] = unknown.findings.filter((entry) => entry.code === 'source-unknown');
  assert.equal(slip.field, 'rows[0].evidence[0].sourceId');
  assert.match(slip.message, /which is no image or PDF this review offered/u);
  assert.deepEqual(slip.allowed, [codeSourceId(SHOT)], 'the repair names the images this review offers, never guessing one');

  const elsewhere = report(ctx, { evidence: attested(ctx) });
  elsewhere.rows[1].evidence = attested(ctx);
  const misplaced = checkSourceReviewReport(elsewhere, ctx);
  assert.equal(misplaced.retentionReady, false);
  assert.ok(misplaced.findings.some((entry) => entry.code === 'evidence-outside-plan' && entry.field === 'rows[1].evidence[0]'), JSON.stringify(misplaced.findings));

  const unread = checkSourceReviewReport(report(ctx, { evidence: attested(ctx), visual: [] }), ctx);
  assert.equal(unread.retentionReady, false);
  assert.ok(unread.findings.some((entry) => entry.code === 'visual-sources-not-reviewed'));
  // Format: an attestation is words; an empty one is refused before anything is judged.
  assert.equal(validateSourceReviewReport(report(ctx, { evidence: [{ sourceId: codeSourceId(SHOT), attestation: ' ' }] }), 'code').status, 'correction-required');
});

test('a review retained before the screenshot was offered reads as stale: reviewed again, not a new version', () => {
  const ctx = context();
  const { visualSources: _offered, binding: _binding, ...without } = ctx;
  const before = { ...without, binding: sourceReviewBinding(without) };
  // What the incident's reviewer could retain: the screenshot row with only its test cited, bound without the image.
  const retained = report(before, { visual: [] });
  delete retained.visualSourcesReviewed;
  delete retained.rows[0].evidence;
  assert.equal(evaluateSourceGroundedReview(retained, before).status, 'correction-required', 'it held the step then');
  const now = evaluateSourceGroundedReview(retained, ctx);
  assert.equal(now.status, 'stale', 'its inputs changed: the review packet now holds the screenshot');
  assert.deepEqual(codes(now.findings), ['review-binding-stale']);
});

// ---- The real CLI and hooks, on a quick fix whose criterion is proved by a screenshot ----

const INTAKE = [`# ${W} — Quick fix scope and plan`, '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
  '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${W}:AC-001] | The exported value equals 2. |`, '',
  '## Requirements', '', `The module exports the approved value 2. [${W}:REQ-001]`, '',
  '## Planned implementation evidence', '',
  '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
  `| \`${W}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | The test reads 2. |`,
  `| \`${W}:AC-001\` | \`${SHOT}\` | \`test/value.test.mjs\` | evidence | The reviewed screen shows the value 2. |`, '',
  '## Verification contracts', '',
  '| Criterion | Slot | Method | Witness | Role | Required assurance |', '|---|---|---|---|---|---|',
  `| \`${W}:AC-001\` | screen | visual | \`Value display\` | primary | source-bound |`, '',
  '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');

/** A reviewed quick fix at its code step, its intake reviewed, submitted and approved. */
async function screenshotStory(t) {
  const repo = await repository(t, { implementCommands: false, reviews: true });
  const { root, sflow, must, env } = repo;
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
  must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', W, '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, `singularity/work-items/${W}/artifacts/intake/intake.md`), INTAKE);
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  const json = (args) => {
    const result = repo.sflowJson(...args.filter((arg) => arg !== '--json'));
    assert.equal(result.status, 0, JSON.stringify(result.value).slice(0, 3000));
    return result.value;
  };
  assert.equal(retainStepReview(json, 'intake', documentReport(json(['review-source', 'context', 'intake', '--json']))).status, 'ready');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('resume', W);
  const hook = (event, payload) => {
    const result = spawnSync(process.execPath, [CLI, 'hook', event], { cwd: root, env, input: JSON.stringify({ cwd: root, ...payload }),
      encoding: 'utf8', timeout: childTimeout(60_000) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout || '{}');
  };
  const boundaries = path.join(path.dirname(env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries');
  const turnRecord = async (sessionId) => {
    for (const name of (await readdir(boundaries)).filter((entry) => entry.endsWith('.mutation.json'))) {
      const value = JSON.parse(await readFile(path.join(boundaries, name), 'utf8'));
      if (value.sessionId === sessionId) return { file: path.join(boundaries, name), value };
    }
    return null;
  };
  return { ...repo, json, hook, turnRecord };
}

async function writeVersion(root, comment) {
  await writeFile(path.join(root, 'src/value.mjs'), `// @clause:${W}:REQ-001 ${comment}\nexport const value = 2;\n`);
  await writeFile(path.join(root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${W}:AC-001`, "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
}

/** The reviewer's report from its packet: each clause's planned test, the code row's code, and the screenshot attested or not. */
function cliReport(packet, { attest }) {
  const source = (relative) => packet.sources.find((entry) => entry.path === relative);
  const cite = (relative, quote) => {
    const entry = source(relative);
    return { sourceId: entry.id, line: entry.text.split(/\r?\n/u).findIndex((line) => line.includes(quote)) + 1, quote };
  };
  const shot = packet.visualSources.find((entry) => entry.path === SHOT);
  return { ...packet.reportTemplate,
    visualSourcesReviewed: [{ sourceId: shot.id, method: 'image-tool', locator: 'whole screen', observations: 'The display reads 2.' }],
    rows: packet.reportTemplate.rows.map((row) => row.clauseId === `${W}:AC-001`
      ? { ...row, tests: [cite('test/value.test.mjs', "test('returns two'")], evidence: attest ? [{ sourceId: shot.id, attestation: 'Whole screen: the display reads 2.' }] : [],
        assessment: 'implemented', testAssessment: 'proves' }
      : { ...row, implementation: [cite('src/value.mjs', 'export const value = 2;')], tests: [cite('test/value.test.mjs', "test('returns two'")],
        assessment: 'implemented', testAssessment: 'proves' }),
    unplannedPaths: packet.reportTemplate.unplannedPaths.map((entry) => ({ ...entry, assessment: 'supporting', note: 'Supports the planned change.' })),
    qualityReviewed: packet.code.quality.map((entry) => entry.id), findings: [] };
}

test('the code review offers the published screenshot, also the one an earlier version published; attested it is ready', slowLane({ timeout: 480_000 }), async (t) => {
  const story = await screenshotStory(t);
  const { root, sflow, json } = story;
  sflow('prepare', 'implement');
  await writeVersion(root, 'return the approved value');
  await mkdir(path.dirname(path.join(root, SHOT)), { recursive: true });
  await writeFile(path.join(root, SHOT), PNG);
  sflow('prepare', 'implement');
  json(['phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator']);

  // Version 1: the packet offers the screenshot's published bytes to inspect, and the row a place to attest it.
  const first = json(['review-source', 'context', 'implement', '--for-agent']);
  assert.equal(first.kind, 'code');
  const [shot] = first.visualSources;
  assert.deepEqual([shot.id, shot.path, shot.mimeType, shot.originalSha256], [codeSourceId(SHOT), SHOT, 'image/png', sha256(PNG)]);
  assert.equal(await readFile(shot.absolutePath).then(sha256), sha256(PNG), 'the offered file is the published screenshot');
  assert.deepEqual(first.binding.visualSources, [{ id: shot.id, path: SHOT, originalSha256: sha256(PNG), mimeType: 'image/png' }]);
  assert.deepEqual(first.reportTemplate.rows.find((row) => row.clauseId === `${W}:AC-001`).evidence, []);
  assert.deepEqual(first.citationGuide.evidenceFiles, [{ clauseId: `${W}:AC-001`, sourceId: shot.id, path: SHOT }]);
  assert.match(first.reviewGuide.verification, /attested in its row's evidence \(citationGuide\.evidenceRule\)/u);
  assert.ok(!first.sources.some((entry) => entry.path === SHOT), 'an image is inspected, never cited by line');
  // Not attested: retained honestly, it holds the step for the evidence row alone.
  const held = retainStepReview(json, 'implement', cliReport(first, { attest: false }));
  assert.equal(held.status, 'correction-required');
  assert.deepEqual(held.findings.map((entry) => [entry.code, entry.clauseId]), [['clause-implementation-uncited', `${W}:AC-001`]]);

  // Version 2 changes only the code; the screenshot version 1 published is unchanged and still offered, pinned.
  const preview = json(['phase', 'rollover', 'implement', '--json']);
  json(['phase', 'rollover', 'implement', '--confirm', preview.confirmation, '--json']);
  sflow('prepare', 'implement');
  await writeVersion(root, 'return the approved value 2, as the intake asks');
  sflow('prepare', 'implement');
  json(['phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator']);
  const second = json(['review-source', 'context', 'implement', '--for-agent']);
  assert.equal(second.generation, 2);
  assert.deepEqual(second.visualSources.map((entry) => [entry.path, entry.originalSha256]), [[SHOT, sha256(PNG)]]);
  const unattested = json(['review-source', 'check', 'implement', '--report-file',
    json(['review-source', 'stage', 'implement', '--report-json', JSON.stringify(cliReport(second, { attest: false }))]).stagingPath]);
  assert.equal(unattested.retentionReady, true);
  assert.equal(unattested.evaluation.status, 'correction-required');
  const ready = retainStepReview(json, 'implement', cliReport(second, { attest: true }));
  assert.equal(ready.status, 'ready', JSON.stringify(ready.findings));
  assert.match(sflow('submit', 'implement'), /implement/u, 'with the screenshot attested, the code step submits');
});

test('the code turn that just published starts its reviewer before the CLI refreshed the turn; nothing else passes', slowLane({ timeout: 480_000 }), async (t) => {
  const story = await screenshotStory(t);
  const { root, sflow, hook, turnRecord, base } = story;
  const author = 'code-author';
  hook('boundary-turn', { sessionId: author, prompt: '/sf-code implement' });
  sflow('prepare', 'implement');
  await writeVersion(root, 'return the approved value');
  await mkdir(path.dirname(path.join(root, SHOT)), { recursive: true });
  await writeFile(path.join(root, SHOT), PNG);
  sflow('prepare', 'implement');
  const bound = (await turnRecord(author)).value;
  assert.equal(bound.contract.turnMode, 'authoring');
  assert.equal(bound.contract.generation, 0);
  // The publication as the agent saw it: its result was read before the CLI rebuilt the turn from the changed Story.
  // A command run outside this machine's Copilot records stands for that moment: it publishes and refreshes nothing.
  const published = spawnSync(process.execPath, [CLI, '--no-model', 'phase', 'publish', 'implement', '--authored', 'deterministic',
    '--channel', 'kernel-generator', '--json'], { cwd: root, env: { ...story.env, SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'elsewhere', 'copilot-mode.json') },
    encoding: 'utf8', timeout: childTimeout(240_000) });
  assert.equal(published.status, 0, published.stdout + published.stderr);
  const handoff = JSON.parse(published.stdout).reviewSubagent;
  assert.equal(handoff.prompt, '/sf-review-source implement');
  assert.deepEqual((await turnRecord(author)).value.binding, bound.binding, 'the turn still names the Story before publication');

  const decisionOf = (answer) => answer.permissionDecision ?? answer.hookSpecificOutput?.permissionDecision ?? 'allow';
  const call = (toolName, toolArgs, id = 'toolu_call') => hook('boundary-guard', { sessionId: author, toolCallId: id, toolName, toolArgs });
  const task = (args) => call('task', { name: 'review-implement', description: 'Review implement', mode: 'sync', ...args }, 'toolu_review');
  // Anything else this turn does without a current contract is refused as before.
  const refusedHere = (answer, label) => {
    assert.equal(decisionOf(answer), 'deny', label);
    assert.match(answer.permissionDecisionReason, /^PHASE_MUTATION_CONTRACT_REQUIRED/u, label);
  };
  refusedHere(call('edit', { path: path.join(root, 'src/value.mjs'), old_str: 'value = 2', new_str: 'value = 3' }), 'an edit');
  refusedHere(call('task', { agent_type: 'general-purpose', prompt: 'Tidy the value module.' }), 'another sub-agent');
  refusedHere(task({ agent_type: 'singularity-flow:sflow-source-reviewer', prompt: '/sf-review-source intake' }), 'the reviewer of another step');
  refusedHere(task({ agent_type: 'some-reviewer', prompt: '/sf-review-source implement' }), 'an agent that is not the Story\'s reviewer');
  refusedHere(call('bash', { command: 'npm install left-pad', cwd: root }), 'a shell command');

  // The reviewer of exactly this published version, started by this turn: allowed, and noted as this turn's.
  const start = task({ agent_type: `singularity-flow:${handoff.agent}`, prompt: handoff.prompt });
  assert.equal(decisionOf(start), 'allow', JSON.stringify(start));
  assert.deepEqual((await turnRecord(author)).value.reviewerStarted, { phaseId: 'implement', generation: 1 });
  // The CLI's refresh then lands; the turn keeps the reviewer it started, so the review stays the step's to correct.
  sflow('review-source', 'status', 'implement', '--json');
  const refreshed = (await turnRecord(author)).value;
  assert.equal(refreshed.contract.generation, 1);
  assert.deepEqual(refreshed.reviewerStarted, { phaseId: 'implement', generation: 1 });
  const reasoned = hook('boundary-guard', { sessionId: author, toolCallId: 'toolu_roll', toolName: 'bash',
    toolArgs: { command: 'singularity-flow phase rollover implement --reason "My own correction" --json', cwd: root } });
  assert.match(reasoned.permissionDecisionReason ?? '', /this turn started the step's independent reviewer/u);

  // A turn whose record is no longer verifiable never starts one: the contract is gone, not stale.
  const { file, value } = await turnRecord(author);
  await writeFile(file, JSON.stringify({ ...value, findings: ['tampered'] }));
  refusedHere(task({ agent_type: 'singularity-flow:sflow-source-reviewer', prompt: '/sf-review-source implement' }), 'a corrupt turn record');
});
