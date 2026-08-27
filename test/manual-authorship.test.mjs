import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGenerationAuthorship, normalizeAuthorshipOptions, phasePublicationCommand
} from '../src/manual-authorship.mjs';

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

test('publication guidance derives producer and channel from the phase contract', () => {
  assert.equal(phasePublicationCommand({
    id: 'implementation', generationPolicy: { defaultProducer: 'governed-agent' }
  }), 'singularity-flow phase publish implementation --authored governed-agent --channel copilot-host');
  assert.equal(phasePublicationCommand({
    id: 'convergence', generationPolicy: { defaultProducer: 'deterministic' }
  }), 'singularity-flow phase publish convergence --authored deterministic --channel kernel-generator');
});
