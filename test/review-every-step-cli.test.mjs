/**
 * A reviewer in every step, code included (owner, 2026-11-11: "let there be a reviewer in every step .. even
 * for coding"). Real quick-fix Stories, through the CLI, with the work type's review left at its default:
 *   - a document step (intake) waits for its review, is reviewed against the Story, then submits;
 *   - a code step (implement) waits for its review; a review asking for corrections opens generation N+1 in
 *     the same step through the reviewed rollover, with the review as the reason; the corrected generation's
 *     review is ready, and only then does it submit.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { repository } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { agentAct } from '../src/agent-output.mjs';

const INTAKE = ['# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
  '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
  '## Planned implementation evidence', '',
  '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
  '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
  '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');

/** A refused command's error, wherever its JSON envelope puts it. */
function refusal(result) {
  assert.notEqual(result.status, 0, JSON.stringify(result.value).slice(0, 2000));
  return result.value.error ?? result.value;
}

function cite(source, needle) {
  const lines = source.text.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `${source.id} has no line with ${needle}`);
  return { sourceId: source.id, line: index + 1, quote: needle };
}

/** The reviewer's work: stage, check and retain an honest report through the CLI. */
function retainReview(repo, phase, report) {
  const staged = repo.sflowJson('review-source', 'stage', phase, '--report-json', JSON.stringify(report));
  assert.equal(staged.status, 0, JSON.stringify(staged.value));
  const checked = repo.sflowJson('review-source', 'check', phase, '--report-file', staged.value.stagingPath);
  assert.equal(checked.value.retentionReady, true, JSON.stringify(checked.value.findings ?? checked.value, null, 2).slice(0, 4000));
  const retained = repo.sflowJson('review-source', 'submit', phase, '--report-file', staged.value.stagingPath);
  assert.equal(retained.status, 0, JSON.stringify(retained.value));
  return repo.sflowJson('review-source', 'status', phase).value;
}

async function writeCode(repo, value) {
  await writeFile(path.join(repo.root, 'src/value.mjs'), `// @clause:QF-1:AC-001 — return the approved value\nexport const value = ${value};\n`);
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
}

function codeReport(packet, { blocking = null } = {}) {
  const source = (relative) => packet.sources.find((entry) => entry.path === relative);
  const code = source('src/value.mjs');
  const tests = source('test/value.test.mjs');
  assert.ok(code && tests, JSON.stringify(packet.sources.map((entry) => entry.path)));
  return {
    ...packet.reportTemplate,
    rows: [{ clauseId: 'QF-1:AC-001', implementation: [cite(code, 'export const value = 2;')],
      tests: [cite(tests, "test('returns two', () => assert.equal(value, 2));")], assessment: 'implemented', testAssessment: 'proves' }],
    unplannedPaths: [], qualityReviewed: packet.code.quality.map((entry) => entry.id),
    findings: [
      // (d) Readability is advisory unless it names a real maintainability defect.
      { id: 'name-the-constant', severity: 'advisory', check: 'design', message: 'A name for the approved value would read better.',
        ...cite(code, 'export const value = 2;') },
      ...(blocking ? [blocking(code, tests)] : [])
    ]
  };
}

