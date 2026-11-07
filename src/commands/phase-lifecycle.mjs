import { requirePositional, SingularityFlowError, optionString, optionBoolean, optionStrings } from '../util.mjs';
import { repoRoot } from '../git.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { generationRecovery } from '../recovery-plan.mjs';
import { generationResultMatches, generationResultDigest, beginPhaseGeneration, saveStoryDraft } from '../state-stores.mjs';
import { safeCommandGuidance, commandGuidanceLines } from '../safe-command-guidance.mjs';
import { nextPhaseGeneration } from '../kernel/phase-policy.mjs';
import { printCommandRoutes } from './shared/print-command-routes.mjs';
import { storyDraftTransaction } from '../engine-compatibility/story-draft-transaction.mjs';
import { verifyOpenGenerationIntent } from '../generation-boundary.mjs';
// Load the full document renderer only when a caller actually requests that projection.
async function phaseReview(...args) { return (await import('./shared/phase-review.mjs')).phaseReview(...args); }
import { printPhaseReview } from './shared/print-phase-review.mjs';
import { loadSession } from '../session.mjs';
import { phasePrepublish, prepublishTestExecutionLines } from '../phase-prepublish.mjs';
import { phaseDraftCheck } from '../phase-draft-check.mjs';
import { operationContext } from '../operation-context.mjs';
import { applicationReviewOffer, codeOutcomeReviewOffer } from '../code-delivery-policy.mjs';
import { agentPublicationProducer } from '../kernel/phase-policy.mjs';
import path from 'node:path';
import * as style from '../style.mjs';
import { pendingTelemetryNote } from '../telemetry.mjs';
import { postPublicationStep } from '../phase-post-transition-guidance.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';

/**
 * The advisory lines a draft check or prepublish prints. Coverage, doc-comment and every other
 * advisory each keep their own heading: a release or conformance step's evidence, traceability
 * and specification advisories are not documentation, and were printed as "0 public
 * declaration(s)" followed by "Documentation: undefined".
 */
export function prepublishAdvisoryLines(result) {
  const lines = [];
  const advisories = result.advisories ?? [];
  const coverageAdvisories = advisories.filter((advisory) => advisory.category === 'coverage');
  if (coverageAdvisories.length) {
    lines.push(`Coverage warnings: approval would refuse ${result.coverage?.unclaimed ?? coverageAdvisories.length} changed path(s). Name each in a clause's Expected paths, or under ## Supporting files in the plan if it cannot carry a @clause tag.`);
    for (const advisory of coverageAdvisories.slice(0, 10)) lines.push(`  · ${advisory.message}`);
  }
  const otherAdvisories = advisories.filter((advisory) => !['coverage', 'documentation'].includes(advisory.category));
  if (otherAdvisories.length) {
    lines.push(`Advisories (never block publication): ${otherAdvisories.length}.`);
    for (const advisory of otherAdvisories.slice(0, 10)) lines.push(`  · ${advisory.message ?? advisory.code}`);
    if (otherAdvisories.length > 10) lines.push(`  · …and ${otherAdvisories.length - 10} more (--json lists them all).`);
  }
  const documentationAdvisories = advisories.filter((advisory) => advisory.category === 'documentation');
  if (documentationAdvisories.length) {
    const undocumented = result.documentation?.undocumented ?? documentationAdvisories.length;
    lines.push(`Documentation advisories (never block publication): ${undocumented} public declaration(s) without a doc comment.`);
    for (const advisory of documentationAdvisories.slice(0, 10)) lines.push(`  · ${advisory.message}`);
    if (undocumented > 10) lines.push(`  · …and ${undocumented - 10} more (--json lists up to 50).`);
    if (result.documentation?.guidance) lines.push(`Documentation: ${result.documentation.guidance}`);
  } else if (result.documentation?.status === 'unavailable') {
    lines.push(`Documentation advisories: the check could not run (${result.documentation.reason ?? 'unknown reason'}); it never blocks publication.`);
  }
  return lines;
}

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => phaseCommand(positionals, options)));
}

