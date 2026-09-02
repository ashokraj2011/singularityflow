/**
 * Deterministic guided authoring for the installed SGOS core profile.
 *
 * This is deliberately smaller than the Workflow IR language. It creates one material KERNEL task,
 * one independently registered verifier, and one END task from explicit choices. More complex
 * graphs remain ordinary reviewed declarations. No model, clock, filesystem, identity, approval,
 * compilation, or execution dependency belongs in this module.
 */
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import {
  cloneSgosValue, sha256, validateIntentIr, validatePolicySnapshot
} from './contracts.mjs';
import { createSgosWorkflowCandidate } from './authoring.mjs';
import {
  SGOS_BUILTIN_OPERATION_MANIFESTS, SGOS_BUILTIN_OPERATION_VERIFIERS
} from './builtin-adapters.mjs';
import {
  confirmedSgosIntentClauses, validateSgosRegistrySnapshot
} from './compiler.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { compareSgosCodePoints } from './order.mjs';

export const SGOS_WORKFLOW_GUIDE_FORMAT = 'singularity-flow-sgos-workflow-guide/v1';
export const SGOS_WORKFLOW_CREATE_FORMAT = 'singularity-flow-sgos-workflow-create/v1';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const LOWER_KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const UNRESOLVED_FIELDS = new Set(['unknowns', 'contradictions']);
const EVIDENCE_FIELDS = new Set(['successCriteria', 'evidenceExpectations']);

function fail(message, code = 'SGOS_WORKFLOW_GUIDE_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) fail(`${label} must be an object.`);
  const vocabulary = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !vocabulary.has(key));
  if (unknown) fail(`${label} contains unknown field '${unknown}'.`, 'SGOS_WORKFLOW_GUIDE_INVALID', {
    field: unknown
  });
}

function requiredString(value, label, { pattern = null, maximumBytes = 512 } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, 'utf8') > maximumBytes) {
    fail(`${label} exceeds the ${maximumBytes}-byte authoring boundary.`,
      'SGOS_WORKFLOW_GUIDE_LIMIT', { label, maximumBytes });
  }
  if (pattern && !pattern.test(normalized)) fail(`${label} has an invalid format.`);
  return normalized;
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const member of Object.values(value)) freeze(member);
  return Object.freeze(value);
}

function registryOperations(snapshot) {
  const source = snapshot.operations;
  const values = Array.isArray(source)
    ? source
    : Object.entries(source).map(([id, entry]) => ({ id, ...entry }));
  return values.map((entry) => {
    const installed = SGOS_BUILTIN_OPERATION_MANIFESTS[entry.id] ?? null;
    const installedExact = installed != null
      && entry.status === 'active'
      && String(entry.version) === installed.version
      && entry.manifestSha256 === installed.manifestSha256
      && (entry.opcode == null || String(entry.opcode).toUpperCase() === 'KERNEL');
    const role = installedExact && installed.kind === 'kernel'
      ? 'operation'
      : installedExact && installed.kind === 'verifier' ? 'verifier' : null;
    const verifierId = role === 'operation'
      ? SGOS_BUILTIN_OPERATION_VERIFIERS[entry.id] ?? null
      : null;
    return freeze({
      id: entry.id,
      version: entry.version,
      status: entry.status,
      opcode: entry.opcode ?? 'KERNEL',
      kind: entry.kind ?? installed?.kind ?? 'operation',
      manifestSha256: entry.manifestSha256,
      guidedRole: role,
      guidedEligible: role != null,
      verificationOperationIds: verifierId == null ? [] : [verifierId]
    });
  }).sort((left, right) => compareSgosCodePoints(left.id, right.id));
}

function clauseRows(intentIr) {
  return confirmedSgosIntentClauses(intentIr).map((clause) => ({
    clauseId: clause.clauseId,
    field: clause.field,
    required: clause.required,
    statement: clause.value.statement ?? canonicalJson(clause.value.value)
  }));
}

function sealed(core, hashField) {
  return freeze({ ...core, [hashField]: sha256(core) });
}

