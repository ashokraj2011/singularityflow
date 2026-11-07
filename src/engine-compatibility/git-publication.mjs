/** Git/installed-owner composition for registered SDK operations. No CLI dispatch. */
import path from 'node:path';
import { createEngine, ENGINE_OPERATIONS } from '../engine-sdk/index.mjs';
import { SingularityFlowError, readJson } from '../util.mjs';
import { actionActor } from '../git.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { generationResultMatches, prefetchStoryPublicationObservation, scanArtifacts, commitAndPublish, publishGeneration } from '../state-stores.mjs';
import { nextPhaseGeneration } from '../kernel/phase-policy.mjs';
import { phaseAgentMutationRestriction } from '../phase-actor-policy.mjs';
import { publishedGenerationCommit } from '../generation-publication-store.mjs';
import { operationContext } from '../operation-context.mjs';
import { phaseRequiresCodeDelivery, generationSkillForPhase } from '../code-delivery-policy.mjs';
import { loadSession } from '../session.mjs';
import { isConvergencePhase } from '../kernel/phase-policy.mjs';
import { assertProducerAllowed, normalizeAuthorshipOptions } from '../kernel/phase-policy.mjs';
import { inspectDeterministicInPlaceArtifact, inspectInPlaceArtifact, importManualArtifact } from '../manual-authorship.mjs';
import { buildGenerationAuthorship } from '../kernel/phase-policy.mjs';
import { workDir } from '../story-paths.mjs';
import { directCopilotSkill } from '../copilot-guidance.mjs';
import { assertConvergencePublicationReady } from '../convergence-context.mjs';
import { generationStartPublicationBinding } from '../generation-boundary.mjs';
import { currentInteractiveRevisionPublication } from '../revision/publication-adapter.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { applicationPathContext, applicationChangeSetProjection } from '../work-intervals.mjs';
import { buildRepositoryChangeSet } from '../repository-change-set.mjs';
import { observeAutoCandidateWorktree, assertAutoCandidateMatches } from '../auto/auto-candidate.mjs';
import { measureCommandSpan } from '../dx-timing-context.mjs';
import { withoutReadScope } from '../read-scope.mjs';
import { withoutConfigurationReadScope } from '../configuration-read-scope.mjs';

function publicationFacts(context, phase, result, status, retentionReason = null) {
  return Object.freeze({ workId: context.workflow.workItem.id,
    phase: phase.id, generation: phase.generation, revision: result.sha, pushed: status === 'published' && result.pushed === true,
    artifact: phase.requiredArtifact.path, ...(retentionReason ? {retentionReason} : {}) });
}

