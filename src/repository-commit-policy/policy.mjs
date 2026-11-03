import {currentSchemaVersion, readRecord} from '../schema-migrations.mjs';
import { createHash } from 'node:crypto';
import { compileCommitPattern } from './pattern.mjs';
import { normalizeCommitProfile, policyPath } from './profile.mjs';
import { SingularityFlowError } from '../util.mjs';

export const RCP_NAMESPACE = 'RCP';
export const RCP_SCHEMA_VERSION = currentSchemaVersion('repository-commit-policy');
export const COMMIT_HOOK_STAGES = Object.freeze(['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-push']);
export const RCP_STATUSES = Object.freeze(['passed', 'rejected', 'tool-unavailable', 'timed-out', 'interrupted', 'unproven', 'not-applicable']);
export const RCP_PURPOSES = Object.freeze(['story', 'initiative', 'run', 'configuration', 'ledger', 'maintenance', 'candidate', 'recovery']);
const FIELDS = new Set(['trackingKey', 'summary', 'type', 'scope', 'phase']);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;

export function rcpFailure(code, message, details = {}) {
  throw new SingularityFlowError(message, { code, details: { ...details,
    nextAction: details.nextAction ?? { copilot: '/sf-git-policy show', shell: 'singularity-flow git-policy show --json', vscode: '@sflow /git-policy', command: 'singularity-flow git-policy show --json', copilotCommand: '/sf-git-policy show', modelFreeCommand: '@sflow /git-policy' } } });
}
export function strictObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) rcpFailure('RCP_POLICY_INVALID', `${label} must be an object.`);
  const unknown = Object.keys(value).filter(key => !fields.includes(key));
  if (unknown.length) rcpFailure('RCP_POLICY_INVALID', `${label} has unsupported fields: ${unknown.join(', ')}.`);
  return value;
}
export function rcpDigest(value) {
  const sorted = item => Array.isArray(item) ? item.map(sorted) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])])) : item;
  return `sha256:${createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex')}`;
}
function text(value, label, maximum = 4096) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum || /[\r\n\u0000]/u.test(value)) rcpFailure('RCP_POLICY_INVALID', `${label} must be nonempty single-line text within ${maximum} bytes.`);
  return value;
}
function enumeration(value, values, label) { if (!values.includes(value)) rcpFailure('RCP_POLICY_INVALID', `${label} must be one of ${values.join(', ')}.`); return value; }
function list(value, label) { if (!Array.isArray(value) || value.length > 128 || value.some(item => typeof item !== 'string' || !TOKEN.test(item)) || new Set(value).size !== value.length) rcpFailure('RCP_POLICY_INVALID', `${label} must contain distinct registered identifiers.`); return [...value]; }
export function commitTemplateFields(template) {
  text(template, 'subjectTemplate', 1024);
  const fields = [...template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu)].map(found => found[1]);
  if (/[{}]/u.test(template.replace(/\{[A-Za-z][A-Za-z0-9]*\}/gu, '')) || fields.some(field => !FIELDS.has(field))
      || fields.filter(field => field === 'summary').length !== 1 || new Set(fields).size !== fields.length) rcpFailure('RCP_POLICY_INVALID', 'subjectTemplate requires one summary and distinct registered placeholders.');
  return fields;
}
export function normalizeCommitPolicy(value) {
  if (value == null) return null;
  strictObject(value, ['schemaVersion', 'mode', 'subjectTemplate', 'subjectPattern', 'maxSubjectBytes', 'tracking', 'validation', 'profiles', 'metadata', 'defaults', 'types', 'scopes', 'body', 'signing', 'outgoingRange', 'organizationFloor'], 'git.commitPolicy');
  const policy = structuredClone(readRecord('repository-commit-policy', value).record);
  enumeration(policy.mode, ['off', 'discover', 'enforce'], 'commitPolicy.mode');
  if (policy.mode !== 'enforce' && policy.subjectTemplate === undefined) {strictObject(policy, ['schemaVersion','mode'], 'inactive commit policy');return policy;}
  const fields = commitTemplateFields(policy.subjectTemplate);
  if (!Number.isSafeInteger(policy.maxSubjectBytes ?? 120) || (policy.maxSubjectBytes ?? 120) < 1 || (policy.maxSubjectBytes ?? 120) > 8192) rcpFailure('RCP_POLICY_INVALID', 'maxSubjectBytes must be between 1 and 8192.');
  policy.maxSubjectBytes ??= 120;
  if (policy.subjectPattern) compileCommitPattern(policy.subjectPattern);
  policy.tracking ??= { required: fields.includes('trackingKey'), allowedKinds: ['story'], bindings: {} };
  strictObject(policy.tracking, ['required', 'allowedKinds', 'bindings', 'references', 'keyPattern', 'requireBranchAgreement', 'branchTemplate'], 'tracking');
  if (typeof policy.tracking.required !== 'boolean') rcpFailure('RCP_POLICY_INVALID', 'tracking.required must be boolean.');
  if (policy.tracking.required && !fields.includes('trackingKey')) rcpFailure('RCP_POLICY_INVALID', 'A required tracking reference must appear in the subject template.');
  policy.tracking.allowedKinds = list(policy.tracking.allowedKinds ?? ['story'], 'tracking.allowedKinds');
  if (policy.tracking.keyPattern) compileCommitPattern(policy.tracking.keyPattern);
  if (policy.tracking.requireBranchAgreement != null && typeof policy.tracking.requireBranchAgreement !== 'boolean') rcpFailure('RCP_POLICY_INVALID', 'requireBranchAgreement must be boolean.');
  if (policy.tracking.branchTemplate != null) {
    text(policy.tracking.branchTemplate, 'branchTemplate', 256);
    if (policy.tracking.branchTemplate.split('{trackingKey}').length !== 2 || /[{}]/u.test(policy.tracking.branchTemplate.replace('{trackingKey}', ''))) rcpFailure('RCP_POLICY_INVALID', 'branchTemplate must contain exactly one trackingKey placeholder.');
  }
  strictObject(policy.tracking.bindings ?? {}, RCP_PURPOSES, 'tracking.bindings');
  for (const selector of Object.values(policy.tracking.bindings ?? {})) enumeration(selector, ['repository-story', 'approved-planning-story', 'approved-tracking-reference', 'approved-maintenance-story'], 'tracking binding');
  strictObject(policy.tracking.references ?? {}, Object.keys(policy.tracking.references ?? {}), 'tracking.references');
  for (const [id, ref] of Object.entries(policy.tracking.references ?? {})) {
    text(id, 'tracking reference id', 128);
    strictObject(ref, ['kind', 'key', 'subjectId', 'repository', 'immutableIssueId'], 'tracking reference');
    for (const name of ['kind', 'key', 'subjectId', 'repository']) text(ref[name], `tracking reference ${name}`, 256);
  }
  strictObject(policy.validation ?? {}, ['adapter', 'profile'], 'validation');
  enumeration(policy.validation?.adapter, ['registered-checks', 'native-git'], 'validation.adapter');
  text(policy.validation?.profile, 'validation.profile', 128);
  strictObject(policy.profiles ?? {}, Object.keys(policy.profiles ?? {}), 'profiles');
  for (const [name, profile] of Object.entries(policy.profiles ?? {})) {
    if (!TOKEN.test(name)) rcpFailure('RCP_POLICY_INVALID', 'Profile aliases must be registered identifiers.');
    const normalized = normalizeCommitProfile(profile, profile.adapter);
    const { profileSha256: _digest, ...definition } = normalized;
    policy.profiles[name] = definition;
  }
  for (const name of ['types', 'scopes']) if (policy[name] != null) policy[name] = list(policy[name], name);
  strictObject(policy.defaults ?? {}, ['type', 'scope'], 'defaults');
  for (const [name, entry] of Object.entries(policy.defaults ?? {})) text(entry, `default ${name}`, 128);
  strictObject(policy.body ?? {}, ['maxBytes', 'requiredTrailers', 'pattern'], 'body');
  if (policy.body?.pattern) compileCommitPattern(policy.body.pattern);
  if (policy.body?.maxBytes != null && (!Number.isSafeInteger(policy.body.maxBytes) || policy.body.maxBytes < 1 || policy.body.maxBytes > 65536)) rcpFailure('RCP_POLICY_INVALID', 'body.maxBytes must be between 1 and 65536.');
  if (policy.body?.requiredTrailers != null && (!Array.isArray(policy.body.requiredTrailers) || policy.body.requiredTrailers.length > 128)) rcpFailure('RCP_POLICY_INVALID', 'requiredTrailers must be a bounded array.');
  for (const trailer of policy.body?.requiredTrailers ?? []) text(trailer, 'required trailer', 128);
  strictObject(policy.signing ?? {}, ['required'], 'signing');
  if (policy.signing?.required != null && typeof policy.signing.required !== 'boolean') rcpFailure('RCP_POLICY_INVALID', 'signing.required must be boolean.');
  if (policy.outgoingRange != null) enumeration(policy.outgoingRange, ['latest', 'new-commits'], 'outgoingRange');
  strictObject(policy.metadata ?? {}, ['mode', 'profile', 'refs', 'paths', 'purposes', 'requireBranchAgreement'], 'metadata');
  enumeration(policy.metadata?.mode ?? 'same-policy', ['same-policy', 'scoped-profile'], 'metadata.mode');
  for (const listName of ['refs', 'purposes']) if (policy.metadata?.[listName] != null) list(policy.metadata[listName], `metadata.${listName}`);
  if (policy.metadata?.paths != null) {
    if (!Array.isArray(policy.metadata.paths) || policy.metadata.paths.length > 128 || new Set(policy.metadata.paths).size !== policy.metadata.paths.length) rcpFailure('RCP_POLICY_INVALID', 'metadata.paths must be a bounded array of distinct repository paths.');
    policy.metadata.paths.forEach(policyPath);
  }
  if (policy.metadata?.mode === 'scoped-profile' && (!policy.metadata.profile || !policy.metadata.refs?.length || !policy.metadata.paths?.length || !policy.metadata.purposes?.length)) rcpFailure('RCP_POLICY_INVALID', 'A metadata profile requires explicit profile, refs, paths and purposes.');
  if (policy.metadata?.requireBranchAgreement != null && (typeof policy.metadata.requireBranchAgreement !== 'boolean' || policy.metadata.mode !== 'scoped-profile')) rcpFailure('RCP_POLICY_INVALID', 'A metadata branch exception requires an explicit scoped profile and boolean requireBranchAgreement.');
  if (policy.organizationFloor != null) {
    strictObject(policy.organizationFloor, ['subjectPattern', 'trackingRequired', 'signingRequired', 'requiredCoverage'], 'organizationFloor');
    if (policy.organizationFloor.subjectPattern) compileCommitPattern(policy.organizationFloor.subjectPattern);
    if (policy.organizationFloor.trackingRequired && !policy.tracking.required || policy.organizationFloor.signingRequired && !policy.signing?.required) rcpFailure('RCP_POLICY_CONFLICT', 'Repository policy conflicts with the mandatory organization floor.');
  }
  return policy;
}

