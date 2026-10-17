/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { requirePositional, SingularityFlowError, optionString, optionBoolean, readJson, optionStrings } from '../util.mjs';
import { repoRoot } from '../git.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { generationRecovery } from '../recovery-plan.mjs';
import { generationResultMatches, generationResultDigest, beginPhaseGeneration, saveStoryDraft, prefetchStoryPublicationObservation, workDir, scanArtifacts, commitAndPublish, publishGeneration } from '../state-stores.mjs';
import { safeCommandGuidance, commandGuidanceLines } from '../safe-command-guidance.mjs';
import { nextPhaseGeneration } from '../phase-generation.mjs';
import { printCommandRoutes } from './shared/print-command-routes.mjs';
import { storyDraftTransaction } from './shared/story-draft-transaction.mjs';
import { verifyOpenGenerationIntent, generationStartPublicationBinding } from '../generation-boundary.mjs';
import { phaseReview } from './shared/phase-review.mjs';
import { printPhaseReview } from './shared/print-phase-review.mjs';
import { loadSession } from '../session.mjs';
import { phasePrepublish, prepublishTestExecutionLines } from '../phase-prepublish.mjs';
import { publishedGenerationCommit } from '../generation-publication-store.mjs';
import { phaseDraftCheck } from '../phase-draft-check.mjs';
import { operationContext } from '../operation-context.mjs';
import { phaseRequiresCodeDelivery, generationSkillForPhase } from '../code-delivery-policy.mjs';
import { effectivePhasePublicationProducer, normalizeAuthorshipOptions, assertProducerAllowed, inspectDeterministicInPlaceArtifact, inspectInPlaceArtifact, importManualArtifact, buildGenerationAuthorship } from '../manual-authorship.mjs';
import { isConvergencePhase } from '../phase-roles.mjs';
import { actionActor } from './kernel.mjs';
import path from 'node:path';
import { directCopilotSkill } from '../copilot-guidance.mjs';
import { assertConvergencePublicationReady } from '../convergence-context.mjs';
import { listModelInvocations } from '../model-runner.mjs';
import { currentInteractiveRevisionPublication } from '../revision/publication-adapter.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { applicationPathContext, applicationChangeSetProjection } from '../work-intervals.mjs';
import { buildRepositoryChangeSet } from '../repository-change-set.mjs';
import { observeAutoCandidateWorktree, assertAutoCandidateMatches } from '../auto/auto-candidate.mjs';
import * as style from '../style.mjs';
import { pendingTelemetryNote } from '../telemetry.mjs';
import { postPublicationStep } from './shared/post-publication-step.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { measureCommandSpan } from '../dx-timing-context.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => phaseCommand(positionals, options)));
}

