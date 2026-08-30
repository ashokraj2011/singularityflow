/** Closed, bounded AGENT/DEVICE bridge for the installed GVM profile. */
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { sha256 } from './contracts.mjs';
import {
  createAgentTaskContract, installedExecutionUnit, installedExecutionUnitManifests
} from './execution-units.mjs';
import { installedDeviceManifests, invokeSgosDevice } from './devices.mjs';

const DETERMINISTIC_AGENT = 'deterministic-translator';
const READ_ONLY_FILESYSTEM_DEVICE = 'filesystem-read';

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    fail(`${label} must be an array of non-empty strings.`, 'SGOS_GVM_ADAPTER_CONTRACT_INVALID');
  }
  return [...new Set(value)].sort();
}

function requiredEvidence(template) {
  const evidence = template.evidence ?? {};
  const required = Array.isArray(evidence)
    ? evidence
    : evidence.required ?? evidence.requiredEvidence ?? [];
  return stringArray(required, 'AGENT required evidence');
}

function manifestBinding(template, manifest, kind) {
  const prefix = kind === 'agent' ? 'executionUnit' : 'device';
  const id = String(template.metadata?.[`${prefix}Id`] ?? template.operation ?? '');
  const version = template.metadata?.[`${prefix}Version`];
  const digest = template.metadata?.[`${prefix}ManifestSha256`];
  if (id !== manifest.id || String(version ?? '') !== String(manifest.version)
      || digest !== manifest.manifestSha256) {
    fail(`${kind === 'agent' ? 'Execution Unit' : 'Device'} task is not bound to the exact installed manifest.`,
      kind === 'agent'
        ? 'SGOS_GEU_MANIFEST_MISMATCH'
        : 'SGOS_DEVICE_MANIFEST_MISMATCH', {
        expected: { id: manifest.id, version: manifest.version, manifestSha256: manifest.manifestSha256 },
        received: { id, version: version ?? null, manifestSha256: digest ?? null }
      });
  }
}

export function resolveInstalledGvmAdapter(template) {
  if (template.opcode === 'AGENT') {
    const id = String(template.metadata?.executionUnitId ?? template.operation ?? '');
    if (id !== DETERMINISTIC_AGENT) {
      fail(`Execution Unit '${id || 'unknown'}' is proposal-only and is not installed for GVM completion.`,
        'SGOS_GEU_GVM_PROFILE_UNSUPPORTED', { executionUnitId: id || null });
    }
    const manifest = installedExecutionUnitManifests().find((entry) => entry.id === id);
    if (!manifest) fail(`Execution Unit '${id}' is not installed.`, 'SGOS_GEU_NOT_INSTALLED');
    manifestBinding(template, manifest, 'agent');
    const resources = template.resources ?? {};
    if (['reads', 'writes', 'devices', 'externalEffects']
      .some((field) => (resources[field]?.length ?? 0) > 0)) {
      fail('The deterministic translator GVM profile accepts no repository, Device, or external-effect scope.',
        'SGOS_GEU_SANDBOX_SCOPE_UNSUPPORTED');
    }
    return Object.freeze({ kind: 'agent', id, manifest });
  }
  if (template.opcode === 'DEVICE') {
    const id = String(template.metadata?.deviceId ?? template.operation ?? '');
    if (id !== READ_ONLY_FILESYSTEM_DEVICE) {
      fail(`Device '${id || 'unknown'}' is not part of the installed read-only filesystem GVM profile.`,
        'SGOS_DEVICE_GVM_PROFILE_UNSUPPORTED', { deviceId: id || null });
    }
    const manifest = installedDeviceManifests().find((entry) => entry.id === id);
    if (!manifest) fail(`Device '${id || 'unknown'}' is not installed.`, 'SGOS_DEVICE_NOT_INSTALLED');
    manifestBinding(template, manifest, 'device');
    if (manifest.effects?.class !== 'read-only') {
      fail(`Device '${id}' is not part of the installed read-only GVM profile.`,
        'SGOS_DEVICE_GVM_PROFILE_UNSUPPORTED');
    }
    const resources = template.resources ?? {};
    if ((resources.writes?.length ?? 0) > 0 || (resources.externalEffects?.length ?? 0) > 0
        || canonicalJson(resources.devices ?? []) !== canonicalJson([id])) {
      fail(`Device '${id}' task exceeds the installed read-only resource profile.`,
        'SGOS_DEVICE_GVM_PROFILE_UNSUPPORTED');
    }
    return Object.freeze({ kind: 'device', id, manifest });
  }
  return null;
}

