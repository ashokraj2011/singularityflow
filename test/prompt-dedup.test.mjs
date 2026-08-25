import test from 'node:test';
import assert from 'node:assert/strict';

import { approvedReferenceAlreadyCaptured } from '../src/worldmodel.mjs';

const path = 'singularity/work-items/WORK-1/artifacts/intake/intake.md';
const raw = `sha256:${'a'.repeat(64)}`;
const preview = `sha256:${'b'.repeat(64)}`;

function input(representation, overrides = {}) {
  return {
    status: 'captured', repositoryPath: path, sha256: raw,
    source: { path, rawSha256: raw }, representation, ...overrides
  };
}

function reference(overrides = {}) {
  return {
    path, rawSha256: raw,
    representation: { kind: 'truncated', sha256: preview, bytes: 100, complete: false, expansionHandle: 'sfref:preview' },
    ...overrides
  };
}

test('the same governed reference handle deduplicates across publication metadata changes', () => {
  const handle = 'sfref:v1:story:WORK-1:abcdefabcdef';
  assert.equal(approvedReferenceAlreadyCaptured(reference({
    handle, rawSha256: `sha256:${'d'.repeat(64)}`
  }), [input({
    kind: 'full', sha256: `sha256:${'c'.repeat(64)}`, bytes: 500,
    complete: true, expansionHandle: handle
  })]), true);
});

test('approved reference dedup requires model-visible equivalence, completeness, or visible expansion', () => {
  assert.equal(approvedReferenceAlreadyCaptured(reference(), [input({
    kind: 'truncated', sha256: preview, bytes: 100, complete: false, expansionHandle: null
  })]), true, 'the exact representation is already visible');

  assert.equal(approvedReferenceAlreadyCaptured(reference(), [input({
    kind: 'full', sha256: `sha256:${'c'.repeat(64)}`, bytes: 500, complete: true, expansionHandle: null
  })]), true, 'a complete existing representation contains the preview');

  for (const kind of ['summary', 'clauses', 'truncated', 'fallback-whole']) {
    assert.equal(approvedReferenceAlreadyCaptured(reference(), [input({
      kind, sha256: `sha256:${'c'.repeat(64)}`, bytes: 50, complete: false, expansionHandle: 'sfref:exact-source'
    })]), true, `${kind} remains safe when its exact expansion handle is model-visible`);
  }
});

test('same source never suppresses a different incomplete representation without expansion', () => {
  for (const kind of ['summary', 'clauses', 'truncated', 'fallback-whole']) {
    assert.equal(approvedReferenceAlreadyCaptured(reference(), [input({
      kind, sha256: `sha256:${'c'.repeat(64)}`, bytes: 50, complete: false, expansionHandle: null
    })]), false, `${kind} does not become complete merely because its raw source matches`);
  }
  assert.equal(approvedReferenceAlreadyCaptured(reference(), [input(null)]), false,
    'a legacy record with source identity alone proves no model-visible representation');
});

test('dedup still requires exact source identity and a captured status', () => {
  const complete = input({ kind: 'full', sha256: preview, bytes: 100, complete: true, expansionHandle: null });
  assert.equal(approvedReferenceAlreadyCaptured({ ...reference(), rawSha256: `sha256:${'d'.repeat(64)}` }, [complete]), false);
  assert.equal(approvedReferenceAlreadyCaptured({ ...reference(), path: 'another.md' }, [complete]), false);
  assert.equal(approvedReferenceAlreadyCaptured(reference(), [{ ...complete, status: 'hash_mismatch' }]), false);
});
