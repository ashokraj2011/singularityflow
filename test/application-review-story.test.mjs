/** Disposable real Story journey: authoritative tests, human event, real browser images, approval. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { repository, startQuickFix, cli } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { startApplicationReview, mutateApplicationReview, confirmApplicationReview, finalizeApplicationReview, recordApplicationFeedback, prepareApplicationRepair } from '../src/application-review.mjs';
import { applicationReviewStatus, applicationReviewResults, findReviewSession, applicationReviewSnapshot, reviewLocalRoot } from '../src/application-review-read.mjs';
import { createApplicationReviewHumanServer } from '../src/application-review-human.mjs';
import { captureApplicationReview } from '../src/application-review-preview.mjs';
import { reviewDigest, reviewReportPages } from '../src/application-review-contract.mjs';
import { applicationReviewHostDescriptor, applicationReviewHostAlive, inspectApplicationReview } from '../src/commands/app-review.mjs';

test('adopted backend review survives metadata commits and accepts only after real post-confirmation capture', slowLane({ timeout: 360000 }), async t => {
  const repo = await repository(t, { implementCommands: false, applicationReview: { mode: 'required', surface: 'backend' } });
  await writeFile(path.join(repo.root, 'src/UnchangedFrontend.jsx'), 'export const OldView = () => "Existing frontend";\n');
  repo.must('git', ['add', 'src/UnchangedFrontend.jsx']); repo.must('git', ['commit', '-qm', 'Existing UI outside this delivery']);
  await startQuickFix(repo);
  repo.sflow('prepare', 'implement');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 — return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value } from '../src/value.mjs';",
    '// @ac:QF-1:AC-001', "test('returns the confirmed value', () => assert.equal(value, 2));", ''].join('\n'));
  repo.sflow('prepare', 'implement');
  repo.sflow('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  repo.sflow('submit', 'implement');
  const held = repo.sflowJson('approve', 'implement', '--yes');
  assert.equal(held.status, 1); assert.equal(held.value.error.code, 'ARA_REVIEW_REQUIRED');
  const inherited = { ...process.env }; Object.assign(process.env, repo.env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in inherited)) delete process.env[key]; Object.assign(process.env, inherited); });
  const read = async id => { const { config, workflow } = await loadAcceptedStoryExecution(repo.root, 'QF-1'); return applicationReviewStatus(repo.root, config, workflow, id, { includeResults: true }); };
  const created = await startApplicationReview(repo.root, { workId: 'QF-1', actionId: 'host-start-action' });
  const id = created.session.id;
  assert.equal(created.session.target.results.ready, true);
  assert.equal(created.session.target.applicability.surface, 'backend', 'An unchanged frontend does not turn an API-only delivery into a UI change.');
  const cliPlan = repo.sflowJson('app-review', 'plan', '--work-id', 'QF-1', '--for-agent');
  assert.equal(cliPlan.status, 0); assert.equal(cliPlan.value.resultType, 'sflow-application-review');
  assert.equal(cliPlan.value.results.ready, true); assert.equal(cliPlan.value.snapshot, undefined, 'Copilot never receives a whole source manifest.');
  assert.ok(created.session.target.results.attempts.every(attempt => attempt.purpose === 'submission'));
  assert.equal((await startApplicationReview(repo.root, { workId: 'QF-1', actionId: 'host-start-action' })).replay, true);
  const initial = await read(id);
  assert.equal(initial.state, 'inspecting');
  assert.equal(initial.completion.requiredDecisionsSatisfied, false);
  const { config, workflow } = await loadAcceptedStoryExecution(repo.root, 'QF-1');
  const snapshot = (await applicationReviewSnapshot(repo.root, config, workflow)).digest;
  await writeFile(path.join(repo.root, 'src/unplanned.mjs'), 'export const unplanned = true;\n');
  const stale = await applicationReviewResults(repo.root, config, workflow, 'implement');
  assert.equal(stale.ready, false, 'A new unplanned source file cannot reuse the earlier submitted checks.');
  assert.equal(stale.confirmable, false);
  assert.ok(stale.sourceBinding.changedPaths.includes('src/unplanned.mjs'));
  await (await import('node:fs/promises')).rm(path.join(repo.root, 'src/unplanned.mjs'));
  await mutateApplicationReview(repo.root, { workId: 'QF-1', sessionId: id, actionId: 'host-defer-action', expectedRevision: initial.revision, type: 'review-deferred', input: {}, prepare: () => ({}) });
  assert.equal((await applicationReviewSnapshot(repo.root, config, workflow)).digest, snapshot, 'Review metadata must not stale source merely because HEAD moved.');
  let confirmation;
  const human = await createApplicationReviewHumanServer({ root: repo.root, sessionId: id, read: () => read(id), render: (_view, form) => JSON.stringify(form),
    perform: async ({ actionId, expectedRevision, grant }) => {
      const current = await read(id);
      const policy = findReviewSession((await loadAcceptedStoryExecution(repo.root, 'QF-1')).workflow, id).policy;
      const pages = reviewReportPages(current.target.results, policy.capture);
      const input = { dimensions: ['functional'], coverage: current.coverage.map(item => item.id),
        capturePlan: { applicationUi: false, reportDigest: reviewDigest(pages), resultPages: pages.pages.map(item => item.id), limits: policy.capture, pageFingerprint: null } };
      const result = await confirmApplicationReview(repo.root, { workId: 'QF-1', sessionId: id, actionId, expectedRevision, input, human: grant(input) });
      confirmation = result.session.confirmation;
      return { message: 'Actual fixture reviewer confirmed the exact backend result.' };
    } });
  t.after(human.close);
  const form = await (await fetch(human.url)).json();
  const response = await fetch(new URL(form.route, human.origin), { method: 'POST', headers: { Origin: human.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ actionId: form.actionId, nonce: form.nonce, action: 'accept' }) });
  assert.equal(response.status, 200, await response.text());
  assert.ok(confirmation);
  let view = await read(id);
  assert.equal(view.state, 'confirmed-awaiting-capture');
  assert.equal(view.completion.reviewSatisfied, false);
  assert.equal(view.captures.length, 0, 'No final screenshot may precede human confirmation.');
  await mutateApplicationReview(repo.root, { workId: 'QF-1', sessionId: id, actionId: 'capture-fault-action', expectedRevision: view.revision,
    type: 'capture-blocked', input: {}, prepare: () => ({ code: 'ARA_CAPTURE_FAILED', message: 'Injected interruption before image capture' }) });
  view = await read(id);
  assert.equal(view.confirmation.id, confirmation.id);
  const policy = findReviewSession((await loadAcceptedStoryExecution(repo.root, 'QF-1')).workflow, id).policy;
  const receipts = await captureApplicationReview(repo.root, view, policy);
  assert.ok(receipts.length >= 2);
  assert.ok(receipts.every(item => item.confirmation === confirmation.id && Date.parse(item.capturedAt) >= Date.parse(confirmation.at)));
  await mutateApplicationReview(repo.root, { workId: 'QF-1', sessionId: id, actionId: 'capture-admit-action', expectedRevision: view.revision,
    type: 'capture-admitted', input: {}, prepare: () => ({ receipts }) });
  view = await read(id);
  await finalizeApplicationReview(repo.root, { workId: 'QF-1', sessionId: id, actionId: 'capture-final-action', expectedRevision: view.revision, input: {} });
  view = await read(id);
  assert.equal(view.completion.reviewSatisfied, true);
  assert.equal(view.target.applicability.dimensions.visual, 'not-applicable');
  assert.ok((await readdir(path.join(reviewLocalRoot(repo.root), 'artifacts'))).some(file => file.endsWith('.png')));
  assert.equal(repo.must('git', ['ls-files', '*.png']).trim(), '', 'Local review images must not be published to Git.');
  const approval = repo.run(process.execPath, [cli, '--no-model', 'approve', 'implement', '--yes', '--json']);
  assert.equal(approval.status, 0, approval.stdout + approval.stderr);
  assert.equal(JSON.parse(await readFile(path.join(repo.root, 'singularity/work-items/QF-1/workflow.json'), 'utf8')).phases.implement.status, 'approved');
  let host;
  const openedUrls = [];
  try {
    await inspectApplicationReview(repo.root, 'QF-1', id, { openReview: async url => { openedUrls.push(url); } });
    const descriptor = await applicationReviewHostDescriptor(repo.root, id);
    host = JSON.parse(await readFile(descriptor, 'utf8'));
    assert.equal(host?.kind, 'local-application-review-host', JSON.stringify(host?.error));
    await inspectApplicationReview(repo.root, 'QF-1', id, { openReview: async url => { openedUrls.push(url); } });
    assert.equal(JSON.parse(await readFile(descriptor, 'utf8')).pid, host.pid, 'The same owned host is reused, not spawned twice.');
    assert.deepEqual(openedUrls, [host.url, host.url]);
    const opened = await fetch(host.url);
    assert.equal(opened.status, 200);
    const html = await opened.text(); assert.match(html, /Review your application/u); assert.match(html, /Captured evidence/u);
    const image = html.match(/src="([^"<>]+\/evidence\/[a-f0-9]{64})"/u)?.[1];
    assert.ok(image, 'Admitted images are visible after confirmation.');
    const picture = await fetch(new URL(image, host.url)); assert.equal(picture.status, 200); assert.equal(picture.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await picture.arrayBuffer()).readUInt32BE(0), 0x89504e47);
    assert.ok(!JSON.stringify((await loadAcceptedStoryExecution(repo.root, 'QF-1')).workflow).includes(host.url), 'Private action URLs never enter published Story state.');
  } finally {
    if (!host) {
      try { host = JSON.parse(await readFile(await applicationReviewHostDescriptor(repo.root, id), 'utf8')); } catch { /* startup never claimed a host */ }
    }
    if (host?.pid && await applicationReviewHostAlive(host)) {
      process.kill(host.pid, 'SIGTERM');
      for (let count = 0; count < 50 && await applicationReviewHostAlive(host); count += 1) await delay(100);
    }
  }
});

