/** Governed Execution Unit ABI and the installed local adapters. */
import { lstat, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { loadDefinition } from '../config.mjs';
import { invokeModel, resolveModelProvider } from '../model-runner.mjs';
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError, nowIso } from '../util.mjs';
import { tryWindowsTaskkill } from '../platform-process.mjs';
import { MAXIMUM_AGENT_PROPOSAL_OUTPUT_BYTES, sha256 } from './contracts.mjs';

const ID = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS = 4096;
const MAX_SESSIONS = 1024;
const TERMINATION_GRACE_MS = 2_000;
const SAFE_PROCESS_ENVIRONMENT = new Set([
  'CI', 'LANG', 'LC_ALL', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP',
  'TMPDIR', 'TZ', 'WINDIR'
]);
const CONTRACT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'taskId', 'processId', 'instructionId', 'objective',
  'acceptanceClauses', 'policySnapshotSha256', 'programSha256', 'inputs', 'readScope',
  'writeScope', 'forbiddenScope', 'allowedDevices', 'environmentManifestSha256',
  'candidatePolicy', 'outputSchema', 'requiredEvidence', 'budgets', 'stopConditions',
  'humanRequestPolicy', 'subagentPolicy', 'rawEvidencePolicy',
  'workingSet', 'executionUnitManifestSha256', 'contractSha256'
]);

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!plain(value)) fail(`${label} must be an object.`, 'SGOS_GEU_CONTRACT_INVALID');
  const accepted = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !accepted.has(key));
  if (unexpected.length) fail(`${label} contains unsupported field(s): ${unexpected.join(', ')}.`,
    'SGOS_GEU_CONTRACT_INVALID', { unexpected });
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    fail(`${label} must be an array of non-empty strings.`, 'SGOS_GEU_CONTRACT_INVALID');
  }
  if (new Set(value).size !== value.length) fail(`${label} contains duplicates.`, 'SGOS_GEU_CONTRACT_INVALID');
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function seal(kind, hashField, value) {
  const core = {
    schemaVersion: 1, // schema-transient: Execution Unit ABI envelope, never persisted by this adapter
    kind,
    ...structuredClone(value)
  };
  delete core[hashField];
  return freezeDeep({ ...core, [hashField]: sha256(core) });
}

function bytesSha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function createExecutionUnitManifest(value) {
  exactKeys(value, [
    'id', 'version', 'publisher', 'provider', 'models', 'capabilities', 'sandbox',
    'network', 'toolPolicy', 'risk', 'tests', 'command'
  ], 'Execution Unit manifest');
  if (!ID.test(String(value.id ?? '')) || !VERSION.test(String(value.version ?? ''))) {
    fail('Execution Unit manifest has an invalid ID or semantic version.', 'SGOS_GEU_MANIFEST_INVALID');
  }
  for (const field of ['publisher', 'provider']) {
    if (typeof value[field] !== 'string' || !value[field]) fail(`Execution Unit ${field} is required.`, 'SGOS_GEU_MANIFEST_INVALID');
  }
  if (!plain(value.capabilities) || !plain(value.sandbox) || !plain(value.network)
      || !plain(value.toolPolicy) || !plain(value.risk) || !plain(value.tests)) {
    fail('Execution Unit manifest policy sections must be objects.', 'SGOS_GEU_MANIFEST_INVALID');
  }
  stringArray(value.models ?? [], 'Execution Unit models');
  if (!HASH.test(String(value.tests.conformanceReceiptSha256 ?? ''))) {
    fail('Execution Unit manifest requires an exact conformance receipt.', 'SGOS_GEU_MANIFEST_INVALID');
  }
  if (value.command != null) {
    exactKeys(value.command, [
      'executable', 'executableSha256', 'arguments', 'environmentAllowlist'
    ], 'Execution Unit command');
    if (typeof value.command.executable !== 'string' || !path.isAbsolute(value.command.executable)) {
      fail('Generic Execution Unit executable must be an absolute path.', 'SGOS_GEU_MANIFEST_INVALID');
    }
    if (!HASH.test(String(value.command.executableSha256 ?? ''))) {
      fail('Generic Execution Unit executable must be pinned by its byte digest.',
        'SGOS_GEU_MANIFEST_INVALID');
    }
    stringArray(value.command.arguments ?? [], 'Execution Unit command arguments');
    stringArray(value.command.environmentAllowlist ?? [], 'Execution Unit environment allowlist');
    const unsafeEnvironment = value.command.environmentAllowlist
      .filter((name) => !SAFE_PROCESS_ENVIRONMENT.has(name));
    if (unsafeEnvironment.length) {
      fail(`Generic Execution Unit environment allowlist contains unsafe name(s): ${unsafeEnvironment.join(', ')}.`,
        'SGOS_GEU_MANIFEST_INVALID', { unsafeEnvironment });
    }
  }
  return seal('execution-unit-manifest', 'manifestSha256', value);
}

