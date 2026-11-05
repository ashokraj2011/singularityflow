import { TextDecoder } from 'node:util';
import {createHash} from 'node:crypto';
import { readLocalGitBlobs } from '../git-blob-batch.mjs';
import { exactTreeListing } from '../git-exact-reads.mjs';
import { secureRepositoryPath } from '../util.mjs';
import { withoutGitProcessOverrides } from '../git-enterprise-environment.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { issuedCommitPolicyPlan, assertCommitPlanCurrent } from './plan.mjs';
import { rcpDigest, rcpFailure, validateCommitMessage } from './policy.mjs';
import { retainCommitPolicyRecord, readCommitPolicyOperation, writeCommitPolicyOperation } from './records.mjs';

const MAX_BYTES = 32 * 1024 * 1024;
function inside(file, prefixes) { return !prefixes?.length || prefixes.some(prefix => file === prefix || file.startsWith(`${prefix}/`)); }
function protectedPath(file) { return /^(?:\.git(?:\/|$)|\.husky(?:\/|$)|\.pre-commit-config\.yaml$|singularity\/workflow\.yml$|(?:\.commitlintrc|commitlint\.config)(?:\.|$))/u.test(file); }
function utf8(bytes) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; } }
export function commitPlanFiles(plan) {
  const { root } = issuedCommitPolicyPlan(plan);
  const listed = exactTreeListing(root, plan.prospectiveTree, { timeoutMs: 15000, maxBytes: 16 * 1024 * 1024, required: true,
    env: { ...withoutGitProcessOverrides(process.env), GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' } }).value;
  const selected = [];
  for (const entry of listed.split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t([\s\S]+)$/u.exec(entry);
    if (!match) rcpFailure('RCP_VALIDATION_INCOMPLETE', 'Git returned an unreadable exact candidate tree.');
    const [, mode, type, oid, file] = match;
    if (plan.paths.includes(file)) selected.push({ mode, type, oid, path: file });
  }
  const blobs = readLocalGitBlobs(root, [...new Set(selected.filter(file => file.type === 'blob').map(file => file.oid))], {
    maximumBytes: MAX_BYTES, maximumObjectBytes: 4 * 1024 * 1024, code: 'RCP_VALIDATION_INCOMPLETE', label: 'Commit candidate files'
  });
  return selected.map(file => ({ ...file, bytes: file.type === 'blob' ? blobs.get(file.oid) : null }));
}
export function evaluateRegisteredChecks(plan) {
  const { profile, policy, fields } = issuedCommitPolicyPlan(plan);
  const files = profile.checks.some(check => check.rule !== 'message-envelope') || profile.normalization ? commitPlanFiles(plan) : [];
  const checks = [];
  for (const check of profile.checks) {
    const findings = [];
    if (check.rule === 'message-envelope') validateCommitMessage(policy, plan.proposedMessage, { ...fields, expectedSubject: plan.proposedMessage.split('\n')[0] });
    else for (const file of files.filter(entry => inside(entry.path, check.paths))) {
      if (file.type !== 'blob' || file.mode === '120000') { findings.push({ path: file.path, reason: 'Unsupported non-regular content for the selected text rule.' }); continue; }
      const text = utf8(file.bytes);
      if (text == null) { findings.push({ path: file.path, reason: 'The selected rule requires valid UTF-8 text.' }); continue; }
      if (check.rule === 'no-trailing-whitespace' && /[\t ]+(?=\r?$)/mu.test(text)) findings.push({ path: file.path, reason: 'Trailing whitespace.' });
      if (check.rule === 'final-newline' && text && !text.endsWith('\n')) findings.push({ path: file.path, reason: 'Missing final newline.' });
    }
    checks.push({ id: check.id, rule: check.rule, execution: 'registered-check', status: findings.length ? 'rejected' : 'passed', findings });
  }
  return { status: checks.some(check => check.status === 'rejected') ? 'rejected' : 'passed', checks, files };
}

export async function validateRegisteredCommitPlan(plan, { operationId = null } = {}) {
  const { root, profile } = issuedCommitPolicyPlan(plan);
  if (profile.adapter !== 'registered-checks') rcpFailure('RCP_VALIDATION_UNSUPPORTED', 'This plan requires the native object-production adapter; checks cannot silently replace it.');
  await assertCommitPlanCurrent(plan);
  const evaluated = evaluateRegisteredChecks(plan);
  const record = { repository: plan.repository, subject: plan.subject, planSha256: plan.planSha256,
    policySha256: plan.policySha256, profileSha256: plan.profileSha256, prospectiveTree: plan.prospectiveTree,
    messageSha256: plan.messageSha256, tracking: plan.tracking, expectedLocalRef: plan.expectedLocalRef,
    runtime: plan.runtime, configurationInputs: plan.configurationInputs, hookBindings: plan.hookBindings,
    status: evaluated.status, checks: evaluated.checks, nativeHookExecution: 'not-executed', approval: 'not-implied' };
  const reference = await retainCommitPolicyRecord(root, 'attempt', record);
  if (operationId) {
    const current = await readCommitPolicyOperation(root, operationId);
    await writeCommitPolicyOperation(root, operationId, { ...current, stage: evaluated.status === 'passed' ? 'validated' : 'validation-rejected',
      attempts: [...(current?.attempts ?? []), reference].slice(-128) });
  }
  if (evaluated.status !== 'passed') rcpFailure('RCP_CONTENT_REJECTED', 'The registered repository checks rejected the exact proposed commit. Preserve the candidate and repair the reported files through its current phase owner.', { attempt: reference, checks: evaluated.checks });
  return { record, reference };
}

/** Authoring-only normalization. A frozen/reviewed publication never grants permission to run it. */
export async function normalizeCommitCandidate(plan, { operationId, beforeSourceFreeze = false, allowedPaths = [], assertWriteAllowed } = {}) {
  const { root, profile } = issuedCommitPolicyPlan(plan);
  if (!beforeSourceFreeze || typeof assertWriteAllowed !== 'function' || !operationId) rcpFailure('RCP_CANDIDATE_CHANGED', 'Normalization requires the existing authoring owner before the source/review target is frozen.');
  await assertCommitPlanCurrent(plan);
  const current = await readCommitPolicyOperation(root, operationId), consumed = current?.changedNormalizationAttempts ?? 0;
  if (current?.stage === 'normalizing') rcpFailure('RCP_VALIDATION_INCOMPLETE', 'An earlier normalization has an unresolved effect outcome. Inspect and reconcile that exact owner operation before retrying.', { operationId });
  const steps = profile.normalization?.steps ?? [];
  const maximum = profile.normalization?.maximumChangedAttempts ?? 2;
  const changes = [];
  for (const file of commitPlanFiles(plan)) {
    let text = file.bytes && utf8(file.bytes); if (text == null || file.mode === '120000') continue;
    const original = text;
    for (const step of steps.filter(step => inside(file.path, step.paths))) {
      if (!inside(file.path, allowedPaths) || !allowedPaths.length || protectedPath(file.path) || profile.inputs.some(input => input.path === file.path)) rcpFailure('RCP_HOOK_EFFECT_OUT_OF_SCOPE', 'A formatter may not edit unadmitted files, hook programs or protected commit policy.', { path: file.path });
      if (step.rule === 'trim-trailing-whitespace') text = text.replace(/[\t ]+(?=\r?$)/gmu, '');
      if (step.rule === 'ensure-final-newline' && text && !text.endsWith('\n')) text += '\n';
    }
    if (text !== original) changes.push({ path: file.path, before: file.bytes, after: Buffer.from(text) });
  }
  if (!changes.length) return { status: 'unchanged', changedPaths: [], changedNormalizationAttempts: consumed, automaticallyRetried: false };
  if (consumed >= maximum) rcpFailure('RCP_NORMALIZATION_BUDGET_EXHAUSTED', 'The durable normalization budget is exhausted. Preserve the candidate and resolve the formatter through the current phase repair owner.', { maximumChangedAttempts: maximum, changedNormalizationAttempts: consumed });
  for (const change of changes) await assertWriteAllowed(change.path);
  await writeCommitPolicyOperation(root, operationId, { ...current, stage: 'normalizing', changedNormalizationAttempts: consumed + 1, normalizationChanges: changes.map(file => ({path: file.path, before: `sha256:${createHash('sha256').update(file.before).digest('hex')}`, after: `sha256:${createHash('sha256').update(file.after).digest('hex')}`})), normalizationInputs: rcpDigest(changes.map(file => ({ path: file.path, sha256: `sha256:${createHash('sha256').update(file.before).digest('hex')}` }))) });
  for (const change of changes) {
    const file = await secureRepositoryPath(root, change.path, { label: 'Authorized normalization output', type: 'file', mustExist: true });
    if (!(await readFile(file.absolute)).equals(change.before)) rcpFailure('RCP_PLAN_STALE', 'Source changed before the formatter could apply its exact authorized patch.', { path: change.path });
    await writeFile(file.absolute, change.after);
  }
  await writeCommitPolicyOperation(root, operationId, { ...current, stage: 'candidate-changed', changedNormalizationAttempts: consumed + 1, changedPaths: changes.map(file => file.path) });
  return { status: 'candidate-changed', changedPaths: changes.map(file => file.path), changedNormalizationAttempts: consumed + 1,
    rerunRequired: ['candidate-capture', 'affected-checks', 'affected-application-review'], historicalEvidenceReused: false };
}

/** Reconcile a crashed formatter from exact observations; never discard user/hook edits. */
export async function reconcileCommitNormalization(root, operationId) {
  const current = await readCommitPolicyOperation(root, operationId);
  if (!current?.normalizationChanges) rcpFailure('RCP_PLAN_UNISSUED', 'No issued normalization journal exists for this owner operation.');
  const observations = [];
  for (const change of current.normalizationChanges) {
    const file = await secureRepositoryPath(root, change.path, {label:'Normalization recovery', type:'file', mustExist:true});
    const actual = `sha256:${createHash('sha256').update(await readFile(file.absolute)).digest('hex')}`;
    observations.push({path:change.path, status:actual===change.after?'applied':actual===change.before?'not-applied':'changed-by-other-or-incomplete'});
  }
  const unproven = observations.some(item=>item.status==='changed-by-other-or-incomplete');
  if (!unproven) await writeCommitPolicyOperation(root,operationId,{...current,stage:'candidate-changed',normalizationRecovery:observations});
  return {status:unproven?'unproven':'candidate-changed',observations,changedNormalizationAttempts:current.changedNormalizationAttempts,sourceWrites:0,rerunRequired:['candidate-capture','affected-checks','affected-application-review'],approval:'not-implied'};
}
