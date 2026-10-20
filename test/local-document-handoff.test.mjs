import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { publishedSpecificationStory, reviewReport } from './helpers/source-review-fixture.mjs';
import { loadConfig } from '../src/state.mjs';
import { loadStoryAggregate } from '../src/state-stores.mjs';
import { addDocuments, restoreLocalDocument } from '../src/documents.mjs';
import { phaseDocumentReadiness, withLocalDocumentEvidence } from '../src/document-runtime.mjs';
import { sourceReviewContext, sourceReviewInput, checkSourceReviewReport } from '../src/source-review-lifecycle.mjs';
import { resolveDocumentStorage } from '../src/document-storage-policy.mjs';
import { readLocalDocument } from '../src/document-storage.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const { root, phaseId } = await publishedSpecificationStory(t);
  const inputs = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-uploads-'));
  t.after(() => rm(inputs, { recursive: true, force: true }));
  const notes = path.join(inputs, 'requirements.md');
  const image = path.join(inputs, 'saved-screen.png');
  await writeFile(notes, '# Local source\nA saved draft displays saved status.\n');
  await writeFile(image, png);
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, 'REVIEW-1');
  const records = await addDocuments(root, config, workflow, { files: [notes, image],
    names: ['Draft rules', 'Saved-state screen'] });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Record document identities only');
  return { root, phaseId, inputs, notes, image, config, workflow, records };
}

test('new workflows keep images and requirement sources local, while old shared policy remains explicit', async t => {
  assert.equal(resolveDocumentStorage(null), 'local');
  assert.equal(resolveDocumentStorage(null, { storage: { default: 'git' } }), 'git');
  const { root, config, workflow, phaseId, records } = await fixture(t);
  assert.deepEqual(records.map(record => record.storage.kind), ['local', 'local']);
  assert.ok(records.every(record => record.path === undefined));
  assert.equal(git(root, 'ls-files', 'singularity/work-items/REVIEW-1/inputs'), '');
  const text = await withLocalDocumentEvidence(root, config, workflow, phaseId, '# Durable metadata only\n');
  assert.match(text, /A saved draft displays saved status/);
  assert.match(text, /Saved-state screen/);
  assert.match(text, /native file\/image\/PDF tool/);
  assert.equal(spawnSync('git', ['grep', '-F', 'A saved draft displays saved status.', 'HEAD'], { cwd: root }).status, 1,
    'source text never becomes a Git object through upload or runtime delivery');
});