export function renderCommitMessage(policy, draft, context) {
  if (typeof draft !== 'string' || draft.includes('\0') || Buffer.byteLength(draft) > 65536) rcpFailure('RCP_MESSAGE_REJECTED', 'The complete proposed commit message is invalid or too large.');
  const [original, ...body] = draft.replace(/\r\n/gu, '\n').split('\n');
  const values = { ...policy.defaults, ...context, summary: context.summary ?? original };
  for (const field of commitTemplateFields(policy.subjectTemplate)) {
    if (typeof values[field] !== 'string' || !values[field].trim() || /[\r\n\u0000]/u.test(values[field])) rcpFailure(field === 'trackingKey' ? 'RCP_TRACKING_KEY_REQUIRED' : 'RCP_MESSAGE_REJECTED', `Commit message requires a valid ${field}.`);
  }
  // A kernel-produced, already compliant header is retained rather than prefixed twice.
  const pieces = policy.subjectTemplate.split('{summary}');
  const substitute = part => part.replace(/\{(trackingKey|type|scope|phase)\}/gu, (_match, key) => values[key]);
  const prefix = substitute(pieces[0]), suffix = substitute(pieces[1]);
  if (policy.subjectPattern && compileCommitPattern(policy.subjectPattern)(original)
      && !original.startsWith(prefix)) rcpFailure('RCP_TRACKING_KEY_MISMATCH', 'A supplied compliant-looking header belongs to different tracking/type/scope context; it cannot be reprefixed.');
  if (context.summary == null && original.startsWith(prefix) && original.endsWith(suffix) && original.length > prefix.length + suffix.length) values.summary = original.slice(prefix.length, suffix ? -suffix.length : undefined);
  const subject = policy.subjectTemplate.replace(/\{([A-Za-z]+)\}/gu, (_match, name) => values[name]);
  const message = [subject, ...body].join('\n');
  validateCommitMessage(policy, message, { ...context, expectedSubject: subject });
  return message;
}

