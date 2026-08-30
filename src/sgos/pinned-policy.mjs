/**
 * Strict pinned-policy amendment runtime.
 *
 * Policy inputs are read only from refreshed approved configuration.  Amendment records live in
 * the Git-common sidecar and are content addressed.  Most importantly, this module never rewrites
 * a Program or Process: a running Process keeps the policy hash with which it started.  A selected
 * invalidation is an explicit restart-required receipt, not an in-place policy rotation.
 */
import { constants as fsConstants } from 'node:fs';
import {
  lstat, mkdir, open, readdir, rename, rm
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import { configurationReadRoot } from '../configuration-read-scope.mjs';
import { gitCommonDir } from '../git.mjs';
import { canonicalJson } from '../records.mjs';
import {
  readRecord, stampCurrentRecord
} from '../schema-migrations.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { SingularityFlowError, nowIso, run } from '../util.mjs';
import {
  cloneSgosValue, recordSelfSha256, SHA256_PATTERN, validatePolicySnapshot
} from './contracts.mjs';
import { withTrustedSgosConfigurationRead } from './authority-trust.mjs';
import { loadApprovedPlatformMutationAuthority } from './platform/authority.mjs';
import {
  listSgosProcesses, readSgosProcess, readSgosProgram
} from './store.mjs';

export const SGOS_POLICY_CURRENT_PATH = 'singularity/sgos/policy/current.json';
export const SGOS_POLICY_CANDIDATE_PATH = 'singularity/sgos/policy/candidate.json';
export const SGOS_POLICY_COMPONENTS = Object.freeze([
  'lawSha256', 'registrySha256', 'executionUnitPolicySha256', 'devicePolicySha256',
  'storagePolicySha256', 'memoryPolicySha256', 'humanAuthoritySha256',
  'governedRootsSha256', 'verificationPolicySha256', 'publicationPolicySha256'
]);

const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const POLICY_ROOT_PARTS = ['singularity-flow', 'sgos', 'policy-runtime'];
const policyAuthorityScope = new AsyncLocalStorage();
const policyAuthorityWitnesses = new WeakMap();
let policyAuthorityReadObserverForTests = null;
const FAMILY = Object.freeze({
  bundle: Object.freeze({ family: 'sgos-policy-bundle', kind: 'sgos-policy-bundle', hash: 'bundleSha256' }),
  approval: Object.freeze({ family: 'sgos-policy-approval', kind: 'sgos-policy-approval', hash: 'approvalSha256' }),
  diff: Object.freeze({ family: 'sgos-policy-diff', kind: 'sgos-policy-diff', hash: 'diffSha256' }),
  impact: Object.freeze({ family: 'sgos-policy-impact', kind: 'sgos-policy-impact', hash: 'impactSha256' }),
  plan: Object.freeze({ family: 'sgos-policy-amendment-plan', kind: 'sgos-policy-amendment-plan', hash: 'planSha256' }),
  amendment: Object.freeze({ family: 'sgos-policy-amendment-receipt', kind: 'sgos-policy-amendment-receipt', hash: 'amendmentSha256' }),
  invalidation: Object.freeze({ family: 'sgos-policy-invalidation', kind: 'sgos-policy-invalidation', hash: 'invalidationSha256' }),
  state: Object.freeze({ family: 'sgos-policy-runtime-state', kind: 'sgos-policy-runtime-state', hash: 'stateSha256' })
});

function fail(message, code = 'SGOS_POLICY_RUNTIME_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

/** @internal Test-only observation of expensive approved-configuration reads. */
export function setSgosPolicyAuthorityReadObserverForTests(observer = null) {
  if (observer !== null && typeof observer !== 'function') {
    throw new TypeError('Policy authority read observer must be a function or null.');
  }
  policyAuthorityReadObserverForTests = observer;
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, fields, label) {
  if (!plain(value)) fail(`${label} must be an object.`);
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) fail(`${label} contains unknown field '${field}'.`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) fail(`${label} is missing '${field}'.`);
  }
}

function digest(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail(`${label} must be a SHA-256 digest.`);
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    fail(`${label} must be a canonical identifier.`);
  }
}

function timestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(`${label} must be an ISO timestamp.`);
}

