/** Shared Story-start context; no dispatcher, model invocation, or lifecycle policy changes. */
import { sessionRepositoryAuthority } from './session-repository-authority.mjs';
import { sessionDiscoveryConfiguration } from './session-discovery-configuration.mjs';
import { activatePhaseAgent, summary } from '../kernel.mjs';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { SingularityFlowError, optionBoolean, optionString, requirePositional, run, secureRepositoryPath } from '../../util.mjs';
import { assertClean, branch, checkout, fetchRemote, fileAtRef, localBranches, refExists, remoteBranches, repoRoot } from '../../git.mjs';
import { buildRepositorySubjectIndexFromRefs, resolveContext } from '../../repository-subject-index.mjs';
import { currentPhase } from '../../phase-generation.mjs';
import { resolveWorkItem, validateId } from '../../state-stores.mjs';
import { phasePreparationCommandLines } from '../../phase-preparation-guidance.mjs';
import { loadDefinition, resolveWorkType, WORKFLOW_PATH } from '../../config.mjs';
import { readRecord } from '../../schema-migrations.mjs';
import { loadAcceptedStoryExecution } from '../../accepted-story-execution.mjs';
import { CONFIGURATION_SOURCE_PATH, readConfigurationSource } from '../../configuration-branch.mjs';
import { activateWorkspaceStoryContext, activeWorkspaceFile, workspaceRegistryFile } from '../../workspace-context.mjs';
import { withApprovedConfigurationRead } from '../../approved-configuration-reader.mjs';
import { resolveEffectiveCapabilityPolicy } from '../../capabilities.mjs';
import { applyCapabilityPolicyToWorkResolution, validateConfigurationSnapshotCapabilities } from '../../capability-context.mjs';
import { commandResult, effects, succeeded } from '../../narration/command-result.mjs';
import { emitCommandResult } from '../../narration/emit.mjs';

/**
 * Refuse to cut a Story branch from an application branch that does not carry the governed
 * definition and has no approved configuration authority to materialize.
 *
 * Approved configuration belongs to `sflow/config`, not application main. When that authority is
 * available, start deliberately cuts the Story from the application base and materializes the exact
 * approved revision into it. This guard is therefore only for the older branch-local case where the
 * current checkout has governance but no approved configuration authority exists anywhere.
 */
export function assertBaseCarriesGovernance(root, {
  config, branchName, base, remote, currentBranch, configurationRemote,
  allowExistingStoryBranch = true
}) {
  // Reached only when this repository carries its own governance in the working tree — the `init`
  // path. A bootstrapped repository has no local definition at all: it resolves configuration from
  // the `sflow/config` branch and materializes it into the Story branch at start, so `config` is
  // null here and the guard correctly does nothing.
  // Only meaningful when the definition is in this working tree. A repository governed from the
  // workspace lead's `sflow/config` branch legitimately has no definition on its own base branch.
  if (configurationRemote || !config || !base) return;
  if (allowExistingStoryBranch && refExists(root, `refs/heads/${branchName}`)) return;
  const baseRef = [`refs/heads/${base}`, `refs/remotes/${remote}/${base}`]
    .find((ref) => refExists(root, ref));
  if (!baseRef || fileAtRef(root, baseRef, WORKFLOW_PATH) !== null) return;
  throw new SingularityFlowError(
    `Base branch '${base}' does not carry ${WORKFLOW_PATH} yet, so a Story branch cut from it would `
    + `lose the governed definition currently on '${currentBranch}'.\n`
    + `Publish the reviewed governance to 'sflow/config' first, then run this again. `
    + `The application branch '${base}' does not need to change. Nothing was changed.`
  );
}

export async function durableLocalStoryOnBranch(root, workId, branchName) {
  const ref = `refs/heads/${branchName}`;
  if (!refExists(root, ref)) return null;
  // The ref index reads workItemRoot from the branch's own pinned workflow definition. This
  // distinguishes a durable Story from an Epic-materialized seed or an ungoverned name collision
  // without consulting today's FOS/configuration authority.
  const index = await buildRepositorySubjectIndexFromRefs(root, {
    definition: {}, refs: [{ branch: branchName, ref }]
  });
  return resolveContext(index, { reference: workId, kind: 'story', required: false });
}

