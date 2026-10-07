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
  checkSourceReviewReport, evaluateSubmittedSourceReview, readSourceReviewStatus, retainSourceReview,
  retainSourceReviewDecision, scopedSourceReviewerSession, sourceReviewContext, sourceReviewInput
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

const PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n';

async function fixture(t, { document = 'file', notes = NOTES, spec = SPEC, extraDocuments = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-source-review-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Review Test');
  git(root, 'config', 'user.email', 'review@example.test');
  const source = Buffer.from('{"title":"Save a draft"}\n');
  await put(root, `${ITEM}/source.json`, source);
  await put(root, `${ITEM}/USER-STORY.md`, STORY);
  await put(root, `${ITEM}/workflow.json`, '{"schemaVersion":1}\n');
  await put(root, `${ITEM}/artifacts/spec.md`, spec);
  const documents = document === 'file'
    ? [{ id: 'DOC-001', type: 'file', status: 'active', path: `${ITEM}/inputs/notes.md`,
      mimeType: 'text/markdown', sha256: sha(Buffer.from(notes)) }]
    : document === 'pdf'
      ? [{ id: 'DOC-001', type: 'file', status: 'active', path: `${ITEM}/inputs/brief.pdf`,
        mimeType: 'application/pdf', sha256: sha(Buffer.from(PDF)) }]
      : [{ id: 'DOC-001', type: 'url', status: 'active', url: 'https://example.test/notes' }];
  if (document === 'file') await put(root, `${ITEM}/inputs/notes.md`, notes);
  if (document === 'pdf') await put(root, `${ITEM}/inputs/brief.pdf`, PDF);
  for (const extra of extraDocuments) {
    await put(root, extra.path, extra.text);
    documents.push({ id: extra.id, type: 'file', status: 'active', path: extra.path,
      mimeType: 'text/markdown', sha256: sha(Buffer.from(extra.text)) });
  }
  await put(root, `${ITEM}/documents.json`, `${JSON.stringify({ schemaVersion: 2, workId: ID, documents })}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Story source and specification');
  const config = { workItemRoot: 'singularity/work-items',
    approvalAuthorities: { 'product-approvers': { label: 'Product approvers',
      members: [{ email: 'approver@example.test' }] } },
    agents: { 'sflow-source-reviewer': { sha256: REVIEWER_SHA256,
      metadata: { 'sflow-mode': 'read-only-review' } } } };
  const workflow = {
    workItem: { id: ID }, currentPhase: 'specification', history: [], phaseOrder: ['specification'],
    // The step is reviewed as a specification because it defines the scope, not because of its name.
    resolution: { sourceSha256: sha(source),
      obligationGraph: { nodes: [{ id: 'specification', responsibilities: ['scope', 'review'] }] },
      agents: { 'sflow-source-reviewer': { sha256: REVIEWER_SHA256 } } },
    publicationProjections: [],
    phases: { specification: {
      id: 'specification', generation: 1, status: 'in_progress', generatedAgent: 'sflow-product-owner',
      approvalPolicy: { authorities: ['product-approvers'], minimum: 1 },
      requiredArtifact: { path: 'artifacts/spec.md' },
      artifacts: [{ path: `${ITEM}/artifacts/spec.md`, sha256: sha(Buffer.from(spec)) }]
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
  assert.equal(packet.reportSchema.properties.kind.const, 'specification');
  assert.equal((await readSourceReviewStatus(root, config, workflow, 'specification')).status, 'missing');
});

async function pinClarification(root, workflow, phaseId, { answer = 'Provide one desktop screenshot and one automated positive-value test.', status = 'answered', mutate = () => {} } = {}) {
  const phase = workflow.phases[phaseId];
  const relative = `${ITEM}/context/clarifications-${phaseId}-gen${phase.generation}.json`;
  const record = { schemaVersion: 1, workId: ID, phase: phaseId, generation: phase.generation,
    mode: 'required', completed: true, recordedAt: '2026-10-07T03:06:13.236Z',
    recordedBy: session.actor, agent: phase.generatedAgent,
    promptSha256: 'b'.repeat(64), groundingRecordSha256: 'c'.repeat(64),
    promptPath: `${ITEM}/context/prompts/${phaseId}-gen${phase.generation}.md`,
    groundingRecordPath: `${ITEM}/context/${phaseId}-gen${phase.generation}.json`,
    responses: [{ id: 'Q-005', question: 'What evidence satisfies screenshot and test cases?', answer, status, blocking: false }] };
  mutate(record);
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  await put(root, relative, bytes);
  const reference = { generation: phase.generation, path: relative, sha256: sha(bytes),
    promptSha256: record.promptSha256, responses: record.responses.length, markers: [],
    recordedAt: record.recordedAt, recordedBy: record.recordedBy };
  phase.clarifications = [reference];
  const relativeArtifact = `${ITEM}/${phase.requiredArtifact.path}`;
  const original = await readFile(path.join(root, relativeArtifact), 'utf8');
  const authored = original.replace(/^<!-- singularity-flow:metadata\n[\s\S]*?\n-->\s*/u, '');
  const published = `<!-- singularity-flow:metadata\n${JSON.stringify({ clarification: reference })}\n-->\n\n${authored}`;
  await put(root, relativeArtifact, published);
  phase.artifacts = [{ path: relativeArtifact, sha256: sha(published) }];
  await put(root, `${ITEM}/workflow.json`, `${JSON.stringify(workflow, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Publish human clarification with artifact');
  return { relative, record, reference };
}

test('the plural-test incident packet includes the exact published human answer, not a later draft', async (t) => {
  const { root, config, workflow } = await fixture(t);
  const pinned = await pinClarification(root, workflow, 'specification');
  const input = await sourceReviewInput(root, config, workflow, 'specification');
  const packet = await sourceReviewContext(root, config, workflow, 'specification', '.git/report.json');
  assert.equal(packet.clarifications[0].responses[0].answer, pinned.record.responses[0].answer);
  assert.equal(packet.clarifications[0].sha256, pinned.reference.sha256);
  assert.deepEqual(packet.binding.clarifications, [{ id: 'clarification:current-phase', phase: 'specification',
    generation: 1, path: pinned.relative, sha256: pinned.reference.sha256 }]);
  assert.match(packet.clarificationGuidance, /correct the review of this generation/);
  assert.deepEqual(packet.reportTemplate.clarificationsReviewed, [], 'the template must not claim the reviewer read the answers');
  const report = review(input);
  assert.equal(checkSourceReviewReport(report, input).retentionReady, false, 'an acknowledgement is required');
  report.clarificationsReviewed = ['clarification:current-phase'];
  assert.equal(checkSourceReviewReport(report, input).evaluation.status, 'ready');
  await put(root, `${ITEM}/context/clarifications-specification-gen2.json`, '{"answer":"require ten tests"}');
  assert.equal((await sourceReviewInput(root, config, workflow, 'specification')).clarifications[0].responses[0].answer,
    pinned.record.responses[0].answer, 'an unpublished later answer cannot replace the published answer');
  await retainReport(root, config, workflow, report, input);
  assert.equal((await readSourceReviewStatus(root, config, workflow, 'specification')).status, 'ready');
  // Equivalent CRLF checkout bytes on Windows still use the committed record hash.
  await put(root, pinned.relative, (await readFile(path.join(root, pinned.relative), 'utf8')).replaceAll('\n', '\r\n'));
  assert.equal((await sourceReviewInput(root, config, workflow, 'specification')).clarifications[0].sha256, pinned.reference.sha256);
  await put(root, pinned.relative, `${JSON.stringify({ ...pinned.record, responses: [] })}\n`);
  await assert.rejects(sourceReviewInput(root, config, workflow, 'specification'), { code: 'SOURCE_REVIEW_SOURCE_CHANGED' });
});

test('a renamed planning phase reads both its answers and the approved renamed scope answers', async (t) => {
  const { root, config, workflow } = await fixture(t);
  const scope = workflow.phases.specification;
  delete workflow.phases.specification;
  scope.id = 'custom-scope';
  scope.status = 'approved';
  workflow.phases['custom-scope'] = scope;
  workflow.phases['custom-plan'] = { ...scope, id: 'custom-plan', status: 'in_progress', generatedAgent: 'architect',
    requiredArtifact: { path: 'artifacts/plan.md' }, artifacts: [] };
  workflow.phaseOrder = ['custom-scope', 'custom-plan'];
  workflow.currentPhase = 'custom-plan';
  workflow.resolution.obligationGraph.nodes = [
    { id: 'custom-scope', responsibilities: ['scope', 'review'] },
    { id: 'custom-plan', responsibilities: ['plan', 'review'] }
  ];
  await put(root, `${ITEM}/artifacts/plan.md`, '# Plan\n| Clause | Expected paths | Planned tests |\n|---|---|---|\n| `EXAMPLE:REQ-001` | `src/app.mjs` | `test/app.test.mjs` |\n| `EXAMPLE:AC-001` | `src/app.mjs` | `test/app.test.mjs` |\n');
  await pinClarification(root, workflow, 'custom-scope');
  await pinClarification(root, workflow, 'custom-plan', { answer: 'Use the existing test harness.' });
  const packet = await sourceReviewContext(root, config, workflow, 'custom-plan', '.git/report.json');
  assert.equal(packet.kind, 'planning');
  assert.deepEqual(packet.clarifications.map((entry) => [entry.role, entry.phase]),
    [['current-phase', 'custom-plan'], ['approved-scope', 'custom-scope']]);
  const input = await sourceReviewInput(root, config, workflow, 'custom-plan');
  const report = structuredClone(packet.reportTemplate);
  report.rows.forEach((row) => { row.assessment = 'supported'; });
  report.clarificationsReviewed = ['clarification:current-phase'];
  assert.equal(checkSourceReviewReport(report, input).retentionReady, false, 'the approved scope answers must also be read');
  report.clarificationsReviewed.push('clarification:approved-scope');
  assert.equal(checkSourceReviewReport(report, input).evaluation.status, 'ready');
});

test('invalid, cross-Story or unpublished clarification cannot become review authority', async (t) => {
  for (const mutate of [
    (record) => { record.workId = 'OTHER'; },
    (record) => { record.phase = 'planning'; },
    (record) => { record.generation = 2; },
    (record) => { record.completed = false; },
    (record) => { record.responses[0].blocking = true; },
    (record) => { record.recordedBy = null; }
  ]) {
    const { root, config, workflow } = await fixture(t);
    await pinClarification(root, workflow, 'specification', { mutate });
    await assert.rejects(sourceReviewInput(root, config, workflow, 'specification'), { code: 'SOURCE_REVIEW_CLARIFICATION_INVALID' });
  }
  const { root, config, workflow } = await fixture(t);
  const pinned = await pinClarification(root, workflow, 'specification');
  // Both memory references agree, but the new file has not been published.
  const next = `${JSON.stringify({ ...pinned.record, responses: [{ ...pinned.record.responses[0], answer: 'Different answer.' }] })}\n`;
  await put(root, pinned.relative, next);
  const reference = { ...pinned.reference, sha256: sha(next) };
  workflow.phases.specification.clarifications = [reference];
  await put(root, `${ITEM}/artifacts/spec.md`, `<!-- singularity-flow:metadata\n${JSON.stringify({ clarification: reference })}\n-->\n\n${SPEC}`);
  workflow.phases.specification.artifacts[0].sha256 = sha(await readFile(path.join(root, `${ITEM}/artifacts/spec.md`)));
  await assert.rejects(sourceReviewInput(root, config, workflow, 'specification'), { code: 'SOURCE_REVIEW_INPUT_UNPUBLISHED' });
});

test('missing or hidden publication-bound answers fail explicitly, while a deferred answer stays labelled deferred', async (t) => {
  const { root, config, workflow } = await fixture(t);
  const pinned = await pinClarification(root, workflow, 'specification', { answer: 'Unknown until the test harness is inspected.', status: 'deferred' });
  assert.equal((await sourceReviewInput(root, config, workflow, 'specification')).clarifications[0].responses[0].status, 'deferred');
  const phase = workflow.phases.specification;
  phase.clarifications = [];
  await assert.rejects(sourceReviewInput(root, config, workflow, 'specification'), { code: 'SOURCE_REVIEW_CLARIFICATION_INVALID' });
  phase.clarifications = [pinned.reference, pinned.reference];
  await assert.rejects(sourceReviewInput(root, config, workflow, 'specification'), { code: 'SOURCE_REVIEW_CLARIFICATION_INVALID' });
  phase.clarifications = [pinned.reference];
  await rm(path.join(root, pinned.relative));
  await assert.rejects(sourceReviewInput(root, config, workflow, 'specification'), { code: 'SOURCE_REVIEW_INPUT_UNAVAILABLE' });
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

/** Retain a report and commit it, as the governed submit command does. */
async function retainReport(root, config, workflow, report, input) {
  const evaluation = evaluateSubmittedSourceReview(report, input, session);
  const reportEvent = await appendEvent(root, workflow, { kind: 'source-grounded-review',
    reportSha256: evaluation.reportSha256, actor: session.actor, agent: session.agent });
  await retainSourceReview(root, config, workflow, 'specification', report, evaluation, session, reportEvent);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Retain source review');
  return evaluation;
}

/** Record and commit an authorized human decision for a pending disposition. */
async function decide(root, config, workflow, findingId) {
  const pending = await readSourceReviewStatus(root, config, workflow, 'specification');
  const actor = { email: 'approver@example.test' };
  const decisionEvent = await appendEvent(root, workflow, { kind: 'source-review-disposition',
    reportSha256: pending.reportSha256, actor, authorityGroup: 'product-approvers', findingId });
  await retainSourceReviewDecision(root, config, workflow, 'specification', pending, findingId,
    'Reviewed by the product owner.', actor,
    { authorityGroup: 'product-approvers', identityAssurance: 'configured-local' }, decisionEvent);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', `Decide ${findingId}`);
}

function storyOnlyReport(input, rows = []) {
  return {
    schemaVersion: 1, resultType: 'source-grounded-review', kind: 'specification',
    binding: sourceReviewBinding(input), reviewer: { agentId: 'sflow-source-reviewer', readOnly: true },
    sourcesReviewed: input.sources.map((source) => source.id), findings: [],
    rows: [{ id: 'story-draft', sourceId: 'story', line: 2, quote: 'Save a draft and show saved status.',
      outcome: 'covered', scenarioId: 'S1', clauseIds: ['EXAMPLE:REQ-001', 'EXAMPLE:AC-001'] }, ...rows]
  };
}

test('a review still describes the artifact after submission rewrites its managed metadata', async (t) => {
  const envelope = (status) => `<!-- singularity-flow:metadata\n{"status":"${status}","generationCommit":null}\n-->\n`;
  const { root, config, workflow } = await fixture(t, { document: 'url', spec: `${envelope('in_progress')}${SPEC}` });
  const input = await sourceReviewInput(root, config, workflow, 'specification');
  assert.equal(input.artifact.text, SPEC, 'the reviewer reads what the author wrote');
  const context = await sourceReviewContext(root, config, workflow, 'specification', '.git/review.json');
  assert.equal(context.artifact.authoredContentSha256, sha(Buffer.from(SPEC)));
  assert.equal(context.artifact.registeredFileSha256, sha(Buffer.from(`${envelope('in_progress')}${SPEC}`)));
  assert.notEqual(context.artifact.authoredContentSha256, context.artifact.registeredFileSha256);
  assert.equal(context.artifact.integrity.status, 'verified');
  await retainReport(root, config, workflow, storyOnlyReport(input), input);
  await decide(root, config, workflow, 'unreadable:DOC-001');
  assert.equal((await readSourceReviewStatus(root, config, workflow, 'specification')).status, 'ready');
  // Submission replaces the envelope and re-registers the artifact; the authored text is unchanged.
  const submitted = `${envelope('awaiting_approval')}${SPEC}`;
  await put(root, `${ITEM}/artifacts/spec.md`, submitted);
  workflow.phases.specification.status = 'awaiting_approval';
  workflow.phases.specification.artifacts.push({ path: `${ITEM}/artifacts/spec.md`, sha256: sha(Buffer.from(submitted)) });
  await put(root, `${ITEM}/workflow.json`, `${JSON.stringify(workflow, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Submit for approval');
  assert.equal((await readSourceReviewStatus(root, config, workflow, 'specification')).status, 'ready',
    'submission must not make a ready review stale');
});

test('historical reviewer authorship is recoverable without forging provenance or replacing reviewer', async (t) => {
  const { root, config, workflow } = await fixture(t);
  const phase = workflow.phases.specification;
  workflow.resolution.sourceReview = { mode: 'enforce', phases: ['specification'], reviewerAgent: 'sflow-source-reviewer' };
  phase.defaultAgent = 'sflow-product-owner';
  phase.generatedAgent = 'sflow-source-reviewer';
  const before = JSON.stringify(workflow);
  const context = await sourceReviewContext(root, config, workflow, phase.id, '.git/review.json');
  assert.equal(context.reviewer.activation, 'blocked-author-conflict');
  assert.equal(context.reviewer.setupRequired, false);
  assert.equal(context.recovery.actions[0].command, 'singularity-flow agent --agent sflow-product-owner');
  assert.equal((await readSourceReviewStatus(root, config, workflow, phase.id)).status, 'author-conflict');
  const input = await sourceReviewInput(root, config, workflow, phase.id);
  assert.throws(() => scopedSourceReviewerSession(input, { ...session, agent: 'sflow-product-owner' }),
    error => error.code === 'SOURCE_REVIEW_AUTHOR_COLLISION' && error.details.actions.length === 2);
  assert.equal(JSON.stringify(workflow), before, 'review repaired provenance by rewriting history');
});

test('operation-scoped reviewer rejects cross-story/phase attachment and never mutates the author session', () => {
  const input = { workId: ID, phase: 'planning-copy', reviewerAgentId: 'sflow-source-reviewer',
    reviewerAgentSha256: REVIEWER_SHA256, authorAgentId: 'architect' };
  const authorSession = { actor: session.actor, agent: 'architect', agentSha256: 'b'.repeat(64),
    workId: ID, phaseId: 'planning-copy' };
  const before = JSON.stringify(authorSession);
  const reviewer = scopedSourceReviewerSession(input, authorSession);
  assert.equal(reviewer.agent, input.reviewerAgentId);
  assert.equal(reviewer.agentSha256, REVIEWER_SHA256);
  assert.equal(JSON.stringify(authorSession), before);
  for (const mismatch of [{ workId: 'OTHER' }, { phaseId: 'specification' }, { actor: null }]) {
    assert.throws(() => scopedSourceReviewerSession(input, { ...authorSession, ...mismatch }),
      error => error.code === 'SOURCE_REVIEW_SESSION_SCOPE_INVALID' && error.details.actions[0].skill === '/sf-session');
  }
});

test('a decision on an unreadable document carries over while that document is unchanged', async (t) => {
  const { root, config, workflow } = await fixture(t, { document: 'pdf' });
  const first = await sourceReviewInput(root, config, workflow, 'specification');
  assert.deepEqual(first.binding.unreadableSources, [{ id: 'DOC-001', code: 'no-text-layer', originalSha256: sha(Buffer.from(PDF)) }]);
  await retainReport(root, config, workflow, storyOnlyReport(first), first);
  await decide(root, config, workflow, 'unreadable:DOC-001');
  assert.equal((await readSourceReviewStatus(root, config, workflow, 'specification')).status, 'ready');

  // A new generation needs a new report, but not a new decision on the unchanged PDF.
  workflow.phases.specification.generation = 2;
  const second = await sourceReviewInput(root, config, workflow, 'specification');
  await retainReport(root, config, workflow, storyOnlyReport(second), second);
  const carried = await readSourceReviewStatus(root, config, workflow, 'specification');
  assert.equal(carried.status, 'ready');
  assert.deepEqual(carried.carriedDecisions.map((entry) => [entry.id, entry.carriedFrom.generation]), [['unreadable:DOC-001', 1]]);

  // A replaced PDF is a different document as far as the decision is concerned.
  const replaced = `${PDF}% revised\n`;
  await put(root, `${ITEM}/inputs/brief.pdf`, replaced);
  const manifest = JSON.parse(await readFile(path.join(root, ITEM, 'documents.json'), 'utf8'));
  manifest.documents[0].sha256 = sha(Buffer.from(replaced));
  await put(root, `${ITEM}/documents.json`, `${JSON.stringify(manifest)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Replace the PDF');
  workflow.phases.specification.generation = 3;
  const third = await sourceReviewInput(root, config, workflow, 'specification');
  await retainReport(root, config, workflow, storyOnlyReport(third), third);
  const fresh = await readSourceReviewStatus(root, config, workflow, 'specification');
  assert.equal(fresh.status, 'correction-required');
  assert.deepEqual(fresh.pendingDispositions.map((entry) => entry.id), ['unreadable:DOC-001']);
});

test('a scenario grounded only in an unreadable document is attested by a person', async (t) => {
  const { root, config, workflow } = await fixture(t, { document: 'url' });
  const input = await sourceReviewInput(root, config, workflow, 'specification');
  const unattested = storyOnlyReport(input, [{ id: 'link-draft', sourceId: 'DOC-001', outcome: 'covered',
    scenarioId: 'S1', clauseIds: ['EXAMPLE:REQ-001'] }]);
  const refused = checkSourceReviewReport(unattested, input);
  assert.ok(refused.findings.some((entry) => entry.code === 'attestation-invalid'));
  assert.equal(refused.retentionReady, false);
  assert.throws(() => evaluateSubmittedSourceReview(unattested, input, session),
    (error) => error.code === 'SOURCE_REVIEW_REPORT_INVALID');
  const report = storyOnlyReport(input, [{ id: 'link-draft', sourceId: 'DOC-001', outcome: 'covered',
    scenarioId: 'S1', clauseIds: ['EXAMPLE:REQ-001'], attestation: 'Section "Drafts" of the linked page.' }]);
  await retainReport(root, config, workflow, report, input);
  const pending = await readSourceReviewStatus(root, config, workflow, 'specification');
  assert.deepEqual(pending.pendingDispositions.map((entry) => entry.id).sort(), ['attested:link-draft', 'unreadable:DOC-001']);
  await decide(root, config, workflow, 'attested:link-draft');
  await decide(root, config, workflow, 'unreadable:DOC-001');
  assert.equal((await readSourceReviewStatus(root, config, workflow, 'specification')).status, 'ready');
});

test('an empty attachment and documents past the review budget become decisions, not refusals', async (t) => {
  const empty = await fixture(t, { notes: '' });
  const emptyInput = await sourceReviewInput(empty.root, empty.config, empty.workflow, 'specification');
  assert.deepEqual(emptyInput.binding.unreadableSources.map((entry) => [entry.id, entry.code]), [['DOC-001', 'empty-text']]);

  // Five sources of almost 1 MiB each exceed the 4 MiB review budget; the last one waits for a person.
  const big = (n) => `# Part ${n}\n${'x'.repeat(1_000_000)}\n`;
  const extraDocuments = [2, 3, 4, 5].map((n) => ({ id: `DOC-00${n}`, path: `${ITEM}/inputs/part-${n}.md`, text: big(n) }));
  const large = await fixture(t, { notes: big(1), extraDocuments });
  const largeInput = await sourceReviewInput(large.root, large.config, large.workflow, 'specification');
  assert.deepEqual(largeInput.sources.map((source) => source.id), ['story', 'DOC-001', 'DOC-002', 'DOC-003', 'DOC-004']);
  assert.deepEqual(largeInput.binding.unreadableSources.map((entry) => [entry.id, entry.code]), [['DOC-005', 'review-budget-exceeded']]);
});

test('a changed pinned attachment is rejected', async (t) => {
  const changed = await fixture(t);
  await put(changed.root, `${ITEM}/inputs/notes.md`, `${NOTES}Changed.\n`);
  await assert.rejects(sourceReviewInput(changed.root, changed.config, changed.workflow, 'specification'),
    { code: 'SOURCE_REVIEW_SOURCE_CHANGED' });
});

test('a checkout that rewrote an attachment\'s line endings still reviews its committed bytes', async (t) => {
  const { root, config, workflow } = await fixture(t);
  await put(root, `${ITEM}/inputs/notes.md`, NOTES.replaceAll('\n', '\r\n'));
  const packet = await sourceReviewContext(root, config, workflow, 'specification', '/tmp/report.json');
  assert.equal(packet.sources[1].originalSha256, sha(Buffer.from(NOTES)));
  assert.equal(packet.sources[1].text, NOTES);
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