function sortedUnique(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array.`);
  const result = values.map((entry) => {
    if (typeof entry !== 'string' || !entry) fail(`${label} entries must be strings.`);
    return entry;
  });
  const sorted = [...new Set(result)].sort();
  if (canonicalJson(result) !== canonicalJson(sorted)) fail(`${label} must be sorted and unique.`);
  return Object.freeze(sorted);
}

function seal(descriptor, input) {
  const stamped = stampCurrentRecord(descriptor.family, {
    ...cloneSgosValue(input), kind: descriptor.kind
  });
  delete stamped[descriptor.hash];
  stamped[descriptor.hash] = recordSelfSha256(stamped, descriptor.hash);
  return Object.freeze(validateRecord(descriptor, stamped));
}

function baseRecord(descriptor, value, fields) {
  const record = readRecord(descriptor.family, value).record;
  exact(record, ['schemaVersion', 'kind', ...fields, descriptor.hash], descriptor.kind);
  // readRecord is the sole version-range/migration authority. Semantic validation starts from its
  // current in-memory shape and therefore never branches on a durable schemaVersion literal.
  if (record.kind !== descriptor.kind) fail(`${descriptor.kind} has the wrong record family.`);
  digest(record[descriptor.hash], `${descriptor.kind}.${descriptor.hash}`);
  if (record[descriptor.hash] !== recordSelfSha256(record, descriptor.hash)) {
    fail(`${descriptor.kind} content hash does not match its bytes.`, 'SGOS_POLICY_RECORD_TAMPERED', {
      family: descriptor.family, expected: recordSelfSha256(record, descriptor.hash),
      actual: record[descriptor.hash]
    });
  }
  return record;
}

function validateTighteningPolicy(value) {
  exact(value, ['enabled', 'components'], 'sgos-policy-bundle.automaticTightening');
  if (typeof value.enabled !== 'boolean') fail('automaticTightening.enabled must be boolean.');
  if (!plain(value.components)) fail('automaticTightening.components must be an object.');
  for (const [component, values] of Object.entries(value.components)) {
    if (!SGOS_POLICY_COMPONENTS.includes(component)) fail(`Unknown policy component '${component}'.`);
    sortedUnique(values, `automaticTightening.components.${component}`)
      .forEach((entry) => digest(entry, `automaticTightening.components.${component}`));
  }
}

function validateBundle(value) {
  const record = baseRecord(FAMILY.bundle, value, ['snapshot', 'automaticTightening']);
  validatePolicySnapshot(record.snapshot);
  validateTighteningPolicy(record.automaticTightening);
  return record;
}

function validateApproval(value) {
  const record = baseRecord(FAMILY.approval, value, [
    'fromPolicySnapshotSha256', 'toPolicySnapshotSha256', 'diffSha256', 'decision',
    'approvedBy', 'approvedAt'
  ]);
  ['fromPolicySnapshotSha256', 'toPolicySnapshotSha256', 'diffSha256']
    .forEach((field) => digest(record[field], `sgos-policy-approval.${field}`));
  if (record.decision !== 'approved') fail("sgos-policy-approval.decision must be 'approved'.");
  identifier(record.approvedBy, 'sgos-policy-approval.approvedBy');
  timestamp(record.approvedAt, 'sgos-policy-approval.approvedAt');
  return record;
}

function validateDiff(value) {
  const record = baseRecord(FAMILY.diff, value, [
    'fromBundleSha256', 'toBundleSha256', 'fromPolicySnapshotSha256',
    'toPolicySnapshotSha256', 'fromAuthorityRevision', 'toAuthorityRevision',
    'classification', 'changes'
  ]);
  ['fromBundleSha256', 'toBundleSha256', 'fromPolicySnapshotSha256', 'toPolicySnapshotSha256']
    .forEach((field) => digest(record[field], `sgos-policy-diff.${field}`));
  for (const field of ['fromAuthorityRevision', 'toAuthorityRevision']) {
    if (!/^[a-f0-9]{40,64}$/.test(record[field])) fail(`sgos-policy-diff.${field} is invalid.`);
  }
  if (!['tightening', 'weakening', 'mixed'].includes(record.classification)) {
    fail('sgos-policy-diff.classification is invalid.');
  }
  if (!Array.isArray(record.changes) || !record.changes.length) fail('sgos-policy-diff requires changes.');
  let prior = null;
  for (const change of record.changes) {
    exact(change, ['component', 'fromSha256', 'toSha256', 'classification'], 'sgos-policy-diff.change');
    if (!SGOS_POLICY_COMPONENTS.includes(change.component) || prior >= change.component) {
      fail('sgos-policy-diff changes must be sorted, unique policy components.');
    }
    prior = change.component;
    digest(change.fromSha256, `sgos-policy-diff.${change.component}.fromSha256`);
    digest(change.toSha256, `sgos-policy-diff.${change.component}.toSha256`);
    if (!['tightening', 'weakening'].includes(change.classification)) fail('Policy component classification is invalid.');
  }
  return record;
}

function validateImpact(value) {
  const record = baseRecord(FAMILY.impact, value, [
    'diffSha256', 'fromPolicySnapshotSha256', 'toPolicySnapshotSha256',
    'affectedPrograms', 'affectedProcesses', 'selectedProcessIds', 'selectedProgramIds'
  ]);
  ['diffSha256', 'fromPolicySnapshotSha256', 'toPolicySnapshotSha256']
    .forEach((field) => digest(record[field], `sgos-policy-impact.${field}`));
  sortedUnique(record.selectedProcessIds, 'sgos-policy-impact.selectedProcessIds');
  sortedUnique(record.selectedProgramIds, 'sgos-policy-impact.selectedProgramIds');
  if (!Array.isArray(record.affectedProcesses) || !Array.isArray(record.affectedPrograms)) {
    fail('sgos-policy-impact affected collections must be arrays.');
  }
  let priorProcess = null;
  for (const process of record.affectedProcesses) {
    exact(process, ['processId', 'programId', 'programSha256', 'status'], 'sgos-policy-impact.affectedProcess');
    identifier(process.processId, 'affectedProcess.processId');
    identifier(process.programId, 'affectedProcess.programId');
    digest(process.programSha256, 'affectedProcess.programSha256');
    if (typeof process.status !== 'string' || priorProcess >= process.processId) {
      fail('affectedProcesses must be sorted and unique.');
    }
    priorProcess = process.processId;
  }
  let priorProgram = null;
  for (const program of record.affectedPrograms) {
    exact(program, ['programId', 'programSha256', 'processIds'], 'sgos-policy-impact.affectedProgram');
    identifier(program.programId, 'affectedProgram.programId');
    digest(program.programSha256, 'affectedProgram.programSha256');
    sortedUnique(program.processIds, 'affectedProgram.processIds');
    if (priorProgram >= program.programId) fail('affectedPrograms must be sorted and unique.');
    priorProgram = program.programId;
  }
  const affectedIds = new Set(record.affectedProcesses.map((entry) => entry.processId));
  if (record.selectedProcessIds.some((id) => !affectedIds.has(id))) {
    fail('Policy impact selects a Process outside its exact affected set.');
  }
  const affectedProgramIds = new Set(record.affectedPrograms.map((entry) => entry.programId));
  if (record.selectedProgramIds.some((id) => !affectedProgramIds.has(id))) {
    fail('Policy impact selects a Program outside its exact affected set.');
  }
  return record;
}

function validatePlan(value) {
  const record = baseRecord(FAMILY.plan, value, [
    'configurationAuthority', 'fromPolicySnapshotSha256', 'toPolicySnapshotSha256',
    'diffSha256', 'impactSha256', 'classification', 'requiresHumanApproval',
    'approvalSha256', 'runtimeRevision', 'runtimeStateSha256'
  ]);
  exact(record.configurationAuthority, ['kind', 'ref', 'commit', 'sourceCommit'], 'plan.configurationAuthority');
  if (!['approved-configuration-ref', 'verified-state-mirror'].includes(record.configurationAuthority.kind)
      || typeof record.configurationAuthority.ref !== 'string'
      || !/^[a-f0-9]{40,64}$/.test(record.configurationAuthority.commit)
      || !/^[a-f0-9]{40,64}$/.test(record.configurationAuthority.sourceCommit)) {
    fail('Plan configuration authority is invalid.');
  }
  ['fromPolicySnapshotSha256', 'toPolicySnapshotSha256', 'diffSha256', 'impactSha256']
    .forEach((field) => digest(record[field], `sgos-policy-amendment-plan.${field}`));
  digest(record.approvalSha256, 'plan.approvalSha256', { nullable: true });
  digest(record.runtimeStateSha256, 'plan.runtimeStateSha256', { nullable: true });
  if (!Number.isSafeInteger(record.runtimeRevision) || record.runtimeRevision < 0
      || (record.runtimeRevision === 0) !== (record.runtimeStateSha256 === null)) {
    fail('Plan runtime revision and state digest disagree.');
  }
  if (!['tightening', 'weakening', 'mixed'].includes(record.classification)
      || typeof record.requiresHumanApproval !== 'boolean'
      || record.requiresHumanApproval !== (record.classification !== 'tightening')) {
    fail('Plan classification and approval requirement disagree.');
  }
  return record;
}

function validateInvalidation(value) {
  const record = baseRecord(FAMILY.invalidation, value, [
    'planSha256', 'processId', 'programId', 'programSha256', 'fromPolicySnapshotSha256',
    'toPolicySnapshotSha256', 'effect', 'invalidatedAt'
  ]);
  ['planSha256', 'programSha256', 'fromPolicySnapshotSha256', 'toPolicySnapshotSha256']
    .forEach((field) => digest(record[field], `sgos-policy-invalidation.${field}`));
  identifier(record.processId, 'invalidation.processId');
  identifier(record.programId, 'invalidation.programId');
  if (record.effect !== 'restart-required') fail("Policy invalidation effect must be 'restart-required'.");
  timestamp(record.invalidatedAt, 'invalidation.invalidatedAt');
  return record;
}

function validateAmendment(value) {
  const record = baseRecord(FAMILY.amendment, value, [
    'planSha256', 'diffSha256', 'impactSha256', 'fromPolicyBundleSha256',
    'toPolicyBundleSha256', 'fromPolicySnapshotSha256', 'toPolicySnapshotSha256',
    'previousAmendmentSha256', 'authorization',
    'invalidationSha256s', 'appliedAt'
  ]);
  [
    'planSha256', 'diffSha256', 'impactSha256', 'fromPolicyBundleSha256',
    'toPolicyBundleSha256', 'fromPolicySnapshotSha256', 'toPolicySnapshotSha256'
  ]
    .forEach((field) => digest(record[field], `sgos-policy-amendment-receipt.${field}`));
  digest(record.previousAmendmentSha256, 'amendment.previousAmendmentSha256', { nullable: true });
  exact(record.authorization, [
    'actorId', 'authorityGroup', 'configurationCommit', 'authorizationSha256'
  ], 'amendment.authorization');
  identifier(record.authorization.actorId, 'amendment.authorization.actorId');
  identifier(record.authorization.authorityGroup, 'amendment.authorization.authorityGroup');
  if (!/^[a-f0-9]{40,64}$/.test(record.authorization.configurationCommit)) {
    fail('amendment.authorization.configurationCommit is invalid.');
  }
  digest(record.authorization.authorizationSha256, 'amendment.authorization.authorizationSha256');
  sortedUnique(record.invalidationSha256s, 'amendment.invalidationSha256s')
    .forEach((entry) => digest(entry, 'amendment.invalidationSha256s[]'));
  timestamp(record.appliedAt, 'amendment.appliedAt');
  return record;
}

function validateState(value) {
  const record = baseRecord(FAMILY.state, value, [
    'revision', 'activePolicyBundleSha256', 'activePolicySnapshotSha256', 'latestAmendmentSha256',
    'configurationAuthorityCommit', 'updatedAt'
  ]);
  if (!Number.isInteger(record.revision) || record.revision < 1) fail('Policy runtime state revision is invalid.');
  digest(record.activePolicyBundleSha256, 'state.activePolicyBundleSha256');
  digest(record.activePolicySnapshotSha256, 'state.activePolicySnapshotSha256');
  digest(record.latestAmendmentSha256, 'state.latestAmendmentSha256');
  if (!/^[a-f0-9]{40,64}$/.test(record.configurationAuthorityCommit)) {
    fail('state.configurationAuthorityCommit is invalid.');
  }
  timestamp(record.updatedAt, 'state.updatedAt');
  return record;
}

function validateRecord(descriptor, value) {
  if (descriptor === FAMILY.bundle) return validateBundle(value);
  if (descriptor === FAMILY.approval) return validateApproval(value);
  if (descriptor === FAMILY.diff) return validateDiff(value);
  if (descriptor === FAMILY.impact) return validateImpact(value);
  if (descriptor === FAMILY.plan) return validatePlan(value);
  if (descriptor === FAMILY.invalidation) return validateInvalidation(value);
  if (descriptor === FAMILY.amendment) return validateAmendment(value);
  if (descriptor === FAMILY.state) return validateState(value);
  fail(`Unsupported policy record family '${descriptor?.family ?? 'unknown'}'.`);
}

export function createPinnedPolicyBundle({ snapshot, automaticTightening = {} }) {
  const components = {};
  for (const component of Object.keys(automaticTightening.components ?? {}).sort()) {
    components[component] = [...new Set(automaticTightening.components[component] ?? [])].sort();
  }
  return seal(FAMILY.bundle, {
    snapshot,
    automaticTightening: {
      enabled: automaticTightening.enabled === true,
      components
    }
  });
}

export function createPinnedPolicyApproval(input) {
  return seal(FAMILY.approval, input);
}

function policyRuntimeRoot(root) {
  return path.join(gitCommonDir(root), ...POLICY_ROOT_PARTS);
}

function fileName(digestValue) {
  digest(digestValue, 'content address');
  return `${digestValue.slice('sha256:'.length)}.json`;
}

function recordPath(root, descriptor, digestValue, { processId = null } = {}) {
  const directory = descriptor === FAMILY.diff ? 'diffs'
    : descriptor === FAMILY.impact ? 'impacts'
      : descriptor === FAMILY.plan ? 'plans'
        : descriptor === FAMILY.amendment ? 'amendments'
          : descriptor === FAMILY.invalidation ? path.join('invalidations', encodeURIComponent(processId))
            : null;
  if (!directory) fail(`Record family '${descriptor.family}' has no immutable store.`);
  return path.join(policyRuntimeRoot(root), directory, fileName(digestValue));
}

function statePath(root) {
  return path.join(policyRuntimeRoot(root), 'state.json');
}

async function safeDirectory(directory, { create = false } = {}) {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const boundary = parts.lastIndexOf('singularity-flow');
  if (boundary < 0) fail(`Policy runtime path '${directory}' escapes its sidecar.`, 'SGOS_POLICY_PATH_UNSAFE');
  let current = parsed.root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    if (index < boundary) continue;
    let info = await lstat(current).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!info && create) {
      // Create one segment at a time only after every existing ancestor was proven not to be a
      // symlink. `mkdir({ recursive:true })` would traverse an attacker-controlled parent first.
      try { await mkdir(current, { mode: 0o700 }); } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      info = await lstat(current);
    }
    if (!info) return false;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail(`Policy runtime path '${directory}' is not a safe directory.`, 'SGOS_POLICY_PATH_UNSAFE');
    }
  }
  return true;
}

async function readJson(file, { optional = false } = {}) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_RECORD_BYTES) fail(`Policy record '${file}' is unsafe or too large.`, 'SGOS_POLICY_PATH_UNSAFE');
    const text = await handle.readFile('utf8');
    try { return JSON.parse(text); } catch (error) {
      fail(`Policy record '${file}' is not valid JSON.`, 'SGOS_POLICY_RECORD_CORRUPT', { cause: error.message });
    }
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP') fail(`Policy record '${file}' must not be a symbolic link.`, 'SGOS_POLICY_PATH_UNSAFE');
    throw error;
  } finally {
    await handle?.close();
  }
}

async function writeExclusiveRecord(root, descriptor, record, options = {}) {
  const file = recordPath(root, descriptor, record[descriptor.hash], options);
  await safeDirectory(path.dirname(file), { create: true });
  let handle;
  try {
    handle = await open(file,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(canonicalJson(record), 'utf8');
    await handle.sync();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = validateRecord(descriptor, await readJson(file));
    if (canonicalJson(existing) !== canonicalJson(record)) {
      fail(`Policy content address '${record[descriptor.hash]}' is occupied by different bytes.`, 'SGOS_POLICY_RECORD_TAMPERED');
    }
  } finally {
    await handle?.close();
  }
  return file;
}

async function writeStateAtomic(root, state) {
  const file = statePath(root);
  await safeDirectory(path.dirname(file), { create: true });
  const temporary = path.join(path.dirname(file), `.state-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(canonicalJson(state), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function readState(root) {
  if (!await safeDirectory(path.dirname(statePath(root)))) return null;
  const value = await readJson(statePath(root), { optional: true });
  return value == null ? null : Object.freeze(validateState(value));
}

async function approvedPolicyConfiguration(root, {
  requireCandidate = false,
  refreshAuthority = false
} = {}) {
  policyAuthorityReadObserverForTests?.();
  return withTrustedSgosConfigurationRead(root, async (authority, trust) => {
    const approvedRoot = configurationReadRoot(root);
    const currentValue = await readJson(
      path.join(approvedRoot, SGOS_POLICY_CURRENT_PATH), { optional: true }
    );
    const candidateValue = await readJson(
      path.join(approvedRoot, SGOS_POLICY_CANDIDATE_PATH), { optional: true }
    );
    if (currentValue == null && candidateValue == null) {
      const sourceCommit = authority?.kind === 'verified-state-mirror'
        ? authority.manifest?.source?.commit : authority?.commit;
      const reusableAuthority = authority?.ref
        && /^[a-f0-9]{40,64}$/.test(authority?.commit ?? '')
        && /^[a-f0-9]{40,64}$/.test(sourceCommit ?? '')
        ? Object.freeze({
            kind: authority.kind, ref: authority.ref,
            commit: authority.commit, sourceCommit
          })
        : null;
      return Object.freeze({
        configured: false, authority: reusableAuthority, current: null, candidate: null
      });
    }
    if (!authority?.ref || !/^[a-f0-9]{40,64}$/.test(authority.commit ?? '') || !trust
        || !['approved-configuration-ref', 'verified-state-mirror'].includes(authority.kind)) {
      fail('Pinned policy authority requires approved configuration or verified state authority.',
        'SGOS_POLICY_APPROVED_CONFIGURATION_REQUIRED');
    }
    const sourceCommit = authority.kind === 'verified-state-mirror'
      ? authority.manifest?.source?.commit : authority.commit;
    if (!/^[a-f0-9]{40,64}$/.test(sourceCommit ?? '')) {
      fail('Approved policy authority has no exact source configuration commit.',
        'SGOS_POLICY_APPROVED_CONFIGURATION_REQUIRED');
    }
    const configurationAuthority = Object.freeze({
      kind: authority.kind, ref: authority.ref, commit: authority.commit, sourceCommit
    });
    if (currentValue == null || (requireCandidate && candidateValue == null)) {
      fail(
        requireCandidate
          ? 'Pinned policy amendment planning requires both approved current.json and candidate.json.'
          : 'Approved pinned policy configuration contains candidate.json without current.json.',
        'SGOS_POLICY_CONFIGURATION_PARTIAL'
      );
    }
    const current = validateBundle(currentValue);
    const candidate = candidateValue == null ? null : validateBundle(candidateValue);
    for (const [label, bundle] of [['current', current], ['candidate', candidate]]) {
      if (bundle == null) continue;
      const revision = bundle.snapshot.authorityRevision;
      if (!/^[a-f0-9]{40,64}$/.test(revision)) {
        fail(`Approved ${label} policy authorityRevision must be an exact Git object ID.`,
          'SGOS_POLICY_AUTHORITY_REVISION_INVALID');
      }
      const ancestry = revision === sourceCommit ? { status: 0 } : run('git', [
        'merge-base', '--is-ancestor', revision, sourceCommit
      ], { cwd: root, allowFailure: true });
      if (ancestry.status !== 0) {
        fail(`Approved ${label} policy does not descend from its declared authorityRevision.`,
          'SGOS_POLICY_AUTHORITY_REVISION_INVALID', {
            revision, approvedCommit: sourceCommit
          });
      }
    }
    return Object.freeze({
      configured: true,
      authority: configurationAuthority,
      current: Object.freeze(current),
      candidate: candidate == null ? null : Object.freeze(candidate)
    });
  }, { refreshAuthority, requireFreshRemote: refreshAuthority });
}

function dirtyPolicyPaths(root) {
  const result = run('git', [
    'status', '--porcelain=v1', '-z', '--', 'singularity/sgos/policy'
  ], { cwd: root, allowFailure: true });
  if (result.status !== 0) fail('Could not verify the candidate policy working-tree boundary.', 'SGOS_POLICY_CANDIDATE_UNVERIFIED');
  return [...new Set(result.stdout.split('\0').filter(Boolean).map((entry) => entry.slice(3)).filter(Boolean))].sort();
}

async function approvedPolicyInputs(root) {
  const dirty = dirtyPolicyPaths(root);
  if (dirty.length) {
    fail('Dirty candidate policy cannot govern or authorize its own amendment. Publish it through the approved configuration authority first.',
      'SGOS_POLICY_CANDIDATE_DIRTY', { paths: dirty });
  }
  const configuration = await approvedPolicyConfiguration(root, {
    requireCandidate: true,
    refreshAuthority: true
  });
  if (!configuration.configured) {
    fail('Pinned policy planning requires approved current.json and candidate.json.',
      'SGOS_POLICY_APPROVED_CONFIGURATION_REQUIRED');
  }
  return withTrustedSgosConfigurationRead(root, async () => {
    const approvedRoot = configurationReadRoot(root);
    const approvalFile = path.join(
      approvedRoot, 'singularity', 'sgos', 'policy', 'approvals',
      fileName(configuration.candidate.snapshot.snapshotSha256)
    );
    const approvalValue = await readJson(approvalFile, { optional: true });
    return Object.freeze({
      authority: configuration.authority,
      current: configuration.current,
      candidate: configuration.candidate,
      approval: approvalValue == null ? null : Object.freeze(validateApproval(approvalValue))
    });
  }, { refreshAuthority: false, requireFreshRemote: false });
}

function classifyDiff(current, candidate) {
  const changes = [];
  for (const component of SGOS_POLICY_COMPONENTS) {
    const fromSha256 = current.snapshot[component];
    const toSha256 = candidate.snapshot[component];
    if (fromSha256 === toSha256) continue;
    const explicitlyAllowed = current.automaticTightening.enabled
      && (current.automaticTightening.components[component] ?? []).includes(toSha256);
    changes.push(Object.freeze({
      component, fromSha256, toSha256,
      classification: explicitlyAllowed ? 'tightening' : 'weakening'
    }));
  }
  if (!changes.length) fail('Candidate policy has no component change to amend.', 'SGOS_POLICY_NO_CHANGE');
  const classes = new Set(changes.map((entry) => entry.classification));
  const classification = classes.size === 2 ? 'mixed' : changes[0].classification;
  return seal(FAMILY.diff, {
    fromBundleSha256: current.bundleSha256,
    toBundleSha256: candidate.bundleSha256,
    fromPolicySnapshotSha256: current.snapshot.snapshotSha256,
    toPolicySnapshotSha256: candidate.snapshot.snapshotSha256,
    fromAuthorityRevision: current.snapshot.authorityRevision,
    toAuthorityRevision: candidate.snapshot.authorityRevision,
    classification,
    changes
  });
}

async function exactImpact(root, diff, selectedInput) {
  const states = await listSgosProcesses(root);
  const unavailable = states.filter((entry) => entry.available === false);
  if (unavailable.length) {
    fail('Pinned policy impact cannot prove its exact Process set while a Process is unavailable.',
      'SGOS_POLICY_IMPACT_UNAVAILABLE', {
        processes: unavailable.map((entry) => ({ processId: entry.processId, error: entry.error }))
      });
  }
  const affectedProcesses = [];
  const programs = new Map();
  for (const state of states) {
    if (state.policySnapshotSha256 !== diff.fromPolicySnapshotSha256) continue;
    const program = (await readSgosProgram(root, state.processId, state.programSha256)).record;
    affectedProcesses.push(Object.freeze({
      processId: state.processId, programId: program.programId,
      programSha256: program.programSha256, status: state.status
    }));
    const found = programs.get(program.programId) ?? {
      programId: program.programId, programSha256: program.programSha256, processIds: []
    };
    if (found.programSha256 !== program.programSha256) {
      fail(`Program ID '${program.programId}' resolves to multiple exact Programs.`, 'SGOS_POLICY_IMPACT_AMBIGUOUS');
    }
    found.processIds.push(state.processId);
    programs.set(program.programId, found);
  }
  affectedProcesses.sort((left, right) => left.processId.localeCompare(right.processId));
  const affectedPrograms = [...programs.values()]
    .map((entry) => Object.freeze({ ...entry, processIds: Object.freeze(entry.processIds.sort()) }))
    .sort((left, right) => left.programId.localeCompare(right.programId));
  const requested = selectedInput == null
    ? affectedProcesses.map((entry) => entry.processId)
    : [...new Set(selectedInput)].sort();
  if (requested.some((id) => typeof id !== 'string')) fail('invalidateProcessIds must contain Process IDs.');
  const byId = new Map(affectedProcesses.map((entry) => [entry.processId, entry]));
  const outside = requested.filter((id) => !byId.has(id));
  if (outside.length) {
    fail('Policy invalidation selection contains a Process outside the exact affected set.',
      'SGOS_POLICY_INVALIDATION_SELECTION_INVALID', { processIds: outside });
  }
  const statesById = new Map(states.map((entry) => [entry.processId, entry]));
  const active = requested.filter((id) => {
    const state = statesById.get(id);
    return (state?.activeExecutions?.length ?? 0) > 0 || (state?.activeLeases?.length ?? 0) > 0;
  });
  if (active.length) {
    fail(
      'A policy amendment cannot invalidate a Process while its exact execution or owner lease is active. Stop it and prove quiescence before planning again.',
      'SGOS_POLICY_INVALIDATION_NOT_QUIESCENT', { processIds: active }
    );
  }
  const selectedProgramIds = [...new Set(requested.map((id) => byId.get(id).programId))].sort();
  return seal(FAMILY.impact, {
    diffSha256: diff.diffSha256,
    fromPolicySnapshotSha256: diff.fromPolicySnapshotSha256,
    toPolicySnapshotSha256: diff.toPolicySnapshotSha256,
    affectedPrograms,
    affectedProcesses,
    selectedProcessIds: requested,
    selectedProgramIds
  });
}

function approvalForPlan(inputs, diff) {
  if (diff.classification === 'tightening') return null;
  const approval = inputs.approval;
  if (approval == null) return null;
  if (approval.fromPolicySnapshotSha256 !== diff.fromPolicySnapshotSha256
      || approval.toPolicySnapshotSha256 !== diff.toPolicySnapshotSha256
      || approval.diffSha256 !== diff.diffSha256) {
    fail('Policy approval does not bind the exact current/candidate snapshots and classified diff.',
      'SGOS_POLICY_APPROVAL_STALE');
  }
  return approval;
}

/** Compute one deterministic, mutation-free amendment plan. */
export async function planPinnedSgosPolicyAmendment(root, {
  invalidateProcessIds = null
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    fail('Pinned policy planning requires an explicit absolute repository root.', 'SGOS_POLICY_REPOSITORY_REQUIRED');
  }
  const inputs = await approvedPolicyInputs(root);
  const state = await readState(root);
  if (state && (state.activePolicySnapshotSha256 !== inputs.current.snapshot.snapshotSha256
      || state.activePolicyBundleSha256 !== inputs.current.bundleSha256)) {
    fail('Approved current policy no longer matches the active policy runtime head. Rotate current.json to the exact active bundle before planning another amendment.',
      'SGOS_POLICY_ROTATION_REQUIRED', {
        runtime: {
          bundleSha256: state.activePolicyBundleSha256,
          snapshotSha256: state.activePolicySnapshotSha256
        },
        approvedCurrent: {
          bundleSha256: inputs.current.bundleSha256,
          snapshotSha256: inputs.current.snapshot.snapshotSha256
        }
      });
  }
  const diff = classifyDiff(inputs.current, inputs.candidate);
  const impact = await exactImpact(root, diff, invalidateProcessIds);
  const approval = approvalForPlan(inputs, diff);
  const plan = seal(FAMILY.plan, {
    configurationAuthority: inputs.authority,
    fromPolicySnapshotSha256: diff.fromPolicySnapshotSha256,
    toPolicySnapshotSha256: diff.toPolicySnapshotSha256,
    diffSha256: diff.diffSha256,
    impactSha256: impact.impactSha256,
    classification: diff.classification,
    requiresHumanApproval: diff.classification !== 'tightening',
    approvalSha256: approval?.approvalSha256 ?? null,
    runtimeRevision: state?.revision ?? 0,
    runtimeStateSha256: state?.stateSha256 ?? null
  });
  return Object.freeze({
    plan, diff, impact, approval,
    confirmationSha256: plan.planSha256,
    mutation: false,
    selectedProcessIds: impact.selectedProcessIds
  });
}

async function withSelectedProcessAuthorityLocks(root, processIds, callback, index = 0) {
  const selected = [...new Set(processIds)].sort();
  if (index >= selected.length) return callback();
  return withSubjectLock(root, { kind: 'sgos-process', id: selected[index] }, () =>
    withSelectedProcessAuthorityLocks(root, selected, callback, index + 1));
}

/** Apply only the exact plan the caller reviewed; every mutable input is re-read under one lock. */
export async function applyPinnedSgosPolicyAmendment(root, {
  confirmationSha256, expectedRevision, invalidateProcessIds = null
} = {}) {
  digest(confirmationSha256, 'confirmationSha256');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    fail('Policy amendment apply requires the exact non-negative runtime revision from its plan.',
      'SGOS_POLICY_REVISION_REQUIRED');
  }
  return withSubjectLock(root, { kind: 'sgos-policy-runtime', id: 'authority' }, async () => {
    const planned = await planPinnedSgosPolicyAmendment(root, { invalidateProcessIds });
    if (planned.plan.runtimeRevision !== expectedRevision) {
      fail(`Policy runtime revision changed. Review revision ${planned.plan.runtimeRevision} and confirm its exact plan.`,
        'SGOS_POLICY_PLAN_STALE', {
          expectedRevision, currentRevision: planned.plan.runtimeRevision,
          current: planned.plan.planSha256
        });
    }
    if (planned.plan.planSha256 !== confirmationSha256) {
      fail(`Policy amendment plan is stale. Review and confirm ${planned.plan.planSha256}.`,
        'SGOS_POLICY_PLAN_STALE', {
          supplied: confirmationSha256, current: planned.plan.planSha256
        });
    }
    const authorization = await loadApprovedPlatformMutationAuthority(root, 'policy.amend', {
      policyAuthorityRevision: planned.diff.fromAuthorityRevision
    });
    if (planned.plan.requiresHumanApproval) {
      if (!planned.approval) {
        fail('Weakening or mixed policy amendments require an exact human approval record in approved configuration.',
          'SGOS_POLICY_HUMAN_APPROVAL_REQUIRED');
      }
      if (planned.approval.approvedBy !== authorization.actorId) {
        fail('The exact policy approval was not issued by the currently authorized policy.amend principal.',
          'SGOS_POLICY_HUMAN_APPROVAL_REQUIRED', {
            approvedBy: planned.approval.approvedBy, actorId: authorization.actorId
          });
      }
    }
    // Selected Process locks serialize invalidation against the exact Process CAS boundary. A
    // mutation already in flight finishes before invalidation; a later mutation observes the
    // durable invalidation before it can publish. This also prevents a late task success from
    // crossing an amendment boundary.
    return withSelectedProcessAuthorityLocks(root, planned.impact.selectedProcessIds, async () => {
      // Authority loading performs another refreshed read. Re-plan once more to prove that neither
      // remote authority, Process selection, nor runtime head changed before publication.
      const current = await planPinnedSgosPolicyAmendment(root, { invalidateProcessIds });
    if (current.plan.planSha256 !== confirmationSha256) {
      fail(`Policy amendment plan changed during authorization. Review and confirm ${current.plan.planSha256}.`,
        'SGOS_POLICY_PLAN_STALE', { supplied: confirmationSha256, current: current.plan.planSha256 });
    }
    const prior = await readState(root);
    const appliedAt = nowIso();
    const byProcess = new Map(current.impact.affectedProcesses.map((entry) => [entry.processId, entry]));
    const invalidations = current.impact.selectedProcessIds.map((processId) => {
      const affected = byProcess.get(processId);
      return seal(FAMILY.invalidation, {
        planSha256: current.plan.planSha256,
        processId,
        programId: affected.programId,
        programSha256: affected.programSha256,
        fromPolicySnapshotSha256: current.plan.fromPolicySnapshotSha256,
        toPolicySnapshotSha256: current.plan.toPolicySnapshotSha256,
        effect: 'restart-required',
        invalidatedAt: appliedAt
      });
    });
    const amendment = seal(FAMILY.amendment, {
      planSha256: current.plan.planSha256,
      diffSha256: current.diff.diffSha256,
      impactSha256: current.impact.impactSha256,
      fromPolicyBundleSha256: current.diff.fromBundleSha256,
      toPolicyBundleSha256: current.diff.toBundleSha256,
      fromPolicySnapshotSha256: current.plan.fromPolicySnapshotSha256,
      toPolicySnapshotSha256: current.plan.toPolicySnapshotSha256,
      previousAmendmentSha256: prior?.latestAmendmentSha256 ?? null,
      authorization: {
        actorId: authorization.actorId,
        authorityGroup: authorization.authorityGroup,
        configurationCommit: authorization.configurationCommit,
        authorizationSha256: authorization.recordSha256
      },
      invalidationSha256s: invalidations.map((entry) => entry.invalidationSha256).sort(),
      appliedAt
    });
    await writeExclusiveRecord(root, FAMILY.diff, current.diff);
    await writeExclusiveRecord(root, FAMILY.impact, current.impact);
    await writeExclusiveRecord(root, FAMILY.plan, current.plan);
    for (const invalidation of invalidations) {
      await writeExclusiveRecord(root, FAMILY.invalidation, invalidation, {
        processId: invalidation.processId
      });
    }
    await writeExclusiveRecord(root, FAMILY.amendment, amendment);
    const state = seal(FAMILY.state, {
      revision: (prior?.revision ?? 0) + 1,
      activePolicyBundleSha256: current.diff.toBundleSha256,
      activePolicySnapshotSha256: current.plan.toPolicySnapshotSha256,
      latestAmendmentSha256: amendment.amendmentSha256,
      configurationAuthorityCommit: current.plan.configurationAuthority.commit,
      updatedAt: appliedAt
    });
    await writeStateAtomic(root, state);
      return Object.freeze({
        state, amendment, invalidations: Object.freeze(invalidations),
        diff: current.diff, impact: current.impact, plan: current.plan
      });
    });
  });
}

async function readStored(root, descriptor, digestValue, options = {}) {
  const file = recordPath(root, descriptor, digestValue, options);
  if (!await safeDirectory(path.dirname(file))) {
    const error = new Error(`Policy record '${file}' does not exist.`);
    error.code = 'ENOENT';
    throw error;
  }
  const value = await readJson(file);
  const record = validateRecord(descriptor, value);
  if (record[descriptor.hash] !== digestValue) fail('Policy record filename and self-hash differ.', 'SGOS_POLICY_RECORD_TAMPERED');
  return Object.freeze(record);
}

async function amendmentChain(root) {
  const state = await readState(root);
  if (!state) return Object.freeze({ state: null, amendments: Object.freeze([]) });
  const amendments = [];
  const seen = new Set();
  let cursor = state.latestAmendmentSha256;
  let expectedBundle = state.activePolicyBundleSha256;
  let expectedSnapshot = state.activePolicySnapshotSha256;
  while (cursor !== null) {
    if (seen.has(cursor) || seen.size > 10_000) fail('Policy amendment lineage contains a cycle or exceeds its bound.', 'SGOS_POLICY_LINEAGE_INVALID');
    seen.add(cursor);
    const amendment = await readStored(root, FAMILY.amendment, cursor);
    if (amendment.toPolicyBundleSha256 !== expectedBundle
        || amendment.toPolicySnapshotSha256 !== expectedSnapshot) {
      fail('Policy amendment lineage does not join its successor bundle and snapshot.',
        'SGOS_POLICY_LINEAGE_INVALID', { amendmentSha256: cursor });
    }
    amendments.push(amendment);
    expectedBundle = amendment.fromPolicyBundleSha256;
    expectedSnapshot = amendment.fromPolicySnapshotSha256;
    cursor = amendment.previousAmendmentSha256;
  }
  return Object.freeze({ state, amendments: Object.freeze(amendments) });
}

async function requiredAmendmentRecord(root, descriptor, digestValue, amendmentSha256) {
  try {
    return await readStored(root, descriptor, digestValue);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fail(
      `Policy amendment '${amendmentSha256}' refers to a missing ${descriptor.kind} record.`,
      'SGOS_POLICY_LINEAGE_INVALID', {
        amendmentSha256, recordKind: descriptor.kind, recordSha256: digestValue
      }
    );
  }
}

async function policyForProcess(root, process, lineage = null) {
  const resolvedLineage = lineage ?? await amendmentChain(root);
  const processId = process.processId;
  for (const amendment of resolvedLineage.amendments) {
    if (amendment.fromPolicySnapshotSha256 !== process.policySnapshotSha256) continue;
    // The amendment receipt alone cannot say whether this Process was selected: invalidation
    // records are intentionally stored below their Process directory.  Re-establish the exact
    // plan/impact lineage before treating an absent record as "not selected".  Otherwise deleting
    // the selected Process' invalidation file would silently turn a revoked Process back into a
    // runnable pinned Process.
    const plan = await requiredAmendmentRecord(
      root, FAMILY.plan, amendment.planSha256, amendment.amendmentSha256
    );
    const impact = await requiredAmendmentRecord(
      root, FAMILY.impact, amendment.impactSha256, amendment.amendmentSha256
    );
    if (amendment.diffSha256 !== plan.diffSha256
        || amendment.impactSha256 !== plan.impactSha256
        || amendment.fromPolicySnapshotSha256 !== plan.fromPolicySnapshotSha256
        || amendment.toPolicySnapshotSha256 !== plan.toPolicySnapshotSha256
        || impact.diffSha256 !== plan.diffSha256
        || impact.fromPolicySnapshotSha256 !== plan.fromPolicySnapshotSha256
        || impact.toPolicySnapshotSha256 !== plan.toPolicySnapshotSha256) {
      fail(`Policy amendment '${amendment.amendmentSha256}' has broken plan/impact lineage.`,
        'SGOS_POLICY_LINEAGE_INVALID');
    }
    const selected = impact.selectedProcessIds.includes(processId);
    const affectedProcess = impact.affectedProcesses.find((entry) => entry.processId === processId);
    if (!affectedProcess || affectedProcess.programSha256 !== process.programSha256) {
      fail(`Policy amendment '${amendment.amendmentSha256}' does not bind the exact Process/Program impact.`,
        'SGOS_POLICY_LINEAGE_INVALID', { processId });
    }
    let matchedInvalidation = null;
    for (const invalidationSha256 of amendment.invalidationSha256s) {
      const invalidation = await readStored(root, FAMILY.invalidation, invalidationSha256, {
        processId
      }).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!invalidation) continue;
      if (matchedInvalidation || invalidation.processId !== processId) {
        fail(`Policy amendment '${amendment.amendmentSha256}' has ambiguous Process invalidations.`,
          'SGOS_POLICY_LINEAGE_INVALID', { processId });
      }
      if (invalidation.planSha256 !== amendment.planSha256
          || invalidation.fromPolicySnapshotSha256 !== process.policySnapshotSha256
          || invalidation.toPolicySnapshotSha256 !== amendment.toPolicySnapshotSha256
          || invalidation.programId !== affectedProcess.programId
          || invalidation.programSha256 !== process.programSha256) {
        fail('Process policy invalidation is not bound to its exact Process/Program/policy.',
          'SGOS_POLICY_INVALIDATION_INVALID');
      }
      matchedInvalidation = { invalidation, invalidationSha256 };
    }
    if (selected !== (matchedInvalidation !== null)) {
      fail(
        selected
          ? `Policy amendment '${amendment.amendmentSha256}' is missing the required invalidation for Process '${processId}'.`
          : `Policy amendment '${amendment.amendmentSha256}' contains an invalidation for unselected Process '${processId}'.`,
        'SGOS_POLICY_LINEAGE_INVALID', { processId, amendmentSha256: amendment.amendmentSha256 }
      );
    }
    if (matchedInvalidation) {
      const { invalidation, invalidationSha256 } = matchedInvalidation;
      return Object.freeze({
        processId,
        status: 'invalidated',
        executionAllowed: false,
        requiresRestart: true,
        startingPolicySnapshotSha256: process.policySnapshotSha256,
        replacementPolicySnapshotSha256: invalidation.toPolicySnapshotSha256,
        amendmentSha256: amendment.amendmentSha256,
        invalidationSha256
      });
    }
  }
  return Object.freeze({
    processId,
    status: 'pinned',
    executionAllowed: true,
    requiresRestart: false,
    startingPolicySnapshotSha256: process.policySnapshotSha256,
    replacementPolicySnapshotSha256: null,
    amendmentSha256: null,
    invalidationSha256: null
  });
}

