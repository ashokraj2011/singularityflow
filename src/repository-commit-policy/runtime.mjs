import {redactionEntries, redactText} from '../output-redaction.mjs';
import {redactDiagnosticText} from '../git-remote-diagnostics.mjs';
import { TextDecoder } from 'node:util';
import { run, nowIso } from '../util.mjs';
import { withoutGitProcessOverrides } from '../git-enterprise-environment.mjs';
import { resolveGitCommitIdentity, resolveGitCommitSigning, gitCommitIdentityArgs, gitCommitIdentityEnvironment, gitCommitSigningArgs, validateGitCommitIdentity } from '../git.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { planRepositoryCommit, issuedCommitPolicyPlan, assertCommitPlanCurrent } from './plan.mjs';
import { validateRegisteredCommitPlan } from './checks.mjs';
import { retainCommitPolicyRecord, readCommitPolicyRecord, readCommitPolicyOperation, writeCommitPolicyOperation, bindCommitPolicyObject, operationForCommit } from './records.mjs';
import { rcpFailure, rcpDigest, validateCommitMessage } from './policy.mjs';
import { withAdmittedCommitGit, commitGitRequestDigest } from './gate.mjs';

const admissions = new WeakMap();
function cleanEnvironment(source = process.env) { return { ...withoutGitProcessOverrides(source), GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' }; }
function storedMessage(value) { return value.endsWith('\n') ? value : `${value}\n`; }
export function observePolicyCommit(root, commit) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit ?? '')) rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'Git did not return an exact commit object.');
  const bytes = run('git', ['cat-file', 'commit', commit], { cwd: root, env: cleanEnvironment(), encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, timeoutMs: 15000 }).stdout;
  let raw; try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'The actual commit message is not supported UTF-8.'); }
  const separator = raw.indexOf('\n\n');
  if (separator < 0) rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'The actual Git commit object has no complete message.');
  const header = raw.slice(0, separator).split('\n'), message = raw.slice(separator + 2);
  return { schemaVersion: 1, kind: 'repository-commit-policy-object', commit,
    tree: header.find(line => line.startsWith('tree '))?.slice(5), parents: header.filter(line => line.startsWith('parent ')).map(line => line.slice(7)),
    author: header.find(line => line.startsWith('author '))?.slice(7), committer: header.find(line => line.startsWith('committer '))?.slice(10),
    message, messageSha256: rcpDigest(message), signature: header.some(line => line.startsWith('gpgsig ')) ? 'present-unverified' : 'absent' };
}
function verifyIdentity(value, expected) {
  return typeof value === 'string' && value.startsWith(`${expected.name} <${expected.email}> `) && /^\d+ [+-]\d{4}$/u.test(value.slice(`${expected.name} <${expected.email}> `.length));
}
async function verifyObject(plan, commit, identity, { native = null } = {}) {
  const { root, policy, fields } = issuedCommitPolicyPlan(plan);
  const object = observePolicyCommit(root, commit);
  if (object.tree !== plan.prospectiveTree || rcpDigest(object.parents) !== rcpDigest(plan.parents)
      || !verifyIdentity(object.author, identity) || !verifyIdentity(object.committer, identity)) rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'The created commit has unexpected content, parents or frozen authorship. Its object is retained and no owner ref was advanced.', { commit });
  if (!native && object.message !== storedMessage(plan.proposedMessage)) rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'The actual complete message differs from the admitted draft and declared Git normalization.', { commit });
  if (native) (await import('./native.mjs')).verifyNativeCommitMessage(plan, object.message, native);
  validateCommitMessage(policy, object.message, { ...fields, ...(!native ? { expectedSubject: plan.proposedMessage.split('\n')[0] } : {}) });
  if (policy.signing?.required && object.signature !== 'present-unverified') rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'The actual commit is missing its required signature.', { commit });
  if (object.signature === 'present-unverified') {
    const verified = run('git', ['verify-commit', '--raw', commit], { cwd: root, env: cleanEnvironment(), allowFailure: true, timeoutMs: 30000, maxBuffer: 65536 });
    if (verified.status !== 0) rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'The created object’s signature could not be verified under its required signing contract.', { commit });
    object.signature = 'verified';
  }
  return object;
}

