import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderInputsBlock } from '../src/inputs.mjs';
import { renderPromptInputsBlock } from '../src/prompt-input-projection.mjs';
import { extractClauses } from '../src/specifications.mjs';
import { recordSha256 } from '../src/records.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const sourcePath = 'singularity/work-items/PROJECTION/artifacts/specification/spec.md';
const sourceSha256 = 'a'.repeat(64);
const list = [
  '- Every export must retain the approved display precision and stable ordering. [PROJECTION:REQ-001]',
  '- A failed request must retain the original data and display a useful retry message. [PROJECTION:REQ-002]',
  '- Unicode values, including café and 東京, must round-trip without data loss. [PROJECTION:REQ-003]'
].join('\n');
const summary = `# Approved brief\n\n## Summary\n\nExport behavior is unchanged.\n\n## Requirements\n\n${list}\n\n## Supporting files\n\n| Clause | Source | Test |\n| --- | --- | --- |\n| PROJECTION:REQ-001 | src/export.js | export.test.js |\n`;

function bindCapsule(capsule) {
  const { capsuleSha256: _ignored, ...payload } = capsule;
  return { ...payload, capsuleSha256: `sha256:${recordSha256(payload)}` };
}

function fixture(content = summary) {
  const capsule = bindCapsule({
    schemaVersion: 1, workId: 'PROJECTION', phase: 'planning', openRisks: [], clarifications: [],
    clauses: extractClauses(list, { sourcePath }).map((clause) => ({
      id: clause.id, text: clause.body, source: clause.source,
      sourceSha256: `sha256:${sourceSha256}`, dependencies: clause.dependsOn
    }))
  });
  const entry = {
    phase: 'specification', path: 'artifacts/specification/spec.md', repositoryPath: sourcePath,
    status: 'captured', sha256: sourceSha256, source: { path: sourcePath, rawSha256: sourceSha256 },
    content, truncated: false,
    projection: { kind: 'approved-summary', briefSha256: hash(content) },
    representation: { kind: 'summary', sha256: `sha256:${hash(content)}`, bytes: Buffer.byteLength(content), complete: false, expansionHandle: 'sfref:approved-source' }
  };
  return { result: { mode: 'enforce', records: [entry] }, capsule, entry };
}

test('verified summary duplicate clauses become capsule references without altering durable inputs', () => {
  const { result, capsule } = fixture();
  const original = structuredClone(result);
  const durable = renderInputsBlock(result);
  const projected = renderPromptInputsBlock(result, capsule);
  assert.match(projected.text, /Exact clauses in Active Clause Capsule: PROJECTION:REQ-001, PROJECTION:REQ-002, PROJECTION:REQ-003/);
  assert.doesNotMatch(projected.text, /Every export must retain/);
  assert.match(projected.text, /Export behavior is unchanged/);
  assert.match(projected.text, /src\/export.js \| export.test.js/);
  assert.match(projected.text, /sfref:approved-source/);
  assert.match(projected.text, new RegExp(sourceSha256));
  assert.equal(projected.projection.inputs.length, 1);
  assert.equal(projected.projection.inputs[0].deduplicatedClauseIds.length, 3);
  assert.match(projected.text, new RegExp(`representation-sha256=${projected.projection.inputs[0].renderedSha256}`));
  assert.match(projected.text, new RegExp(`brief-sha256=${original.records[0].projection.briefSha256}`));
  assert.ok(projected.projection.savedBytes > 0);
  assert.equal(projected.projection.originalContentBytes - projected.projection.renderedContentBytes,
    projected.projection.savedBytes);
  assert.notEqual(projected.projection.originalSha256, projected.projection.renderedSha256);
  assert.deepEqual(result, original);
  assert.deepEqual(renderInputsBlock(result), durable);
  assert.deepEqual(renderPromptInputsBlock(result, capsule), projected, 'repeat composition is deterministic');
});

test('duplicate projection requires complete verified summary and exact expansion/source identities', () => {
  const variations = [
    (value) => { value.entry.status = 'hash_mismatch'; },
    (value) => { value.entry.truncated = true; },
    (value) => { value.entry.projection.kind = 'fallback-whole'; },
    (value) => { value.entry.representation.kind = 'full'; },
    (value) => { value.entry.representation.expansionHandle = null; },
    (value) => { value.entry.content += '\nChanged after verification.'; },
    (value) => { value.entry.projection.briefSha256 = 'b'.repeat(64); },
    (value) => { value.entry.source.path = 'another.md'; },
    (value) => { value.entry.repositoryPath = 'another.md'; },
    (value) => { value.entry.source.rawSha256 = 'b'.repeat(64); },
    (value) => { value.entry.sha256 = 'b'.repeat(64); },
    (value) => { value.capsule.capsuleSha256 = 'b'.repeat(64); },
    (value) => { value.capsule.clauses.forEach((clause) => { clause.sourceSha256 = 'b'.repeat(64); }); value.capsule = bindCapsule(value.capsule); },
    (value) => { value.capsule.clauses.forEach((clause) => { clause.text += ' Different obligation.'; }); value.capsule = bindCapsule(value.capsule); }
  ];
  for (const change of variations) {
    const value = fixture();
    change(value);
    const projected = renderPromptInputsBlock(value.result, value.capsule);
    assert.equal(projected.text, renderInputsBlock(value.result).text, change.toString());
    assert.equal(projected.projection.savedBytes, 0);
  }
});

test('notes, code, comments, tables, nested sections and duplicate anchors are never discarded', () => {
  for (const body of [
    `${list}\n\nKeep this extra unique obligation.`,
    `${list}\n\n- Keep this unanchored obligation.`,
    `${list}\n\n  <!-- keep this note -->`,
    `${list}\n\n\`\`\`js\nrunThis();\n\`\`\``,
    `${list}\n\n| Path | src/export.js |`,
    `${list}\n\n### Notes\n\nRetain extra scope.`,
    `${list}\n${list.split('\n')[0]}`,
    list.replace('PROJECTION:REQ-001', 'OTHER-PROJECTION:REQ-001')
  ]) {
    const value = fixture(summary.replace(list, body));
    assert.equal(renderPromptInputsBlock(value.result, value.capsule).text, renderInputsBlock(value.result).text, body);
  }
});

test('no capsule, disabled inputs and very short sections remain byte-identical', () => {
  const value = fixture();
  assert.equal(renderPromptInputsBlock(value.result, null).text, renderInputsBlock(value.result).text);
  const disabled = { ...value.result, mode: 'off' };
  const disabledProjection = renderPromptInputsBlock(disabled, value.capsule);
  assert.equal(disabledProjection.text, '');
  assert.equal(disabledProjection.projection.savedBytes, 0);
  assert.deepEqual(disabledProjection.projection.inputs, []);
  const short = fixture('## Requirements\n\n- Short. [PROJECTION:REQ-001]\n');
  short.capsule.clauses[0].text = 'Short.';
  short.capsule = bindCapsule(short.capsule);
  assert.equal(renderPromptInputsBlock(short.result, short.capsule).text, renderInputsBlock(short.result).text);
});
