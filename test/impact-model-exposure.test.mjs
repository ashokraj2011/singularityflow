import assert from 'node:assert/strict';
import test from 'node:test';
import { storyModelExposure } from '../src/impact.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';

function workflow(authorship) {
  return { phaseOrder: ['design'], phases: { design: { id: 'design', generation: 1, usage: [], authorship: [{ ...authorship, generation: 1 }] } }, measurement: { exposures: [] } };
}

test('manual authorship exposes exact kernel non-invocation without claiming no assistance', () => {
  const record = buildGenerationAuthorship({
    options: normalizeAuthorshipOptions({ producer: 'human', channel: 'manual-in-place' }),
    actor: { name: 'Human' }, governedAgentContext: null,
    source: { kind: 'in-place', filename: 'design.md', sha256: 'a'.repeat(64), bytes: 10 }
  });
  assert.deepEqual(storyModelExposure(workflow(record))[0], {
    phaseId: 'design', level: 'unknown', assurance: 'unknown', observationStatus: 'unavailable',
    kernelModelInvoked: false, kernelModelStatus: 'exact', kernelInvocationIds: [],
    externalAiUse: 'unknown', externalAiUseStatus: 'unavailable', producer: 'human', channel: 'manual-in-place'
  });
});

test('Copilot-hosted authorship remains host evidence and never fabricates a kernel invocation', () => {
  const record = buildGenerationAuthorship({
    options: normalizeAuthorshipOptions({ producer: 'governed-agent', channel: 'copilot-host', externalAiUse: 'assisted' }),
    actor: { name: 'Contributor' }, governedAgentContext: { agentId: 'developer', host: 'vscode-copilot' },
    source: { kind: 'in-place', filename: 'design.md', sha256: 'b'.repeat(64), bytes: 10 }
  });
  const exposure = storyModelExposure(workflow(record))[0];
  assert.equal(exposure.level, 'artifact-assisted');
  assert.equal(exposure.assurance, 'attested');
  assert.equal(exposure.kernelModelInvoked, false);
  assert.equal(exposure.externalAiUse, 'assisted');
});