test('Report and fix admits a submitted delivery successor through its existing owner and cannot replay the repair budget', slowLane({ timeout: 360000 }), async t => {
  const repo = await repository(t, { implementCommands: false, applicationReview: { mode: 'required', surface: 'backend' } });
  await startQuickFix(repo);
  repo.sflow('prepare', 'implement');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 — approved value\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value } from '../src/value.mjs';",
    '// @ac:QF-1:AC-001', "test('returns the approved value', () => assert.equal(value, 2));", ''].join('\n'));
  repo.sflow('prepare', 'implement');
  repo.sflow('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  repo.sflow('submit', 'implement');
  const inherited = { ...process.env }; Object.assign(process.env, repo.env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in inherited)) delete process.env[key]; Object.assign(process.env, inherited); });
  const { session } = await startApplicationReview(repo.root, { workId: 'QF-1', actionId: 'repair-review-start' });
  const read = async () => { const { config, workflow } = await loadAcceptedStoryExecution(repo.root, 'QF-1'); return applicationReviewStatus(repo.root, config, workflow, session.id); };
  const originalSource = await readFile(path.join(repo.root, 'src/value.mjs'), 'utf8');
  const original = (await loadAcceptedStoryExecution(repo.root, 'QF-1')).workflow;
  const packet = original.lineage.submissions.findLast(item => item.phase === 'implement').packetSha256;
  const report = { observed: 'The returned value is still wrong in the inspected client.', expected: 'The approved value must be returned.', intent: 'report-and-fix', targetId: session.target.id };
  await assert.rejects(recordApplicationFeedback(repo.root, { workId: 'QF-1', sessionId: session.id, actionId: 'forged-direction-action', expectedRevision: session.revision, input: report }), { code: 'ARA_REPAIR_DIRECTION_REQUIRED' });
  let finding;
  const human = await createApplicationReviewHumanServer({ root: repo.root, sessionId: session.id, read, render: (_view, form) => JSON.stringify(form),
    perform: async ({ actionId, expectedRevision, grant }) => {
      const retained = await recordApplicationFeedback(repo.root, { workId: 'QF-1', sessionId: session.id, actionId, expectedRevision, input: report, human: grant(report) });
      finding = retained.session.findings.at(-1); return { message: 'Actual fixture reporter requested repair.' };
    } });
  t.after(human.close);
  const form = await (await fetch(human.url)).json();
  assert.equal((await fetch(new URL(form.route, human.origin), { method: 'POST', headers: { Origin: human.origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ actionId: form.actionId, nonce: form.nonce, action: 'report-and-fix' }) })).status, 200);
  assert.ok(finding);
  const view = await read();
  const request = { workId: 'QF-1', sessionId: session.id, actionId: 'admit-repair-attempt', expectedRevision: view.revision,
    input: { findingId: finding.id, obligationRefs: ['QF-1:AC-001'] } };
  const prepared = await prepareApplicationRepair(repo.root, request);
  assert.equal(prepared.session.repairAttempts.length, 1);
  const replayedCommand = repo.sflowJson('app-review', 'repair', session.id, '--work-id', 'QF-1', '--action-id', request.actionId,
    '--revision', String(request.expectedRevision), '--input-json', JSON.stringify(request.input), '--for-agent');
  assert.equal(replayedCommand.status, 0, replayedCommand.stderr + replayedCommand.stdout);
  assert.equal(replayedCommand.value.commandGuidance.copilotCommand, '/sf-code');
  const replay = await prepareApplicationRepair(repo.root, request);
  assert.equal(replay.replay, true);
  assert.equal(replay.generationIntent.id, prepared.generationIntent.id, 'A lost response must not open another generation.');
  const current = (await loadAcceptedStoryExecution(repo.root, 'QF-1')).workflow;
  assert.equal(current.phases.implement.status, 'in_progress');
  assert.equal(current.phases.implement.generationIntent.status, 'open');
  assert.equal(current.phases.implement.generationIntent.generation, 2);
  assert.equal(current.lineage.submissions.some(item => item.packetSha256 === packet), true, 'The inspected submission remains immutable history.');
  assert.equal(await readFile(path.join(repo.root, 'src/value.mjs'), 'utf8'), originalSource, 'Preparing a repair never edits application source.');
  assert.equal((await read()).findings[0].state, 'repairing', 'Neither generation admission nor test passes resolve the human finding.');
});
