import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
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
import {
  createInitiative, loadInitiative, prepareInitiativePhase, saveInitiative
} from '../src/initiative-state.mjs';
import { run, snapshot } from '../src/util.mjs';

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
  gate = await evaluateInitiativePhase(root, phaseApproval.portfolio, phaseApproval.initiative, 'define');
  assert.equal(gate.ready, true);
  assert.match(gate.passes.join('\n'), /phase bundle approval: define@/);

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

test('an approved phase without an approval for its exact bundle fails governance', async () => {
  const root = await repository();
  await publishDefine(root);
  await approveInitiative(root, {
    initiativeId: 'INIT-EVIDENCE',
    phaseId: 'define',
    subject: 'business-case',
    persona: 'product-owner'
  });
  const loaded = await loadInitiative(root, 'INIT-EVIDENCE');
  loaded.initiative.phases.define.status = 'approved';
  loaded.initiative.phases.define.approvedAt = new Date().toISOString();
  loaded.initiative.phases.plan.status = 'in_progress';
  loaded.initiative.currentPhase = 'plan';
  await saveInitiative(root, loaded.portfolio, loaded.initiative);

  const gate = await evaluateInitiativePhase(root, loaded.portfolio, loaded.initiative, 'define');
  assert.equal(gate.ready, false);
  assert.match(gate.errors.join('\n'), /phase define has 0\/1 approvals for exact bundle/);
});

test('phase approval blocks when an initiative-lite child has not reached its required milestone', async () => {
  const root = await repository();
  const loaded = await loadInitiative(root, 'INIT-EVIDENCE');
  loaded.initiative.phases.define.status = 'approved';
  loaded.initiative.phases.plan.status = 'approved';
  loaded.initiative.phases.build.status = 'in_progress';
  loaded.initiative.currentPhase = 'build';
  for (const output of Object.values(loaded.initiative.phases.plan.outputs)) {
    const absolute = path.join(root, 'singularity/initiatives/INIT-EVIDENCE', output.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `# ${output.label}\n`);
    const current = await snapshot(absolute);
    Object.assign(output, { status: 'approved', generation: 1, sha256: current.sha256, bytes: current.size });
  }
  loaded.initiative.childStories = {
    'API-1': {
      id: 'API-1',
      repository: 'api',
      blocking: true,
      status: 'in_progress',
      currentPhase: 'implementation',
      stale: false,
      milestones: { verification: false, conformance: false }
    }
  };
  await saveInitiative(root, loaded.portfolio, loaded.initiative);
  await prepareInitiativePhase(root, 'INIT-EVIDENCE', 'build');
  await publishInitiativePhase(root, 'INIT-EVIDENCE', 'build');
  for (const checkId of ['blocking-stories-complete', 'tests-passing']) {
    await registerInitiativeEvidence(root, {
      initiativeId: 'INIT-EVIDENCE',
      phaseId: 'build',
      checkId,
      assurance: 'machine-verified',
      source: { observedState: 'passed' }
    });
  }

  await assert.rejects(() => approveInitiative(root, {
    initiativeId: 'INIT-EVIDENCE',
    phaseId: 'build',
    subject: 'phase'
  }), /build has 1 blocking stories below verification/);
});

test('phase bundles pin required milestones without churning on later child progress', async () => {
  const root = await repository();
  const loaded = await loadInitiative(root, 'INIT-EVIDENCE');
  loaded.initiative.childStories = {
    'API-1': {
      id: 'API-1',
      repository: 'api',
      blocking: true,
      status: 'in_progress',
      currentPhase: 'verification',
      observedCommit: 'a'.repeat(40),
      stale: false,
      milestones: { verification: true, conformance: false }
    }
  };
  const original = await initiativeBundle(root, loaded.portfolio, loaded.initiative, 'build');
  loaded.initiative.childStories['API-1'].status = 'complete';
  loaded.initiative.childStories['API-1'].currentPhase = null;
  loaded.initiative.childStories['API-1'].observedCommit = 'b'.repeat(40);
  loaded.initiative.childStories['API-1'].milestones.conformance = true;
  const advanced = await initiativeBundle(root, loaded.portfolio, loaded.initiative, 'build');
  assert.equal(advanced.sha256, original.sha256);

  loaded.initiative.childStories['API-1'].milestones.verification = false;
  const regressed = await initiativeBundle(root, loaded.portfolio, loaded.initiative, 'build');
  assert.notEqual(regressed.sha256, original.sha256);
});

