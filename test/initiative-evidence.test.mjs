import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import {
  approveInitiative,
  durationMilliseconds,
  evaluateInitiativePhase,
  initiativeBundle,
  publishInitiativePhase,
  readInitiativeRecords,
  registerInitiativeEvidence
} from '../src/initiative-evidence.mjs';
import { createInitiative, loadInitiative, prepareInitiativePhase } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

async function repository({ freshness = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-initiative-evidence-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Initiative\n');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(file, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: 'Initiative Owner', email: 'owner@example.com' }];
  if (freshness) portfolio.initiativePhases.define.checklist[0].freshness = { validFor: freshness, revalidateAt: ['define'] };
  await writeFile(file, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize portfolio'], { cwd: root });
  run('git', ['switch', '-c', 'INIT-EVIDENCE'], { cwd: root });
  await createInitiative(root, { id: 'INIT-EVIDENCE', title: 'Evidence initiative', profile: 'initiative-lite', persona: 'product-owner' });
  await prepareInitiativePhase(root, 'INIT-EVIDENCE', 'define', { persona: 'product-owner' });
  return root;
}

async function publishDefine(root) {
  await publishInitiativePhase(root, 'INIT-EVIDENCE', 'define', { persona: 'product-owner' });
  const evidenceFile = path.join(root, 'evidence.md');
  await writeFile(evidenceFile, '# Approved evidence\n');
  await registerInitiativeEvidence(root, {
    initiativeId: 'INIT-EVIDENCE',
    phaseId: 'define',
    checkId: 'business-case-approved',
    assurance: 'human-approved',
    source: { path: 'evidence.md' },
    persona: 'product-owner'
  });
  await registerInitiativeEvidence(root, {
    initiativeId: 'INIT-EVIDENCE',
    phaseId: 'define',
    checkId: 'scope-agreed',
    assurance: 'human-approved',
    source: { path: 'evidence.md' },
    persona: 'product-owner'
  });
}

test('initiative evidence is content-addressed and exact bundle approvals advance the phase', async () => {
  const root = await repository();
  await publishDefine(root);
  let loaded = await loadInitiative(root, 'INIT-EVIDENCE');
  let gate = await evaluateInitiativePhase(root, loaded.portfolio, loaded.initiative, 'define');
  assert.equal(gate.ready, false);
  assert.match(gate.errors.join('\n'), /business-case has 0\/1 approvals/);

  const outputApproval = await approveInitiative(root, {
    initiativeId: 'INIT-EVIDENCE',
    phaseId: 'define',
    subject: 'business-case',
    persona: 'product-owner'
  });
  assert.equal(outputApproval.reached, true);
  assert.equal(outputApproval.selfApproval, true);

  loaded = await loadInitiative(root, 'INIT-EVIDENCE');
  gate = await evaluateInitiativePhase(root, loaded.portfolio, loaded.initiative, 'define');
  assert.equal(gate.ready, true);
  const phaseApproval = await approveInitiative(root, {
    initiativeId: 'INIT-EVIDENCE',
    phaseId: 'define',
    subject: 'phase',
    persona: 'product-owner'
  });
  assert.equal(phaseApproval.selfApproval, true);
  assert.equal(phaseApproval.next, 'plan');
  assert.equal(phaseApproval.initiative.phases.define.status, 'approved');
  assert.equal(phaseApproval.initiative.phases.plan.status, 'in_progress');

  const evidence = await readInitiativeRecords(root, loaded.portfolio, 'INIT-EVIDENCE', 'evidence');
  const approvals = await readInitiativeRecords(root, loaded.portfolio, 'INIT-EVIDENCE', 'approvals');
  assert.equal(evidence.length, 2);
  assert.equal(approvals.length, 2);
  assert.ok(evidence.every((entry) => path.basename(entry.path) === `${entry.sha256}.json`));
  assert.ok(approvals.every((entry) => entry.record.identityAssurance === 'configured-local'));

  await prepareInitiativePhase(root, 'INIT-EVIDENCE', 'plan');
  const approvedInput = phaseApproval.initiative.phases.define.outputs['scope-and-outcomes'];
  await writeFile(path.join(root, 'singularity/initiatives/INIT-EVIDENCE', approvedInput.path), '# Tampered after approval\n');
  await assert.rejects(
    () => publishInitiativePhase(root, 'INIT-EVIDENCE', 'plan'),
    /input 'define\/scope-and-outcomes'.*changed after approval/
  );
});

test('presence-only evidence does not satisfy a human-approved Must check', async () => {
  const root = await repository();
  await publishInitiativePhase(root, 'INIT-EVIDENCE', 'define');
  await writeFile(path.join(root, 'evidence.md'), '# Exists\n');
  await registerInitiativeEvidence(root, {
    initiativeId: 'INIT-EVIDENCE',
    phaseId: 'define',
    checkId: 'business-case-approved',
    assurance: 'presence-only',
    source: { path: 'evidence.md' }
  });
  const { portfolio, initiative } = await loadInitiative(root, 'INIT-EVIDENCE');
  const gate = await evaluateInitiativePhase(root, portfolio, initiative, 'define');
  assert.match(gate.errors.join('\n'), /business-case-approved is missing/);
});

test('freshness and source hashes make evidence stale without mutating status', async () => {
  const root = await repository({ freshness: '1m' });
  await publishDefine(root);
  const loaded = await loadInitiative(root, 'INIT-EVIDENCE');
  const future = new Date(Date.now() + durationMilliseconds('2m'));
  const bundle = await initiativeBundle(root, loaded.portfolio, loaded.initiative, 'define', { now: future });
  assert.equal(bundle.checklist.find((check) => check.id === 'business-case-approved').status, 'stale');

  const evidence = await readInitiativeRecords(root, loaded.portfolio, 'INIT-EVIDENCE', 'evidence');
  const registered = evidence.find((entry) => entry.record.check === 'scope-agreed');
  await writeFile(path.join(root, registered.record.source.path), '# Changed after registration\n');
  const tampered = await initiativeBundle(root, loaded.portfolio, loaded.initiative, 'define');
  assert.equal(tampered.checklist.find((check) => check.id === 'scope-agreed').status, 'stale');
});

test('unauthorized local Git email cannot create human-approved evidence or approval', async () => {
  const root = await repository();
  await publishInitiativePhase(root, 'INIT-EVIDENCE', 'define');
  await writeFile(path.join(root, 'evidence.md'), '# Evidence\n');
  run('git', ['config', 'user.email', 'outsider@example.com'], { cwd: root });
  await assert.rejects(() => registerInitiativeEvidence(root, {
    initiativeId: 'INIT-EVIDENCE',
    phaseId: 'define',
    checkId: 'business-case-approved',
    assurance: 'human-approved',
    source: { path: 'evidence.md' }
  }), /not authorized/);
  await assert.rejects(() => approveInitiative(root, {
    initiativeId: 'INIT-EVIDENCE',
    phaseId: 'define',
    subject: 'business-case'
  }), /not authorized/);
});
