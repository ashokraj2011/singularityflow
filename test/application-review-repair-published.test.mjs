/**
 * "Report and fix" on a code step that is published and not yet submitted (review of the opening flow, 2026-11-17,
 * finding 3). Admitting the repair spends its budget and marks the finding repairing; before, nothing then said what
 * version the fix goes in: the kernel saw an unchanged publication, so the admission returned no version and no route,
 * the work command's entry fell through to "unchanged publication: relay next" (submit), and the fix never happened.
 * Now the person's report is the change the step's next version makes, kept as their typed words for it, so the admission
 * names that version and the step's own preview asks them "Start version 2?"; only their yes opens it [D3, OSA:REQ-030].
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { startApplicationReview, recordApplicationFeedback, prepareApplicationRepair } from '../src/application-review.mjs';
import { applicationReviewStatus } from '../src/application-review-read.mjs';
import { createApplicationReviewHumanServer } from '../src/application-review-human.mjs';

test('Report and fix on a published, unsubmitted code step names its next version and the preview that asks the person', slowLane({ timeout: 360000 }), async t => {
  const repo = await repository(t, { implementCommands: false, applicationReview: { mode: 'required', surface: 'backend' } });
  await startQuickFix(repo);
  repo.sflow('prepare', 'implement');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 — approved value\nexport const value = 1;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value } from '../src/value.mjs';",
    '// @ac:QF-1:AC-001', "test('returns the current value', () => assert.equal(value, 1));", ''].join('\n'));
  repo.sflow('prepare', 'implement');
  repo.sflow('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  const inherited = { ...process.env }; Object.assign(process.env, repo.env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in inherited)) delete process.env[key]; Object.assign(process.env, inherited); });
  const { session } = await startApplicationReview(repo.root, { workId: 'QF-1', actionId: 'published-review-start' });
  const read = async () => { const { config, workflow } = await loadAcceptedStoryExecution(repo.root, 'QF-1'); return applicationReviewStatus(repo.root, config, workflow, session.id); };
  const report = { observed: 'The returned value is still 1 in the inspected client.', expected: 'The approved value 2 is returned.', intent: 'report-and-fix', targetId: session.target.id };
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
  const before = (await loadAcceptedStoryExecution(repo.root, 'QF-1')).workflow.phases.implement;
  assert.equal(before.status, 'in_progress', 'published, not submitted');
  const request = { workId: 'QF-1', sessionId: session.id, actionId: 'admit-published-repair', expectedRevision: (await read()).revision,
    input: { findingId: finding.id, obligationRefs: ['QF-1:AC-001'] } };
  const prepared = await prepareApplicationRepair(repo.root, request);
  assert.equal(prepared.session.repairAttempts.length, 1);
  // The fix goes in version 2, which opens only on the person's yes: the admission names it and the preview that asks it.
  assert.deepEqual(prepared.versionOpening, { phase: 'implement', version: 2, opened: false }, JSON.stringify(prepared).slice(0, 2000));
  assert.equal(prepared.continuation?.nextAction?.command, 'singularity-flow phase rollover implement --json');
  assert.equal(prepared.continuation.nextAction.skill, '/sf-code');
  // A lost response replays the same admission: the same version, no second change kept, no budget spent again.
  const replay = await prepareApplicationRepair(repo.root, request);
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.versionOpening, prepared.versionOpening);
  assert.equal(replay.session.repairAttempts.length, 1);
  // The step's preview asks the person, with their own report as the change, once.
  const preview = repo.sflowJson('phase', 'rollover', 'implement');
  assert.equal(preview.status, 0, preview.stderr + preview.stdout);
  assert.match(preview.value.question, /^Start version 2 of /u);
  assert.deepEqual(preview.value.requestedChange.requests, ['Application review: The returned value is still 1 in the inspected client. Expected: The approved value 2 is returned.']);
  // Nothing opened before that yes, and the published version and its source stay as they are.
  const after = (await loadAcceptedStoryExecution(repo.root, 'QF-1')).workflow.phases.implement;
  assert.equal(after.generation, 1);
  assert.notEqual(after.generationIntent?.status, 'open');
  assert.match(await readFile(path.join(repo.root, 'src/value.mjs'), 'utf8'), /value = 1/u);
  // The person's yes opens version 2 through the opening operation.
  const opened = repo.sflowJson('phase', 'rollover', 'implement', '--confirm', preview.value.confirmation);
  assert.equal(opened.status, 0, opened.stderr + opened.stdout);
  const reopened = (await loadAcceptedStoryExecution(repo.root, 'QF-1')).workflow.phases.implement;
  assert.equal(reopened.generationIntent.status, 'open');
  assert.equal(reopened.versionOpening.version, 2);
});