export function createGitEngine({ root, notice = () => {}, approvalInteraction = null, decisionInteraction = null,
  decisionRecordInteraction = null, planCorrectionInteraction = null, rejectionInteraction = null } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new SingularityFlowError(
    'Git engine composition requires an explicit absolute checkout root.', { code: 'ENGINE_INPUT_INVALID' });
  if (typeof notice !== 'function') throw new SingularityFlowError(
    'Git engine notices require a trusted observer function.', {code: 'ENGINE_INPUT_INVALID'});
  const notifications = [];
  const observer = notice;
  notice = event => {
    // Advisory diagnostics are bounded machine-local observations, never lifecycle authority.
    if (notifications.length === 256) notifications.shift();
    const captured = Object.freeze({...event});
    notifications.push(captured);
    return observer(captured);
  };
  let presentation = null;
  const port = {
    notice,
    async load(input) {
      const accepted = await loadAcceptedStoryExecution(root, input.workId ?? null);
      const config = accepted.definition, workflow = accepted.workflow;
      const usage = input.usageFile ? await readJson(path.resolve(root, input.usageFile)) : input.usage ?? null;
      const phaseId = input.phaseId ?? workflow.currentPhase;
      const phase = workflow.phases[phaseId];
      if (!phase) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`);
      const context = { root, accepted, config, workflow, phaseId, phase, usage,
        subject: Object.freeze({kind:'story',id:workflow.workItem.id}),
        modelEnabled: operationContext()?.modelMode.enabled !== false };
      presentation = context;
      return context;
    },
    async retained(context, input) {
      const { root, config, workflow, accepted, phaseId, phase: requestedPhase, usage } = context;
      let reason = null;
      if (phaseRequiresCodeDelivery(requestedPhase)
        && requestedPhase.generationIntent?.status === 'consumed'
        && Number(requestedPhase.generationIntent.generation) === Number(requestedPhase.generation)) {
        if (!(await generationResultMatches(root, config, workflow, requestedPhase))) {
          throw new SingularityFlowError(
            `Generation intent ${requestedPhase.generationIntent.id} was already consumed and the source or artifact bytes now differ. Run singularity-flow phase rollover ${phaseId} to preview the exact guarded next-generation command.`,
            { code: 'GENERATION_INTENT_ALREADY_CONSUMED', details: { nextAction: `singularity-flow phase rollover ${phaseId}` } });
        }
        reason = 'consumed-intent';
      } else if (!input.from
        && await (await import('../phase-publication-unchanged.mjs')).documentUnchangedSincePublication(root, config, workflow, requestedPhase)
        && !phaseAgentMutationRestriction(config, workflow, requestedPhase, await loadSession(root, {required:false}), 'publish')) {
        reason = 'unchanged-document';
      }
      return reason ? publicationFacts(context, requestedPhase,
        { sha: publishedGenerationCommit(root, workflow, requestedPhase), pushed: false }, 'retained', reason) : null;
    },
    async prepare(context, input, intent) {
      const { root, config, workflow, accepted, phaseId, phase: requestedPhase, usage } = context;
      const sourcePath = input.from ? path.resolve(root, input.from) : null;
      let authorshipOptions = intent.authorship;
      // Ask for the remote tip now; it arrives while publication checks run.
      prefetchStoryPublicationObservation(root, config, workflow);
      const deterministicPublication = authorshipOptions.producer === 'deterministic';
      const session = deterministicPublication
        ? { actor: actionActor(root), agent: null }
        : await loadSession(root);
      const targetPath = path.join(workDir(root, config, workflow.workItem.id), requestedPhase.requiredArtifact.path);
      const targetRelative = path.relative(root, targetPath).replaceAll(path.sep, '/');
      const generation = nextPhaseGeneration(requestedPhase);
      const publicationArtifactContract = {
        ...requestedPhase.requiredArtifact,
        generation: nextPhaseGeneration(requestedPhase)
      };
      const publicationAuthoringOptions = {
        qualityContext: { root, config, workflow, phase: requestedPhase, generation },
        baseline: requestedPhase.authoringBaseline ?? null,
        retrySkill: directCopilotSkill(generationSkillForPhase(requestedPhase, workflow))
      };
      const deterministicConvergence = isConvergencePhase(requestedPhase);
      const inspectPublicationArtifact = deterministicConvergence
        ? (candidatePath) => inspectDeterministicInPlaceArtifact(candidatePath, publicationArtifactContract)
        : (candidatePath) => inspectInPlaceArtifact(candidatePath, publicationArtifactContract, publicationAuthoringOptions);
      // Refuse an incomplete in-place artifact before artifact discovery mutates even the in-memory
      // aggregate. The transaction repeats this inspection to close the change-between-check-and-use
      // window; this first read gives CLI and Copilot hosts the complete deterministic remediation
      // without beginning publication work.
      const preflight = sourcePath ? null : await measureCommandSpan('publication.preflight', () => inspectPublicationArtifact(targetPath));
      // SF Guard: on a Story it requires, a person's or an external tool's authorship claim is believed only
      // with its author's presence signature; an unsigned one is recorded and checked as the agent's. The
      // claimant is the person running this, and a claim they sign records them as its actor.
      let claimActor = null;
      if (workflow.resolution?.presence) {
        const claimant = actionActor(root);
        const claimed = await (await import('../presence/authorship-claims.mjs')).prepareAuthorshipClaim(root, {
          workflow, phase: requestedPhase, options: authorshipOptions, generation, artifactSha256: preflight?.sha256 ?? null,
          actor: claimant, sourcePath: sourcePath ? path.resolve(sourcePath) : null,
          asAgent: (candidate) => {
            assertProducerAllowed(candidate, 'governed-agent');
            return normalizeAuthorshipOptions({ producer: 'governed-agent', channel: 'copilot-host', externalAiUse: authorshipOptions.externalAiUse });
          }
        });
        authorshipOptions = claimed.options;
        if (authorshipOptions.presence) claimActor = claimant;
        if (claimed.notice) notice({ code: 'publication.authorship-claim', message: claimed.notice });
      }
      if (deterministicConvergence) {
        await assertConvergencePublicationReady(root, config, workflow, requestedPhase);
      }
      // Discover the prospective generation's artifact set before opening the publication unit. This
      // changes only the in-memory aggregate; the unit below still owns every durable write. Without
      // this preflight, implementation source/tests first discovered inside `publishGeneration` were
      // absent from the transaction's immutable path allowlist and therefore absent from the exact
      // generation commit later used by governed references and review packets.
      await measureCommandSpan('publication.discovery', () => scanArtifacts(root, config, workflow, phaseId));
      // Attribute only invocations explicitly bound to this generation intent. Story-wide unclaimed
      // audits may come from exploration, another phase, or an abandoned attempt and can never prove
      // the model assurance of the generation being published.
      const attributedInvocations = new Set(Object.values(workflow.phases ?? {})
        .flatMap((item) => item.authorship ?? [])
        .flatMap((record) => record.kernelModel?.invocationIds ?? []));
      const { listModelInvocations } = await import('../model-runner.mjs');
      const kernelInvocations = (await listModelInvocations(root, {
        subjectId: workflow.workItem.id,
        phase: requestedPhase.id,
        generationIntentId: requestedPhase.generationIntent?.id ?? null,
        generation,
        task: 'code',
        startedAfter: requestedPhase.generationIntent?.startedAt ?? null
      }))
        .filter((record) => !attributedInvocations.has(record.id));
      const kernelInvocationIds = kernelInvocations.map((record) => record.id);
      const generationStart = await generationStartPublicationBinding(root, workflow, requestedPhase);
      // A code phase with no REV loop keeps the ordinary publication path. Once the guarded REV flow
      // has established any private pointer/journal state, publication may proceed only through its
      // exact current prechecked selected head; missing, stale, abandoned, or uncertain state refuses
      // instead of silently publishing whatever happens to be in the worktree.
      const revisionPublication = phaseRequiresCodeDelivery(requestedPhase)
        ? await currentInteractiveRevisionPublication(root, accepted)
        : null;

      return { authorshipOptions, sourcePath, session, targetPath, targetRelative, generation, publicationArtifactContract, publicationAuthoringOptions, deterministicConvergence, inspectPublicationArtifact, claimActor, kernelInvocationIds, kernelInvocations, generationStart, revisionPublication };
    },
    async commit(context, prepared) {
      const { root, config, workflow, accepted, phaseId, phase: requestedPhase, usage } = context;
      const { authorshipOptions, sourcePath, session, targetPath, targetRelative, generation, publicationArtifactContract, publicationAuthoringOptions, deterministicConvergence, inspectPublicationArtifact, claimActor, kernelInvocationIds, kernelInvocations, generationStart, revisionPublication } = prepared;
      let phase = requestedPhase;
      let publicationStabilityGuard = null;
      await (await import('../workflow-task-store.mjs')).observeWorkflowTask(root, workflow, phase,
        { state: 'publication-requested', checkpoint: 'publication-requested' }, { generation });
      const result = await commitAndPublish(
        root,
        config,
        workflow,
        {
          type: LIFECYCLE_EVENT.ARTIFACT_GENERATED,
          phaseId,
          generation,
          payload: generationStart ?? {}
        },
        `[${workflow.workItem.id}][phase:${phaseId}][generated:${generation}] publish artifacts`,
        [...new Set([...requestedPhase.artifacts.map((item) => item.path), targetRelative])],
        {
          beforeStateWrite: async (publicationEvent, transactionContext) => {
            const source = sourcePath
              ? await importManualArtifact({
                  sourcePath: path.resolve(sourcePath), targetPath,
                  contract: publicationArtifactContract,
                  baseline: publicationAuthoringOptions.baseline,
                  retrySkill: publicationAuthoringOptions.retrySkill
                })
              : await inspectPublicationArtifact(targetPath);
            const authorship = buildGenerationAuthorship({
              options: authorshipOptions,
              actor: claimActor ?? session.actor,
              governedAgentContext: session.agent,
              source,
              kernelInvocationIds,
              kernelInvocations,
              generation
            });
            // The initial discovery owns the transaction allowlist. publishGeneration refreshes
            // registrations after its managed writes; repeating discovery here observes no new scope.
            phase = await measureCommandSpan('publication.validation', () => publishGeneration(root, config, workflow, {
              phaseId,
              usage,
              authorship,
              persist: false,
              publicationTransaction: {
                publicationEvent,
                transactionId: transactionContext.transactionId,
                expectedHead: transactionContext.expectedHead
              }
            }));
            // Deterministic phases may legitimately replace their prepared scaffold during
            // `publishGeneration`; all phases also receive engine-owned metadata. The stability
            // boundary therefore begins from the validated post-transition artifact, not from the
            // pre-transition author/import source.
            const expectedArtifactSha256 = (await inspectPublicationArtifact(targetPath)).sha256;
            const expectedConvergenceSnapshotSha256 = deterministicConvergence
              ? (await assertConvergencePublicationReady(root, config, workflow, phase)).snapshotSha256
              : null;
            const deliveryBaseline = phase.deliveryEvidence?.baselineCommit ?? null;
            const pathContext = applicationPathContext(config, workflow);
            const expectedApplicationDigest = phase.deliveryEvidence?.changeSet
              ? applicationChangeSetProjection(phase.deliveryEvidence.changeSet, pathContext).digest
              : null;
            publicationStabilityGuard = async () => {
              const artifact = await inspectPublicationArtifact(targetPath);
              if (artifact.sha256 !== expectedArtifactSha256) {
                throw new SingularityFlowError(
                  `The authored ${phase.id} artifact changed while publication was running. Nothing was committed; retry after the editor is stable.`,
                  {
                    code: 'PUBLICATION_SNAPSHOT_CHANGED',
                    details: { expectedArtifactSha256, currentArtifactSha256: artifact.sha256 }
                  }
                );
              }
              if (expectedConvergenceSnapshotSha256) {
                const currentConvergence = await assertConvergencePublicationReady(root, config, workflow, phase);
                if (currentConvergence.snapshotSha256 !== expectedConvergenceSnapshotSha256) {
                  throw new SingularityFlowError(
                    `The reviewed convergence projection or one of its exact inputs changed while publication was running. Nothing was committed; run singularity-flow prepare ${phase.id} again.`,
                    {
                      code: 'PUBLICATION_SNAPSHOT_CHANGED',
                      details: { nextAction: { executable: 'singularity-flow', argv: ['prepare', phase.id], label: 'Inspect or continue the retained operation; recheck before retrying.' },
                        expectedConvergenceSnapshotSha256,
                        currentConvergenceSnapshotSha256: currentConvergence.snapshotSha256
                      }
                    }
                  );
                }
              }
              let applicationDigest = null;
              if (deliveryBaseline && expectedApplicationDigest) {
                const current = await buildRepositoryChangeSet(root, {
                  baseCommit: deliveryBaseline,
                  subject: {
                    workId: workflow.workItem.id, phase: phase.id, generation: phase.generation,
                    generationIntentId: phase.generationIntent?.id ?? null
                  }
                });
                applicationDigest = applicationChangeSetProjection(current, pathContext).digest;
                if (applicationDigest !== expectedApplicationDigest) {
                  throw new SingularityFlowError(
                    'Application source or test bytes changed after validation and before the commit. '
                    + 'Nothing was committed; wait for editor, formatter, generator, and test writes to finish, then retry.',
                    {
                      code: 'PUBLICATION_SNAPSHOT_CHANGED',
                      details: { expectedApplicationDigest, currentApplicationDigest: applicationDigest }
                    }
                  );
                }
              }
              // The generic delivery digest closes ordinary editor/test races. Auto publication has a
              // stronger one-Candidate law: immediately before and after the isolated Git index is
              // staged, reproduce the exact frozen Candidate resource identity as well. This keeps
              // the lifecycle commit/event/trailer bound to the same Candidate that was verified even
              // when a concurrent writer changes source after the earlier generation preflight.
              let autoCandidateDigest = null;
              if (phase.deliveryEvidence?.autoCandidate) {
                const candidate = phase.deliveryEvidence.autoCandidate;
                const observation = await observeAutoCandidateWorktree(root, candidate, pathContext);
                assertAutoCandidateMatches(candidate, observation);
                autoCandidateDigest = `${candidate.bindingSha256}:${observation.applicationResourceDigest}`;
              }
              return `${expectedArtifactSha256}:${applicationDigest ?? 'artifact-only'}:${autoCandidateDigest ?? 'manual'}`;
            };
          },
          worktreeGuard: async () => {
            if (!publicationStabilityGuard) {
              throw new SingularityFlowError('Publication stability guard was not initialized.', {
                code: 'PUBLICATION_SNAPSHOT_CHANGED'
              });
            }
            return publicationStabilityGuard();
          },
          revisionPublication
        }
      );

      context.phase = phase;
      context.publication = result;
      return result;
    },
    async finish(context, prepared, result) {
      const {root, config, workflow, phase} = context;
      context.warnings = await (await import('../commands/input-restore.mjs'))
        .approvedArtifactDriftWarnings(root, config, workflow, phase).catch(() => []);
      return publicationFacts(context, phase, result, 'published');
    }
  };
  let submissionOwner;
  const submission = {notice};
  for (const stage of ENGINE_OPERATIONS.find(operation => operation.port === 'submission').stages) {
    submission[stage] = async (...args) => {
      submissionOwner ??= import('./git-submission.mjs')
        .then(({createGitSubmissionPort}) => createGitSubmissionPort({root,notice,onContext:context => {presentation=context;}}))
        .catch(error => {submissionOwner=undefined;throw error;});
      const owner = await submissionOwner;
      return owner[stage](...args);
    };
  }
  let approvalOwner;
  const interaction=approvalInteraction ? Object.freeze({
    ...(typeof approvalInteraction.load==='function'?{load:approvalInteraction.load.bind(approvalInteraction)}:{}),
    ...(typeof approvalInteraction.prepare==='function'?{prepare:approvalInteraction.prepare.bind(approvalInteraction)}:{})
  }) : null;
  const approval={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='approval').stages) {
    approval[stage]=async(...args)=>{
      approvalOwner ??= import('./git-approval.mjs')
        .then(({createGitApprovalPort})=>createGitApprovalPort({root,interaction,notice,onContext:context=>{presentation=context;}}))
        .catch(error=>{approvalOwner=undefined;throw error;});
      const owner=await approvalOwner;
      return owner[stage](...args);
    };
  }
  let decisionOwner;
  let rejectionOwner;
  const rejectInteraction = rejectionInteraction ? Object.freeze({
    ...(typeof rejectionInteraction.load === 'function' ? { load: rejectionInteraction.load.bind(rejectionInteraction) } : {}),
    ...(typeof rejectionInteraction.prepare === 'function' ? { prepare: rejectionInteraction.prepare.bind(rejectionInteraction) } : {})
  }) : null;
  const rejection = {};
  for (const stage of ENGINE_OPERATIONS.find(operation => operation.port === 'rejection').stages) {
    rejection[stage] = async (...args) => {
      rejectionOwner ??= import('./git-rejection.mjs').then(({ createGitRejectionPort }) => createGitRejectionPort({
        root, interaction: rejectInteraction, notice, onContext: context => { presentation = context; }
      })).catch(error => { rejectionOwner = undefined; throw error; });
      return (await rejectionOwner)[stage](...args);
    };
  }
  const decisionPreparation=typeof decisionInteraction?.prepare==='function'
    ? Object.freeze({prepare:decisionInteraction.prepare.bind(decisionInteraction)}) : null;
  const decisions={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='decisions').stages) {
    decisions[stage]=async(...args)=>{
      decisionOwner ??= import('./git-decisions.mjs')
        .then(({createGitDecisionPort})=>createGitDecisionPort({root,notice,interaction:decisionPreparation,onContext:context=>{presentation=context;}}))
        .catch(error=>{decisionOwner=undefined;throw error;});
      return (await decisionOwner)[stage](...args);
    };
  }
  let advancementOwner;
  const advancement={notice,async withReview(...args){
    advancementOwner ??= import('./git-advancement.mjs')
      .then(({createGitAdvancementPort})=>createGitAdvancementPort({root,notice,onContext:context=>{presentation=context;}}))
      .catch(error=>{advancementOwner=undefined;throw error;});
    return (await advancementOwner).withReview(...args);
  }};
  let decisionRecordOwner;
  const recordInteraction=typeof decisionRecordInteraction?.prepare==='function'
    ? Object.freeze({prepare:decisionRecordInteraction.prepare.bind(decisionRecordInteraction)}) : null;
  const decisionRecord={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='decisionRecord').stages) {
    decisionRecord[stage]=async(...args)=>{
      decisionRecordOwner ??= import('./git-decision-record.mjs')
        .then(({createGitDecisionRecordPort})=>createGitDecisionRecordPort({root,notice,interaction:recordInteraction,
          onContext:context=>{presentation=context;}}))
        .catch(error=>{decisionRecordOwner=undefined;throw error;});
      return (await decisionRecordOwner)[stage](...args);
    };
  }
  let testDecisionRecordOwner;
  const testDecisionRecord={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='testDecisionRecord').stages) {
    testDecisionRecord[stage]=async(...args)=>{
      testDecisionRecordOwner ??= import('./git-test-decision-record.mjs')
        .then(({createGitTestDecisionRecordPort})=>createGitTestDecisionRecordPort({root,interaction:recordInteraction,
          onContext:context=>{presentation=context;}}))
        .catch(error=>{testDecisionRecordOwner=undefined;throw error;});
      return (await testDecisionRecordOwner)[stage](...args);
    };
  }
  let planCorrectionOwner;
  const correctionInteraction=planCorrectionInteraction?Object.freeze(Object.fromEntries(['prepare','capture','consume']
    .filter(name=>typeof planCorrectionInteraction[name]==='function').map(name=>[name,planCorrectionInteraction[name].bind(planCorrectionInteraction)]))):null;
  const planCorrection={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='planCorrection').stages) {
    planCorrection[stage]=async(...args)=>{
      planCorrectionOwner ??= import('./git-plan-correction.mjs')
        .then(({createGitPlanCorrectionPort})=>createGitPlanCorrectionPort({root,interaction:correctionInteraction,onContext:context=>{presentation=context;}}))
        .catch(error=>{planCorrectionOwner=undefined;throw error;});
      return (await planCorrectionOwner)[stage](...args);
    };
  }
  let upstreamOwner;
  const upstream={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='upstream').stages) {
    upstream[stage]=async(...args)=>{
      upstreamOwner ??= import('./git-upstream.mjs')
        .then(({createGitUpstreamPort})=>createGitUpstreamPort({root,onContext:context=>{presentation=context;}}))
        .catch(error=>{upstreamOwner=undefined;throw error;});
      return (await upstreamOwner)[stage](...args);
    };
  }
  let phaseReviewOwner;
  const phaseReview={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='phaseReview').stages) {
    phaseReview[stage]=async(...args)=>{
      phaseReviewOwner ??= import('./git-phase-review.mjs')
        .then(({createGitPhaseReviewPort})=>createGitPhaseReviewPort({root,onContext:context=>{presentation=context;}}))
        .catch(error=>{phaseReviewOwner=undefined;throw error;});
      return (await phaseReviewOwner)[stage](...args);
    };
  }
  let documentReadOwner;
  const documentRead={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='documentRead').stages) {
    documentRead[stage]=async(...args)=>{
      documentReadOwner??=import('./git-document-read.mjs')
        .then(({createGitDocumentReadPort})=>createGitDocumentReadPort({root,onContext:context=>{presentation=context;}}))
        .catch(error=>{documentReadOwner=undefined;throw error;});
      return (await documentReadOwner)[stage](...args);
    };
  }
  let phaseEntryOwner;
  const phaseEntry={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='phaseEntry').stages) {
    phaseEntry[stage]=async(...args)=>{
      phaseEntryOwner??=import('./git-phase-entry.mjs')
        .then(({createGitPhaseEntryPort})=>createGitPhaseEntryPort({root,onContext:context=>{presentation=context;}}))
        .catch(error=>{phaseEntryOwner=undefined;throw error;});
      return (await phaseEntryOwner)[stage](...args);
    };
  }
  let phaseBeginOwner;
  const phaseBegin={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='phaseBegin').stages) {
    phaseBegin[stage]=async(...args)=>{
      phaseBeginOwner??=import('./git-phase-entry.mjs')
        .then(({createGitPhaseBeginPort})=>createGitPhaseBeginPort({root,onContext:value=>{presentation=value;}}))
        .catch(error=>{phaseBeginOwner=undefined;throw error;});
      return (await phaseBeginOwner)[stage](...args);
    };
  }
  let phasePrepublishOwner;
  const phasePrepublish={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='phasePrepublish').stages) {
    phasePrepublish[stage]=async(...args)=>{
      phasePrepublishOwner??=import('./git-phase-entry.mjs')
        .then(({createGitPhasePrepublishPort})=>createGitPhasePrepublishPort({root,onContext:value=>{presentation=value;}}))
        .catch(error=>{phasePrepublishOwner=undefined;throw error;});
      return (await phasePrepublishOwner)[stage](...args);
    };
  }
  let phaseDraftCheckOwner;
  const phaseDraftCheck={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='phaseDraftCheck').stages) {
    phaseDraftCheck[stage]=async(...args)=>{
      phaseDraftCheckOwner??=import('./git-phase-entry.mjs')
        .then(({createGitPhaseDraftCheckPort})=>createGitPhaseDraftCheckPort({root,onContext:value=>{presentation=value;}}))
        .catch(error=>{phaseDraftCheckOwner=undefined;throw error;});
      return (await phaseDraftCheckOwner)[stage](...args);
    };
  }
  let phaseRolloverOwner;
  const phaseRollover={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='phaseRollover').stages) {
    phaseRollover[stage]=async(...args)=>{
      phaseRolloverOwner??=import('./git-phase-entry.mjs')
        .then(({createGitPhaseRolloverPort})=>createGitPhaseRolloverPort({root,onContext:value=>{presentation=value;}}))
        .catch(error=>{phaseRolloverOwner=undefined;throw error;});
      return (await phaseRolloverOwner)[stage](...args);
    };
  }
  let phasePreparationOwner;
  const phasePreparation={};
  for(const stage of ENGINE_OPERATIONS.find(operation=>operation.port==='phasePreparation').stages) {
    phasePreparation[stage]=async(...args)=>{
      phasePreparationOwner??=import('./git-phase-entry.mjs')
        .then(({createGitPhasePreparationPort})=>createGitPhasePreparationPort({root,onContext:value=>{presentation=value;}}))
        .catch(error=>{phasePreparationOwner=undefined;throw error;});
      return (await phasePreparationOwner)[stage](...args);
    };
  }
  const engine = createEngine({ports:{publication:port, submission, approval, rejection, decisions, advancement, decisionRecord, testDecisionRecord, planCorrection, upstream, phaseReview, documentRead, phaseEntry, phaseBegin, phasePrepublish, phaseDraftCheck, phaseRollover, phasePreparation, invocation: {
    // A long-lived SDK host can call from an advisory read or configuration preview. Each writer
    // starts without that caller's mutable observations; authenticated operation context remains.
    run: callback => withoutConfigurationReadScope(() => withoutReadScope(callback))
  }}});
  return Object.freeze({ engine, presentation: () => presentation, notifications: () => Object.freeze([...notifications]) });
}
