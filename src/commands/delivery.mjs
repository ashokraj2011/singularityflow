import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { readAdhocSession, startAdhocSession } from '../adhoc/session.mjs';
import { promoteAdhocSession } from '../adhoc/landing.mjs';
import { readSessionRecord, writeSessionRecord } from '../adhoc/session-store.mjs';
import { loadDefinition } from '../config.mjs';
import {
  buildOutcomeSelectionBundle, normalizeDeliveryRequest, recommendDelivery,
  validateRecommendationPlan
} from '../delivery-modes/delivery-kernel.mjs';
import { buildWorkflowDeliveryProjection } from '../delivery-modes/workflow-delivery.mjs';
import {
  buildAgentExecutionBinding, buildAgentExecutionCheckpoint
} from '../delivery-modes/execution-bridge.mjs';
import {
  applyPromotionPlan, buildPromotionPlan, validateDeliveryModeTransition
} from '../delivery-modes/promotion.mjs';
import { evaluateLocalHermeticEvidence } from '../delivery-modes/high-assurance.mjs';
import {
  buildLocalRunnerPlan, createLocalRunnerSigner, localRunnerSignerStatus,
  publishLocalRunnerAttestation, runLocalRunnerProcess, validateLocalRunnerPlan,
  verifyLocalRunnerAttestationWithSigner
} from '../delivery-modes/local-signed-runner.mjs';
import { provenanceReadiness } from '../delivery-modes/provenance.mjs';
import { buildGdpReadiness } from '../delivery-modes/readiness.mjs';
import { resolveShadowPassportDiagnostic } from '../delivery-modes/shadow-passport-service.mjs';
import { branch, gitCommitIdentity, head, repoRoot } from '../git.mjs';
import { commandResult, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { recordSha256 } from '../records.mjs';
import { readSgosCheckpoint, readSgosProcess } from '../sgos/index.mjs';
import {
  optionBoolean, optionString, secureRepositoryPath, SingularityFlowError
} from '../util.mjs';

function sha(value) { return `sha256:${recordSha256(value)}`; }

function deliveryPolicy(definition) {
  const configured = definition.delivery ?? {};
  const allowedModes = configured.allowedModes ?? ['outcome', 'workflow'];
  return {
    selectionStrategy: configured.selectionStrategy ?? 'recommend',
    allowedModes,
    defaultWorkflowProfile: configured.defaultWorkflowProfile
      ?? configured.workflowProfile
      ?? 'feature',
    outcomeBounds: {
      maximumRisk: 'medium', maximumRepositories: 1, maximumTouchedResources: 40,
      externalEffects: false, credentials: false, protectedPaths: false
    }
  };
}

async function jsonFile(root, relative, label) {
  if (!relative) throw new SingularityFlowError(`${label} is required.`, { code: 'GDM_MODE_REQUIRED' });
  const secured = await secureRepositoryPath(root, relative, {
    label, mustExist: true, type: 'file'
  });
  if (secured.entry.size > 1024 * 1024) throw new SingularityFlowError(
    `${label} exceeds the 1048576-byte limit.`, { code: 'PFC_RECORD_TOO_LARGE' }
  );
  try { return JSON.parse(await readFile(secured.absolute, 'utf8')); }
  catch (error) {
    throw new SingularityFlowError(`${label} is not valid JSON.`, {
      code: 'GDM_MODE_REQUIRED', cause: error
    });
  }
}

function repositoryRevision(root) {
  return sha({ branch: branch(root), head: head(root) });
}

function configurationIdentity(definition, policy) {
  return sha({
    policy,
    protectedPaths: definition.governance?.protectedPaths ?? [],
    adhoc: definition.adhoc ?? null,
    workflows: Object.keys(definition.workflows ?? {}).sort()
  });
}

function effects({ stateChanged = false, filesChanged = false } = {}) {
  return {
    stateChanged, filesChanged, publicationCreated: false,
    externalSystemsChanged: false
  };
}

function requiredOption(options, key, label = `--${key}`) {
  const value = optionString(options, key);
  if (!value) throw new SingularityFlowError(`${label} is required.`, {
    code: 'GDP_LOCAL_RUNNER_INPUT_REQUIRED'
  });
  return value;
}

async function workflowDeliveryFor(root, definition, policy, workId, proofProfile = 'standard') {
  const { workflow, diagnostic } = await resolveShadowPassportDiagnostic(
    root, definition, workId, { proofProfile }
  );
  const workflowProfile = workflow.resolution?.workflowId ?? workflow.workItem?.workType;
  const projection = buildWorkflowDeliveryProjection({
    workflow,
    request: {
      schemaVersion: 1, kind: 'delivery-request', workId: workflow.workItem.id,
      outcome: {
        statement: workflow.workItem.title ?? workflow.workItem.summary ?? `Complete ${workflow.workItem.id}`,
        observablePredicate: 'All creation-pinned workflow obligations are satisfied.'
      },
      acceptanceClauses: [], nonGoals: [],
      predicted: {
        repositories: 1, touchedResources: 0, protectedPaths: false,
        externalEffects: false, credentialUse: false, architectureDecision: false,
        publicContractChange: false, databaseMigration: false
      },
      riskClass: 'unknown', executionProvider: 'governed-agent',
      executionPace: workflow.executionOrigin?.mode === 'auto' ? 'auto' : 'assisted',
      autonomyCeiling: 'A2', proofProfile, workflowProfile,
      allowedEffects: ['repository-file-write'],
      forbiddenEffects: ['credential-read', 'external-network']
    },
    candidateSha256: diagnostic.candidate.candidateSha256,
    worldModel: diagnostic.worldModel, sourceRecordSha256: sha(workflow),
    configurationSha256: configurationIdentity(definition, policy),
    proofPolicySha256: sha({ profile: proofProfile, source: 'installed-gdp-m6' }),
    gapAcceptancePolicySha256: sha({ mode: 'none', milestone: 'GDP-M6' }),
    promotionPolicySha256: sha(policy.outcomeBounds)
  });
  return { workflow, diagnostic, workflowProfile, projection };
}

export async function run(_argv, { positionals, options, operation: suppliedOperation = null } = {}) {
  const action = positionals?.[1] ?? 'recommend';
  const root = repoRoot();
  const definition = await loadDefinition(root);
  const policy = deliveryPolicy(definition);
  if (action === 'local-runner-create') {
    const signer = await createLocalRunnerSigner(
      root, requiredOption(options, 'signer')
    );
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.local-runner-create', classification: 'mutation' },
      subject: { kind: 'repository', id: path.basename(root) },
      outcome: succeeded('delivery.local-runner-created', {
        signer: signer.keyId, created: signer.created
      }),
      effects: effects({ stateChanged: signer.created }), restState: 'informational',
      data: {
        schemaVersion: 1, kind: 'gdp-local-runner-signer', ...signer,
        assurance: 'developer-local-signed', authority: 'developer-local',
        gateEligible: false,
        nextAction: `singularity-flow delivery local-runner-plan --signer ${signer.keyId} --work-id <WORK-ID> --phase <PHASE> --command <CONFIGURED-COMMAND-ID> --proof-subject <SHA256> --candidate <SHA256> --json`
      }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action === 'local-runner-status') {
    const status = await localRunnerSignerStatus(root, requiredOption(options, 'signer'));
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.local-runner-status', classification: 'read' },
      subject: { kind: 'repository', id: path.basename(root) },
      outcome: succeeded('delivery.local-runner-reported', {
        status: status.status, assurance: status.assurance
      }),
      effects: effects(), restState: 'informational', data: status
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action === 'local-runner-plan') {
    const plan = await buildLocalRunnerPlan(root, definition, {
      signerId: requiredOption(options, 'signer'),
      workId: requiredOption(options, 'work-id'),
      phaseId: requiredOption(options, 'phase'),
      commandId: requiredOption(options, 'command'),
      proofSubjectSha256: requiredOption(options, 'proof-subject'),
      candidateSha256: requiredOption(options, 'candidate')
    });
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.local-runner-plan', classification: 'read' },
      subject: { kind: 'story', id: plan.workId },
      outcome: succeeded('delivery.local-runner-plan-ready', {
        workId: plan.workId, phase: plan.phaseId, command: plan.commandId
      }),
      effects: effects(), restState: 'informational',
      data: {
        plan,
        warning: 'This same-user runner provides tamper-evident developer-local evidence, not independent enterprise approval.',
        nextAction: `Save this JSON, review the exact plan, then run singularity-flow delivery local-runner-run --plan <FILE> --confirm-plan ${plan.planSha256} --json`
      }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action === 'local-runner-run') {
    const envelope = await jsonFile(
      root, requiredOption(options, 'plan'), 'Local runner plan file'
    );
    const plan = validateLocalRunnerPlan(envelope?.data?.plan ?? envelope?.plan ?? envelope);
    if (optionString(options, 'confirm-plan') !== plan.planSha256) {
      throw new SingularityFlowError(
        `Local runner execution requires --confirm-plan ${plan.planSha256}. Nothing ran.`,
        { code: 'GDP_LOCAL_RUNNER_CONFIRMATION_INVALID' }
      );
    }
    const attestation = await runLocalRunnerProcess(root, definition, plan);
    const output = await publishLocalRunnerAttestation(root, plan.workId, attestation);
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.local-runner-run', classification: 'mutation' },
      subject: { kind: 'story', id: plan.workId },
      outcome: succeeded('delivery.local-runner-completed', {
        outcome: attestation.outcome, changed: attestation.workingTreeStatusChanged
      }),
      effects: effects({ filesChanged: true }), restState: 'informational',
      data: {
        attestation, output,
        acceptedFor: ['developer-local-observation', 'tamper-detection', 'replay-diagnostics'],
        refusedFor: ['independent-review', 'enterprise-provider-authority', 'lifecycle-gate-authority']
      }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action === 'local-runner-verify') {
    const envelope = await jsonFile(
      root, requiredOption(options, 'attestation-file'), 'Local runner attestation file'
    );
    const attestation = envelope?.data?.attestation ?? envelope?.attestation ?? envelope;
    const verified = await verifyLocalRunnerAttestationWithSigner(
      root, attestation, requiredOption(options, 'signer')
    );
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.local-runner-verify', classification: 'read' },
      subject: { kind: 'repository', id: path.basename(root) },
      outcome: succeeded('delivery.local-runner-verified', {
        outcome: verified.outcome, assurance: verified.assurance
      }),
      effects: effects(), restState: 'informational', data: {
        status: 'verified', attestationSha256: verified.attestationSha256,
        outcome: verified.outcome, assurance: verified.assurance,
        authority: verified.authority, gateEligible: verified.gateEligible
      }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action === 'workflow-status') {
    const workId = positionals?.[2] ?? optionString(options, 'work-id') ?? branch(root);
    const { workflow, workflowProfile, projection } = await workflowDeliveryFor(
      root, definition, policy, workId, optionString(options, 'proof-profile') ?? 'standard'
    );
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.workflow-status', classification: 'read' },
      subject: { kind: 'story', id: workflow.workItem.id },
      outcome: succeeded('delivery.workflow-reported', {
        workId: workflow.workItem.id, profile: workflowProfile,
        checkpoints: projection.checkpoints.length
      }),
      effects: effects(), restState: 'informational', data: projection
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action === 'execution-status') {
    const processId = positionals?.[2];
    if (!processId) throw new SingularityFlowError(
      'Execution status requires a Process ID: delivery execution-status <PROCESS-ID> [--work-id <WORK-ID>].',
      { code: 'GDM_EXECUTION_BINDING_INVALID' }
    );
    const process = await readSgosProcess(root, processId);
    const workId = optionString(options, 'work-id') ?? process.authorityBinding?.subjectId;
    if (!workId) throw new SingularityFlowError(
      'The SGOS Process does not identify a governed Story. Pass --work-id explicitly.',
      { code: 'GDM_EXECUTION_BINDING_INVALID' }
    );
    const { projection } = await workflowDeliveryFor(
      root, definition, policy, workId, optionString(options, 'proof-profile') ?? 'standard'
    );
    const binding = buildAgentExecutionBinding({
      workId, selection: projection.selection,
      completionContract: projection.completionContract, process,
      executionUnitManifestSha256: process.executionUnitManifestSha256 ?? null
    });
    const checkpointRecord = process.currentCheckpointSha256
      ? (await readSgosCheckpoint(root, process.processId, process.currentCheckpointSha256)).record
      : null;
    const checkpoint = buildAgentExecutionCheckpoint({ binding, process, checkpoint: checkpointRecord });
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.execution-status', classification: 'read' },
      subject: { kind: 'story', id: workId },
      outcome: succeeded('delivery.execution-reported', {
        processId, status: checkpoint.status, quiescent: checkpoint.quiescent
      }),
      effects: effects(), restState: 'informational',
      data: {
        schemaVersion: 1, kind: 'gdp-execution-status', binding, checkpoint,
        authority: 'existing-sgos-runtime',
        controls: {
          pause: `singularity-flow process pause ${processId}`,
          stop: `singularity-flow process stop ${processId}`,
          recover: `singularity-flow process recover ${processId}`
        }
      }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action === 'promotion-preview') {
    const session = await readAdhocSession(root, positionals?.[2] ?? null);
    const preview = await readSessionRecord(root, session.sessionId, 'preview', { required: false });
    const targetWorkId = optionString(options, 'work-id');
    const targetWorkflowProfile = optionString(options, 'workflow');
    const plan = buildPromotionPlan({
      session, targetWorkId, targetWorkflowProfile, expectedHead: head(root),
      changeSetSha256: preview?.changeSetSha256 ?? null
    });
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.promotion-preview', classification: 'read' },
      subject: { kind: 'adhoc', id: session.sessionId },
      outcome: succeeded('delivery.promotion-previewed', {
        workId: plan.workId, workflow: plan.targetWorkflowProfile
      }),
      effects: effects(), restState: 'informational',
      data: {
        schemaVersion: 1, kind: 'gdp-promotion-plan', plan, nothingChanged: true,
        nextAction: `singularity-flow delivery promotion-apply --plan <PLAN-FILE> --confirm-plan ${plan.transitionSha256}`
      }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action === 'promotion-apply') {
    const envelope = await jsonFile(root, optionString(options, 'plan'), 'Promotion plan');
    const plan = validateDeliveryModeTransition(envelope?.data?.plan ?? envelope?.plan ?? envelope);
    if (optionString(options, 'confirm-plan') !== plan.transitionSha256) {
      throw new SingularityFlowError(
        `Promotion requires --confirm-plan ${plan.transitionSha256}. Nothing changed.`,
        { code: 'GDM_PROMOTION_CONFIRMATION_INVALID' }
      );
    }
    const session = await readAdhocSession(root, plan.sessionId);
    const preview = await readSessionRecord(root, session.sessionId, 'preview', { required: false });
    const transition = applyPromotionPlan({
      plan, session, expectedHead: head(root), changeSetSha256: preview?.changeSetSha256 ?? null
    });
    const checkpoint = await promoteAdhocSession(root, session.sessionId);
    const stored = await writeSessionRecord(
      root, session.sessionId, 'deliveryTransition', transition
    );
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.promotion-apply', classification: 'mutation' },
      subject: { kind: 'adhoc', id: session.sessionId },
      outcome: succeeded('delivery.promotion-applied', {
        workId: transition.workId, workflow: transition.targetWorkflowProfile
      }),
      effects: effects({ stateChanged: true }), restState: 'informational',
      data: {
        schemaVersion: 1, kind: 'gdp-promotion-handoff', transition: stored, checkpoint,
        nextArgv: transition.targetArgv
      }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action === 'promotion-status') {
    const session = await readAdhocSession(root, positionals?.[2] ?? null);
    const transition = await readSessionRecord(
      root, session.sessionId, 'deliveryTransition', { required: false }
    );
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.promotion-status', classification: 'read' },
      subject: { kind: 'adhoc', id: session.sessionId },
      outcome: succeeded('delivery.promotion-reported', {
        sessionId: session.sessionId, status: transition?.status ?? 'not-started'
      }),
      effects: effects(), restState: 'informational',
      data: {
        schemaVersion: 1, kind: 'gdp-promotion-status', session, transition,
        recover: transition?.status === 'handoff-ready' ? transition.targetArgv
          : ['singularity-flow', 'delivery', 'promotion-preview', session.sessionId,
            '--workflow', '<feature|bugfix>', '--work-id', '<WORK-ID>']
      }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action === 'assurance-evaluate') {
    const evidence = await jsonFile(
      root, optionString(options, 'evidence-file'), 'Local hermetic evidence file'
    );
    const evaluation = evaluateLocalHermeticEvidence(evidence);
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.assurance-evaluate', classification: 'read' },
      subject: { kind: 'story', id: evaluation.workId },
      outcome: succeeded('delivery.assurance-reported', {
        workId: evaluation.workId, verdict: evaluation.verdict,
        coverage: evaluation.coverage.status
      }),
      effects: effects(), restState: 'informational',
      data: {
        ...evaluation,
        warning: 'Local observations are non-authoritative until an authenticated hermetic runner provider is configured.'
      }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action === 'provenance-status') {
    const providerFile = optionString(options, 'provider-file');
    const readiness = provenanceReadiness(providerFile
      ? await jsonFile(root, providerFile, 'Provenance provider file') : null);
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.provenance-status', classification: 'read' },
      subject: { kind: 'repository', id: path.basename(root) },
      outcome: succeeded('delivery.provenance-reported', {
        status: readiness.status, configured: readiness.configured,
        verifier: readiness.verifierAvailable
      }),
      effects: effects(), restState: 'informational', data: {
        ...readiness,
        nextAction: readiness.configured
          ? 'Install and register an approved verifier implementation before accepting attestations.'
          : 'Create a reviewed repository-relative provider descriptor; no credentials belong in it.'
      }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action === 'readiness') {
    const providerFile = optionString(options, 'provider-file');
    const readiness = buildGdpReadiness({
      platform: process.platform, architecture: process.arch, nodeVersion: process.version,
      providerConfiguration: providerFile
        ? await jsonFile(root, providerFile, 'Provenance provider file') : null
    });
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.readiness', classification: 'read' },
      subject: { kind: 'repository', id: path.basename(root) },
      outcome: succeeded('delivery.readiness-reported', {
        status: readiness.status, blockers: readiness.blockers.length,
        gaReady: readiness.gaReady
      }),
      effects: effects(), restState: 'informational', data: readiness
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action === 'recommend') {
    const request = normalizeDeliveryRequest(await jsonFile(
      root, optionString(options, 'request-file'), 'Delivery request file'
    ));
    const plan = recommendDelivery({
      request, repositoryRevisionSha256: repositoryRevision(root),
      configurationSha256: configurationIdentity(definition, policy), ...policy
    });
    return emitCommandResult(commandResult({
      operation: suppliedOperation ?? { id: 'delivery.recommend', classification: 'read' },
      subject: { kind: 'outcome', id: request.workId },
      outcome: succeeded('delivery.recommendation-created', {
        recommendation: plan.outcome, reasons: plan.reasons.length
      }),
      effects: effects(), restState: 'informational',
      data: {
        schemaVersion: 1, kind: 'gdm-delivery-recommendation-plan', request, plan,
        nothingChanged: true,
        nextAction: plan.requiredMode === 'workflow'
          ? `singularity-flow start ${request.workId} --workflow ${request.workflowProfile}`
          : 'Save this JSON to a repository-relative file, review it, then run delivery select with its exact digest.'
      }
    }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
  }
  if (action !== 'select') throw new SingularityFlowError(
    `Unknown delivery action '${action}'. Use: delivery recommend, delivery select, `
      + 'delivery workflow-status, delivery execution-status, delivery promotion-preview, '
      + 'delivery promotion-status, delivery assurance-evaluate, delivery provenance-status, '
      + 'delivery local-runner-create, delivery local-runner-status, delivery local-runner-plan, '
      + 'delivery local-runner-run, delivery local-runner-verify, or delivery readiness.',
    { code: 'UNKNOWN_SUBCOMMAND' }
  );
  const envelope = await jsonFile(root, optionString(options, 'plan'), 'Delivery plan');
  const plan = validateRecommendationPlan(envelope);
  const request = normalizeDeliveryRequest(envelope?.data?.request ?? envelope?.request);
  const confirmPlan = optionString(options, 'confirm-plan');
  if (!confirmPlan || confirmPlan !== plan.recommendationSha256) throw new SingularityFlowError(
    `Delivery selection requires --confirm-plan ${plan.recommendationSha256}. Nothing changed.`,
    { code: 'GDM_SELECTION_CONFIRMATION_INVALID' }
  );
  const currentRepository = repositoryRevision(root);
  const currentConfiguration = configurationIdentity(definition, policy);
  if (plan.repositoryRevisionSha256 !== currentRepository
      || plan.configurationSha256 !== currentConfiguration
      || plan.requestSha256 !== sha(request)) {
    throw new SingularityFlowError(
      'Repository, configuration, or request changed after delivery recommendation. Nothing changed. '
      + 'Run delivery recommend again and review the replacement plan.',
      { code: 'GDM_SELECTION_PLAN_STALE' }
    );
  }
  const mode = optionString(options, 'mode');
  if (mode !== 'outcome') throw new SingularityFlowError(
    `The GDP-M5 selection pilot starts only bounded Outcome work. For Workflow mode run: `
    + `singularity-flow start ${request.workId} --workflow ${request.workflowProfile}. Nothing changed.`,
    { code: 'GDM_MODE_NOT_ALLOWED' }
  );
  const identity = gitCommitIdentity(root);
  if (!identity.email) throw new SingularityFlowError(
    'Git user.email is required to attribute the reviewed delivery selection. Nothing changed.',
    { code: 'GDM_MODE_REQUIRED' }
  );
  const selectedBy = {
    kind: 'human', identity: identity.email, authoritySha256: null
  };
  const proofPolicySha256 = sha({ profile: request.proofProfile, source: 'installed-gdp-m5' });
  const bundle = buildOutcomeSelectionBundle({
    request, recommendation: plan, mode,
    proofPolicySha256, policySnapshotSha256: currentConfiguration,
    gapAcceptancePolicySha256: sha({ mode: 'none', milestone: 'GDP-M5' }),
    promotionPolicySha256: sha(policy.outcomeBounds), selectedBy
  });
  const started = await startAdhocSession(root, definition, {
    note: request.outcome.statement, from: 'HEAD', includeExisting: false,
    mode: 'in-place', gdp: bundle
  });
  return emitCommandResult(commandResult({
    operation: suppliedOperation ?? { id: 'delivery.select', classification: 'mutation' },
    subject: { kind: 'adhoc', id: started.session.sessionId },
    outcome: succeeded('delivery.outcome-started', {
      workId: request.workId, sessionId: started.session.sessionId,
      selectionSha256: bundle.selection.selectionSha256
    }),
    effects: effects({ stateChanged: true }), restState: 'informational',
    data: {
      workId: request.workId, session: started.session, baseline: started.baseline,
      selection: bundle.selection, completionContract: bundle.completionContract,
      nextAction: `singularity-flow adhoc status ${started.session.sessionId}`,
      publication: 'The existing Ad Hoc publisher will commit these exact GDP records only after its own landing preview and confirmation.'
    }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}