function agentContract(process, task, template, manifest) {
  const parameters = plain(template.metadata?.parameters) ? template.metadata.parameters : {};
  const resources = template.resources ?? {};
  const budgets = plain(template.metadata?.budgets) ? template.metadata.budgets : {};
  return createAgentTaskContract({
    taskId: task.taskInstanceId,
    processId: process.processId,
    instructionId: template.taskTemplateId,
    objective: typeof parameters.objective === 'string' && parameters.objective.trim()
      ? parameters.objective.trim()
      : `Produce the deterministic result for ${template.taskTemplateId}.`,
    acceptanceClauses: stringArray(template.intentClauseIds ?? [], 'AGENT acceptance clauses'),
    policySnapshotSha256: process.policySnapshotSha256,
    programSha256: process.programSha256,
    inputs: stringArray(task.inputRefs ?? [], 'AGENT inputs'),
    readScope: stringArray(resources.reads ?? [], 'AGENT read scope'),
    writeScope: stringArray(resources.writes ?? [], 'AGENT write scope'),
    forbiddenScope: stringArray(parameters.forbiddenScope ?? ['.git'], 'AGENT forbidden scope'),
    allowedDevices: stringArray(resources.devices ?? [], 'AGENT allowed devices'),
    environmentManifestSha256: process.processBindingSha256,
    candidatePolicy: 'immutable-snapshot',
    outputSchema: plain(parameters.outputSchema) ? structuredClone(parameters.outputSchema) : { type: 'object' },
    requiredEvidence: requiredEvidence(template),
    budgets: {
      activeMinutes: Number.isSafeInteger(budgets.activeMinutes) ? budgets.activeMinutes : 1,
      modelInvocations: 0,
      touchedResources: (resources.reads?.length ?? 0) + (resources.writes?.length ?? 0)
    },
    stopConditions: stringArray(parameters.stopConditions ?? [], 'AGENT stop conditions'),
    humanRequestPolicy: plain(parameters.humanRequestPolicy)
      ? structuredClone(parameters.humanRequestPolicy) : {},
    subagentPolicy: { allowed: false },
    rawEvidencePolicy: { mode: 'digest-only' },
    executionUnitManifestSha256: manifest.manifestSha256
  });
}

async function executeAgent(root, context, adapter, signal) {
  const unit = installedExecutionUnit(adapter.id, { root });
  const contract = agentContract(context.begun, context.task, context.template, adapter.manifest);
  const handle = await unit.start(contract);
  let stopPromise = null;
  const requestStop = () => {
    stopPromise ??= unit.requestStop(handle, { reason: 'SGOS Process stop requested.' });
  };
  if (signal?.aborted) requestStop();
  signal?.addEventListener('abort', requestStop, { once: true });
  try {
    const executionEvents = [];
    for await (const entry of unit.observe(handle)) executionEvents.push(entry);
    if (stopPromise) await stopPromise;
    const quiescence = await unit.quiesce(handle);
    if (signal?.aborted) {
      fail('AGENT execution stopped before its candidate could be admitted.',
        'SGOS_PROCESS_STOP_REQUESTED');
    }
    const result = await unit.collect(handle);
    const expected = {
      objective: contract.objective,
      acceptanceClauses: [...contract.acceptanceClauses],
      inputs: [...contract.inputs]
    };
    if (canonicalJson(result.output) !== canonicalJson(expected)) {
      fail('Deterministic Execution Unit output failed independent reconstruction.',
        'SGOS_GEU_RESULT_INVALID');
    }
    const outputSha256 = sha256(result.output);
    return Object.freeze({
      method: 'execution-unit-deterministic-reconstruction',
      rawResult: {
        status: 'completed', executionUnitId: adapter.id,
        contractSha256: contract.contractSha256, outputSha256
      },
      outputRefs: [outputSha256],
      evidenceRefs: [contract.contractSha256, quiescence.quiescenceReceiptSha256],
      effectRefs: [],
      executionEvents,
      evidenceContext: {
        executionUnitManifest: adapter.manifest.manifestSha256,
        cost: { status: 'observed', amount: 0 }
      }
    });
  } finally {
    signal?.removeEventListener('abort', requestStop);
  }
}