export function testRecoveryIntakePhases(definition, workType, snapshot, capabilityId, legacyCapabilityEvidence) {
  const resolved = resolveWorkType(definition, workType);
  const retained = validateConfigurationSnapshotCapabilities(snapshot, { capabilityId });
  const capability = retained?.definition && retained.capabilityId
    ? { id: retained.capabilityId, policy: resolveEffectiveCapabilityPolicy(retained.definition, retained.capabilityId).policy }
    : legacyCapabilityEvidence?.capability ?? null;
  return applyCapabilityPolicyToWorkResolution(resolved, capability).phases;
}

export async function resumeCommand(positionals, options) {
  const reference = requirePositional(positionals, 1, 'work ID or branch reference');
  const root = repoRoot();
  const json = optionBoolean(options, 'json');
  const discovery = await withApprovedConfigurationRead(
    root, async () => sessionDiscoveryConfiguration(
      root, await sessionRepositoryAuthority(root), { storyBootstrap: true }
    )
  );
  const initialConfig = discovery.definition;
  const fetch = optionBoolean(options, 'fetch');
  const remote = discovery.remote;
  if (fetch) await fetchRemote(root, remote);
  const refs = [
    { branch: branch(root), ref: branch(root) },
    ...localBranches(root).map((branchName) => ({ branch: branchName, ref: branchName })),
    ...(fetch ? remoteBranches(root, remote).map((branchName) => ({ branch: branchName, ref: `${remote}/${branchName}` })) : [])
  ];
  const refIndex = await buildRepositorySubjectIndexFromRefs(root, { definition: initialConfig, refs });
  const refSubject = resolveContext(refIndex, { reference, kind: 'story', required: false });
  const resolved = refSubject
    ? { workId: refSubject.id, branch: refSubject.canonicalBranch, selectedBranch: refSubject.selectedBranch, workflow: refSubject.state, source: refSubject.source }
    : await resolveWorkItem(root, initialConfig, reference, { mutation: true });
  const targetBranch = resolved.selectedBranch ?? resolved.branch;
  // An isolated Story branch is already checked out in its managed worktree. Git correctly
  // refuses to check the same branch out in the launch clone, so resume must enter the checkout
  // that owns the branch instead of mutating (or requiring a clean) unrelated launch work.
  const { storyWorktreeForBranch } = await import('../../story-worktree.mjs');
  const managedWorktree = storyWorktreeForBranch(root, targetBranch);
  const executionRoot = managedWorktree?.repositoryPath ?? root;
  if (branch(executionRoot) !== targetBranch && !optionBoolean(options, 'allow-dirty')) {
    assertClean(executionRoot);
  }
  // Discovery has already fetched every remote ref. Reuse that exact observation for the local
  // fast-forward; asking `checkout` to fetch again used to add a second fetch and then a pull.
  await checkout(executionRoot, targetBranch, {
    base: initialConfig.defaultBaseBranch, fetch: false, fetched: fetch, existingOnly: true, remote
  });
  const accepted = await loadAcceptedStoryExecution(executionRoot, resolved.workId);
  const config = accepted.definition;
  const workflow = accepted.workflow;
  validateId(config, resolved.workId);
  const session = await activatePhaseAgent(
    executionRoot, config, resolved.workId, currentPhase(workflow), optionString(options, 'agent') ?? null,
    workflow
  );
  try {
    await activateWorkspaceStoryContext(
      activeWorkspaceFile(), workspaceRegistryFile(), executionRoot,
      { storyId: resolved.workId, selectionSource: 'story-resume' }
    );
  } catch (error) {
    // The durable Story and phase session are already selected. A stale optional workspace
    // navigation record must not turn that success into a second lifecycle attempt.
    console.warn(`Warning: Story '${resolved.workId}' resumed, but its active-workspace selection was not updated: ${error.message}`);
  }
  if (!json) {
    summary(workflow);
    console.log(`Active governed agent: ${session.agentLabel ?? session.agent} (${session.agent})`);
  }
  const active = currentPhase(workflow);
  if (active && !json) {
    console.log(`\n${phasePreparationCommandLines(active, 'Run', workflow).join('\n')}`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'resume', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('resume.succeeded', {
      workId: workflow.workItem.id, branch: branch(executionRoot)
    }),
    // Resume may check out a different branch and records the local governed-agent selection.
    effects: effects({ filesChanged: true }),
    data: {
      repositoryPath: executionRoot,
      materialization: managedWorktree ? 'reused-managed-story-worktree' : 'current-checkout',
      ...(managedWorktree ? { sourceRepositoryPath: root } : {})
    }
  }), { json, postState: workflow });
}

