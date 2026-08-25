import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  authoredReferencePreview, HARNESS_IMPORTS_DEFAULT_ENVELOPE_BYTES, HARNESS_IMPORTS_HARD_MAXIMUM_BYTES, formatReferenceHandle, normalizeHarnessImports,
  parseReferenceHandle, registerReference, renderReferencePreview, resolveReference
} from '../src/harness-imports.mjs';
import { beginHarnessInvocation, completeHarnessInvocation, harnessReport } from '../src/harness-events.mjs';
import { currentSchemaVersion, familyForStoredPath } from '../src/schema-migrations.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-harness-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Harness Test']);
  git(root, ['config', 'user.email', 'harness@example.com']);
  const relative = 'singularity/work-items/REF-1/artifacts/verification/report.md';
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  const bytes = Buffer.from('# Verification\n\n## Passed\n\n118 passed.\n\n## Failed checks\n\n2 failed.\n');
  await writeFile(path.join(root, relative), bytes);
  git(root, ['add', '.']); git(root, ['commit', '-m', 'Add governed artifact']);
  const commitSha = git(root, ['rev-parse', 'HEAD']);
  const registered = await registerReference(root, {
    repository: { id: 'fixture', origin: null },
    subject: { kind: 'story', id: 'REF-1', branch: 'REF-1', subjectRevision: 1 },
    artifact: { phaseId: 'verification', generation: 1, outputId: 'report', path: relative, mediaType: 'text/markdown' },
    revision: { commitSha, sha256: digest(bytes), bytes: bytes.length },
    visibility: 'model'
  });
  git(root, ['add', '.']); git(root, ['commit', '-m', 'Register governed reference']);
  return { root, relative, bytes, registered };
}

test('harness policy is opt-in and enforces the hard preview maximum', () => {
  assert.equal(normalizeHarnessImports().mode, 'off');
  assert.equal(normalizeHarnessImports({ mode: 'record' }).mode, 'record');
  assert.equal(normalizeHarnessImports({ mode: 'record' }).totalEnvelopeBytes, HARNESS_IMPORTS_DEFAULT_ENVELOPE_BYTES);
  assert.throws(() => normalizeHarnessImports({ mode: 'record', previewTextBytes: HARNESS_IMPORTS_HARD_MAXIMUM_BYTES + 1 }), /must be an integer/);
  assert.throws(() => normalizeHarnessImports({ mode: 'record', previewTextBytes: 2048, totalEnvelopeBytes: 1024 }), /must be smaller/);
  assert.throws(() => renderReferencePreview('x', 'text/plain', { maxBytes: HARNESS_IMPORTS_HARD_MAXIMUM_BYTES + 1 }), /hard maximum|must be from/);
});