/** RCP produces/observes objects only; the existing owner still performs its ref CAS and push. */
export async function createRepositoryPolicyCommit(root, request, {
  env = process.env, sign = false, signingKey = null, commitIdentity = null, legacyCreate, fault = null
} = {}) {
  const operationId = rcpDigest(request.operationId
    ? { ownerActionId: request.operationId, subject: request.subject, purpose: request.purpose, ref: request.ref }
    : { subject: request.subject, purpose: request.purpose, ref: request.ref, tree: request.tree, parents: request.parents, message: request.message });
  const prior = await readCommitPolicyOperation(root, operationId);
  const {resolveRepositoryCommitPolicy,repositoryCommitPolicyBinding}=await import('./context.mjs');
  const policyBinding = await resolveRepositoryCommitPolicy(root,{env});
  const plan = await planRepositoryCommit(root, { ...request, policyBinding, operationId, ...(prior ? { expectedLocalRef: prior.expectedLocalRef } : {}) });
  if (plan.status === 'not-applicable') {
    if (typeof legacyCreate !== 'function') return null;
    return { commit: await legacyCreate(request.message), admission: null, compliance: plan.compliance };
  }
  const { profile, policy } = issuedCommitPolicyPlan(plan);
  const secrets = redactionEntries(Object.entries(env).filter(([name]) => /(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE_KEY)/iu.test(name)).map(([name,value]) => ({name:name.toUpperCase(),value})));
  if (redactText(plan.proposedMessage,secrets) !== plan.proposedMessage) rcpFailure('RCP_MESSAGE_REJECTED', 'The proposed message contains a bound secret value. No commit or message record was created.');
  return withSubjectLock(root, { kind: 'repository-commit-policy', id: operationId.slice(7) }, async () => {
    let operation = await readCommitPolicyOperation(root, operationId);
    if (operation?.planSha256 && operation.planSha256 !== plan.planSha256) rcpFailure('RCP_PLAN_STALE', 'This idempotent owner action is already bound to different commit inputs. Preserve its existing recovery operation.', { operationId });
    if (operation?.observation) {
      const prior = await readCommitPolicyRecord(root, operation.observation);
      if (prior.messageRedacted) rcpFailure('RCP_OBJECT_RECONCILIATION_REQUIRED', 'The retained object contains unsafe message material and cannot be admitted by a retry.', {operationId,commit:prior.commit});
      const current = run('git', ['rev-parse', '--verify', '--quiet', plan.ref], { cwd: root, env: cleanEnvironment(), allowFailure: true }).stdout.trim();
      const refAdvanced = current === prior.commit;
      await assertCommitPlanCurrent(plan, { allowLocalRef: refAdvanced ? prior.commit : null });
      const actual = await verifyObject(plan, prior.commit, operation.identity, { native: operation.native ?? null });
      const admission = Object.freeze({ operationId, commit: actual.commit, object: operation.observation, reused: true });
      admissions.set(admission, { root, plan, operationId, observation: actual });
      await bindCommitPolicyObject(root, actual.commit, operationId);
      return { commit: actual.commit, admission, reused: true, refAdvanced };
    }
    if (operation?.nativeCandidate?.commit) rcpFailure('RCP_OBJECT_RECONCILIATION_REQUIRED', 'An earlier native turn already produced a retained object. Its validation/effects require owner reconciliation; repeating commit would rerun hooks and change its identity.', { operationId, commit: operation.nativeCandidate.commit, validation: operation.nativeValidation });
    if (operation?.stage === 'native-attempt-rejected') rcpFailure('RCP_REPAIR_REQUIRED', 'The prior native attempt was rejected before creating an object. Repair its reported prerequisite, then request a new owner plan using the original draft. This attempt is not retried automatically.', { operationId, validation: operation.nativeValidation });
    if (operation?.stage === 'creating-object') rcpFailure('RCP_VALIDATION_INCOMPLETE', 'The earlier object-production result is unproven. Reconcile its retained owner operation instead of rerunning hooks or creating another commit.', { operationId });
    const identity = commitIdentity ? validateGitCommitIdentity(commitIdentity) : resolveGitCommitIdentity(root, { env });
    const signing = resolveGitCommitSigning(root, { env, required: sign || policy.signing?.required === true });
    if (signingKey && signing.key !== signingKey) rcpFailure('RCP_PLAN_STALE', 'The owner’s frozen signing key no longer matches the configured signer. No commit was created.');
    const planReference = await retainCommitPolicyRecord(root, 'plan', plan);
    const discoveryReference = await retainCommitPolicyRecord(root, 'discovery', repositoryCommitPolicyBinding(policyBinding).discovery);
    operation ??= { createdAt: nowIso(), changedNormalizationAttempts: 0, attempts: [] };
    operation = await writeCommitPolicyOperation(root, operationId, { ...operation, stage: 'planned', planSha256: plan.planSha256,
      plan: planReference, discovery: discoveryReference, ownerActionId: request.operationId ?? null, subject: plan.subject, purpose: plan.purpose, ref: plan.ref, identity, expectedLocalRef: plan.expectedLocalRef });
    let validation = null, native = null;
    if (profile.adapter === 'registered-checks') validation = await validateRegisteredCommitPlan(plan, { operationId });
    await assertCommitPlanCurrent(plan);
    operation = await readCommitPolicyOperation(root, operationId);
    operation = await writeCommitPolicyOperation(root, operationId, { ...operation, stage: 'creating-object', validation: validation?.reference ?? null });
    let commit;
    if (profile.adapter === 'native-git') {
      native = await (await import('./native.mjs')).createNativePolicyObject(root, plan, { operationId, identity, signing, env });
      commit = native.commit;
    } else {
      const environment = gitCommitIdentityEnvironment(cleanEnvironment(env), identity);
      const args = [...gitCommitIdentityArgs(identity), ...gitCommitSigningArgs(signing), 'commit-tree', plan.prospectiveTree,
        ...plan.parents.flatMap(parent => ['-p', parent]), ...(signing.required ? [`-S${signing.key}`] : []), '-m', plan.proposedMessage];
      const result = withAdmittedCommitGit(root, { kind: 'commit-object', requestSha256: commitGitRequestDigest(args, { env: environment }) }, () =>
        run('git', args, { cwd: root, env: environment, timeoutMs: 120000 }));
      commit = result.stdout.trim();
    }
    // Retain the raw observation before interpreting it. An invalid object is still an object.
    const observed = observePolicyCommit(root, commit);
    const safeMessage = redactText(redactDiagnosticText(observed.message, {multiline:true}),secrets);
    const messageRedacted = safeMessage.trim() !== observed.message.trim();
    const observation = await retainCommitPolicyRecord(root, 'object', { ...observed, ...(messageRedacted ? {message:safeMessage,messageRedacted:true} : {}), status: 'object-created-not-admitted',
      policyPlan: planReference, validation: validation?.reference ?? native?.validation ?? null, approval: 'not-implied' });
    operation = await readCommitPolicyOperation(root, operationId);
    await writeCommitPolicyOperation(root, operationId, { ...operation, stage: 'object-created', observation, native, commit });
    if (messageRedacted) rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'A hook placed unsafe or bound secret material in the actual commit message. The private object and a redacted observation were retained; no owner ref was advanced.', {commit,operationId});
    if (fault) await fault('after-commit-policy-object', { commit, operationId });
    const actual = await verifyObject(plan, commit, identity, { native });
    await assertCommitPlanCurrent(plan);
    const verifiedObservation = await retainCommitPolicyRecord(root, 'object', { ...actual, status: 'object-verified', rawObservation: observation, policyPlan: planReference, validation: validation?.reference ?? native?.validation ?? null, approval: 'not-implied' });
    const admission = Object.freeze({ operationId, commit, object: verifiedObservation, reused: false });
    admissions.set(admission, { root, plan, operationId, observation: actual });
    await writeCommitPolicyOperation(root, operationId, { ...await readCommitPolicyOperation(root, operationId), stage: 'object-verified', observation: verifiedObservation });
    await bindCommitPolicyObject(root, commit, operationId);
    return { commit, admission, object: actual, validation: validation?.reference ?? native?.validation ?? null };
  });
}

