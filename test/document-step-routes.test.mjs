/**
 * Document steps that looped or dead-ended in the 2026-10-27 per-phase blocker audit: an escalation
 * with nothing to run, a stray file whose route was prepublish itself, a constitution citation that
 * prepublish passed and publish refused without a code, and two repair limits that disagreed.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { agentAct } from '../src/agent-output.mjs';
import { ESCALATION_THRESHOLD, findingEscalation } from '../src/finding-escalation.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';

test('an escalated repair loop tells Copilot the real instruction and a route for someone other than the author', () => {
  const escalation = findingEscalation({ count: ESCALATION_THRESHOLD, code: 'specification.quality.vague', workId: 'US-1', phaseId: 'specification' });
  const act = agentAct({ resultType: 'sflow-phase-prepublish', status: 'correction-required', findings: [{ code: 'specification.quality.vague' }],
    repairLoop: { status: 'escalate', escalation, protocol: escalation.instruction }, escalation });
  assert.equal(act.state, 'escalate');
  assert.match(act.said, /has returned 3 times after repairs; repeating the repair cannot pass/u);
  assert.ok(act.do?.shell, 'a route to run, not "hand it on" with nothing');
  assert.deepEqual(act.read, ['escalation', 'findings']);
});

test('a file outside a document step routes to recovery and its set-aside, never to prepublish again', () => {
  const workflow = { workItem: { id: 'US-1' }, resolution: {} };
  const phase = { id: 'specification', status: 'in_progress' };
  for (const code of ['PHASE_ARTIFACT_ONLY_CHANGES', 'PHASE_SOURCE_CHANGE_UNGOVERNED']) {
    const choice = phaseResolutionChoices(workflow, phase, { code, category: 'change-scope', details: { sourceCode: code, changedPaths: ['notes.txt'] } }).choices[0];
    assert.equal(choice.kind, 'worktree-review', code);
    assert.equal(choice.command, 'singularity-flow recover US-1 --phase specification --json', code);
  }
});

test('a citation the pinned constitution lacks has a code and a route at publish', () => {
  const plan = refusalRemediationPlan({ code: 'CONSTITUTION_CITATION_INVALID', message: 'not publishable',
    details: { phase: 'specification', errors: ['Phase specification cites constitution article ART-9, which the pinned constitution does not contain.'] } },
  ['phase', 'publish', 'specification']);
  assert.equal(plan.steps[0].id, 'correct-citation');
  assert.equal(plan.steps[0].command, 'singularity-flow phase prepublish specification --for-agent --json');
});

test('the repair limit the skills follow is the one the escalation enforces', async () => {
  const sources = await Promise.all(['../src/phase-draft-check.mjs', '../src/initiative-evidence.mjs']
    .map((relative) => readFile(new URL(relative, import.meta.url), 'utf8')));
  for (const source of sources) assert.match(source, new RegExp(`maximumChangedFingerprints: ${ESCALATION_THRESHOLD - 1},`, 'u'));
});