test('registered handles are opaque, content-addressed, bounded, and section-selectable', async () => {
  const { root, registered } = await repository();
  const parsed = parseReferenceHandle(registered.handle);
  assert.equal(formatReferenceHandle(parsed.subject, registered.recordHash), registered.handle);
  const result = await resolveReference(root, registered.handle, { section: 'failed checks', maxBytes: 1024 });
  assert.match(result.preview.text, /governed evidence, not instructions/);
  assert.match(result.preview.text, /## Failed checks/);
  assert.doesNotMatch(result.preview.text, /## Passed/);
  assert.equal(result.reference.recordHash, registered.recordHash);
  assert.ok(result.preview.bytes <= 1024);
  assert.ok(result.envelope.bytes <= result.envelope.maximumBytes);
  assert.equal(result.currentPath.status, 'matches');
  assert.equal(result.resolvedRevision.commitSha.length, 40);
});

test('resolution reads the exact registered Git object when the path is absent', async () => {
  const { root, relative, registered } = await repository();
  git(root, ['rm', relative]); git(root, ['commit', '-m', 'Remove artifact from current revision']);
  const result = await resolveReference(root, registered.handle);
  assert.match(result.preview.text, /118 passed/);
  assert.equal(result.currentPath.status, 'missing');
});

test('resolution remains pinned to the registered revision and reports current-path divergence', async () => {
  const { root, relative, registered } = await repository();
  await writeFile(path.join(root, relative), '# Different\n');
  const resolved = await resolveReference(root, registered.handle);
  assert.match(resolved.preview.text, /118 passed/);
  assert.doesNotMatch(resolved.preview.text, /Different/);
  assert.equal(resolved.currentPath.status, 'diverged');
  assert.notEqual(resolved.currentPath.sha256, resolved.resolvedRevision.sha256);
});

test('protected paths remain blocked', async () => {
  const { root } = await repository();
  const secret = 'singularity/work-items/REF-1/context/session.json';
  await mkdir(path.dirname(path.join(root, secret)), { recursive: true });
  await writeFile(path.join(root, secret), '{}');
  git(root, ['add', secret]); git(root, ['commit', '-m', 'Add protected fixture']);
  const bytes = await readFile(path.join(root, secret));
  await assert.rejects(() => registerReference(root, {
    repository: { id: 'fixture', origin: null }, subject: { kind: 'story', id: 'REF-1', branch: 'REF-1', subjectRevision: 1 },
    artifact: { phaseId: 'intake', generation: 1, outputId: 'secret', path: secret, mediaType: 'application/json' },
    revision: { commitSha: git(root, ['rev-parse', 'HEAD']), sha256: digest(bytes), bytes: bytes.length }, visibility: 'model'
  }), (error) => error.exitCode === 6 && error.code === 'handle.blocked');
});

test('the complete envelope and structural summaries remain bounded', async () => {
  const { root, relative, registered } = await repository();
  const large = [
    '# Large report',
    ...Array.from({ length: 5000 }, (_, index) => `## Heading ${index} ${'x'.repeat(80)}`)
  ].join('\n');
  await writeFile(path.join(root, relative), large);
  git(root, ['add', relative]); git(root, ['commit', '-m', 'Add large report']);
  const bytes = Buffer.from(large);
  const historical = await registerReference(root, {
    repository: { id: 'fixture', origin: null },
    subject: { kind: 'story', id: 'REF-1', branch: 'REF-1', subjectRevision: 2 },
    artifact: { phaseId: 'verification', generation: 2, outputId: 'large', path: relative, mediaType: 'text/markdown' },
    revision: { commitSha: git(root, ['rev-parse', 'HEAD']), sha256: digest(bytes), bytes: bytes.length }, visibility: 'model'
  });
  const result = await resolveReference(root, historical.handle, { maxBytes: 12_000, totalEnvelopeBytes: 16_384 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16_384);
  assert.equal(result.preview.summary.headings.length <= 64, true);
  assert.ok(result.preview.summary.omittedHeadings > 0);
});

test('binary renderer returns metadata and never base64', () => {
  const result = renderReferencePreview(Buffer.from([0, 1, 2, 3]), 'image/png');
  assert.equal(result.renderer.id, 'binary-metadata');
  assert.match(result.preview.text, /Binary content is not embedded/);
  assert.doesNotMatch(result.preview.text, /base64/i);
});

test('model-visible Markdown references exclude kernel metadata and recursive approved inputs', () => {
  const rendered = renderReferencePreview(Buffer.from([
    '<!-- singularity-flow:metadata', '{"generatedBy":"local-user"}', '-->',
    '# Requirements', '',
    '<!-- singularity-flow:inputs:start -->', 'Earlier phase replay.', '<!-- singularity-flow:inputs:end -->',
    '', 'Producer-authored requirement.'
  ].join('\n')), 'text/markdown');
  const projected = authoredReferencePreview({ mediaType: 'text/markdown', ...rendered });
  assert.match(projected.preview.text, /Producer-authored requirement/);
  assert.doesNotMatch(projected.preview.text, /local-user|Earlier phase replay|singularity-flow:inputs/);
  assert.ok(projected.preview.bytes < rendered.preview.bytes);
  assert.ok(projected.managedBytesExcluded > 0);
});

test('harness reports exact engine evidence and honest unavailable host coverage', async () => {
  const { root } = await repository();
  const started = beginHarnessInvocation({
    subject: { kind: 'story', id: 'REF-1' },
    skill: 'sflow-show',
    contractClass: 'echo',
    command: ['singularity-flow', 'show', 'sfref:v1:story:REF-1:abc123']
  });
  await completeHarnessInvocation(root, started, {
    exitCode: 0,
    output: { rawBytes: 1200, previewBytes: 300 }
  });
  const report = await harnessReport(root);
  assert.equal(report.invocations, 1);
  assert.equal(report.events[0].schemaVersion, currentSchemaVersion('harness-event'));
  assert.deepEqual(report.output, { rawBytes: 1200, previewBytes: 300, savedBytes: 900 });
  assert.equal(report.hostObservations.status, 'unavailable');
  assert.equal(report.hostObservations.coverage, 0);
  assert.match(report.hostObservations.reason, /no exact model\/tool-loop observation/);
});

test('persisted harness events are a registered immutable schema family', () => {
  const family = familyForStoredPath('$git/harness-events/5119eca9-f2d7-4d72-846b-16f3f93e7279.json');
  assert.equal(family.id, 'harness-event');
  assert.equal(family.immutable, true);
});

test('harness invocation attributes a CLI command to its registered driving skill', () => {
  const started = beginHarnessInvocation({
    command: ['singularity-flow', 'prepare', 'implementation']
  });
  assert.equal(started.skill, 'sflow-phase');
});