/** Read-only data for CLI, Copilot, and editor authoring surfaces. */
export function createSgosWorkflowGuide(requestValue) {
  const request = cloneSgosValue(requestValue);
  exactKeys(request, ['intentIr', 'registrySnapshot'], 'workflow guide request');
  const intentIr = validateIntentIr(request.intentIr);
  const registrySnapshot = validateSgosRegistrySnapshot(request.registrySnapshot);
  const clauses = clauseRows(intentIr);
  const unresolvedRequiredClauses = clauses
    .filter((clause) => clause.required && UNRESOLVED_FIELDS.has(clause.field));
  const operations = registryOperations(registrySnapshot);
  const eligibleVerificationOperations = operations
    .filter((operation) => operation.guidedRole === 'verifier');
  const eligibleVerifierIds = new Set(eligibleVerificationOperations.map((entry) => entry.id));
  const eligibleOperations = operations.filter((operation) =>
    operation.guidedRole === 'operation'
      && operation.verificationOperationIds.some((id) => eligibleVerifierIds.has(id)));
  const blockers = [];
  if (unresolvedRequiredClauses.length) {
    blockers.push({
      code: 'SGOS_WORKFLOW_GUIDE_HUMAN_DECISION_REQUIRED',
      message: 'The bounded creator cannot silently resolve a required unknown or contradiction; confirm the Intent again or author an explicit Human Request task.',
      clauseIds: unresolvedRequiredClauses.map((entry) => entry.clauseId)
    });
  }
  if (!eligibleOperations.length) {
    blockers.push({
      code: 'SGOS_WORKFLOW_GUIDE_OPERATION_UNAVAILABLE',
      message: 'The pinned registry has no exact installed core operation and compatible independent verifier for the bounded creator.',
      clauseIds: []
    });
  }
  return sealed({
    format: SGOS_WORKFLOW_GUIDE_FORMAT,
    intent: {
      intentId: intentIr.intentId,
      intentIrSha256: intentIr.intentIrSha256,
      objective: intentIr.objective.statement,
      clauseCount: clauses.length,
      requiredClauseCount: clauses.filter((entry) => entry.required).length
    },
    registrySnapshotSha256: registrySnapshot.registrySnapshotSha256,
    clauses,
    unresolvedRequiredClauses,
    operations,
    eligibleOperations,
    eligibleVerificationOperations,
    defaults: {
      maximumAttempts: 1,
      outputRef: 'artifact:result',
      declarationDirectory: 'singularity/sgos-drafts/<id>'
    },
    installedLimits: {
      maximumTasks: SGOS_INSTALLED_LIMITS.maximumTasks,
      maximumAttemptsPerTask: SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask
    },
    scope: {
      profile: 'core-single-operation',
      modelPolicy: 'never',
      createsAuthority: false,
      supportsAdvancedGraphs: false
    },
    blockers
  }, 'guideSha256');
}

function coverageFor(intentIr) {
  const clauses = {};
  const tasks = { run: [{ kind: 'verification', sourceId: 'run' }] };
  const taskClauseIds = [];
  for (const clause of clauseRows(intentIr)) {
    if (UNRESOLVED_FIELDS.has(clause.field)) continue;
    if (clause.field === 'nonGoals') {
      clauses[clause.clauseId] = [{ kind: 'explicit-non-goal', targetId: clause.clauseId }];
      continue;
    }
    if (EVIDENCE_FIELDS.has(clause.field)) {
      clauses[clause.clauseId] = [{ kind: 'evidence-contract', targetId: 'run' }];
      continue;
    }
    clauses[clause.clauseId] = [{ kind: 'task', targetId: 'run' }];
    tasks.run.push({ kind: 'intent-clause', sourceId: clause.clauseId });
    taskClauseIds.push(clause.clauseId);
  }
  return {
    intentWorkflowMap: { clauses, tasks },
    taskClauseIds: taskClauseIds.sort(compareSgosCodePoints)
  };
}

function selectedOperation(guide, id, label, role) {
  const operation = guide.operations.find((entry) => entry.id === id);
  if (!operation) {
    fail(`${label} '${id}' is not present in the pinned registry.`,
      'SGOS_WORKFLOW_OPERATION_UNKNOWN', { operation: id });
  }
  if (operation.guidedRole !== role) {
    fail(`${label} '${id}' is outside the installed core single-operation ${role} catalog. Author an explicit declaration for signed Pack or non-KERNEL operations.`,
      'SGOS_WORKFLOW_OPERATION_UNSUPPORTED', { operation: id });
  }
  return operation;
}

/**
 * Produce a declaration and validate its exact Workflow Candidate through the canonical compiler
 * authoring boundary. The result still carries no ratification or Program authority.
 */