export function validateExecutionUnitManifest(value) {
  if (value?.kind !== 'execution-unit-manifest' || !HASH.test(String(value.manifestSha256 ?? ''))) {
    fail('Execution Unit manifest is invalid.', 'SGOS_GEU_MANIFEST_INVALID');
  }
  const core = structuredClone(value);
  delete core.schemaVersion;
  delete core.kind;
  delete core.manifestSha256;
  const rebuilt = createExecutionUnitManifest(core);
  if (rebuilt.manifestSha256 !== value.manifestSha256 || canonicalJson(rebuilt) !== canonicalJson(value)) {
    fail('Execution Unit manifest failed its exact content hash.', 'SGOS_GEU_MANIFEST_MISMATCH');
  }
  return freezeDeep(structuredClone(value));
}

export function createAgentTaskContract(value) {
  exactKeys(value, CONTRACT_KEYS.filter((key) => !['schemaVersion', 'kind', 'contractSha256'].includes(key)),
    'Agent Task Contract');
  for (const field of ['taskId', 'processId', 'instructionId', 'objective']) {
    if (typeof value[field] !== 'string' || !value[field]) fail(`Agent Task Contract ${field} is required.`, 'SGOS_AGENT_TASK_CONTRACT_INVALID');
  }
  for (const field of ['policySnapshotSha256', 'programSha256', 'environmentManifestSha256', 'executionUnitManifestSha256']) {
    if (!HASH.test(String(value[field] ?? ''))) fail(`Agent Task Contract ${field} must be an exact digest.`, 'SGOS_AGENT_TASK_CONTRACT_INVALID');
  }
  for (const field of [
    'acceptanceClauses', 'inputs', 'readScope', 'writeScope', 'forbiddenScope',
    'allowedDevices', 'requiredEvidence', 'stopConditions'
  ]) stringArray(value[field] ?? [], `Agent Task Contract ${field}`);
  if (value.candidatePolicy !== 'immutable-snapshot') {
    fail('Agent Task Contract candidate policy must be immutable-snapshot.', 'SGOS_AGENT_TASK_CONTRACT_INVALID');
  }
  if (!plain(value.budgets) || !plain(value.outputSchema)) {
    fail('Agent Task Contract requires typed output and budget objects.', 'SGOS_AGENT_TASK_CONTRACT_INVALID');
  }
  const budgetLimits = [
    ['activeMinutes', 1, 24 * 60], ['modelInvocations', 0, 256], ['touchedResources', 0, 100_000]
  ];
  for (const [field, minimum, maximum] of budgetLimits) {
    const number = value.budgets[field];
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
      fail(`Agent Task Contract budget ${field} is outside the installed bounds.`, 'SGOS_AGENT_TASK_CONTRACT_INVALID');
    }
  }
  for (const field of ['humanRequestPolicy', 'subagentPolicy', 'rawEvidencePolicy']) {
    if (value[field] != null && !plain(value[field])) fail(`Agent Task Contract ${field} must be an object.`, 'SGOS_AGENT_TASK_CONTRACT_INVALID');
  }
  if (value.workingSet != null) {
    if (!plain(value.workingSet)
        || value.workingSet.kind !== 'gvm-working-set'
        || !HASH.test(String(value.workingSet.workingSetSha256 ?? ''))
        || value.workingSet.processId !== value.processId
        || value.workingSet.taskInstanceId !== value.taskId
        || value.workingSet.programSha256 !== value.programSha256
        || value.workingSet.policySnapshotSha256 !== value.policySnapshotSha256) {
      fail('Agent Task Contract workingSet is not bound to this exact task and Program.',
        'SGOS_AGENT_TASK_CONTRACT_INVALID');
    }
    // Importing the Memory validator here would create a cycle through the runtime adapter.
    // The content hash is still independently reconstructed before the contract is sealed.
    const workingSetCore = structuredClone(value.workingSet);
    delete workingSetCore.workingSetSha256;
    workingSetCore.workingSetSha256 = null;
    if (sha256(workingSetCore) !== value.workingSet.workingSetSha256) {
      fail('Agent Task Contract workingSet failed its exact content hash.',
        'SGOS_AGENT_TASK_CONTRACT_INVALID');
    }
  }
  return seal('agent-task-contract', 'contractSha256', value);
}

