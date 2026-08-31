import path from 'node:path';
import { assertPlannedClaimsReady, loadDefinition, resolveWorkType } from './config.mjs';
import {
  assertClean,
  branch,
  checkout,
  fastForwardTo,
  fetchRemote,
  identity,
  preflightPushBranch,
  refExists,
  refHead,
  repoRoot,
  head
} from './git.mjs';
import {
  capabilityPublicationPlan, preflightStoryRepositories, prepareCapabilityRepositories,
  preflightIncludesRepository, preflightPublicationAuthority, storyBaseForRepository
} from './capability-start.mjs';
import { configuredRemoteAuthority } from './git-remote-diagnostics.mjs';
import { loadCopilotSession, loadSession, setAgentSession } from './session.mjs';
import {
  commitAndPublish,
  createWorkflow,
  loadWorkflow,
  validateId,
  workDirRelative
} from './state-stores.mjs';
import { SingularityFlowError } from './util.mjs';
import { normalizeMcpTargetOrigin } from './mcp-target.mjs';
import { writeReturnLocator } from './return-locator.mjs';
import { pinAcceptedChangeFlightPlan } from './change-flight-plan.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { pinAcceptedAutoPlan } from './auto/auto-origin.mjs';
import { scheduleStoryStartAstWarm } from './ast-story-start-warm.mjs';
import { runDraftTransaction } from './draft-unit-of-work.mjs';
import {
  captureConfigurationState, CONFIGURATION_BRANCH, loadStoryConfigurationSnapshot,
  materializeConfigurationSnapshot, readConfigurationSource, resolveNewStoryConfigurationAuthority
} from './configuration-branch.mjs';
import { publishCurrentIdentityToConfiguration } from './configuration-people.mjs';
import {
  publishCapabilityRepositoriesDurably, retainCapabilityPublicationRecovery
} from './capability-publication-recovery.mjs';
import {
  beginStoryStartJournal, clearStoryStartJournal, recoverStoryStart,
  serializeConfigurationRestorePoint, updateStoryStartJournal
} from './story-start-journal.mjs';
import { publishInitialStoryDocuments } from './story-start-documents.mjs';
import { validateConfigurationSnapshotCapabilities } from './capability-context.mjs';

function lines(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

export function manualStorySource(id, input = {}) {
  const title = String(input.title ?? '').trim();
  if (!title) throw new SingularityFlowError('Enter a Story title before starting.');
  return {
    type: 'manual',
    id,
    key: null,
    url: null,
    title,
    user: String(input.user ?? input.audience ?? '').trim(),
    description: String(input.description ?? input.problem ?? '').trim(),
    desiredOutcome: String(input.desiredOutcome ?? input.outcome ?? '').trim(),
    scope: {
      in: lines(input.inScope),
      out: lines(input.outOfScope)
    },
    stakeholders: lines(input.stakeholders),
    urgency: String(input.urgency ?? '').trim(),
    constraints: lines(input.constraints),
    dependencies: lines(input.dependencies),
    acceptanceCriteria: lines(input.acceptanceCriteria),
    risks: lines(input.risks),
    notes: String(input.notes ?? '').trim(),
    epicId: String(input.parentEpicId ?? '').trim() || null
  };
}

function validateStorySource(source, id) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new SingularityFlowError('Story intake requires a source object.');
  }
  if (!String(source.title ?? '').trim()) {
    throw new SingularityFlowError('Story intake requires a title.');
  }
  return {
    ...structuredClone(source),
    type: source.type ?? 'manual',
    id: source.id ?? id,
    title: String(source.title).trim()
  };
}

function assertSafeStoryId(id) {
  if (!id || id === '.' || id === '..' || String(id).includes('/') || String(id).includes('\\')) {
    throw new SingularityFlowError('Work ID must be one safe identifier without slashes.');
  }
}

