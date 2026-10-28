/** Canonical story publication service; legacy state exports delegate here. */
import { SingularityFlowError } from "./util.mjs";
import { WORKFLOW_PATH } from "./config.mjs";
import { assertNoPendingPublication } from "./story-publication-pending.mjs";
import { assertStoryNotArchived } from "./governance-archive.mjs";
import { buildDesignSourceSet } from "./design-sources.mjs";
import { capabilityPublicationPlanSha256 } from './capability-publication-identity.mjs';
import { captureAggregateRecovery, restoreAggregateRecovery } from "./aggregate-recovery.mjs";
import { clearPendingPublication } from "./publication-pending.mjs";
import { commitIsAncestor, exactRemoteBranchObservationAsync, head, identity } from "./git.mjs";
import { configuredRemoteAuthority } from "./git-remote-diagnostics.mjs";
import { createLedgerIntent } from "./ledger.mjs";
import { deliverLifecycleNotifications, warnNotificationFailures } from "./notifications.mjs";
import { ensureWorkIntervalBaseline } from "./work-intervals.mjs";
import { finalizeDraftWorkflowSnapshot } from "./workflow-snapshots.mjs";
import { initialWorkflowRecord } from "./story-policy-anchor.mjs";
import { legacyPendingPublicationPath, saveWorkflow, validateId } from "./story-state-write.mjs";
import { lifecycleEvent, recordPublicationProjection } from "./lifecycle-event.mjs";
import { normalizeLedgerConfig } from "./ledger-config.mjs";
import { default as path } from "node:path";
import { phaseRequiresCodeDelivery } from "./code-delivery-policy.mjs";
import { publishLifecycleChange } from "./publication-unit-of-work.mjs";
import { repositoryLogger } from "./logging.mjs";
import { restorePublicationPreimage } from "./publication-recovery.mjs";
import { runStepActionsAfterTransition, stepActionWarning } from "./step-action-delivery.mjs";
import { storyLedgerSummary, workflowPublicationBranch, workflowPublicationMode } from "./story-publication-binding.mjs";
import { storyPublicationPending } from "./story-publication-read.mjs";
import { storyRequiresStepActions } from "./step-action-receipts.mjs";
import { takeRemoteBranchObservation } from "./remote-observation-prefetch.mjs";
import { validateDocumentPublicationTree } from "./document-publication.mjs";
import { validateWorkflow } from "./story-state-validation.mjs";
import { workDir, workDirRelative } from "./story-paths.mjs";
async function assertNoInteractiveRevisionPublication(...args) { return (await import('./revision/publication-absence.mjs')).assertNoInteractiveRevisionPublication(...args); }
async function prepareRevisionPublicationSelection(...args) { return (await import('./revision/publication-selection.mjs')).prepareRevisionPublicationSelection(...args); }
async function verifyPreparedRevisionPublicationSelection(...args) { return (await import('./revision/publication-selection.mjs')).verifyPreparedRevisionPublicationSelection(...args); }
async function refreshPhaseSpecificationIndex(...args) { return (await import('./state.mjs')).refreshPhaseSpecificationIndex(...args); }
async function refreshSkillLifecycleArtifactIdentities(...args) { return (await import('./state.mjs')).refreshSkillLifecycleArtifactIdentities(...args); }
async function registerApprovedSnapshot(...args) { return (await import('./state.mjs')).registerApprovedSnapshot(...args); }
async function registerArtifact(...args) { return (await import('./state.mjs')).registerArtifact(...args); }
async function settleRetainedPhases(...args) { return (await import('./state.mjs')).settleRetainedPhases(...args); }
async function updateArtifactMetadata(...args) { return (await import('./state.mjs')).updateArtifactMetadata(...args); }
async function validatePhase(...args) { return (await import('./state.mjs')).validatePhase(...args); }
async function writeDecision(...args) { return (await import('./state.mjs')).writeDecision(...args); }

