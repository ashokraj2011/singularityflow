import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { CONFIGURATION_BRANCH, ensureConfigurationBranch,
  loadStoryConfigurationSnapshot, resolveNewStoryConfigurationAuthority
} from '../src/configuration-branch.mjs';
import { loadDefinition } from '../src/config.mjs';
import { inspectSkillPackageContents } from '../src/skp-package.mjs';
import { compileConfirmedSkillPhase, configurationPhaseFromCompiledSkill,
  skillCandidateCatalogSha256, skillContractSha256,
  skillPhaseCandidateSha256 } from '../src/skp-contract.mjs';
import { loadWorkflow, previewStorySkillVersionProposal,
  proposeStorySkillVersion, previewStorySkillVersionDecision,
  decideStorySkillVersion, submitPhase, validateWorkflow, workflowPath } from '../src/state.mjs';
import { run } from '../src/util.mjs';
import { verifyWorkflowSnapshot } from '../src/workflow-snapshots.mjs';
import { phaseNeedsGeneration } from '../src/sequence.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const H = (digit) => `sha256:${digit.repeat(64)}`;

function git(cwd, ...args) { return run('git', args, { cwd }).stdout.trim(); }

function flow(cwd, ...args) {
  const result = run(process.execPath, [CLI, ...args], { cwd, allowFailure: true });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function publishSkill(publisher, version, {
  independentSkill = false, approvalMinimum = 1
} = {}) {
  git(publisher, 'pull', '-q', '--ff-only', 'origin', CONFIGURATION_BRANCH);
  const skillDir = path.join(publisher, 'singularity/skills/threat-model');
  await mkdir(skillDir, { recursive: true });
  const skillText = `# Threat model ${version}\n\nProduce the accepted threat report.\n`;
  await writeFile(path.join(skillDir, 'SKILL.md'), skillText);
  const captured = inspectSkillPackageContents('threat-model',
    new Map([['SKILL.md', Buffer.from(skillText)]]));
  const packageSha256 = captured.manifest.packageSha256;
  let independentPackageSha256 = null;
  if (independentSkill) {
    const independentText = '# Independent privacy check\n\nProduce the privacy report.\n';
    const independentDir = path.join(publisher, 'singularity/skills/privacy-check');
    await mkdir(independentDir, { recursive: true });
    await writeFile(path.join(independentDir, 'SKILL.md'), independentText);
    independentPackageSha256 = inspectSkillPackageContents('privacy-check',
      new Map([['SKILL.md', Buffer.from(independentText)]]))
      .manifest.packageSha256;
  }
  const workflowPath = path.join(publisher, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  definition.version = 3;
  definition.git.publish = 'off';
  definition.approvalSecurity = { profile: 'poc', allowSelfApproval: true,
    autoEnrollNewIdentities: true };
  definition.approvalAuthorities['engineering-reviewers'].allowAnyGitIdentity = true;
  definition.workTypes['skill-only'] = { label: 'Skill only',
    phases: independentSkill ? ['threat-model', 'privacy-check'] : ['threat-model'],
    plannedClaims: { mode: 'opt-out' } };
  const authoring = {
    id: 'threat-model', kind: 'skill', label: 'Threat model',
    skill: { id: 'threat-model', packageSha256 },
    contract: {
      task: 'analyze', consumes: [],
      produces: [{ id: 'threat-report', path: 'artifacts/threat-model/threat-model.md',
        kind: 'custom:threat-model', mediaType: 'text/markdown', encoding: 'utf-8',
        minimumBytes: 80, maximumBytes: 131072, clauses: 'optional', claimRole: 'findings' }],
      checks: ['markdownlint'], writeScope: 'artifact-only',
      readScope: { inputs: false, sourcePaths: [] },
      approval: { authorities: ['engineering-reviewers'], minimum: approvalMinimum }
    }
  };
  const catalog = {
    skillPackages: {
      'threat-model': { packageSha256, eligibility: 'candidate-producer' },
      ...(independentSkill ? { 'privacy-check': {
        packageSha256: independentPackageSha256, eligibility: 'candidate-producer'
      } } : {})
    },
    phases: {},
    checks: { markdownlint: { id: 'markdownlint', argv: ['markdownlint', 'report.md'],
      modelPolicy: 'never', kind: 'lint', requirement: 'required' } },
    approvalAuthorities: { 'engineering-reviewers': definition.approvalAuthorities['engineering-reviewers'] },
    approvalSecurity: definition.approvalSecurity,
    readPaths: [], sourceScopes: {}, artifactSets: {}
  };
  const phaseOrder = definition.workTypes['skill-only'].phases;
  const catalogSha256 = skillCandidateCatalogSha256(catalog);
  const compiled = compileConfirmedSkillPhase({
    phase: authoring, catalog, phaseOrder,
    confirmation: {
      contractSha256: skillContractSha256(authoring.id, authoring.contract),
      catalogSha256, packageSha256,
      candidateSha256: skillPhaseCandidateSha256(authoring, phaseOrder, catalogSha256),
      planSha256: H('b'), draftRevision: version
    }
  });
  definition.phases['threat-model'] = configurationPhaseFromCompiledSkill(compiled);
  if (independentSkill) {
    const independentAuthoring = {
      ...structuredClone(authoring), id: 'privacy-check', label: 'Privacy check',
      skill: { id: 'privacy-check', packageSha256: independentPackageSha256 },
      contract: {
        ...structuredClone(authoring.contract),
        produces: [{ ...authoring.contract.produces[0], id: 'privacy-report',
          path: 'artifacts/privacy-check/privacy-check.md', kind: 'custom:privacy-check' }]
      }
    };
    const independentCompiled = compileConfirmedSkillPhase({
      phase: independentAuthoring, catalog, phaseOrder,
      confirmation: {
        contractSha256: skillContractSha256(independentAuthoring.id,
          independentAuthoring.contract), catalogSha256,
        packageSha256: independentPackageSha256,
        candidateSha256: skillPhaseCandidateSha256(independentAuthoring, phaseOrder,
          catalogSha256), planSha256: H('c'), draftRevision: version
      }
    });
    definition.phases['privacy-check'] = configurationPhaseFromCompiledSkill(independentCompiled);
  }
  await writeFile(workflowPath, YAML.stringify(definition));
  const agentPath = path.join(publisher, '.github/agents/developer.agent.md');
  const agent = await readFile(new URL('../templates/agents/developer.agent.md', import.meta.url),
    'utf8');
  await writeFile(agentPath, agent.replaceAll('implement,implementation',
    `implement,implementation,threat-model${independentSkill ? ',privacy-check' : ''}`));
  git(publisher, 'add', '-A');
  git(publisher, 'commit', '-qm', `approve skill version ${version}`);
  git(publisher, 'push', '-q', 'origin', CONFIGURATION_BRANCH);
  return packageSha256;
}

async function fixture(t, { independentSkill = false, approvalMinimum = 1 } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-state-amendment-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'application');
  const remote = path.join(base, 'application.git');
  const publisher = path.join(base, 'publisher');
  await mkdir(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Story Proposer');
  git(root, 'config', 'user.email', 'proposer@example.invalid');
  flow(root, 'init');
  await writeFile(path.join(root, 'README.md'), '# Application\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'application baseline');
  git(base, 'clone', '-q', '--bare', root, remote);
  git(root, 'remote', 'add', 'origin', remote);
  await ensureConfigurationBranch(remote);
  git(base, 'clone', '-q', '-b', CONFIGURATION_BRANCH, remote, publisher);
  git(publisher, 'config', 'user.name', 'Skill Publisher');
  git(publisher, 'config', 'user.email', 'publisher@example.invalid');
  const firstPackageSha256 = await publishSkill(publisher, 1, {
    independentSkill, approvalMinimum
  });
  const storyAuthority = await resolveNewStoryConfigurationAuthority(root);
  assert.ok(storyAuthority, 'start must resolve the approved configuration authority');
  flow(root, 'start', 'SKP-ADOPT-1', '--from-branch', 'main',
    '--work-type', 'skill-only', '--agent', 'developer',
    '--title', 'Review threat-model version',
    '--description', 'Adopt a reviewed newer skill package while preserving prior Story authority.');
  const config = await loadDefinition(root);
  const workflow = await loadWorkflow(root, config, 'SKP-ADOPT-1');
  const started = await verifyWorkflowSnapshot(root, config, workflow, {
    requireAccepted: true
  });
  assert.equal(started.skillPackages.find((entry) => entry.skillId === 'threat-model')
    .packageSha256, firstPackageSha256,
    'CLI Story start must pass its approved configuration snapshot into WFA capture');
  const secondPackageSha256 = await publishSkill(publisher, 2, {
    independentSkill, approvalMinimum
  });
  const approved = await loadStoryConfigurationSnapshot({
    remote, branch: CONFIGURATION_BRANCH
  });
  return { root, remote, publisher, config, workflow, approved,
    firstPackageSha256, secondPackageSha256 };
}

test('reviewed two-step skill adoption commits proposal, distinct decision, and WFA revision', async (t) => {
  const value = await fixture(t);
  const { root, config, workflow, approved } = value;
  assert.equal(workflow.workflowSnapshot.revision, 1);
  const proposal = await previewStorySkillVersionProposal(root, config, workflow, {
    skillId: 'threat-model', approvedConfigurationSnapshot: approved,
    reason: 'Use the approved revised threat-model checklist.'
  });
  assert.equal(proposal.status, 'ready');
  assert.deepEqual(proposal.affectedPhaseIds, ['threat-model']);
  await proposeStorySkillVersion(root, config, workflow, {
    skillId: 'threat-model', approvedConfigurationSnapshot: approved,
    reason: 'Use the approved revised threat-model checklist.',
    confirmPreviewDigest: proposal.planSha256
  });
  assert.equal(workflow.skillVersionAmendments[0].status, 'proposed');
  assert.equal(workflow.workflowSnapshot.revision, 1);
  git(root, 'config', 'user.name', 'Story Reviewer');
  git(root, 'config', 'user.email', 'reviewer@example.invalid');
  const decision = await previewStorySkillVersionDecision(root, config, workflow, {
    proposalId: proposal.proposalId, decision: 'approve',
    approvedConfigurationSnapshot: approved,
    reason: 'Reviewed exact package and impact.'
  });
  assert.equal(decision.willApply, true);
  const result = await decideStorySkillVersion(root, config, workflow, {
    proposalId: proposal.proposalId, decision: 'approve',
    approvedConfigurationSnapshot: approved,
    reason: 'Reviewed exact package and impact.',
    confirmPreviewDigest: decision.planSha256
  });
  assert.equal(result.applied, true);
  assert.equal(workflow.workflowSnapshot.revision, 2);
  assert.equal(workflow.schemaVersion, 10);
  assert.equal(workflow.skillVersionAmendments[0].status, 'approved');
  assert.equal(workflow.phases['threat-model'].status, 'in_progress');
  const verified = await verifyWorkflowSnapshot(root, config, workflow, {
    requireAccepted: true
  });
  assert.equal(verified.revision, 2);
  assert.equal(verified.skillPackages[0].packageSha256, value.secondPackageSha256);
  assert.equal((await validateWorkflow(root, config, workflow)).valid, true);
});

test('accepted amendment binds generation baseline despite local marker deletion or alteration', async (t) => {
  const { root, config, workflow, approved } = await fixture(t);
  // Model an existing generation at adoption: without the anchored marker this old generation
  // would pass phaseNeedsGeneration and be eligible for resubmission.
  workflow.phases['threat-model'].generation = 1;
  const selection = {
    skillId: 'threat-model', approvedConfigurationSnapshot: approved,
    reason: 'Revalidate the existing report under the approved new skill version.'
  };
  const proposal = await previewStorySkillVersionProposal(root, config, workflow, selection);
  await proposeStorySkillVersion(root, config, workflow, {
    ...selection, confirmPreviewDigest: proposal.planSha256
  });
  git(root, 'config', 'user.name', 'Story Reviewer');
  git(root, 'config', 'user.email', 'reviewer@example.invalid');
  const review = {
    proposalId: proposal.proposalId, decision: 'approve',
    approvedConfigurationSnapshot: approved, reason: 'The old generation must be regenerated.'
  };
  const decision = await previewStorySkillVersionDecision(root, config, workflow, review);
  await decideStorySkillVersion(root, config, workflow, {
    ...review, confirmPreviewDigest: decision.planSha256
  });
  assert.equal(workflow.phases['threat-model'].skillAmendmentRevalidation.generationAtAdoption, 1);
  assert.equal(phaseNeedsGeneration(workflow, workflow.phases['threat-model']), true);

  const file = workflowPath(root, config, workflow.workItem.id);
  const original = await readFile(file, 'utf8');
  for (const tamper of [
    (phase) => { delete phase.skillAmendmentRevalidation; },
    (phase) => { phase.skillAmendmentRevalidation.generationAtAdoption = 0; }
  ]) {
    const changed = JSON.parse(original);
    tamper(changed.phases['threat-model']);
    await writeFile(file, JSON.stringify(changed, null, 2));
    await assert.rejects(loadWorkflow(root, config, workflow.workItem.id), {
      code: 'SKP_AMENDMENT_REVALIDATION_INVALID'
    });
    const diagnosis = await validateWorkflow(root, config, changed);
    assert.equal(diagnosis.valid, false);
    assert.match(diagnosis.errors.join(' '), /revalidation baseline/i);
    await assert.rejects(submitPhase(root, config, changed, {
      phaseId: 'threat-model', runChecks: false, persist: false,
      actor: { name: 'Story Reviewer', email: 'reviewer@example.invalid' }
    }), { code: 'SKP_AMENDMENT_REVALIDATION_INVALID' });
  }
  await writeFile(file, original);
  const restored = await loadWorkflow(root, config, workflow.workItem.id);
  assert.equal(phaseNeedsGeneration(restored, restored.phases['threat-model']), true);
  restored.phases['threat-model'].generation = 2;
  assert.equal(phaseNeedsGeneration(restored, restored.phases['threat-model']), false,
    'a fresh published generation can satisfy the immutable adoption baseline');
  assert.equal((await validateWorkflow(root, config, restored)).valid, true);
});

test('adopting one of two pinned packages preserves the independent skill phase', async (t) => {
  const { root, config, workflow, approved, secondPackageSha256 } =
    await fixture(t, { independentSkill: true });
  const before = structuredClone(workflow.phases['privacy-check']);
  const retained = await verifyWorkflowSnapshot(root, config, workflow, {
    requireAccepted: true
  });
  const privacyPackageSha256 = retained.skillPackages.find((entry) =>
    entry.skillId === 'privacy-check').packageSha256;
  const selection = {
    skillId: 'threat-model', approvedConfigurationSnapshot: approved,
    reason: 'Adopt the revised threat model without reopening the independent check.'
  };
  const proposal = await previewStorySkillVersionProposal(root, config, workflow, selection);
  assert.deepEqual(proposal.affectedPhaseIds, ['threat-model']);
  assert.deepEqual(proposal.preservedPhaseIds, ['privacy-check']);
  await proposeStorySkillVersion(root, config, workflow, {
    ...selection, confirmPreviewDigest: proposal.planSha256
  });
  git(root, 'config', 'user.name', 'Story Reviewer');
  git(root, 'config', 'user.email', 'reviewer@example.invalid');
  const decision = await previewStorySkillVersionDecision(root, config, workflow, {
    proposalId: proposal.proposalId, decision: 'approve',
    approvedConfigurationSnapshot: approved,
    reason: 'The independent package has no affected input.'
  });
  await decideStorySkillVersion(root, config, workflow, {
    proposalId: proposal.proposalId, decision: 'approve',
    approvedConfigurationSnapshot: approved,
    reason: 'The independent package has no affected input.',
    confirmPreviewDigest: decision.planSha256
  });
  assert.deepEqual(workflow.phases['privacy-check'], before);
  const accepted = await verifyWorkflowSnapshot(root, config, workflow, {
    requireAccepted: true
  });
  assert.equal(accepted.revision, 2);
  assert.equal(accepted.skillPackages.find((entry) => entry.skillId === 'threat-model')
    .packageSha256, secondPackageSha256);
  assert.equal(accepted.skillPackages.find((entry) => entry.skillId === 'privacy-check')
    .packageSha256, privacyPackageSha256);
});

test('two distinct recorded reviewers satisfy a pinned two-person amendment threshold', async (t) => {
  const { root, config, workflow, approved } = await fixture(t, {
    approvalMinimum: 2
  });
  const priorTestIdentity = process.env.SINGULARITY_FLOW_TEST_IDENTITY;
  const priorNodeEnv = process.env.NODE_ENV;
  t.after(() => {
    if (priorTestIdentity === undefined) delete process.env.SINGULARITY_FLOW_TEST_IDENTITY;
    else process.env.SINGULARITY_FLOW_TEST_IDENTITY = priorTestIdentity;
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
  });
  process.env.NODE_ENV = 'test';
  const selection = {
    skillId: 'threat-model', approvedConfigurationSnapshot: approved,
    reason: 'Review a new version under the two-person policy.'
  };
  const proposal = await previewStorySkillVersionProposal(root, config, workflow, selection);
  await proposeStorySkillVersion(root, config, workflow, {
    ...selection, confirmPreviewDigest: proposal.planSha256
  });
  git(root, 'config', 'user.name', 'First Reviewer');
  git(root, 'config', 'user.email', 'first-reviewer@example.invalid');
  process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'First Reviewer';
  const firstOptions = {
    proposalId: proposal.proposalId, decision: 'approve',
    approvedConfigurationSnapshot: approved, reason: 'First independent approval.'
  };
  const first = await previewStorySkillVersionDecision(root, config, workflow, firstOptions);
  assert.equal(first.willApply, false);
  await decideStorySkillVersion(root, config, workflow, {
    ...firstOptions, confirmPreviewDigest: first.planSha256
  });
  assert.equal(workflow.skillVersionAmendments[0].approvals.length, 1);
  assert.equal(workflow.workflowSnapshot.revision, 1);
  git(root, 'config', 'user.name', 'Second Reviewer');
  git(root, 'config', 'user.email', 'second-reviewer@example.invalid');
  process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'Second Reviewer';
  const secondOptions = {
    proposalId: proposal.proposalId, decision: 'approve',
    approvedConfigurationSnapshot: approved, reason: 'Second independent approval.'
  };
  const second = await previewStorySkillVersionDecision(root, config, workflow, secondOptions);
  assert.equal(second.willApply, true,
    'the committed first review must count toward the second-reviewer threshold');
  const applied = await decideStorySkillVersion(root, config, workflow, {
    ...secondOptions, confirmPreviewDigest: second.planSha256
  });
  assert.equal(applied.applied, true);
  assert.equal(workflow.skillVersionAmendments[0].approvals.length, 2);
  assert.equal((await verifyWorkflowSnapshot(root, config, workflow, {
    requireAccepted: true
  })).revision, 2);
});

test('a stale proposed package can be rejected without adopting it or trapping the Story', async (t) => {
  const { root, remote, publisher, config, workflow, approved } = await fixture(t);
  const selection = {
    skillId: 'threat-model', approvedConfigurationSnapshot: approved,
    reason: 'Review version two of the skill.'
  };
  const proposal = await previewStorySkillVersionProposal(root, config, workflow, selection);
  await proposeStorySkillVersion(root, config, workflow, {
    ...selection, confirmPreviewDigest: proposal.planSha256
  });
  await publishSkill(publisher, 3);
  const newerApproved = await loadStoryConfigurationSnapshot({
    remote, branch: CONFIGURATION_BRANCH
  });
  git(root, 'config', 'user.name', 'Story Reviewer');
  git(root, 'config', 'user.email', 'reviewer@example.invalid');
  await assert.rejects(previewStorySkillVersionDecision(root, config, workflow, {
    proposalId: proposal.proposalId, decision: 'reject',
    approvedConfigurationSnapshot: {
      ...newerApproved, authority: { ...newerApproved.authority,
        remote: '/other-organisation/config.git' }
    }
  }), { code: 'SKP_AMENDMENT_AUTHORITY_CHANGED' });
  await assert.rejects(previewStorySkillVersionDecision(root, config, workflow, {
    proposalId: proposal.proposalId, decision: 'approve',
    approvedConfigurationSnapshot: newerApproved
  }), { code: 'SKP_AMENDMENT_STALE' });
  const rejectionReason = 'Superseded by a newer approved package.';
  const rejection = JSON.parse(flow(root, 'story', 'skill-version', 'decide',
    proposal.proposalId, '--decision', 'reject', '--reason', rejectionReason, '--json'));
  assert.equal(rejection.willApply, false);
  const result = JSON.parse(flow(root, 'story', 'skill-version', 'decide',
    proposal.proposalId, '--decision', 'reject', '--reason', rejectionReason,
    '--confirm', rejection.planSha256, '--json'));
  assert.equal(result.applied, false);
  const reloaded = await loadWorkflow(root, config, 'SKP-ADOPT-1');
  assert.equal(reloaded.workflowSnapshot.revision, 1);
  assert.equal(reloaded.skillVersionAmendments[0].status, 'rejected');
  const status = JSON.parse(flow(root, 'story', 'skill-version', 'status', '--json'));
  assert.equal(status.resultType, 'skill-version-adoption-status');
  assert.equal(status.proposals[0].status, 'rejected');
  assert.equal(JSON.stringify(status).includes('Superseded by a newer'), false,
    'navigation status must not expose unbounded review prose');
  const third = await previewStorySkillVersionProposal(root, config, reloaded, {
    skillId: 'threat-model', approvedConfigurationSnapshot: newerApproved,
    reason: 'Review the current package after rejecting stale version two.'
  });
  assert.equal(third.proposalId, 'SAM-002');
});
