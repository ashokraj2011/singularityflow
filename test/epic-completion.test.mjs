import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import {
  assertEpicCompletionAuthorized, completeEpicDelivery, epicCompletionAuthorizationStatus,
  epicDeliveryReadiness
} from '../src/epic-completion.mjs';
import {
  createInitiative, initiativeDir, saveInitiative
} from '../src/initiative-state.mjs';
import { commitInitiativeChange, loadInitiativeAggregate } from '../src/state-stores.mjs';
import { run } from '../src/util.mjs';
import { LIFECYCLE_EVENT } from '../src/vocabularies/catalog.mjs';

async function epicFixture(id = 'APP-100') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-epic-completion-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Product Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Lead\n');
  await initializeDefinition(root);
  const portfolioPath = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: 'Product Owner', email: 'owner@example.com' }];
  }
  portfolio.repositories = {
    mobile: {
      url: 'https://git.example.com/mobile.git',
      defaultBranch: 'main',
      required: true
    }
  };
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize'], { cwd: root });
  run('git', ['switch', '-c', id], { cwd: root });
  const created = await createInitiative(root, {
    id,
    title: 'Mobile onboarding',
    profile: 'epic-planning',
    agent: 'product-owner'
  });
  return { root, ...created };
}

async function readyEpicFixture(id) {
  const fixture = await epicFixture(id);
  const { root, portfolio, initiative } = fixture;
  portfolio.git.publish = 'off';
  for (const phaseId of initiative.phaseOrder) initiative.phases[phaseId].status = 'approved';
  initiative.status = 'complete';
  initiative.currentPhase = null;
  initiative.materialization.status = 'complete';
  const workId = `${id}-STORY`;
  initiative.childStories['STORY-001'] = {
    id: 'STORY-001',
    workId,
    jiraKey: workId,
    repository: 'mobile',
    blocking: true,
    observedCommit: 'a'.repeat(40),
    status: 'complete',
    currentPhase: null,
    blocked: false,
    stale: false,
    milestones: { conformance: true },
    conformance: { status: 'approved', treeSha256: 'b'.repeat(64) },
    deliveryStatus: 'finalized_for_review',
    submissions: [{ packetSha256: 'c'.repeat(64), submittedAt: '2026-07-24T09:00:00.000Z' }],
    finalizations: [{
      packetSha256: 'e'.repeat(64),
      reviewPacketSha256: 'c'.repeat(64),
      finalizedAt: '2026-07-24T09:05:00.000Z'
    }],
    reviewEvidence: [{
      packetSha256: 'c'.repeat(64),
      evidenceSha256: 'd'.repeat(64),
      recordedAt: '2026-07-24T09:10:00.000Z',
      ready: true
    }]
  };
  await writeFile(path.join(initiativeDir(root, portfolio, id), 'breakdown.yml'), YAML.stringify({
    version: 2,
    initiativeId: id,
    epics: [{
      planId: 'EPIC-001', jiraKey: id, title: 'Ready Epic',
      stories: [{
        planId: 'STORY-001', jiraKey: workId, workId, title: 'Ready Story',
        repository: 'mobile', blocking: true, requirements: ['REQ-001'],
        acceptanceCriteria: ['AC-001'], dependsOn: []
      }]
    }]
  }));
  await saveInitiative(root, portfolio, initiative);
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', `Ready ${id}`], { cwd: root });
  return fixture;
}

