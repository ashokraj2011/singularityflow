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
import { setPersonaSession } from './session.mjs';
import { exists, run, SingularityFlowError } from './util.mjs';

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
  const latest = latestSubmission(candidates);
  const selected = latestSubmission(candidates, packetSha256);
  if (!selected) throw new SingularityFlowError(`Story '${workId}' has no submitted review packet on any published branch.`);
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
  const personas = (phase.approvalPolicy?.personas ?? [])
    .filter((persona) => selected.config.personas?.[persona]?.mayApprove?.includes(phase.id))
    .map((persona) => ({
      id: persona,
      label: selected.config.personas[persona].label ?? persona
    }));
  return {
    phase: phase.id,
    status: phase.status,
    generation: phase.generation,
    minimum: phase.approvalPolicy?.minimum ?? 1,
    personas,
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
  persona,
  target = null,
  reason = null
} = {}) {
  if (!packetSha256) throw new SingularityFlowError('An exact Story review-packet hash is required.');
  if (!['approve', 'reject'].includes(decision)) throw new SingularityFlowError("Review decision must be 'approve' or 'reject'.");
  const selected = await checkoutSubmission(root, initiativeId, storyReference, packetSha256);
  const preview = approvalPreview(selected);
  if (preview.status !== 'awaiting_approval') {
    throw new SingularityFlowError(`Story phase '${preview.phase}' is '${preview.status}', not awaiting approval.`);
  }
  if (!preview.personas.some((entry) => entry.id === persona)) {
    throw new SingularityFlowError(
      `Persona '${persona ?? ''}' cannot decide phase '${preview.phase}'. Choose one of: ${preview.personas.map((entry) => entry.id).join(', ')}.`
    );
  }
  if (decision === 'approve' && !preview.evidence?.ready) {
    throw new SingularityFlowError(
      `Exact-SHA checks have not passed for packet '${packetSha256.slice(0, 12)}'. Run and record checks before approval.`
    );
  }
  await setPersonaSession(
    selected.clone,
    selected.config,
    identity(selected.clone),
    persona,
    selected.workflow.workItem.id
  );
  const outcome = decision === 'approve'
    ? await approvePhase(selected.clone, selected.config, selected.workflow, {
      phaseId: preview.phase,
      channel: 'desktop-epic-review'
    })
    : await rejectPhase(selected.clone, selected.config, selected.workflow, {
      phaseId: preview.phase,
      target: target ?? preview.phase,
      reason,
      channel: 'desktop-epic-review'
    });
  const publication = await commitAndPublish(
    selected.clone,
    selected.config,
    selected.workflow,
    `[${selected.workflow.workItem.id}][review:${decision}] ${packetSha256.slice(0, 12)}`
  );
  const synchronized = await syncInitiativeRepositories(root, initiativeId);
  const refreshed = await loadInitiative(root, initiativeId);
  const initiativePublication = await commitInitiativeChange(
    root,
    refreshed.portfolio,
    refreshed.initiative,
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
    const selected = latestSubmission(candidates);
    if (!selected) continue;
    if (selected.workflow.phases?.[selected.submission.phase]?.status !== 'awaiting_approval') continue;
    items.push({
      planId: story.planId ?? story.id,
      workId,
      jiraKey: story.jiraKey ?? null,
      repository: story.repository,
      branch: selected.ref.replace(/^origin\//, ''),
      packetSha256: selected.submission.packetSha256,
      phase: selected.submission.phase,
      generation: selected.submission.generation,
      submittedAt: selected.submission.submittedAt
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
