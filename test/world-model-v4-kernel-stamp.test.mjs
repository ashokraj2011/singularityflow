import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMIT_PATTERN } from '../src/world-model/contracts.mjs';
import { parseWorldModelViewKernelStamp } from '../src/world-model/materialize/stamp.mjs';

const hash = (character) => `sha256:${character.repeat(64)}`;

function stamped(commit) {
  return [
    '# Registered view',
    '',
    '---',
    'generated-at: 2026-09-01T00:00:00.000Z',
    `source-commit: ${commit}`,
    `view-sha256: ${hash('a')}`,
    `prompt-sha256: ${hash('b')}`,
    'execution-unit: deterministic-renderer@1',
    'model: unavailable',
    'assurance: validated-derived-view',
    '---',
    ''
  ].join('\n');
}

test('WMB kernel stamps preserve SHA-1 and accept SHA-256 Git object identities', () => {
  for (const commit of ['c'.repeat(40), 'd'.repeat(64)]) {
    assert.equal(COMMIT_PATTERN.test(commit), true);
    const parsed = parseWorldModelViewKernelStamp(stamped(commit));
    assert.equal(parsed.sourceCommit, commit);
    assert.equal(parsed.compositionViewSha256, hash('a'));
    assert.equal(parsed.promptSha256, hash('b'));
  }
});

test('WMB kernel stamps reject ambiguous Git object lengths', () => {
  for (const length of [39, 41, 63, 65]) {
    const commit = 'e'.repeat(length);
    assert.equal(COMMIT_PATTERN.test(commit), false);
    assert.equal(parseWorldModelViewKernelStamp(stamped(commit)), null);
  }
});