export function validateCommitMessage(policy, message, context = {}) {
  const subject = message.split('\n')[0];
  if (!subject.trim() || /[\r\n\u0000]/u.test(subject) || Buffer.byteLength(subject) > policy.maxSubjectBytes) rcpFailure('RCP_MESSAGE_REJECTED', 'The commit subject is empty, contains control characters or exceeds its UTF-8 byte limit.');
  for (const pattern of [policy.subjectPattern, policy.organizationFloor?.subjectPattern].filter(Boolean)) if (!compileCommitPattern(pattern)(subject)) rcpFailure('RCP_MESSAGE_REJECTED', 'The complete subject does not satisfy the adopted repository grammar.');
  if (context.expectedSubject && subject !== context.expectedSubject) rcpFailure('RCP_TRACKING_KEY_MISMATCH', 'The observed subject differs from its exact canonical tracking/message binding.');
  for (const name of ['type', 'scope']) if (policy[name === 'type' ? 'types' : 'scopes'] && !policy[name === 'type' ? 'types' : 'scopes'].includes(context[name] ?? policy.defaults?.[name])) rcpFailure('RCP_MESSAGE_REJECTED', `The ${name} is not in the adopted allowlist.`);
  if (policy.body?.maxBytes && Buffer.byteLength(message) > policy.body.maxBytes) rcpFailure('RCP_MESSAGE_REJECTED', 'The complete message exceeds its adopted byte limit.');
  for (const name of policy.body?.requiredTrailers ?? []) {
    const lines = message.split('\n').filter(line => line.startsWith(`${name}: `));
    if (lines.length !== 1 || !lines[0].slice(name.length + 2).trim()) rcpFailure('RCP_MESSAGE_REJECTED', `Exactly one ${name} trailer is required.`);
  }
  if (policy.body?.pattern && !compileCommitPattern(policy.body.pattern)(message.slice(subject.length + 1))) rcpFailure('RCP_MESSAGE_REJECTED', 'The message body does not satisfy the adopted grammar.');
  return true;
}
