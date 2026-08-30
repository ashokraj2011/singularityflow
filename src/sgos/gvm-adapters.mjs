/** Closed, bounded AGENT/DEVICE bridge for the installed GVM profile. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../records.mjs';
import { assertModelInvocationAllowed } from '../operation-context.mjs';
import { SingularityFlowError } from '../util.mjs';
import { MAXIMUM_AGENT_PROPOSAL_OUTPUT_BYTES, sha256 } from './contracts.mjs';
import {
  createAgentTaskContract, installedExecutionUnit, installedExecutionUnitManifests
} from './execution-units.mjs';
import { installedDeviceManifests, invokeSgosDevice } from './devices.mjs';

const DETERMINISTIC_AGENT = 'deterministic-translator';
const COPILOT_PROPOSAL_AGENT = 'copilot-cli';
const READ_ONLY_FILESYSTEM_DEVICE = 'filesystem-read';
const SANDBOX_CAS_DEVICE = 'sandbox-cas';
const AGENT_PARAMETER_KEYS = new Set([
  'objective', 'outputSchema', 'forbiddenScope', 'stopConditions', 'humanRequestPolicy'
]);

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
    if (![DETERMINISTIC_AGENT, COPILOT_PROPOSAL_AGENT].includes(id)) {
      fail(`Execution Unit '${id || 'unknown'}' is not part of the installed GVM profile.`,
        'SGOS_GEU_GVM_PROFILE_UNSUPPORTED', { executionUnitId: id || null });
    }
    const manifest = installedExecutionUnitManifests().find((entry) => entry.id === id);
    if (!manifest) fail(`Execution Unit '${id}' is not installed.`, 'SGOS_GEU_NOT_INSTALLED');
    manifestBinding(template, manifest, 'agent');
    const resources = template.resources ?? {};
    if (['reads', 'writes', 'devices', 'externalEffects'].some((field) => (
      !Array.isArray(resources[field] ?? []) || (resources[field]?.length ?? 0) > 0
    ))) {
      fail('The installed AGENT GVM profiles accept no repository, Device, or external-effect scope.',
        'SGOS_GEU_SANDBOX_SCOPE_UNSUPPORTED');
    }
    if (id === COPILOT_PROPOSAL_AGENT) {
      const unsafeCapability = Object.entries(manifest.capabilities ?? {})
        .find(([, enabled]) => enabled !== false);
      if (unsafeCapability || manifest.sandbox?.kind !== 'model-runner-no-tools'
          || manifest.network?.mode !== 'provider-only'
          || manifest.toolPolicy?.mode !== 'none') {
        fail('The installed Copilot manifest exceeds the proposal-only GVM profile.',
          'SGOS_GEU_GVM_PROFILE_UNSUPPORTED', {
            manifestSha256: manifest.manifestSha256,
            unsafeCapability: unsafeCapability?.[0] ?? null
          });
      }
      // This is deliberately checked after exact manifest and scope validation, but before an
      // attempt is opened or a provider can be launched. The CLI flag grants model invocation
      // permission only; it never changes Program or adapter authority.
      assertModelInvocationAllowed();
    }
    return Object.freeze({
      kind: 'agent', id, manifest, proposalOnly: id === COPILOT_PROPOSAL_AGENT
    });
  }
  if (template.opcode === 'DEVICE') {
    const id = String(template.metadata?.deviceId ?? template.operation ?? '');
    if (![READ_ONLY_FILESYSTEM_DEVICE, SANDBOX_CAS_DEVICE].includes(id)) {
      fail(`Device '${id || 'unknown'}' is not part of an installed GVM profile.`,
        'SGOS_DEVICE_GVM_PROFILE_UNSUPPORTED', { deviceId: id || null });
    }
    const manifest = installedDeviceManifests().find((entry) => entry.id === id);
    if (!manifest) fail(`Device '${id || 'unknown'}' is not installed.`, 'SGOS_DEVICE_NOT_INSTALLED');
    manifestBinding(template, manifest, 'device');
    const resources = template.resources ?? {};
    if (canonicalJson(resources.devices ?? []) !== canonicalJson([id])) {
      fail(`Device '${id}' task does not bind the exact installed Device resource.`,
        'SGOS_DEVICE_GVM_PROFILE_UNSUPPORTED');
    }
    if (id === READ_ONLY_FILESYSTEM_DEVICE) {
      if (manifest.effects?.class !== 'read-only'
          || (resources.writes?.length ?? 0) > 0
          || (resources.externalEffects?.length ?? 0) > 0) {
        fail(`Device '${id}' task exceeds the installed read-only resource profile.`,
          'SGOS_DEVICE_GVM_PROFILE_UNSUPPORTED');
      }
    } else {
      const writes = stringArray(resources.writes ?? [], 'DEVICE declared write resources');
      const effects = stringArray(
        resources.externalEffects ?? [], 'DEVICE declared external-effect resources'
      );
      if (manifest.effects?.class !== 'local-consequential'
          || manifest.effects?.boundary !== 'git-common-sgos-fixture'
          || manifest.effects?.applicationFiles !== false
          || (resources.reads?.length ?? 0) !== 0
          || writes.length !== 1
          || canonicalJson(writes) !== canonicalJson(effects)) {
        fail(`Device '${id}' task exceeds the installed consequential fixture profile.`,
          'SGOS_DEVICE_GVM_PROFILE_UNSUPPORTED');
      }
    }
    return Object.freeze({ kind: 'device', id, manifest });
  }
  return null;
}

function agentContract(process, task, template, manifest, workingSet) {
  const parameters = plain(template.metadata?.parameters) ? template.metadata.parameters : {};
  const resources = template.resources ?? {};
  const budgets = plain(template.metadata?.budgets) ? template.metadata.budgets : {};
  const proposalOnly = manifest.id === COPILOT_PROPOSAL_AGENT;
  const unexpectedParameters = Object.keys(parameters)
    .filter((key) => !AGENT_PARAMETER_KEYS.has(key));
  if (proposalOnly && unexpectedParameters.length) {
    fail('Copilot proposal parameters contain unsupported provider or tool controls.',
      'SGOS_GEU_CONTRACT_INVALID', { unexpected: unexpectedParameters.sort() });
  }
  const expectedModelInvocations = proposalOnly ? 1 : 0;
  if ((budgets.modelInvocations != null
      && budgets.modelInvocations !== expectedModelInvocations)
      || (budgets.touchedResources != null && budgets.touchedResources !== 0)) {
    fail('AGENT task budgets contradict the installed execution profile.',
      'SGOS_GEU_CONTRACT_INVALID', {
        expectedModelInvocations,
        receivedModelInvocations: budgets.modelInvocations ?? null,
        receivedTouchedResources: budgets.touchedResources ?? null
      });
  }
  if (proposalOnly && parameters.outputSchema != null
      && canonicalJson(parameters.outputSchema) !== canonicalJson({ type: 'string' })) {
    fail('Copilot proposal output schema must be the installed bounded string envelope.',
      'SGOS_GEU_CONTRACT_INVALID');
  }
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
    outputSchema: proposalOnly
      ? { type: 'string' }
      : plain(parameters.outputSchema) ? structuredClone(parameters.outputSchema) : { type: 'object' },
    requiredEvidence: requiredEvidence(template),
    budgets: {
      activeMinutes: Number.isSafeInteger(budgets.activeMinutes) ? budgets.activeMinutes : 1,
      modelInvocations: expectedModelInvocations,
      touchedResources: (resources.reads?.length ?? 0) + (resources.writes?.length ?? 0)
    },
    stopConditions: stringArray(parameters.stopConditions ?? [], 'AGENT stop conditions'),
    humanRequestPolicy: plain(parameters.humanRequestPolicy)
      ? structuredClone(parameters.humanRequestPolicy) : {},
    subagentPolicy: { allowed: false },
    rawEvidencePolicy: proposalOnly ? {
      mode: 'proposal-artifact',
      storage: 'process-local-immutable-record',
      maximumBytes: MAXIMUM_AGENT_PROPOSAL_OUTPUT_BYTES
    } : { mode: 'digest-only' },
    workingSet,
    executionUnitManifestSha256: manifest.manifestSha256
  });
}

async function executeAgent(root, context, adapter, signal, executionUnitOptions = {}) {
  const unit = installedExecutionUnit(adapter.id, { root, ...executionUnitOptions });
  const contract = agentContract(
    context.begun, context.task, context.template, adapter.manifest, context.workingSet
  );
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
    if (!adapter.proposalOnly) {
      const expected = {
        objective: contract.objective,
        acceptanceClauses: [...contract.acceptanceClauses],
        inputs: [...contract.inputs]
      };
      if (canonicalJson(result.output) !== canonicalJson(expected)) {
        fail('Deterministic Execution Unit output failed independent reconstruction.',
          'SGOS_GEU_RESULT_INVALID');
      }
    }
    if (adapter.proposalOnly && typeof result.output !== 'string') {
      fail('Copilot Execution Unit result is not a proposal string.',
        'SGOS_GEU_RESULT_INVALID');
    }
    const outputSha256 = sha256(result.output);
    if (adapter.proposalOnly) {
      const rawOutputSha256 = `sha256:${createHash('sha256')
        .update(result.output, 'utf8').digest('hex')}`;
      if (typeof result.output !== 'string'
          || result.candidate?.kind !== 'model-proposal'
          || result.candidate?.authority !== 'none'
          || result.candidate?.outputSha256 !== rawOutputSha256
          || result.candidate?.outputBytes !== Buffer.byteLength(result.output, 'utf8')
          || result.candidate?.provider !== COPILOT_PROPOSAL_AGENT
          || typeof result.candidate?.providerInvocationId !== 'string'
          || result.candidate?.providerAuditRef
            !== `model-invocation:${result.candidate?.providerInvocationId}`
          || result.outputSha256 !== outputSha256) {
        fail('Copilot Execution Unit result is not an exact proposal-only envelope.',
          'SGOS_GEU_RESULT_INVALID');
      }
    }
    return Object.freeze({
      method: adapter.proposalOnly
        ? 'execution-unit-proposal-envelope-integrity'
        : 'execution-unit-deterministic-reconstruction',
      rawResult: adapter.proposalOnly ? {
        status: 'proposal', authority: 'none', executionUnitId: adapter.id,
        contractSha256: contract.contractSha256, outputSha256
      } : {
        status: 'completed', executionUnitId: adapter.id,
        contractSha256: contract.contractSha256, outputSha256
      },
      outputRefs: adapter.proposalOnly ? [] : [outputSha256],
      evidenceRefs: [
        contract.contractSha256, quiescence.quiescenceReceiptSha256
      ],
      effectRefs: [],
      executionEvents,
      evidenceContext: {
        executionUnitManifest: adapter.manifest.manifestSha256,
        cost: adapter.proposalOnly
          ? { status: 'unavailable', amount: null }
          : { status: 'observed', amount: 0 }
      },
      proposalEvidence: adapter.proposalOnly ? {
        contractSha256: contract.contractSha256,
        executionUnitManifestSha256: adapter.manifest.manifestSha256,
        provider: result.candidate.provider,
        providerInvocationId: result.candidate.providerInvocationId,
        providerAuditRef: result.candidate.providerAuditRef,
        mediaType: 'text/plain; charset=utf-8',
        contentEncoding: 'base64',
        outputBase64: Buffer.from(result.output, 'utf8').toString('base64'),
        outputBytes: result.candidate.outputBytes,
        outputSha256: result.candidate.outputSha256,
        assurance: {
          kind: 'proposal-only', authority: 'none',
          verification: 'not-performed', approval: 'not-granted'
        }
      } : null
    });
  } finally {
    signal?.removeEventListener('abort', requestStop);
  }
}

function deviceParameters(template, adapter) {
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
  const resources = template.resources ?? {};
  if (adapter.id === READ_ONLY_FILESYSTEM_DEVICE) {
    if (canonicalJson(normalized.scope) !== canonicalJson(
      stringArray(resources.reads ?? [], 'DEVICE declared read resources')
    )) {
      fail('DEVICE invocation scope must exactly equal its compiled read-resource contract.',
        'SGOS_DEVICE_SCOPE_ESCAPE');
    }
  } else {
    const writes = stringArray(resources.writes ?? [], 'DEVICE declared write resources');
    const effects = stringArray(
      resources.externalEffects ?? [], 'DEVICE declared external-effect resources'
    );
    if (canonicalJson(normalized.scope) !== canonicalJson(writes)
        || canonicalJson(normalized.scope) !== canonicalJson(effects)) {
      fail('Consequential DEVICE scope must exactly equal its compiled write and effect contract.',
        'SGOS_DEVICE_SCOPE_ESCAPE');
    }
  }
  return normalized;
}

async function executeDevice(root, context, adapter, signal) {
  const parameters = deviceParameters(context.template, adapter);
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
  const safeEffect = adapter.id === READ_ONLY_FILESYSTEM_DEVICE
    ? result.effect?.class === 'none' && result.effect?.changed === false
    : result.effect?.class === 'local-consequential'
      && result.effect?.changed === true
      && result.assurance === 'exact-postcondition-verified'
      && parameters.scope.includes(result.effect?.resource);
  if (result.status !== 'observed' || result.verification?.status !== 'passed' || !safeEffect) {
    fail('Device result did not prove the exact installed effect profile.',
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
      // Device effect proof is carried by the verified Tool Result. Action Evidence's
      // pre/post state hashes bind different SGOS record types, so they are not direct
      // repository-state equality assertions.
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

export async function executeInstalledGvmAdapter(
  root, context, adapter, signal, executionUnitOptions = {}
) {
  if (adapter?.kind === 'agent') {
    return executeAgent(root, context, adapter, signal, executionUnitOptions);
  }
  if (adapter?.kind === 'device') return executeDevice(root, context, adapter, signal);
  fail('No installed GVM adapter was selected.', 'SGOS_GVM_ADAPTER_UNAVAILABLE');
}
