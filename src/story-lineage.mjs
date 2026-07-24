import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { branch, changes, head, identity } from './git.mjs';
import { loadSession, setPersonaSession } from './session.mjs';
import {
  commitAndPublish, loadWorkflow, saveWorkflow, sourceTreeHash, workflowBranchAllowed,
  workflowPublicationBranch, workDir
} from './state.mjs';
import { nowIso, run, SingularityFlowError, writeJson } from './util.mjs';

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateBranchName(root, value) {
  const name = String(value ?? '').trim();
  if (!name) throw new SingularityFlowError('A child branch name is required.');
  const result = run('git', ['check-ref-format', '--branch', name], { cwd: root, allowFailure: true });
  if (result.status !== 0) throw new SingularityFlowError(`Invalid Git branch name '${name}'.`);
  return name;
}

function childRecord(workflow, name, actor, baseCommit) {
  return {
    name,
    parentStoryId: workflow.workItem.id,
    canonicalBranch: workflow.lineage?.canonicalBranch ?? workflow.workItem.branch,
    baseCommit,
    registeredAt: nowIso(),
    registeredBy: actor,
    status: 'active'
  };
}

async function preservePersona(root, config, workflow) {
  const session = await loadSession(root, { required: false });
  if (session?.persona && config.personas?.[session.persona]) {
    await setPersonaSession(root, config, identity(root), session.persona, workflow.workItem.id);
  }
}