test('Epic completion requires exact Story review and conformance lineage', async () => {
  const { root, portfolio, initiative } = await epicFixture();
  for (const phaseId of initiative.phaseOrder) initiative.phases[phaseId].status = 'approved';
  initiative.status = 'complete';
  initiative.currentPhase = null;
  initiative.materialization.status = 'complete';
  initiative.childStories['STORY-001'] = {
    id: 'STORY-001',
    workId: 'APP-101',
    jiraKey: 'APP-101',
    repository: 'mobile',
    blocking: true,
    observedCommit: 'a'.repeat(40),
    status: 'complete',
    currentPhase: null,
    blocked: false,
    stale: false,
    milestones: { conformance: true },
    conformance: { status: 'approved', treeSha256: 'b'.repeat(64) },
    deliveryStatus: 'finalized_for_review',
    submissions: [{
      packetSha256: 'c'.repeat(64),
      submittedAt: '2026-07-24T09:00:00.000Z'
    }],
    finalizations: [{
      packetSha256: 'e'.repeat(64),
      reviewPacketSha256: 'c'.repeat(64),
      finalizedAt: '2026-07-24T09:05:00.000Z'
    }],
    reviewEvidence: [{
      packetSha256: 'c'.repeat(64),
      evidenceSha256: 'd'.repeat(64),
      recordedAt: '2026-07-24T09:10:00.000Z',
      ready: true
    }]
  };
  await writeFile(path.join(initiativeDir(root, portfolio, 'APP-100'), 'breakdown.yml'), YAML.stringify({
    version: 2,
    initiativeId: 'APP-100',
    epics: [{
      planId: 'EPIC-001',
      jiraKey: 'APP-100',
      title: 'Mobile onboarding',
      stories: [{
        planId: 'STORY-001',
        jiraKey: 'APP-101',
        workId: 'APP-101',
        title: 'Build sign in',
        repository: 'mobile',
        blocking: true,
        requirements: ['REQ-001'],
        acceptanceCriteria: ['AC-001'],
        dependsOn: []
      }]
    }]
  }));
  await saveInitiative(root, portfolio, initiative);

  const readiness = await epicDeliveryReadiness(root, 'APP-100');
  assert.equal(readiness.ready, true);
  assert.equal(readiness.readyStories, 1);
  await assert.rejects(
    () => completeEpicDelivery(root, 'APP-100', { confirmation: 'wrong' }),
    /exact Epic confirmation/
  );

  await assert.rejects(
    () => assertEpicCompletionAuthorized(root, 'APP-100', {
      actor: { name: 'Unrelated Developer', email: 'developer@example.com' }
    }),
    (error) => {
      assert.equal(error.code, 'EPIC_COMPLETION_UNAUTHORIZED');
      assert.equal(error.details.initiativeId, 'APP-100');
      assert.equal(error.details.requiredAuthority, 'product-approvers');
      assert.match(error.message, /developer@example\.com is not authorized.*Required authority: product-approvers/);
      return true;
    }
  );
  const authorization = await epicCompletionAuthorizationStatus(root, 'APP-100', {
    actor: { name: 'Unrelated Developer', email: 'developer@example.com' }
  });
  assert.equal(authorization.ready, false);
  assert.equal(authorization.code, 'EPIC_COMPLETION_UNAUTHORIZED');
  assert.equal(authorization.requiredAuthority, 'product-approvers');
  assert.match(authorization.warning, /not cryptographic authentication/);
  await assert.rejects(
    () => completeEpicDelivery(root, 'APP-100', {
      confirmation: 'APP-100',
      actor: { name: 'Unrelated Developer', email: 'developer@example.com' }
    }),
    /not authorized to record the Product Owner completion decision/
  );
  const reportPath = path.join(
    initiativeDir(root, portfolio, 'APP-100'),
    'artifacts/delivery/spec-to-code-completion.md'
  );
  await assert.rejects(() => readFile(reportPath, 'utf8'), { code: 'ENOENT' });

  const completed = await completeEpicDelivery(root, 'APP-100', {
    confirmation: 'APP-100',
    actor: { name: 'Product Owner', email: 'owner@example.com' }
  });
  assert.equal(completed.initiative.delivery.status, 'complete');
  assert.match(completed.record.sha256, /^[a-f0-9]{64}$/);
  const report = await readFile(reportPath, 'utf8');
  assert.match(report, /APP-101/);
  assert.match(report, /matched/);
  assert.match(report, /configured-local/);
});

