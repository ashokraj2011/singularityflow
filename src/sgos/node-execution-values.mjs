/** Data-only Node syntax and digest binding for the frozen Execution Unit ABI. No process or file I/O. */
import {createHash} from 'node:crypto';
import path from 'node:path';
import {canonicalJson,cloneSgosRecordValue,EXECUTION_UNIT_ABI_SCHEMA} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
/** Native reporter syntax over an explicitly retained executor root, without looking at this host. */
export function qualifiedCheckReportRoot(reportRoot){
  const syntax=reportRoot?.grammar==='win32'?path.win32:reportRoot?.grammar==='posix'?path.posix:null;
  return Boolean(syntax&&typeof reportRoot.absolute==='string'&&syntax.isAbsolute(reportRoot.absolute));
}
export function qualifiedCheckReportLocation(file,reportRoot){
  const syntax=reportRoot?.grammar==='win32'?path.win32:reportRoot?.grammar==='posix'?path.posix:null;
  if(!qualifiedCheckReportRoot(reportRoot)||typeof file!=='string'||!syntax.isAbsolute(file))return null;
  const relative=syntax.relative(reportRoot.absolute,file),parts=relative.split(syntax.sep);
  return !relative||syntax.isAbsolute(relative)||parts.some(part=>['','..','.'].includes(part))?null:parts.join('/');
}
function sha256(value){const bytes=Buffer.isBuffer(value)||value instanceof Uint8Array?Buffer.from(value)
  :typeof value==='string'?value:canonicalJson(cloneSgosRecordValue(value));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;}

const ID = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
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
    schemaVersion: EXECUTION_UNIT_ABI_SCHEMA.currentVersion, // Execution Unit ABI envelope, never persisted by this adapter
    kind,
    ...structuredClone(value)
  };
  delete core[hashField];
  return freezeDeep({ ...core, [hashField]: sha256(core) });
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

export {HASH,fail,exactKeys,stringArray,freezeDeep,seal,sha256};
