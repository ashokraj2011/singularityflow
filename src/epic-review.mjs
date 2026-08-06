import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { branch, gitDir, identity } from './git.mjs';
import {
  approvePhase, commitAndPublish, loadConfig, loadWorkflow, rejectPhase
} from './state.mjs';
import { loadInitiative } from './initiative-state.mjs';
import { loadInitiativeBreakdown, syncInitiativeRepositories } from './initiative-repositories.mjs';
import { readStoryReviewPacket } from './story-lineage.mjs';
import { runAndRecordStoryChecks } from './github-evidence.mjs';
import { documentCatalog } from './documents.mjs';
import { createReviewBundle, reviewMarkdown } from './review.mjs';
import { commitInitiativeChange } from './initiative-state.mjs';
import { setAgentSession } from './session.mjs';
import { exists, run, SingularityFlowError } from './util.mjs';
import { matchApprovalAuthority } from './approval-authority.mjs';

function workItemPath(workId) {
  return `singularity/work-items/${workId}/workflow.json`;
}

function reviewClone(root, initiativeId, repositoryId) {
  return path.join(gitDir(root), 'singularity-flow', 'reviews', initiativeId, repositoryId);
}

function git(root, args, { allowFailure = false } = {}) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  if (!allowFailure && result.status !== 0) {
    throw new SingularityFlowError(`Git review checkout failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function validateCloneRemote(clone, expected) {
  const actual = git(clone, ['remote', 'get-url', 'origin']).stdout.trim();
  if (actual !== expected) throw new SingularityFlowError(`Managed review checkout remote '${actual}' does not match '${expected}'.`);
}

async function prepareReviewClone(root, initiative, story) {
  const repository = initiative.resolution.repositories?.[story.repository];
  if (!repository) throw new SingularityFlowError(`Story '${story.id}' references unknown repository '${story.repository}'.`);
  const clone = reviewClone(root, initiative.initiative.id, story.repository);
  if (!(await exists(path.join(clone, '.git')))) {
    await mkdir(path.dirname(clone), { recursive: true });
    const result = run('git', ['clone', '--no-checkout', repository.url, clone], { cwd: root, allowFailure: true });
    if (result.status !== 0) throw new SingularityFlowError(`Unable to create isolated review checkout for '${story.repository}': ${(result.stderr || result.stdout).trim()}`);
  }
  validateCloneRemote(clone, repository.url);
  if (git(clone, ['status', '--porcelain']).stdout.trim()) {
    throw new SingularityFlowError(`Isolated review checkout for '${story.repository}' has local changes; inspect ${clone}.`);
  }
  const actor = identity(root);
  if (actor.name) git(clone, ['config', 'user.name', actor.name]);
  if (actor.email) git(clone, ['config', 'user.email', actor.email]);
  git(clone, ['fetch', '--prune', 'origin']);
  return clone;
}

function candidateRemoteRefs(clone) {
  return git(clone, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']).stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value && value !== 'origin/HEAD');
}

function workflowAtRef(clone, ref, workId) {
  const result = git(clone, ['show', `${ref}:${workItemPath(workId)}`], { allowFailure: true });
  if (result.status !== 0) return null;
  try {
    const workflow = JSON.parse(result.stdout);
    return workflow?.workItem?.id === workId ? workflow : null;
  } catch {
    return null;
  }
}

function latestSubmission(candidates, packetSha256 = null) {
  const submissions = candidates.flatMap(({ ref, workflow }) =>
    (workflow.lineage?.submissions ?? []).map((submission) => ({ ref, workflow, submission }))
  ).filter((entry) => !packetSha256 || entry.submission.packetSha256 === packetSha256);
  submissions.sort((left, right) =>
    String(right.submission.submittedAt ?? '').localeCompare(String(left.submission.submittedAt ?? ''))
  );
  return submissions[0] ?? null;
}

function latestFinalizedSubmission(candidates) {
  const finalized = candidates.flatMap(({ ref, workflow }) =>
    (workflow.lineage?.finalizations ?? []).map((finalization) => ({ ref, workflow, finalization }))
  );
  finalized.sort((left, right) =>
    String(right.finalization.finalizedAt ?? '').localeCompare(String(left.finalization.finalizedAt ?? ''))
  );
  const selected = finalized[0];
  if (!selected) return null;
  const submission = (selected.workflow.lineage?.submissions ?? [])
    .find((entry) => entry.packetSha256 === selected.finalization.reviewPacketSha256);
  return submission ? { ref: selected.ref, workflow: selected.workflow, submission, finalization: selected.finalization } : null;
}

async function resolveStory(root, initiativeId, storyReference) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
  const story = breakdown.stories.find((entry) =>
    [entry.id, entry.planId, entry.workId, entry.jiraKey, ...(entry.jiraAliases ?? [])].includes(storyReference)
  );
  if (!story) throw new SingularityFlowError(`Epic '${initiativeId}' has no planned Story '${storyReference}'.`);
  return { portfolio, initiative, breakdown, story };
}

async function checkoutSubmission(root, initiativeId, storyReference, packetSha256 = null) {
  const resolved = await resolveStory(root, initiativeId, storyReference);
  const workId = resolved.story.workId ?? resolved.story.id;
  const clone = await prepareReviewClone(root, resolved.initiative, resolved.story);
  const candidates = candidateRemoteRefs(clone)
    .map((ref) => ({ ref, workflow: workflowAtRef(clone, ref, workId) }))
    .filter((entry) => entry.workflow);
  const finalized = latestFinalizedSubmission(candidates);
  const latest = finalized ?? latestSubmission(candidates);
  const selected = packetSha256 ? latestSubmission(candidates, packetSha256) : finalized;
  if (!selected) throw new SingularityFlowError(
    `Story '${workId}' has no finalized review packet on any published branch. The developer must run singularity-flow finalize.`
  );
  if (packetSha256 && finalized?.finalization.reviewPacketSha256 !== packetSha256) {
    throw new SingularityFlowError(
      `Review packet '${packetSha256.slice(0, 12)}' is not the packet referenced by the latest developer finalization `
      + `'${finalized?.finalization.packetSha256?.slice(0, 12) ?? 'missing'}'.`
    );
  }
  if (packetSha256 && latest?.submission.packetSha256 !== packetSha256) {
    throw new SingularityFlowError(
      `Review packet '${packetSha256.slice(0, 12)}' is stale. Open the latest submitted packet '${latest.submission.packetSha256.slice(0, 12)}' before deciding.`
    );
  }
  const submittedBranch = selected.ref.replace(/^origin\//, '');
  const switched = git(clone, ['switch', '-C', submittedBranch, selected.ref], { allowFailure: true });
  if (switched.status !== 0) throw new SingularityFlowError(`Unable to open submitted branch '${submittedBranch}': ${(switched.stderr || switched.stdout).trim()}`);
  const config = await loadConfig(clone);
  const workflow = await loadWorkflow(clone, config, workId);
  const packet = await readStoryReviewPacket(clone, config, workflow, selected.submission.packetSha256);
  return { ...resolved, clone, config, workflow, packet, submittedBranch };
}

function identityKey(actor) {
  return String(actor?.email ?? actor?.login ?? actor?.name ?? '').trim().toLowerCase();
}

function approvalPreview(selected) {
  const phase = selected.workflow.phases[selected.packet.phase];
  if (!phase) throw new SingularityFlowError(`Review packet references unknown phase '${selected.packet.phase}'.`);
  const activeEvidence = [...(selected.workflow.lineage?.reviewEvidence ?? [])]
    .reverse()
    .find((entry) => entry.packetSha256 === selected.packet.packetSha256) ?? null;
  const reviewer = identity(selected.clone);
  const availableAgents = Object.entries(selected.config.agents ?? {}).map(([id, agent]) => ({
    id,
    label: agent.label ?? id
  }));
  const defaultAgent = phase.defaultAgent ?? availableAgents[0]?.id ?? null;
  const authority = matchApprovalAuthority(
    selected.workflow.resolution.approvalAuthorities ?? selected.config.approvalAuthorities,
    phase.approvalPolicy,
    reviewer
  );
  return {
    phase: phase.id,
    status: phase.status,
    generation: phase.generation,
    minimum: phase.approvalPolicy?.minimum ?? 1,
    availableAgents,
    defaultAgent,
    reviewerAuthority: authority,
    rejectTo: phase.approvalPolicy?.rejectTo ?? [phase.id],
    reviewer,
    submittedBy: selected.packet.submittedBy,
    generatedBy: phase.generatedBy ?? null,
    selfApprovalWarning: [selected.packet.submittedBy, phase.generatedBy]
      .some((actor) => identityKey(actor) && identityKey(actor) === identityKey(reviewer)),
    evidence: activeEvidence
  };
}

export async function epicReviewStory(root, initiativeId, storyReference, { packetSha256 = null } = {}) {
  const selected = await checkoutSubmission(root, initiativeId, storyReference, packetSha256);
  const review = await createReviewBundle(selected.clone, selected.config, selected.workflow);
  review.markdown = reviewMarkdown(review);
  return {
    initiativeId,
    story: selected.story,
    checkout: selected.clone,
    submittedBranch: selected.submittedBranch,
    packet: selected.packet,
    documents: await documentCatalog(selected.clone, selected.config, selected.workflow),
    review,
    approval: approvalPreview(selected)
  };
}

export async function epicReviewDecision(root, initiativeId, storyReference, {
  packetSha256,
  decision,
  agent,
  target = null,
  reason = null,
  channel = 'desktop-epic-review'
} = {}) {
  if (!packetSha256) throw new SingularityFlowError('An exact Story review-packet hash is required.');
  if (!['approve', 'reject'].includes(decision)) throw new SingularityFlowError("Review decision must be 'approve' or 'reject'.");
  const selected = await checkoutSubmission(root, initiativeId, storyReference, packetSha256);
  const preview = approvalPreview(selected);
  if (preview.status !== 'awaiting_approval') {
    throw new SingularityFlowError(`Story phase '${preview.phase}' is '${preview.status}', not awaiting approval.`);
  }
  const selectedAgent = agent ?? preview.defaultAgent;
  if (!preview.availableAgents.some((entry) => entry.id === selectedAgent)) {
    throw new SingularityFlowError(
      `Unknown governed agent '${selectedAgent ?? ''}'. Choose one of: ${preview.availableAgents.map((entry) => entry.id).join(', ')}.`
    );
  }
  if (!preview.reviewerAuthority.authorized) throw new SingularityFlowError(preview.reviewerAuthority.reason);
  if (decision === 'approve' && !preview.evidence?.ready) {
    throw new SingularityFlowError(
      `Exact-SHA checks have not passed for packet '${packetSha256.slice(0, 12)}'. Run and record checks before approval.`
    );
  }
  await setAgentSession(
    selected.clone,
    selected.config,
    identity(selected.clone),
    selectedAgent,
    selected.workflow.workItem.id
  );
  const workflowBeforeDecision = structuredClone(selected.workflow);
  const outcome = decision === 'approve'
    ? await approvePhase(selected.clone, selected.config, selected.workflow, {
      phaseId: preview.phase,
      channel,
      persist: false
    })
    : await rejectPhase(selected.clone, selected.config, selected.workflow, {
      phaseId: preview.phase,
      target: target ?? preview.phase,
      reason,
      channel
    });
  const publication = await commitAndPublish(
    selected.clone,
    selected.config,
    selected.workflow,
    { type: decision === 'approve' ? 'phase-approved' : 'phase-rejected', phaseId: preview.phase, payload: { packetSha256 } },
    `[${selected.workflow.workItem.id}][review:${decision}] ${packetSha256.slice(0, 12)}`,
    [],
    { rollbackWorkflow: workflowBeforeDecision }
  );
  const synchronized = await syncInitiativeRepositories(root, initiativeId);
  const refreshed = await loadInitiative(root, initiativeId);
  const initiativePublication = await commitInitiativeChange(
    root,
    refreshed.portfolio,
    refreshed.initiative,
    { type: 'evidence-recorded', payload: { storyId: selected.story.workId ?? selected.story.id, decision, packetSha256 } },
    `[${initiativeId}][epic:review] ${decision} ${selected.story.workId ?? selected.story.id}`
  );
  return {
    initiativeId,
    story: selected.story,
    packetSha256,
    decision,
    phase: preview.phase,
    outcome,
    selfApproval: decision === 'approve' ? Boolean(outcome.approval?.selfApproval) : preview.selfApprovalWarning,
    publication,
    synchronized,
    initiativePublication
  };
}

export async function epicCheckStory(root, initiativeId, storyReference, {
  packetSha256 = null,
  runCommand = run
} = {}) {
  const selected = await checkoutSubmission(root, initiativeId, storyReference, packetSha256);
  const checks = await runAndRecordStoryChecks(selected.clone, selected.config, selected.workflow, {
    packetSha256: selected.packet.packetSha256,
    runCommand
  });
  const synchronized = await syncInitiativeRepositories(root, initiativeId);
  const refreshed = await loadInitiative(root, initiativeId);
  const publication = await commitInitiativeChange(
    root,
    refreshed.portfolio,
    refreshed.initiative,
    { type: 'evidence-recorded', payload: { storyId: selected.story.workId ?? selected.story.id, checksRecorded: true } },
    `[${initiativeId}][epic:review] record ${selected.story.workId ?? selected.story.id} checks`
  );
  return {
    initiativeId,
    story: selected.story,
    packet: selected.packet,
    checks,
    synchronized,
    publication
  };
}

export async function listEpicReviewInbox(root, initiativeId) {
  const { initiative, breakdown } = await resolveStoryList(root, initiativeId);
  const items = [];
  for (const story of breakdown.stories) {
    const workId = story.workId ?? story.id;
    const clone = await prepareReviewClone(root, initiative, story);
    const candidates = candidateRemoteRefs(clone)
      .map((ref) => ({ ref, workflow: workflowAtRef(clone, ref, workId) }))
      .filter((entry) => entry.workflow);
    const selected = latestFinalizedSubmission(candidates);
    if (!selected) continue;
    items.push({
      planId: story.planId ?? story.id,
      workId,
      jiraKey: story.jiraKey ?? null,
      repository: story.repository,
      branch: selected.ref.replace(/^origin\//, ''),
      packetSha256: selected.submission.packetSha256,
      phase: selected.submission.phase,
      generation: selected.submission.generation,
      submittedAt: selected.submission.submittedAt,
      finalizedAt: selected.finalization.finalizedAt,
      finalizationSha256: selected.finalization.packetSha256,
      status: 'finalized_for_review'
    });
  }
  return items.sort((left, right) => String(right.submittedAt).localeCompare(String(left.submittedAt)));
}

async function resolveStoryList(root, initiativeId) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  return {
    portfolio,
    initiative,
    breakdown: await loadInitiativeBreakdown(root, portfolio, initiativeId)
  };
}
