/** GDP-M6 deterministic Workflow-mode contract, Passport, and checkpoint projection. */
import { recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import {
  buildCompletionContract, buildDeliverySelection, buildEffectPolicy, buildRiskAssessment,
  normalizeDeliveryRequest, recommendDelivery
} from './delivery-kernel.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RAW_DIGEST = /^[a-f0-9]{64}$/;
const PROFILES = new Set(['feature', 'bugfix']);
const TERMINAL_PHASES = new Set(['approved', 'complete', 'completed']);
const MAX_CHECKPOINTS = 32;
const MAX_INPUTS = 128;

function fail(message, code = 'GDM_WORKFLOW_MAPPING_UNAVAILABLE') {
  const error = new TypeError(`GDP Workflow mapping: ${message}`);
  error.code = code;
  throw error;
}

function digest(value) { return `sha256:${recordSha256(value)}`; }
function prefixed(value) {
  const text = String(value ?? '');
  if (DIGEST.test(text)) return text;
  if (RAW_DIGEST.test(text)) return `sha256:${text}`;
  return null;
}

function hashRecord(family, hashField, fields) {
  const core = { schemaVersion: currentSchemaVersion(family), kind: family, ...fields };
  return Object.freeze({ ...core, [hashField]: digest(core) });
}

function phaseInputs(phase) {
  const values = new Map();
  const add = (role, value) => {
    const sha256 = prefixed(value);
    if (sha256) values.set(`${role}:${sha256}`, { role, sha256 });
  };
  for (const artifact of phase.artifacts ?? []) add('artifact', artifact.sha256);
  add('phase-input', phase.inputSnapshotSha256 ?? phase.phaseInputSha256);
  add('grounding', phase.groundingCompositionSha256 ?? phase.grounding?.compositionSha256);
  add('delivery-evidence', phase.deliveryEvidence?.receiptSha256);
  for (const approval of phase.approvals ?? []) {
    if (!approval.invalidatedAt && approval.decision === 'approved') {
      add('approval', approval.approvalSha256 ?? approval.decisionSha256);
    }
  }
  const result = [...values.values()].sort((left, right) => (
    `${left.role}:${left.sha256}`.localeCompare(`${right.role}:${right.sha256}`)
  ));
  if (result.length > MAX_INPUTS) fail(`phase '${phase.id}' exceeds ${MAX_INPUTS} checkpoint inputs.`);
  return result;
}

export function buildWorkflowCheckpointSatisfaction({
  workId, workflowProfile, phase, sourceRecordSha256, completionContractSha256,
  proofSubjectSha256 = null
} = {}) {
  if (!PROFILES.has(workflowProfile)) fail(`workflow profile '${workflowProfile}' is not mapped.`);
  const inputs = phaseInputs(phase);
  const terminal = TERMINAL_PHASES.has(phase.status);
  const status = terminal && inputs.length ? 'satisfied'
    : terminal ? 'unavailable'
      : ['in_progress', 'awaiting_approval'].includes(phase.status) ? 'pending' : 'not-applicable';
  const gaps = [];
  if (terminal && !inputs.length) gaps.push('CHECKPOINT_INPUT_IDENTITY_UNAVAILABLE');
  if (!proofSubjectSha256) gaps.push('CANDIDATE_OR_PROOF_SUBJECT_UNAVAILABLE');
  return hashRecord('workflow-checkpoint-satisfaction', 'satisfactionSha256', {
    workId, workflowProfile, phaseId: String(phase.id),
    generation: Number.isSafeInteger(phase.generation) && phase.generation > 0 ? phase.generation : 1,
    phaseStatus: String(phase.status), status, sourceRecordSha256,
    completionContractSha256, proofSubjectSha256, inputs, gaps: [...new Set(gaps)].sort()
  });
}

export function validateWorkflowCheckpointSatisfaction(value) {
  const expected = [
    'schemaVersion', 'kind', 'workId', 'workflowProfile', 'phaseId', 'generation',
    'phaseStatus', 'status', 'sourceRecordSha256', 'completionContractSha256',
    'proofSubjectSha256', 'inputs', 'gaps', 'satisfactionSha256'
  ].sort();
  if (JSON.stringify(Object.keys(value ?? {}).sort()) !== JSON.stringify(expected)) {
    fail('checkpoint has an invalid field set.');
  }
  const readable = readRecord('workflow-checkpoint-satisfaction', value);
  if (readable.migratedThrough.length || value.kind !== 'workflow-checkpoint-satisfaction') {
    fail('checkpoint schema is not current.');
  }
  const core = structuredClone(value); delete core.satisfactionSha256;
  if (value.satisfactionSha256 !== digest(core)) fail('checkpoint self hash is invalid.');
  return Object.freeze(structuredClone(value));
}

export function buildWorkflowDeliveryProjection({
  workflow, request, candidateSha256 = null, worldModel = null,
  sourceRecordSha256, configurationSha256, proofPolicySha256,
  gapAcceptancePolicySha256, promotionPolicySha256
} = {}) {
  const normalized = normalizeDeliveryRequest(request);
  const workId = String(workflow?.workItem?.id ?? '');
  const workflowProfile = String(workflow?.resolution?.workflowId ?? workflow?.workItem?.workType ?? '');
  if (normalized.workId !== workId) fail('request and workflow Work IDs differ.');
  if (!PROFILES.has(workflowProfile)) fail(
    `workflow '${workflowProfile || 'unknown'}' is creation-pinned and not mapped by GDP-M6.`
  );
  const recommendation = recommendDelivery({
    request: normalized, repositoryRevisionSha256: sourceRecordSha256,
    configurationSha256, selectionStrategy: 'fixed', allowedModes: ['workflow'],
    defaultWorkflowProfile: workflowProfile
  });
  const selectedBy = { kind: 'policy', identity: null, authoritySha256: configurationSha256 };
  const selection = buildDeliverySelection({
    request: normalized, recommendation, mode: 'workflow', proofPolicySha256,
    policySnapshotSha256: configurationSha256, selectedBy,
    selectionReason: 'creation-pinned-workflow-mapping'
  });
  const effectPolicy = buildEffectPolicy({ workId, request: normalized });
  const riskAssessment = buildRiskAssessment({ workId, request: normalized });
  const completionContract = buildCompletionContract({
    request: normalized, effectPolicySha256: effectPolicy.effectPolicySha256,
    proofPolicySha256, gapAcceptancePolicySha256,
    riskAssessmentSha256: riskAssessment.riskAssessmentSha256, promotionPolicySha256
  });
  const candidate = prefixed(candidateSha256);
  let proofSubject = null;
  let passport = null;
  if (candidate) {
    const proofCore = {
      schemaVersion: currentSchemaVersion('proof-subject'), kind: 'proof-subject', workId,
      candidateSha256: candidate,
      completionContractSha256: completionContract.contractSha256,
      effectPolicySha256: effectPolicy.effectPolicySha256, proofPolicySha256,
      proofProfile: normalized.proofProfile,
      worldModel: worldModel?.status === 'ready' && prefixed(worldModel.baselineSha256) ? {
        status: 'ready', baselineSha256: prefixed(worldModel.baselineSha256),
        candidateDeltaSha256: prefixed(worldModel.candidateDeltaSha256), reasonCode: null
      } : {
        status: 'unavailable', baselineSha256: null, candidateDeltaSha256: null,
        reasonCode: 'GDP_WORLD_MODEL_UNAVAILABLE'
      }
    };
    proofSubject = { ...proofCore, proofSubjectSha256: digest(proofCore) };
    readRecord('proof-subject', proofSubject);
    const passportCore = {
      schemaVersion: currentSchemaVersion('change-passport'), kind: 'change-passport',
      passportId: `GDP-WORKFLOW-${recordSha256({ workId, candidate }).slice(0, 24).toUpperCase()}`,
      revision: 1, priorPassportSha256: null, subject: { kind: 'story', id: workId },
      selectionSha256: selection.selectionSha256, candidateSha256: candidate,
      proofSubjectSha256: proofSubject.proofSubjectSha256, proofSummarySha256: null,
      decisionRefs: [], publicationRefs: [], status: 'candidate-ready'
    };
    passport = { ...passportCore, passportSha256: digest(passportCore) };
    readRecord('change-passport', passport);
  }
  const phases = (workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})).map(
    (phaseId) => workflow.phases?.[phaseId]
  ).filter(Boolean);
  if (phases.length > MAX_CHECKPOINTS) fail(`workflow exceeds ${MAX_CHECKPOINTS} phases.`);
  const checkpoints = phases.map((phase) => buildWorkflowCheckpointSatisfaction({
    workId, workflowProfile, phase, sourceRecordSha256,
    completionContractSha256: completionContract.contractSha256,
    proofSubjectSha256: proofSubject?.proofSubjectSha256 ?? null
  }));
  const core = {
    schemaVersion: 1, kind: 'gdp-workflow-delivery-projection', mode: 'observe',
    authority: 'creation-pinned-workflow', workId, workflowProfile,
    recommendation, selection, completionContract, effectPolicy, riskAssessment,
    proofSubject, passport, checkpoints,
    gaps: [
      ...(candidate ? [] : ['CANDIDATE_UNAVAILABLE']),
      ...(worldModel?.status === 'ready' ? [] : ['WORLD_MODEL_UNAVAILABLE_NON_BLOCKING'])
    ],
    guarantees: {
      sourceWorkflowRemainsAuthority: true, consumedByLifecycle: false, noWrites: true,
      noModel: true, astRequired: false, worldModelRequired: false
    }
  };
  return Object.freeze({ ...core, projectionSha256: digest(core) });
}