export async function commitAndPublish(root, config, workflow, event, message, extraPaths = [], {
  beforeStateWrite = null,
  afterOwnedWrites = null,
  eventFromResult = null,
  afterEventFinalize = null,
  worktreeGuard = null,
  transactionId = null,
  rollbackWorkflow = null,
  recoveryPreimage = null,
  expectedRemoteSha = undefined,
  expectedLocalHead = undefined,
  publicationAuthority = null,
  publicationTail = null,
  exactWorkItemPaths = null,
  revisionPublication = null,
  fault = null
} = {}) {
  validateId(config, workflow?.workItem?.id);
  if (revisionPublication !== null && (typeof revisionPublication !== 'object'
      || Array.isArray(revisionPublication))) {
    throw new SingularityFlowError('REV publication selection must be an internal exact binding.', {
      code: 'REV_PUBLICATION_BINDING_INVALID'
    });
  }
  // Capture before the first asynchronous read. Even aggregates loaded through a legacy path that
  // lacks a STATE_REVISION receipt must not silently move onto a different local parent while this
  // transaction is checking pending publication and ledger state.
  const invocationHead = head(root);
  // The revision-one closure becomes immutable only with the Story creation commit. Creation
  // callers may add other already-reviewed pins to the draft before this locked transaction.
  const unacceptedWorkflowSnapshot = initialWorkflowRecord(root, config, workflow.workItem.id) == null;
  if (await storyPublicationPending(root, config, workflow.workItem.id)) await assertNoPendingPublication(root, config, workflow, 'create another lifecycle commit');
  // A Story a governance rebuild archived stays readable, but nothing may change it [E2G §11].
  assertStoryNotArchived(root, workflow);
  const ledgerConfig = normalizeLedgerConfig(workflow.resolution?.ledger ?? config.ledger ?? {});
  const requestedPhaseId = event?.phaseId ?? workflow.currentPhase ?? null;
  const requestedPhase = requestedPhaseId ? workflow.phases?.[requestedPhaseId] : null;
  const decision = [...(requestedPhase?.approvals ?? [])].reverse().find((item) => !item.invalidatedAt) ?? null;
  const authenticatedPublicationTail = publicationTail?.capabilityPublications?.length ? {
    ...publicationTail,
    capabilityPublicationPlan: publicationTail.capabilityPublicationPlan
      ?? publicationTail.capabilityPublications,
    capabilityPublicationPlanSha256: capabilityPublicationPlanSha256(
      publicationTail.capabilityPublicationPlan ?? publicationTail.capabilityPublications
    )
  } : publicationTail;
  const envelope = lifecycleEvent({
    ...event,
    subject: { kind: 'story', id: workflow.workItem.id, branch: workflowPublicationBranch(root, workflow) },
    phaseId: requestedPhaseId,
    generation: event?.generation ?? requestedPhase?.generation ?? null,
    actor: event?.actor ?? decision?.actor ?? identity(root),
    agent: Object.hasOwn(event ?? {}, 'agent') ? event.agent : decision?.agent ?? requestedPhase?.generatedAgent ?? null,
    authorityGroup: event?.authorityGroup ?? decision?.authorityGroup ?? null,
    payload: {
      ...(event?.payload ?? {}),
      ...(storyRequiresStepActions(workflow) ? {
        stepActionRemote: workflowPublicationMode(config, workflow) === 'off' ? null
          : (publicationAuthority ?? configuredRemoteAuthority(root, config.git?.remote ?? 'origin'))?.url ?? null
      } : {}),
      ...(authenticatedPublicationTail?.capabilityPublicationPlanSha256 ? {
        capabilityPublicationPlanSha256: authenticatedPublicationTail.capabilityPublicationPlanSha256
      } : {}),
      decision: Object.hasOwn(event?.payload ?? {}, 'decision') ? event.payload.decision : decision?.decision ?? null,
      reviewPacketSha256: decision?.reviewPacketSha256 ?? null
    }
  });
  let ledgerIntent = null;
  if (ledgerConfig.enabled) {
    ledgerIntent = createLedgerIntent({
      eventId: envelope.eventId,
      eventType: envelope.type,
      capabilityId: workflow.resolution?.capability?.id ?? `story-${workflow.workItem.id}`,
      subject: {
        workId: workflow.workItem.id,
        workType: workflow.workItem.workType,
        phase: envelope.phaseId,
        generation: envelope.generation,
        branch: workflowPublicationBranch(root, workflow),
        ...storyLedgerSummary(workflow)
      },
      actor: envelope.actor,
      agent: envelope.agent,
      authorityGroup: envelope.authorityGroup,
      identityAssurance: decision?.identityAssurance ?? null,
      payload: {
        lifecycleEventId: envelope.eventId,
        lifecyclePayload: envelope.payload,
        configPath: WORKFLOW_PATH,
        configSha256: workflow.resolution?.configSha256 ?? null,
        templateSha256: envelope.phaseId ? workflow.resolution?.templates?.[envelope.phaseId]?.sha256 ?? null : null,
        capabilityMapSha256: workflow.resolution?.capability?.map?.sha256 ?? null,
        capabilityPolicy: workflow.resolution?.capability?.policy ?? null
      }
    });
  }
  const targetBranch = workflowPublicationBranch(root, workflow);
  const publicationMode = workflowPublicationMode(config, workflow);
  const governedLocalParent = expectedLocalHead
    ?? workflow[Symbol.for('singularity-flow.state-revision')]?.head
    ?? invocationHead;
  // Every ordinary lifecycle update extends the exact local revision that was loaded and validated
  // by this transaction. The remote may legitimately be an older ancestor when ordinary local
  // commits have not been pushed yet, so bind the push to the exact observed remote tip below.
  // Creation paths can still explicitly supply absence (`null`) or a materialized seed commit.
  let governedExpectedRemoteSha = expectedRemoteSha !== undefined
    ? expectedRemoteSha
    : governedLocalParent;
  let expectedRemoteShaSource = expectedRemoteSha !== undefined
    ? 'explicit'
    : 'implicit-local-parent';
  let governedPublicationAuthority = publicationAuthority;
  if (publicationMode !== 'off' && expectedRemoteSha === undefined) {
    governedPublicationAuthority ??= configuredRemoteAuthority(
      root, config.git?.remote ?? 'origin'
    );
    const observation = governedPublicationAuthority?.url
      ? await takeRemoteBranchObservation(root, governedPublicationAuthority.url, targetBranch)
        ?? await exactRemoteBranchObservationAsync(root, governedPublicationAuthority.url, targetBranch)
      : { reachable: false, malformed: false, sha: null };
    if (observation.reachable && !observation.malformed && observation.sha !== null) {
      if (!commitIsAncestor(root, observation.sha, governedLocalParent)) {
        // Only behind: refresh-branch is the whole answer, and sync would find nothing to publish.
        // A remote tip this clone has never fetched cannot tell, so refresh-branch reports it.
        const remoteTipHere = commitIsAncestor(root, observation.sha, observation.sha);
        const unpublishedLocal = remoteTipHere ? !commitIsAncestor(root, governedLocalParent, observation.sha) : null;
        // A waiting SFlow commit stops this transaction before it gets here, so a commit the remote lacks
        // was made outside SFlow, and sync had nothing to publish: it named sync and looped (2026-10-28).
        const merge = `git pull --no-rebase ${config.git?.remote ?? 'origin'} ${targetBranch}`;
        throw new SingularityFlowError(
          `Story '${workflow.workItem.id}' has commits on its remote branch '${targetBranch}' that this checkout does not have: another clone published to it. `
          + 'Run singularity-flow refresh-branch to bring them in (it only fast-forwards), then retry; nothing was changed.'
          + (unpublishedLocal === true ? ` This checkout also holds a commit made outside SFlow that the remote does not have, so refresh-branch will report that the branch diverged: merge the other clone's commits in with a reviewed ${merge}, then retry.`
            : unpublishedLocal === null ? ` If it reports that the branch diverged, this checkout also holds a commit the remote does not have: merge with a reviewed ${merge}, then retry.` : ''),
          {
            code: 'STORY_PUBLICATION_REMOTE_DIVERGED',
            details: {
              branch: targetBranch,
              localParent: governedLocalParent,
              observedRemoteSha: observation.sha,
              // Fast-forward first; a diverged branch then needs the unpublished commit published.
              recoveryCommands: ['singularity-flow refresh-branch', ...(unpublishedLocal === false ? [] : [merge])]
            }
          }
        );
      }
      // Local commits ahead of the remote are a normal fast-forward history. Lease the exact live
      // remote tip rather than pretending every local ancestor was already published.
      governedExpectedRemoteSha = observation.sha;
      expectedRemoteShaSource = 'observed-remote';
    } else if (observation.reachable && !observation.malformed) {
      // The remote has no Story branch (a merged pull request deleted it). Leasing the local parent
      // could never succeed there, so the commit stayed unsent and cancel was blocked (2026-10-28).
      // Create it, create-only: that cannot replace anything another clone sent.
      governedExpectedRemoteSha = null;
      expectedRemoteShaSource = 'observed-absent';
    }
  }
  const priorWorkflow = rollbackWorkflow ?? structuredClone(workflow);
  const workflowRecovery = captureAggregateRecovery(workflow, priorWorkflow);
  // The whole work directory, not just `workflow.json`.
  //
  // `state.write` is not one write: the approval path rewrites the artifact's metadata block in
  // place, registers an approved snapshot, and writes both `approvals/<phase>.json` and a timestamped
  // decision file — all before `saveWorkflow`. Restoring only the aggregate left an artifact carrying
  // post-approval metadata (so the next command reported "Artifact changed after registration" and
  // blamed the operator) and a complete approved decision on disk for an approval that was undone —
  // which the next successful governed commit would then sweep into signed, pushed, attested history.
  const workDirectory = workDirRelative(config, workflow.workItem.id);
  // Narrow evidence/appeal transactions must not sweep an unfinished phase draft into a commit.
  // The subject state and status projection remain mandatory owned paths; callers cannot use this
  // internal option to commit application code or another Story's files.
  if (exactWorkItemPaths !== null && (!Array.isArray(exactWorkItemPaths)
      || exactWorkItemPaths.some(file => typeof file !== 'string' || !file.startsWith(`${workDirectory}/`)
        || file.split('/').some(segment => !segment || segment === '.' || segment === '..')
        || /[\\\x00-\x1f]/u.test(file)))) {
    throw new SingularityFlowError('Exact Story publication paths must stay inside this work item.', { code: 'STORY_PUBLICATION_SCOPE_INVALID' });
  }
  const pendingMetadata = {
    workId: workflow.workItem.id,
    ...(authenticatedPublicationTail ?? {}),
    // This provenance is covered by the machine-local recovery MAC. Keep it after caller metadata
    // so an authenticated tail cannot relabel an explicit lease as an inferred compatibility lease.
    ...(publicationMode !== 'off' ? { expectedRemoteShaSource } : {})
  };
  let revisionSelection = null;
  const revisionAttestation = revisionPublication === null ? null : {
    beforeStateWrite: async ({ expectedHead }) => {
      const preflight = await prepareRevisionPublicationSelection({
        ...revisionPublication, root, workflow
      });
      if (revisionPublication.candidateReference?.repository?.baselineCommit !== expectedHead) {
        throw new SingularityFlowError('REV selected Candidate does not extend the Story publication parent.', {
          code: 'REV_PUBLICATION_BASELINE_CHANGED'
        });
      }
      return preflight;
    },
    select: async ({ preflight, prospectiveTree }) => {
      revisionSelection = await verifyPreparedRevisionPublicationSelection({
        token: preflight, root, prospectiveTree, config, workflow
      });
      return revisionSelection;
    }
  };
  const result = await publishLifecycleChange(root, {
    subject: envelope.subject,
    expectedRevision: workflow[Symbol.for('singularity-flow.state-revision')] ?? null,
    allowedPaths: exactWorkItemPaths === null ? [workDirectory, ...extraPaths]
      : [...new Set([`${workDirectory}/workflow.json`, `${workDirectory}/STATUS.md`, ...exactWorkItemPaths, ...extraPaths])],
    event: envelope,
    commit: { message },
    state: {
      write: async (publicationEvent, transactionContext) => {
        // Mutations which create or advance governed lifecycle state must run
        // after the publication unit has acquired the subject lock and opened
        // its recovery journal. Callers may prepare an in-memory decision before
        // this point, but may not persist governed files outside this callback.
        if (revisionPublication === null && phaseRequiresCodeDelivery(
          workflow.phases?.[workflow.currentPhase]
        )) {
          await assertNoInteractiveRevisionPublication(root, { definition: config, workflow });
        }
        const transitionResult = beforeStateWrite
          ? await beforeStateWrite(publicationEvent, transactionContext)
          : undefined;
        if (eventFromResult) {
          const derived = await eventFromResult(transitionResult, workflow, publicationEvent);
          if (derived) {
            const finalized = lifecycleEvent({
              ...publicationEvent,
              ...derived,
              subject: publicationEvent.subject,
              payload: { ...(publicationEvent.payload ?? {}), ...(derived.payload ?? {}) }
            });
            Object.assign(publicationEvent, finalized, {
              eventId: publicationEvent.eventId,
              createdAt: publicationEvent.createdAt
            });
            if (ledgerIntent) {
              ledgerIntent.eventType = publicationEvent.type;
              ledgerIntent.subject.phase = publicationEvent.phaseId;
              ledgerIntent.subject.generation = publicationEvent.generation;
              ledgerIntent.actor = {
                name: publicationEvent.actor?.name ?? null,
                email: publicationEvent.actor?.email ?? null,
                githubLogin: publicationEvent.actor?.login ?? publicationEvent.actor?.githubLogin ?? null,
                identityAssurance: derived.identityAssurance
                  ?? ledgerIntent.actor?.identityAssurance
                  ?? 'unavailable'
              };
              ledgerIntent.agent = publicationEvent.agent;
              ledgerIntent.authorityGroup = publicationEvent.authorityGroup;
              ledgerIntent.payload = {
                ...(ledgerIntent.payload ?? {}),
                lifecyclePayload: publicationEvent.payload,
                lifecycleEvent: publicationEvent
              };
            }
          }
        }
        // Some governed transitions legitimately mint a generation without using the ordinary
        // publish command (currently an authority-approved intent amendment). Their durable
        // generation receipt must bind the *finalized* lifecycle event, including the generation
        // derived from the transition result, so this hook runs after eventFromResult and before
        // the workflow projection is saved in the same transaction.
        if (afterEventFinalize) {
          await afterEventFinalize(publicationEvent, transactionContext, transitionResult);
        }
        // Design-source selection is lifecycle authority, not an incidental file
        // write. Build and bind it only after the publication unit has acquired
        // the subject lock, checked the revision, and opened its journal.
        if (event?.type === 'artifact-generated'
          && workflow.resolution?.designSources?.capturePhase === requestedPhase?.id) {
          await buildDesignSourceSet(root, workflow, {
            itemDirectory: workDir(root, config, workflow.workItem.id),
            selectionByFileKey: requestedPhase.designSourceSelection ?? {}
          });
          await updateArtifactMetadata(root, config, workflow, requestedPhase);
          // The source set is created after publishGeneration has registered the
          // artifact. Its managed metadata therefore changes once more here;
          // refresh that registration inside the same publication transaction so
          // submit does not mistake Flow's own metadata update for user tampering.
          await registerArtifact(root, workflow, path.join(
            workDirRelative(config, workflow.workItem.id),
            requestedPhase.requiredArtifact.path
          ), { phaseId: requestedPhase.id, kind: requestedPhase.requiredArtifact.kind, config });
          const designValidation = await validatePhase(root, config, workflow, requestedPhase,
            { generation: publicationEvent.generation, transition: 'publish' });
          if (designValidation.length) {
            throw new SingularityFlowError(`Phase ${requestedPhase.id} design-source binding is not publishable:\n- ${designValidation.join('\n- ')}`);
          }
        }
        if (event?.type === 'phase-approved') {
          const binding = workflow.resolution?.designSources?.capturePhase === requestedPhase?.id
            ? [...(requestedPhase.designSourceSets ?? [])]
              .reverse().find((entry) => entry.generation === requestedPhase.generation) ?? null
            : null;
          if (workflow.resolution?.designSources?.capturePhase === requestedPhase?.id
            && workflow.resolution.designSources.requireApprovedSet && !binding) {
            throw new SingularityFlowError(
              `Phase '${requestedPhase.id}' cannot be approved without its generation ${requestedPhase.generation} design-source set.`
            );
          }
          const approval = [...(requestedPhase.approvals ?? [])].reverse()
            .find((item) => !item.invalidatedAt && item.decision === 'approved');
          if (approval) {
            if (binding) approval.designSourceSet = binding;
            if (requestedPhase.status === 'approved') {
              await updateArtifactMetadata(root, config, workflow, requestedPhase);
              // This hash represents the final approved artifact, including its
              // managed approval metadata. Do not rewrite it after this point.
              await registerApprovedSnapshot(root, config, workflow, requestedPhase);
              await refreshSkillLifecycleArtifactIdentities(root, config, workflow, requestedPhase, {
                stage: 'approved', decision: approval
              });
              // The specification index was first created at publication, before approval metadata
              // was rendered. Rebuild it against the exact final approved bytes so downstream
              // clause context can verify source, index and workflow anchor before injection.
              await refreshPhaseSpecificationIndex(root, config, workflow, requestedPhase);
              await settleRetainedPhases(root, config, workflow, approval.at);
            }
            await writeDecision(root, config, workflow, requestedPhase, approval);
            // The advancing phase's interval baseline is a durable write like the three above, and
            // it belongs here for the same reason. `approvePhase` used to write it before the unit
            // opened, which put the baseline file inside the snapshot the rollback restores — so a
            // failed approval left the file on disk with a workflow.json that no longer referenced
            // it. `currentPhase` has already advanced in memory by this point, and the helper is a
            // no-op for a phase that does not use intervals or already has an open one.
            if (requestedPhase.status === 'approved') {
              await ensureWorkIntervalBaseline(root, config, workflow, {
                phaseId: workflow.currentPhase,
                itemDirectory: workDir(root, config, workflow.workItem.id),
                itemRelative: workDirRelative(config, workflow.workItem.id)
              });
            }
          }
        }
        // Every publication that commits a Story as complete passes the final evaluation first, and
        // once. It runs after every other write of the transition (approval metadata, the approved
        // snapshot, the decision receipt), so it judges the bytes about to be committed; a refusal
        // throws before the state is written, and the publication unit rolls back.
        if (workflow.status === 'closed' && workflow.completion?.evaluatedAt == null) {
          const { assertTerminalTransition } = await import('./evidence/terminal.mjs');
          await assertTerminalTransition(root, config, workflow);
        }
        if (unacceptedWorkflowSnapshot) {
          await finalizeDraftWorkflowSnapshot(root, config, workflow);
        }
        // The transition above moved the Story on; the ledger lists it as it is committed.
        if (ledgerIntent) Object.assign(ledgerIntent.subject, storyLedgerSummary(workflow));
        recordPublicationProjection(workflow, publicationEvent, ledgerIntent);
        await saveWorkflow(root, config, workflow);
        return { event: publicationEvent, transitionResult };
      },
      // Captured before the projection mutates it in place, so a publication that fails after the
      // write leaves no record of an event that never happened — and covering every file the write
      // touches, not only the aggregate.
      // The captured bytes are the aggregate too, so restoring them is the whole durable undo. The
      // in-memory object is restored separately below without re-serialising the already-correct
      // file.
      rollback: async (preimage, recoveryOptions = {}) => {
        const restoration = await restorePublicationPreimage(root, preimage, {
          subject: envelope.subject,
          ...recoveryOptions
        });
        // The publication unit restores every durable Story byte, but callers may keep the same
        // aggregate object alive (the state store, VS Code command services, and tests all do).
        // Leaving that object mutated after a pre-commit refusal makes an immediate retry observe
        // a generation, approval, or phase transition that never became authoritative. Restore the
        // supplied object only from this rollback callback: it is invoked iff the durable preimage
        // was restored. A push failure deliberately does not come through here because its exact
        // governed commit is retained as the new stable recovery boundary.
        restoreAggregateRecovery(workflow, workflowRecovery);
        return restoration;
      },
      validate: async () => {
        // Publication acts on errors only; its warnings were never shown.
        const validation = await validateWorkflow(root, config, workflow, { reportWarnings: false });
        if (!validation.valid) {
          throw new SingularityFlowError(`Story state is invalid before publication: ${validation.errors.join(' ')}`, {
            code: 'STORY_STATE_INVALID',
            details: { workId: workflow.workItem.id, currentPhase: workflow.currentPhase ?? null, problems: validation.errors }
          });
        }
      }
    },
    publication: {
      mode: publicationMode,
      remote: config.git?.remote ?? 'origin',
      branch: targetBranch,
      expectedLocalHead: governedLocalParent,
      ...(governedPublicationAuthority ? { authority: governedPublicationAuthority } : {}),
      ...(publicationMode !== 'off' ? { expectedRemoteSha: governedExpectedRemoteSha } : {})
    },
    pendingMetadata,
    pendingRecord: () => pendingMetadata,
    retainPendingOnSuccess: Boolean(publicationTail),
    revisionAttestation,
    ledger: { config: ledgerConfig, intent: ledgerIntent, intentDirectory: workDirRelative(config, workflow.workItem.id) },
    afterOwnedWrites,
    validateProspectiveTree: async ({ event: finalizedEvent, prospectiveTree }) => {
      await validateDocumentPublicationTree(root, config, workflow, finalizedEvent, { prospectiveTree });
    },
    recoveryPreimage,
    stabilityGuard: worktreeGuard,
    transactionId,
    fault
  });
  if (workflow[Symbol.for('singularity-flow.state-revision')]) {
    workflow[Symbol.for('singularity-flow.state-revision')].head = result.sha;
  }
  let pendingCleanup = { status: 'not-required' };
  if (result.pushed && !publicationTail) {
    try {
      await clearPendingPublication(root, {
        kind: 'story', id: workflow.workItem.id,
        legacyPath: legacyPendingPublicationPath(root, config, workflow.workItem.id)
      });
      pendingCleanup = { status: 'complete' };
    } catch (error) {
      // The exact governed commit is already created and pushed. A failure to remove its local
      // retry marker is recoverable machine state, not a failed lifecycle mutation; throwing here
      // invites the caller to publish the same transition again. Keep the marker for `sync` to
      // verify and clear, and return the committed outcome with a bounded warning instead.
      pendingCleanup = {
        status: 'pending',
        code: typeof error?.code === 'string' ? error.code : 'LOCAL_PENDING_CLEANUP_FAILED'
      };
      console.warn(
        `Warning: commit ${result.sha.slice(0, 8)} was pushed, but its local publication marker could not be cleared. `
        + 'Do not repeat the lifecycle action; run singularity-flow sync to verify and clear the marker.'
      );
    }
  }
  const notifications = await deliverLifecycleNotifications({
    channels: workflow.resolution?.collaboration?.notifications ?? config.collaboration?.notifications ?? [],
    event: result.event
  });
  warnNotificationFailures(notifications);
  // After-step actions run from the actions this Story pinned, once the commit is published (or at
  // once when publication is off). A commit that could not be pushed holds them until sync does.
  const stepActions = await runStepActionsAfterTransition(root, workflow, {
    event: result.event,
    commit: result.sha,
    remote: governedPublicationAuthority?.url ?? null,
    published: Boolean(result.pushed) || workflowPublicationMode(config, workflow) === 'off',
    logger: stepActionLogger(root, config, workflow)
  });
  const stepActionNotice = stepActionWarning(stepActions);
  if (stepActionNotice) console.warn(`Warning: ${stepActionNotice}`);
  return {
    ...result, notifications, stepActions, pendingCleanup,
    ...(revisionSelection ? { revisionSelection } : {})
  };
}

export function stepActionLogger(root, config, workflow) {
  try { return repositoryLogger(root, config, { context: { workId: workflow?.workItem?.id ?? null } }); } catch { return null; }
}