test('Epic completion remains blocked when conformance or exact-SHA checks are absent', async () => {
  const { root, portfolio, initiative } = await epicFixture('APP-200');
  for (const phaseId of initiative.phaseOrder) initiative.phases[phaseId].status = 'approved';
  initiative.status = 'complete';
  initiative.currentPhase = null;
  initiative.materialization.status = 'complete';
  initiative.childStories['STORY-001'] = {
    id: 'STORY-001',
    workId: 'APP-201',
    repository: 'mobile',
    blocking: true,
    observedCommit: 'a'.repeat(40),
    status: 'complete',
    blocked: false,
    stale: false,
    milestones: { conformance: false },
    submissions: []
  };
  await writeFile(path.join(initiativeDir(root, portfolio, 'APP-200'), 'breakdown.yml'), YAML.stringify({
    version: 2,
    initiativeId: 'APP-200',
    epics: [{
      planId: 'EPIC-001',
      jiraKey: 'APP-200',
      title: 'Incomplete Epic',
      stories: [{
        planId: 'STORY-001',
        workId: 'APP-201',
        title: 'Incomplete Story',
        repository: 'mobile',
        blocking: true,
        requirements: [],
        acceptanceCriteria: [],
        dependsOn: []
      }]
    }]
  }));
  await saveInitiative(root, portfolio, initiative);
  const readiness = await epicDeliveryReadiness(root, 'APP-200');
  assert.equal(readiness.ready, false);
  assert.match(readiness.blockers.join('\n'), /conformance is missing/);
  assert.match(readiness.blockers.join('\n'), /review packet/);
});

test('Epic completion fails closed when its pinned Product Owner policy has no authority', async () => {
  const { root, portfolio, initiative } = await epicFixture('APP-300');
  const planning = initiative.resolution.phases.find((phase) => phase.id === 'epic-planning');
  planning.bundleApproval = {
    ...planning.bundleApproval,
    mode: 'none',
    authorities: [],
    minimum: 0,
    chain: null
  };
  await saveInitiative(root, portfolio, initiative);

  await assert.rejects(
    () => assertEpicCompletionAuthorized(root, 'APP-300', {
      actor: { name: 'Product Owner', email: 'owner@example.com' }
    }),
    (error) => {
      assert.equal(error.code, 'EPIC_COMPLETION_AUTHORITY_MISSING');
      assert.equal(error.details.requiredAuthority, 'product-approvers');
      assert.match(error.message, /no configured Product Owner approval authority.*completion is refused/);
      return true;
    }
  );
});

test('Epic completion never treats another planning-chain authority as Product Owner authority', async () => {
  const { root, portfolio, initiative } = await epicFixture('APP-400');
  portfolio.approvalAuthorities['architecture-reviewers'] = {
    members: [{ name: 'Architecture Reviewer', email: 'architect@example.com' }]
  };
  initiative.resolution.approvalAuthorities['architecture-reviewers'] = {
    members: [{ name: 'Architecture Reviewer', email: 'architect@example.com' }]
  };
  const planning = initiative.resolution.phases.find((phase) => phase.id === 'epic-planning');
  planning.bundleApproval = {
    ...planning.bundleApproval,
    authorities: ['product-approvers', 'architecture-reviewers'],
    minimum: 2,
    chain: [
      { authority: 'product-approvers', label: 'Product Governance', minimum: 1 },
      { authority: 'architecture-reviewers', label: 'Architecture Review', minimum: 1 }
    ]
  };
  await saveInitiative(root, portfolio, initiative);

  await assert.rejects(
    () => assertEpicCompletionAuthorized(root, 'APP-400', {
      actor: { name: 'Architecture Reviewer', email: 'architect@example.com' }
    }),
    /architect@example\.com is not authorized.*Required authority: product-approvers/
  );
  const authorized = await assertEpicCompletionAuthorized(root, 'APP-400', {
    actor: { name: 'Product Owner', email: 'owner@example.com' }
  });
  assert.deepEqual(authorized.policy.authorities, ['product-approvers']);
  assert.deepEqual(authorized.planningPolicy.authorities, ['product-approvers', 'architecture-reviewers']);
});