/** Resolve Process policy without ever replacing the Process' own pinned starting digest. */
export async function readPinnedSgosPolicyForProcess(root, processId) {
  const process = await readSgosProcess(root, processId);
  return policyForProcess(root, process);
}

/** Read the local pinned-policy head, optionally including one Process' exact effective status. */
export async function readPinnedSgosPolicyRuntimeStatus(root, { processId = null } = {}) {
  const lineage = await amendmentChain(root);
  const process = processId == null
    ? null : await readPinnedSgosPolicyForProcess(root, processId);
  return Object.freeze({
    initialized: lineage.state !== null,
    revision: lineage.state?.revision ?? 0,
    stateSha256: lineage.state?.stateSha256 ?? null,
    activePolicyBundleSha256: lineage.state?.activePolicyBundleSha256 ?? null,
    activePolicySnapshotSha256: lineage.state?.activePolicySnapshotSha256 ?? null,
    latestAmendmentSha256: lineage.state?.latestAmendmentSha256 ?? null,
    amendmentCount: lineage.amendments.length,
    process
  });
}

function policyAuthorityFailure(message, code, {
  operation, processId = null, configuration, lineage, pinnedPolicySnapshotSha256 = null
}) {
  fail(message, code, {
    operation,
    processId,
    pinnedPolicySnapshotSha256,
    approvedConfigurationCommit: configuration.authority?.commit ?? null,
    approvedCurrentPolicySnapshotSha256:
      configuration.current?.snapshot?.snapshotSha256 ?? null,
    approvedCandidatePolicySnapshotSha256:
      configuration.candidate?.snapshot?.snapshotSha256 ?? null,
    localRuntimeRevision: lineage.state?.revision ?? 0,
    localRuntimeStateSha256: lineage.state?.stateSha256 ?? null,
    localActivePolicySnapshotSha256: lineage.state?.activePolicySnapshotSha256 ?? null,
    remedy: processId == null
      ? 'Run singularity-flow policy status --json. Complete the reviewed policy plan/apply boundary or restore the exact policy-runtime authority through an administrator-reviewed machine transfer before starting a Process.'
      : `Run singularity-flow policy status ${processId} --json. Complete the reviewed policy plan/apply boundary or restore the exact policy-runtime authority through an administrator-reviewed machine transfer; otherwise start a new Process under the approved current policy.`
  });
}

