import assert from 'node:assert/strict';
import test from 'node:test';

import { lifecycleEvent, LIFECYCLE_EVENT, LIFECYCLE_EVENT_TYPES, LIFECYCLE_EVENT_VOCABULARY } from '../src/lifecycle-event.mjs';
import { defineVocabulary } from '../src/vocabularies/definition.mjs';

function entry(value, overrides = {}) {
  return {
    value,
    class: 'core-observational',
    since: 1,
    status: 'active',
    writeAllowed: true,
    unknownRead: 'preserve-opaque',
    description: `${value} description`,
    ...overrides
  };
}

test('the lifecycle vocabulary owns immutable symbols, descriptors, and a stable manifest', () => {
  assert.equal(LIFECYCLE_EVENT.ARTIFACT_GENERATED, 'artifact-generated');
  assert.equal(LIFECYCLE_EVENT.DESIGN_SOURCE_PROMOTED, 'design-source-promoted');
  assert.equal(LIFECYCLE_EVENT.REWORK_ROLLED_FORWARD, 'rework-rolled-forward');
  assert.equal(LIFECYCLE_EVENT_TYPES.includes('generation-started'), false);
  assert.equal(LIFECYCLE_EVENT_VOCABULARY.descriptors['artifact-generated'].class, 'core-governing');
  assert.match(LIFECYCLE_EVENT_VOCABULARY.manifest.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(LIFECYCLE_EVENT), true);
  assert.equal(Object.isFrozen(LIFECYCLE_EVENT_VOCABULARY.descriptors['artifact-generated']), true);
  assert.throws(() => { LIFECYCLE_EVENT.ARTIFACT_GENERATED = 'other'; }, TypeError);
});

test('a vocabulary rejects duplicate ownership and invalid deprecated members', () => {
  assert.throws(() => defineVocabulary({
    id: 'duplicate-test', version: 1, defaultClass: 'core-observational',
    entries: { FIRST: entry('same'), SECOND: entry('same') }
  }), /duplicate value/);
  assert.throws(() => defineVocabulary({
    id: 'deprecated-test', version: 1, defaultClass: 'core-observational',
    entries: { OLD: entry('old', { status: 'deprecated', writeAllowed: false }) }
  }), /deprecatedSince/);
});

test('an unknown lifecycle writer is refused with operation scope and preserved-work evidence', () => {
  assert.throws(
    () => lifecycleEvent({
      type: 'generation-started',
      subject: { kind: 'story', id: 'VOC-1' },
      phaseId: 'implementation',
      generation: 2
    }),
    (error) => error.code === 'VOCABULARY_MEMBER_UNKNOWN'
      && error.details.scope.repositoryWide === false
      && error.details.authority.recorded === false
      && error.details.workPreserved.generationIntent === true
      && error.details.allowedOperations.includes('phase.begin')
  );
});
