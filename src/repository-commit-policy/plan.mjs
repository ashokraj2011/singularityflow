import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { run, secureRepositoryPath } from '../util.mjs';
import { redactDiagnosticText } from '../git-remote-diagnostics.mjs';
import { withoutGitProcessOverrides } from '../git-enterprise-environment.mjs';
import { repositoryCommitPolicyBinding, resolveCommitTracking, resolveRepositoryCommitPolicy, selectCommitProfile, assertCommitPolicyFresh } from './context.mjs';
import { rcpDigest, rcpFailure, renderCommitMessage } from './policy.mjs';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const issued = new WeakMap();
const scopes = new Set(['story', 'initiative', 'run', 'configuration', 'ledger', 'maintenance', 'candidate', 'recovery']);
function exactOid(value) { if (!OID.test(value ?? '')) rcpFailure('RCP_PLAN_INVALID', 'A commit plan requires exact local object identities.'); return value; }
function local(root, args, options = {}) {
  return run('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: root, timeoutMs: 15000, maxBuffer: 16 * 1024 * 1024,
    env: { ...withoutGitProcessOverrides(process.env), GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' }, ...options });
}
export function exactTreeChanges(root, tree, parents) {
  const args = parents.length ? ['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', parents[0], tree, '--']
    : ['ls-tree', '-r', '--name-only', '-z', tree];
  const paths = local(root, args).stdout.split('\0').filter(Boolean);
  if (paths.length > 20000 || paths.some(file => path.isAbsolute(file) || file.split('/').some(part => part === '..' || part.toLowerCase() === '.git'))) rcpFailure('RCP_PLAN_INVALID', 'The prospective change set exceeds the supported path scope.');
  return paths;
}
function subjectScope(paths, allowedPaths) {
  if (allowedPaths == null) return;
  if (!Array.isArray(allowedPaths) || !allowedPaths.length || paths.some(file => !allowedPaths.some(prefix => file === prefix || file.startsWith(`${prefix}/`)))) rcpFailure('RCP_HOOK_EFFECT_OUT_OF_SCOPE', 'The prospective commit includes paths outside this owner’s admitted changeset.');
}
async function profileInputs(root, profile) {
  const inputs = [];
  for (const entry of profile.inputs) {
    const file = await secureRepositoryPath(root, entry.path, { label: 'Commit validator input', type: 'file', mustExist: true });
    const bytes = await readFile(file.absolute);
    if (bytes.length > 4 * 1024 * 1024) rcpFailure('RCP_VALIDATION_UNSUPPORTED', `Validator input '${entry.path}' exceeds the supported byte budget.`);
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (sha256 !== entry.sha256) rcpFailure('RCP_PLAN_STALE', `The adopted hook/runtime input '${entry.path}' changed. Rebind the affected validator through its existing configuration owner.`, { path: entry.path, expectedSha256: entry.sha256, observedSha256: sha256 });
    inputs.push({ path: entry.path, sha256 });
  }
  return inputs;
}

/** Build a read-only preview. Only a publication owner can retain/execute the issued in-memory plan. */
export async function planRepositoryCommit(root, {
  subject, purpose = subject?.kind ?? 'maintenance', ref, tree, parents = [], message,
  allowedPaths = null, phase = null, generation = null, type = null, scope = null, referenceId = null,
  operationId = null, expectedRemote = undefined, expectedLocalRef = undefined, policyBinding = null
} = {}) {
  const binding = policyBinding ?? await resolveRepositoryCommitPolicy(root);
  if (binding.mode !== 'enforce') return { schemaVersion: 1, kind: 'repository-commit-policy-plan', status: 'not-applicable', mode: binding.mode,
    compliance: binding.compliance, nativeHookExecution: 'not-claimed', message, binding };
  if (!scopes.has(purpose) || !subject || !/^[A-Za-z][A-Za-z0-9-]*$/u.test(subject.kind ?? '') || !subject.id
      || typeof ref !== 'string' || !ref.startsWith('refs/heads/') || /[\s\u0000~^:?*\\\[]/u.test(ref) || ref.includes('..')) rcpFailure('RCP_PLAN_INVALID', 'A commit policy plan requires its exact canonical owner, purpose and destination ref.');
  exactOid(tree);
  if (!Array.isArray(parents) || parents.length > 8) rcpFailure('RCP_PLAN_INVALID', 'Commit parent scope is invalid.');
  parents.forEach(exactOid);
  const checked = local(root, ['cat-file', '-t', tree]);
  if (checked.stdout.trim() !== 'tree') rcpFailure('RCP_PLAN_INVALID', 'The prospective content object is not a Git tree.');
  const paths = exactTreeChanges(root, tree, parents); subjectScope(paths, allowedPaths);
  const { policy, authorityRoot, discovery } = repositoryCommitPolicyBinding(binding);
  const tracking = await resolveCommitTracking(binding, { subject, purpose, referenceId, ref });
  const fields = { trackingKey: tracking.reference?.key ?? '', ...(phase == null ? {} : { phase }), ...(type == null ? {} : { type }), ...(scope == null ? {} : { scope }) };
  const rendered = renderCommitMessage(policy, message, fields);
  if (redactDiagnosticText(rendered, { multiline: true }).trim() !== rendered.trim()) rcpFailure('RCP_MESSAGE_REJECTED', 'The proposed message contains credential-shaped or unsafe diagnostic material; no message bytes were retained.');
  const { alias, profile } = selectCommitProfile(binding, { purpose, ref, paths });
  const inputs = await profileInputs(authorityRoot, profile);
  const currentRef = local(root, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true });
  if (![0, 1].includes(currentRef.status)) rcpFailure('RCP_PLAN_STALE', 'The owner’s current destination ref could not be verified.');
  const plan = {
    schemaVersion: 1, kind: 'repository-commit-policy-plan', status: 'planned', repository: binding.repository,
    subject: structuredClone(subject), purpose, ref, expectedLocalRef: expectedLocalRef === undefined ? (currentRef.status === 0 ? currentRef.stdout.trim() : null) : expectedLocalRef,
    ...(expectedRemote === undefined ? {} : { expectedRemote }), prospectiveTree: tree, parents: [...parents], paths,
    operationId, ownerGeneration: generation, authority: binding.authority, policySha256: binding.policySha256, profile: alias, profileSha256: profile.profileSha256,
    fields: { ...(phase == null ? {} : { phase }), ...(type == null ? {} : { type }), ...(scope == null ? {} : { scope }) },
    strategy: profile.adapter, draftMessage: message, proposedMessage: rendered, messageSha256: rcpDigest(rendered), tracking,
    hookBindings: discovery.hooks.filter(hook => hook.status !== 'missing').map(hook => ({ stage: hook.stage, sha256: hook.sha256, availability: hook.nativeAvailability })),
    discoverySha256: binding.discoverySha256, configurationInputs: inputs,
    runtime: { platform: process.platform, arch: process.arch, node: process.version, git: discovery.gitVersion },
    coverage: profile.coverage.map(entry => ({ ...entry, execution: ['pre-push', 'remote-receive', 'ci'].includes(entry.stage) ? 'separate-publication-obligation'
      : profile.adapter === 'native-git' ? 'native-required' : 'registered-equivalence-required' })),
    ...(profile.native?.messageTransform ? { permittedMessageTransformation: structuredClone(profile.native.messageTransform) } : {}),
    changesAuthorization: false, approval: 'not-implied'
  };
  const value = Object.freeze({ ...plan, planSha256: rcpDigest(plan) });
  issued.set(value, { root, binding, policy, profile, fields, inputs, request: { subject, purpose, ref, tree, parents, phase, generation, type, scope, referenceId, operationId, expectedRemote, expectedLocalRef, allowedPaths } });
  return value;
}

export function issuedCommitPolicyPlan(plan) {
  const internal = issued.get(plan);
  if (!internal) rcpFailure('RCP_PLAN_UNISSUED', 'This plan was not issued by the exact repository owner. A model-authored JSON document cannot authorize validation or a commit.');
  const { planSha256, ...core } = plan;
  if (rcpDigest(core) !== planSha256) rcpFailure('RCP_PLAN_STALE', 'The issued commit plan changed.');
  return internal;
}

export async function assertCommitPlanCurrent(plan, { allowLocalRef = null, refreshAuthority = false } = {}) {
  const { root, binding, profile, request } = issuedCommitPolicyPlan(plan);
  await assertCommitPolicyFresh(binding,{refreshAuthority});
  const now = local(root, ['rev-parse', '--verify', '--quiet', plan.ref], { allowFailure: true });
  if (![0, 1].includes(now.status) || (now.status === 0 ? now.stdout.trim() : null) !== (allowLocalRef ?? plan.expectedLocalRef)) rcpFailure('RCP_PLAN_STALE', 'The destination ref changed after the policy plan was issued.');
  const tracking = await resolveCommitTracking(binding, request);
  if (rcpDigest(tracking) !== rcpDigest(plan.tracking)) rcpFailure('RCP_PLAN_STALE', 'The canonical tracking mapping changed after validation.');
  if (rcpDigest(await profileInputs(repositoryCommitPolicyBinding(binding).authorityRoot, profile)) !== rcpDigest(plan.configurationInputs)) rcpFailure('RCP_PLAN_STALE', 'Validator runtime/configuration inputs changed after validation.');
  return true;
}
