/**
 * `singularity-flow apm policy init` [APM A5, 2026-10-30]: the organisation's APM policy, which every
 * `apm install` reads before it writes anything and `apm audit --ci` checks on every pull request.
 *
 * APM looks for `apm-policy.yml` at the root of the organisation's `.github-private`, `.github`,
 * `.apm` or `_apm` repository, found from each project's Git remote. SFlow writes one that allows the
 * packages of your marketplaces (`dependencies.allow`, matched against each package's source without
 * its host, such as `acme/team-catalog/plugins/reviewer`), checks it with APM's own
 * `apm policy status --check`, and commits it on `apm/policy-init` for review. Nothing is pushed.
 */
import { lstat, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { captureApm, requireApmCli } from './apm-install.mjs';
import { remoteRepository, requireCleanBranch, targetBranch } from './apm-marketplace.mjs';
import { add, changedPaths, checkout, commit, remoteUrl } from './git.mjs';
import { SingularityFlowError } from './util.mjs';

export const APM_POLICY_INIT_RESULT = 'sflow-apm-policy-init';
export const APM_POLICY_FILE = 'apm-policy.yml';
// Where APM looks for an organisation's policy, in its order.
export const POLICY_REPOSITORIES = Object.freeze(['.github-private', '.github', '.apm', '_apm']);
const ENFORCEMENT = Object.freeze(['block', 'warn']);
const PATTERN = /^[A-Za-z0-9._*-]+(?:\/[A-Za-z0-9._*-]+)+$/u;
const MARKETPLACE = /^(?:[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/)?([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/u;

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

/** `owner/repo/**` for a marketplace named `owner/repo` or `host/owner/repo`: APM matches without the host. */
export function marketplaceAllowPattern(value) {
  const match = MARKETPLACE.exec(String(value ?? '').trim().replace(/\.git$/u, ''));
  if (!match) fail(`--marketplace takes the marketplace repository as owner/repository (or host/owner/repository): '${value ?? ''}'.`, 'APM_POLICY_INVALID', { value });
  return `${match[1]}/**`;
}

function allowPattern(value) {
  const pattern = String(value ?? '').trim();
  if (!PATTERN.test(pattern) || pattern.length > 256) {
    fail(`--allow takes a package pattern such as acme/** or acme/team-catalog/**: '${value ?? ''}'.`, 'APM_POLICY_INVALID', { value });
  }
  return pattern;
}

/** The policy file's text: what it allows, and how strictly APM applies it. */
export function policyText({ name, allow, enforcement }) {
  const body = YAML.stringify({ name, version: '1.0.0', enforcement, dependencies: { allow } }, { lineWidth: 0 });
  return [
    '# The organisation\'s APM policy, written by singularity-flow apm policy init. Every apm install in the',
    '# organisation reads it before writing anything, and apm audit --ci checks it on every pull request.',
    '# dependencies.allow matches each package\'s source without its host; anything else is refused.',
    body
  ].join('\n');
}

/**
 * Write the organisation's policy in the checkout at `root`, check it with APM, and commit it on
 * `apm/policy-init`. `capture` runs the APM CLI and reads its JSON; tests inject it.
 */
export async function initApmPolicy(root, {
  name = null, marketplaces = [], allow = [], enforcement = 'block', dryRun = false, capture = captureApm, cliVersion = undefined
} = {}) {
  if (!ENFORCEMENT.includes(enforcement)) fail(`--enforcement is block or warn: '${enforcement}'.`, 'APM_POLICY_INVALID', { enforcement });
  const patterns = [...new Set([...marketplaces.map(marketplaceAllowPattern), ...allow.map(allowPattern)])];
  if (!patterns.length) {
    fail('Name what the organisation allows: --marketplace <owner/repository> for your marketplace, or --allow <pattern>. An empty allow list refuses every package.',
      'APM_POLICY_INVALID');
  }
  if (await lstat(path.join(root, APM_POLICY_FILE)).catch(() => null)) {
    fail(`${APM_POLICY_FILE} is already here; change it in its own pull request.`, 'APM_POLICY_EXISTS');
  }
  const repository = remoteRepository(remoteUrl(root));
  const owner = repository?.split('/').at(-2) ?? null;
  const label = String(name ?? '').replace(/\s+/gu, ' ').trim() || (owner ? `${owner} agent packages` : 'Agent packages');
  const discovered = repository ? POLICY_REPOSITORIES.includes(repository.split('/').at(-1)) : false;
  const { found } = await requireApmCli(root, cliVersion);
  const current = requireCleanBranch(root, 'this checkout');
  const branch = targetBranch(root, current, 'apm/policy-init');
  const text = policyText({ name: label, allow: patterns, enforcement });
  const notes = discovered ? [] : [
    `APM finds an organisation's policy only in its ${POLICY_REPOSITORIES.join(', ')} repository; ${repository ? `${repository} is not one of them, so` : 'from anywhere else'} a project names it with apm audit --ci --policy <owner>/<repository>.`
  ];
  const base = {
    schemaVersion: 1, resultType: APM_POLICY_INIT_RESULT, name: label, enforcement, allow: patterns, apmVersion: found,
    repository, discovered, branch, from: current, file: APM_POLICY_FILE, notes
  };
  if (dryRun) return { ...base, dryRun: true, committed: false, text };

  const file = path.join(root, APM_POLICY_FILE);
  await writeFile(file, text);
  // APM's own reading of the file decides whether it is a policy, not SFlow's.
  const checked = capture(root, ['policy', 'status', '--policy-source', `./${APM_POLICY_FILE}`, '--check', '-o', 'json']);
  let report = null;
  try { report = JSON.parse(checked.stdout); } catch { report = null; }
  if (report?.outcome !== 'found' || report.error) {
    await rm(file, { force: true });
    fail(`APM does not accept the policy: ${report?.error ?? (checked.stderr.trim().split('\n').at(-1) || `exit ${checked.status}`)}. Nothing was written.`,
      'APM_POLICY_INVALID', { outcome: report?.outcome ?? null });
  }
  const changed = changedPaths(root, ['.']);
  if (branch !== current) await checkout(root, branch, { base: current });
  add(root, changed);
  const sha = commit(root, [
    `Start the organisation's APM policy: ${label}`,
    '',
    `Allows ${patterns.join(', ')}; enforcement ${enforcement}. apm policy status --check (apm ${found}) accepts it.`
  ].join('\n'), changed);
  return {
    ...base, dryRun: false, committed: true, commit: sha, createdBranch: branch !== current, changed,
    warnings: Array.isArray(report.warnings) ? report.warnings.map(String) : [],
    nextActions: [
      { command: `git push -u origin ${branch}`, why: 'Send the branch.' },
      { command: 'gh pr create --fill', why: 'Open the pull request your organisation\'s owners approve.' },
      { command: 'singularity-flow apm install <PACKAGE>', why: 'Once it is merged, every install in the organisation applies it.' }
    ]
  };
}