async function resumePinnedLocalStory(root, { id, agent = null } = {}) {
  const originalBranch = branch(root);
  assertClean(root);
  const checkoutMode = checkout(root, id, { existingOnly: true, fetch: false });
  let definition;
  let workflow;
  try {
    const source = await readConfigurationSource(root, { verify: true });
    if (!source) {
      throw new SingularityFlowError('singularity/configuration-source.json is missing.');
    }
    definition = await loadDefinition(root);
    validateId(definition, id);
    workflow = await loadWorkflow(root, definition, id);
    const pinned = workflow?.resolution?.configurationSource;
    if (workflow?.workItem?.id !== id
        || workflow?.workItem?.branch !== id
        || workflow?.lineage?.canonicalBranch !== id
        || pinned?.branch !== source.branch
        || pinned?.repository !== source.repository
        || pinned?.commit !== source.commit
        || !pinned?.filesSha256
        || pinned.filesSha256 !== source.filesSha256) {
      throw new SingularityFlowError(
        'The local configuration source is not bound to this Story resolution.'
      );
    }
  } catch (error) {
    if (originalBranch !== id) {
      try { checkout(root, originalBranch, { existingOnly: true, fetch: false }); }
      catch (restoreError) {
        throw new SingularityFlowError(
          `Story '${id}' has an invalid immutable configuration pin: ${error.message} `
          + `Restoring branch '${originalBranch}' also failed: ${restoreError.message}`,
          { code: 'STORY_CONFIGURATION_PIN_INVALID', cause: error }
        );
      }
    }
    throw new SingularityFlowError(
      `Story '${id}' has an invalid immutable configuration pin: ${error.message}`,
      { code: 'STORY_CONFIGURATION_PIN_INVALID', cause: error }
    );
  }
  const actor = identity(root);
  const resumedAgent = agent || workflow.phases?.[workflow.currentPhase]?.defaultAgent;
  if (!definition.agents?.[resumedAgent]) {
    throw new SingularityFlowError(`Story phase '${workflow.currentPhase}' has no valid governed agent.`);
  }
  await setAgentSession(root, definition, actor, resumedAgent, id, {
    phaseId: workflow.currentPhase,
    source: agent ? 'explicit-override' : 'phase-default'
  });
  return {
    workId: id,
    resumed: true,
    checkoutMode,
    branch: id,
    workflow
  };
}

async function currentPinnedConfigurationRemote(root) {
  const current = branch(root);
  if (!current) return null;
  try {
    const source = await readConfigurationSource(root, { verify: true });
    if (!source) return null;
    const definition = await loadDefinition(root);
    validateId(definition, current);
    const workflow = await loadWorkflow(root, definition, current);
    const pinned = workflow?.resolution?.configurationSource;
    if (workflow?.workItem?.id !== current
        || workflow?.workItem?.branch !== current
        || workflow?.lineage?.canonicalBranch !== current
        || pinned?.branch !== source.branch
        || pinned?.repository !== source.repository
        || pinned?.commit !== source.commit
        || !pinned?.filesSha256
        || pinned.filesSha256 !== source.filesSha256) return null;
    return source.repository;
  } catch {
    // A copied, corrupt, or unbound source record is not an authority candidate. Current workspace
    // or raw-origin discovery still gets its normal fail-closed behavior.
    return null;
  }
}

/**
 * Desktop-safe Story start path.
 *
 * The UI supplies an explicit workflow choice. Its first phase selects the governed
 * agent deterministically, so this function never prompts or treats a role as user identity.
 * It persists exactly the same workflow,
 * source, document, commit, and publication records as the CLI start command.
 */
