/** Synthetic local-only accepted amendment setup, shared with adversarial tests. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CONFIGURATION_BRANCH, ensureConfigurationBranch, inspectApprovedSkillPackage,
  loadStoryConfigurationSnapshot
} from '../src/configuration-branch.mjs';
import { canonicalJson } from '../src/records.mjs';
import { run } from '../src/util.mjs';
import {
  captureWorkflowSnapshot, captureWorkflowSnapshotAmendment, verifyWorkflowSnapshot
} from '../src/workflow-snapshots.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const qualified = (bytes) => `sha256:${digest(bytes)}`;
const domainHash = (domain, value) => qualified(Buffer.concat([
  Buffer.from(`${domain}\0`), Buffer.from(canonicalJson(value))
]));

export async function fixture(t, { secondSkill = false, approvalMinimum = 1, runtime = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-amendment-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const application = path.join(base, 'application');
  const remote = path.join(base, 'approved.git');
  const publisher = path.join(base, 'publisher');
  const storyRoot = path.join(base, 'story');
  run('git', ['init', '-q', '-b', 'main', application], { cwd: base });
  run('git', ['config', 'user.name', 'Snapshot Test'], { cwd: application });
  run('git', ['config', 'user.email', 'snapshot@example.invalid'], { cwd: application });
  await writeFile(path.join(application, 'README.md'), '# Application\n');
  run('git', ['add', '-A'], { cwd: application });
  run('git', ['commit', '-qm', 'application baseline'], { cwd: application });
  run('git', ['clone', '-q', '--bare', application, remote], { cwd: base });
  await ensureConfigurationBranch(remote);
  run('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, remote, publisher], { cwd: base });
  run('git', ['config', 'user.name', 'Skill Publisher'], { cwd: publisher });
  run('git', ['config', 'user.email', 'publisher@example.invalid'], { cwd: publisher });
  const source = path.join(publisher, 'singularity/skills/threat-model');
  await mkdir(path.join(source, 'references'), { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '# Threat model\n\nRead references/checklist.md.\n');
  await writeFile(path.join(source, 'references/checklist.md'), 'Original checklist.\n');
  if (secondSkill) {
    const other = path.join(publisher, 'singularity/skills/risk-register');
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, 'SKILL.md'), '# Risk register\n\nKeep exact accepted risks.\n');
  }
  run('git', ['add', '-A'], { cwd: publisher });
  run('git', ['commit', '-qm', 'approve skill v1'], { cwd: publisher });
  run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: publisher });
  const approved = await loadStoryConfigurationSnapshot({ remote, branch: CONFIGURATION_BRANCH });
  const selected = await inspectApprovedSkillPackage(approved, 'threat-model');
  const retainedOther = secondSkill
    ? await inspectApprovedSkillPackage(approved, 'risk-register') : null;

  await mkdir(path.join(storyRoot, '.github/agents'), { recursive: true });
  const agentPath = '.github/agents/developer.agent.md';
  const agentPhases = secondSkill ? 'threat-model,risk-register' : 'threat-model';
  const agent = `---\nname: developer\ndescription: Review threat models.\nmetadata:\n  sflow-phases: ${agentPhases}\n  sflow-default-for: ${agentPhases}\n---\n# Developer\n\nUse the accepted Story.\n`;
  await writeFile(path.join(storyRoot, agentPath), agent);
  const config = {
    workItemRoot: 'singularity/work-items',
    agentCatalog: [{
      id: 'developer', file: path.join(storyRoot, agentPath), source: agentPath,
      scope: 'repository', sha256: digest(agent), dependencies: []
    }]
  };
  const workflow = {
    schemaVersion: 9,
    workItem: { id: 'SKP-1', workType: 'feature', createdAt: '2026-09-26T00:00:00.000Z' },
    phaseOrder: secondSkill ? ['threat-model', 'risk-register'] : ['threat-model'],
    resolution: {
      session: {}, contextPolicy: {}, sequenceGates: {},
      configurationSource: { repository: remote, commit: approved.sourceCommit,
        filesSha256: null },
      approvalAuthorities: {
        reviewers: { label: 'Reviewers', allowAnyGitIdentity: true, members: [] }
      },
      phases: [{
        id: 'threat-model', kind: 'skill', defaultAgent: 'developer',
        approval: { mode: 'required', authorities: ['reviewers'], requiredAuthorities: [],
          minimum: approvalMinimum, allowSelfApproval: false },
        skillBinding: {
          schemaVersion: 1, compiler: 'skp-contract/v1', compilationSha256: H('c'),
          parserProfile: 'skp-skill-text/v1',
          bindingRefs: {
            skill: { id: 'threat-model', packageSha256: selected.manifest.packageSha256 },
            contractSha256: H('b'), inputs: [], outputs: []
          }
        }
      }, ...(secondSkill ? [{
        id: 'risk-register', kind: 'skill', defaultAgent: 'developer',
        approval: { mode: 'required', authorities: ['reviewers'], requiredAuthorities: [],
          minimum: 1, allowSelfApproval: false },
        skillBinding: {
          schemaVersion: 1, compiler: 'skp-contract/v1', compilationSha256: H('7'),
          parserProfile: 'skp-skill-text/v1',
          bindingRefs: {
            skill: { id: 'risk-register', packageSha256: retainedOther.manifest.packageSha256 },
            contractSha256: H('8'), inputs: [], outputs: []
          }
        }
      }] : [])],
      templates: {}
    }
  };
  if (runtime) {
    for (const phase of workflow.resolution.phases) phase.skillBinding.bindingRefs.outputs = [{
      id: 'report', path: `artifacts/${phase.id}/report.md`, kind: 'report', required: true,
      minimumBytes: 1, maximumBytes: 1048576, encoding: 'utf8', mediaType: 'text/markdown'
    }];
    workflow.currentPhase = workflow.phaseOrder[0]; workflow.status = 'active';
    workflow.workItem.branch = workflow.workItem.id;
    workflow.lineage = { canonicalBranch: workflow.workItem.id, childBranches: [], requiredChecks: [] };
    workflow.phases = Object.fromEntries(workflow.resolution.phases.map(phase => [phase.id, {
      id: phase.id, kind: phase.kind, status: 'in_progress', generation: 0, defaultAgent: phase.defaultAgent,
      artifacts: [], approvals: [], requiredArtifact: { path: `artifacts/${phase.id}/report.md`, kind: 'report' }
    }]));
  }
  workflow.workflowSnapshot = await captureWorkflowSnapshot(storyRoot, config, workflow,
    { approvedConfigurationSnapshot: approved });
  run('git', ['init', '-q', '-b', 'main'], { cwd: storyRoot });
  run('git', ['config', 'user.name', 'Story Author'], { cwd: storyRoot });
  run('git', ['config', 'user.email', 'story@example.invalid'], { cwd: storyRoot });
  const workflowPath = path.join(storyRoot, config.workItemRoot, workflow.workItem.id,
    'workflow.json');
  await mkdir(path.dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: storyRoot });
  run('git', ['commit', '-qm', 'accept skill Story genesis'], { cwd: storyRoot });
  return { storyRoot, remote, publisher, source, config, workflow, workflowPath,
    retainedOther };
}

export async function propose(t, options = {}) {
  const value = await fixture(t, options);
  const genesis = await verifyWorkflowSnapshot(value.storyRoot, value.config, value.workflow,
    { requireAccepted: true, retainBytes: true });
  await writeFile(path.join(value.source, 'SKILL.md'),
    '# Threat model v2\n\nUse the amended checklist.\n');
  await writeFile(path.join(value.source, 'references/checklist.md'),
    'Reviewed amended checklist.\n');
  run('git', ['add', '-A'], { cwd: value.publisher });
  run('git', ['commit', '-qm', 'approve skill v2'], { cwd: value.publisher });
  run('git', ['push', '-q', 'origin', CONFIGURATION_BRANCH], { cwd: value.publisher });
  const approved = await loadStoryConfigurationSnapshot({
    remote: value.remote, branch: CONFIGURATION_BRANCH
  });
  const selected = await inspectApprovedSkillPackage(approved, 'threat-model');
  const proposed = structuredClone(value.workflow);
  proposed.resolution.configurationSource.commit = approved.sourceCommit;
  const phase = proposed.resolution.phases[0];
  phase.skillBinding.bindingRefs.skill.packageSha256 = selected.manifest.packageSha256;
  phase.skillBinding.bindingRefs.contractSha256 = H('e');
  phase.skillBinding.compilationSha256 = H('d');
  const core = structuredClone(proposed.resolution);
  delete core.policySha256;
  const nextPolicySha256 = qualified(Buffer.from(canonicalJson(core)));
  const binding = phase.skillBinding;
  const decision = {
    schemaVersion: 1, kind: 'skill-version-adoption-decision', id: 'SAM-001',
    workId: value.workflow.workItem.id, status: 'approved',
    proposedBy: { email: 'proposer@example.invalid' },
    proposalSha256: null, impactSha256: null,
    approvedAt: '2026-09-26T01:00:00.000Z',
    approvals: [{ actor: { email: 'reviewer@example.invalid' },
      authorityGroup: 'reviewers', identityAssurance: 'configured-local',
      at: '2026-09-26T00:59:00.000Z' }],
    from: { revision: 1, snapshotHash: value.workflow.workflowSnapshot.snapshotHash,
      policySha256: genesis.policy.policySha256 },
    to: { revision: 2, policySha256: nextPolicySha256,
      configurationCommit: approved.sourceCommit, skillId: 'threat-model',
      packageSha256: selected.manifest.packageSha256,
      phaseBindings: [{
        phaseId: phase.id, contractSha256: binding.bindingRefs.contractSha256,
        compilationSha256: binding.compilationSha256, parserProfile: binding.parserProfile,
        bindingRefsSha256: domainHash('skp.binding-refs.v1', binding.bindingRefs)
      }] }
  };
  const reviewRoot = `${value.config.workItemRoot}/${value.workflow.workItem.id}/context/skill-amendments/SAM-001`;
  const proposalPath = `${reviewRoot}-proposal.json`;
  const impactPath = `${reviewRoot}-impact.json`;
  const impact = {
    schemaVersion: 1, kind: 'skill-version-adoption-impact', proposalId: 'SAM-001',
    workId: value.workflow.workItem.id, status: 'ready',
    affectedPhaseIds: ['threat-model'],
    preservedPhaseIds: value.retainedOther ? ['risk-register'] : []
  };
  const impactBytes = Buffer.from(canonicalJson(impact));
  const impactSha256 = qualified(impactBytes);
  const proposal = {
    schemaVersion: 1, kind: 'skill-version-adoption-proposal', id: 'SAM-001',
    workId: value.workflow.workItem.id, skillId: 'threat-model',
    proposedBy: decision.proposedBy, reason: 'Adopt reviewed skill update.',
    impactSha256, from: decision.from,
    to: {
      configurationCommit: decision.to.configurationCommit,
      packageSha256: decision.to.packageSha256,
      policySha256: decision.to.policySha256,
      phaseBindings: decision.to.phaseBindings
    }
  };
  const proposalBytes = Buffer.from(canonicalJson(proposal));
  const proposalSha256 = qualified(proposalBytes);
  decision.proposalSha256 = proposalSha256;
  decision.impactSha256 = impactSha256;
  const summary = {
    id: 'SAM-001', status: 'proposed', skillId: 'threat-model',
    proposalPath, proposalSha256, impactPath, impactSha256,
    from: decision.from,
    to: { configurationCommit: decision.to.configurationCommit,
      packageSha256: decision.to.packageSha256 },
    proposedBy: decision.proposedBy, proposedAt: '2026-09-26T00:30:00.000Z',
    approvals: [], affectedPhaseIds: impact.affectedPhaseIds,
    preservedPhaseIds: impact.preservedPhaseIds
  };
  value.workflow.skillVersionAmendments = [structuredClone(summary)];
  proposed.skillVersionAmendments = [structuredClone(summary)];
  await mkdir(path.dirname(path.join(value.storyRoot, proposalPath)), { recursive: true });
  await writeFile(path.join(value.storyRoot, proposalPath), proposalBytes);
  await writeFile(path.join(value.storyRoot, impactPath), impactBytes);
  const proposalCommitWorkflow = structuredClone(value.workflow);
  if (options.proposalResolutionTamper) {
    proposalCommitWorkflow.resolution.phases[0].approval.minimum += 1;
  }
  if (options.proposalLifecycleProgress) {
    proposalCommitWorkflow.history = [{
      at: '2026-09-26T00:31:00.000Z', event: 'phase_progress',
      phase: 'threat-model', detail: 'Unrelated Story activity.'
    }];
  }
  await writeFile(value.workflowPath, `${JSON.stringify(proposalCommitWorkflow, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: value.storyRoot });
  run('git', ['commit', '-qm', 'propose reviewed skill version adoption'],
    { cwd: value.storyRoot });
  if (options.proposalResolutionTamper) {
    // The forged proposal remains in Git history; restore the worktree so draft capture can reach
    // the acceptance boundary and exercise the accepted-chain forensic reader.
    await writeFile(value.workflowPath, `${JSON.stringify(value.workflow, null, 2)}\n`);
  }
  const decisionPath = `${value.config.workItemRoot}/${value.workflow.workItem.id}/context/skill-amendments/SAM-001-decision.json`;
  await mkdir(path.dirname(path.join(value.storyRoot, decisionPath)), { recursive: true });
  const decisionBytes = Buffer.from(`${JSON.stringify(decision, null, 2)}\n`);
  await writeFile(path.join(value.storyRoot, decisionPath), decisionBytes);
  return { ...value, approved, selected, proposed, decision, decisionPath,
    decisionSha256: qualified(decisionBytes) };
}

export async function stageAcceptedReview(value) {
  const approval = value.decision.approvals[0];
  const reviewPath = `${value.config.workItemRoot}/${value.workflow.workItem.id}/context/skill-amendments/SAM-001-review-001.json`;
  const review = {
    schemaVersion: 1, kind: 'skill-version-adoption-review', id: 'SAM-001',
    workId: value.workflow.workItem.id, decision: 'approve', actor: approval.actor,
    authorityGroup: approval.authorityGroup,
    identityAssurance: approval.identityAssurance, at: approval.at,
    reason: null, proposalSha256: value.decision.proposalSha256,
    impactSha256: value.decision.impactSha256
  };
  const reviewBytes = Buffer.from(canonicalJson(review));
  await writeFile(path.join(value.storyRoot, reviewPath), reviewBytes);
  const summary = value.proposed.skillVersionAmendments[0];
  summary.status = 'approved';
  summary.approvals = [{ ...approval, reviewPath, reviewSha256: qualified(reviewBytes) }];
  summary.decidedAt = value.decision.approvedAt;
  summary.decisionPath = value.decisionPath;
  summary.decisionSha256 = value.decisionSha256;
  value.proposed.schemaVersion = 10;
}

export async function acceptAmendment(value) {
  const reference = await captureWorkflowSnapshotAmendment(value.storyRoot, value.config,
    value.workflow, value.proposed, {
      approvedConfigurationSnapshot: value.approved,
      amendmentDecision: { path: value.decisionPath, sha256: value.decisionSha256 }
    });
  value.proposed.workflowSnapshot = reference;
  await stageAcceptedReview(value);
  if (value.proposed.phases) for (const phaseId of value.proposed.skillVersionAmendments[0].affectedPhaseIds) {
    value.proposed.phases[phaseId].skillAmendmentRevalidation = {
      id: 'SAM-001', state: 'affected', adoptedAt: value.decision.approvedAt,
      generationAtAdoption: value.proposed.phases[phaseId].generation
    };
  }
  await writeFile(value.workflowPath, `${JSON.stringify(value.proposed, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: value.storyRoot });
  run('git', ['commit', '-qm', 'accept reviewed skill version amendment'],
    { cwd: value.storyRoot });
  return reference;
}

