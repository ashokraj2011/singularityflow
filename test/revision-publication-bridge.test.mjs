import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { recordSha256 } from '../src/records.mjs';
import { sgosRevisionCandidateReference } from '../src/revision/candidate-adapter.mjs';
import { computeRevisionPrecheck } from '../src/revision/precheck.mjs';
import { setAgentSession } from '../src/session.mjs';
import { commitAndPublish, createWorkflow, loadConfig } from '../src/state.mjs';
import { freezeSgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';

const hash = (value) => `sha256:${recordSha256(value)}`;
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const subject = Object.freeze({
  workId: 'REV-STORY-1', phaseId: 'intake', phaseGeneration: 1
});
const producer = Object.freeze({
  id: 'revision-test', version: '1', implementationSha256: digest('d')
});
const checks = [
  'candidateIntegrity', 'candidateFreeze', 'parentResultLineage', 'scope', 'protectedPaths',
  'forbiddenEffects', 'secretScan', 'hunkDisposition', 'criteriaBindingFreshness',
  'specificationDisposition', 'requiredStructure', 'kernelChecks',
  'proofProfileReadiness', 'pendingRecovery', 'worktreeEquality'
];

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-story-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.com');
  const appFile = path.join(root, 'app.txt');
  await writeFile(appFile, 'baseline\n');
  await initializeDefinition(root);
  git('add', '.');
  git('commit', '-m', 'repository setup');
  git('switch', '-c', 'REV-STORY-1');
  const config = await loadConfig(root);
  config.git.publish = 'off';
  const resolved = resolveWorkType(config, 'feature');
  const actor = { name: 'Revision Test', email: 'revision@example.com', login: null };
  await setAgentSession(root, config, actor, 'product-owner', 'REV-STORY-1', {
    phaseId: 'intake', source: 'test'
  });
  const workflow = await createWorkflow(root, config, {
    id: 'REV-STORY-1', title: 'REV publication boundary',
    source: {
      type: 'manual', key: 'REV-STORY-1', title: 'REV publication boundary',
      description: 'A test of exact selected-head publication.',
      acceptanceCriteria: ['The published application bytes match the selected candidate.']
    },
    baseBranch: 'main', workType: 'feature', agent: 'product-owner', resolved
  });
  await commitAndPublish(root, config, workflow, {
    type: 'binding', payload: { reason: 'initial Story baseline' }
  }, '[REV-STORY-1] baseline');
  const headCommit = git('rev-parse', 'HEAD');
  await writeFile(appFile, 'selected application bytes\n');
  const frozen = await freezeSgosCandidate(root, {
    subjectId: 'REV-STORY-1:intake',
    createdBy: { kind: 'human', id: 'revision@example.com' }
  });
  const candidateReference = await sgosRevisionCandidateReference(root, frozen.candidate.candidateId);
  const candidate = {
    candidateId: candidateReference.candidateId,
    candidateSha256: candidateReference.candidateSha256,
    candidateRefSha256: hash(candidateReference),
    candidateTree: candidateReference.repository.candidateTree
  };
  const context = {
    repositorySha256: digest('a'), headCommit,
    sourceTreeSha256: digest('b'), configSha256: digest('c'),
    workflowSha256: digest('d'), approvedIntentSha256: digest('e'),
    routeContractSha256: digest('f'), proofProfileSha256: digest('1'),
    editorDiskIndexBaselineSha256: hash(await readFile(appFile, 'utf8'))
  };
  const hunkClaimSet = {
    schemaVersion: 1, kind: 'revision-hunk-claim-set',
    subject, producer,
    parentCandidateId: 'CAN-PARENT1', resultCandidateId: candidate.candidateId,
    claims: [{ hunkId: 'HUNK-001', cause: { kind: 'criterion', id: 'REV-STORY-1:AC-001' }, status: 'claimed' }],
    unexplained: []
  };
  hunkClaimSet.claimSetSha256 = hash(hunkClaimSet);
  const precheckInput = {
    subject,
    producer,
    candidateReference,
    head: {
      ...candidate, headRevision: 1,
      headTransitionSha256: digest('2'), phaseGeneration: 1,
      workflowSha256: context.workflowSha256, configSha256: context.configSha256,
      proofProfileSha256: context.proofProfileSha256,
      editorDiskIndexBaselineSha256: context.editorDiskIndexBaselineSha256
    },
    bindings: {
      criteriaBindingSha256: digest('3'), specificationDispositionSha256: digest('4'),
      hunkClaimSetSha256: hunkClaimSet.claimSetSha256
    },
    hunkClaimSet,
    worktree: {
      savedTree: candidate.candidateTree,
      editorDiskIndexBaselineSha256: context.editorDiskIndexBaselineSha256,
      changedPaths: []
    },
    validations: Object.fromEntries(checks.map((name) => [name, {
      status: 'pass', evidenceSha256: hash(name)
    }])),
    criteria: [{
      clauseId: 'REV-STORY-1:AC-001', applicable: true, claimedChange: true,
      witnessReady: false, availability: 'available', contradicted: false,
      testBodySha256: null, environmentSha256: null, witnesses: []
    }],
    refusalSummary: { count: 0, corrected: 0, unresolved: 0 },
    proofProfile: 'standard'
  };
  const precheckReceipt = computeRevisionPrecheck(precheckInput);
  const selectedHead = {
    status: 'open', head: candidate,
    headTransitionSha256: precheckInput.head.headTransitionSha256,
    headSnapshotSha256: precheckReceipt.headSnapshotSha256,
    precheckSha256: precheckReceipt.precheckSha256,
    revision: 1, entrySha256: digest('5'), loopId: 'LOOP-REV-STORY-1', context
  };
  const loopStore = {
    scope: { workId: 'REV-STORY-1', phaseId: 'intake', phaseGeneration: 1 },
    async read() { return selectedHead; },
    async list() { return [{
      revision: selectedHead.revision, entrySha256: selectedHead.entrySha256,
      transition: { type: 'commit-interval', precheck: precheckReceipt }
    }]; }
  };
  const revisionPublication = {
    loopStore, candidateReference, precheckReceipt,
    readCurrentContext: async () => ({
      ...context, editorDiskIndexBaselineSha256: hash(await readFile(appFile, 'utf8'))
    }),
    readCurrentPrecheckInput: async () => precheckInput
  };
  return {
    root, git, config, workflow, appFile, headCommit, selectedHead,
    precheckInput, revisionPublication
  };
}