export function validateAgentTaskContract(value, manifest = null) {
  if (value?.kind !== 'agent-task-contract' || !HASH.test(String(value.contractSha256 ?? ''))) {
    fail('Agent Task Contract is invalid.', 'SGOS_AGENT_TASK_CONTRACT_INVALID');
  }
  const core = structuredClone(value);
  delete core.schemaVersion;
  delete core.kind;
  delete core.contractSha256;
  const rebuilt = createAgentTaskContract(core);
  if (rebuilt.contractSha256 !== value.contractSha256 || canonicalJson(rebuilt) !== canonicalJson(value)) {
    fail('Agent Task Contract failed its exact content hash.', 'SGOS_AGENT_TASK_CONTRACT_INVALID');
  }
  if (manifest && value.executionUnitManifestSha256 !== manifest.manifestSha256) {
    fail('Agent Task Contract is bound to another Execution Unit manifest.', 'SGOS_GEU_MANIFEST_MISMATCH');
  }
  return freezeDeep(structuredClone(value));
}

function event(handle, sequence, type, data = {}, priorEventSha256 = null) {
  return seal('execution-event', 'eventSha256', {
    handleSha256: handle.handleSha256,
    sequence,
    priorEventSha256,
    type,
    data,
    recordedAt: nowIso()
  });
}

function executionHandle(manifest, contract, adapterHandle) {
  return seal('execution-handle', 'handleSha256', {
    executionUnitManifestSha256: manifest.manifestSha256,
    contractSha256: contract.contractSha256,
    adapterHandle
  });
}

class BufferedExecution {
  constructor(manifest, contract, run) {
    this.manifest = manifest;
    this.contract = contract;
    this.controller = new AbortController();
    this.events = [];
    this.result = null;
    this.error = null;
    this.settled = false;
    this.stopReceipt = null;
    this.quiescenceReceipt = null;
    this.handle = executionHandle(manifest, contract, {
      kind: manifest.id, nonceSha256: sha256({ manifest: manifest.manifestSha256, contract: contract.contractSha256 })
    });
    this.push('started', { contractSha256: contract.contractSha256 });
    this.promise = Promise.resolve().then(() => run({
      signal: this.controller.signal,
      emit: (type, data = {}) => this.push(type, data)
    })).then((result) => {
      this.result = result;
      this.push('completed', { resultSha256: sha256(result) });
    }, (error) => {
      this.error = error;
      this.push('failed', { code: error?.code ?? 'SGOS_GEU_FAILED' });
    }).finally(() => { this.settled = true; });
  }

  push(type, data) {
    const terminal = type === 'completed' || type === 'failed';
    // Reserve the final slot for a terminal event. Otherwise an overflowing producer throws and
    // the promise rejection handler cannot append the failure that makes the stream terminal.
    if (this.events.length >= MAX_EVENTS || (!terminal && this.events.length >= MAX_EVENTS - 1)) {
      fail('Execution Unit event ceiling exceeded.', 'SGOS_GEU_EVENT_LIMIT');
    }
    this.events.push(event(this.handle, this.events.length + 1, type, data,
      this.events.at(-1)?.eventSha256 ?? null));
  }
}

