import {redactionEntries,createStreamRedactor} from '../output-redaction.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { mkdir, readFile, writeFile, stat, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { gitCommonDir } from '../git-execution.mjs';
import { run, nowIso } from '../util.mjs';
import { runQualityCommand, verifyCompletedQualityLaunch } from '../quality-command-runner.mjs';
import { withoutGitProcessOverrides } from '../git-enterprise-environment.mjs';
import { gitCommitIdentityArgs, gitCommitIdentityEnvironment, gitCommitSigningArgs } from '../git.mjs';
import { gitFailureDiagnostic } from '../git-remote-diagnostics.mjs';
import { safePrivateSidecarDirectory } from '../private-sidecar.mjs';
import { issuedCommitPolicyPlan } from './plan.mjs';
import { repositoryCommitPolicyBinding } from './context.mjs';
import { rcpDigest, rcpFailure } from './policy.mjs';
import { captureCommitEffects, compareCommitEffects } from './effects.mjs';
import { retainCommitPolicyRecord, readCommitPolicyOperation, writeCommitPolicyOperation } from './records.mjs';
import { withAdmittedCommitGit, commitGitRequestDigest } from './gate.mjs';

function local(root, args, env) { return run('git', args, { cwd: root, env, timeoutMs: 15000 }); }
function plain(value) { return value.endsWith('\n') ? value : `${value}\n`; }
function nativeStages(trace, hooks) {
  const runs = new Map(), stages = [];
  for (const line of trace.split(/\r?\n/u).filter(Boolean)) {
    let event; try { event = JSON.parse(line); } catch { rcpFailure('RCP_VALIDATION_INCOMPLETE', 'Native Git hook tracing was incomplete. The object/effects remain retained for owner recovery.'); }
    if (event.event === 'child_start' && event.child_class === 'hook') {
      const stage = event.hook_name ?? hooks.find(hook => event.argv?.some(arg => String(arg).replaceAll('\\', '/').endsWith(`/${hook.stage}`)))?.stage;
      if (stage) runs.set(`${event.sid}:${event.child_id}`, { stage, status: 'unproven' });
    }
    if (event.event === 'child_exit') {
      const found = runs.get(`${event.sid}:${event.child_id}`);
      if (found) { found.status = event.code === 0 ? 'passed' : 'rejected'; found.exitCode = event.code; stages.push(found); runs.delete(`${event.sid}:${event.child_id}`); }
    }
  }
  return [...stages, ...runs.values()];
}

