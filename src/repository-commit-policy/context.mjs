import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import YAML from 'yaml';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { configurationReadRoot, configurationReadScope } from '../configuration-read-scope.mjs';
import { configuredRemoteIdentity } from '../git-remote-diagnostics.mjs';
import { run, secureRepositoryPath, bindRepositoryCommitPolicyProjection, repositoryCommitPolicyProjection, retainedRepositoryCommitPolicy } from '../util.mjs';
import { normalizeCommitPolicy, rcpDigest, rcpFailure, strictObject } from './policy.mjs';
import { normalizeCommitProfile } from './profile.mjs';
import { compileCommitPattern } from './pattern.mjs';
import { discoverCommitPolicy } from './discovery.mjs';
import { installCommitPolicyHintParser, registerCommitPolicyMode } from './gate.mjs';
import { writeMutablePrivateSidecar } from '../private-sidecar.mjs';
import { gitCommonDir } from '../git-execution.mjs';

installCommitPolicyHintParser(bytes => {const policy=YAML.parse(bytes)?.git?.commitPolicy;return policy==null?'absent':policy.mode??'unknown';});

const bindings = new WeakMap();

function projectionKey(root) { try {return realpathSync.native(root);} catch {return path.resolve(root);} }

const APPROVED = new Set(['approved-configuration-ref', 'verified-state-mirror']);

/** A disposable configuration projection keeps its parent destination policy, never its edited draft. */
export function bindCommitPolicyProjection(applicationRoot, projectionRoot, sourceCommit) {
  return bindRepositoryCommitPolicyProjection(applicationRoot, projectionRoot, sourceCommit);
}
export function repositoryCommitPolicyBinding(binding) {
  const internal = bindings.get(binding);
  if (!internal) rcpFailure('RCP_PLAN_UNISSUED', 'Commit policy bindings must be issued by the repository authority resolver.');
  return internal;
}
async function selectedPolicy(root, { refreshAuthority }) {
  const inspect = async authority => {
    const selected = path.join(configurationReadRoot(root), 'singularity/workflow.yml');
    let bytes;
    try { bytes = await readFile(selected, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { policy: null, authority: null, definition: null }; throw error; }
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) rcpFailure('RCP_POLICY_INVALID', 'Repository commit policy configuration exceeds its byte limit.');
    const definition = YAML.parse(bytes), policy = normalizeCommitPolicy(definition?.git?.commitPolicy);
    if (policy?.mode === 'enforce' && (!authority?.commit || !APPROVED.has(authority.kind))) rcpFailure('RCP_POLICY_NOT_ADOPTED', 'This commit policy is a draft or branch-local input. Adopt it through the existing repository configuration review before enforcement.', { authority: authority?.kind ?? null });
    return { policy, authority: authority ? { kind: authority.kind, ref: authority.ref ?? null, commit: authority.commit ?? null, sourceCommit: authority.sourceCommit ?? authority.commit ?? null } : null,
      definition, definitionSha256: rcpDigest(bytes) };
  };
  // The first local observation keeps compatibility/off repositories off the network. Enforced
  // operations independently capture the current approved authority before issuing a plan.
  return withApprovedConfigurationRead(root, inspect, { preferAuthority: true, refreshAuthority,
    ...(refreshAuthority ? { freshOwnerCapture: true } : {}), selectPaths: ['singularity/workflow.yml'], useObjectCache: true });
}