test('Epic completion fails closed when a customized planning policy drops Product Owner authority', async () => {
  const { root, portfolio, initiative } = await epicFixture('APP-500');
  portfolio.approvalAuthorities['architecture-reviewers'] = {
    members: [{ name: 'Architecture Reviewer', email: 'architect@example.com' }]
  };
  initiative.resolution.approvalAuthorities['architecture-reviewers'] = {
    members: [{ name: 'Architecture Reviewer', email: 'architect@example.com' }]
  };
  const planning = initiative.resolution.phases.find((phase) => phase.id === 'epic-planning');
  planning.bundleApproval = {
    ...planning.bundleApproval,
    authorities: ['architecture-reviewers'],
    minimum: 1,
    chain: null
  };
  await saveInitiative(root, portfolio, initiative);

  await assert.rejects(
    () => assertEpicCompletionAuthorized(root, 'APP-500', {
      actor: { name: 'Architecture Reviewer', email: 'architect@example.com' }
    }),
    (error) => {
      assert.equal(error.code, 'EPIC_COMPLETION_AUTHORITY_INVALID');
      assert.deepEqual(error.details.configuredAuthorities, ['architecture-reviewers']);
      assert.match(error.message, /does not assign completion to 'product-approvers'; completion is refused/);
      return true;
    }
  );
});

test('Epic completion revision CAS rejects a concurrent state change before writing decision artifacts', async () => {
  const { root, portfolio } = await readyEpicFixture('APP-600');
  const stale = await loadInitiativeAggregate(root, 'APP-600', portfolio);
  const concurrent = await loadInitiativeAggregate(root, 'APP-600', portfolio);
  concurrent.initiative.history.push({
    at: '2026-07-24T10:00:00.000Z', actor: 'other@example.com', event: 'concurrent_update',
    phase: null, detail: 'Changed after completion preflight'
  });
  await saveInitiative(root, portfolio, concurrent.initiative);
  let transitionRan = false;

  await assert.rejects(
    () => commitInitiativeChange(root, stale.portfolio, stale.initiative, {
      type: LIFECYCLE_EVENT.WORK_COMPLETED,
      payload: { operation: 'epic-delivery-completion' }
    }, '[APP-600][epic:complete] governed decision', {
      beforeStateWrite: async () => {
        transitionRan = true;
        return completeEpicDelivery(root, 'APP-600', {
          confirmation: 'APP-600',
          actor: { name: 'Product Owner', email: 'owner@example.com' },
          portfolio: stale.portfolio,
          initiative: stale.initiative
        });
      }
    }),
    /changed|revision|state/i
  );
  assert.equal(transitionRan, false, 'the completion transition must not run after revision drift');
  await assert.rejects(
    () => readFile(path.join(initiativeDir(root, portfolio, 'APP-600'), 'artifacts/delivery/spec-to-code-completion.md'), 'utf8'),
    { code: 'ENOENT' }
  );
});

test('Epic completion publishes its exact decision and persisted state in one revision-bound unit', async () => {
  const { root, portfolio } = await readyEpicFixture('APP-650');
  const loaded = await loadInitiativeAggregate(root, 'APP-650', portfolio);
  let result;
  const publication = await commitInitiativeChange(root, loaded.portfolio, loaded.initiative, {
    type: LIFECYCLE_EVENT.WORK_COMPLETED,
    payload: { operation: 'epic-delivery-completion' }
  }, '[APP-650][epic:complete] governed decision', {
    beforeStateWrite: async () => {
      result = await completeEpicDelivery(root, 'APP-650', {
        confirmation: 'APP-650',
        actor: { name: 'Product Owner', email: 'owner@example.com' },
        portfolio: loaded.portfolio,
        initiative: loaded.initiative
      });
      return result;
    },
    eventFromResult: (transitionResult) => ({
      payload: { completionSha256: transitionResult.record.sha256 }
    })
  });

  assert.match(publication.sha, /^[a-f0-9]{40}$/);
  const persisted = await loadInitiativeAggregate(root, 'APP-650', portfolio);
  assert.equal(persisted.initiative.delivery.status, 'complete');
  assert.equal(persisted.initiative.delivery.completion.sha256, result.record.sha256);
  assert.match(
    await readFile(path.join(root, result.reportPath), 'utf8'),
    new RegExp(result.record.sha256)
  );
  assert.equal(run('git', ['status', '--short'], { cwd: root }).stdout.trim(), '');
});

