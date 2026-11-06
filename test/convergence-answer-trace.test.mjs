/**
 * A person may change a convergence answer, and the one it replaces stays on the record. A second
 * approver's answer used to erase the first with no trace. Every sealed record from before this
 * verifies and reads exactly as it did: only a record that really holds a replaced answer is new.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  adjudicatedConvergenceProjection, assertConvergencePublishable, decodeConvergenceRecord, findingAdjudication,
  renderConvergenceArtifact, replacedAnswers, serializeConvergence
} from '../src/convergence.mjs';
import { recordSha256 } from '../src/records.mjs';
import { convergenceSealCore, currentSchemaVersion, readRecord } from '../src/schema-migrations.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'convergence');
const frozen = (name, encoding) => readFile(path.join(fixtures, name), encoding);
const IDENTITY = { workId: 'BIN-1', iteration: 1 };
const AT = '2026-11-06T09:00:00.000Z';

async function changedAnswer() {
  const read = decodeConvergenceRecord(await frozen('v5-decided.json'), IDENTITY);
  const earlier = findingAdjudication(read.findings[0]);
  const second = { itemId: earlier.itemId, disposition: 'deferred', classification: earlier.classification ?? null,
    reason: 'A later Story owns this.', clauseIds: [], actor: 'reviewer-two', at: AT,
    replaced: replacedAnswers(earlier) };
  const others = read.findings.slice(1).map(findingAdjudication);
  return { read, earlier, projection: adjudicatedConvergenceProjection(read, [...others, second]) };
}

test('a stored v5 record verifies, reads the same, keeps its seal, and its report is the same bytes', async () => {
  assert.equal(currentSchemaVersion('convergence-record'), 6);
  const bytes = await frozen('v5-decided.json');
  const v5 = JSON.parse(bytes);
  assert.equal(v5.schemaVersion, 5);
  const read = decodeConvergenceRecord(bytes, IDENTITY);
  assert.equal(read.schemaVersion, 6);
  assert.equal(read.convergenceSha256, v5.convergenceSha256, 'reading an old record changed its seal');
  assert.deepEqual(read.findings, v5.findings);
  const report = await frozen('v5-decided.md', 'utf8');
  assert.equal(renderConvergenceArtifact(read), report, 'the report of a stored record reads differently');
  assert.doesNotThrow(() => assertConvergencePublishable(read, report));
  assert.throws(() => decodeConvergenceRecord(JSON.stringify({ ...v5, workId: 'SOMEONE-ELSE' })), (error) => error.code === 'CONVERGENCE_RECORD_CORRUPT');
});

test('a stored v4 record still keeps its seal and its report through both steps', async () => {
  const bytes = await frozen('v4-decided.json');
  const read = decodeConvergenceRecord(bytes, IDENTITY);
  assert.equal(read.schemaVersion, 6);
  assert.equal(read.convergenceSha256, JSON.parse(bytes).convergenceSha256);
  assert.equal(renderConvergenceArtifact(read), await frozen('v4-decided.md', 'utf8'));
});

test('changing an answer keeps the earlier one, whoever gave it, and the record verifies', async () => {
  const { earlier, projection } = await changedAnswer();
  const finding = projection.findings.find((entry) => entry.itemId === earlier.itemId);
  assert.equal(finding.disposition, 'deferred');
  assert.equal(finding.decision.actor, 'reviewer-two');
  assert.deepEqual(finding.decision.replaced, [{ disposition: earlier.disposition, classification: earlier.classification, clauseIds: earlier.clauseIds,
    reason: earlier.reason, actor: earlier.actor, at: earlier.at }]);
  const reread = decodeConvergenceRecord(serializeConvergence(projection), IDENTITY);
  assert.deepEqual(reread.findings, projection.findings);
  assert.equal(reread.convergenceSha256, projection.convergenceSha256);
});

test('a third answer keeps both before it, oldest first, signatures and all', async () => {
  const { read, earlier, projection } = await changedAnswer();
  const second = projection.findings.find((entry) => entry.itemId === earlier.itemId);
  const third = { itemId: earlier.itemId, disposition: 'dismissed', classification: earlier.classification ?? null, reason: 'Not a real difference.',
    clauseIds: [], actor: 'reviewer-three', at: '2026-11-06T10:00:00.000Z', replaced: replacedAnswers({ ...findingAdjudication(second), presence: { signature: 'kept' } }) };
  const others = read.findings.slice(1).map(findingAdjudication);
  const next = adjudicatedConvergenceProjection(projection, [...others, third]);
  const trace = next.findings.find((entry) => entry.itemId === earlier.itemId).decision.replaced;
  assert.deepEqual(trace.map((entry) => entry.actor), [earlier.actor, 'reviewer-two']);
  assert.deepEqual(trace[1].presence, { signature: 'kept' });
  assert.deepEqual(decodeConvergenceRecord(serializeConvergence(next), IDENTITY).findings, next.findings);
});

test('taking the earlier answer out of a sealed record is caught', async () => {
  const { earlier, projection } = await changedAnswer();
  const tampered = structuredClone({ ...projection });
  delete tampered.findings.find((entry) => entry.itemId === earlier.itemId).decision.replaced;
  assert.throws(() => decodeConvergenceRecord(serializeConvergence(tampered), IDENTITY), (error) => error.code === 'CONVERGENCE_RECORD_HASH_MISMATCH');
  const edited = structuredClone({ ...projection });
  edited.findings.find((entry) => entry.itemId === earlier.itemId).decision.replaced = [{ disposition: 'rework' }];
  assert.throws(() => decodeConvergenceRecord(serializeConvergence(edited), IDENTITY), (error) => /^CONVERGENCE_RECORD_/u.test(error.code));
});

test('only a record that holds a replaced answer seals as v6', async () => {
  const { read, projection } = await changedAnswer();
  assert.equal(convergenceSealCore(read).schemaVersion, 5, 'a record with a settled list seals as v5');
  assert.equal(convergenceSealCore(projection).schemaVersion, 6);
  assert.equal(projection.convergenceSha256, recordSha256(convergenceSealCore(projection)));
  assert.equal(readRecord('convergence-record', serializeConvergence(projection)).storedVersion, 6);
  assert.throws(() => readRecord('convergence-record', JSON.stringify({ ...projection, schemaVersion: 7 })), (error) => error.code === 'SCHEMA_VERSION_FUTURE');
});

test('the report says what was changed, by whom, and a record with no change reads as it did', async () => {
  const { earlier, projection } = await changedAnswer();
  const report = renderConvergenceArtifact(projection);
  assert.match(report, /## Changed answers/u);
  const finding = projection.findings.find((entry) => entry.itemId === earlier.itemId);
  const row = report.split('\n').find((line) => line.startsWith(`| ${finding.id} |`) && line.includes(earlier.actor));
  assert.ok(row, 'a row names the finding and the person who gave the earlier answer');
  assert.ok(row.includes(earlier.at));
  assert.ok(row.includes(earlier.disposition));
  assert.ok(row.includes('deferred') && row.includes('reviewer-two'), 'and what it became, by whom');
  assert.doesNotMatch(await frozen('v5-decided.md', 'utf8'), /Changed answers/u);
  assert.doesNotThrow(() => assertConvergencePublishable(projection, report));
});
