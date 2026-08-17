import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERSONALIZATION_SCHEMA_VERSION,
  personalizationFromGitIdentity
} from '../src/personalization.mjs';

test('a Git display name supplies a bounded natural reply name', () => {
  assert.deepEqual(personalizationFromGitIdentity({ name: 'Ada Lovelace', email: 'ada@example.test' }), {
    schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
    source: 'git-identity',
    displayName: 'Ada Lovelace',
    replyName: 'Ada'
  });
  assert.equal(personalizationFromGitIdentity({ name: 'Lovelace, Ada' }).replyName, 'Ada');
});

test('personalization never guesses from email, placeholders, or control characters', () => {
  assert.equal(personalizationFromGitIdentity({ email: 'ada@example.test' }).replyName, null);
  assert.equal(personalizationFromGitIdentity({ name: 'github-actions[bot]' }).replyName, null);
  assert.equal(personalizationFromGitIdentity({ name: 'unknown-user' }).replyName, null);
  assert.equal(personalizationFromGitIdentity({ name: '\u202eAda\u0000 Lovelace' }).displayName, 'Ada Lovelace');
});
