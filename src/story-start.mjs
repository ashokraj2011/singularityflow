import path from 'node:path';
import { loadDefinition, resolveWorkType } from './config.mjs';
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
  preflightIncludesRepository, publishCapabilityRepositories, storyBaseForRepository
} from './capability-start.mjs';
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
  materializeConfigurationSnapshot, resolveStoryConfigurationAuthority
} from './configuration-branch.mjs';
import { publishCurrentIdentityToConfiguration } from './configuration-people.mjs';
import { clearPendingPublication } from './publication-pending.mjs';
import { retainCapabilityPublicationRecovery } from './capability-publication-recovery.mjs';
import {
  beginStoryStartJournal, clearStoryStartJournal, recoverStoryStart,
  serializeConfigurationRestorePoint, updateStoryStartJournal
} from './story-start-journal.mjs';
import { publishInitialStoryDocuments } from './story-start-documents.mjs';

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
  astWarmLauncher = undefined
} = {}) {
  let checkoutDefinition = null;
  let definitionError = null;
  try { checkoutDefinition = await loadDefinition(root); }
  catch (error) { definitionError = error; }
  let remote = checkoutDefinition?.git?.remote ?? 'origin';
  let configurationAuthority = null;
  try { configurationAuthority = await resolveStoryConfigurationAuthority(root, remote); }
  catch (error) {
    if (!checkoutDefinition) throw error;
  }
  let approvedConfigurationSnapshot = configurationAuthority
    ? await loadStoryConfigurationSnapshot(configurationAuthority)
    : null;
  let initialDefinition = approvedConfigurationSnapshot?.definition ?? checkoutDefinition;
  if (!initialDefinition) throw definitionError;
  validateId(initialDefinition, id);
  await recoverStoryStart(root, id);
  const normalizedSource = validateStorySource(source, id);
  const actor = identity(root);
  remote = initialDefinition.git?.remote ?? remote;

  assertClean(root);
  const localExisted = refExists(root, `refs/heads/${id}`);
  if (!localExisted) fetchRemote(root, remote);
  const remoteExisted = refExists(root, `refs/remotes/${remote}/${id}`);
  const existed = localExisted || remoteExisted;
  if (!existed && configurationAuthority?.branch === CONFIGURATION_BRANCH) {
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
      configurationAuthority = await resolveStoryConfigurationAuthority(root, remote);
      if (!configurationAuthority || configurationAuthority.commit !== enrollment.commit) {
        throw new SingularityFlowError(
          'Approved configuration changed again after automatic enrollment. Refresh Story intake and retry; nothing was changed.',
          { code: 'STORY_CONFIGURATION_AUTHORITY_STALE' }
        );
      }
      approvedConfigurationSnapshot = await loadStoryConfigurationSnapshot(configurationAuthority);
      initialDefinition = approvedConfigurationSnapshot.definition;
    }
  }
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
  let startJournal = null;
  let configurationSnapshot = null;
  let workflow = null;
  let publication = null;
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
      capabilityId
    });
    const publishRequired = (initialDefinition.git?.publish ?? 'required') !== 'off';
    const capabilityPreflight = storyBase.scope === 'capability'
      ? await preflightStoryRepositories(storyBase.workspaceRoot, storyBase.plan, id, {
          remote, publishRequired, lifecycleRoot: root, capabilityId: storyBase.capability,
          configurationSnapshot: approvedConfigurationSnapshot
        })
      : null;
    capabilityPublications = capabilityPublicationPlan(capabilityPreflight, root);
    const rootFetchedByCapabilityPreflight = preflightIncludesRepository(capabilityPreflight, root);
    if (!rootFetchedByCapabilityPreflight) fetchRemote(root, remote);
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
      const dryRun = preflightPushBranch(root, remote, remoteBaseRef, id);
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
  const resolved = resolveWorkType(definition, workType);
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
        capabilityId,
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
        { recoveryPreimage: creationPreimage, transactionId: startJournal?.transactionId ?? null }
      );
      return { workflow, publication };
    }
  });
  const documents = await publishInitialStoryDocuments(root, definition, workflow, {
    workId: id,
    operation: 'document-upload',
    inputs: [
      ...(files.length ? [{ files }] : []),
      ...urls.map((url) => ({ url }))
    ]
  });
  if (startJournal) await clearStoryStartJournal(root, id, startJournal.transactionId);
  let capabilityPublication = { published: [], pending: [], error: null };
  const rootPublication = { remote, branch: id, commit: head(root) };
  if (publication.pushed && capabilityPublications.length) {
    await retainCapabilityPublicationRecovery(
      root, id, rootPublication, capabilityPublications,
      new Error('Capability Story branch publication is in progress.'),
      { rootPublished: true }
    );
    capabilityPublication = publishCapabilityRepositories(capabilityPublications);
    if (capabilityPublication.pending.length) {
      const failure = new SingularityFlowError(
        `Story '${id}' was published in its lifecycle repository, but capability branch publication failed for `
        + `'${capabilityPublication.pending[0].repository}': ${capabilityPublication.error}. The remaining exact `
        + 'branch publications were retained; run singularity-flow sync after fixing remote access.',
        { code: 'STORY_CAPABILITY_PUBLICATION_PENDING' }
      );
      await retainCapabilityPublicationRecovery(
        root, id, rootPublication, capabilityPublication.pending, failure, { rootPublished: true }
      );
      throw failure;
    }
    await clearPendingPublication(root, { kind: 'story', id });
  } else if (!publication.pushed && capabilityPublications.length) {
    await retainCapabilityPublicationRecovery(
      root, id, rootPublication, capabilityPublications,
      new Error('The lifecycle Story branch is still pending publication.')
    );
  }
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
    if (workflow && capabilityPublications.length) {
      await retainCapabilityPublicationRecovery(
        root, id, { remote, branch: id, commit: head(root) }, capabilityPublications, error,
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
