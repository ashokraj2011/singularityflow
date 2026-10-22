import assert from 'node:assert/strict';
import test from 'node:test';
import { IN_CONTEXT_TEXT, phaseEntryAgentPresentation, phaseEntryPacketCompaction } from '../src/agent-packet-presentation.mjs';
import { AUTHORING_VERIFICATION_PROTOCOL, CLI_PATH_CONTRACT } from '../src/safe-command-guidance.mjs';

const RETAINED = 'Use retainedExecutionEvidence for governed command outcomes, not earlier authored prose or IDE test discovery. Current source/test-input bindings must match before reusing results; command success alone proves neither every criterion nor visual acceptance.';
const CONSISTENCY = 'Use this read-only account for evidence provenance and outstanding decisions. A missing retained execution record does not prove tests never ran; it means that run is not established by the retained packet.';

const working = { id: 'working-tree', safe: false, mode: 'guided', command: null, expectedPaths: ['a.md', 'b.md'] };
const prepare = { id: 'prepare-artifact:planning', command: 'singularity-flow prepare planning', skill: '/sf-phase' };
const todo = (line) => ({ code: 'artifact.placeholder.unresolved', path: 'items/S-1/artifacts/planning/plan.md', line, value: 'TODO',
  bytes: 900, minimumBytes: null, fingerprint: 'sha256:abc', phase: 'planning', generation: 1, details: { bytes: 900, minimumBytes: null } });
const packet = () => ({
  ready: true, workId: 'S-1', phase: 'planning', status: 'authoring-entry',
  mutationContract: { toolProtocol: { paths: CLI_PATH_CONTRACT, localVerification: { allowed: true, guidance: AUTHORING_VERIFICATION_PROTOCOL } } },
  next: [prepare, working],
  recovery: { actions: [working, { id: 'complete-artifact:planning', detail: 'Complete the artifact.' }],
    blockers: [todo(10), todo(14), todo(20), { code: 'artifact.required.missing', path: 'x.md', line: null, details: { reason: 'absent', bytes: null }, bytes: null }] },
  retainedExecutionEvidence: { instruction: RETAINED, entries: [] },
  evidenceConsistency: { instruction: CONSISTENCY, summary: ['Read-only retained facts.'] },
  context: { text: `# Contract\n\n- Paths: ${CLI_PATH_CONTRACT}\n\n# Governed execution evidence\n\n${RETAINED}\n\n# Evidence consistency\n\n${CONSISTENCY}\n\n# Runtime CLI-issued file protocol\n\n${AUTHORING_VERIFICATION_PROTOCOL}\n` }
});

test('the phase-entry agent view says each copy once and names where the other is, changing nothing it was given', () => {
  const given = packet();
  const before = JSON.stringify(given);
  const compact = phaseEntryPacketCompaction(given);
  assert.equal(JSON.stringify(given), before, 'the caller\'s packet is never changed');
  // A recovery action identical to a next action is that action, by reference; any other stays whole.
  assert.deepEqual(compact.recovery.actions, [{ id: 'working-tree', sameAs: 'next[1]' }, given.recovery.actions[1]]);
  assert.deepEqual(compact.next, given.next);
  // Placeholders that differ only by line are one blocker with every line; details keep only what is new.
  const [grouped, missing] = compact.recovery.blockers;
  assert.deepEqual(grouped.lines, [10, 14, 20]);
  assert.equal(Object.hasOwn(grouped, 'line'), false);
  assert.equal(Object.hasOwn(grouped, 'details'), false);
  assert.deepEqual(missing, { code: 'artifact.required.missing', path: 'x.md', line: null, details: { reason: 'absent' }, bytes: null });
  // Instructions the composed prompt renders word for word point to it; facts and switches stay.
  assert.equal(compact.mutationContract.toolProtocol.paths, IN_CONTEXT_TEXT);
  assert.equal(compact.mutationContract.toolProtocol.localVerification.guidance, IN_CONTEXT_TEXT);
  assert.equal(compact.mutationContract.toolProtocol.localVerification.allowed, true);
  assert.equal(compact.retainedExecutionEvidence.instruction, IN_CONTEXT_TEXT);
  assert.equal(compact.evidenceConsistency.instruction, IN_CONTEXT_TEXT);
  assert.deepEqual(compact.evidenceConsistency.summary, given.evidenceConsistency.summary);
  assert.equal(compact.context.text, given.context.text);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(before));
});

test('without the composed prompt, or with different text, every instruction stays where it is', () => {
  const absent = { ...packet(), context: null };
  const kept = phaseEntryPacketCompaction(absent);
  assert.equal(kept.mutationContract.toolProtocol.paths, CLI_PATH_CONTRACT);
  assert.equal(kept.retainedExecutionEvidence.instruction, RETAINED);
  const reworded = packet();
  reworded.context.text = reworded.context.text.replace(RETAINED, `${RETAINED.slice(0, -1)}, and more.`);
  assert.equal(phaseEntryPacketCompaction(reworded).retainedExecutionEvidence.instruction, RETAINED,
    'only an exact copy is replaced');
  // The full presentation applies it, keeping the read order and the composed context last.
  const presented = phaseEntryAgentPresentation(packet());
  assert.deepEqual(presented.recovery.actions[0], { id: 'working-tree', sameAs: 'next[1]' });
  assert.equal(Object.keys(presented).at(-1), 'context');
  assert.ok(presented.agentGuide.readOrder.includes('recovery'));
});
