/** Native Git generation transition extracted intact from the aggregate; not an SDK port contract. */
import { answeredMarkerHashes, resolvedClarificationPolicy } from '../clarifications.mjs';
import { applicationPathContext } from '../work-intervals.mjs';
import { artifactFindingMessage, inspectPhaseAuthoredReviewContent } from '../publication-preflight.mjs';
import { artifactSetDiff, catalogArtifactSet, disclosureLines, resolvedArtifactSet } from '../artifact-sets.mjs';
import { assertAstLifecycleGate, evaluateAstLifecycleGate, persistAstLifecycleReceipt } from '../ast-lifecycle.mjs';
import { assertAutoCandidateMatches, autoCandidatePublicationFromEnvironment, observeAutoCandidateWorktree } from '../auto/auto-candidate.mjs';
import { assertConvergencePublicationReady } from '../convergence-context.mjs';
import { assertIntentAmendmentAcknowledged } from '../source-review-policy.mjs';
import { assertNoPendingPublication } from '../story-publication-pending.mjs';
import { assertPhaseAgentMayMutate } from '../phase-actor-policy.mjs';
import { assertPhasePublicationReadiness } from '../phase-publication-readiness.mjs';
import { assertPhaseSequence, phaseNeedsGeneration, phasePublicationCommandForMode } from '../sequence.mjs';
import { assertProducerAllowed } from '../kernel/phase-policy.mjs';
import { phasePublicationCommand } from '../phase-publication-guidance.mjs';
import { assertReviewCodeEvidenceFresh, evaluateCodeDeliveryPreflight, phaseRequiresCodeDelivery, resolveDeliveryQualityCommands } from '../delivery-evidence.mjs';
import { assertStoryNotArchived } from '../governance-archive.mjs';
import { buildArtifactSidecar, serializeArtifactSidecar, sidecarRelativePath } from '../artifact-sidecar.mjs';
import { citedArticleIds, validateCitations } from '../constitution.mjs';
import { collectCopilotUsage, phaseTelemetrySummary, recordPhaseTelemetry, telemetryCaptureGap } from '../telemetry.mjs';
import { consumeGenerationIntent, persistGenerationPublicationRecord, verifyOpenGenerationIntent } from '../generation-boundary.mjs';
import { createAgentBriefs, planAgentBriefs } from '../agent-briefs.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';
import { directCopilotSkill } from '../copilot-guidance.mjs';
import { evaluateSpecificationGate, specificationGateDiagnostics } from '../specification-gate.mjs';
import { generationSkillForPhase, storyTestScope } from '../code-delivery-policy.mjs';
import { head, identity } from '../git.mjs';
import { isConformancePhase, isConvergencePhase } from '../kernel/phase-policy.mjs';
import { loadSession } from '../session.mjs';
import { nextPhaseGeneration } from '../kernel/phase-policy.mjs';
import { nowIso, posix, SingularityFlowError, writeJson, writeText } from '../util.mjs';
import path from 'node:path';
import { requiredRepoPath } from '../story-state-validation.mjs';
import { resolveStoryExecutionCatalog } from '../story-execution-context.mjs';
import { resolveTrpDeliverySelection } from '../trp-delivery-selection.mjs';
import { saveWorkflow } from '../story-state-write.mjs';
import { updateRemoteOutputRenderedHashes } from '../agents.mjs';
import { verifyAcceptedTestCommandAmendment } from '../story-test-command-amendment.mjs';
import { verifySkillPhasePublication } from '../skp-phase-evidence.mjs';
import { workDir, workDirRelative } from '../story-paths.mjs';