function deviceParameters(template) {
  const value = template.metadata?.parameters;
  if (!plain(value)) {
    fail('DEVICE task requires parameters with operation, arguments, and scope.',
      'SGOS_DEVICE_REQUEST_INVALID');
  }
  const unexpected = Object.keys(value).filter((key) => !['operation', 'arguments', 'scope'].includes(key));
  if (unexpected.length || typeof value.operation !== 'string' || !value.operation
      || !plain(value.arguments)) {
    fail('DEVICE task parameters are malformed.', 'SGOS_DEVICE_REQUEST_INVALID', { unexpected });
  }
  const normalized = {
    operation: value.operation,
    arguments: structuredClone(value.arguments),
    scope: stringArray(value.scope ?? [], 'DEVICE scope')
  };
  if (canonicalJson(normalized.scope) !== canonicalJson(
    stringArray(template.resources?.reads ?? [], 'DEVICE declared read resources')
  )) {
    fail('DEVICE invocation scope must exactly equal its compiled read-resource contract.',
      'SGOS_DEVICE_SCOPE_ESCAPE');
  }
  return normalized;
}

async function executeDevice(root, context, adapter, signal) {
  const parameters = deviceParameters(context.template);
  const invocation = await invokeSgosDevice(root, {
    deviceId: adapter.id,
    processId: context.begun.processId,
    taskInstanceId: context.task.taskInstanceId,
    attemptId: context.attemptId,
    operation: parameters.operation,
    arguments: parameters.arguments,
    scope: parameters.scope,
    authorizationSha256: adapter.manifest.manifestSha256,
    createdAt: context.startedAt
  }, { signal });
  if (signal?.aborted) {
    fail('DEVICE execution stopped before its result could be admitted.',
      'SGOS_PROCESS_STOP_REQUESTED');
  }
  const { intent, result } = invocation;
  if (result.status !== 'observed' || result.verification?.status !== 'passed'
      || result.effect?.class !== 'none' || result.effect?.changed !== false) {
    fail('Read-only Device result did not prove a verified, effect-free observation.',
      'SGOS_DEVICE_RESULT_UNSAFE', {
        status: result.status ?? null,
        verificationStatus: result.verification?.status ?? null,
        effectClass: result.effect?.class ?? null,
        changed: result.effect?.changed ?? null
      });
  }
  return Object.freeze({
    method: 'device-tool-result-integrity',
    rawResult: {
      status: 'completed', deviceId: adapter.id,
      toolIntents: [intent.intentSha256], toolResults: [result.resultSha256],
      // Read-only effect proof is carried by the verified Tool Result. Do not
      // set observedWrites here: Action Evidence's pre/post state hashes bind
      // different record types (Process and Candidate), so treating them as a
      // direct state-equality assertion would manufacture a contradiction.
      observationSha256: sha256(result.observation)
    },
    outputRefs: [result.resultSha256],
    evidenceRefs: [intent.intentSha256, result.resultSha256],
    effectRefs: result.effect?.changed === true ? [result.resultSha256] : [],
    executionEvents: [
      { sequence: 1, type: 'tool-intent', eventSha256: intent.intentSha256 },
      { sequence: 2, type: 'tool-result', eventSha256: result.resultSha256 }
    ],
    evidenceContext: {
      deviceManifest: adapter.manifest.manifestSha256,
      cost: { status: 'observed', amount: 0 }
    }
  });
}

export async function executeInstalledGvmAdapter(root, context, adapter, signal) {
  if (adapter?.kind === 'agent') return executeAgent(root, context, adapter, signal);
  if (adapter?.kind === 'device') return executeDevice(root, context, adapter, signal);
  fail('No installed GVM adapter was selected.', 'SGOS_GVM_ADAPTER_UNAVAILABLE');
}