test('Story mutation refuses altered application bytes before its governed commit', async (t) => {
  const value = await fixture(t);
  await writeFile(value.appFile, 'altered after precheck\n');
  await assert.rejects(commitAndPublish(value.root, value.config, value.workflow, {
    type: 'binding', payload: { reason: 'attempt REV selected publication' }
  }, '[REV-STORY-1] selected publication', ['app.txt'], {
    revisionPublication: value.revisionPublication
  }), (error) => ['REV_PUBLICATION_CONTEXT_STALE', 'REV_PUBLICATION_CANDIDATE_MISMATCH']
    .includes(error.code));
  assert.equal(value.git('rev-parse', 'HEAD'), value.headCommit);
});

test('internal REV opt-in selects the exact staged application tree before Story commit', async (t) => {
  const value = await fixture(t);
  const published = await commitAndPublish(value.root, value.config, value.workflow, {
    type: 'binding', payload: { reason: 'accept exact REV selection' }
  }, '[REV-STORY-1] selected publication', ['app.txt'], {
    revisionPublication: value.revisionPublication
  });
  assert.notEqual(value.git('rev-parse', 'HEAD'), value.headCommit);
  assert.equal(published.revisionSelection.candidateId,
    value.revisionPublication.candidateReference.candidateId);
  assert.equal(published.revisionSelection.precheckSha256,
    value.revisionPublication.precheckReceipt.precheckSha256);
  assert.equal(published.revisionSelection.prospectiveTree,
    value.git('rev-parse', 'HEAD^{tree}'));
});