test('a quick-fix Story reviews every step: its document, then its code, with a correction in the same step', async (t) => {
  const repo = await repository(t, { implementCommands: false, reviews: true });
  const { root, sflow, sflowJson, must } = repo;
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
  must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  const started = JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
  assert.equal(started.resolution.sourceReview.mode, 'enforce');
  assert.equal(started.resolution.sourceReview.level, 2);
  assert.deepEqual(started.resolution.sourceReview.kinds, { intake: 'document', implement: 'code' },
    'every authored step of a new Story is reviewed; verify is built by the kernel');

  // A document step: submission waits for its review, and the refusal leads with the in-step route.
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), INTAKE);
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  const early = sflowJson('submit', 'intake');
  assert.notEqual(early.status, 0, 'submission waits for the review');
  assert.equal(refusal(early).code, 'SOURCE_REVIEW_REQUIRED');
  assert.equal(early.value.remediationPlan.steps[0].command, 'singularity-flow review-source context intake --json', 'the in-step route leads');
  const document = sflowJson('review-source', 'context', 'intake').value;
  assert.equal(document.kind, 'document');
  assert.ok(document.sources.some((entry) => entry.id === 'story'));
  assert.match(document.citationGuide.mappingRule, /each pinned source/u);
  const story = document.sources.find((entry) => entry.id === 'story');
  const intakeReview = retainReview(repo, 'intake', { ...document.reportTemplate,
    rows: document.sources.map((source, index) => ({ id: `row-${index + 1}`, ...cite(source, source.text.split(/\r?\n/u).find((line) => line.trim()).trim()), outcome: 'consistent' })),
    findings: [] });
  assert.equal(intakeReview.status, 'ready', JSON.stringify(intakeReview.findings));
  assert.ok(story);
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('resume', 'QF-1');

  // A code step: generation 1 is published, its review asks for a correction.
  sflow('prepare', 'implement');
  await writeCode(repo, 2);
  sflow('prepare', 'implement');
  const published = sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.equal(published.status, 0, JSON.stringify(published.value));
  const waiting = sflowJson('submit', 'implement');
  assert.equal(refusal(waiting).code, 'SOURCE_REVIEW_REQUIRED', 'a code step waits for its review too');
  const first = sflowJson('review-source', 'context', 'implement').value;
  assert.equal(first.kind, 'code');
  assert.deepEqual(first.code.deliveredClauses, ['QF-1:AC-001']);
  assert.deepEqual(first.code.planned['QF-1:AC-001'].expectedPaths, ['src/value.mjs']);
  assert.ok(first.code.passedTests.includes('test/value.test.mjs'), JSON.stringify(first.code));
  assert.equal(first.citationGuide.checks.length, 4);
  const corrected = retainReview(repo, 'implement', codeReport(first, { blocking: (code) => ({ id: 'explain-the-value', severity: 'blocking', check: 'plan',
    clauseId: 'QF-1:AC-001', message: 'The clause comment must say why the value is 2, as the plan row says.', ...cite(code, '// @clause:QF-1:AC-001') }) }));
  assert.equal(corrected.status, 'correction-required');
  assert.ok(corrected.findings.some((entry) => entry.code === 'reviewer-blocker'));
  assert.ok(!corrected.findings.some((entry) => /name-the-constant/u.test(entry.message)), 'an advisory design note does not hold the step');
  // Its next step in SFlow's own words, ready to relay, and one turn: /sf-code, never /sf-recover (owner, 2026-11-16).
  // Only the reviewer has seen version 1, so that step starts version 2 on its own, with an undo (owner, 2026-11-19).
  assert.deepEqual([corrected.continuation.nextSkill, corrected.continuation.copilotCommand], ['/sf-code', '/sf-code implement']);
  assert.equal(corrected.continuation.presentation, ["Now — Fix the review's findings (version 2)", '- Copilot: `/sf-code implement`',
    '- Shell: `singularity-flow phase rollover implement --review-findings`', '- VS Code (model-free): not available for this action'].join('\n'));
  assert.equal(agentAct(corrected).show, corrected.continuation.presentation, 'a review turn ends on it');
  assert.match(sflow('review-source', 'status', 'implement'), /Now — Fix the review's findings \(version 2\)\n- Copilot: \/sf-code implement\n/u);
  // /sf-code's entry runs that start in its own turn and asks the person nothing.
  const entering = sflowJson('phase', 'enter', '--compose', '--for-agent').value;
  const enterAct = entering.act ?? agentAct(entering);
  assert.deepEqual([enterAct.state, enterAct.do?.shell, enterAct.ask], ['next', 'singularity-flow phase rollover implement --review-findings --json', undefined],
    JSON.stringify(entering).slice(0, 3000));

  // The refusal leads with the same in-step route.
  const held = sflowJson('submit', 'implement');
  assert.equal(refusal(held).code, 'SOURCE_REVIEW_REQUIRED');
  assert.equal(refusal(held).details.nextAction, 'singularity-flow phase rollover implement --review-findings --json');
  assert.equal(held.value.remediationPlan.steps[0].command, 'singularity-flow phase rollover implement --review-findings --json', 'the in-step route leads');
  const opened = sflowJson('phase', 'rollover', 'implement', '--review-findings');
  assert.equal(opened.status, 0, JSON.stringify(opened.value));
  assert.equal(opened.value.toGeneration, 2);
  // Its undo is forward only, and says so: version 2 stays open (2026-11-19 review).
  assert.equal(opened.value.line, 'Only the reviewer had seen version 1 of Implement, so SFlow started version 2 to fix its findings. '
    + 'Version 2 stays open; an undo on the decisions card (/sf-decide QF-1) only makes SFlow ask you before it starts another.');
  assert.match(opened.value.settled.undo.words, /^An undo does not withdraw version 2: it stays open\./u);
  // The review is named by its generation, never its digest: these words are shown and kept [no hashes shown].
  assert.ok(opened.value.requestedChange.requests.some((entry) => /^Correct what the review of version 1 found: .*explain-the-value/u.test(entry)),
    JSON.stringify(opened.value.requestedChange));
  assert.equal(opened.value.settled.kind, 'review-corrections');
  const settledRecord = JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
  assert.equal(settledRecord.phases.implement.generationIntent.generation, 2);
  assert.deepEqual(settledRecord.phases.implement.versionOpening.consent, { settled: opened.value.settled.id, surface: 'settled' });
  // The settlement is written in the opening's own commit: a start that fails leaves none for a version nobody opened.
  assert.match(must('git', ['log', '-1', '--format=%s']), /^Open implement version 2 of QF-1/u);
  const committed = JSON.parse(must('git', ['show', 'HEAD:singularity/work-items/QF-1/workflow.json']));
  const start = committed.settledDecisions.find((entry) => entry.id === opened.value.settled.id);
  assert.deepEqual([start?.kind, start?.effect], ['review-corrections', { generation: 1, toGeneration: 2, findings: ['explain-the-value'] }]);
  // The reviewer's blocking finding on version 1 has no dispute route for a person after this start, as before it (only a
  // review's pending dispositions are decided: ceremony-turns.test.mjs), and version 2 has no review yet.
  // Their say is their words to the author or a return at approval, as the undo names (owner item, 2026-11-19).
  const dispute = sflowJson('review-source', 'decision-context', 'implement', '--work-id', 'QF-1', '--finding', 'explain-the-value', '--reason', 'The comment is enough.');
  assert.match(refusal(dispute).message, /requires a retained report/u, JSON.stringify(dispute.value).slice(0, 1500));
  // Run again once version 2 is open, it opens nothing: the step's next action is writing it.
  assert.equal(refusal(sflowJson('phase', 'rollover', 'implement', '--review-findings')).code, 'GENERATION_ROLLOVER_UNAVAILABLE');
  // Version 2 is authored with the review of version 1 loaded, and its act says to fix each finding.
  const fixing = sflowJson('phase', 'enter', '--compose', '--for-agent').value;
  assert.deepEqual(fixing.reviewCorrection?.findings?.map((entry) => [entry.id, entry.check, entry.at]), [['explain-the-value', 'plan', 'src/value.mjs:1']],
    JSON.stringify(fixing).slice(0, 3000));
  // Recovery right after the rollover, before anything changed (owner's run, 11:00): nothing changed yet is expected, and
  // the route is the code author, never a view of the step's documents.
  const recovery = sflowJson('recover', 'QF-1', '--phase', 'implement').value;
  const routes = [...(recovery.actions ?? []), ...(recovery.act ? [recovery.act.do ?? {}] : [agentAct(recovery)?.do ?? {}])];
  assert.ok(!JSON.stringify(routes).includes('/sf-phase-documents'), JSON.stringify(routes).slice(0, 3000));
  const delivery = (recovery.actions ?? []).find((entry) => entry.id === 'complete-code-delivery:implement');
  assert.deepEqual([delivery?.skill, delivery?.command], ['/sf-code', 'singularity-flow prepare implement'], JSON.stringify(recovery.actions).slice(0, 3000));
  // What publication checks is this version's checklist, the author's own work, never a blocker or a person's route
  // (Story new-ash-graph, 2026-11-18: reported as a blocker on a version just opened with no code).
  const blockers = recovery.blockers ?? recovery.recovery?.blockers ?? [];
  assert.equal(blockers.find((entry) => entry.code === 'code.delivery.checklist')?.blocking, false, JSON.stringify(blockers).slice(0, 2000));
  assert.ok(!blockers.some((entry) => entry.code === 'code.delivery.incomplete'), JSON.stringify(blockers).slice(0, 2000));
  assert.ok(!(recovery.actions ?? []).some((entry) => ['/sf-decide', '/sf-appeal'].includes(entry.skill)), JSON.stringify(recovery.actions).slice(0, 3000));
  // The rollover changed the Story record in the checkout, uncommitted; the entry to generation 2 still reads
  // generation 1's review from the commit, so the code step is not held as unverifiable [incident 2026-11-16].
  const entry = sflowJson('phase', 'enter', 'implement', '--compose');
  assert.doesNotMatch(JSON.stringify(entry.value), /SOURCE_REVIEW_RECORD_UNPUBLISHED/u, JSON.stringify(entry.value).slice(0, 3000));
  assert.doesNotMatch(JSON.stringify(entry.value), /attention-required/u, JSON.stringify(entry.value.act ?? entry.value).slice(0, 3000));
  // Its author prepares version 2, which rewrites the step's summary in the checkout; a new chat's next step is
  // still to write version 2, and the code step's entry is still not held [incident 2026-11-16, 13:50].
  sflow('prepare', 'implement');
  const prepared = sflowJson('phase', 'enter', 'implement', '--compose');
  assert.doesNotMatch(JSON.stringify(prepared.value), /SOURCE_REVIEW_INPUT_UNPUBLISHED|SOURCE_REVIEW_RECORD_UNPUBLISHED|attention-required/u,
    JSON.stringify(prepared.value.authoring?.entry ?? prepared.value.act ?? null).slice(0, 3000));
  // Its code may be written now: the open version is editable, not a retained one to recover [incident 2026-11-16, 15:50].
  assert.equal(prepared.value.mutationContract?.applicationEdits, true, JSON.stringify(prepared.value.mutationContract ?? null).slice(0, 1500));
  assert.equal(prepared.value.codeAuthoringReady, true);
  const session = sflowJson('nextsteps', 'QF-1');
  assert.doesNotMatch(JSON.stringify(session.value.act ?? session.value).slice(0, 4000), /review-source/u,
    `with version 2 open, the next step writes it; version 1 is not offered for review again: ${JSON.stringify(session.value.actions?.[0] ?? null)}`);
  const status = sflowJson('review-source', 'status', 'implement');
  assert.doesNotMatch(JSON.stringify(status.value), /SOURCE_REVIEW_INPUT_UNPUBLISHED/u, JSON.stringify(status.value).slice(0, 3000));

  // Generation 2 corrects it; its own review is ready, and the step submits.
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 — return the approved value 2, as the intake asks\nexport const value = 2;\n');
  sflow('prepare', 'implement');
  const republished = sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.equal(republished.status, 0, JSON.stringify(republished.value));
  const second = sflowJson('review-source', 'context', 'implement').value;
  assert.equal(second.generation, 2);
  const ready = retainReview(repo, 'implement', codeReport(second));
  assert.equal(ready.status, 'ready', JSON.stringify(ready.findings));
  assert.match(sflow('submit', 'implement'), /implement/u, 'with its review ready, the code step submits');
  const after = JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
  assert.notEqual(after.phases.implement.status, 'in_progress');
  assert.equal(after.phases.implement.generation, 2);
});