test('presence-only evidence is refused for a human-approved Must check', async () => {
  // It used to be accepted and then ignored: stored, listed as active, and unable to satisfy the
  // check it was filed against, with nothing saying why. The protection is the same, moved to the
  // moment of the mistake and given a sentence that names the tiers that would work.
  const root = await repository();
  await publishInitiativePhase(root, 'INIT-EVIDENCE', 'define');
  await writeFile(path.join(root, 'evidence.md'), '# Exists\n');
  await assert.rejects(() => registerInitiativeEvidence(root, {
    initiativeId: 'INIT-EVIDENCE',
    phaseId: 'define',
    checkId: 'business-case-approved',
    assurance: 'presence-only',
    source: { path: 'evidence.md' }
  }), /cannot be satisfied by presence-only evidence.*accepts: .*human-approved/s);

  // And the check is still missing, because nothing was written.
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

test('initiative evidence rejects a repository path that is a symbolic link', async () => {
  const root = await repository();
  const outside = path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-evidence-outside-')), 'evidence.md');
  await writeFile(outside, '# Outside evidence\n');
  const linked = path.join(root, 'linked-evidence.md');
  await symlink(outside, linked);
  await assert.rejects(() => registerInitiativeEvidence(root, {
    initiativeId: 'INIT-EVIDENCE',
    phaseId: 'define',
    checkId: 'business-case-approved',
    assurance: 'human-approved',
    source: { path: 'linked-evidence.md' }
  }), /evidence source cannot be a symbolic link/i);
});

test('publication records its own machine evidence, so every surface can approve the phase', async () => {
  // The gate lives in the engine, not in a CLI wrapper. This is what was broken: the desktop calls
  // publishInitiativePhase directly, so evidence recorded only by the CLI left blocking gates
  // permanently missing and the phase impossible to approve from the app.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-publish-evidence-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Initiative\n');
  await initializeDefinition(root);

  // A profile whose single phase declares the impact gate: it exercises the same code path as
  // epic-plan without needing the whole Epic chain approved first.
  const file = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(file, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: 'Initiative Owner', email: 'owner@example.com' }];
  portfolio.initiativePhases['impact-phase'] = {
    label: 'Impact',
    worldModelViews: ['business'],
    outputs: [{ id: 'repository-map', label: 'Impact map', kind: 'yaml', path: 'repository-map.yml', template: 'initiatives/epic/repository-map.yml' }],
    checklist: [{ id: 'impact-grounded', label: 'Impact map is grounded', requirement: 'must', acceptedAssurance: ['machine-verified'], gate: 'block' }]
  };
  portfolio.initiativeProfiles['impact-only'] = {
    label: 'Impact only', description: 'Single phase for gate verification', lifecycleMode: 'planning-only', phases: ['impact-phase']
  };
  await writeFile(file, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Add impact profile'], { cwd: root });
  run('git', ['switch', '-c', 'INIT-IMPACT'], { cwd: root });

  await createInitiative(root, { id: 'INIT-IMPACT', title: 'Impact gate', profile: 'impact-only', persona: 'product-owner' });
  await prepareInitiativePhase(root, 'INIT-IMPACT', 'impact-phase', { persona: 'product-owner' });

  const published = await publishInitiativePhase(root, 'INIT-IMPACT', 'impact-phase', { persona: 'product-owner' });

  // The impact map is validated during publication; recording that result is what makes the phase
  // approvable. Validating and discarding left the gate missing however often it was published.
  assert.deepEqual(published.evidence, ['impact-grounded']);
  // Checklist status is evaluated from the evidence records, which is what the approval gate reads.
  const evaluated = await evaluateInitiativePhase(root, published.portfolio, published.initiative, 'impact-phase');
  const gate = evaluated.checklist.find((check) => check.id === 'impact-grounded');
  assert.equal(gate.status, 'satisfied', 'the impact gate must be satisfied by publication alone');
  // The returned state must reflect what was written, not the pre-evidence snapshot, or callers
  // commit a version of state.json that is missing the evidence they just recorded.
  assert.equal(published.phase.status, 'awaiting_approval');
});