test('another clone asks only for phase-required documents and restores exact existing IDs without Git mutations', async t => {
  const { root, config, workflow, phaseId, records, notes, image, inputs } = await fixture(t);
  const second = path.join(inputs, 'another-laptop');
  git(root, 'clone', '--quiet', '--no-local', root, second);
  const beforeHead = git(second, 'rev-parse', 'HEAD');
  const manifestPath = path.join(second, 'singularity/work-items/REVIEW-1/documents.json');
  const beforeManifest = await readFile(manifestPath, 'utf8');
  const missing = await phaseDocumentReadiness(second, config, workflow, phaseId);
  assert.equal(missing.status, 'upload-required');
  assert.deepEqual(missing.missing.map(record => record.id), records.map(record => record.id));
  assert.ok(missing.missing.every(record => record.commandGuidance.copilotCommand?.includes('sf-documents')));
  for (const [record, file] of [[records[0], notes], [records[1], image]]) {
    const restored = await restoreLocalDocument(second, config, workflow, { documentId: record.id, file });
    assert.equal(restored.documentId, record.id);
    assert.equal(restored.effects.committed, false);
  }
  assert.equal((await phaseDocumentReadiness(second, config, workflow, phaseId)).status, 'ready');
  assert.equal(git(second, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(second, 'status', '--porcelain'), '');
  assert.equal(await readFile(manifestPath, 'utf8'), beforeManifest);
  const firstBinding = (await sourceReviewInput(root, config, workflow, phaseId)).binding;
  assert.deepEqual((await sourceReviewInput(second, config, workflow, phaseId)).binding, firstBinding,
    'restoring on another laptop reproduces exactly the same source binding');
});

test('wrong and symlinked originals cannot replace an existing document; scoped-out documents are not requested', async t => {
  const { root, config, workflow, records, notes, image, phaseId, inputs } = await fixture(t);
  await assert.rejects(restoreLocalDocument(root, config, workflow, { documentId: records[0].id, file: image }),
    error => error.code === 'DOCUMENT_RESTORE_HASH_MISMATCH');
  if (process.platform !== 'win32') {
    const linked = path.join(inputs, 'linked.md');
    await symlink(notes, linked);
    await assert.rejects(restoreLocalDocument(root, config, workflow, { documentId: records[0].id, file: linked }));
  }
  const manifestPath = path.join(root, 'singularity/work-items/REVIEW-1/documents.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.documents[0].phases = ['planning'];
  manifest.documents[1].status = 'detached';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const second = path.join(inputs, 'scoped-laptop');
  await mkdir(second);
  git(second, 'init', '-q');
  await mkdir(path.join(second, 'singularity/work-items/REVIEW-1'), { recursive: true });
  await writeFile(path.join(second, 'singularity/work-items/REVIEW-1/documents.json'), JSON.stringify(manifest));
  assert.equal((await phaseDocumentReadiness(second, config, workflow, phaseId)).status, 'ready');
  assert.deepEqual((await phaseDocumentReadiness(second, config, workflow, 'planning')).missing.map(record => record.id), [records[0].id]);
});

test('source review reads local text and requires genuine per-image inspection instead of automatic unreadable decisions', async t => {
  const { root, config, workflow, phaseId, records } = await fixture(t);
  const packet = await sourceReviewContext(root, config, workflow, phaseId, null);
  assert.equal(packet.unreadableSources, undefined);
  assert.match(packet.sources.find(source => source.id === records[0].id).text, /A saved draft/);
  assert.equal(packet.visualSources[0].id, records[1].id);
  assert.equal(packet.visualSources[0].mimeType, 'image/png');
  const report = reviewReport(packet);
  report.rows.push({ id: 'local-rule', sourceId: records[0].id, line: 2,
    quote: 'A saved draft displays saved status.', outcome: 'covered', scenarioId: 'S1', clauseIds: ['REVIEW-1:AC-001'] });
  report.rows.push({ id: 'local-screen', sourceId: records[1].id,
    attestation: 'Full image: saved-state presentation is inspected.', outcome: 'covered', scenarioId: 'S1', clauseIds: ['REVIEW-1:AC-001'] });
  const input = await sourceReviewInput(root, config, workflow, phaseId);
  const uninspected = checkSourceReviewReport(report, input);
  assert.equal(uninspected.retentionReady, false);
  assert.ok(uninspected.findings.some(finding => finding.code === 'visual-sources-not-reviewed'));
  report.visualSourcesReviewed = [{ sourceId: records[1].id, method: 'image-tool',
    locator: 'Full image', observations: 'A small monochrome image; no conversion result is claimed.' }];
  const inspected = checkSourceReviewReport(report, input);
  assert.equal(inspected.retentionReady, true, JSON.stringify(inspected.findings));
  assert.ok(!inspected.evaluation.pendingDispositions.some(item => item.id.startsWith('unreadable:')));
});

test('missing documents return an actionable upload request before review, without staging a fabricated report', async t => {
  const { root, config, workflow, phaseId, inputs } = await fixture(t);
  const second = path.join(inputs, 'missing-laptop');
  git(root, 'clone', '--quiet', '--no-local', root, second);
  const packet = await sourceReviewContext(second, config, workflow, phaseId, null);
  assert.equal(packet.canReview, false);
  assert.equal(packet.status, 'documents-required');
  assert.equal(packet.binding, null);
  assert.equal(packet.documentReadiness.missing.length, 2);
  assert.ok(packet.continuation.actions.every(action => action.argv[0] === 'documents' && action.argv[1] === 'restore'));
});

test('restoring the original preserves a damaged local copy and never accepts different bytes', async t => {
  const { root, config, workflow, phaseId, records, notes } = await fixture(t);
  const original = await readLocalDocument(root, workflow.workItem.id, records[0]);
  await writeFile(original.absolutePath, 'A damaged local copy that must not be deleted.');
  assert.equal((await phaseDocumentReadiness(root, config, workflow, phaseId)).missing[0].availability, 'changed');
  const restored = await restoreLocalDocument(root, config, workflow, { documentId: records[0].id, file: notes });
  assert.equal(await readFile(restored.preservedPath, 'utf8'), 'A damaged local copy that must not be deleted.');
  assert.deepEqual((await readLocalDocument(root, workflow.workItem.id, records[0])).bytes, await readFile(notes));
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('PDF sources require a PDF inspection receipt, not an invented text citation or image receipt', async t => {
  const { root, config, workflow, phaseId, inputs } = await fixture(t);
  const file = path.join(inputs, 'layout.pdf');
  await writeFile(file, '%PDF-1.4\n% Native tool inspection fixture\n%%EOF\n');
  const [record] = await addDocuments(root, config, workflow, { files: [file], names: ['Layout document'] });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Pin local PDF identity');
  const packet = await sourceReviewContext(root, config, workflow, phaseId, null);
  const input = await sourceReviewInput(root, config, workflow, phaseId);
  const report = reviewReport(packet);
  report.rows.push({ id: 'local-rule', sourceId: 'DOC-001', line: 2,
    quote: 'A saved draft displays saved status.', outcome: 'covered', scenarioId: 'S1', clauseIds: ['REVIEW-1:AC-001'] });
  for (const visual of packet.visualSources) report.rows.push({ id: `visual-${visual.id}`, sourceId: visual.id,
    attestation: 'Full document or image inspected for the saved-state layout.', outcome: 'covered', scenarioId: 'S1', clauseIds: ['REVIEW-1:AC-001'] });
  report.visualSourcesReviewed = packet.visualSources.map(source => ({ sourceId: source.id,
    method: 'image-tool', locator: 'Full image', observations: 'Test receipt for source-reading validation only.' }));
  assert.ok(checkSourceReviewReport(report, input).findings.some(finding => finding.code === 'visual-inspection-invalid'));
  Object.assign(report.visualSourcesReviewed.find(source => source.sourceId === record.id), {
    method: 'pdf-tool', locator: 'Page 1', observations: 'Test receipt for a PDF tool inspection; no text extraction is claimed.' });
  assert.equal(checkSourceReviewReport(report, input).retentionReady, true);
  assert.ok(!input.binding.visualSources.some(source => Object.hasOwn(source, 'absolutePath')),
    'cross-laptop review binding must not contain a machine path');
});

test('a high-resolution image is not subjected to the text citation budget', async t => {
  const { root, config, workflow, phaseId, inputs } = await fixture(t);
  const file = path.join(inputs, 'large-screen.png');
  await writeFile(file, Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]));
  const [record] = await addDocuments(root, config, workflow, { files: [file], names: ['High-resolution screen'] });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Pin high-resolution image identity');
  const input = await sourceReviewInput(root, config, workflow, phaseId);
  assert.ok(input.visualSources.some(source => source.id === record.id));
  assert.ok(!input.unreadableSources?.some(source => source.id === record.id));
});

test('missing originals are requested consistently in every phase, including a custom future phase', async t => {
  const { root, config, workflow, inputs } = await fixture(t);
  const manifestPath = path.join(root, 'singularity/work-items/REVIEW-1/documents.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Legacy records without an explicit phase list remain offered to all phases, including custom ones.
  for (const record of manifest.documents) delete record.phases;
  await writeFile(manifestPath, JSON.stringify(manifest));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'Use all-phase document scope');
  const second = path.join(inputs, 'all-phase-laptop');
  git(root, 'clone', '--quiet', '--no-local', root, second);
  for (const phase of [...workflow.phaseOrder, 'custom-future-phase']) {
    const readiness = await phaseDocumentReadiness(second, config, workflow, phase);
    assert.equal(readiness.status, 'upload-required', phase);
    assert.deepEqual(readiness.missing.map(record => record.id), ['DOC-001', 'DOC-002'], phase);
    assert.ok(readiness.missing.every(record => record.commandGuidance.argv.includes('REVIEW-1')));
  }
});