export async function phaseCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'phase subcommand');
  if (subcommand === 'prepublish' && options['publish-if-ready'] === true) return (await import('./phase-publish-if-ready.mjs')).run({ positionals, options });
  if (subcommand === 'show') return (await import('./phase-show.mjs')).phaseShowCommand(positionals, options);
  const root = repoRoot();
  if (subcommand === 'publish') return phasePublishCommand(root, positionals, options);
  if (subcommand === 'begin') return phaseBeginCommand(root, positionals, options);
  const accepted = await loadAcceptedStoryExecution(root, optionString(options, 'work-id') ?? null);
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
    // An agent's read names its own authorship, never a person's: see agentPublicationProducer.
    const result = await check(root, config, workflow, phase, {
      modelEnabled: operationContext()?.modelMode.enabled !== false, session,
      requestedProducer: optionBoolean(options, 'for-agent') ? agentPublicationProducer(phase) : null
    });
    const { observeWorkflowTaskCheck, readWorkflowTaskResume } = await import('../workflow-task-store.mjs');
    if (subcommand === 'draft-check') await observeWorkflowTaskCheck(root, workflow, phase, result);
    const taskResume = await readWorkflowTaskResume(root, workflow, phase, { generation: result.generation,
      progress: { state: result.status === 'ready' ? 'publish-ready' : result.correction?.sameTurn ? 'repair-draft' : 'blocked',
        nextAction: result.commandGuidance?.next ?? result.commandGuidance?.publish } });
    if (optionBoolean(options, 'for-agent')) {
      await (await import('../copilot-mutation-guard.mjs')).recordPhaseTaskCheck(root, result).catch(() => {});
      const { phaseAgentResult } = await import('../phase-agent-result.mjs');
      return console.log(JSON.stringify(phaseAgentResult({ ...result, taskResume })));
    }
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ ...result, taskResume }, null, 2));
    const pendingTests = subcommand === 'prepublish'
      && result.testExecution?.status === 'not-run';
    console.log(`${phase.label} ${subcommand === 'prepublish' ? 'prepublish' : 'draft'}: ${result.status}${pendingTests && result.status === 'ready' ? ' for a publication attempt' : ''}.`);
    if (result.artifact) console.log(`Artifact: ${result.artifact.path}${result.artifact.sha256 ? ` · ${result.artifact.sha256}` : ''}`);
    if (pendingTests) for (const line of prepublishTestExecutionLines(result.testExecution)) console.log(line);
    if (result.qualityDisposition === 'accepted-risk') console.log('Document quality: unmet, accepted risk for the exact reviewed bytes. Tests, independent review and approval remain required.');
    for (const finding of result.findings) console.log(`  - ${finding.message}`);
    for (const warning of result.warnings ?? result.grounding?.warnings ?? []) console.log(`Readiness warning: ${warning}`);
    if (result.finalGate?.status === 'blocked') {
      console.log(`Before ${result.finalGate.submission} can be submitted (publishing is not blocked):`);
      for (const blocker of result.finalGate.blockers) console.log(`  - ${blocker}`);
      if (result.finalGate.more) console.log(`  - …and ${result.finalGate.more} more: singularity-flow evidence matrix`);
      for (const command of result.finalGate.recovery) console.log(`  Run: ${command}`);
    }
    for (const line of prepublishAdvisoryLines(result)) console.log(line);
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
  throw new SingularityFlowError(`Unknown phase subcommand: ${subcommand}`);
}

async function phaseBeginCommand(root,positionals,options) {
  const {createGitPhaseBeginEngine}=await import('../engine-compatibility/git-phase-entry.mjs');
  const binding=createGitPhaseBeginEngine({root});
  const receipt=await binding.engine.run('phase.begin',{
    workId:optionString(options,'work-id')??null,phaseId:positionals[2]??null,
    adoptExisting:optionBoolean(options,'adopt-existing')||optionBoolean(options,'adopt-current-interval'),
    confirm:optionString(options,'confirm')??null
  });
  const {phase,result:intent}=binding.presentation();
  if(receipt.status==='retained') {
    if(optionBoolean(options,'json'))console.log(JSON.stringify(intent,null,2));
    else console.log(`Generation intent ${intent.id} is already open for ${phase.id} generation ${intent.generation}.`);
    return;
  }
  const output={...intent,local:true,lifecycleEvent:null};
  if(optionBoolean(options,'json'))console.log(JSON.stringify(output,null,2));
  else console.log(`Began ${phase.id} generation ${receipt.generation} with local intent ${intent.id}. The receipt will be bound into the generation publication.`);
}

