import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sourceReviewBinding } from '../src/source-grounded-review.mjs';
import { LIFECYCLE_EVENT } from '../src/lifecycle-event.mjs';
import { recordSha256 } from '../src/records.mjs';
import {
  evaluateSubmittedSourceReview, readSourceReviewStatus, retainSourceReview,
  retainSourceReviewDecision, sourceReviewContext, sourceReviewInput
} from '../src/source-review-lifecycle.mjs';

const ID = 'EXAMPLE';
const ITEM = `singularity/work-items/${ID}`;
const REVIEWER_SHA256 = 'a'.repeat(64);
const STORY = '# Story\nSave a draft and show saved status.\n';
const NOTES = '# Notes\nDrafts must persist.\n';
const SPEC = `# Specification
## User scenarios
### S1 — Save a draft
- Given a draft, when saved, then it persists.
## Requirements
- Save the draft. (S1) [EXAMPLE:REQ-001]
- Show saved status. (S1) [EXAMPLE:AC-001]
`;

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function git(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
async function put(root, relative, data) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  return file;
}

async function fixture(t, { document = 'file' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-source-review-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Review Test');
  git(root, 'config', 'user.email', 'review@example.test');
  const source = Buffer.from('{"title":"Save a draft"}\n');
  await put(root, `${ITEM}/source.json`, source);
  await put(root, `${ITEM}/USER-STORY.md`, STORY);
  await put(root, `${ITEM}/workflow.json`, '{"schemaVersion":1}\n');
  await put(root, `${ITEM}/artifacts/spec.md`, SPEC);
  const documents = document === 'file'
    ? [{ id: 'DOC-001', type: 'file', status: 'active', path: `${ITEM}/inputs/notes.md`,
      mimeType: 'text/markdown', sha256: sha(Buffer.from(NOTES)) }]
    : [{ id: 'DOC-001', type: 'url', status: 'active', url: 'https://example.test/notes' }];
  if (document === 'file') await put(root, `${ITEM}/inputs/notes.md`, NOTES);
  await put(root, `${ITEM}/documents.json`, `${JSON.stringify({ schemaVersion: 2, workId: ID, documents })}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Story source and specification');
  const config = { workItemRoot: 'singularity/work-items',
    approvalAuthorities: { 'product-approvers': { label: 'Product approvers',
      members: [{ email: 'approver@example.test' }] } },
    agents: { 'sflow-source-reviewer': { sha256: REVIEWER_SHA256,
      metadata: { 'sflow-mode': 'read-only-review' } } } };
  const workflow = {
    workItem: { id: ID }, currentPhase: 'specification', history: [],
    resolution: { sourceSha256: sha(source),
      agents: { 'sflow-source-reviewer': { sha256: REVIEWER_SHA256 } } },
    publicationProjections: [],
    phases: { specification: {
      id: 'specification', generation: 1, status: 'in_progress', generatedAgent: 'sflow-product-owner',
      approvalPolicy: { authorities: ['product-approvers'], minimum: 1 },
      requiredArtifact: { path: 'artifacts/spec.md' },
      artifacts: [{ path: `${ITEM}/artifacts/spec.md`, sha256: sha(Buffer.from(SPEC)) }]
    } }
  };
  return { root, config, workflow };
}

async function appendEvent(root, workflow, { kind, reportSha256, actor, agent = null,
  authorityGroup = null, findingId = null }) {
  const event = {
    eventId: randomUUID(), type: LIFECYCLE_EVENT.EVIDENCE_RECORDED,
    subject: { kind: 'story', id: ID }, phaseId: 'specification',
    generation: workflow.phases.specification.generation, actor, agent, authorityGroup,
    payload: { kind, reportSha256, ...(findingId ? { findingId } : {}) },
    sourceCommit: null
  };
  workflow.publicationProjections.push({ schemaVersion: 1, event, ledgerIntent: null });
  await put(root, `${ITEM}/workflow.json`, `${JSON.stringify(workflow, null, 2)}\n`);
  return event;
}

function review(input, { excludeNotes = false } = {}) {
  return {
    schemaVersion: 1, resultType: 'source-grounded-review', kind: 'specification',
    binding: sourceReviewBinding(input), reviewer: { agentId: 'sflow-source-reviewer', readOnly: true },
    sourcesReviewed: ['story', 'DOC-001'], findings: [],
    rows: [
      { id: 'story-draft', sourceId: 'story', line: 2,
        quote: 'Save a draft and show saved status.', outcome: 'covered', scenarioId: 'S1',
        clauseIds: ['EXAMPLE:REQ-001', 'EXAMPLE:AC-001'] },
      excludeNotes
        ? { id: 'notes-exclusion', sourceId: 'DOC-001', line: 2, quote: 'Drafts must persist.',
          outcome: 'excluded', reason: 'Duplicative supporting note.' }
        : { id: 'notes-draft', sourceId: 'DOC-001', line: 2, quote: 'Drafts must persist.',
          outcome: 'covered', scenarioId: 'S1', clauseIds: ['EXAMPLE:REQ-001'] }
    ]
  };
}

const session = { workId: ID, phaseId: 'specification', agent: 'sflow-source-reviewer',
  agentSha256: REVIEWER_SHA256,
  actor: { name: 'Review Test', email: 'review@example.test' } };

async function readyReviewFixture(t) {
  const fixtureData = await fixture(t);
  const { root, config, workflow } = fixtureData;
  const input = await sourceReviewInput(root, config, workflow, 'specification');
  const report = review(input, { excludeNotes: true });
  const evaluation = evaluateSubmittedSourceReview(report, input, session);
  const reportEvent = await appendEvent(root, workflow, { kind: 'source-grounded-review',
    reportSha256: evaluation.reportSha256, actor: session.actor, agent: session.agent });
  await retainSourceReview(root, config, workflow, 'specification', report, evaluation, session, reportEvent);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Retain source review');
  const pending = await readSourceReviewStatus(root, config, workflow, 'specification');
  const actor = { email: 'approver@example.test' };
  const decisionEvent = await appendEvent(root, workflow, { kind: 'source-review-disposition',
    reportSha256: pending.reportSha256, actor, authorityGroup: 'product-approvers',
    findingId: 'exclusion:notes-exclusion' });
  const retainedDecision = await retainSourceReviewDecision(root, config, workflow,
    'specification', pending, 'exclusion:notes-exclusion', 'Confirmed duplicate.', actor,
    { authorityGroup: 'product-approvers', identityAssurance: 'configured-local' }, decisionEvent);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Retain human decision');
  assert.equal((await readSourceReviewStatus(root, config, workflow, 'specification')).status, 'ready');
  return { ...fixtureData, retainedDecision };
}

test('review context binds Story snapshot, exact attachment bytes, and published artifact', async (t) => {
  const { root, config, workflow } = await fixture(t);
  const packet = await sourceReviewContext(root, config, workflow, 'specification', '/tmp/report.json');
  assert.equal(packet.sources.length, 2);
  assert.equal(packet.sources[0].text, STORY);
  assert.equal(packet.sources[1].originalSha256, sha(Buffer.from(NOTES)));
  assert.equal(packet.artifact.sha256, sha(Buffer.from(SPEC)));
  assert.equal(packet.authorAgentId, 'sflow-product-owner');
  assert.equal(packet.reportTemplate.binding.sources.length, 2);
  assert.equal((await readSourceReviewStatus(root, config, workflow, 'specification')).status, 'missing');
});

test('an attachment a reviewer cannot cite waits for a recorded human decision instead of refusing', async (t) => {
  const readable = await fixture(t);
  const readableInput = await sourceReviewInput(readable.root, readable.config, readable.workflow, 'specification');
  assert.equal(Object.hasOwn(readableInput.binding, 'unreadableSources'), false,
    'a review whose sources are all readable binds exactly what it bound before');

  const { root, config, workflow } = await fixture(t, { document: 'url' });
  const input = await sourceReviewInput(root, config, workflow, 'specification');
  assert.deepEqual(input.sources.map((source) => source.id), ['story']);
  assert.deepEqual(input.binding.unreadableSources, [{ id: 'DOC-001', code: 'external-reference' }]);
  const packet = await sourceReviewContext(root, config, workflow, 'specification', '/tmp/report.json');
  assert.match(packet.unreadableSources[0].reason, /a link \(https:\/\/example\.test\/notes\)/);
  const report = {
    schemaVersion: 1, resultType: 'source-grounded-review', kind: 'specification',
    binding: sourceReviewBinding(input), reviewer: { agentId: 'sflow-source-reviewer', readOnly: true },
    sourcesReviewed: ['story'], findings: [],
    rows: [{ id: 'story-draft', sourceId: 'story', line: 2, quote: 'Save a draft and show saved status.',
      outcome: 'covered', scenarioId: 'S1', clauseIds: ['EXAMPLE:REQ-001', 'EXAMPLE:AC-001'] }]
  };
  const evaluation = evaluateSubmittedSourceReview(report, input, session);
  assert.deepEqual(evaluation.pendingDispositions.map((entry) => entry.id), ['unreadable:DOC-001']);
  const reportEvent = await appendEvent(root, workflow, { kind: 'source-grounded-review',
    reportSha256: evaluation.reportSha256, actor: session.actor, agent: session.agent });
  await retainSourceReview(root, config, workflow, 'specification', report, evaluation, session, reportEvent);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Retain source review');
  const pending = await readSourceReviewStatus(root, config, workflow, 'specification');
  assert.equal(pending.status, 'correction-required');
  assert.match(pending.findings.map((entry) => entry.message).join('\n'), /Human disposition is required for unreadable:DOC-001/);
  const actor = { email: 'approver@example.test' };
  const decisionEvent = await appendEvent(root, workflow, { kind: 'source-review-disposition',
    reportSha256: pending.reportSha256, actor, authorityGroup: 'product-approvers', findingId: 'unreadable:DOC-001' });
  await retainSourceReviewDecision(root, config, workflow, 'specification', pending,
    'unreadable:DOC-001', 'The linked page repeats the Story; nothing to cite.', actor,
    { authorityGroup: 'product-approvers', identityAssurance: 'configured-local' }, decisionEvent);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Retain human decision');
  assert.equal((await readSourceReviewStatus(root, config, workflow, 'specification')).status, 'ready');
});

test('a changed pinned attachment is rejected', async (t) => {
  const changed = await fixture(t);
  await put(changed.root, `${ITEM}/inputs/notes.md`, `${NOTES}Changed.\n`);
  await assert.rejects(sourceReviewInput(changed.root, changed.config, changed.workflow, 'specification'),
    { code: 'SOURCE_REVIEW_SOURCE_CHANGED' });
});

test('only a committed independent report and committed human decision make review ready', async (t) => {
  const { root, config, workflow } = await fixture(t);
  const input = await sourceReviewInput(root, config, workflow, 'specification');
  const report = review(input, { excludeNotes: true });
  const evaluation = evaluateSubmittedSourceReview(report, input, session);
  assert.equal(evaluation.status, 'correction-required');
  const reportEvent = await appendEvent(root, workflow, { kind: 'source-grounded-review',
    reportSha256: evaluation.reportSha256, actor: session.actor, agent: session.agent });
  await retainSourceReview(root, config, workflow, 'specification', report, evaluation, session, reportEvent);
  await assert.rejects(readSourceReviewStatus(root, config, workflow, 'specification'),
    { code: 'SOURCE_REVIEW_RECORD_UNPUBLISHED' });
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Retain source review');
  const pending = await readSourceReviewStatus(root, config, workflow, 'specification');
  assert.equal(pending.status, 'correction-required');
  assert.deepEqual(pending.pendingDispositions.map((entry) => entry.id), ['exclusion:notes-exclusion']);
  const actor = { email: 'approver@example.test' };
  const decisionEvent = await appendEvent(root, workflow, { kind: 'source-review-disposition',
    reportSha256: pending.reportSha256, actor, authorityGroup: 'product-approvers',
    findingId: 'exclusion:notes-exclusion' });
  await retainSourceReviewDecision(root, config, workflow, 'specification', pending,
    'exclusion:notes-exclusion', 'Confirmed duplicate.', { email: 'approver@example.test' },
    { authorityGroup: 'product-approvers', identityAssurance: 'configured-local' }, decisionEvent);
  await assert.rejects(readSourceReviewStatus(root, config, workflow, 'specification'),
    { code: 'SOURCE_REVIEW_RECORD_UNPUBLISHED' });
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Retain human decision');
  assert.equal((await readSourceReviewStatus(root, config, workflow, 'specification')).status, 'ready');
  workflow.phases.specification.generation = 2;
  const stale = await readSourceReviewStatus(root, config, workflow, 'specification');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.reportSha256, evaluation.reportSha256);
});

test('report provenance comes from governed reviewer session, not the report JSON', async (t) => {
  const { root, config, workflow } = await fixture(t);
  const input = await sourceReviewInput(root, config, workflow, 'specification');
  const packet = review(input);
  await assert.rejects(async () => evaluateSubmittedSourceReview(packet, input, {
    ...session, agent: 'sflow-product-owner'
  }), { code: 'SOURCE_REVIEW_INDEPENDENT_AGENT_REQUIRED' });
  const evaluation = evaluateSubmittedSourceReview(packet, input, session);
  const reportEvent = await appendEvent(root, workflow, { kind: 'source-grounded-review',
    reportSha256: evaluation.reportSha256, actor: session.actor, agent: session.agent });
  await retainSourceReview(root, config, workflow, 'specification', packet, evaluation, session, reportEvent);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Retain source review');
  assert.equal((await readSourceReviewStatus(root, config, workflow, 'specification')).status, 'ready');
  const pointer = path.join(root, ITEM, 'context/reviews/specification/gen-1/current.json');
  await writeFile(pointer, `${(await readFile(pointer, 'utf8')).trim()} \n`);
  await assert.rejects(readSourceReviewStatus(root, config, workflow, 'specification'),
    { code: 'SOURCE_REVIEW_RECORD_UNPUBLISHED' });
});

test('a hash-valid committed decision with an unauthorized actor cannot satisfy review', async (t) => {
  const { root, config, workflow, retainedDecision } = await readyReviewFixture(t);
  const original = JSON.parse(await readFile(retainedDecision.path, 'utf8'));
  const { recordSha256: ignored, ...body } = original;
  body.actor.email = 'intruder@example.test';
  const forged = { ...body, recordSha256: recordSha256(body) };
  await put(root, path.relative(root, path.join(path.dirname(retainedDecision.path),
    `${forged.recordSha256}.json`)), `${JSON.stringify(forged, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Directly insert unauthorized review decision');
  await assert.rejects(readSourceReviewStatus(root, config, workflow, 'specification'),
    { code: 'SOURCE_REVIEW_DECISION_UNAUTHORIZED' });
});

test('a copied lifecycle event cannot authorize a later direct decision insert', async (t) => {
  const { root, config, workflow, retainedDecision } = await readyReviewFixture(t);
  const original = JSON.parse(await readFile(retainedDecision.path, 'utf8'));
  const { recordSha256: ignored, ...body } = original;
  body.reason = 'Forged acceptance with the same authorized actor and event.';
  const forged = { ...body, recordSha256: recordSha256(body) };
  await put(root, path.relative(root, path.join(path.dirname(retainedDecision.path),
    `${forged.recordSha256}.json`)), `${JSON.stringify(forged, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Directly insert copied-event review decision');
  await assert.rejects(readSourceReviewStatus(root, config, workflow, 'specification'),
    { code: 'SOURCE_REVIEW_EVENT_MISSING' });
});