export async function publishNativeGeneration(root, config, workflow, {
  phaseId, usage: rawUsage, authorship = null, persist = true, publicationTransaction = null
} = {}, collaborators) {
  const {
    actorKey,
    addUsageAggregate,
    assertPassedCodeDeliveryInput,
    assertPhaseChangeScope,
    assertPlannedSpecificationClaims,
    assertQualifiedConformanceReady,
    assertRequiredArtifactSetPublishable,
    assertRequiredAssignment,
    assertSkillPhaseHostReady,
    assertStoryTestRecoveryFeatureAdmission,
    assertUncodedPlanSupportingFiles,
    generationResultDigest,
    generationResultMatches,
    MODEL_ASSURANCE_RANK,
    normalizeUsage,
    preflightCodeDeliveryTests,
    preparePhaseInputs,
    readArtifactText,
    refreshPhaseSpecificationIndex,
    refreshPlannedSpecificationClaims,
    requiredModelAssuranceRank,
    scanArtifacts,
    sourceTreeHash,
    testInputTreeHash,
    updateArtifactMetadata,
    validatePhase
  } = collaborators;
  assertStoryNotArchived(root, workflow);
  if (workflow.workflowSnapshot) config = (await resolveStoryExecutionCatalog(root, config, workflow)).effectiveDefinition;
  const selectedSession = await loadSession(root, { required: false });
  assertPhaseAgentMayMutate(config, workflow, workflow.phases?.[phaseId ?? workflow.currentPhase],
    selectedSession, 'publish');
  assertIntentAmendmentAcknowledged(workflow);
  if (authorship?.governedAgentContext?.agentId) assertPhaseAgentMayMutate(config, workflow,
    workflow.phases?.[phaseId ?? workflow.currentPhase], { agent: authorship.governedAgentContext.agentId }, 'publish');
  await verifyAcceptedTestCommandAmendment(root, config, workflow);
  if (workflow.resolution?.presence) await (await import('../story-test-command-amendment.mjs')).assertSignedTestCommandAmendments(workflow);
  await assertNoPendingPublication(root, config, workflow, 'publish a generation');
  const phase = await assertPhaseSequence(root, workflow, 'publish a generation', { requestedPhase: phaseId });
  await (await import('../document-runtime.mjs')).requirePhaseDocuments(root, config, workflow, phase.id);
  const { assertStoryDocumentRiskGates } = await import('../trp-document-runtime.mjs');
  await assertStoryDocumentRiskGates(root, config, workflow, phase, 'publish');
  await assertStoryTestRecoveryFeatureAdmission(root, config, workflow, phase);
  await assertSkillPhaseHostReady(workflow, phase, 'publish');
  // Deterministic generation is kernel-owned and deliberately carries no phase-agent session.
  // Its explicit authorship still binds the human Git identity that invoked the publication.
  const session = authorship?.producer === 'deterministic'
    ? { actor: authorship.actor ?? identity(root), agent: null }
    : selectedSession ?? await loadSession(root);
  if (phaseRequiresCodeDelivery(phase)
      && phase.generationIntent?.status === 'consumed'
      && Number(phase.generationIntent.generation) === Number(phase.generation)) {
    if (!phaseNeedsGeneration(workflow, phase)
        && await generationResultMatches(root, config, workflow, phase)) return phase;
    throw new SingularityFlowError(
      `Generation intent ${phase.generationIntent.id} was already consumed and the source or artifact bytes now differ. Run singularity-flow phase rollover ${phase.id} to preview the exact guarded next-generation command.`,
      { code: 'GENERATION_INTENT_ALREADY_CONSUMED', details: { nextAction: `singularity-flow phase rollover ${phase.id}` } }
    );
  }
  const generationIntent = await verifyOpenGenerationIntent(root, workflow, phase);
  assertRequiredAssignment(workflow, phase);
  const verifiedCodeInput = await assertPassedCodeDeliveryInput(root, config, workflow, phase);
  await assertReviewCodeEvidenceFresh(root, config, workflow, phase, { verifiedCodeInput });
  // Resolve and validate authorship before any content, test, brief, input, telemetry, or lifecycle
  // write. A wrong producer is a preflight refusal and must not leave partial recovery state.
  let effectiveAuthorship = authorship ?? {
    schemaVersion: currentSchemaVersion('artifact-authorship'), producer: 'legacy-unspecified', channel: 'legacy', actor: structuredClone(session.actor),
    governedAgentContext: session.agent ? { agentId: session.agent } : null,
    kernelModel: { invoked: false, status: 'unavailable', invocationIds: [] },
    externalAiUse: { value: 'unknown', status: 'unavailable' }, source: null
  };
  if (workflow.executionOrigin?.mode === 'auto') {
    effectiveAuthorship = {
      ...effectiveAuthorship,
      executionOrigin: structuredClone(workflow.executionOrigin)
    };
  }
  assertProducerAllowed(phase, effectiveAuthorship.producer);
  // Convergence is a kernel-owned projection regardless of which legacy/mixed producer label an
  // upgraded workflow carried. Never let an alternate or omitted producer bypass exact review,
  // source, fact, and artifact validation.
  const deterministicConvergence = isConvergencePhase(phase);
  if (deterministicConvergence) {
    await assertConvergencePublicationReady(root, config, workflow, phase);
  }
  // Template completeness is a publication preflight, not a late transaction failure. In
  // particular, do this before `preparePhaseInputs` records context or the generation counter,
  // sidecars and telemetry begin to move. An untouched prepared template should cost the author one
  // clear correction, not leave a half-started generation that produces the same adoption warning
  // on every retry.
  // Use the same authored-byte boundary as manual import and recovery. Report every deterministic
  // authoring blocker together so a host can repair the artifact once instead of chasing one
  // first-error failure per retry.
  // The convergence body is a byte-for-byte kernel projection and may legitimately quote text such
  // as "TODO remains" from evidence. Its exact projection check above supersedes human-template
  // placeholder heuristics; asking a user to edit those bytes would itself violate the contract.
  const contentFindings = deterministicConvergence
    ? []
    : await inspectPhaseAuthoredReviewContent(root, config, workflow, phase,
      { transition: 'publish', generation: publicationTransaction?.publicationEvent?.generation ?? null });
  if (contentFindings.length) {
    throw new SingularityFlowError(
      `Phase ${phase.id} generation is not publishable:\n- ${contentFindings.map(artifactFindingMessage).join('\n- ')}\n`
      + `Complete the listed review artifact(s), then run singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json. `
      + 'A Copilot host may re-author and retry publication once only after the artifact fingerprint changes.',
      {
        code: 'ARTIFACT_AUTHORING_INCOMPLETE',
        details: {
          subjectKind: 'story',
          workId: workflow.workItem.id,
          phase: phase.id,
          findings: contentFindings,
          fingerprint: contentFindings.find((finding) => finding.fingerprint)?.fingerprint ?? null,
          retry: {
            skill: directCopilotSkill(generationSkillForPhase(phase, workflow)), maximumAttempts: 1, requiresFingerprintChange: true,
            command: phasePublicationCommandForMode(phase) ?? phasePublicationCommand(phase)
          }
        }
      }
    );
  }
  // Specification structure/markers are preflight too: before managed input rendering, tests,
  // telemetry or generation writes. The gate reads the recorded clarification for this generation.
  const gate = await evaluateSpecificationGate(root, config, workflow, phase, {
    generation: nextPhaseGeneration(phase),
    artifactRelativePath: requiredRepoPath(config, workflow, phase),
    namespace: (workflow.resolution?.spec ?? config.spec)?.namespace ?? null
  });
  gate.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (gate.errors.length) {
    const clarification = specificationGateDiagnostics(gate, requiredRepoPath(config, workflow, phase)).findings.some(finding => finding.category === 'clarification');
    throw new SingularityFlowError(
      `Phase ${phase.id} is not publishable:\n- ${gate.errors.join('\n- ')}\n`
      + (clarification
        ? resolvedClarificationPolicy(config, workflow, phase).mode === 'off'
          ? `Replace each cited clarification marker with content sourced from the pinned evidence; clarification is off for ${phase.id}, so no question is recorded.`
          : `Resolve only the cited clarification questions and record their actual answers with singularity-flow clarification record ${phase.id}; do not invent or repeat answered questions.`
        : `Repair the listed specification draft structure from the pinned source and clarifications, then rerun singularity-flow phase prepublish ${phase.id} --json. Missing scenarios are author corrections, not a new clarification interview.`),
      // A draft-structure refusal gets a code of its own, so its plan names the recheck rather than
      // the generic recover/doctor route; a clarification refusal keeps its own wording.
      clarification ? undefined : { code: 'SPEC_PUBLICATION_GATE_REFUSED', details: { phase: phase.id } }
    );
  }
  // Required artifact-set members are part of the declared publication bundle. Refuse before
  // inputs, briefs, telemetry, or generation state are written; a warning after cataloguing is
  // too late for the author to repair this generation safely.
  const requiredSet = resolvedArtifactSet(config, workflow, phase);
  if (requiredSet) {
    const catalog = await catalogArtifactSet(root, workDirRelative(config, workflow.workItem.id), phase, requiredSet);
    await assertRequiredArtifactSetPublishable(root, phase, catalog);
  }
  await assertQualifiedConformanceReady(root, config, workflow, phase, 'publish a generation');
  await assertUncodedPlanSupportingFiles(root, config, workflow, phase);
  // A code-generation phase must deliver code and acceptance-mapped tests. This is deliberately
  // before prompt/input preparation and telemetry capture: an artifact-only attempt is a refused
  // preflight, not a half-started generation that has to be repaired in durable state.
  if (phaseRequiresCodeDelivery(phase)) {
    await assertPlannedSpecificationClaims(root, config, workflow, phase);
  }
  let deliveryPreflight = await evaluateCodeDeliveryPreflight(root, config, workflow, phase, { requireReconciled: true });
  const dependencyOptions = { producer: effectiveAuthorship.producer,
    generation: nextPhaseGeneration(phase), agent: session.agent };
  let dependencies = await assertPhasePublicationReadiness(root, config, workflow, phase, dependencyOptions);
  // Execute the exact structured test command before consuming the generation intent. Submission
  // reuses this run while nothing it depends on moved [TCE:REQ-080], and command inference, test discovery, and
  // result-adapter incompatibility must be found while the current generation is still editable.
  // Otherwise the only way to repair a bad adapter is to mutate bytes after publication and enter
  // generation recovery for a failure the kernel could have detected earlier.
  if (deliveryPreflight) {
    await preflightCodeDeliveryTests(root, config, workflow, phase, deliveryPreflight);
    const testedSelection = deliveryPreflight.trpSelection ?? null;
    const testedRisk = deliveryPreflight.testRecovery ?? null;
    const testedAttempts = deliveryPreflight.preflightAttempts ?? [];
    const testedRunRisks = deliveryPreflight.testRunRisks ?? null;
    // Tests are repository-owned programs and may generate or rewrite files. Rebind delivery
    // evidence after they finish so publication never commits bytes that were absent from the
    // preflight change set or retains hashes for bytes the test command changed.
    deliveryPreflight = await evaluateCodeDeliveryPreflight(root, config, workflow, phase, { requireReconciled: true });
    if (testedSelection) {
      const commands = await resolveDeliveryQualityCommands(root, { ...phase, deliveryEvidence: deliveryPreflight },
        { executionMode: storyTestScope(workflow) });
      const refreshed = await resolveTrpDeliverySelection(root, config, workflow, phase, deliveryPreflight, commands,
        { previewOnly: true });
      // The selector owns the semantic source/command binding. Its own generated
      // manifest and volatile capture timestamps must not invalidate that binding.
      if (!refreshed.preview?.ready || refreshed.preview.planDigest !== testedSelection.planDigest) {
        throw new SingularityFlowError('The candidate changed after its approved test selection ran. Review the new selection before publication.',
          { code: 'TRP_TEST_SELECTION_STALE' });
      }
      deliveryPreflight.trpSelection = testedSelection;
    }
    if (testedRisk) deliveryPreflight.testRecovery = testedRisk;
    if (testedRunRisks) deliveryPreflight.testRunRisks = testedRunRisks;
    deliveryPreflight.preflightAttempts = testedAttempts;
  }
  // Auto adds an exact constraint to the ordinary Story transaction; it never owns a second
  // publication path. Re-read the immutable Candidate after all preflight tests and before the
  // first Story mutation so test/source drift cannot be adopted as a new Candidate implicitly.
  const autoPublication = await autoCandidatePublicationFromEnvironment(root);
  const autoCandidate = autoPublication?.binding ?? null;
  const autoCandidateVerification = autoPublication?.verification ?? null;
  if (autoCandidate) {
    if (!deliveryPreflight) {
      throw new SingularityFlowError(
        'Auto Candidate publication requires a code-delivery phase with exact source evidence.',
        { code: 'AUTO_CANDIDATE_DELIVERY_REQUIRED' }
      );
    }
    assertAutoCandidateMatches(autoCandidate, await observeAutoCandidateWorktree(
      root, autoCandidate, applicationPathContext(config, workflow)
    ));
  }
  // Downstream briefs are derived later from the exact published bytes, but their authored
  // heading contract can be validated now. This keeps ambiguity, missing preserved sections, and
  // size-bound failures on the no-mutation side of the publication boundary.
  await planAgentBriefs(root, workflow, phase, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id),
    generation: nextPhaseGeneration(phase)
  });
  // Repository-owned tests may change dependency bytes too. Recheck before input/Story writes.
  if (deliveryPreflight) dependencies = await assertPhasePublicationReadiness(root, config, workflow, phase, dependencyOptions);
  dependencies.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  const { clarification } = dependencies;
  await preparePhaseInputs(root, config, workflow, phase.id);
  // Grounding and telemetry preserve the existing legacy behavior. Clarification is narrower:
  // only explicit governed-agent authorship proves that an interactive model path ran and must
  // therefore carry a generation-bound human response. Never guess that from legacy provenance.
  const modelAssisted = ['governed-agent', 'legacy-unspecified'].includes(effectiveAuthorship.producer);
  // Code delivery has already evaluated protected paths and source boundaries against its one
  // baseline-aware, rename-aware RepositoryChangeSet. Reconstructing those facts from a name-only
  // dirty-tree list here would both disagree on committed changes and reintroduce rename bypasses.
  if (!deliveryPreflight) await assertPhaseChangeScope(root, config, workflow, phase);
  /**
   * Constitution citations `[SPK:REQ-101]`.
   *
   * Validated against the Story's **pin**, not the file on disk. An article added since the Story
   * started exists today and did not when the author wrote the citation, so accepting it would
   * record a reference to a rule nobody read. Checked here, beside the marker gate, so a citation
   * problem costs the same as a marker: the answer, and nothing else.
   */
  const citations = validateCitations(
    workflow.resolution?.constitutionPin ?? null,
    citedArticleIds(await readArtifactText(root, requiredRepoPath(config, workflow, phase))),
    { label: `Phase ${phase.id}` }
  );
  citations.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (citations.errors.length && (workflow.resolution?.constitution?.mode ?? 'off') === 'enforce') {
    throw new SingularityFlowError(`Phase ${phase.id} is not publishable:\n- ${citations.errors.join('\n- ')}`,
      { code: 'CONSTITUTION_CITATION_INVALID', details: { phase: phase.id, errors: citations.errors, cited: citations.cited } });
  }
  citations.errors.forEach((error) => console.warn(`Warning: ${error}`));

  const codeModelObservation = effectiveAuthorship.kernelModel?.observations
    ?.find((observation) => observation.task === 'code') ?? null;
  const codeModelAssurance = codeModelObservation?.assurance ?? 'unavailable';
  if (deliveryPreflight && effectiveAuthorship.producer === 'governed-agent') {
    const minimum = workflow.resolution?.codeDelivery?.model?.minimumAssurance ?? 'unavailable';
    if ((MODEL_ASSURANCE_RANK[codeModelAssurance] ?? -1) < requiredModelAssuranceRank(minimum)) {
      throw new SingularityFlowError(
        `Code generation requires ${minimum} model assurance; the host supplied ${codeModelAssurance}.`,
        { code: 'CODE_MODEL_ASSURANCE_REQUIRED' }
      );
    }
    if (codeModelAssurance !== 'unavailable' && !codeModelObservation?.invocationId) {
      throw new SingularityFlowError('Observed code-model assurance requires a host invocation binding.', {
        code: 'CODE_MODEL_ASSURANCE_REQUIRED'
      });
    }
    if (codeModelAssurance !== 'unavailable' && (!codeModelObservation?.provider
        || !codeModelObservation?.resolvedModel
        || codeModelObservation?.host !== 'singularity-flow-kernel'
        || codeModelObservation?.source !== 'model-invocation-audit'
        || !codeModelObservation?.observedAt
        || codeModelObservation?.observationIntegrity !== 'external-host-attested'
        || Number(codeModelObservation?.generation) !== Number(nextPhaseGeneration(phase)))) {
      throw new SingularityFlowError('Code-model assurance is missing its provider, model, host audit source, timestamp, or generation binding.', {
        code: 'CODE_MODEL_ASSURANCE_REQUIRED'
      });
    }
  }

  // AST is optional. This boundary may collect structural diagnostics, but it never blocks or
  // mutates publication when AST, a language pack, an adapter, or its evidence store is absent.
  const astGate = await evaluateAstLifecycleGate(root, config, workflow, phase, {
    generation: nextPhaseGeneration(phase)
  });
  assertAstLifecycleGate(astGate, `publication of phase '${phase.id}'`);

  const capture = !modelAssisted
    ? { source: 'not-invoked', usage: [], spans: 0, rawBytes: 0, pending: false, warnings: [] }
    : rawUsage
    ? { source: 'usage-json', usage: Array.isArray(rawUsage) ? rawUsage : [rawUsage], spans: 0, rawBytes: 0, startedAt: rawUsage.startedAt, completedAt: rawUsage.completedAt, warnings: [] }
    : { source: 'copilot-otel', ...await collectCopilotUsage(root, workflow, phase, { readTelemetry: false }) };
  capture.pending = modelAssisted && !rawUsage && capture.usage.length === 0;
  // Only a launch SFlow started can still be exporting its turn; say so only when one ran.
  if (capture.pending) capture.warnings.push(telemetryCaptureGap(capture, null) === 'awaiting-export'
    ? 'Copilot usage is not read during the work; run singularity-flow telemetry reconcile to record it.'
    : 'No Copilot activity was captured for this phase.');
  capture.warnings.forEach((warning) => console.warn(`Telemetry warning: ${warning}`));
  const normalizedUsage = modelAssisted
    ? (capture.usage.length ? capture.usage : [{ source: 'copilot-otel-unavailable' }]).map((record) => normalizeUsage(record, session, nextPhaseGeneration(phase)))
    : [];
  const capabilityBudget = workflow.resolution?.capability?.policy?.tokenBudget;
  if (capabilityBudget) {
    const used = Object.values(workflow.phases).flatMap((entry) => entry.usage ?? [])
      .reduce((total, record) => total + (record.totalTokens ?? 0), 0)
      + normalizedUsage.reduce((total, record) => total + (record.totalTokens ?? 0), 0);
    if (used > capabilityBudget) {
      throw new SingularityFlowError(`Capability '${workflow.resolution.capability.id}' token budget exceeded: ${used}/${capabilityBudget}.`);
    }
  }
  const targetGeneration = nextPhaseGeneration(phase);
  // Architecture intent was removed with the registered World Model; publications record no
  // intent binding or decision, exactly as when it was disabled.
  const architectureIntentBinding = null;
  const architectureDecision = null;
  phase.generation = targetGeneration; phase.generatedBy = session.actor;
  phase.submissionArchitectureDecision = null;
  phase.generatedAgent = effectiveAuthorship.producer === 'governed-agent' ? session.agent : null;
  phase.authorship ??= [];
  const publishedAt = nowIso();
  phase.authorship.push({ ...structuredClone(effectiveAuthorship), generation: phase.generation, publishedAt });
  if (deliveryPreflight) {
    // These are live submission bindings, not publication history. A successor starts without
    // observed evidence; immutable prior claim maps/publications remain in Git and lineage.
    if (phase.claimMaps) delete phase.claimMaps.observed;
    phase.generationCommit = null;
    phase.publicationCommit = null;
    phase.submittedAt = null;
    const deliveryRoot = posix(path.join(
      workDirRelative(config, workflow.workItem.id), 'context', 'code-delivery'
    ));
    const receiptPath = `${deliveryRoot}/${phase.id}-gen${phase.generation}.json`;
    const changeSetPath = `${deliveryRoot}/${phase.id}-gen${phase.generation}-changes.json`;
    await writeJson(path.join(root, changeSetPath), deliveryPreflight.changeSet);
    const workingStateDigest = await sourceTreeHash(root, config, workflow);
    const testInputSha256 = await testInputTreeHash(root, config, workflow);
    const receipt = {
      schemaVersion: currentSchemaVersion('code-delivery'),
      kind: 'code-delivery',
      workId: workflow.workItem.id,
      phase: phase.id,
      generation: phase.generation,
      generationIntentId: deliveryPreflight.generationIntentId,
      changeSet: {
        path: changeSetPath,
        digest: deliveryPreflight.changeSet.digest,
        sourcePaths: deliveryPreflight.sourcePaths,
        deletedSourcePaths: deliveryPreflight.deletedSourcePaths,
        configurationPaths: deliveryPreflight.configurationPaths,
        executableTestPaths: deliveryPreflight.testPaths,
        supportingTestPaths: deliveryPreflight.supportingTestPaths
      },
      changeClassification: {
        ...deliveryPreflight.changeClassification,
        declaredOrigins: [...(effectiveAuthorship.changeOrigins ?? [])]
      },
      ...(deliveryPreflight.documentationCorrection ? {
        documentationCorrection: structuredClone(deliveryPreflight.documentationCorrection)
      } : {}),
      ...(deliveryPreflight.testingRepair ? {
        testingRepair: structuredClone(deliveryPreflight.testingRepair)
      } : {}),
      traceability: {
        required: deliveryPreflight.acceptanceCriteria.required,
        bound: deliveryPreflight.acceptanceCriteria.tagged,
        missing: deliveryPreflight.acceptanceCriteria.missing,
        ambiguous: deliveryPreflight.acceptanceCriteria.ambiguous,
        bindings: deliveryPreflight.acceptanceCriteria.bindings,
        // Which exact test each criterion tag sits on, read by the module adapter [E2G-015].
        witnesses: deliveryPreflight.acceptanceCriteria.witnesses ?? [],
        unattachedTags: deliveryPreflight.acceptanceCriteria.unattachedTags ?? [],
        adapterProfiles: deliveryPreflight.acceptanceCriteria.profiles ?? [],
        ...(deliveryPreflight.sourceBindings.mode === 'enforce' ? {
          sourceRequired: deliveryPreflight.sourceBindings.required,
          sourceBindings: deliveryPreflight.sourceBindings.bindings
        } : {})
      },
      ...(deliveryPreflight.fulfillment?.length ? { fulfillment: { obligations: structuredClone(deliveryPreflight.fulfillment) } } : {}),
      ...(deliveryPreflight.implementationBindings ? { implementationBindings: structuredClone(deliveryPreflight.implementationBindings) } : {}),
      ...(deliveryPreflight.cornerCaseMatrix ? { cornerCaseMatrix: structuredClone(deliveryPreflight.cornerCaseMatrix) } : {}),
      ...(deliveryPreflight.excludedChanges?.length ? { excludedChanges: [...deliveryPreflight.excludedChanges] } : {}),
      testExecutions: [],
      ...(deliveryPreflight.testRecovery ? { testRecovery: structuredClone(deliveryPreflight.testRecovery) } : {}),
      ...(autoCandidate ? { autoCandidate: structuredClone(autoCandidate) } : {}),
      ...(autoCandidateVerification ? {
        autoCandidateVerification: structuredClone(autoCandidateVerification)
      } : {}),
      tree: { workingStateDigest, ...(testInputSha256 ? { testInputSha256 } : {}),
        generationCommit: null, generationTree: null },
      model: {
        task: 'code',
        required: effectiveAuthorship.producer === 'governed-agent',
        authorshipProducer: effectiveAuthorship.producer,
        minimumAssurance: workflow.resolution?.codeDelivery?.model?.minimumAssurance ?? 'unavailable',
        mappingRevision: codeModelObservation?.mappingRevision ?? null,
        provider: codeModelObservation?.provider ?? null,
        requestedModel: codeModelObservation?.requestedModel ?? null,
        resolvedModel: codeModelObservation?.resolvedModel ?? null,
        assurance: codeModelAssurance,
        invocationIds: codeModelObservation ? [codeModelObservation.invocationId] : [],
        host: codeModelObservation?.host ?? null,
        observationSource: codeModelObservation?.source ?? null,
        observationIntegrity: codeModelObservation?.observationIntegrity ?? 'unverified-local',
        observedAt: codeModelObservation?.observedAt ?? null,
        generation: codeModelObservation?.generation ?? null
      },
      status: 'pending-tests',
      capturedAt: publishedAt
    };
    await writeJson(path.join(root, receiptPath), receipt);
    phase.deliveryEvidence = {
      ...deliveryPreflight,
      changeClassification: {
        ...deliveryPreflight.changeClassification,
        declaredOrigins: [...(effectiveAuthorship.changeOrigins ?? [])]
      },
      generation: phase.generation,
      receiptPath,
      changeSetPath,
      sourceTreeSha256: workingStateDigest,
      ...(testInputSha256 ? { testInputSha256 } : {}),
      ...(autoCandidate ? { autoCandidate: structuredClone(autoCandidate) } : {}),
      ...(autoCandidateVerification ? {
        autoCandidateVerification: structuredClone(autoCandidateVerification)
      } : {}),
      status: 'pending-tests',
      capturedAt: publishedAt,
      validation: null
    };
    if (autoCandidate && publicationTransaction?.publicationEvent?.payload) {
      publicationTransaction.publicationEvent.payload.autoCandidate = {
        candidateId: autoCandidate.candidateId,
        candidateSha256: autoCandidate.candidateSha256,
        bindingSha256: autoCandidate.bindingSha256,
        attemptId: autoCandidate.attemptId,
        verificationReceiptSha256: autoCandidateVerification.verificationReceiptSha256
      };
    }
  }
  const astReceipt = await persistAstLifecycleReceipt(root, config, workflow, phase, astGate);
  if (astReceipt) {
    phase.astGates = [
      ...(phase.astGates ?? []).filter((record) => record.generation !== phase.generation),
      astReceipt
    ].sort((left, right) => left.generation - right.generation);
  }

  if (clarification.record) {
    phase.clarifications ??= [];
    phase.clarifications = [
      ...phase.clarifications.filter((record) => record.generation !== phase.generation),
      {
        generation: phase.generation,
        path: clarification.path,
        sha256: clarification.sha256,
        promptSha256: clarification.record.promptSha256,
        responses: clarification.record.responses.length,
        // Which artifact markers this batch answered `[SPK:REQ-066]`. Kept on the summary so the
        // gate can tell a resolved marker from a deleted one without reading every record off disk
        // on a path that already does a lot of I/O.
        markers: answeredMarkerHashes(clarification.record),
        recordedAt: clarification.record.recordedAt,
        recordedBy: structuredClone(clarification.record.recordedBy)
      }
    ];
  }
  /**
   * What this generation left open, so the next one can tell resolution from deletion.
   *
   * `[SPK:REQ-067]` only works if there is a prior list to have vanished from: without it, quietly
   * removing a question is indistinguishable from answering it.
   */
  if (gate.applies && gate.record) {
    phase.markers = [
      ...(phase.markers ?? []).filter((record) => record.generation !== phase.generation),
      { ...gate.record, generation: phase.generation, recordedAt: publishedAt }
    ].sort((left, right) => left.generation - right.generation);
  }
  phase.sourceCommit = head(root);
  // Every conformance report is bound to the tree it compared, so any of them can be checked for freshness.
  if (isConformancePhase(phase)) phase.conformanceTree = await sourceTreeHash(root, config, workflow);
  phase.usage.push(...normalizedUsage);
  const telemetry = await recordPhaseTelemetry(root, workflow, phase, normalizedUsage, capture, {
    itemDirectory: workDir(root, config, workflow.workItem.id), itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  phase.telemetry = [...(phase.telemetry ?? []).filter((item) => item.generation !== phase.generation), phaseTelemetrySummary(telemetry)];
  await updateArtifactMetadata(root, config, workflow, phase);
  await scanArtifacts(root, config, workflow, phase.id);
  /**
   * Canonical provenance for this generation's final artifacts `[SPK:REQ-043]`.
   *
   * Capture only after lifecycle metadata and checkout representation have settled. The kernel
   * owns `context/sidecars/`, outside the artifact-only scope already checked above [SPK:CON-023].
   */
  const sidecarDir = workDirRelative(config, workflow.workItem.id);
  phase.sidecars = [];
  for (const artifact of phase.artifacts ?? []) {
    if (!artifact.sha256) continue;
    const relative = sidecarRelativePath(sidecarDir, phase.id, phase.generation, artifact.path);
    const record = buildArtifactSidecar({
      subject: { kind: 'story', id: workflow.workItem.id },
      phase: phase.id,
      generation: phase.generation,
      artifact: { path: artifact.path, sha256: artifact.sha256, bytes: artifact.size ?? null, role: artifact.kind ?? null },
      configuration: { sha256: workflow.resolution?.configSha256 ?? null, revision: workflow.resolution?.configurationSource?.commit ?? null },
      template: {
        path: workflow.resolution?.templates?.[phase.id]?.path ?? null,
        sha256: workflow.resolution?.templates?.[phase.id]?.sha256 ?? null
      },
      inputs: (phase.inputs ?? []).map((entry) => ({ path: entry.path, sha256: entry.sha256 ?? null, kind: entry.kind ?? null })),
      producer: {
        kind: effectiveAuthorship.producer,
        actor: session.actor?.email ?? session.actor?.name ?? null,
        agent: phase.generatedAgent
      },
      // The commit is not known until the publication transaction closes.
      publication: { commit: null, branch: workflow.workItem.branch ?? null, publishedAt }
    });
    await writeText(path.join(root, relative), serializeArtifactSidecar(record));
    phase.sidecars.push({ path: relative, artifact: artifact.path, integritySha256: record.integritySha256 });
  }
  // Generate the downstream projection from the exact generation bytes that this publication
  // commits. Submission later binds these hashes into its immutable review packet; subsequent
  // approval metadata must not redefine what the reviewer and downstream consumer received.
  const agentBriefs = await createAgentBriefs(root, workflow, phase, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  if (agentBriefs.length) {
    phase.agentBriefs = [
      ...(phase.agentBriefs ?? []).filter((entry) => entry.generation !== phase.generation),
      ...agentBriefs
    ].sort((left, right) => left.generation - right.generation || left.consumerPhase.localeCompare(right.consumerPhase));
  }
  /**
   * The typed artifact set `[SPK:REQ-110]` `[SPK:REQ-111]`.
   *
   * Catalogued after the scan, so the set describes the bundle as published. Required members are
   * checked again here because tests and other publication work ran after the initial preflight.
   *
   * When the phase was reopened for named members, this is also where the promise is checked. The
   * clause asks that incidental change be *disclosed*, not forbidden — a regeneration that reflowed
   * a neighbouring paragraph is usually harmless, and refusing it would push people into rewriting
   * the whole bundle, which is the outcome surgical reopen exists to avoid.
   */
  const artifactSet = resolvedArtifactSet(config, workflow, phase);
  if (artifactSet) {
    const previous = phase.artifactSet ?? null;
    const catalog = await catalogArtifactSet(root, workDirRelative(config, workflow.workItem.id), phase, artifactSet);
    await assertRequiredArtifactSetPublishable(root, phase, catalog);
    const diff = artifactSetDiff(previous, catalog, { declared: phase.surgicalReopen?.members ?? [] });
    for (const line of disclosureLines(diff)) console.warn(`Warning: ${line}`);
    phase.artifactSet = {
      ...catalog,
      generation: phase.generation,
      preserved: diff.preserved.map((member) => member.path),
      changed: diff.changed.map((member) => member.path),
      // Member names, not repository paths: this block is read beside `reopen.members`, which is
      // the list the reviewer wrote, and the two have to be comparable at a glance.
      ...(phase.surgicalReopen ? { reopen: { ...phase.surgicalReopen, incidental: diff.incidental.map((member) => member.member) } } : {})
    };
    // Consumed by the generation that answered it. A reopen that stayed on the phase would keep
    // re-disclosing the same incidental change at every later generation.
    delete phase.surgicalReopen;
  }

  await refreshPhaseSpecificationIndex(root, config, workflow, phase);
  await refreshPlannedSpecificationClaims(root, config, workflow, phase);
  await updateRemoteOutputRenderedHashes(root, workflow, phase, { itemDirectory: workDir(root, config, workflow.workItem.id) });
  const errors = await validatePhase(root, config, workflow, phase, {
    placeholders: !deterministicConvergence,
    content: true, generation: targetGeneration, transition: 'publish'
  });
  if (errors.length) throw new SingularityFlowError(`Phase ${phase.id} generation is not publishable:\n- ${errors.join('\n- ')}`);
  // This is an evidence check only. Host admission above remains closed until a qualified
  // containment/delivery boundary can prove how the selected skill was executed.
  await verifySkillPhasePublication(root, config, workflow, phase);
  if (generationIntent) {
    const resultDigest = await generationResultDigest(root, config, workflow, phase, {
      architectureIntent: architectureIntentBinding,
      architectureDecision,
      resultDigestVersion: 3
    });
    await consumeGenerationIntent(root, phase, {
      generation: phase.generation,
      publishedAt,
      changeSetDigest: deliveryPreflight?.changeSet?.digest ?? null,
      resultDigest,
      resultDigestVersion: 3
    });
  }
  const generationPublication = {
    generation: phase.generation,
    publishedAt,
    changeSetDigest: deliveryPreflight?.changeSet?.digest ?? null,
    resultDigest: generationIntent?.publication?.resultDigest
      ?? await generationResultDigest(root, config, workflow, phase, {
        architectureIntent: architectureIntentBinding,
        architectureDecision,
        resultDigestVersion: 3
      }),
    resultDigestVersion: Math.max(generationIntent?.publication?.resultDigestVersion ?? 0, 3),
    architectureIntent: structuredClone(architectureIntentBinding),
    architectureDecision: structuredClone(architectureDecision),
    record: null
  };
  phase.generationPublications = [
    ...(phase.generationPublications ?? []).filter((entry) => Number(entry.generation) !== Number(phase.generation)),
    generationPublication
  ].sort((left, right) => Number(left.generation) - Number(right.generation));
  if (publicationTransaction) {
    await persistGenerationPublicationRecord(root, workflow, phase, {
      ...publicationTransaction,
      workDirectory: workDirRelative(config, workflow.workItem.id)
    });
  }
  normalizedUsage.forEach((usage) => addUsageAggregate(workflow, phase, usage));
  workflow.history.push({ at: nowIso(), actor: actorKey(session.actor), agent: session.agent, event: 'phase_generated', phase: phase.id, detail: `generation ${phase.generation}` });
  if (persist) await saveWorkflow(root, config, workflow);
  return phase;
}
