import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import {
  completeEpicDelivery, epicDeliveryReadiness
} from '../src/epic-completion.mjs';
import {
  createInitiative, initiativeDir, saveInitiative
} from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

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
    persona: 'product-owner'
  });
  return { root, ...created };
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
    submissions: [{
      packetSha256: 'c'.repeat(64),
      submittedAt: '2026-07-24T09:00:00.000Z'
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

  const completed = await completeEpicDelivery(root, 'APP-100', {
    confirmation: 'APP-100',
    actor: { name: 'Product Owner', email: 'owner@example.com' }
  });
  assert.equal(completed.initiative.delivery.status, 'complete');
  assert.match(completed.record.sha256, /^[a-f0-9]{64}$/);
  const report = await readFile(path.join(
    initiativeDir(root, portfolio, 'APP-100'),
    'artifacts/delivery/spec-to-code-completion.md'
  ), 'utf8');
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