export async function resolveRepositoryCommitPolicy(root, { refreshAuthority = true, env = process.env } = {}) {
  root = await realpath(root);
  const projected = repositoryCommitPolicyProjection(root);
  const authorityRoot = projected?.applicationRoot ?? root;
  let selected = await selectedPolicy(authorityRoot, { refreshAuthority: false });
  if ((selected.policy?.mode === 'enforce' || retainedRepositoryCommitPolicy(authorityRoot)) && refreshAuthority) selected = await selectedPolicy(authorityRoot, { refreshAuthority: true });
  if (projected?.sourceCommit && selected.policy?.mode === 'enforce' && ![selected.authority?.commit, selected.authority?.sourceCommit].includes(projected.sourceCommit)) rcpFailure('RCP_PLAN_STALE', 'The configuration authority changed after this projection was created. Preserve the proposal and refresh its owner plan.');
  const remote = configuredRemoteIdentity(authorityRoot, selected.definition?.git?.remote ?? 'origin', { direction: 'push' });
  const repository = remote.configured && remote.url && !remote.ambiguous ? `sha256:${remote.fingerprint.replace(/^sha256:/u, '')}` : `local:${rcpDigest(authorityRoot).slice(7)}`;
  const discovery = selected.policy?.mode === 'enforce' ? await discoverCommitPolicy(authorityRoot, {env}) : null;
  const binding = Object.freeze({ schemaVersion: 1, kind: 'repository-commit-policy', repository,
    mode: selected.policy?.mode ?? 'off', compliance: selected.policy?.mode === 'enforce' ? 'admission-required' : 'compatibility-not-policy-validation',
    authority: selected.authority ?? null, policySha256: selected.policy ? rcpDigest(selected.policy) : null,
    discoverySha256: discovery?.discoverySha256 ?? null });
  bindings.set(binding, { ...selected, binding, root, authorityRoot, repository, discovery, env });
  registerCommitPolicyMode(root, binding.mode);
  if (binding.mode === 'enforce') await writeMutablePrivateSidecar(root, path.join(gitCommonDir(root), 'singularity-flow/repository-commit-policy/enforced.json'), `${JSON.stringify({schemaVersion: 1, policySha256: binding.policySha256})}\n`, { maximumBytes: 4096 });
  return binding;
}