const POLICY_STORE_BOUNDARIES = new Set([
  'process.start.publish', 'process.publish', 'process.transition-recovery',
  'process.control-upgrade', 'process.quarantine'
]);

function witnessedPolicyAuthority(result, {
  root, configuration, lineage = null, processId = null,
  pinnedPolicySnapshotSha256 = null
}) {
  const frozen = Object.freeze(result);
  policyAuthorityWitnesses.set(frozen, Object.freeze({
    root: path.resolve(root),
    authorityRef: configuration.authority?.ref ?? null,
    authorityCommit: configuration.authority?.commit ?? null,
    runtimeStateSha256: lineage?.state?.stateSha256 ?? null,
    processId,
    pinnedPolicySnapshotSha256,
    result: frozen
  }));
  return frozen;
}

async function reuseScopedPolicyAuthority(root, {
  operation, processId = null, process: suppliedProcess = null,
  policySnapshotSha256 = null, quarantineTreeSha256 = null
}) {
  const witness = policyAuthorityScope.getStore();
  if (witness == null || witness.root !== path.resolve(root)) return null;
  const id = suppliedProcess?.processId ?? processId ?? null;
  const pinned = suppliedProcess?.policySnapshotSha256 ?? policySnapshotSha256 ?? null;
  const sameProcess = witness.processId === id
    || (witness.processId == null && ['process.start', 'process.start.publish'].includes(operation));
  if (!sameProcess) return null;
  if (pinned != null && witness.pinnedPolicySnapshotSha256 != null
      && pinned !== witness.pinnedPolicySnapshotSha256) return null;
  if (quarantineTreeSha256 != null
      && witness.result.quarantineTreeSha256 !== quarantineTreeSha256) return null;

  // The full approved configuration and amendment graph are read once per public operation. At the
  // actual store boundary, recheck only the exact authority ref and content-addressed local head.
  // This is cheap, keeps the witness bounded, and prevents a stale preflight from crossing a policy
  // rotation while the Process lock is held.
  if (POLICY_STORE_BOUNDARIES.has(operation)) {
    if (witness.authorityRef == null || witness.authorityCommit == null) {
      if (witness.result.status !== 'unconfigured') return null;
      for (const relative of [SGOS_POLICY_CURRENT_PATH, SGOS_POLICY_CANDIDATE_PATH]) {
        try {
          await lstat(path.join(root, relative));
          return null;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    } else {
      const authority = run('git', [
        'rev-parse', '--verify', `${witness.authorityRef}^{commit}`
      ], { cwd: root, allowFailure: true });
      if (authority.status !== 0 || authority.stdout.trim() !== witness.authorityCommit) return null;
    }
    const state = await readState(root);
    if ((state?.stateSha256 ?? null) !== witness.runtimeStateSha256) return null;
  }
  return Object.freeze({
    ...witness.result, operation, processId: id ?? witness.result.processId ?? null
  });
}

/**
 * One fail-closed policy-authority preflight for every Process mutation.
 *
 * A repository with no approved pinned-policy files keeps the original SGOS behavior. Once
 * current.json exists, a candidate without an exact local amendment head is an ambiguous
 * cross-clone boundary and cannot be treated as permission to continue. A rotated current policy
 * likewise cannot silently authorize a Process whose older amendment/invalidation lineage is
 * absent. This deliberately fails closed instead of claiming that machine-local receipts are
 * portable authority.
 */
async function evaluateSgosProcessPolicyAuthority(root, {
  operation = 'process.mutate',
  processId = null,
  process: suppliedProcess = null,
  policySnapshotSha256 = null,
  quarantineTreeSha256 = null
} = {}) {
  const configuration = await approvedPolicyConfiguration(root, {
    refreshAuthority: false,
    requireCandidate: false
  });
  if (operation === 'process.quarantine' && quarantineTreeSha256 != null) {
    digest(quarantineTreeSha256, 'quarantineTreeSha256');
    return witnessedPolicyAuthority({
      status: 'quarantine-preserve-only', executionAllowed: false,
      quarantineAllowed: true, operation, processId,
      quarantineTreeSha256,
      approvedCurrentPolicySnapshotSha256:
        configuration.current?.snapshot?.snapshotSha256 ?? null
    }, {
      root, configuration, processId,
      pinnedPolicySnapshotSha256:
        configuration.current?.snapshot?.snapshotSha256 ?? null
    });
  }
  if (!configuration.configured) {
    return witnessedPolicyAuthority({
      status: 'unconfigured', executionAllowed: true, operation,
      processId: suppliedProcess?.processId ?? processId ?? null
    }, {
      root, configuration,
      processId: suppliedProcess?.processId ?? processId ?? null,
      pinnedPolicySnapshotSha256:
        suppliedProcess?.policySnapshotSha256 ?? policySnapshotSha256 ?? null
    });
  }
  const lineage = await amendmentChain(root);
  let process = suppliedProcess;
  if (process == null && processId != null) {
    try {
      process = await readSgosProcess(root, processId);
    } catch (error) {
      // Start admission intentionally runs before the Process directory exists.  Treat absence as
      // a new Process only for that exact boundary; every other mutation requires a durable Process
      // and must preserve the store's normal not-found refusal.
      if (!['process.start', 'process.start.publish'].includes(operation)
          || !['ENOENT', 'SGOS_PROCESS_NOT_FOUND'].includes(error?.code)) {
        throw error;
      }
      process = null;
    }
  }
  const id = process?.processId ?? processId ?? null;
  const pinned = process?.policySnapshotSha256 ?? policySnapshotSha256;
  if (typeof pinned !== 'string' || !SHA256_PATTERN.test(pinned)) {
    policyAuthorityFailure(
      'Configured SGOS policy authority cannot admit a Process mutation without its exact pinned policy snapshot.',
      'SGOS_POLICY_PROCESS_PIN_REQUIRED', {
        operation, processId: id, configuration, lineage,
        pinnedPolicySnapshotSha256: pinned ?? null
      }
    );
  }

  const currentSnapshot = configuration.current.snapshot.snapshotSha256;
  const currentBundle = configuration.current.bundleSha256;
  const candidateSnapshot = configuration.candidate?.snapshot?.snapshotSha256 ?? null;
  const candidateBundle = configuration.candidate?.bundleSha256 ?? null;
  const pendingCandidate = candidateSnapshot !== null
    && (candidateSnapshot !== currentSnapshot || candidateBundle !== currentBundle);
  const state = lineage.state;

  if (state == null) {
    if (pendingCandidate) {
      policyAuthorityFailure(
        'Approved policy has a pending candidate, but this checkout has no exact amendment/invalidation authority. Continuing could bypass an invalidation applied in another clone.',
        'SGOS_POLICY_AUTHORITY_UNESTABLISHED', {
          operation, processId: id, configuration, lineage,
          pinnedPolicySnapshotSha256: pinned
        }
      );
    }
    if (process == null && pinned !== currentSnapshot) {
      policyAuthorityFailure(
        'A new Process must pin the exact approved current policy snapshot.',
        'SGOS_POLICY_START_SNAPSHOT_STALE', {
          operation, processId: id, configuration, lineage,
          pinnedPolicySnapshotSha256: pinned
        }
      );
    }
    if (pinned !== currentSnapshot) {
      policyAuthorityFailure(
        'The Process pins an older policy, but this checkout has no amendment graph proving whether it remains allowed or was invalidated.',
        'SGOS_POLICY_AUTHORITY_DIVERGED', {
          operation, processId: id, configuration, lineage,
          pinnedPolicySnapshotSha256: pinned
        }
      );
    }
    return witnessedPolicyAuthority({
      status: 'approved-current', executionAllowed: true, operation,
      processId: id, startingPolicySnapshotSha256: pinned,
      activePolicySnapshotSha256: currentSnapshot, amendmentSha256: null
    }, {
      root, configuration, lineage, processId: id,
      pinnedPolicySnapshotSha256: pinned
    });
  }

  const activeIsCurrent = state.activePolicySnapshotSha256 === currentSnapshot
    && state.activePolicyBundleSha256 === currentBundle;
  const activeIsCandidate = pendingCandidate
    && state.activePolicySnapshotSha256 === candidateSnapshot
    && state.activePolicyBundleSha256 === candidateBundle;
  if (!activeIsCurrent && !activeIsCandidate) {
    policyAuthorityFailure(
      'Local policy-runtime authority diverges from approved current/candidate configuration.',
      'SGOS_POLICY_AUTHORITY_DIVERGED', {
        operation, processId: id, configuration, lineage,
        pinnedPolicySnapshotSha256: pinned
      }
    );
  }
  if (pendingCandidate && activeIsCurrent) {
    policyAuthorityFailure(
      'Approved policy candidate has not crossed an exact amendment boundary in this checkout. Process mutations are paused so another clone cannot apply an invalidation invisibly.',
      'SGOS_POLICY_AUTHORITY_UNESTABLISHED', {
        operation, processId: id, configuration, lineage,
        pinnedPolicySnapshotSha256: pinned
      }
    );
  }
  const activeSnapshot = state.activePolicySnapshotSha256;
  if (process == null) {
    if (pinned !== activeSnapshot) {
      policyAuthorityFailure(
        'A new Process must pin the exact active approved policy snapshot.',
        'SGOS_POLICY_START_SNAPSHOT_STALE', {
          operation, processId: id, configuration, lineage,
          pinnedPolicySnapshotSha256: pinned
        }
      );
    }
    return witnessedPolicyAuthority({
      status: 'active', executionAllowed: true, operation, processId: id,
      startingPolicySnapshotSha256: pinned,
      activePolicySnapshotSha256: activeSnapshot,
      amendmentSha256: state.latestAmendmentSha256
    }, {
      root, configuration, lineage, processId: id,
      pinnedPolicySnapshotSha256: pinned
    });
  }

  const knownSnapshots = new Set([activeSnapshot]);
  for (const amendment of lineage.amendments) {
    knownSnapshots.add(amendment.fromPolicySnapshotSha256);
    knownSnapshots.add(amendment.toPolicySnapshotSha256);
  }
  if (!knownSnapshots.has(pinned)) {
    policyAuthorityFailure(
      'The Process policy snapshot is not connected to the exact local amendment graph.',
      'SGOS_POLICY_AUTHORITY_DIVERGED', {
        operation, processId: id, configuration, lineage,
        pinnedPolicySnapshotSha256: pinned
      }
    );
  }
  const policy = await policyForProcess(root, process, lineage);
  if (!policy.executionAllowed) {
    fail(
      `Process '${id}' was invalidated by policy amendment ${policy.amendmentSha256}. Restart it under ${policy.replacementPolicySnapshotSha256}; no Process mutation is permitted on the invalidated state.`,
      'SGOS_POLICY_PROCESS_INVALIDATED', {
        ...policy,
        operation,
        remedy: `Run singularity-flow policy status ${id} --json, then start a new Process from an approved Program pinned to ${policy.replacementPolicySnapshotSha256}.`
      }
    );
  }
  return witnessedPolicyAuthority({
    ...policy, operation, activePolicySnapshotSha256: activeSnapshot
  }, {
    root, configuration, lineage, processId: id,
    pinnedPolicySnapshotSha256: pinned
  });
}

/** Evaluate or cheaply revalidate the policy authority active in this operation. */
export async function assertSgosProcessPolicyAuthority(root, options = {}) {
  const operation = options.operation ?? 'process.mutate';
  const scoped = await reuseScopedPolicyAuthority(root, { ...options, operation });
  if (scoped !== null) return scoped;
  return evaluateSgosProcessPolicyAuthority(root, { ...options, operation });
}

/**
 * Read full authority once, then make its exact witness available to nested Process-store guards.
 * Direct store callers have no scope and therefore still perform the complete fail-closed read.
 */
export async function withSgosProcessPolicyAuthority(root, options, callback) {
  if (typeof callback !== 'function') throw new TypeError('Policy authority scope requires a callback.');
  const operation = options?.operation ?? 'process.mutate';
  const inherited = await reuseScopedPolicyAuthority(root, { ...options, operation });
  if (inherited !== null) return callback(inherited);
  const authority = await evaluateSgosProcessPolicyAuthority(root, { ...options, operation });
  const witness = policyAuthorityWitnesses.get(authority);
  if (witness == null) fail('Policy authority witness was not retained.', 'SGOS_POLICY_WITNESS_INVALID');
  return policyAuthorityScope.run(witness, () => callback(authority));
}

/** Compatibility name retained for callers that used the first step/run-only gate. */
export async function assertPinnedSgosPolicyExecutionAllowed(root, processId) {
  return assertSgosProcessPolicyAuthority(root, {
    operation: 'process.execute', processId
  });
}

async function immutableFiles(root, descriptor, directory) {
  const target = path.join(policyRuntimeRoot(root), directory);
  if (!await safeDirectory(target)) return [];
  const entries = await readdir(target, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const records = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
      fail(`Unexpected policy runtime entry '${directory}/${entry.name}'.`, 'SGOS_POLICY_FSCK_INVALID');
    }
    const expected = `sha256:${entry.name.slice(0, 64)}`;
    records.push(await readStored(root, descriptor, expected));
  }
  return records;
}

/** Complete bounded integrity walk for the policy amendment graph. It never repairs or deletes. */
export async function fsckPinnedSgosPolicyRuntime(root) {
  const errors = [];
  const warnings = [];
  const counts = { diffs: 0, impacts: 0, plans: 0, amendments: 0, invalidations: 0 };
  try {
    const diffs = await immutableFiles(root, FAMILY.diff, 'diffs');
    const impacts = await immutableFiles(root, FAMILY.impact, 'impacts');
    const plans = await immutableFiles(root, FAMILY.plan, 'plans');
    const amendments = await immutableFiles(root, FAMILY.amendment, 'amendments');
    Object.assign(counts, {
      diffs: diffs.length, impacts: impacts.length, plans: plans.length, amendments: amendments.length
    });
    const byDiff = new Map(diffs.map((entry) => [entry.diffSha256, entry]));
    const byImpact = new Map(impacts.map((entry) => [entry.impactSha256, entry]));
    const byPlan = new Map(plans.map((entry) => [entry.planSha256, entry]));
    const byAmendment = new Map(amendments.map((entry) => [entry.amendmentSha256, entry]));
    const invalidations = new Map();
    const invalidationRoot = path.join(policyRuntimeRoot(root), 'invalidations');
    const processDirs = await safeDirectory(invalidationRoot)
      ? await readdir(invalidationRoot, { withFileTypes: true }) : [];
    for (const processDir of processDirs.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!processDir.isDirectory()) fail('Policy invalidation store contains a non-directory Process entry.', 'SGOS_POLICY_FSCK_INVALID');
      const processId = decodeURIComponent(processDir.name);
      const processRoot = path.join(invalidationRoot, processDir.name);
      await safeDirectory(processRoot);
      const files = await readdir(processRoot, { withFileTypes: true });
      for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) fail('Policy invalidation filename is invalid.', 'SGOS_POLICY_FSCK_INVALID');
        const record = await readStored(root, FAMILY.invalidation, `sha256:${file.name.slice(0, 64)}`, { processId });
        if (record.processId !== processId) fail('Policy invalidation directory does not match its Process.', 'SGOS_POLICY_FSCK_INVALID');
        invalidations.set(record.invalidationSha256, record);
      }
    }
    counts.invalidations = invalidations.size;
    for (const plan of plans) {
      const diff = byDiff.get(plan.diffSha256);
      const impact = byImpact.get(plan.impactSha256);
      if (!diff || !impact
          || diff.fromPolicySnapshotSha256 !== plan.fromPolicySnapshotSha256
          || diff.toPolicySnapshotSha256 !== plan.toPolicySnapshotSha256
          || impact.diffSha256 !== diff.diffSha256) {
        fail(`Policy plan '${plan.planSha256}' has broken diff/impact lineage.`, 'SGOS_POLICY_LINEAGE_INVALID');
      }
    }
    const referenced = new Set();
    for (const amendment of amendments) {
      const plan = byPlan.get(amendment.planSha256);
      const diff = plan == null ? null : byDiff.get(plan.diffSha256);
      if (!plan || !diff || amendment.diffSha256 !== plan.diffSha256
          || amendment.impactSha256 !== plan.impactSha256
          || amendment.fromPolicyBundleSha256 !== diff.fromBundleSha256
          || amendment.toPolicyBundleSha256 !== diff.toBundleSha256) {
        fail(`Policy amendment '${amendment.amendmentSha256}' has broken plan lineage.`, 'SGOS_POLICY_LINEAGE_INVALID');
      }
      const selected = new Set(byImpact.get(plan.impactSha256).selectedProcessIds);
      const seenProcesses = new Set();
      for (const hash of amendment.invalidationSha256s) {
        const invalidation = invalidations.get(hash);
        if (!invalidation || invalidation.planSha256 !== plan.planSha256
            || !selected.has(invalidation.processId) || seenProcesses.has(invalidation.processId)) {
          fail(`Policy amendment '${amendment.amendmentSha256}' has an invalid selective invalidation.`, 'SGOS_POLICY_LINEAGE_INVALID');
        }
        seenProcesses.add(invalidation.processId);
        referenced.add(hash);
      }
      if (seenProcesses.size !== selected.size) fail('Policy amendment does not receipt every selected Process.', 'SGOS_POLICY_LINEAGE_INVALID');
      if (amendment.previousAmendmentSha256 !== null
          && !byAmendment.has(amendment.previousAmendmentSha256)) {
        fail('Policy amendment points to a missing predecessor.', 'SGOS_POLICY_LINEAGE_INVALID');
      }
    }
    for (const hash of invalidations.keys()) if (!referenced.has(hash)) warnings.push({ code: 'SGOS_POLICY_ORPHAN_INVALIDATION', sha256: hash });
    const lineage = await amendmentChain(root);
    if (lineage.state && (lineage.amendments[0]?.toPolicySnapshotSha256
          !== lineage.state.activePolicySnapshotSha256
        || lineage.amendments[0]?.toPolicyBundleSha256
          !== lineage.state.activePolicyBundleSha256)) {
      fail('Policy runtime head does not match its latest amendment.', 'SGOS_POLICY_LINEAGE_INVALID');
    }
  } catch (error) {
    errors.push(Object.freeze({ code: error?.code ?? 'SGOS_POLICY_FSCK_INVALID', message: error?.message ?? String(error) }));
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    counts: Object.freeze(counts),
    repaired: false,
    deleted: false
  });
}