export function createSgosGuidedWorkflow(requestValue) {
  const request = cloneSgosValue(requestValue);
  exactKeys(request, ['intentIr', 'policySnapshot', 'registrySnapshot', 'selection'],
    'guided workflow request');
  const intentIr = validateIntentIr(request.intentIr);
  const policySnapshot = validatePolicySnapshot(request.policySnapshot);
  const registrySnapshot = validateSgosRegistrySnapshot(request.registrySnapshot);
  const selection = request.selection;
  exactKeys(selection, [
    'id', 'title', 'operation', 'verificationOperation', 'storageProfileSha256',
    'maximumAttempts', 'outputRef'
  ], 'guided workflow selection');
  const id = requiredString(selection.id, 'workflow ID', { pattern: LOWER_KEBAB, maximumBytes: 96 });
  const title = selection.title == null || selection.title === ''
    ? id : requiredString(selection.title, 'workflow title', { maximumBytes: 256 });
  const operationId = requiredString(selection.operation, 'operation', { maximumBytes: 160 });
  const verificationOperationId = requiredString(
    selection.verificationOperation, 'verification operation', { maximumBytes: 160 }
  );
  const storageProfileSha256 = requiredString(
    selection.storageProfileSha256, 'storage profile SHA-256', { pattern: SHA256, maximumBytes: 71 }
  );
  const maximumAttempts = selection.maximumAttempts ?? 1;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1
      || maximumAttempts > SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask) {
    fail('maximumAttempts is outside the installed positive retry ceiling.',
      'SGOS_WORKFLOW_BOUND_INVALID', {
        maximumAttempts,
        installedMaximumAttempts: SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask
      });
  }
  const outputRef = requiredString(selection.outputRef ?? 'artifact:result', 'output resource', {
    maximumBytes: 512
  });
  const guide = createSgosWorkflowGuide({ intentIr, registrySnapshot });
  if (guide.blockers.length) {
    fail('The confirmed Intent or pinned registry is not eligible for the bounded Workflow creator.',
      'SGOS_WORKFLOW_GUIDE_BLOCKED', { blockers: guide.blockers });
  }
  const operation = selectedOperation(guide, operationId, 'Operation', 'operation');
  if (operationId === verificationOperationId) {
    fail('The verifier must be a different registered operation from the operation it checks.',
      'SGOS_WORKFLOW_VERIFIER_NOT_INDEPENDENT', { operation: operationId });
  }
  const verificationOperation = selectedOperation(
    guide, verificationOperationId, 'Verification operation', 'verifier'
  );
  if (!operation.verificationOperationIds.includes(verificationOperationId)) {
    fail(`Verification operation '${verificationOperationId}' is not the installed verifier for '${operationId}'.`,
      'SGOS_WORKFLOW_VERIFIER_INCOMPATIBLE', {
        operation: operationId,
        verifier: verificationOperationId,
        allowed: operation.verificationOperationIds
      });
  }

  const coverage = coverageFor(intentIr);
  const declaration = {
    version: '1',
    metadata: { id, version: '1', domainPack: 'core', title },
    spec: {
      inputs: {},
      tasks: {
        run: {
          kind: 'task',
          opcode: 'KERNEL',
          operation: operationId,
          dependsOn: [],
          resources: {
            reads: [], writes: [outputRef], devices: [], externalEffects: []
          },
          evidence: { required: ['candidate-snapshot', 'verification-result'] },
          authority: {},
          recovery: {},
          intentClauseIds: coverage.taskClauseIds,
          material: true,
          metadata: {
            operationVersion: String(operation.version),
            operationManifestSha256: operation.manifestSha256,
            verification: {
              kind: 'kernel',
              operation: verificationOperationId,
              operationVersion: String(verificationOperation.version)
            },
            verificationOperationVersion: String(verificationOperation.version),
            verificationOperationManifestSha256: verificationOperation.manifestSha256,
            authoringProfile: 'core-single-operation/v1'
          },
          inputs: [],
          outputs: [{ ref: outputRef }],
          retry: { maximumAttempts }
        },
        end: {
          kind: 'end', opcode: 'END', dependsOn: ['run'], material: false
        }
      },
      joins: {},
      terminalConditions: [{ taskTemplateId: 'end', state: 'succeeded' }],
      budgets: { maximumTasks: 2, maximumAttempts },
      recovery: {},
      evidence: {},
      authority: {},
      storageRequirements: { profileSha256: storageProfileSha256 },
      intentWorkflowMap: coverage.intentWorkflowMap
    }
  };
  const workflow = createSgosWorkflowCandidate({ intentIr, policySnapshot, declaration });
  const selectionSha256 = sha256({
    intentIrSha256: intentIr.intentIrSha256,
    policySnapshotSha256: policySnapshot.snapshotSha256,
    registrySnapshotSha256: registrySnapshot.registrySnapshotSha256,
    id, title, operation: operationId, verificationOperation: verificationOperationId,
    storageProfileSha256, maximumAttempts, outputRef
  });
  return freeze({
    format: SGOS_WORKFLOW_CREATE_FORMAT,
    profile: 'core-single-operation',
    guideSha256: guide.guideSha256,
    selectionSha256,
    declaration,
    workflow,
    authority: {
      status: 'unratified',
      ratified: false,
      compiled: false,
      approved: false,
      executable: false
    }
  });
}
