import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { phaseFindingPolicy } from '../src/phase-finding-policy.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';
import { deriveMutationContract, mutationPathDecision } from '../src/phase-mutation-contract.mjs';
import { testExecutionHandoff } from '../src/test-execution-handoff.mjs';

/**
 * Findings a code step's own author fixes must reach that author with a route that fixes them.
 * A functional test stopped at a code step whose three blockers (an Agent brief inside a template
 * comment, two missing planned screenshots and a "missing" test runner) all came back as
 * escalations to the workflow maintainer.
 */
const ITEM = 'singularity/work-items/HEX-1';
const SCREEN = `${ITEM}/evidence/hex-positive-255.png`;
function codeStory({ intent = 'open' } = {}) {
  const phase = { id: 'implementation', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact',
    generationPolicy: { task: 'code', requirement: 'required' }, requiredArtifact: { kind: 'implementation-summary' },
    generationIntent: { status: intent, generation: 1 } };
  return { workItem: { id: 'HEX-1' }, status: 'in_progress', currentPhase: 'implementation',
    phaseOrder: ['implementation'], phases: { implementation: phase }, resolution: { workItemRoot: 'singularity/work-items' } };
}
const finding = (code, category, sourceCode, extra = {}) => ({ code, category, details: { sourceCode }, ...extra });

test('brief, delivery and planned-evidence findings belong to the step author; convergence projections do not', () => {
  for (const entry of [
    finding('projection.agent-brief.agent-brief-summary-required', 'projection', 'AGENT_BRIEF_SUMMARY_REQUIRED'),
    finding('code.delivery.incomplete', 'code-delivery', 'CODE_DELIVERY_EVIDENCE_REQUIRED'),
    finding('code.delivery.retained-evidence-missing', 'retained-evidence', 'CODE_DELIVERY_RETAINED_EVIDENCE_MISSING', { path: SCREEN })
  ]) assert.equal(phaseFindingPolicy(entry).repairableByProducer, true, entry.code);
  assert.equal(phaseFindingPolicy(finding('convergence.projection-stale', 'projection', null)).repairableByProducer, false);
});

test('each author finding routes to a command that fixes it, with a route every surface can render', () => {
  const workflow = codeStory(); const phase = workflow.phases.implementation;
  const first = (entry) => phaseResolutionChoices(workflow, phase, entry).choices[0];
  const prepublish = 'singularity-flow phase prepublish implementation --for-agent --json';
  for (const [entry, kind, skill, command] of [
    [finding('code.delivery.retained-evidence-missing', 'retained-evidence', 'CODE_DELIVERY_RETAINED_EVIDENCE_MISSING', { path: SCREEN }),
      'capture-retained-evidence', '/sf-code', prepublish],
    [finding('code.delivery.incomplete', 'code-delivery', 'CODE_DELIVERY_EVIDENCE_REQUIRED'), 'author-correction', '/sf-code', prepublish],
    [finding('projection.agent-brief.agent-brief-summary-required', 'projection', 'AGENT_BRIEF_SUMMARY_REQUIRED'),
      'author-correction', '/sf-code', prepublish],
    [finding('code.delivery.incomplete', 'code-delivery', 'CODE_DELIVERY_TEST_COMMAND_REQUIRED'),
      'runner-setup', '/sf-test-setup', 'singularity-flow capability test-setup --json']
  ]) {
    const route = first(entry);
    assert.deepEqual([route.kind, route.copilotCommand, route.command], [kind, skill, command], entry.details.sourceCode);
    assert.doesNotMatch(route.command, /doctor/u);
  }
  assert.match(first(finding('code.delivery.retained-evidence-missing', 'retained-evidence',
    'CODE_DELIVERY_RETAINED_EVIDENCE_MISSING', { path: SCREEN })).detail, /hex-positive-255\.png.*port you confirmed free.*never fabricate/su);
  assert.match(first(finding('projection.agent-brief.agent-brief-summary-required', 'projection',
    'AGENT_BRIEF_SUMMARY_REQUIRED')).detail, /visible text.*outside any <!-- --> template comment/u);
});

test('the author may write exactly the planned evidence files, only while its code generation is open', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-author-evidence-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ITEM, 'evidence'), { recursive: true });
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: [] } };
  const evidence = [SCREEN, `${ITEM}/evidence/../workflow.json`, 'src/escape.png', `${ITEM}/evidence/`];
  const open = deriveMutationContract({ root, definition, workflow: codeStory(), evidence });
  assert.equal(mutationPathDecision(open, SCREEN).allowed, true);
  assert.equal(mutationPathDecision(open, `${ITEM}/evidence/other.png`).allowed, false, 'only the planned file, not the directory');
  assert.equal(mutationPathDecision(open, `${ITEM}/workflow.json`).allowed, false);
  assert.deepEqual(open.allow.artifacts.filter((entry) => entry.includes('/evidence')), [SCREEN]);
  for (const contract of [
    deriveMutationContract({ root, definition, workflow: codeStory({ intent: 'consumed' }), evidence }),
    deriveMutationContract({ root, definition, workflow: codeStory(), evidence, turnMode: 'read-only-review' })
  ]) assert.equal(mutationPathDecision(contract, SCREEN).allowed, false);
});

test('a runner held back by another delivery finding is blocked, not missing, and needs no configuration', () => {
  const blocked = testExecutionHandoff({ status: 'unavailable', reason: 'CODE_DELIVERY_EVIDENCE_REQUIRED',
    blockedBy: ['CODE_DELIVERY_EVIDENCE_REQUIRED'] });
  assert.deepEqual([blocked.runnerStatus, blocked.configurationRequired], ['blocked', false]);
  assert.match(blocked.guidance, /Repair the reported code-delivery finding first.*infers the test runner/u);
  const missing = testExecutionHandoff({ status: 'unavailable', reason: 'CODE_DELIVERY_TEST_COMMAND_REQUIRED',
    blockedBy: ['CODE_DELIVERY_TEST_COMMAND_REQUIRED'] });
  assert.equal(missing.runnerStatus, 'unavailable');
});
