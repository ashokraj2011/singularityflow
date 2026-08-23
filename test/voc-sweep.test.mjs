import assert from 'node:assert/strict';
import test from 'node:test';

import { lintRepositoryVocabularies, vocabularyProducerLint } from '../scripts/vocabulary-lint.mjs';

test('every current first-party lifecycle producer uses an owned symbolic member', async () => {
  assert.deepEqual(await lintRepositoryVocabularies(), []);
});

test('the producer lint catches a planted generation-started emitter at its exact boundary', () => {
  const findings = vocabularyProducerLint(new Map([['src/planted.mjs', `
    commitAndPublish(root, config, workflow,
      { type: 'generation-started', phaseId: 'implementation', generation: 2 },
      'bad producer');
  `]]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'VOCABULARY_MEMBER_UNKNOWN');
  assert.equal(findings[0].member, 'generation-started');
  assert.equal(findings[0].boundary, 'commitAndPublish');
  assert.equal(findings[0].line, 3);
});

test('the producer lint requires symbols but ignores strings outside producer boundaries', () => {
  const findings = vocabularyProducerLint(new Map([['src/planted.mjs', `
    const fixture = { type: 'artifact-generated' };
    const message = 'generation-started is not a lifecycle event';
    lifecycleEvent({ type: 'artifact-generated', subject });
  `]]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, 'VOCABULARY_PRODUCER_LITERAL');
  assert.equal(findings[0].member, 'artifact-generated');
});

