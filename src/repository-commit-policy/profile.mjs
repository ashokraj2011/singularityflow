import {readRecord} from '../schema-migrations.mjs';
import { COMMIT_HOOK_STAGES, strictObject, rcpFailure, rcpDigest } from './policy.mjs';

export const REGISTERED_COMMIT_CHECKS = Object.freeze({
  'message-envelope': { stage: 'message', effects: 'none', protocol: 'rcp-exact-message/v1' },
  'no-trailing-whitespace': { stage: 'content', effects: 'none', protocol: 'rcp-exact-tree-blobs/v1' },
  'final-newline': { stage: 'content', effects: 'none', protocol: 'rcp-exact-tree-blobs/v1' },
  'valid-utf8': { stage: 'content', effects: 'none', protocol: 'rcp-exact-tree-blobs/v1' }
});
export const REGISTERED_COMMIT_FORMATTERS = Object.freeze(['trim-trailing-whitespace', 'ensure-final-newline']);
export function policyPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.startsWith('/') || /[\\\u0000-\u001f:*?]/u.test(value)
      || value.split('/').some(part => ['', '.', '..'].includes(part) || part.toLowerCase() === '.git')) rcpFailure('RCP_POLICY_INVALID', 'Policy paths must be exact portable repository-relative files or directories.');
  return value;
}
const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
export function normalizeCommitProfile(value, adapter) {
  strictObject(value, ['schemaVersion', 'adapter', 'platforms', 'coverage', 'inputs', 'checks', 'normalization', 'native'], 'commit profile');
  readRecord('repository-commit-policy-profile', value);
  if (value.adapter !== adapter) rcpFailure('RCP_VALIDATION_UNSUPPORTED', 'The selected immutable profile does not match the required adapter/schema.');
  const profile = structuredClone(value);
  if (!Array.isArray(profile.platforms) || !profile.platforms.length || profile.platforms.some(os => !['darwin', 'win32', 'linux'].includes(os))) rcpFailure('RCP_POLICY_INVALID', 'A profile must declare its supported host platforms.');
  if (!Array.isArray(profile.checks ?? []) || (profile.checks ?? []).length > 32) rcpFailure('RCP_POLICY_INVALID', 'A profile supports at most 32 checks.');
  profile.checks ??= [];
  const identifiers = new Set();
  for (const check of profile.checks) {
    strictObject(check, ['id', 'rule', 'paths'], 'profile check');
    if (typeof check.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(check.id) || identifiers.has(check.id) || !REGISTERED_COMMIT_CHECKS[check.rule]) rcpFailure('RCP_POLICY_INVALID', 'Each check needs a distinct identifier and an installed registered rule.');
    identifiers.add(check.id);
    if (check.paths != null && (!Array.isArray(check.paths) || check.paths.length > 128)) rcpFailure('RCP_POLICY_INVALID', 'Check paths must be a bounded array.');
    for (const path of check.paths ?? []) policyPath(path);
  }
  if (!Array.isArray(profile.coverage) || profile.coverage.length > 128) rcpFailure('RCP_POLICY_INVALID', 'A profile requires explicit bounded validation coverage.');
  for (const entry of profile.coverage) {
    strictObject(entry, ['stage', 'path', 'sha256', 'checks', 'differences'], 'coverage');
    if (![...COMMIT_HOOK_STAGES, 'repository-message', 'repository-content', 'remote-receive', 'ci'].includes(entry.stage)) rcpFailure('RCP_POLICY_INVALID', 'Coverage names an unsupported stage.');
    if ((entry.path == null) !== (entry.sha256 == null) || entry.sha256 != null && !hash(entry.sha256)) rcpFailure('RCP_POLICY_INVALID', 'Hook equivalence must bind its path and exact SHA-256 together.');
    if (entry.path != null && (typeof entry.path !== 'string' || /[\r\n\u0000]/u.test(entry.path))) rcpFailure('RCP_POLICY_INVALID', 'Hook coverage path is invalid.');
    if (!Array.isArray(entry.checks) || entry.checks.some(id => !identifiers.has(id))) rcpFailure('RCP_POLICY_INVALID', 'Coverage must reference the profile’s installed checks.');
    if (adapter === 'registered-checks' && !entry.checks.length && !['post-commit', 'pre-push', 'remote-receive', 'ci'].includes(entry.stage)) rcpFailure('RCP_POLICY_INVALID', 'Pre-commit equivalence requires an actual registered check.');
    if (entry.differences != null && (typeof entry.differences !== 'string' || entry.differences.length > 4096)) rcpFailure('RCP_POLICY_INVALID', 'Equivalence differences must be bounded text.');
  }
  if (!Array.isArray(profile.inputs ?? []) || (profile.inputs ?? []).length > 128) rcpFailure('RCP_POLICY_INVALID', 'Profile inputs must be a bounded array.');
  profile.inputs ??= [];
  for (const input of profile.inputs) {
    strictObject(input, ['path', 'sha256'], 'profile input'); policyPath(input.path);
    if (!hash(input.sha256)) rcpFailure('RCP_POLICY_INVALID', 'Every declared dependency/configuration input needs an immutable SHA-256.');
  }
  if (profile.normalization != null) {
    strictObject(profile.normalization, ['maximumChangedAttempts', 'steps'], 'normalization');
    const budget = profile.normalization.maximumChangedAttempts ?? 2;
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > 10 || !Array.isArray(profile.normalization.steps) || profile.normalization.steps.length > 16) rcpFailure('RCP_POLICY_INVALID', 'Normalization requires a finite owner-approved attempt budget and bounded steps.');
    profile.normalization.maximumChangedAttempts = budget;
    for (const step of profile.normalization.steps) {
      strictObject(step, ['rule', 'paths'], 'normalization step');
      if (!REGISTERED_COMMIT_FORMATTERS.includes(step.rule) || !Array.isArray(step.paths) || !step.paths.length || step.paths.length > 128) rcpFailure('RCP_POLICY_INVALID', 'A normalization step requires a registered formatter and exact path scope.');
      step.paths.forEach(policyPath);
    }
  }
  if (adapter === 'native-git') {
    strictObject(profile.native ?? {}, ['context', 'gitDirectory', 'timeoutMs', 'maxOutputBytes', 'maximumObservedFiles', 'maximumObservedBytes', 'messageTransform'], 'native profile');
    if (profile.native.context !== 'original-worktree-private-git' || profile.native.gitDirectory !== 'candidate-compatible') rcpFailure('RCP_VALIDATION_UNSUPPORTED', 'Native validation requires an explicitly compatible private Git directory and the original worktree/branch semantics.');
    for (const [field, fallback, maximum] of [['timeoutMs', 120000, 600000], ['maxOutputBytes', 65536, 1048576], ['maximumObservedFiles', 20000, 100000], ['maximumObservedBytes', 268435456, 1073741824]]) {
      profile.native[field] ??= fallback;
      if (!Number.isSafeInteger(profile.native[field]) || profile.native[field] < 1 || profile.native[field] > maximum) rcpFailure('RCP_POLICY_INVALID', `Native ${field} exceeds its installed bound.`);
    }
    if (profile.native.messageTransform != null) {
      const transform = strictObject(profile.native.messageTransform, ['producer', 'placement', 'delimiter', 'prefix', 'encoding', 'maximumClockSkewSeconds'], 'message transformation');
      if (!['prepare-commit-msg', 'commit-msg'].includes(transform.producer) || !['subject-suffix', 'body-suffix'].includes(transform.placement)
          || transform.encoding !== 'unix-seconds' || typeof transform.delimiter !== 'string' || transform.delimiter.length > 32
          || typeof transform.prefix !== 'string' || !transform.prefix || transform.prefix.length > 128 || /[\r\n\u0000]/u.test(transform.prefix)) rcpFailure('RCP_POLICY_INVALID', 'A managed transformation must declare its actual producer, placement, exact delimiter/prefix and timestamp encoding.');
      if (!Number.isSafeInteger(transform.maximumClockSkewSeconds) || transform.maximumClockSkewSeconds < 0 || transform.maximumClockSkewSeconds > 86400) rcpFailure('RCP_POLICY_INVALID', 'A generated timestamp requires an explicit bounded clock tolerance.');
    }
  } else if (profile.native != null) rcpFailure('RCP_POLICY_INVALID', 'A registered-check profile cannot claim native execution.');
  return Object.freeze({ ...profile, profileSha256: rcpDigest(profile) });
}