/** Rebind a retained exact object for its original owner's ref operation, without recreating it. */
export async function withRetainedPolicyRefAdmission(root, commit, ref, action, options = {}) {
  const binding = await (await import('./context.mjs')).resolveRepositoryCommitPolicy(root);
  if (binding.mode !== 'enforce') return action();
  const operation = await operationForCommit(root, commit);
  if (!operation?.plan) rcpFailure('RCP_PUBLICATION_UNPROVEN', 'The exact owner object has no locally rebound validation record. Preserve it and refresh its retained publication plan.', {commit, ref});
  const plan = await readCommitPolicyRecord(root, operation.plan);
  if (plan.ref !== ref) rcpFailure('RCP_PUBLICATION_UNPROVEN', 'The retained object belongs to a different exact destination.', {commit, ref});
  const result = await createRepositoryPolicyCommit(root, {subject: plan.subject, purpose: plan.purpose, ref, tree: plan.prospectiveTree,
    parents: plan.parents, message: plan.draftMessage, ...plan.fields, generation: plan.ownerGeneration, operationId: operation.ownerActionId,
    ...(plan.expectedRemote === undefined ? {} : {expectedRemote: plan.expectedRemote})});
  if (result.commit !== commit) rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'Owner reconciliation did not return the exact retained object.');
  return withRepositoryPolicyRefAdmission(result.admission, action, options);
}

/** Execute only the existing owner’s exact branch compare-and-swap after a fresh policy check. */
export async function withRepositoryPolicyRefAdmission(admission, action, { noDereference = true, env = cleanEnvironment() } = {}) {
  if (admission == null) return action();
  const issued = admissions.get(admission);
  if (!issued) rcpFailure('RCP_PLAN_UNISSUED', 'The commit observation has no verified owner admission.');
  const { root, plan, operationId, observation } = issued;
  await assertCommitPlanCurrent(plan, {refreshAuthority:true});
  const args = ['update-ref', ...(noDereference ? ['--no-deref'] : []), plan.ref, observation.commit, plan.expectedLocalRef ?? '0'.repeat(observation.commit.length)];
  let result;
  try {
    result = await withAdmittedCommitGit(root, { kind: 'verified-ref', requestSha256: commitGitRequestDigest(args, { env }) }, action);
    const actual = run('git', ['rev-parse', '--verify', '--quiet', plan.ref], { cwd: root, env: cleanEnvironment(), allowFailure: true }).stdout.trim();
    await writeCommitPolicyOperation(root, operationId, { ...await readCommitPolicyOperation(root, operationId),
      stage: actual === observation.commit ? 'ref-advanced' : 'ref-outcome-unproven', refAdvanced: actual === observation.commit });
    return result;
  } catch (error) {
    // Once the owner's CAS has been attempted, a failed read or sidecar write is not proof
    // that the branch stayed put. Its existing journal must reconcile the exact object.
    error.publicationRefOutcomeUnknown = true;
    throw error;
  }
}