/** Native Git uses the real working root and branch, with an explicitly admitted private Git dir. */
export async function createNativePolicyObject(root, plan, options) {
  const budgetId = rcpDigest({subject: plan.subject, purpose: plan.purpose, ref: plan.ref, phase: plan.fields?.phase ?? null, generation: plan.ownerGeneration, profile: plan.profileSha256, budget: 'native-source-normalization'});
  return withSubjectLock(root, {kind: 'repository-commit-policy-budget', id: budgetId.slice(7)}, () => createNativePolicyObjectOnce(root, plan, {...options, budgetId}));
}
async function createNativePolicyObjectOnce(root, plan, { operationId, identity, signing, env, budgetId }) {
  const { profile, binding } = issuedCommitPolicyPlan(plan), context = repositoryCommitPolicyBinding(binding);
  if (await realpath(context.authorityRoot) !== await realpath(root)) rcpFailure('RCP_VALIDATION_UNSUPPORTED', 'This native profile cannot faithfully substitute a configuration projection for its original application working root. Use its reviewed metadata equivalent or a separately supported binding.');
  if (plan.parents.length > 1) rcpFailure('RCP_VALIDATION_UNSUPPORTED', 'The native adapter has not qualified merge-message source semantics. No fallback strategy was selected.');
  for (const name of ['HUSKY_SKIP_HOOKS', 'SKIP_GIT_HOOKS', 'SKIP']) if (env[name]) rcpFailure('RCP_HOOK_SETUP_REQUIRED', 'A hook-disabling environment setting conflicts with the adopted native profile. Restore its approved environment binding before retrying.', { setting: name });
  if (env.HUSKY === '0' || env.LEFTHOOK === '0') rcpFailure('RCP_HOOK_SETUP_REQUIRED', 'The required hook framework is disabled in this host environment.');
  const budget = await readCommitPolicyOperation(root, budgetId);
  const consumed = budget?.changedNormalizationAttempts ?? 0;
  const maximum = profile.normalization?.maximumChangedAttempts ?? 2;
  if (consumed >= maximum) rcpFailure('RCP_NORMALIZATION_BUDGET_EXHAUSTED', 'The persistent native formatting budget for this owner generation is exhausted. Preserve the source and request its phase repair/human configuration review.', {operationId, budgetId, consumed, maximum});
  const directory = path.join(gitCommonDir(root), 'singularity-flow', 'repository-commit-policy', 'native', operationId.replace(/^sha256:/u, ''));
  await safePrivateSidecarDirectory(root, directory, { create: true });
  const gitDirectory = path.join(directory, 'git'), messageFile = path.join(directory, 'message'), traceFile = path.join(directory, 'hook-trace');
  const environment = gitCommitIdentityEnvironment(withoutGitProcessOverrides(env), identity);
  const common = gitCommonDir(root);
  local(directory, ['init', '--bare', '--quiet', '--template=', `--object-format=${plan.prospectiveTree.length === 64 ? 'sha256' : 'sha1'}`, gitDirectory], environment);
  await mkdir(path.join(gitDirectory, 'objects/info'), { recursive: true });
  if (/[\r\n\u0000]/u.test(common)) rcpFailure('RCP_VALIDATION_UNSUPPORTED', 'The native object-store path cannot be represented safely.');
  await writeFile(path.join(gitDirectory, 'objects/info/alternates'), `${path.join(common, 'objects').replaceAll('\\', '/')}\n`);
  const base = [`--git-dir=${gitDirectory}`, `--work-tree=${root}`, '-c', 'core.bare=false', '-c', `core.hooksPath=${context.discovery.effectiveHooksPath}`];
  for (const entry of context.discovery.configuration) {
    if (entry.value != null && /^(?:core\.(?:autocrlf|safecrlf)|commit\.cleanup|i18n\.commitencoding)$/iu.test(entry.name)) base.push('-c', `${entry.name}=${entry.value}`);
  }
  const encoding = context.discovery.configuration.find(entry => entry.name.toLowerCase() === 'i18n.commitencoding')?.value;
  if (encoding && !/^utf-?8$/iu.test(encoding)) rcpFailure('RCP_VALIDATION_UNSUPPORTED', 'The native adapter has not qualified this commit encoding.');
  local(directory, [...base, 'symbolic-ref', 'HEAD', plan.ref], environment);
  if (plan.parents[0]) {
    const initialRef = [...base, 'update-ref', plan.ref, plan.parents[0]];
    withAdmittedCommitGit(directory, {kind: 'private-ref', requestSha256: commitGitRequestDigest(initialRef, {env: environment})}, () => local(directory, initialRef, environment));
  }
  local(directory, [...base, 'read-tree', plan.prospectiveTree], environment);
  await writeFile(messageFile, plan.proposedMessage, { mode: 0o600 });
  await writeFile(traceFile, '', { mode: 0o600, flag: 'wx' });
  const before = await captureCommitEffects(root, profile.native);
  await writeFile(path.join(directory, 'before.json'), JSON.stringify(before), { mode: 0o600 });
  const startedAt = nowIso();
  const args = [...base, ...gitCommitIdentityArgs(identity), ...gitCommitSigningArgs(signing), 'commit', ...(signing.required ? [`-S${signing.key}`] : []), '--file', messageFile];
  const actualEnvironment = { ...environment, GIT_TRACE2_EVENT: traceFile, GIT_TRACE2_ENV_VARS: '', GIT_TRACE2_CONFIG_PARAMS: '' };
  const controller = new AbortController();
  let traceLimit = false;
  const monitor = setInterval(() => { void stat(traceFile).then(info => { if (info.size > 4 * 1024 * 1024) { traceLimit = true; controller.abort(); } }, () => {}); }, 100);
  const outputSecrets = redactionEntries(Object.entries(actualEnvironment).filter(([name]) => /(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|PRIVATE_KEY)/iu.test(name)).map(([name,value]) => ({name:name.toUpperCase(),value})));
  await writeCommitPolicyOperation(root,operationId,{...await readCommitPolicyOperation(root,operationId),nativeCandidate:{directory,ref:plan.ref,commit:null,startedAt}});
  let result;
  try {
    result = await withAdmittedCommitGit(root, { kind: 'commit-object', requestSha256: commitGitRequestDigest(args, { env: actualEnvironment }) }, () =>
      runQualityCommand('git', args, { cwd: root, env: actualEnvironment, timeoutMs: profile.native.timeoutMs,
        captureBytes: profile.native.maxOutputBytes, signal: controller.signal, killTree: true, redactor:()=>createStreamRedactor(outputSecrets) }));
  } catch (error) { await unlink(traceFile).catch(()=>{}); throw error; } finally { clearInterval(monitor); }
  const provenance = verifyCompletedQualityLaunch(result, { command: 'git', args, cwd: root,
    environmentSha256: rcpDigest(Object.entries(actualEnvironment).sort()).slice(7), stdoutFile: null });
  let trace = '';
  try { const bytes = await readFile(traceFile); if (bytes.length <= 4 * 1024 * 1024) trace = bytes.toString('utf8'); else traceLimit = true; }
  catch { /* Missing trace is unproven, never a passing hook. */ }
  finally { await unlink(traceFile).catch(() => {}); }
  const after = await captureCommitEffects(root, profile.native), effects = compareCommitEffects(before, after, plan.paths);
  const headResult = run('git', [...base, 'rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: directory, env: environment, allowFailure: true, timeoutMs: 15000 });
  const observedHead = headResult.status === 0 ? headResult.stdout.trim() : null;
  const commit = observedHead === plan.parents[0] ? null : observedHead;
  const privateIndex = run('git',[...base,'write-tree'],{cwd:directory,env:environment,allowFailure:true,timeoutMs:15000});
  const actualPrivateIndexTree = privateIndex.status===0 ? privateIndex.stdout.trim() : null;
  let stages = [], traceError = null;
  try { stages = trace ? nativeStages(trace, context.discovery.hooks) : []; } catch (error) { traceError = error.code; }
  const record = { repository: plan.repository, subject: plan.subject, planSha256: plan.planSha256, policySha256: plan.policySha256,
    profileSha256: plan.profileSha256, prospectiveTree: plan.prospectiveTree, messageSha256: plan.messageSha256,
    startedAt, completedAt: nowIso(), execution: 'native-git', commit, stages, effects,actualPrivateIndexTree,
    status: result.timedOut ? 'timed-out' : result.aborted ? 'interrupted' : result.error?.code === 'ENOENT' ? 'tool-unavailable' : result.status === 0 && provenance && actualPrivateIndexTree===plan.prospectiveTree && !effects.changedPaths.length ? 'passed' : 'rejected',
    diagnostic: gitFailureDiagnostic(result), approval: 'not-implied', finalRemoteOrCiStatus: 'not-observed' };
  const validation = await retainCommitPolicyRecord(root, 'attempt', record);
  const current = await readCommitPolicyOperation(root, operationId);
  await writeCommitPolicyOperation(root, operationId, { ...current, nativeCandidate: { directory, ref: plan.ref, commit, startedAt },
    stage: commit ? 'native-object-retained' : 'native-attempt-rejected', nativeValidation: validation, nativeEffects: effects });
  if (commit) {
    // Import the exact private object, without checkout, owner-ref movement, or reauthoring.
    // The existing owner still decides whether this object is eligible for its CAS/push.
    local(root, ['-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance', '--no-recurse-submodules', gitDirectory, commit], environment);
    const retainedRef = `refs/sflow/rcp/objects/${operationId.slice(7)}`;
    const retention = ['update-ref', retainedRef, commit];
    withAdmittedCommitGit(root, { kind: 'private-ref', requestSha256: commitGitRequestDigest(retention, { env: environment }) }, () => local(root, retention, environment));
  }
  if (effects.changedPaths.length) await writeCommitPolicyOperation(root, budgetId, {...budget, changedNormalizationAttempts: consumed + 1, stage: 'candidate-changed', lastOperation: operationId});
  if (effects.outOfScope.length) rcpFailure('RCP_HOOK_EFFECT_OUT_OF_SCOPE', 'Native hooks changed files or Git control data outside the admitted commit scope. Actual files and any private object were retained.', { operationId, commit, effects, validation });
  if (effects.changedPaths.length) rcpFailure('RCP_CANDIDATE_CHANGED', 'Native hook formatting changed the source target. Preserve those changes, capture a new candidate and rerun affected checks/review; no owner branch was advanced.', { operationId, commit, effects, validation });
  if (actualPrivateIndexTree!==plan.prospectiveTree) rcpFailure('RCP_HOOK_INDEX_CHANGED','The native hook changed its private index outside the admitted candidate. The exact object/index are retained; no owner ref was advanced.',{operationId,commit,actualPrivateIndexTree,validation});
  if (traceLimit || traceError || result.timedOut || result.aborted || !trace) rcpFailure('RCP_VALIDATION_INCOMPLETE', 'Native execution or required stage observations did not complete. Reconcile the retained object/process/effects before retrying.', { operationId, commit, validation });
  if (!commit || result.status !== 0 || !provenance) rcpFailure(result.error?.code === 'ENOENT' || /(?:command not found|not recognized|cannot find|No such file)/iu.test(result.stderr) ? 'RCP_HOOK_TOOL_UNAVAILABLE' : 'RCP_MESSAGE_REJECTED', 'The actual native Git/hook command refused the commit. Inspect its specific tool/check prerequisite and retry through the same owner; no alternate adapter was selected.', { operationId, commit, validation, diagnostic: record.diagnostic });
  for (const hook of context.discovery.hooks.filter(hook => ['pre-commit', 'prepare-commit-msg', 'commit-msg'].includes(hook.stage) && hook.status === 'present')) {
    if (!stages.some(stage => stage.stage === hook.stage && stage.status === 'passed')) rcpFailure('RCP_VALIDATION_INCOMPLETE', 'A required native hook stage has no completed execution observation.', { stage: hook.stage, operationId, commit, validation });
  }
  if (stages.some(stage => stage.stage === 'post-commit' && stage.status !== 'passed')) rcpFailure('RCP_POST_COMMIT_NOTIFICATION_PENDING', 'The commit object exists, but its post-commit notification failed. Preserve that exact object; do not rerun commit or its timestamp-producing hooks.', { operationId, commit, validation });
  return { commit, validation, stages, effects, startedAt, completedAt: record.completedAt,
    nativeContext: 'original-worktree-private-git', beforeMessageSha256: plan.messageSha256,
    internalLinterObservation: 'covered-by-approved-hook-contract-not-separately-observed', postTransformationCi: 'not-observed' };
}

export function verifyNativeCommitMessage(plan, finalMessage, observation) {
  const { profile, policy } = issuedCommitPolicyPlan(plan), transform = profile.native.messageTransform;
  const draft = plain(plan.proposedMessage);
  if (!transform) {
    if (finalMessage !== draft) rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'Native Git changed the message outside its approved normalization contract.', { commit: observation.commit });
    return;
  }
  if (!observation.stages.some(stage => stage.stage === transform.producer && stage.status === 'passed')) rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'The declared message producer has no completed native observation.');
  const original = transform.placement === 'subject-suffix' ? draft.split('\n')[0] : draft.replace(/\n$/u, '');
  const prefix = `${original}${transform.delimiter}${transform.prefix}`;
  const observed = transform.placement === 'subject-suffix' ? finalMessage.split('\n')[0] : finalMessage.replace(/\n$/u, '');
  if (!observed.startsWith(prefix) || !/^[0-9]{1,16}$/u.test(observed.slice(prefix.length))) rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'The managed hook did not produce the exact admitted timestamp placement and encoding.');
  const timestamp = Number(observed.slice(prefix.length));
  const start = Date.parse(observation.startedAt) / 1000, end = Date.parse(observation.completedAt) / 1000;
  if (!Number.isSafeInteger(timestamp) || timestamp < start - transform.maximumClockSkewSeconds || timestamp > end + transform.maximumClockSkewSeconds) rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'The generated timestamp is outside its admitted execution/clock bound.');
  if (transform.placement === 'subject-suffix' && finalMessage.slice(finalMessage.indexOf('\n')) !== draft.slice(draft.indexOf('\n'))) rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'The managed subject transformation modified immutable message body/provenance bytes.');
  if (Buffer.byteLength(finalMessage.split('\n')[0]) > policy.maxSubjectBytes) rcpFailure('RCP_COMMIT_OBJECT_REJECTED', 'The generated suffix breaks the adopted complete subject byte limit.');
}