function adapter(manifest, execute, doctor = async () => ({ status: 'ready' })) {
  const sessions = new Map();
  const sessionFor = (handle) => {
    const session = sessions.get(handle?.handleSha256);
    if (!session || canonicalJson(session.handle) !== canonicalJson(handle)) {
      fail('Execution Unit handle is stale or belongs to another adapter.', 'SGOS_GEU_HANDLE_STALE');
    }
    return session;
  };
  return Object.freeze({
    descriptor: () => manifest,
    async doctor(context = {}) {
      const observed = await doctor(context);
      return seal('execution-unit-attestation', 'attestationSha256', {
        executionUnitManifestSha256: manifest.manifestSha256,
        status: observed.status === 'ready' ? 'ready' : 'unavailable',
        capabilities: structuredClone(observed.capabilities ?? manifest.capabilities),
        observedAt: nowIso(),
        diagnosticCode: observed.diagnosticCode ?? null
      });
    },
    async planCapability(request) {
      const required = request?.requiredCapabilities ?? [];
      stringArray(required, 'Capability probe requirements');
      const unavailable = required.filter((name) => manifest.capabilities[name] !== true);
      return freezeDeep({ capable: unavailable.length === 0, unavailable });
    },
    async start(contract) {
      const validated = validateAgentTaskContract(contract, manifest);
      if (sessions.size >= MAX_SESSIONS) {
        for (const [handleSha256, existing] of sessions) {
          if (existing.settled) sessions.delete(handleSha256);
          if (sessions.size < MAX_SESSIONS) break;
        }
      }
      if (sessions.size >= MAX_SESSIONS) {
        fail('Execution Unit concurrent session ceiling exceeded.', 'SGOS_GEU_SESSION_LIMIT');
      }
      const session = new BufferedExecution(manifest, validated, (runtime) => execute(validated, runtime));
      sessions.set(session.handle.handleSha256, session);
      return session.handle;
    },
    async *observe(handle, cursor = 0) {
      const session = sessionFor(handle);
      if (!Number.isSafeInteger(cursor) || cursor < 0) fail('Execution event cursor is invalid.', 'SGOS_GEU_CURSOR_INVALID');
      while (!session.settled || cursor < session.events.length) {
        while (cursor < session.events.length) yield session.events[cursor++];
        if (!session.settled) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async requestStop(handle, request = {}) {
      exactKeys(request, ['reason'], 'Execution stop request');
      if (request.reason != null && (typeof request.reason !== 'string' || !request.reason.trim())) {
        fail('Execution stop reason must be a non-empty string.', 'SGOS_GEU_CONTRACT_INVALID');
      }
      const session = sessionFor(handle);
      const reason = request.reason?.trim() ?? 'Execution stop requested.';
      const reasonSha256 = sha256(reason);
      if (session.stopReceipt) {
        if (session.stopReceipt.reasonSha256 !== reasonSha256) {
          fail('Execution already has a stop decision bound to another reason.',
            'SGOS_GEU_STOP_CONFLICT');
        }
        return session.stopReceipt;
      }
      let acknowledged = false;
      if (!session.settled && !session.controller.signal.aborted) {
        session.controller.abort(new SingularityFlowError(reason, {
          code: 'SGOS_GEU_STOP_REQUESTED'
        }));
        session.push('stop-requested', { reasonSha256 });
        acknowledged = true;
      }
      session.stopReceipt = seal('stop-receipt', 'stopReceiptSha256', {
        handleSha256: session.handle.handleSha256,
        reasonSha256,
        acknowledged,
        requestedAt: nowIso()
      });
      return session.stopReceipt;
    },
    async quiesce(handle) {
      const session = sessionFor(handle);
      await session.promise;
      session.quiescenceReceipt ??= seal('quiescence-receipt', 'quiescenceReceiptSha256', {
        handleSha256: session.handle.handleSha256,
        quiescent: true,
        eventHeadSha256: session.events.at(-1)?.eventSha256 ?? null,
        observedAt: nowIso()
      });
      return session.quiescenceReceipt;
    },
    async collect(handle) {
      const session = sessionFor(handle);
      await session.promise;
      if (session.error) throw session.error;
      const result = structuredClone(session.result ?? {});
      return freezeDeep({
        kind: 'candidate-result',
        executionUnitManifestSha256: manifest.manifestSha256,
        contractSha256: session.contract.contractSha256,
        output: result.output ?? null,
        outputSha256: sha256(result.output ?? null),
        candidate: result.candidate ?? null,
        usage: result.usage ?? null,
        eventHeadSha256: session.events.at(-1)?.eventSha256 ?? null
      });
    }
  });
}

const TRANSLATOR_MANIFEST = createExecutionUnitManifest({
  id: 'deterministic-translator', version: '1.0.0', publisher: 'singularity-flow',
  provider: 'local-kernel', models: [],
  capabilities: { readFiles: false, writeFiles: false, shell: false, subagents: false, worktrees: false },
  sandbox: { kind: 'in-process-pure' }, network: { mode: 'deny' },
  toolPolicy: { mode: 'none' }, risk: { class: 'low' },
  tests: { conformanceReceiptSha256: sha256('sgos-deterministic-translator-v1') }
});

const COPILOT_MANIFEST = createExecutionUnitManifest({
  id: 'copilot-cli', version: '1.0.0', publisher: 'singularity-flow', provider: 'github',
  models: ['provider-selected'],
  // The installed v1 profile is proposal-only. Broader Copilot capabilities are not advertised
  // until an isolated candidate worktree and path-enforcing Device mediation are bound.
  capabilities: { readFiles: false, writeFiles: false, shell: false, subagents: false, worktrees: false },
  sandbox: { kind: 'model-runner-no-tools' }, network: { mode: 'provider-only' },
  toolPolicy: { mode: 'none' }, risk: { class: 'low' },
  tests: { conformanceReceiptSha256: sha256('sgos-copilot-acp-v1') }
});

export function createDeterministicTranslatorExecutionUnit() {
  return adapter(TRANSLATOR_MANIFEST, async (contract) => ({
    output: {
      objective: contract.objective,
      acceptanceClauses: [...contract.acceptanceClauses],
      inputs: [...contract.inputs]
    },
    usage: { modelInvocations: 0, assurance: 'deterministic' }
  }));
}

export function createCopilotExecutionUnit({ invoke = invokeModel, definition = null, root } = {}) {
  return adapter(COPILOT_MANIFEST, async (contract, runtime) => {
    if (!root || !path.isAbsolute(root)) fail('Copilot GEU requires a verified repository root.', 'SGOS_GEU_ROOT_REQUIRED');
    if (contract.readScope.length || contract.writeScope.length || contract.allowedDevices.length
        || contract.budgets.touchedResources !== 0 || contract.budgets.modelInvocations !== 1) {
      fail('Copilot GEU accepts exactly one model proposal with no repository, Device, or effect scope.',
        'SGOS_GEU_SANDBOX_SCOPE_UNSUPPORTED');
    }
    const provider = resolveModelProvider(definition ?? await loadDefinition(root));
    if (provider.provider !== 'copilot-cli') {
      fail(`Copilot GEU cannot dispatch configured provider '${provider.provider}'.`,
        'SGOS_GEU_PROVIDER_UNSUPPORTED', { provider: provider.provider });
    }
    const prompt = [
      'Execute only the following immutable SGOS Agent Task Contract.',
      'Return proposal text only. Do not use tools or repository context.',
      'Do not expand scope, alter policy, approve work, or claim verification.',
      canonicalJson(contract)
    ].join('\n\n');
    const result = await invoke({
      provider: provider.provider,
      providerConfig: provider.providerConfig,
      cwd: root,
      allowedRoots: [root],
      channel: 'sgos-geu-copilot-cli',
      task: 'code',
      prompt: { text: prompt },
      tools: {
        // The first installed Copilot GEU returns a candidate proposal only. It deliberately has
        // no direct tools until the runtime gives it a separately retained isolated worktree and
        // a path-enforcing device layer; Task Contract prose alone is not a sandbox.
        mode: 'none',
        names: [], requireSuccessful: true, rejectTruncated: true
      },
      limits: {
        timeoutMs: contract.budgets.activeMinutes * 60_000,
        outputBytes: MAXIMUM_AGENT_PROPOSAL_OUTPUT_BYTES,
        maxTurns: 'auto', maxToolCalls: 'auto', maxTotalTokens: 'auto', maxAiCredits: 'auto'
      },
      subject: { kind: 'sgos-task', id: contract.taskId, processId: contract.processId },
      auditRoot: root,
      signal: runtime.signal
    });
    if (!plain(result)
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(String(result.invocationId ?? ''))
        || typeof result.output !== 'string'
        || (result.status != null && result.status !== 'completed')
        || (result.invocation?.id != null && result.invocation.id !== result.invocationId)) {
      fail('Copilot GEU received an invalid provider result envelope.', 'SGOS_GEU_RESULT_INVALID');
    }
    if (result.provider != null && result.provider !== provider.provider) {
      fail('Copilot GEU provider result does not match the configured provider.',
        'SGOS_GEU_PROVIDER_ESCALATION', {
          expected: provider.provider, received: result.provider
        });
    }
    const outputBytes = Buffer.byteLength(result.output, 'utf8');
    const outputSha256 = createHash('sha256').update(result.output, 'utf8').digest('hex');
    if (outputBytes > MAXIMUM_AGENT_PROPOSAL_OUTPUT_BYTES
        || (result.outputBytes != null && result.outputBytes !== outputBytes)
        || (result.outputSha256 != null && result.outputSha256 !== outputSha256)) {
      fail('Copilot GEU provider result exceeds or contradicts the installed output bound.',
        'SGOS_GEU_OUTPUT_LIMIT', {
          maximumBytes: MAXIMUM_AGENT_PROPOSAL_OUTPUT_BYTES, outputBytes
        });
    }
    if (result.toolObservation != null
        || [result.usage?.toolCalls, result.usage?.totalToolCalls, result.usage?.maxToolCalls]
          .some((value) => Number.isFinite(value) && value > 0)) {
      fail('Copilot GEU refused provider tool escalation.', 'SGOS_GEU_TOOL_ESCALATION');
    }
    runtime.emit('provider-completed', { invocationIdSha256: sha256(result.invocationId) });
    return {
      output: result.output,
      candidate: {
        kind: 'model-proposal', authority: 'none', outputBytes,
        outputSha256: `sha256:${outputSha256}`,
        provider: provider.provider,
        providerInvocationId: result.invocationId,
        providerAuditRef: `model-invocation:${result.invocationId}`
      },
      usage: result.usage ?? null
    };
  }, async () => {
    try {
      if (!root || !path.isAbsolute(root)) {
        return {
          status: 'unavailable', capabilities: COPILOT_MANIFEST.capabilities,
          diagnosticCode: 'SGOS_GEU_ROOT_REQUIRED'
        };
      }
      const provider = resolveModelProvider(definition ?? await loadDefinition(root));
      return provider.provider === 'copilot-cli'
        ? { status: 'ready', capabilities: COPILOT_MANIFEST.capabilities }
        : {
            status: 'unavailable', capabilities: COPILOT_MANIFEST.capabilities,
            diagnosticCode: 'SGOS_GEU_PROVIDER_UNSUPPORTED'
          };
    } catch (error) {
      return {
        status: 'unavailable', capabilities: COPILOT_MANIFEST.capabilities,
        diagnosticCode: error?.code ?? 'SGOS_GEU_PROVIDER_UNAVAILABLE'
      };
    }
  });
}

export function createGenericProcessExecutionUnit(manifest, {
  root = null,
  authorizeManifest = null
} = {}) {
  const validated = validateExecutionUnitManifest(manifest);
  if (!validated.command) fail('Generic process Execution Unit requires a pinned command manifest.', 'SGOS_GEU_MANIFEST_INVALID');
  if (!root || !path.isAbsolute(root)) {
    fail('Generic process Execution Unit requires a verified absolute working root.',
      'SGOS_GEU_ROOT_REQUIRED');
  }
  if (typeof authorizeManifest !== 'function') {
    fail('Generic process Execution Unit requires registry authorization for its exact manifest.',
      'SGOS_GEU_AUTHORITY_REQUIRED', { manifestSha256: validated.manifestSha256 });
  }
  if (validated.sandbox?.enforcement !== 'external-attested'
      || !HASH.test(String(validated.sandbox?.attestationSha256 ?? ''))
      || validated.network?.mode !== 'deny') {
    fail('Generic process Execution Unit requires an externally attested sandbox and denied network.',
      'SGOS_GEU_SANDBOX_REQUIRED', { manifestSha256: validated.manifestSha256 });
  }
  async function assertPinnedExecutable() {
    let info;
    try { info = await lstat(validated.command.executable); } catch (error) {
      fail('Generic process Execution Unit executable is unavailable.',
        'SGOS_GEU_EXECUTABLE_MISSING', { causeCode: error?.code ?? null });
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      fail('Generic process Execution Unit executable must remain a regular non-symlink file.',
        'SGOS_GEU_EXECUTABLE_CHANGED');
    }
    const observedSha256 = bytesSha256(await readFile(validated.command.executable));
    if (observedSha256 !== validated.command.executableSha256) {
      fail('Generic process Execution Unit executable bytes changed after manifest review.',
        'SGOS_GEU_EXECUTABLE_CHANGED', {
          expectedSha256: validated.command.executableSha256,
          observedSha256
        });
    }
  }
  return adapter(validated, async (contract, runtime) => {
    const authorization = await authorizeManifest(validated);
    if (authorization !== true && authorization !== validated.manifestSha256) {
      fail('Generic process Execution Unit manifest is not authorized by the active registry.',
        'SGOS_GEU_AUTHORITY_REQUIRED', { manifestSha256: validated.manifestSha256 });
    }
    if (contract.readScope.length || contract.writeScope.length || contract.allowedDevices.length) {
      fail('The installed generic process profile accepts only pure contracts with no repository or Device scope.',
        'SGOS_GEU_SANDBOX_SCOPE_UNSUPPORTED', {
          readScope: contract.readScope.length,
          writeScope: contract.writeScope.length,
          allowedDevices: contract.allowedDevices.length
        });
    }
    await assertPinnedExecutable();
    const allowedEnvironment = Object.fromEntries(validated.command.environmentAllowlist
      .filter((key) => Object.hasOwn(process.env, key)).map((key) => [key, process.env[key]]));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(validated.command.executable, validated.command.arguments, {
        cwd: root, env: allowedEnvironment, shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
      });
      const stdout = [];
      const stderr = [];
      let bytes = 0;
      let overflow = false;
      let timedOut = false;
      let forceTimer = null;
      const terminate = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform === 'win32' && child.pid) {
          if (!tryWindowsTaskkill(child.pid, {
            environment: process.env, spawnSyncCommand: spawnSync, timeoutMs: 5_000
          })) child.kill('SIGTERM');
        } else {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        }
        forceTimer ??= setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          if (process.platform === 'win32' && child.pid) {
            if (!tryWindowsTaskkill(child.pid, {
              force: true, environment: process.env, spawnSyncCommand: spawnSync,
              timeoutMs: 5_000
            })) child.kill('SIGKILL');
          } else {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
          }
        }, TERMINATION_GRACE_MS);
        forceTimer.unref?.();
      };
      const append = (target, chunk) => {
        const value = Buffer.from(chunk);
        bytes += value.length;
        if (bytes > MAX_OUTPUT_BYTES) { overflow = true; terminate(); }
        else target.push(value);
      };
      child.stdout.on('data', (chunk) => append(stdout, chunk));
      child.stderr.on('data', (chunk) => append(stderr, chunk));
      child.on('error', reject);
      child.stdin.on('error', reject);
      const stop = () => terminate();
      runtime.signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(() => { timedOut = true; terminate(); },
        contract.budgets.activeMinutes * 60_000);
      child.on('close', (status, signal) => {
        runtime.signal.removeEventListener('abort', stop);
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        resolve({
          status: status ?? 1, signal, overflow, timedOut,
          stdout: Buffer.concat(stdout), stderrSha256: bytesSha256(Buffer.concat(stderr))
        });
      });
      child.stdin.end(canonicalJson(contract));
    });
    if (result.status !== 0 || result.overflow || result.timedOut) {
      const error = new SingularityFlowError('Generic Execution Unit process failed.', {
        code: result.overflow ? 'SGOS_GEU_OUTPUT_LIMIT'
          : result.timedOut ? 'SGOS_GEU_TIMEOUT' : 'SGOS_GEU_PROCESS_FAILED',
        details: { status: result.status, signal: result.signal, timedOut: result.timedOut }
      });
      error.uncertainEffect = contract.writeScope.length > 0;
      throw error;
    }
    let output;
    try { output = JSON.parse(result.stdout.toString('utf8')); } catch {
      fail('Generic Execution Unit returned invalid JSON.', 'SGOS_GEU_RESULT_INVALID');
    }
    return { output };
  }, async () => {
    try { await assertPinnedExecutable(); return { status: 'ready' }; }
    catch (error) {
      return {
        status: 'unavailable',
        diagnosticCode: error?.code ?? 'SGOS_GEU_EXECUTABLE_MISSING'
      };
    }
  });
}

export function installedExecutionUnitManifests() {
  return Object.freeze([TRANSLATOR_MANIFEST, COPILOT_MANIFEST]);
}

export function installedExecutionUnit(id, options = {}) {
  if (id === TRANSLATOR_MANIFEST.id) return createDeterministicTranslatorExecutionUnit();
  if (id === COPILOT_MANIFEST.id) return createCopilotExecutionUnit(options);
  fail(`Execution Unit '${id}' is not installed.`, 'SGOS_GEU_NOT_INSTALLED', { id });
}