export async function startStory(root, {
  id,
  source,
  workType,
  agent,
  baseBranch = null,
  capabilityId = null,
  targetUrl = null,
  files = [],
  urls = [],
  expectedBaseCommit = null,
  flightPlan = null,
  auto = null,
  astWarmLauncher = undefined,
  afterPublicationAuthorityCapture = null
} = {}) {
  assertSafeStoryId(id);
  await recoverStoryStart(root, id);
  const localExisted = refExists(root, `refs/heads/${id}`);
  // A local Story is already governed by the exact configuration materialized when it started.
  // Resume it without consulting today's workspace authority or Git network, then verify that its
  // full asset catalog and workflow bind the same immutable pin before opening a session.
  if (localExisted) return resumePinnedLocalStory(root, { id, agent });

  let checkoutDefinition = null;
  let definitionError = null;
  try { checkoutDefinition = await loadDefinition(root); }
  catch (error) { definitionError = error; }
  const pinnedConfigurationRemote = await currentPinnedConfigurationRemote(root);
  // A local workflow is a compatibility fallback only after every higher-priority remote has
  // positively reported no authority. Transport, permission, workspace, and mirror-integrity
  // failures must remain refusals; otherwise an old checkout silently governs new work. In
  // particular, an older Story's workflow may not redirect authority discovery through git.remote.
  let configurationAuthority = await resolveNewStoryConfigurationAuthority(root, {
    pinnedRemote: pinnedConfigurationRemote
  });
  let approvedConfigurationSnapshot = configurationAuthority
    ? await loadStoryConfigurationSnapshot(configurationAuthority)
    : null;
  let initialDefinition = approvedConfigurationSnapshot?.definition ?? checkoutDefinition;
  if (!initialDefinition) throw definitionError;
  validateId(initialDefinition, id);
  const normalizedSource = validateStorySource(source, id);
  const actor = identity(root);
  let remote = initialDefinition.git?.remote ?? 'origin';

  assertClean(root);
  const initialFetchAuthority = configuredRemoteAuthority(root, remote, { direction: 'fetch' });
  if (!initialFetchAuthority.url) {
    throw new SingularityFlowError(
      `Story remote '${remote}' has no credential-free fetch authority. Nothing was changed.`,
      { code: 'STORY_REMOTE_UNREACHABLE' }
    );
  }
  fetchRemote(root, remote, { transportRemote: initialFetchAuthority.url });
  const remoteExisted = refExists(root, `refs/remotes/${remote}/${id}`);
  const existed = localExisted || remoteExisted;
  // Reject incomplete POC intake while the caller is still on its original branch. Validation
  // after checkout remains below because the selected remote base owns the definitive workflow.
  const preflightTargetOrigin = normalizeMcpTargetOrigin(targetUrl ?? normalizedSource.targetOrigin, {
    required: !existed && workType === 'poc-workflow',
    label: 'POC target URL'
  });
  if (preflightTargetOrigin) normalizedSource.targetOrigin = preflightTargetOrigin;
  let storyBase = null;
  let baseCommit = null;
  let capabilityRepositoriesPrepared = null;
  let capabilityPublications = [];
  let publicationAuthority = null;
  let startJournal = null;
  let configurationSnapshot = null;
  let workflow = null;
  let publication = null;
  let capabilityPublication = { published: [], pending: [], error: null };
  let capabilityTailStaged = false;
  let checkoutMode;
  try {
  if (existed) {
    checkoutMode = checkout(root, id, {
      base: initialDefinition.defaultBaseBranch,
      fetch: remoteExisted,
      existingOnly: true,
      remote
    });
  } else {
    storyBase = await storyBaseForRepository(root, {
      values: baseBranch ? [baseBranch] : [],
      interactive: false,
      remote,
      defaultBranch: initialDefinition.defaultBaseBranch,
      capabilityId,
      configurationSnapshot: approvedConfigurationSnapshot
    });
    const selectedCapabilityId = capabilityId ?? storyBase.capability ?? null;
    // Validate the exact retained catalog and selected capability before automatic enrollment is
    // allowed to mutate the shared configuration authority. A refused Story start must not leave an
    // otherwise unrelated approval-membership commit behind.
    validateConfigurationSnapshotCapabilities(approvedConfigurationSnapshot, {
      capabilityId: selectedCapabilityId
    });
    if (configurationAuthority?.branch === CONFIGURATION_BRANCH
        && initialDefinition.approvalSecurity?.autoEnrollNewIdentities !== false) {
      const enrollment = await publishCurrentIdentityToConfiguration(root, {
        target: '*', automatic: true
      });
      if (enrollment.changed && !enrollment.pushed) {
        throw new SingularityFlowError(
          `Automatic approval enrollment is pending publication. ${enrollment.nextAction?.command
            ? `Run: ${enrollment.nextAction.command}`
            : 'Publish the retained configuration commit and start again.'}`,
          { code: 'CONFIGURATION_ENROLLMENT_PENDING' }
        );
      }
      if (enrollment.changed) {
        configurationAuthority = await resolveNewStoryConfigurationAuthority(root, {
          pinnedRemote: pinnedConfigurationRemote
        });
        if (!configurationAuthority || configurationAuthority.commit !== enrollment.commit) {
          throw new SingularityFlowError(
            'Approved configuration changed again after automatic enrollment. Refresh Story intake and retry; nothing was changed.',
            { code: 'STORY_CONFIGURATION_AUTHORITY_STALE' }
          );
        }
        approvedConfigurationSnapshot = await loadStoryConfigurationSnapshot(configurationAuthority);
        initialDefinition = approvedConfigurationSnapshot.definition;
        validateConfigurationSnapshotCapabilities(approvedConfigurationSnapshot, {
          capabilityId: selectedCapabilityId
        });
      }
    }
    const publishRequired = (initialDefinition.git?.publish ?? 'required') !== 'off';
    const capabilityPreflight = storyBase.scope === 'capability'
      ? await preflightStoryRepositories(storyBase.workspaceRoot, storyBase.plan, id, {
          remote, publishRequired, lifecycleRoot: root, capabilityId: storyBase.capability,
          configurationSnapshot: approvedConfigurationSnapshot
        })
      : null;
    capabilityPublications = capabilityPublicationPlan(capabilityPreflight, root);
    const rootFetchedByCapabilityPreflight = preflightIncludesRepository(capabilityPreflight, root);
    if (rootFetchedByCapabilityPreflight) {
      publicationAuthority = preflightPublicationAuthority(capabilityPreflight, root);
    } else {
      const fetchAuthority = configuredRemoteAuthority(root, remote, { direction: 'fetch' });
      if (!fetchAuthority.url) {
        throw new SingularityFlowError(
          `Story remote '${remote}' has no credential-free fetch authority. Nothing was changed.`,
          { code: 'STORY_REMOTE_UNREACHABLE' }
        );
      }
      fetchRemote(root, remote, { transportRemote: fetchAuthority.url });
      if (publishRequired) publicationAuthority = configuredRemoteAuthority(root, remote);
    }
    if (publishRequired && !publicationAuthority?.url) {
      throw new SingularityFlowError(
        `Story remote '${remote}' has no credential-free push authority. Nothing was changed.`,
        { code: 'STORY_PUBLICATION_REMOTE_MISSING' }
      );
    }
    if (afterPublicationAuthorityCapture) {
      await afterPublicationAuthorityCapture({ authority: publicationAuthority });
    }
    const remoteBaseRef = `refs/remotes/${remote}/${storyBase.localBase}`;
    if (!refExists(root, remoteBaseRef)) {
      throw new SingularityFlowError(
        `Selected base branch '${storyBase.localBase}' is no longer published by remote '${remote}'. Nothing was changed.`,
        { code: 'STORY_BASE_INVALID' }
      );
    }
    baseCommit = refHead(root, remoteBaseRef);
    if (expectedBaseCommit && baseCommit !== expectedBaseCommit) {
      throw new SingularityFlowError(
        `Selected base '${storyBase.localBase}' moved from accepted revision ${expectedBaseCommit.slice(0, 12)} to ${baseCommit.slice(0, 12)}. Nothing was changed.`,
        {
          code: 'CFP_PLAN_STALE',
          details: { expectedBaseCommit, actualBaseCommit: baseCommit, nextAction: `Refresh Change Flight Plan ${flightPlan?.planId ?? ''}.`.trim() }
        }
      );
    }
    if (publishRequired && !capabilityPreflight) {
      const dryRun = preflightPushBranch(root, remote, remoteBaseRef, id, {
        transportRemote: publicationAuthority.url
      });
      if (dryRun.status !== 0) {
        throw new SingularityFlowError(
          `Cannot publish the new Story branch '${id}' to '${remote}'. `
          + `Git reported: ${(dryRun.stderr || dryRun.stdout || 'remote rejected the dry-run push').trim()} Nothing was changed.`,
          { code: 'STORY_PUBLICATION_PREFLIGHT_FAILED' }
        );
      }
    }
    const siblings = storyBase.scope === 'capability'
      ? storyBase.plan.repositories.map((repository) => {
          const target = repoRoot(path.resolve(storyBase.workspaceRoot, repository.path));
          const base = storyBase.plan.resolution.resolved[repository.id];
          const baseRef = `refs/remotes/${remote}/${base.branch}`;
          return {
            repository: repository.id,
            target,
            from: branch(target),
            targetBranchExisted: refExists(target, `refs/heads/${id}`),
            baseCommit: refExists(target, baseRef) ? refHead(target, baseRef) : null
          };
        })
      : [];
    startJournal = await beginStoryStartJournal(root, {
      id,
      targetBranch: id,
      targetBranchExisted: false,
      originalBranch: branch(root),
      originalHead: head(root),
      baseCommit,
      originalSession: await loadSession(root, { required: false }),
      originalCopilotSession: await loadCopilotSession(root),
      siblingRepositories: siblings
    });
    checkoutMode = checkout(root, id, {
      base: storyBase.localBase,
      remote,
      preferRemoteBase: true
    });
    await updateStoryStartJournal(root, id, startJournal.transactionId, {
      stage: 'root-checked-out', createdBranch: true, checkoutMode
    });
    if (storyBase.scope === 'capability') {
      capabilityRepositoriesPrepared = prepareCapabilityRepositories(
        storyBase.workspaceRoot, storyBase.plan, id, { remote, fetched: Boolean(capabilityPreflight) }
      );
      await updateStoryStartJournal(root, id, startJournal.transactionId, {
        stage: 'siblings-prepared', capabilityRepositoriesPrepared
      });
    }
    if (configurationAuthority) {
      const configurationRestorePoint = await captureConfigurationState(root);
      await updateStoryStartJournal(root, id, startJournal.transactionId, {
        stage: 'configuration-captured',
        configurationRestorePoint: serializeConfigurationRestorePoint(configurationRestorePoint)
      });
      configurationSnapshot = await materializeConfigurationSnapshot(root, {
        authority: configurationAuthority,
        snapshot: approvedConfigurationSnapshot,
        remoteName: remote
      });
    }
  }

  // The branch we just materialized is authoritative for new lifecycle configuration. Keeping the
  // definition loaded from the old checkout meant the files came from fresh remote main while the
  // pinned phase graph, agents, templates, and world-model policy came from stale local main.
  const definition = await loadDefinition(root);
  validateId(definition, id);
  if (startJournal) await updateStoryStartJournal(root, id, startJournal.transactionId, {
    stage: 'configuration-ready', workItemRelative: workDirRelative(definition, id)
  });
  if (!definition.workTypes?.[workType]) throw new SingularityFlowError(`Unknown work type '${workType ?? ''}'.`);
  const resolved = assertPlannedClaimsReady(resolveWorkType(definition, workType));
  const targetOrigin = normalizeMcpTargetOrigin(targetUrl ?? normalizedSource.targetOrigin, {
    required: !existed && workType === 'poc-workflow',
    label: 'POC target URL'
  });
  if (targetOrigin) normalizedSource.targetOrigin = targetOrigin;
  const selectedAgent = agent ?? resolved.phases[0]?.defaultAgent;
  if (!definition.agents?.[selectedAgent]) throw new SingularityFlowError(`Work type '${workType}' has no default governed agent for its first phase.`);

  if (existed) {
    // fetchRemote updated the remote-tracking ref; now advance an existing
    // local branch without merge commits before reading its durable state.
    if (refExists(root, `refs/remotes/${remote}/${id}`)) {
      fastForwardTo(root, `${remote}/${id}`);
    }
    let resumedWorkflow;
    try {
      resumedWorkflow = await loadWorkflow(root, definition, id);
    } catch (error) {
      throw new SingularityFlowError(
        `Branch '${id}' already exists but is not a Singularity Story work item. Choose another Work ID or attach the branch explicitly. ${error.message}`
      );
    }
    const resumedAgent = agent || resumedWorkflow.phases?.[resumedWorkflow.currentPhase]?.defaultAgent;
    if (!definition.agents?.[resumedAgent]) {
      throw new SingularityFlowError(`Story phase '${resumedWorkflow.currentPhase}' has no valid governed agent.`);
    }
    await setAgentSession(root, definition, actor, resumedAgent, id, {
      phaseId: resumedWorkflow.currentPhase,
      source: agent ? 'explicit-override' : 'phase-default'
    });
    return {
      workId: id,
      resumed: true,
      checkoutMode,
      branch: id,
      workflow: resumedWorkflow
    };
  }

  await setAgentSession(root, definition, actor, selectedAgent, id, { phaseId: resolved.phases[0]?.id, source: agent ? 'explicit-override' : 'phase-default' });
  const workflowCapabilityId = capabilityId ?? storyBase?.capability ?? null;
  let returnLocator;
  await runDraftTransaction(root, {
    subject: { kind: 'story', id, branch: id },
    allowedPaths: [workDirRelative(definition, id)],
    operation: 'story-start',
    write: async (creationPreimage) => {
      workflow = await createWorkflow(root, definition, {
        id,
        title: normalizedSource.title,
        source: normalizedSource,
        baseBranch: storyBase.localBase,
        baseCommit,
        baseRemote: remote,
        workType,
        agent: selectedAgent,
        resolved,
        capabilityId: workflowCapabilityId,
        // Always carry the verified catalog digest across the preflight/creation boundary. The
        // creation guard applies it only when resolution selected a capability, so a valid
        // collection-only catalog remains capability-free.
        capabilityMapSha256: configurationSnapshot?.files?.['singularity/capabilities.yml'] ?? null,
        executionOrigin: auto?.executionOrigin ?? null
      });
      if (flightPlan) await pinAcceptedChangeFlightPlan(root, definition, workflow, flightPlan);
      if (auto) await pinAcceptedAutoPlan(root, definition, workflow, auto);
      returnLocator = await writeReturnLocator(root, definition, workflow);
      publication = await commitAndPublish(
        root,
        definition,
        workflow,
        { type: LIFECYCLE_EVENT.BINDING },
        `[${id}][init] start ${workType} workflow`,
        [...(configurationSnapshot?.paths ?? []), returnLocator.path],
        {
          recoveryPreimage: creationPreimage,
          transactionId: startJournal?.transactionId ?? null,
          expectedRemoteSha: null,
          expectedLocalHead: baseCommit,
          ...(publicationAuthority ? { publicationAuthority } : {}),
          ...(capabilityPublications.length ? {
            publicationTail: {
              recoveryStage: 'capability-publication-pending',
              capabilityPublications,
              error: 'Capability Story branch publication has not started.'
            }
          } : {})
        }
      );
      return { workflow, publication };
    }
  });
  capabilityTailStaged = publication.pushed === true && capabilityPublications.length > 0;
  if (startJournal) await clearStoryStartJournal(root, id, startJournal.transactionId);
  const rootPublication = {
    remote,
    branch: id,
    commit: publication.sha ?? head(root),
    event: publication.event ?? null
  };
  if (publication.pushed && capabilityPublications.length) {
    capabilityPublication = await publishCapabilityRepositoriesDurably(
      root, id, rootPublication, capabilityPublications, { rootPublished: true }
    );
    if (capabilityPublication.pending.length) {
      const failure = new SingularityFlowError(
        `Story '${id}' was published in its lifecycle repository, but capability branch publication failed for `
        + `'${capabilityPublication.pending[0].repository}': ${capabilityPublication.error}. The remaining exact `
        + 'branch publications were retained; run singularity-flow sync after fixing remote access.',
        { code: 'STORY_CAPABILITY_PUBLICATION_PENDING' }
      );
      throw failure;
    }
  } else if (!publication.pushed && capabilityPublications.length) {
    await retainCapabilityPublicationRecovery(
      root, id, rootPublication, capabilityPublications,
      new Error('The lifecycle Story branch is still pending publication.')
    );
  }
  const documents = await publishInitialStoryDocuments(root, definition, workflow, {
    workId: id,
    operation: 'document-upload',
    inputs: [
      ...(files.length ? [{ files }] : []),
      ...urls.map((url) => ({ url }))
    ]
  });
  const astWarm = await scheduleStoryStartAstWarm(root, definition, workflow, {
    ...(astWarmLauncher ? { launcher: astWarmLauncher } : {})
  });
  return {
    workId: id,
    resumed: false,
    checkoutMode,
    branch: id,
    workflow,
    base: {
      branch: storyBase.localBase,
      commit: baseCommit,
      remote
    },
    publication: {
      ...publication,
      remote,
      branch: id,
      ref: `refs/heads/${id}`,
      pushed: publication.pushed === true,
      commit: publication.sha
    },
    measurement: workflow.measurement?.plan ? {
      status: workflow.measurement.status,
      studyId: workflow.measurement.plan.studyId,
      studyRunId: workflow.measurement.plan.studyRunId ?? null,
      cohort: workflow.measurement.plan.groupId,
      promptVariant: workflow.measurement.plan.variantId ?? null
    } : { status: workflow.measurement?.status ?? 'not-enrolled' },
    astWarm,
    capabilityPublication,
    ...(storyBase.scope === 'capability' ? {
      capabilityBase: {
        ...storyBase.plan.record,
        prepared: capabilityRepositoriesPrepared ?? []
      }
    } : {}),
    documents
  };
  } catch (error) {
    // Once the root transaction has staged the tail, the durable publisher owns its exact per-ref
    // outcomes. Replacing that marker with the original plan here would turn a known rejection back
    // into an ambiguous attempt (or resurrect refs that already succeeded).
    if (workflow && capabilityPublications.length && !capabilityTailStaged) {
      await retainCapabilityPublicationRecovery(
        root, id, {
          remote,
          branch: id,
          commit: publication?.sha ?? head(root),
          event: publication?.event ?? null
        }, capabilityPublications, error,
        { rootPublished: publication?.pushed === true }
      ).catch(() => {});
    }
    if (startJournal) {
      try { await recoverStoryStart(root, id, { force: true }); }
      catch (recoveryError) {
        throw new SingularityFlowError(
          `${error.message} Story-start recovery also stopped: ${recoveryError.message}`,
          { code: recoveryError.code ?? 'STORY_START_RECOVERY_FAILED', cause: error }
        );
      }
    }
    throw error;
  }
}
