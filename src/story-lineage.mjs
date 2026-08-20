import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertNotDefaultBranch, branch, changes, defaultBranchName, head, identity } from './git.mjs';
import { loadSession, setAgentSession } from './session.mjs';
import {
  commitAndPublish, loadWorkflow, saveStoryDraft, sourceTreeHash, workflowBranchAllowed,
  workflowPublicationBranch, workDir
} from './state-stores.mjs';
import { nowIso, run, SingularityFlowError, snapshot, writeJson } from './util.mjs';
import { evaluateVisualCoverage } from './visual-coverage.mjs';
import { listVisualComparisons } from './visual-compare.mjs';
import { referenceRevision, registerReference } from './harness-imports.mjs';
import { createImpactReceipt } from './impact.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function mediaTypeFor(file) {
  const extension = path.extname(file).toLowerCase();
  return ({
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json',
    '.yml': 'application/yaml', '.yaml': 'application/yaml', '.csv': 'text/csv',
    '.txt': 'text/plain', '.log': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf'
  })[extension] ?? 'application/octet-stream';
}

function repositoryOrigin(root) {
  const result = run('git', ['remote', 'get-url', 'origin'], { cwd: root, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function validateBranchName(root, value, config = {}) {
  const name = String(value ?? '').trim();
  if (!name) throw new SingularityFlowError('A child branch name is required.');
  const result = run('git', ['check-ref-format', '--branch', name], { cwd: root, allowFailure: true });
  if (result.status !== 0) throw new SingularityFlowError(`Invalid Git branch name '${name}'.`);
  const applicationBranch = defaultBranchName(root, config);
  if (name === applicationBranch || name === 'main' || name === 'master') {
    throw new SingularityFlowError(`Branch '${name}' is reserved for application integration and cannot be registered as a Story branch.`);
  }
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

async function preserveAgent(root, config, workflow) {
  const session = await loadSession(root, { required: false });
  if (session?.agent && config.agents?.[session.agent]) {
    await setAgentSession(root, config, identity(root), session.agent, workflow.workItem.id);
  }
}

export async function attachStoryBranch(root, config, {
  parentStoryId,
  branchName = branch(root)
} = {}) {
  assertNotDefaultBranch(root, config, 'Story branch attachment');
  if (!parentStoryId) throw new SingularityFlowError('Attaching a child branch requires --parent with the canonical Story Work ID.');
  const workflow = await loadWorkflow(root, config, parentStoryId);
  const current = validateBranchName(root, branchName, config);
  if (current !== branch(root)) throw new SingularityFlowError(`Current branch is '${branch(root)}'; cannot attach '${current}' without checking it out.`);
  if (current === workflow.workItem.branch) {
    await preserveAgent(root, config, workflow);
    return { workflow, branch: current, canonical: true, created: false, publication: null };
  }
  const existing = (workflow.lineage?.childBranches ?? []).find((entry) => entry.name === current);
  if (existing) {
    await preserveAgent(root, config, workflow);
    return { workflow, branch: current, canonical: false, created: false, record: existing, publication: null };
  }
  const actor = identity(root);
  const record = childRecord(workflow, current, actor, head(root));
  // The in-memory registration has to happen first: `commitAndPublish` resolves the publication
  // branch eagerly through `workflowPublicationBranch`, which refuses a branch the aggregate does
  // not list. Only the durable write moves inside the transaction — that is where the bug was. A
  // failed publication used to leave the child branch recorded in the on-disk workflow but in no
  // commit, and the retry then took the already-registered early return and published nothing, so
  // the registration stayed local and unattested while every other clone rejected work on it.
  workflow.lineage ??= {
    schemaVersion: currentSchemaVersion('story-lineage'),
    canonicalBranch: workflow.workItem.branch,
    parentStoryId: workflow.workItem.id,
    childBranches: []
  };
  workflow.lineage.childBranches ??= [];
  workflow.lineage.childBranches.push(record);
  workflow.history.push({
    at: record.registeredAt,
    actor: actor.email?.toLowerCase() ?? actor.name,
    event: 'child_branch_attached',
    phase: workflow.currentPhase,
    detail: `${current} -> ${workflow.workItem.id}`
  });
  const publication = await commitAndPublish(
    root,
    config,
    workflow,
    { type: 'branch-linked', payload: { childBranch: current } },
    `[${workflow.workItem.id}][branch:attach] ${current}`,
    [],
    { beforeStateWrite: async () => { await saveStoryDraft(root, config, workflow); } }
  );
  await preserveAgent(root, config, workflow);
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
  const name = validateBranchName(root, branchName, config);
  if (workflowBranchAllowed(workflow, name)) throw new SingularityFlowError(`Branch '${name}' is already registered for Story '${parentStoryId}'.`);
  const canonical = branch(root);
  const switched = run('git', ['switch', '-c', name], { cwd: root, allowFailure: true });
  if (switched.status !== 0) throw new SingularityFlowError(`Unable to create child branch '${name}': ${(switched.stderr || switched.stdout).trim()}`);
  try {
    return await attachStoryBranch(root, config, { parentStoryId, branchName: name });
  } catch (error) {
    // The ref moves before the transaction opens and nothing else unwinds it. Without this, a failed
    // attach left the caller on a branch that existed in the on-disk workflow but in no commit — and
    // retrying was worse than useless: `attachStoryBranch` takes its already-registered early return,
    // reports success, and publishes nothing, so the registration stays local and unattested forever
    // while every other clone refuses work on that branch.
    run('git', ['switch', canonical], { cwd: root, allowFailure: true });
    run('git', ['branch', '-D', name], { cwd: root, allowFailure: true });
    throw error;
  }
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
  const submittedCommit = phase.generationCommit ?? head(root);
  const artifacts = [];
  const references = [];
  const harnessPolicy = workflow.resolution?.harnessImports ?? config.harnessImports ?? { mode: 'off' };
  const governedItemPrefix = `${path.relative(root, workDir(root, config, workflow.workItem.id)).replaceAll('\\', '/')}/`;
  for (const item of phase.artifacts ?? []) {
    const artifact = {
      path: item.path,
      kind: item.kind ?? null,
      sha256: item.sha256 ?? null,
      size: item.size ?? null
    };
    // Source and test files may be phase artifacts, but model-facing reference handles are
    // deliberately confined to the governed subject namespace. Those repository files remain in
    // the review packet with their exact hashes; the phase's governed report/specification is the
    // safe, immutable reference a later agent may expand.
    if (harnessPolicy.mode !== 'off' && item.path.startsWith(governedItemPrefix)) {
      const revision = referenceRevision(root, submittedCommit, item.path);
      const registered = await registerReference(root, {
        repository: { id: config.repository?.id ?? path.basename(root), origin: config.repository?.origin ?? repositoryOrigin(root) },
        subject: {
          kind: 'story', id: workflow.workItem.id,
          branch: workflow.workItem.branch,
          subjectRevision: phase.generation
        },
        artifact: {
          phaseId: phase.id, generation: phase.generation,
          outputId: item.kind ?? path.basename(item.path, path.extname(item.path)),
          path: item.path, mediaType: mediaTypeFor(item.path)
        },
        revision,
        visibility: 'model',
        // Submission adds approval metadata before this packet is assembled. The governed
        // evidence is the immutable generation artifact, not that prospective submit commit.
        allowHistorical: true
      });
      artifact.sha256 = revision.sha256;
      artifact.size = revision.bytes;
      artifact.reference = { handle: registered.handle, recordHash: registered.recordHash };
      references.push({ handle: registered.handle, recordHash: registered.recordHash, purpose: 'review-evidence', required: true });
    }
    artifacts.push(artifact);
  }
  const visualAssurance = phase.id === 'visual-verification' ? {
    coverage: await evaluateVisualCoverage(root, workflow),
    comparisons: await listVisualComparisons(root, workflow)
  } : null;
  const base = {
    schemaVersion: currentSchemaVersion('story-submission-packet'),
    workId: workflow.workItem.id,
    epicId: workflow.lineage?.epicId ?? null,
    planId: workflow.lineage?.planId ?? null,
    jiraIssueId: workflow.lineage?.jiraIssueId ?? null,
    initialJiraKey: workflow.lineage?.initialJiraKey ?? null,
    currentJiraKey: workflow.lineage?.currentJiraKey ?? null,
    canonicalBranch: workflow.lineage?.canonicalBranch ?? workflow.workItem.branch,
    submittedBranch,
    submissionCommit: submittedCommit,
    sourceCommit: submittedCommit,
    sourceTreeSha256: await sourceTreeHash(root),
    phase: phase.id,
    generation: phase.generation,
    authorship: [...(phase.authorship ?? [])].reverse().find((record) => record.generation === phase.generation) ?? { producer: 'legacy-unspecified', channel: 'legacy' },
    artifacts,
    references,
    agentBriefs: (phase.agentBriefs ?? []).filter((brief) => brief.generation === phase.generation).map((brief) => ({
      consumerPhase: brief.consumerPhase,
      status: brief.status,
      path: brief.path,
      renderedPath: brief.renderedPath,
      sourceSha256: brief.sourceSha256,
      renderedSha256: brief.renderedSha256,
      integritySha256: brief.integritySha256
    })),
    checks: phase.checks ?? [],
    usage: phase.usage ?? [],
    approvals: phase.approvals?.filter((entry) => !entry.invalidatedAt) ?? [],
    visualAssurance,
    submittedAt: phase.submittedAt ?? nowIso(),
    submittedBy: identity(root),
    status: phase.status === 'approved'
      ? phase.approvalPolicy?.mode === 'policy'
        ? 'policy_waived'
        : 'complete_no_review'
      : 'awaiting_review'
  };
  const packetSha256 = hash(base);
  const packet = { ...base, packetSha256 };
  const file = path.join(workDir(root, config, workflow.workItem.id), 'submissions', phase.id, `${packetSha256}.json`);
  await writeJson(file, packet);
  workflow.lineage ??= { schemaVersion: currentSchemaVersion('story-lineage'), canonicalBranch: workflow.workItem.branch, parentStoryId: workflow.workItem.id, childBranches: [] };
  workflow.lineage.submissions ??= [];
  workflow.lineage.submissions.push({
    packetSha256,
    phase: phase.id,
    generation: phase.generation,
    branch: submittedBranch,
    sourceTreeSha256: base.sourceTreeSha256,
    path: path.relative(root, file).split(path.sep).join('/'),
    submittedAt: base.submittedAt,
    projection: structuredClone(base)
  });
  await saveStoryDraft(root, config, workflow);
  return { packet, path: path.relative(root, file).split(path.sep).join('/') };
}

export async function readStoryReviewPacket(root, config, workflow, packetSha256 = null) {
  const selected = packetSha256
    ? workflow.lineage?.submissions?.find((entry) => entry.packetSha256 === packetSha256)
    : workflow.lineage?.submissions?.at(-1);
  if (!selected) throw new SingularityFlowError(`Story '${workflow.workItem.id}' has no submitted review packet.`);
  const packet = readRecord('story-submission-packet', await readFile(path.join(root, selected.path))).record;
  const { packetSha256: provided, ...base } = packet;
  if (provided !== selected.packetSha256 || hash(base) !== provided) throw new SingularityFlowError('Story review packet hash is invalid.');
  return packet;
}

export async function finalizeStoryDelivery(root, config, workflow, { persist = true } = {}) {
  const incomplete = workflow.phaseOrder
    .map((phaseId) => workflow.phases[phaseId])
    .filter((phase) => phase.status !== 'approved');
  if (workflow.currentPhase || incomplete.length) {
    throw new SingularityFlowError(
      `Story '${workflow.workItem.id}' cannot be finalized: complete and approve every configured phase first. `
      + `Incomplete: ${incomplete.map((phase) => `${phase.id}=${phase.status}`).join(', ') || workflow.currentPhase}.`
    );
  }
  if (changes(root).trim()) {
    throw new SingularityFlowError('Story finalization requires a clean working tree so the packet can bind one exact source commit.');
  }

  const seedPath = path.join(root, 'singularity', 'seeds', `${workflow.workItem.id}.yml`);
  let seed = null;
  try {
    const YAML = (await import('yaml')).default;
    seed = YAML.parse(await readFile(seedPath, 'utf8'));
  } catch {
    throw new SingularityFlowError(
      `Story '${workflow.workItem.id}' has no readable governed seed at singularity/seeds/${workflow.workItem.id}.yml. `
      + 'Fetch or synchronize the canonical Story branch before finalizing.'
    );
  }
  if (seed?.story?.workId !== workflow.workItem.id) {
    throw new SingularityFlowError(`Story seed belongs to '${seed?.story?.workId ?? 'unknown'}', not '${workflow.workItem.id}'.`);
  }

  const governedContext = [];
  for (const record of seed.governedContext ?? []) {
    const file = path.join(root, record.path);
    const current = await snapshot(file);
    if (!current.exists || current.sha256 !== record.sha256) {
      throw new SingularityFlowError(
        `Governed Story input '${record.id}' does not match its approved hash. `
        + `Expected ${record.sha256}; found ${current.exists ? current.sha256 : 'missing'}. Re-fetch the Story branch.`
      );
    }
    governedContext.push({ ...record, verifiedSha256: current.sha256 });
  }
  const phases = workflow.phaseOrder.map((phaseId) => {
    const phase = workflow.phases[phaseId];
    return {
      id: phase.id,
      generation: phase.generation,
      status: phase.status,
      generationCommit: phase.generationCommit ?? null,
      approvalCommit: phase.approvalCommit ?? null,
      artifacts: (phase.artifacts ?? []).map((item) => ({
        path: item.path,
        sha256: item.sha256 ?? null,
        size: item.size ?? null
      })),
      checks: phase.checks ?? [],
      usage: phase.usage ?? [],
      approvals: (phase.approvals ?? []).filter((item) => !item.invalidatedAt)
    };
  });
  const reviewPacket = [...(workflow.lineage?.submissions ?? [])]
    .reverse()
    .find((entry) => entry.phase === 'conformance')
    ?? workflow.lineage?.submissions?.at(-1)
    ?? null;
  if (!reviewPacket) {
    throw new SingularityFlowError(
      `Story '${workflow.workItem.id}' has no published phase review packet. Submit the final configured phase before finalizing.`
    );
  }
  // Receipt bytes must be reproducible from governed evidence. The publication
  // event records when finalization was requested; the packet uses the final
  // approval timestamp so repeating finalization over the same source and phase
  // evidence does not mint a different hash merely because wall-clock time moved.
  const completedAt = [...(workflow.history ?? [])].reverse()
    .find((entry) => ['phase_approved', 'phase_self_approved'].includes(entry.event))?.at
    ?? workflow.workItem.createdAt;
  const base = {
    schemaVersion: currentSchemaVersion('story-finalization-packet'),
    status: 'finalized_for_review',
    workId: workflow.workItem.id,
    epicId: workflow.lineage?.epicId ?? seed.initiative?.id ?? null,
    planId: workflow.lineage?.planId ?? seed.story?.planId ?? null,
    jiraIssueId: workflow.lineage?.jiraIssueId ?? seed.story?.jiraIssueId ?? null,
    jiraKey: workflow.lineage?.currentJiraKey ?? seed.story?.jiraKey ?? workflow.workItem.id,
    canonicalBranch: workflow.lineage?.canonicalBranch ?? workflow.workItem.branch,
    submittedBranch: workflowPublicationBranch(root, workflow),
    sourceCommit: head(root),
    sourceTreeSha256: await sourceTreeHash(root),
    reviewPacketSha256: reviewPacket.packetSha256,
    governedContext,
    phases,
    finalizedAt: completedAt,
    finalizedBy: identity(root)
  };
  const packetSha256 = hash(base);
  const packet = { ...base, packetSha256 };
  const file = path.join(workDir(root, config, workflow.workItem.id), 'finalizations', `${packetSha256}.json`);
  await writeJson(file, packet);
  workflow.lineage ??= {
    schemaVersion: currentSchemaVersion('story-lineage'),
    canonicalBranch: workflow.workItem.branch,
    parentStoryId: workflow.workItem.id,
    childBranches: []
  };
  workflow.lineage.finalizations ??= [];
  workflow.lineage.finalizations.push({
    packetSha256,
    reviewPacketSha256: reviewPacket.packetSha256,
    sourceCommit: base.sourceCommit,
    sourceTreeSha256: base.sourceTreeSha256,
    branch: base.submittedBranch,
    path: path.relative(root, file).split(path.sep).join('/'),
    finalizedAt: base.finalizedAt,
    projection: structuredClone(base)
  });
  workflow.lineage.deliveryStatus = 'finalized_for_review';
  workflow.history.push({
    at: base.finalizedAt,
    actor: base.finalizedBy.email?.toLowerCase() ?? base.finalizedBy.name,
    event: 'story_finalized_for_review',
    phase: null,
    detail: packetSha256
  });
  const impact = await createImpactReceipt(root, config, workflow, packet);
  // Standalone callers retain the draft-writing compatibility behavior. Governed
  // lifecycle callers pass persist:false and invoke this function from
  // StoryStateStore.transact(), so every packet/evidence/state write is covered by
  // the publication lock, recovery journal, rollback, commit, and push boundary.
  if (persist) await saveStoryDraft(root, config, workflow);
  return {
    packet,
    path: path.relative(root, file).split(path.sep).join('/'),
    impact
  };
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
