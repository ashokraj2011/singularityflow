import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';

test('human authorship records exact provenance without pretending a kernel model ran', () => {
  const options = normalizeAuthorshipOptions({ producer: 'human', channel: 'manual-in-place', externalAiUse: 'none' });
  const record = buildGenerationAuthorship({
    options,
    actor: { name: 'Manual Author', email: 'manual@example.invalid' },
    governedAgentContext: 'developer',
    source: { kind: 'in-place', filename: 'intake.md', mediaType: 'text/markdown', sha256: 'a'.repeat(64), bytes: 512 }
  });
  assert.equal(record.producer, 'human');
  assert.equal(record.channel, 'manual-in-place');
  assert.deepEqual(record.kernelModel, { invoked: false, status: 'exact', invocationIds: [] });
  assert.deepEqual(record.externalAiUse, { value: 'none', status: 'self-reported' });
});

test('authorship rejects incompatible producer/channel combinations', () => {
  assert.throws(() => normalizeAuthorshipOptions({ producer: 'human', channel: 'kernel-model' }), /incompatible/);
  assert.throws(() => normalizeAuthorshipOptions({ producer: 'deterministic', channel: 'manual-import' }), /incompatible/);
});