export async function attachStoryBranch(root, config, {
  parentStoryId,
  branchName = branch(root)
} = {}) {
  if (!parentStoryId) throw new SingularityFlowError('Attaching a child branch requires --parent with the canonical Story Work ID.');
  const workflow = await loadWorkflow(root, config, parentStoryId);
  const current = validateBranchName(root, branchName);
  if (current !== branch(root)) throw new SingularityFlowError(`Current branch is '${branch(root)}'; cannot attach '${current}' without checking it out.`);
  if (current === workflow.workItem.branch) {
    await preservePersona(root, config, workflow);
    return { workflow, branch: current, canonical: true, created: false, publication: null };
  }
  const existing = (workflow.lineage?.childBranches ?? []).find((entry) => entry.name === current);
  if (existing) {
    await preservePersona(root, config, workflow);
    return { workflow, branch: current, canonical: false, created: false, record: existing, publication: null };
  }
  workflow.lineage ??= {
    schemaVersion: 1,
    canonicalBranch: workflow.workItem.branch,
    parentStoryId: workflow.workItem.id,
    childBranches: []
  };
  workflow.lineage.childBranches ??= [];
  const actor = identity(root);
  const record = childRecord(workflow, current, actor, head(root));
  workflow.lineage.childBranches.push(record);
  workflow.history.push({
    at: record.registeredAt,
    actor: actor.email?.toLowerCase() ?? actor.name,
    event: 'child_branch_attached',
    phase: workflow.currentPhase,
    detail: `${current} -> ${workflow.workItem.id}`
  });
  await saveWorkflow(root, config, workflow);
  const publication = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][branch:attach] ${current}`);
  await preservePersona(root, config, workflow);
  return { workflow, branch: current, canonical: false, created: true, record, publication };
}

export async function createStoryBranch(root, config, {
  parentStoryId,
  branchName
} = {}) {
  if (changes(root).trim()) throw new SingularityFlowError('Create a child branch from a clean canonical Story checkout.');
  const workflow = await loadWorkflow(root, config, parentStoryId);
  if (branch(root) !== workflow.workItem.branch) {
    throw new SingularityFlowError(`Child branches must start from canonical Story branch '${workflow.workItem.branch}'.`);
  }
  const name = validateBranchName(root, branchName);
  if (workflowBranchAllowed(workflow, name)) throw new SingularityFlowError(`Branch '${name}' is already registered for Story '${parentStoryId}'.`);
  const switched = run('git', ['switch', '-c', name], { cwd: root, allowFailure: true });
  if (switched.status !== 0) throw new SingularityFlowError(`Unable to create child branch '${name}': ${(switched.stderr || switched.stdout).trim()}`);
  return attachStoryBranch(root, config, { parentStoryId, branchName: name });
}

export async function storyBranchStatus(root, config, parentStoryId = null) {
  const workflow = await loadWorkflow(root, config, parentStoryId ?? undefined);
  const current = branch(root);
  const child = workflow.lineage?.childBranches?.find((entry) => entry.name === current) ?? null;
  return {
    workId: workflow.workItem.id,
    epicId: workflow.lineage?.epicId ?? null,
    planId: workflow.lineage?.planId ?? null,
    canonicalBranch: workflow.lineage?.canonicalBranch ?? workflow.workItem.branch,
    currentBranch: current,
    registered: workflowBranchAllowed(workflow, current),
    kind: current === workflow.workItem.branch ? 'canonical' : child ? 'child' : 'unregistered',
    child,
    childBranches: workflow.lineage?.childBranches ?? []
  };
}

export async function createStoryReviewPacket(root, config, workflow, phase) {
  const submittedBranch = workflowPublicationBranch(root, workflow);
  const artifacts = [];
  for (const item of phase.artifacts ?? []) {
    artifacts.push({
      path: item.path,
      kind: item.kind ?? null,
      sha256: item.sha256 ?? null,
      size: item.size ?? null
    });
  }
  const base = {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    epicId: workflow.lineage?.epicId ?? null,
    planId: workflow.lineage?.planId ?? null,
    jiraIssueId: workflow.lineage?.jiraIssueId ?? null,
    initialJiraKey: workflow.lineage?.initialJiraKey ?? null,
    currentJiraKey: workflow.lineage?.currentJiraKey ?? null,
    canonicalBranch: workflow.lineage?.canonicalBranch ?? workflow.workItem.branch,
    submittedBranch,
    submissionCommit: head(root),
    sourceCommit: phase.generationCommit ?? head(root),
    sourceTreeSha256: await sourceTreeHash(root),
    phase: phase.id,
    generation: phase.generation,
    artifacts,
    checks: phase.checks ?? [],
    usage: phase.usage ?? [],
    approvals: phase.approvals?.filter((entry) => !entry.invalidatedAt) ?? [],
    submittedAt: phase.submittedAt ?? nowIso(),
    submittedBy: identity(root),
    status: 'awaiting_review'
  };
  const packetSha256 = hash(base);
  const packet = { ...base, packetSha256 };
  const file = path.join(workDir(root, config, workflow.workItem.id), 'submissions', phase.id, `${packetSha256}.json`);
  await writeJson(file, packet);
  workflow.lineage ??= { schemaVersion: 1, canonicalBranch: workflow.workItem.branch, parentStoryId: workflow.workItem.id, childBranches: [] };
  workflow.lineage.submissions ??= [];
  workflow.lineage.submissions.push({
    packetSha256,
    phase: phase.id,
    generation: phase.generation,
    branch: submittedBranch,
    sourceTreeSha256: base.sourceTreeSha256,
    path: path.relative(root, file).split(path.sep).join('/'),
    submittedAt: base.submittedAt
  });
  await saveWorkflow(root, config, workflow);
  return { packet, path: path.relative(root, file).split(path.sep).join('/') };
}

export async function readStoryReviewPacket(root, config, workflow, packetSha256 = null) {
  const selected = packetSha256
    ? workflow.lineage?.submissions?.find((entry) => entry.packetSha256 === packetSha256)
    : workflow.lineage?.submissions?.at(-1);
  if (!selected) throw new SingularityFlowError(`Story '${workflow.workItem.id}' has no submitted review packet.`);
  const packet = JSON.parse(await readFile(path.join(root, selected.path), 'utf8'));
  const { packetSha256: provided, ...base } = packet;
  if (provided !== selected.packetSha256 || hash(base) !== provided) throw new SingularityFlowError('Story review packet hash is invalid.');
  return packet;
}

export async function promoteStoryBranch(root, config, workflow, {
  mode = null
} = {}) {
  const current = workflowPublicationBranch(root, workflow);
  const canonical = workflow.lineage?.canonicalBranch ?? workflow.workItem.branch;
  if (current === canonical) return { mode: 'canonical', branch: canonical, commit: head(root), pushed: false };
  const seedPath = path.join(root, 'singularity', 'seeds', `${workflow.workItem.id}.yml`);
  let policy = workflow.lineage?.branchCompletionPolicy ?? 'pr';
  try {
    const YAML = (await import('yaml')).default;
    const seed = YAML.parse(await readFile(seedPath, 'utf8'));
    policy = seed?.story?.branchCompletionPolicy ?? 'pr';
  } catch { /* Legacy seeds default to PR completion. */ }
  const selected = mode ?? (policy === 'either' ? null : policy);
  if (!selected || !['pr', 'direct'].includes(selected)) throw new SingularityFlowError(`Repository policy is '${policy}'. Choose --mode pr or --mode direct.`);
  if (policy !== 'either' && selected !== policy) throw new SingularityFlowError(`Repository policy requires '${policy}' completion.`);
  if (selected === 'pr') {
    return { mode: 'pr', branch: current, canonicalBranch: canonical, requiresPullRequest: true };
  }
  const result = run('git', ['push', config.git?.remote ?? 'origin', `HEAD:${canonical}`], { cwd: root, allowFailure: true });
  if (result.status !== 0) throw new SingularityFlowError(`Direct promotion could not fast-forward '${canonical}': ${(result.stderr || result.stdout).trim()}. Rebase the child branch or use a pull request.`);
  return { mode: 'direct', branch: current, canonicalBranch: canonical, commit: head(root), pushed: true };
}