test('a Story pinned before review level 2 keeps the review it started with: its steps submit unreviewed', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdir, mkdtemp, rm } = await import('node:fs/promises');
  const os = (await import('node:os')).default;
  const YAML = (await import('yaml')).default;
  const { initializeDefinition, resolveWorkType } = await import('../src/config.mjs');
  const { withOperationContext } = await import('../src/operation-context.mjs');
  const { setAgentSession } = await import('../src/session.mjs');
  const { createWorkflow, loadConfig } = await import('../src/state.mjs');
  const { childTimeout } = await import('./helpers/child-timeout.mjs');
  const { fileURLToPath } = await import('node:url');
  const executable = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-old-pin-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const cli = (...args) => spawnSync(process.execPath, [executable, '--no-model', ...args], { cwd: root, encoding: 'utf8', timeout: childTimeout(60_000),
    env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/test-workspace-registry.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/test-active-workspace.json') } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Old Pin Driver');
  git('config', 'user.email', 'old-pin@example.test');
  await writeFile(path.join(root, 'README.md'), '# Old pin fixture\n');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/workflow.yml');
  const authored = YAML.parse(await readFile(file, 'utf8'));
  authored.git.publish = 'off';
  authored.session.workItemSelection = 'reuse';
  authored.worldModel.grounding = 'off';
  for (const authority of Object.values(authored.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(file, YAML.stringify(authored));
  git('add', '.');
  git('commit', '-q', '-m', 'Initialize old pin fixture');
  git('switch', '-q', '-c', 'QF-OLD');
  const config = await loadConfig(root);
  const resolved = resolveWorkType(config, 'quick-fix');
  assert.equal(resolved.sourceReview.level, 2, 'a Story starting today pins review level 2');
  // What a quick-fix Story pinned before review level 2: no review. Its pin is its own, so it stays.
  resolved.sourceReview = { mode: 'off', phases: [], reviewerAgent: null };
  const agent = resolved.phases[0].defaultAgent;
  await setAgentSession(root, config, { name: 'Old Pin Driver', email: 'old-pin@example.test' }, agent, 'QF-OLD', { phaseId: 'intake', source: 'test' });
  await withOperationContext({ operation: { id: 'test.review-old-pin', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' }, root, command: 'test' }, () => createWorkflow(root, config, {
    id: 'QF-OLD', title: 'Change the value', source: { type: 'manual', key: 'QF-OLD', title: 'Change the value', description: 'Return 2.' },
    baseBranch: 'main', workType: 'quick-fix', agent, resolved }));
  git('add', '-A');
  git('commit', '-q', '-m', '[QF-OLD] Start the Story');
  const prepared = cli('prepare', 'intake');
  assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
  await mkdir(path.join(root, 'singularity/work-items/QF-OLD/artifacts/intake'), { recursive: true });
  await writeFile(path.join(root, 'singularity/work-items/QF-OLD/artifacts/intake/intake.md'), INTAKE.replaceAll('QF-1', 'QF-OLD'));
  const published = cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  assert.equal(published.status, 0, published.stderr + published.stdout);
  const status = cli('review-source', 'status', 'intake', '--json');
  assert.equal(status.status, 0, status.stderr);
  assert.notEqual(JSON.parse(status.stdout).status, 'missing', 'an old pin owes no review');
  const submitted = cli('submit', 'intake');
  assert.equal(submitted.status, 0, `an old-pin step submits without a review\n${submitted.stderr}\n${submitted.stdout}`);
});

test('a spec-driven Story reviews every authored step, its specification to its release, and ends', slowLane({ timeout: 480_000 }), async (t) => {
  const { mkdir } = await import('node:fs/promises');
  const { storyAtVerification, writeVerificationEvidence } = await import('./helpers/story-to-verification.mjs');
  const { codeReport, retainStepReview, reviewStep } = await import('./helpers/step-review.mjs');
  const W = 'SPEC-R1';
  const kinds = {};
  // Implementation's code review asks for a correction on (d): a named maintainability defect. Generation 2 opens in
  // the same step through the rollover, with the review as its reason; its review is ready, and the walk goes on.
  const correctImplementation = async ({ cli, root }, json) => {
    const first = json(['review-source', 'context', 'implementation', '--json']);
    const value = first.sources.find((entry) => entry.path === 'src/value.mjs');
    const held = retainStepReview(json, 'implementation', codeReport(first, { findings: [{ id: 'tell-the-clauses-apart', severity: 'blocking',
      check: 'design', defect: 'Both clause comments say the same sentence, so a reader cannot tell which line carries which clause.',
      clauseId: `${W}:REQ-002`, message: 'Say what the second clause adds in its own comment.', sourceId: value.id, line: 2, quote: `// @clause:${W}:REQ-002` }] }));
    assert.equal(held.status, 'correction-required');
    const preview = json(['phase', 'rollover', 'implementation', '--json']);
    assert.ok(preview.requestedChange.requests.some((entry) => /tell-the-clauses-apart/u.test(entry)), JSON.stringify(preview.requestedChange));
    assert.equal(json(['phase', 'rollover', 'implementation', '--confirm', preview.confirmation, '--json']).generationIntent.generation, 2);
    await writeFile(path.join(root, 'src/value.mjs'), `// @clause:${W}:AC-001 returns the approved value to its callers\n`
      + `// @clause:${W}:REQ-002 the application returns that same approved value\nexport const value = 1;\n`);
    cli('artifact', 'scan', '--phase', 'implementation');
    cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  };
  // The shipped spec-driven review (templates/workflow.yml): from review level 2 its legacy list is superseded and every
  // authored step is reviewed; the helper's fixture turns review off, so this walk sets it back.
  const story = await storyAtVerification(t, W, { review: async (phase, step) => {
    const json = (args) => JSON.parse(step.cli(...args).stdout);
    if (phase === 'implementation') await correctImplementation(step, json);
    const { packet } = reviewStep(json, phase);
    kinds[phase] = packet.kind;
    if (phase === 'implementation') assert.equal(packet.generation, 2, 'the corrected generation is the one reviewed ready');
  }, configure: (configuration) => {
    configuration.workTypes['spec-driven-standard'].sourceReview = { mode: 'enforce', phases: ['specification', 'planning'], reviewerAgent: 'sflow-source-reviewer' };
  } });
  const { cli, item } = story;
  const workflow = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.deepEqual((await workflow()).resolution.sourceReview.kinds, { specification: 'specification', planning: 'planning',
    implementation: 'code', verification: 'document', release: 'document' }, 'convergence is built by the kernel and has no review');
  await writeVerificationEvidence(story);
  cli('phase', 'publish', 'verification', '--authored', 'human', '--channel', 'manual-in-place');
  kinds.verification = reviewStep((args) => JSON.parse(cli(...args).stdout), 'verification').packet.kind;
  cli('submit', 'verification');
  cli('approve', 'verification', '--yes');
  cli('prepare', 'release');
  const report = path.join(item, 'artifacts/release/conformance.md');
  await mkdir(path.join(item, 'artifacts/release/verification'), { recursive: true });
  await writeFile(path.join(item, 'artifacts/release/verification/evidence-index.md'), `# Release verification evidence index — ${W}\n\nVerification generation 1 is approved, and it reused the run Implementation recorded on this same source tree.\n`);
  const sample = `| \`${W}:REQ-001\` | TODO: exact source/test evidence | TODO: matched/partial/missing/deviated/unplanned |`;
  await writeFile(report, (await readFile(report, 'utf8')).replace(sample, story.clauses.map((clause) => `| \`${clause}\` | \`test/value.test.mjs\`, the run reused on this source tree | matched |`).join('\n'))
    .replace(/TODO:[^\n]*/gu, `Compared ${story.clauses.join(' and ')} against the recorded run.`).replace(/\bTODO\b/gu, 'none'));
  cli('artifact', 'scan', '--phase', 'release');
  cli('phase', 'publish', 'release', '--authored', 'human', '--channel', 'manual-in-place');
  kinds.release = reviewStep((args) => JSON.parse(cli(...args).stdout), 'release').packet.kind;
  // A Story started from its seed, as one from Jira or a story file is: finalizing binds the seed's inputs.
  await story.write(`singularity/seeds/${W}.yml`, `story:\n  workId: ${W}\n  title: Return the approved value\n`);
  const { spawnSync } = await import('node:child_process');
  for (const args of [['add', `singularity/seeds/${W}.yml`], ['commit', '-qm', 'Story seed']]) {
    assert.equal(spawnSync('git', args, { cwd: story.root, encoding: 'utf8' }).status, 0, args.join(' '));
  }
  const submitted = cli('submit', 'release');
  // Approve twice (owner, 2026-11-19): release, reviewed ready with nothing open, is approved by SFlow at its submission,
  // as the specification was; people approved the plan, the code and verification, which may change source files.
  const ended = await workflow();
  for (const step of ['specification', 'release']) {
    assert.equal(ended.phases[step].approvalDisposition, 'approved_automatically', step);
    assert.match(ended.phases[step].automaticApproval.checked.join('; '), /the reviewer said ready/u, step);
  }
  for (const step of ['planning', 'implementation', 'verification']) assert.equal(ended.phases[step].approvals.filter((entry) => !entry.invalidatedAt).length, 1, step);
  assert.deepEqual(kinds, { specification: 'specification', planning: 'planning', implementation: 'code', verification: 'document', release: 'document' },
    'every authored step was reviewed, each as what it is');
  assert.equal((await workflow()).status, 'closed', 'the reviewed Story ends');
  // SFlow never merges: after the person's Yes to the code, the Story finalized by itself when it ended (owner, 2026-11-19).
  assert.equal((await workflow()).lineage?.finalizations?.length, 1, `the Story finalized by itself when it ended\n${String(submitted?.stdout ?? '').slice(-1500)}`);
  assert.match(String(submitted?.stdout ?? ''), /SFlow never merges/u);
});