test('Story mutation refuses an advanced REV head before its governed commit', async (t) => {
  const value = await fixture(t);
  value.selectedHead.revision = 2;
  value.selectedHead.headTransitionSha256 = digest('6');
  value.selectedHead.headSnapshotSha256 = digest('7');
  value.selectedHead.precheckSha256 = null;
  value.selectedHead.entrySha256 = digest('8');
  await assert.rejects(commitAndPublish(value.root, value.config, value.workflow, {
    type: 'binding', payload: { reason: 'attempt stale REV publication' }
  }, '[REV-STORY-1] stale publication', ['app.txt'], {
    revisionPublication: value.revisionPublication
  }), { code: 'REV_PRECHECK_STALE' });
  assert.equal(value.git('rev-parse', 'HEAD'), value.headCommit);
});

test('transaction-owned Story metadata does not invalidate the pre-write REV baseline', async (t) => {
  const value = await fixture(t);
  const workflowFile = path.join(value.root,
    'singularity', 'work-items', 'REV-STORY-1', 'workflow.json');
  const workflowBefore = await readFile(workflowFile, 'utf8');
  const currentBaseline = async () => hash({
    application: await readFile(value.appFile, 'utf8'),
    workflow: await readFile(workflowFile, 'utf8')
  });
  const baseline = await currentBaseline();
  const context = {
    ...value.selectedHead.context,
    editorDiskIndexBaselineSha256: baseline
  };
  const input = structuredClone(value.precheckInput);
  input.head.editorDiskIndexBaselineSha256 = baseline;
  input.worktree.editorDiskIndexBaselineSha256 = baseline;
  const receipt = computeRevisionPrecheck(input);
  const selectedHead = {
    ...value.selectedHead, context,
    headSnapshotSha256: receipt.headSnapshotSha256,
    precheckSha256: receipt.precheckSha256
  };
  const loopStore = {
    scope: value.revisionPublication.loopStore.scope,
    async read() { return selectedHead; },
    async list() { return [{
      revision: selectedHead.revision, entrySha256: selectedHead.entrySha256,
      transition: { type: 'commit-interval', precheck: receipt }
    }]; }
  };
  const revisionPublication = {
    ...value.revisionPublication,
    loopStore, precheckReceipt: receipt,
    readCurrentContext: async () => ({
      ...context, editorDiskIndexBaselineSha256: await currentBaseline()
    }),
    readCurrentPrecheckInput: async () => input
  };
  const published = await commitAndPublish(value.root, value.config, value.workflow, {
    type: 'binding', payload: { reason: 'try full-state REV baseline' }
  }, '[REV-STORY-1] full-state baseline', ['app.txt'], {
    revisionPublication
  });
  assert.notEqual(value.git('rev-parse', 'HEAD'), value.headCommit);
  assert.notEqual(await readFile(workflowFile, 'utf8'), workflowBefore);
  assert.equal(published.revisionSelection.contextSha256, hash(context));
});

test('non-transaction REV context drift still refuses before Story ref advance', async (t) => {
  const value = await fixture(t);
  let reads = 0;
  const revisionPublication = {
    ...value.revisionPublication,
    readCurrentContext: async () => {
      reads += 1;
      return reads === 1 ? value.selectedHead.context
        : { ...value.selectedHead.context, configSha256: digest('9') };
    }
  };
  await assert.rejects(commitAndPublish(value.root, value.config, value.workflow, {
    type: 'binding', payload: { reason: 'refuse changed configuration' }
  }, '[REV-STORY-1] changed context', ['app.txt'], {
    revisionPublication
  }), { code: 'REV_PUBLICATION_CONTEXT_STALE' });
  assert.equal(value.git('rev-parse', 'HEAD'), value.headCommit);
});