export async function resolveCommitTracking(binding, { subject, purpose = subject?.kind ?? 'maintenance', referenceId = null, ref = null } = {}) {
  const { policy, root, repository, definition } = repositoryCommitPolicyBinding(binding);
  if (!subject || typeof subject.id !== 'string' || !subject.id || typeof subject.kind !== 'string') rcpFailure('RCP_TRACKING_KEY_REQUIRED', 'This commit needs its canonical owner subject. Analysis and noncommitting work remain available.');
  strictObject(subject, ['kind', 'id', 'branch'], 'commit subject');
  let reference = null, source = null, workStateSha256 = null;
  const selector = policy.tracking.bindings?.[purpose] ?? (purpose === 'story' ? 'repository-story' : null);
  if (selector === 'repository-story' && subject.kind === 'story') {
    if (/[\\/\u0000]/u.test(subject.id) || ['.', '..'].includes(subject.id)) rcpFailure('RCP_TRACKING_KEY_MISMATCH', 'The canonical Story ID cannot be used as a state path.');
    const file = await secureRepositoryPath(root, `${definition?.workItemRoot ?? 'singularity/work-items'}/${subject.id}/workflow.json`, { type: 'file', mustExist: true, label: 'Canonical Story tracking state' });
    const bytes = await readFile(file.absolute, 'utf8'), workflow = JSON.parse(bytes);
    if (workflow.workItem?.id !== subject.id) rcpFailure('RCP_TRACKING_KEY_MISMATCH', 'The tracking state belongs to another canonical Story.');
    const lineage = workflow.lineage ?? {};
    const key = lineage.currentJiraKey ?? (workflow.workItem.source?.type === 'jira' ? workflow.workItem.source.key : null);
    if (key && !lineage.jiraIssueId) rcpFailure('RCP_TRACKING_KEY_REQUIRED', 'A Jira tracking key requires its retained immutable issue identity.');
    reference = { kind: 'story', key: key ?? subject.id, subjectId: subject.id, repository,
      immutableIssueId: lineage.jiraIssueId ?? null };
    source = key ? 'canonical-story-jira-lineage' : 'canonical-local-story';
    workStateSha256 = rcpDigest({ canonicalWorkId: workflow.workItem.id, key: reference.key, immutableIssueId: reference.immutableIssueId, repository });
  } else {
    const candidates = Object.entries(policy.tracking.references ?? {}).filter(([id, entry]) =>
      (!referenceId || id === referenceId) && entry.subjectId === subject.id && entry.repository === repository);
    if (candidates.length > 1) rcpFailure('RCP_TRACKING_KEY_REQUIRED', 'More than one admitted tracking reference applies; select the repository reference once in the existing owner configuration.');
    if (candidates.length === 1) { reference = candidates[0][1]; source = `approved-reference:${candidates[0][0]}`; }
  }
  if (!reference) {
    if (!policy.tracking.required) return { reference: null, source: 'not-required', workStateSha256: null };
    rcpFailure('RCP_TRACKING_KEY_REQUIRED', `No admitted ${selector ?? 'tracking'} reference is bound to ${subject.kind} '${subject.id}' in this destination.`, { repository, subject, purpose });
  }
  if (!policy.tracking.allowedKinds.includes(reference.kind)) rcpFailure('RCP_TRACKING_KIND_UNSUPPORTED', `The destination does not accept ${reference.kind} tracking for this operation.`, { subject, allowedKinds: policy.tracking.allowedKinds });
  if (typeof reference.key !== 'string' || !reference.key.trim() || /[\s\u0000]/u.test(reference.key)
      || policy.tracking.keyPattern && !compileCommitPattern(policy.tracking.keyPattern)(reference.key)) rcpFailure('RCP_TRACKING_KEY_REQUIRED', 'The canonical tracking reference does not satisfy this repository’s admitted key format.');
  const metadataBranchException = policy.metadata?.mode === 'scoped-profile' && policy.metadata.requireBranchAgreement === false && policy.metadata.purposes.includes(purpose) && policy.metadata.refs.includes(ref);
  if (policy.tracking.requireBranchAgreement && !metadataBranchException) {
    const branch = (ref ?? subject.branch ?? '').replace(/^refs\/heads\//u, '');
    const [prefix, suffix] = (policy.tracking.branchTemplate ?? '{trackingKey}').split('{trackingKey}');
    if (!branch.startsWith(prefix) || !branch.endsWith(suffix) || branch.slice(prefix.length, suffix ? -suffix.length : undefined) !== reference.key) rcpFailure('RCP_TRACKING_KEY_MISMATCH', 'Branch, canonical work identity and tracking key do not agree under the adopted branch resolver.', { ref, subject, expectedKey: reference.key });
  }
  return { reference: structuredClone(reference), source, workStateSha256 };
}

export function selectCommitProfile(binding, { purpose, ref, paths = [] }) {
  const { policy, discovery } = repositoryCommitPolicyBinding(binding);
  let alias = policy.validation.profile;
  if (policy.metadata?.mode === 'scoped-profile' && policy.metadata.purposes.includes(purpose)) {
    const within = (file, prefix) => file === prefix || file.startsWith(`${prefix}/`);
    if (!policy.metadata.refs.includes(ref) || !paths.length || paths.some(file => !policy.metadata.paths.some(prefix => within(file, prefix)))) rcpFailure('RCP_METADATA_POLICY_INCOMPATIBLE', 'The proposed changes do not fit the exact approved metadata ref/path/purpose scope.');
    alias = policy.metadata.profile;
  }
  const definition = policy.profiles?.[alias];
  if (!definition) rcpFailure('RCP_VALIDATION_UNSUPPORTED', `The immutable validation profile '${alias}' is not installed in the approved policy.`);
  const profile = normalizeCommitProfile(definition, definition.adapter);
  if (alias === policy.validation.profile && profile.adapter !== policy.validation.adapter) rcpFailure('RCP_VALIDATION_UNSUPPORTED', 'The selected profile cannot replace the repository’s required validation strategy.');
  if (!profile.platforms.includes(process.platform)) rcpFailure('RCP_VALIDATION_UNSUPPORTED', 'The selected adapter/profile is not qualified for this host OS.', { platform: process.platform, profile: alias });
  for (const hook of discovery.hooks) {
    const requirements = profile.coverage.filter(entry => entry.stage === hook.stage);
    const required = requirements.filter(entry => entry.path != null);
    if (hook.status === 'missing' && required.length) rcpFailure('RCP_HOOK_SETUP_REQUIRED', `The approved ${hook.stage} hook is not installed at its effective location.`, { stage: hook.stage });
    if (hook.status === 'unavailable') rcpFailure('RCP_VALIDATION_UNSUPPORTED', `The effective ${hook.stage} hook cannot be observed safely.`);
    if (hook.status === 'present' && !required.some(entry => entry.sha256 === hook.sha256
        && (entry.path === `@hooks/${hook.stage}` || path.resolve(discovery.repositoryPath, entry.path) === hook.path))) rcpFailure('RCP_VALIDATION_UNSUPPORTED', `The effective ${hook.stage} hook has no exact approved coverage.`, { stage: hook.stage, hookSha256: hook.sha256 });
    if (hook.status === 'present' && hook.nativeAvailability === 'not-executable' && required.length) rcpFailure('RCP_HOOK_SETUP_REQUIRED', `The required ${hook.stage} hook is not executable.`);
  }
  if (profile.adapter === 'native-git' && discovery.hooks.some(hook => hook.stage === 'pre-push' && hook.status === 'present')) rcpFailure('RCP_VALIDATION_UNSUPPORTED', 'Native pre-push stage/effect tracing is not qualified by the commit adapter. Adopt a reviewed registered pre-push equivalent or a separately qualified publication adapter; no hook is skipped.');
  if (profile.adapter === 'registered-checks') for (const entry of profile.coverage) {
    if (entry.path && ['post-commit','pre-push'].includes(entry.stage) && !entry.checks.length) rcpFailure('RCP_VALIDATION_UNSUPPORTED', 'An installed notification/publication obligation has no executable registered equivalent.', {stage:entry.stage});
  }
  // Checked-in setup is not proof that a clone installed the promised framework launcher.
  if (discovery.setup.some(input => input.path.startsWith('.husky/') || input.path === '.pre-commit-config.yaml')
      && !discovery.hooks.some(hook => hook.status === 'present')) rcpFailure('RCP_HOOK_SETUP_REQUIRED', 'Checked-in hook setup exists, but no effective hooks are installed. Follow the approved repository setup route.');
  for (const stage of policy.organizationFloor?.requiredCoverage ?? []) if (!profile.coverage.some(entry => entry.stage === stage)) rcpFailure('RCP_POLICY_CONFLICT', `The selected profile does not cover the organization’s required ${stage} obligation.`);
  return { alias, profile };
}

export async function assertCommitPolicyFresh(binding, {refreshAuthority = false} = {}) {
  const original = repositoryCommitPolicyBinding(binding);
  const fresh = await resolveRepositoryCommitPolicy(original.root, {env: original.env,refreshAuthority});
  // A fresh owner capture and its local approved-ref projection use different presentation
  // labels. Compare their immutable configuration source, not those surface labels.
  const authorityIdentity = authority => authority?.sourceCommit ?? authority?.commit ?? null;
  if (fresh.repository !== binding.repository || fresh.policySha256 !== binding.policySha256
      || fresh.discoverySha256 !== binding.discoverySha256 || authorityIdentity(fresh.authority) !== authorityIdentity(binding.authority)) rcpFailure('RCP_PLAN_STALE', 'Repository policy, effective hooks, configuration or local runtime inputs changed. Refresh the owner plan; historical records were preserved.', {expected:{repository:binding.repository,policySha256:binding.policySha256,discoverySha256:binding.discoverySha256,authority:binding.authority},observed:{repository:fresh.repository,policySha256:fresh.policySha256,discoverySha256:fresh.discoverySha256,authority:fresh.authority}});
  return fresh;
}