/**
 * A configuration-source file is a Story pin only when the current canonical Story binds the exact
 * verified asset set. The file is intentionally self-describing, so merely validating its internal
 * hashes cannot prove that it belongs to this branch: copying the file and matching assets onto an
 * application branch otherwise suppresses the doctor's authority refresh indefinitely.
 */
export async function capabilityDoctorStoryPin(root) {
  const sourcePresent = existsSync(path.join(root, CONFIGURATION_SOURCE_PATH));
  let currentBranch = null;
  let workflow = null;
  let workflowError = null;
  try {
    currentBranch = branch(root);
  } catch { /* A detached/non-Git checkout cannot prove canonical Story identity. */ }
  const roots = new Set(['singularity/work-items']);
  try {
    // This is a location hint, never a validated definition or policy decision. Parsing the whole
    // agent/template catalog here duplicated the subsequent exact authority read on every start.
    // Containment, canonical Story identity and the exact pin are still proved below; tracked
    // discovery also finds a custom-root Story when this YAML is absent or malformed.
    const raw = YAML.parse(await readFile(path.join(root, WORKFLOW_PATH), 'utf8'));
    if (typeof raw?.workItemRoot === 'string' && raw.workItemRoot.trim()) roots.add(raw.workItemRoot.trim());
  } catch { /* Tracked workflow discovery below still catches a custom-root Story. */ }
  const suffix = currentBranch ? `/${currentBranch}/workflow.json` : null;
  const tracked = run('git', ['ls-files', '-z', '--', '*workflow.json'], {
    cwd: root, allowFailure: true
  });
  if (suffix && tracked.status === 0) {
    for (const relative of tracked.stdout.split('\0').filter(Boolean)) {
      if (relative.endsWith(suffix)) roots.add(relative.slice(0, -suffix.length));
    }
  }
  const candidates = [];
  if (currentBranch) {
    for (const workItemRoot of roots) {
      const relative = path.posix.join(workItemRoot, currentBranch, 'workflow.json');
      try {
        const located = await secureRepositoryPath(root, relative, {
          label: 'Current Story workflow', type: 'file'
        });
        if (located.exists) candidates.push({ relative, absolute: located.absolute });
      } catch {
        // An invalid root hint is configuration damage, but without a file at that location it is
        // not evidence that this ordinary branch is a Story.
      }
    }
  }
  if (candidates.length > 1) {
    workflowError = new SingularityFlowError(
      `Current branch '${currentBranch}' has multiple canonical Story records: `
      + candidates.map((entry) => entry.relative).sort().join(', ')
    );
  } else if (candidates.length === 1) {
    try {
      workflow = readRecord('story-workflow', await readFile(candidates[0].absolute)).record;
    } catch (error) {
      workflowError = error;
    }
  }
  // Presence is structural: a workflow at this branch's canonical path remains a Story that must
  // be reported as damaged even when its own branch fields are the damaged bytes. Identity is
  // validated separately below; using it to decide presence let remote status hide corruption.
  const storyPresent = Boolean(workflowError || workflow);
  if (!sourcePresent) {
    return storyPresent
      ? {
          present: false, storyPresent: true, valid: false, source: null, workflow,
          error: workflowError ?? new SingularityFlowError(
            `Canonical Story '${currentBranch}' is missing ${CONFIGURATION_SOURCE_PATH}.`
          )
        }
      : { present: false, storyPresent: false, valid: false, source: null, workflow: null, error: null };
  }
  try {
    if (workflowError) throw workflowError;
    const source = await readConfigurationSource(root, { verify: true });
    if (!storyPresent) {
      throw new SingularityFlowError(
        `${CONFIGURATION_SOURCE_PATH} is not bound to a governed Story on branch '${currentBranch}'.`
      );
    }
    const pinned = workflow?.resolution?.configurationSource;
    if (workflow?.workItem?.branch !== currentBranch
        || workflow?.lineage?.canonicalBranch !== currentBranch
        || pinned?.branch !== source.branch
        || pinned?.repository !== source.repository
        || pinned?.commit !== source.commit
        || !pinned?.filesSha256
        || pinned.filesSha256 !== source.filesSha256) {
      throw new SingularityFlowError(
        `${CONFIGURATION_SOURCE_PATH} is not bound to the current branch's canonical Story resolution.`
      );
    }
    return { present: true, storyPresent: true, valid: true, source, workflow, error: null };
  } catch (error) {
    return { present: true, storyPresent, valid: false, source: null, workflow, error };
  }
}
