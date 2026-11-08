import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { initialPhaseState, initialWorkflowProgress } from '../src/kernel/lifecycle-transitions.mjs';
import { namespaceConfigurationFixture } from './helpers/namespace-configuration-fixture.mjs';
import { seededNamespaceConfiguration } from './helpers/namespace-seeded-configuration.mjs';
import { validateDefinition, resolveWorkType } from '../src/config.mjs';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('shared Story initialization preserves captured native states for every shipped workflow', async t => {
  const captured = JSON.parse(await readFile(new URL('./fixtures/engine-story-creation/native-v1.json', import.meta.url), 'utf8'));
  const f = await namespaceConfigurationFixture(t), { source } = await seededNamespaceConfiguration(f);
  const definitionSource = structuredClone(source.definition);
  validateDefinition(definitionSource);
  const expected = Object.fromEntries(Object.keys(definitionSource.workTypes).map(id =>
    [id, JSON.parse(JSON.stringify(resolveWorkType(definitionSource, id)))]));
  assert.equal(Object.keys(expected).length, captured.results.length);
  let phases = 0;
  for (const reference of captured.results) {
    const definitions = expected[reference.workTypeId].phases;
    assert.equal(sha(definitions), reference.phaseDefinitions, `${reference.workTypeId}: unchanged compiler input`);
    const progress = initialWorkflowProgress(definitions, { startedAt: captured.at,
      tokenMode: source.definition.tokens?.mode ?? 'exact-or-unavailable',
      telemetryMetadata: { schemaVersion: captured.telemetrySchemaVersion } });
    assert.equal(sha(Object.values(progress.phases)), reference.phases, `${reference.workTypeId}: original phase records`);
    assert.equal(sha(progress), reference.progress, `${reference.workTypeId}: original aggregate fields and order`);
    assert.equal(definitions.length, reference.count);
    assert.equal(progress.phases[progress.currentPhase].startedAt, captured.at);
    assert.ok(Object.values(progress.phases).every(phase => phase.generation === 0 && !phase.checks.length && !phase.approvals.length));
    phases += definitions.length;
  }
  assert.equal(phases, 85);
  const definition = expected.feature.phases[0], before = structuredClone(definition);
  const first = initialPhaseState(definition, 0, captured.at), second = initialPhaseState(definition, 0, captured.at);
  first.artifacts.push({ path: 'isolated' }); first.requiredArtifact.path = 'isolated';
  assert.deepEqual(definition, before);
  assert.notDeepEqual(first, second);
});