export async function phaseCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'phase subcommand');
  if (subcommand === 'prepublish' && options['publish-if-ready'] === true) return (await import('./phase-publish-if-ready.mjs')).run({ positionals, options });
  if (subcommand === 'show') return (await import('./phase-show.mjs')).phaseShowCommand(positionals, options);
  const root = repoRoot();
  const accepted = await loadAcceptedStoryExecution(root);
  const config = accepted.definition;
  const workflow = accepted.workflow;
  if (subcommand === 'rollover') {
    const phaseId = positionals[2] ?? workflow.currentPhase;
    const phase = workflow.phases[phaseId];
    if (!phase) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`);
    const plan = await generationRecovery(
      root, workflow, phase,
      async (repositoryRoot, selectedPhase) => await generationResultMatches(
        repositoryRoot, config, workflow, selectedPhase
      )
        ? selectedPhase.generationIntent.publication.resultDigest
        : generationResultDigest(repositoryRoot, config, workflow, selectedPhase)
    );
    if (plan?.action.id === `return-submitted-generation:${phase.id}`) throw new SingularityFlowError(
      'Return the submitted packet through authorized rejection before opening a successor; direct rollover is not legal while awaiting approval.',
      { code: 'GENERATION_ROLLOVER_REVIEW_REQUIRED', details: { actions: [plan.action] } }
    );
    if (!plan || plan.action.mode === 'manual' || !plan.action.command) {
      throw new SingularityFlowError(
        plan?.action.detail ?? `Phase '${phaseId}' has no changed consumed generation to roll over.`,
        { code: 'GENERATION_ROLLOVER_UNAVAILABLE', details: plan ?? null }
      );
    }
    const expected = plan.blocker.details.rolloverConfirmation;
    const route = safeCommandGuidance(plan.action);
    if (!route) throw new SingularityFlowError(
      'The reviewed rollover action has no validated Shell and Copilot route. Re-run recovery before changing state.',
      { code: 'GENERATION_ROLLOVER_ROUTE_UNAVAILABLE', details: { action: plan.action } }
    );
    const supplied = optionString(options, 'confirm');
    const preview = {
      schemaVersion: 1,
      workId: workflow.workItem.id,
      phase: phase.id,
      fromGeneration: phase.generation,
      toGeneration: nextPhaseGeneration(phase),
      confirmation: expected,
      changeSetDigest: plan.blocker.details.changeSetDigest,
      currentResultDigest: plan.blocker.details.currentResultDigest,
      command: route.command,
      executable: route.executable,
      argv: route.argv,
      skill: route.skill,
      copilotCommand: route.copilotCommand,
      platformCommands: route.platformCommands,
      mutates: Boolean(supplied)
    };
    if (!supplied) {
      if (optionBoolean(options, 'json')) console.log(JSON.stringify(preview, null, 2));
      else {
        console.log(`Generation rollover preview for ${phase.id}: ${phase.generation} -> ${nextPhaseGeneration(phase)}.`);
        console.log(`Confirm exact current bytes: ${expected}`);
        printCommandRoutes(route, { label: 'Continue' });
        console.log('Nothing was changed.');
      }
      return;
    }
    if (supplied !== expected) {
      throw new SingularityFlowError(
        `Generation rollover confirmation must equal the current digest ${expected}. Re-run the preview if files are still changing.`,
        { code: 'GENERATION_ROLLOVER_STALE', details: preview }
      );
    }
    const intent = await storyDraftTransaction(root, config, workflow, `phase-rollover:${phaseId}`, async () => {
      const opened = await beginPhaseGeneration(root, config, workflow, {
        phaseId,
        adoptExisting: Boolean(plan.blocker.details.changeSetDigest),
        confirm: plan.blocker.details.changeSetDigest
      });
      await saveStoryDraft(root, config, workflow);
      await verifyOpenGenerationIntent(root, workflow, phase);
      return opened;
    });
    const result = { ...preview, mutates: true, generationIntent: intent };
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`Opened ${phase.id} generation ${intent.generation} from exact confirmed bytes. The previous generation remains preserved.`);
    return;
  }
  if (subcommand === 'begin') {
    const phaseId = positionals[2] ?? workflow.currentPhase;
    const phase = workflow.phases[phaseId];
    if (!phase) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`);
    const existing = phase.generationIntent;
    if (existing?.status === 'open' && Number(existing.generation) === nextPhaseGeneration(phase)) {
      await verifyOpenGenerationIntent(root, workflow, phase);
      if (optionBoolean(options, 'json')) console.log(JSON.stringify(existing, null, 2));
      else console.log(`Generation intent ${existing.id} is already open for ${phase.id} generation ${existing.generation}.`);
      return;
    }
    const generation = nextPhaseGeneration(phase);
    const intent = await storyDraftTransaction(root, config, workflow, `phase-begin:${phaseId}`, async () => {
      const opened = await beginPhaseGeneration(root, config, workflow, {
        phaseId,
        adoptExisting: optionBoolean(options, 'adopt-existing') || optionBoolean(options, 'adopt-current-interval'),
        confirm: optionString(options, 'confirm')
      });
      // Generation begin is a local authoring boundary, not lifecycle authority. Persist the
      // workflow and receipt without a commit, but with a hard-crash recovery journal.
      await saveStoryDraft(root, config, workflow);
      await verifyOpenGenerationIntent(root, workflow, phase);
      return opened;
    });
    const output = { ...intent, local: true, lifecycleEvent: null };
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(output, null, 2));
    else console.log(`Began ${phaseId} generation ${generation} with local intent ${intent.id}. The receipt will be bound into the generation publication.`);
    return;
  }
  if (subcommand === 'draft-check' || subcommand === 'prepublish') {
    const phaseId = positionals[2] ?? workflow.currentPhase;
    const phase = workflow.phases[phaseId];
    if (!phase) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`);
    if (phaseId !== workflow.currentPhase && !['in_progress', 'awaiting_approval'].includes(phase.status)) {
      throw new SingularityFlowError(
        `Phase '${phaseId}' is not the active review draft. Check '${workflow.currentPhase ?? 'none'}' instead.`,
        { code: 'PHASE_DRAFT_NOT_ACTIVE', details: { requestedPhase: phaseId, currentPhase: workflow.currentPhase } }
      );
    }
    const session = await loadSession(root, { required: false });
    const check = subcommand === 'prepublish' ? phasePrepublish : phaseDraftCheck;
    const result = await check(root, config, workflow, phase, {
      modelEnabled: operationContext()?.modelMode.enabled !== false,
      session
    });
    if (optionBoolean(options, 'for-agent')) {
      const { phaseAgentResult } = await import('../phase-agent-result.mjs');
      return console.log(JSON.stringify(phaseAgentResult(result)));
    }
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    const pendingTests = subcommand === 'prepublish'
      && result.testExecution?.status === 'not-run';
    console.log(`${phase.label} ${subcommand === 'prepublish' ? 'prepublish' : 'draft'}: ${result.status}${pendingTests && result.status === 'ready' ? ' for a publication attempt' : ''}.`);
    if (result.artifact) console.log(`Artifact: ${result.artifact.path}${result.artifact.sha256 ? ` · ${result.artifact.sha256}` : ''}`);
    if (pendingTests) for (const line of prepublishTestExecutionLines(result.testExecution)) console.log(line);
    if (result.qualityDisposition === 'accepted-risk') console.log('Document quality: unmet, accepted risk for the exact reviewed bytes. Tests, independent review and approval remain required.');
    for (const finding of result.findings) console.log(`  - ${finding.message}`);
    for (const warning of result.warnings ?? result.grounding?.warnings ?? []) console.log(`Readiness warning: ${warning}`);
    const coverageAdvisories = (result.advisories ?? []).filter((advisory) => advisory.category === 'coverage');
    if (coverageAdvisories.length) {
      console.log(`Coverage warnings: approval would refuse ${result.coverage?.unclaimed ?? coverageAdvisories.length} changed path(s). Name each in a clause's Expected paths, or under ## Supporting files in the plan if it cannot carry a @clause tag.`);
      for (const advisory of coverageAdvisories.slice(0, 10)) console.log(`  · ${advisory.message}`);
    }
    const documentationAdvisories = (result.advisories ?? []).filter((advisory) => advisory.category !== 'coverage');
    if (documentationAdvisories.length) {
      console.log(`Documentation advisories (never block publication): ${result.documentation.undocumented} public declaration(s) without a doc comment.`);
      for (const advisory of documentationAdvisories.slice(0, 10)) console.log(`  · ${advisory.message}`);
      if (result.documentation.undocumented > 10) console.log(`  · …and ${result.documentation.undocumented - 10} more (--json lists up to 50).`);
      console.log(`Documentation: ${result.documentation.guidance}`);
    } else if (result.documentation?.status === 'unavailable') {
      console.log(`Documentation advisories: the check could not run (${result.documentation.reason ?? 'unknown reason'}); it never blocks publication.`);
    }
    if (result.status === 'correction-required') {
      console.log(`Correction: ${result.correction.guidance}`);
      for (const [id, label] of [['next', 'Next'], ['recover', 'Recover'], ['recheck', 'Recheck']]) {
        for (const line of commandGuidanceLines(result.commandGuidance[id], label)) console.log(line);
      }
    } else {
      for (const line of commandGuidanceLines(result.commandGuidance.publish, 'Publish')) console.log(line);
    }
    return;
  }
  if (subcommand !== 'publish') throw new SingularityFlowError(`Unknown phase subcommand: ${subcommand}`);
  const usageFile = optionString(options, 'usage-json'); const usage = usageFile ? await readJson(usageFile) : null;
  const phaseId = positionals[2] ?? workflow.currentPhase;
  const requestedPhase = workflow.phases[phaseId];
  if (!requestedPhase) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`);
  if (phaseRequiresCodeDelivery(requestedPhase)
      && requestedPhase.generationIntent?.status === 'consumed'
      && Number(requestedPhase.generationIntent.generation) === Number(requestedPhase.generation)) {
    if (!(await generationResultMatches(root, config, workflow, requestedPhase))) {
      throw new SingularityFlowError(
        `Generation intent ${requestedPhase.generationIntent.id} was already consumed and the source or artifact bytes now differ. Run singularity-flow phase rollover ${phaseId} to preview the exact guarded next-generation command.`,
        { code: 'GENERATION_INTENT_ALREADY_CONSUMED' }
      );
    }
    if (optionBoolean(options, 'json')) {
      console.log(JSON.stringify({
        schemaVersion: 1, resultType: 'sflow-phase-publication', status: 'retained',
        workId: workflow.workItem.id, phase: requestedPhase.id, generation: requestedPhase.generation,
        commit: publishedGenerationCommit(root, workflow, requestedPhase),
        pushed: false, effects: { committed: false, pushed: false },
        remoteSynchronization: 'not-checked', artifact: requestedPhase.requiredArtifact.path
      }));
      return;
    }
    console.log(`Published ${requestedPhase.id} generation ${requestedPhase.generation} already exists; the idempotent retry created no commit.`);
    printPhaseReview(await phaseReview(root, config, workflow, requestedPhase), { showArtifact: optionBoolean(options, 'show-artifact') });
    return;
  }
  const sourcePath = optionString(options, 'from');
  const explicitAuthored = optionString(options, 'authored');
  const implicitProducer = effectivePhasePublicationProducer(requestedPhase, {
    modelEnabled: operationContext()?.modelMode.enabled !== false
  });
  // A deterministic default is an exact contract, not legacy provenance. Preserve the historical
  // omission warning elsewhere while preventing a missing flag from disabling deterministic
  // publication checks.
  const authored = explicitAuthored ?? (implicitProducer === 'deterministic' ? 'deterministic' : null);
  const requestedChangeOrigins = optionStrings(options, 'change-origin');
  const authorshipOptions = normalizeAuthorshipOptions({
    producer: authored,
    channel: optionString(options, 'channel'),
    imported: Boolean(sourcePath),
    externalAiUse: optionString(options, 'external-ai'),
    changeOrigins: requestedChangeOrigins.length ? requestedChangeOrigins : null
  });
  if (!explicitAuthored && authored !== 'deterministic') console.warn('Deprecation warning: phase publish without --authored records legacy-unspecified. Pass --authored human or --authored governed-agent.');
  if (isConvergencePhase(requestedPhase) && sourcePath) {
    throw new SingularityFlowError(
      `The convergence artifact is a kernel-owned deterministic projection and cannot be imported. Run singularity-flow prepare ${requestedPhase.id}.`,
      { code: 'CONVERGENCE_ARTIFACT_KERNEL_OWNED' }
    );
  }
  if (sourcePath && !['human', 'external-tool'].includes(authorshipOptions.producer)) {
    throw new SingularityFlowError('--from requires --authored human or --authored external-tool.', { code: 'MANUAL_AUTHORSHIP_REQUIRED' });
  }
  if (usageFile && authorshipOptions.producer !== 'governed-agent') {
    throw new SingularityFlowError('--usage-json is valid only with --authored governed-agent. Manual and deterministic publication record model usage as not-invoked.');
  }
  assertProducerAllowed(requestedPhase, authorshipOptions.producer);
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
  if (!sourcePath) await measureCommandSpan('publication.preflight', () => inspectPublicationArtifact(targetPath));
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
  let phase = requestedPhase;
  let publicationStabilityGuard = null;
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
          actor: session.actor,
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
                  details: {
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
                'Application source or test bytes changed after validation and before the governed commit. '
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
  if (optionBoolean(options, 'json')) {
    // Publication is complete here. A GUI needs the exact receipt, not a second expensive review
    // projection before it can acknowledge success. Documents remain available on explicit request.
    console.log(JSON.stringify({
      schemaVersion: 1, resultType: 'sflow-phase-publication', status: 'published',
      workId: workflow.workItem.id, phase: phase.id, generation: phase.generation,
      commit: result.sha, pushed: result.pushed === true,
      effects: { committed: true, pushed: result.pushed === true },
      artifact: phase.requiredArtifact.path
    }));
    return;
  }
  console.log(`Published ${phase.id} generation ${phase.generation} at ${result.sha.slice(0, 8)}${result.pushed ? ' and pushed' : ''}${result.revisionSelection ? ` from REV Candidate ${result.revisionSelection.candidateId}` : ''}.`);
  const telemetry = (phase.telemetry ?? []).find((item) => item.generation === phase.generation);
  const generationUsage = (phase.usage ?? []).filter((item) => item.generation === phase.generation);
  const tokens = generationUsage.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0);
  const costs = generationUsage.map((item) => item.providerCost).filter(Number.isFinite);
  const providerCost = costs.length ? costs.reduce((sum, value) => sum + value, 0) : null;
  if (telemetry) {
    const unavailable = telemetry.status === 'not-invoked' ? 'not invoked' : 'unavailable';
    console.log(style.fields(
      `Telemetry: ${telemetry.status}`,
      `models: ${telemetry.models.join(', ') || unavailable}`,
      `tokens: ${tokens || unavailable}`,
      `provider cost: ${providerCost == null ? unavailable : `$${providerCost.toFixed(6)}`}`
    ));
    const activity = telemetry.activity;
    const prompt = telemetry.prompt;
    if (activity || prompt) {
      const events = (activity?.events ?? []).reduce((sum, event) => sum + event.count, 0);
      console.log(style.fields(
        ...(activity ? [
          `Copilot requests: ${activity.requests ?? 'unavailable'}`,
          `turns: ${activity.turns ?? 'unavailable'}`,
          `tool calls: ${activity.toolCalls}`,
          ...(events ? [`quota/model events: ${events}`] : [])
        ] : []),
        ...(prompt ? [`governed prompt: ${prompt.bytes.toLocaleString('en-US')} bytes (~${prompt.estimatedTokens.toLocaleString('en-US')} tokens)`] : [])
      ));
    }
    console.log(`Telemetry record: ${telemetry.path}`);
    if (telemetry.status === 'pending') console.log(pendingTelemetryNote(telemetry.captureGap));
  }
  const publishedReview = await postPublicationStep(
    'the phase review projection', workflow.workItem.id,
    () => phaseReview(root, config, workflow, phase)
  );
  if (publishedReview.ok) {
    printPhaseReview(publishedReview.value, { showArtifact: optionBoolean(options, 'show-artifact') });
  }
}