test('Epic completion reloads its revision between synchronization and completion publications', async () => {
  const { root, portfolio } = await readyEpicFixture('APP-675');
  const synchronized = await loadInitiativeAggregate(root, 'APP-675', portfolio);
  await commitInitiativeChange(root, synchronized.portfolio, synchronized.initiative, {
    type: LIFECYCLE_EVENT.EXTERNAL_SYNCHRONIZED,
    payload: { operation: 'completion-preflight' }
  }, '[APP-675][epic:sync] completion preflight');

  // The first publication changed state.json, so reusing `synchronized.initiative` would carry its
  // pre-publication stateSha256 and be correctly rejected by the unit-of-work CAS. The CLI must
  // reload exactly as this end-to-end transition does.
  const completionState = await loadInitiativeAggregate(root, 'APP-675', portfolio);
  let transition;
  const publication = await commitInitiativeChange(
    root,
    completionState.portfolio,
    completionState.initiative,
    {
      type: LIFECYCLE_EVENT.WORK_COMPLETED,
      payload: { operation: 'epic-delivery-completion' }
    },
    '[APP-675][epic:complete] governed decision',
    {
      beforeStateWrite: async () => {
        transition = await completeEpicDelivery(root, 'APP-675', {
          confirmation: 'APP-675',
          actor: { name: 'Product Owner', email: 'owner@example.com' },
          portfolio: completionState.portfolio,
          initiative: completionState.initiative
        });
        return transition;
      },
      eventFromResult: (result) => ({
        payload: { completionSha256: result.record.sha256 }
      })
    }
  );

  assert.match(publication.sha, /^[a-f0-9]{40}$/);
  const persisted = await loadInitiativeAggregate(root, 'APP-675', portfolio);
  assert.equal(persisted.initiative.delivery.status, 'complete');
  assert.equal(persisted.initiative.delivery.completion.sha256, transition.record.sha256);
  assert.equal(run('git', ['status', '--short'], { cwd: root }).stdout.trim(), '');
});

test('Epic completion publication rollback removes decision artifacts and restores state after a late failure', async () => {
  const { root, portfolio } = await readyEpicFixture('APP-700');
  const loaded = await loadInitiativeAggregate(root, 'APP-700', portfolio);
  const initiativeRoot = initiativeDir(root, portfolio, 'APP-700');

  await assert.rejects(
    () => commitInitiativeChange(root, loaded.portfolio, loaded.initiative, {
      type: LIFECYCLE_EVENT.WORK_COMPLETED,
      payload: { operation: 'epic-delivery-completion' }
    }, '[APP-700][epic:complete] governed decision', {
      beforeStateWrite: () => completeEpicDelivery(root, 'APP-700', {
        confirmation: 'APP-700',
        actor: { name: 'Product Owner', email: 'owner@example.com' },
        portfolio: loaded.portfolio,
        initiative: loaded.initiative
      }),
      eventFromResult: () => {
        throw new Error('injected failure after completion artifacts');
      }
    }),
    /injected failure after completion artifacts/
  );

  await assert.rejects(
    () => readFile(path.join(initiativeRoot, 'artifacts/delivery/spec-to-code-completion.md'), 'utf8'),
    { code: 'ENOENT' }
  );
  const recordsPath = path.join(initiativeRoot, 'delivery/records');
  await assert.rejects(() => stat(recordsPath), { code: 'ENOENT' });
  const restored = await loadInitiativeAggregate(root, 'APP-700', portfolio);
  assert.equal(restored.initiative.delivery.status, 'tracking');
  assert.equal(run('git', ['status', '--short'], { cwd: root }).stdout.trim(), '');
});
