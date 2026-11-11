/**
 * The 4 KB agent view (2026-11-10) moved fields their reader needs out without naming them: help's page, the
 * articles a person answers before approval. Each kind of result keeps the field its reader reads in view, or act
 * names it in `read` so the read plan the guard admits holds it. `[agent-output]`
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { boundedAgentOutput, completeAgentResult, READER_FIELDS, readerFields } from '../src/agent-output.mjs';

const filler = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`detail${index}`, { note: 'n'.repeat(700) }]));
const articles = ['completeness', 'ambiguity', 'consistency', 'verifiability', 'boundary-conditions', 'non-functional']
  .map((id) => ({ id, question: `Is the specification's ${id} enough for approval?`, answer: null }));
const SAMPLES = {
  'help-page': { selectedTopic: 'decision', content: Array.from({ length: 160 }, (_, index) => `singularity-flow decision line ${index}`).join('\n') },
  'approval-checklist': { schemaVersion: 1, phase: 'specification', status: 'awaiting_approval', approvalChecklist: { required: true, articles }, ...filler(6) },
  'phase-show': { schemaVersion: 1, phase: 'planning', handoffScope: 'current', continuation: { nextCommand: 'singularity-flow decisions W-1',
    nextAction: { reason: "Planning can't be approved yet: 1 decision needed." } }, ...filler(6) },
  'decision-list': { schemaVersion: 1, resultType: 'sflow-decisions', status: 'decisions-needed', items: [{ id: 'd1', title: 'Reuse the run', options: [{ id: 'reuse' }] }],
    record: { form: 'singularity-flow decisions record W --choose <ITEM>=<OPTION> --confirm sha256:x' }, ...filler(6) },
  'decision-list-command': { schemaVersion: 1, resultType: 'command-result', data: { resultType: 'sflow-decisions', status: 'decisions-needed',
    items: [{ id: 'd1', title: 'Reuse the run' }] }, ...filler(6) },
  'source-review-check': { schemaVersion: 1, resultType: 'source-review-check', retentionReady: false, repair: { status: 'repair-packet', citations: [{ field: 'rows[0].line' }] },
    findings: [{ code: 'citation-line', message: 'The cited line is out of range.' }], ...filler(6) },
  'source-review-status': { schemaVersion: 1, resultType: 'source-review-status', status: 'correction-required', findings: [{ code: 'gap', message: 'A gap.' }],
    pendingDispositions: [{ id: 'exclusion:x' }], continuation: { classification: 'human-disposition-required', actions: [] }, ...filler(6) },
  refusal: { schemaVersion: 1, resultType: 'sflow-refusal-plan', status: 'failed', error: { code: 'SOME_REFUSAL', message: 'Refused.' },
    remediationPlan: { steps: [{ id: 'repair', command: 'singularity-flow status W-1', label: 'Repair it.' }] }, ...filler(6) }
};

test('the list of reader fields, by the kind of result', () => {
  assert.deepEqual(READER_FIELDS.map((entry) => [entry.kind, entry.fields]), [
    ['help-page', ['content']], ['approval-checklist', ['approvalChecklist']], ['phase-show', ['continuation']], ['decision-list', ['items', 'record', 'preview']],
    ['decision-list-command', ['data']], ['source-review-check', ['repair', 'findings']],
    ['source-review-status', ['findings', 'pendingDispositions', 'continuation']], ['refusal', ['error', 'remediationPlan']]]);
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    const entry = READER_FIELDS.find((candidate) => candidate.kind === kind);
    assert.ok(entry.matches(sample), kind);
    assert.deepEqual(readerFields(sample).filter((field) => entry.fields.includes(field)), entry.fields.filter((field) => sample[field] !== undefined), kind);
  }
});

test('a bounded view keeps what its reader reads, or names it in act and its read plan', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-reader-fields-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  for (const [kind, sample] of Object.entries(SAMPLES)) {
    const text = await boundedAgentOutput(JSON.stringify(sample), { cwd: root });
    assert.ok(Buffer.byteLength(text) <= 4000, `${kind}: ${Buffer.byteLength(text)} bytes`);
    const view = JSON.parse(text);
    for (const field of READER_FIELDS.find((entry) => entry.kind === kind).fields.filter((name) => sample[name] !== undefined)) {
      if (Object.hasOwn(view, field)) { assert.deepEqual(view[field], sample[field], `${kind}: ${field}`); continue; }
      // Out of view: act reads it (named, or act reads every field), the omitted list names it and the file holds it whole.
      assert.ok(!Array.isArray(view.act?.read) || view.act.read.includes(field), `${kind}: act does not read ${field}`);
      assert.ok([...(view.omittedFields ?? [])].some((entry) => entry.field === field) || view.omittedIndex, `${kind}: ${field} is not named`);
      assert.deepEqual(completeAgentResult(view)[field], sample[field], `${kind}: ${field} is not in the file`);
    }
  }
  // The checklist a person answers before approval stays in view beside the act.
  const checklist = JSON.parse(await boundedAgentOutput(JSON.stringify(SAMPLES['approval-checklist']), { cwd: root }));
  assert.deepEqual(checklist.approvalChecklist.articles.map((article) => article.id), articles.map((article) => article.id));
});

test('with nowhere to keep the rest, help shows the start of its page and says where it was cut', async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-reader-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify(SAMPLES['help-page']), { cwd: outside }));
  assert.match(view.content, /^singularity-flow decision line 0\n/u);
  // Never "run the command again" to read: a command that changed something would change it twice (agent-text audit, 2026-11-11).
  assert.match(view.content, /\[Cut here: \d+ more bytes\. To see the rest of a read, run it again from the Story checkout; never run a command that changed anything again to read it: read where it left things \(singularity-flow nextsteps --for-agent --json\)\.\]$/u);
});
