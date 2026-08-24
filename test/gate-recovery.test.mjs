import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import YAML from 'yaml';

import {
  classifyInitiativeGateFailures,
  classifyStoryGateFailures,
  recoveryActionsForFindings
} from '../src/gate-recovery.mjs';

function story(phaseOrder, { complete = false } = {}) {
  const phases = Object.fromEntries(phaseOrder.map((id, index) => [id, {
    id,
    status: complete ? 'approved' : index ? 'not_started' : 'in_progress',
    generation: index + 1,
    approvalPolicy: {
      rejectTo: phaseOrder,
      changeRequests: { reopenCompleted: true }
    }
  }]));
  return {
    workItem: { id: 'REC-1' },
    phaseOrder,
    phases,
    currentPhase: complete ? null : phaseOrder[0],
    status: complete ? 'complete' : 'in_progress'
  };
}

test('every packaged Story workflow phase has deterministic unchanged-state gate recovery ownership', async () => {
  const definition = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  for (const [profile, entry] of Object.entries(definition.workTypes)) {
    const workflow = story(entry.phases);
    for (const phaseId of entry.phases) {
      const [finding] = classifyStoryGateFailures(workflow, [`terminal: phase ${phaseId} is not approved`]);
      assert.equal(finding.phase, phaseId, `${profile}/${phaseId} lost recovery ownership`);
      assert.equal(finding.stableState, 'unchanged');
      assert.equal(finding.recovery.ownerPhase, phaseId);
      assert.match(finding.recovery.command, /singularity-flow next REC-1/);
    }
  }
});

test('a completed Story maps terminal gate defects to governed reopen or configuration authority', () => {
  const workflow = story(['intake', 'implementation', 'verification', 'conformance'], { complete: true });
  const findings = classifyStoryGateFailures(workflow, [
    'AC coverage: AC-001 has no module test-source binding',
    'conformance report is stale: source/test tree changed after comparison',
    'protected process path changed on work branch: singularity/workflow.yml (destination)'
  ]);
  assert.deepEqual(findings.map((entry) => entry.code), [
    'gate.acceptance-criteria.unbound',
    'gate.conformance.stale',
    'gate.protected-path.changed'
  ]);
  assert.equal(findings[0].recovery.ownerPhase, 'implementation');
  assert.match(findings[0].recovery.command, /reopen REC-1 --to implementation/);
  assert.equal(findings[1].recovery.ownerPhase, 'conformance');
  assert.match(findings[1].recovery.command, /reopen REC-1 --to conformance/);
  assert.equal(findings[2].recovery.mode, 'manual');
  assert.equal(findings[2].path, 'singularity/workflow.yml');
  assert.ok(findings.every((entry) => entry.stableState === 'unchanged'));

  const actions = recoveryActionsForFindings(findings);
  assert.equal(actions.length, 3);
  assert.ok(actions.every((entry) => entry.stableState === 'unchanged'));
});

test('every packaged Initiative phase has an explicit recovery owner without model routing', async () => {
  const portfolio = YAML.parse(await readFile(new URL('../templates/portfolio.yml', import.meta.url), 'utf8'));
  for (const [profile, entry] of Object.entries(portfolio.initiativeProfiles)) {
    const initiative = {
      initiative: { id: 'INIT-1' },
      phaseOrder: entry.phases,
      phases: Object.fromEntries(entry.phases.map((id) => [id, { id, status: 'in_progress', generation: 1 }])),
      currentPhase: entry.phases[0],
      status: 'in_progress'
    };
    for (const phaseId of entry.phases) {
      const [finding] = classifyInitiativeGateFailures(initiative, [`terminal: phase ${phaseId} is in_progress`]);
      assert.equal(finding.phase, phaseId, `${profile}/${phaseId} lost recovery ownership`);
      assert.equal(finding.stableState, 'unchanged');
      assert.match(finding.recovery.command, /singularity-flow initiative next INIT-1/);
    }
  }
});

test('a completed Initiative gate stays stable when no governed reopen route exists', () => {
  const initiative = {
    initiative: { id: 'INIT-DONE' },
    phaseOrder: ['initiative-intake', 'initiative-close'],
    phases: {
      'initiative-intake': { id: 'initiative-intake', status: 'approved', generation: 1 },
      'initiative-close': { id: 'initiative-close', status: 'approved', generation: 1 }
    },
    currentPhase: null,
    status: 'complete'
  };
  const [finding] = classifyInitiativeGateFailures(
    initiative,
    ['terminal: phase initiative-close is not complete']
  );
  assert.equal(finding.stableState, 'unchanged');
  assert.equal(finding.recovery.mode, 'manual');
  assert.equal(finding.recovery.requiresReopen, true);
  assert.equal(finding.recovery.command, null);
  assert.match(finding.recovery.detail, /explicit human authority/);
});

test('gate recovery classifier stays deterministic and model/AST independent', async () => {
  const source = await readFile(new URL('../src/gate-recovery.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"].*(?:model|ast)/i);
  assert.doesNotMatch(source, /from ['"].*(?:runner|provider|completion)/i);
});