export function phasePublicationJson(receipt, context) {
  const { workflow, phase, warnings = [] } = context;
  const result = { schemaVersion: 1, resultType: 'sflow-phase-publication', status: receipt.status,
    workId: receipt.subject.id, phase: receipt.phase, generation: receipt.generation,
    commit: receipt.revision, pushed: receipt.effects.pushed, effects: receipt.effects };
  if (receipt.status === 'retained') return { ...result, remoteSynchronization: 'not-checked', artifact: receipt.artifact,
    ...(receipt.retentionReason === 'unchanged-document' ? {message: `Already published as generation ${phase.generation}; nothing changed since, so nothing was recorded.`} : {}) };
  const outcomeReview = codeOutcomeReviewOffer(workflow, phase), applicationReview = applicationReviewOffer(workflow, phase);
  return { ...result, artifact: receipt.artifact, ...(outcomeReview ? {outcomeReview} : {}),
    ...(applicationReview ? {applicationReview} : {}), ...(warnings.length ? {warnings} : {}) };
}

async function phasePublishCommand(root, positionals, options) {
  const { createGitEngine } = await import('../engine-compatibility/git-publication.mjs');
  const binding = createGitEngine({root, notice: event => {
    if (event.code === 'publication.legacy-authorship') console.warn('Deprecation warning: phase publish without --authored records legacy-unspecified. Pass --authored human or --authored governed-agent.');
    else if (event.message) console.warn(event.message);
  }});
  let receipt;
  try {
    receipt = await binding.engine.run('phase.publish', {
      workId: optionString(options,'work-id') ?? null, phaseId: positionals[2] ?? null,
      authored: optionString(options,'authored') ?? null, channel: optionString(options,'channel') ?? null,
      from: optionString(options,'from') ? path.resolve(optionString(options,'from')) : null,
      usageFile: optionString(options,'usage-json') ? path.resolve(optionString(options,'usage-json')) : null,
      externalAiUse: optionString(options,'external-ai') ?? null, changeOrigins: optionStrings(options,'change-origin')
    });
  } catch (error) {
    if (error.code === 'CONVERGENCE_ARTIFACT_KERNEL_OWNED' && error.details?.phase) {
      const id = error.details.phase;
      error.message = `The convergence artifact is a kernel-owned deterministic projection and cannot be imported. Run singularity-flow prepare ${id}.`;
      error.details = { nextAction: { executable: 'singularity-flow', argv: ['prepare', id], label: 'Inspect or continue the retained operation; recheck before retrying.' } };
    }
    throw error;
  }
  const context = binding.presentation();
  const {config, workflow, phase} = context;
  if (optionBoolean(options,'json')) { console.log(JSON.stringify(phasePublicationJson(receipt, context))); return; }
  if (receipt.status === 'retained') {
    console.log(receipt.retentionReason === 'consumed-intent'
      ? `Published ${phase.id} generation ${phase.generation} already exists; the idempotent retry created no commit.`
      : `Already published as generation ${phase.generation}; nothing changed since, so nothing was recorded.`);
    printPhaseReview(await phaseReview(root, config, workflow, phase), {showArtifact:optionBoolean(options,'show-artifact')});
    return;
  }
  const result = context.publication;
  const approvedDrift = context.warnings ?? [];
  const applicationReview = applicationReviewOffer(workflow, phase), outcomeReview = codeOutcomeReviewOffer(workflow, phase);
  console.log(`Published ${phase.id} generation ${phase.generation} at ${result.sha.slice(0, 8)}${result.pushed ? ' and pushed' : ''}${result.revisionSelection ? ` from REV Candidate ${result.revisionSelection.candidateId}` : ''}.`);
  if (outcomeReview) for (const line of commandGuidanceLines(outcomeReview, 'Try and review this Story')) console.log(line);
  if (applicationReview) for (const line of commandGuidanceLines(applicationReview, 'Review application')) console.log(line);
  for (const warning of approvedDrift) console.log(`Warning: ${warning.message}`);
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
        ...(prompt ? [`phase prompt: ${prompt.bytes.toLocaleString('en-US')} bytes (~${prompt.estimatedTokens.toLocaleString('en-US')} tokens)`] : [])
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
