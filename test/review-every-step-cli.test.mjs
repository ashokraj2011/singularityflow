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

  // The refusal leads with the in-step route: the reviewed rollover to generation 2, with the review as its reason.
  const held = sflowJson('submit', 'implement');
  assert.equal(refusal(held).code, 'SOURCE_REVIEW_REQUIRED');
  assert.equal(refusal(held).details.nextAction, 'singularity-flow phase rollover implement --json');
  assert.equal(held.value.remediationPlan.steps[0].command, 'singularity-flow phase rollover implement --json', 'the in-step route leads');
  const preview = sflowJson('phase', 'rollover', 'implement');
  assert.equal(preview.status, 0, JSON.stringify(preview.value));
  assert.equal(preview.value.toGeneration, 2);
  // The review is named by its generation, never its digest: these words are shown and kept [no hashes shown].
  assert.ok(preview.value.requestedChange.requests.some((entry) => /^Correct what the review of generation 1 found: .*explain-the-value/u.test(entry)),
    JSON.stringify(preview.value.requestedChange));
  assert.equal(preview.value.mutates, false);
  const opened = sflowJson('phase', 'rollover', 'implement', '--confirm', preview.value.confirmation);
  assert.equal(opened.status, 0, JSON.stringify(opened.value));
  assert.equal(opened.value.generationIntent.generation, 2);

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
  cli('submit', 'release');
  cli('approve', 'release', '--yes');
  assert.deepEqual(kinds, { specification: 'specification', planning: 'planning', implementation: 'code', verification: 'document', release: 'document' },
    'every authored step was reviewed, each as what it is');
  assert.equal((await workflow()).status, 'closed', 'the reviewed Story ends');
});
