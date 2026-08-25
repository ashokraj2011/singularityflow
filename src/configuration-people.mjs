/** Publish approval membership to the shared configuration authority without touching a Story checkout. */
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';

import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { normalizeApprovalSecurity } from './approval-authority.mjs';
import {
  CONFIGURATION_BRANCH, resolveConfigurationRemote
} from './configuration-branch.mjs';
import { PORTFOLIO_PATH, validatePortfolio } from './initiative-config.mjs';
import { identity } from './git.mjs';
import { sanitizeRemote } from './git-remote-diagnostics.mjs';
import { createAndPushTransportIntent } from './transport-intents.mjs';
import { removeTemporaryTree, run, SingularityFlowError } from './util.mjs';

const TARGETS = new Set(['*', 'story:*', 'initiative:*']);
const INDIVIDUAL_TARGET = /^(story|initiative):([a-z0-9]+(?:-[a-z0-9]+)*)$/;

function parseDocument(text, label) {
  const document = YAML.parseDocument(text);
  if (document.errors.length) {
    throw new SingularityFlowError(`${label} is not valid YAML: ${document.errors[0].message}`);
  }
  return document;
}

function authorityRows(document, scope) {
  const value = document.toJS()?.approvalAuthorities;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).map(([id, authority]) => ({ id, scope, authority }));
}

function selectedAuthorities(story, initiative, requestedTarget) {
  const target = String(requestedTarget ?? '').trim();
  if (!TARGETS.has(target) && !INDIVIDUAL_TARGET.test(target)) {
    throw new SingularityFlowError(`Unknown approval-group target '${target}'. Refresh People & approvals and choose a current group.`);
  }
  const all = [...story, ...initiative];
  const selected = target === '*'
    ? all
    : target === 'story:*'
      ? story
      : target === 'initiative:*'
        ? initiative
        : all.filter((entry) => `${entry.scope}:${entry.id}` === target);
  if (!selected.length) {
    throw new SingularityFlowError('The selected approval-group scope has no groups in the approved configuration.');
  }
  return selected;
}

function normalizedMember(actor) {
  return {
    name: String(actor?.name ?? '').trim() || null,
    email: String(actor?.email ?? '').trim().toLowerCase() || null,
    githubLogin: String(actor?.login ?? '').trim() || null
  };
}

function mergeMember(members, actor, scope) {
  const normalized = normalizedMember(actor);
  if (scope === 'initiative' && !normalized.email) {
    throw new SingularityFlowError('Initiative approval groups require git user.email. Configure the repository Git email and try again.');
  }
  if (!normalized.email && !normalized.githubLogin) {
    throw new SingularityFlowError('Approval membership requires git user.email or an authenticated GitHub login.');
  }
  const email = normalized.email?.toLowerCase();
  const login = normalized.githubLogin?.toLowerCase();
  const rows = Array.isArray(members) ? structuredClone(members) : [];
  const index = rows.findIndex((entry) => (
    email && String(entry?.email ?? '').trim().toLowerCase() === email
  ) || (
    scope === 'story' && login
      && String(entry?.githubLogin ?? entry?.login ?? '').trim().toLowerCase() === login
  ));
  const candidate = scope === 'initiative'
    ? { name: normalized.name || normalized.email, email: normalized.email }
    : {
      ...(normalized.name ? { name: normalized.name } : {}),
      ...(normalized.email ? { email: normalized.email } : {}),
      ...(normalized.githubLogin ? { githubLogin: normalized.githubLogin } : {})
    };
  if (index < 0) return { members: [...rows, candidate], changed: true };
  const existing = rows[index];
  const merged = scope === 'initiative'
    ? {
      ...existing,
      name: String(existing?.name ?? '').trim() || candidate.name,
      email: String(existing?.email ?? '').trim().toLowerCase() || candidate.email
    }
    : {
      ...existing,
      ...(String(existing?.name ?? '').trim() ? {} : candidate.name ? { name: candidate.name } : {}),
      ...(String(existing?.email ?? '').trim() ? {} : candidate.email ? { email: candidate.email } : {}),
      ...(String(existing?.githubLogin ?? '').trim() ? {} : candidate.githubLogin
        ? { githubLogin: candidate.githubLogin } : {})
    };
  if (JSON.stringify(existing) === JSON.stringify(merged)) return { members: rows, changed: false };
  rows[index] = merged;
  return { members: rows, changed: true };
}

function configurationRemoteName(root, remoteUrl) {
  const names = run('git', ['remote'], { cwd: root }).stdout.trim().split('\n').filter(Boolean);
  const matching = names.find((name) => {
    const url = run('git', ['remote', 'get-url', name], { cwd: root, allowFailure: true }).stdout.trim();
    return url && sanitizeRemote(url) === sanitizeRemote(remoteUrl);
  });
  if (matching) return matching;
  const name = 'sflow-configuration';
  const existing = run('git', ['remote', 'get-url', name], { cwd: root, allowFailure: true }).stdout.trim();
  if (existing && sanitizeRemote(existing) !== sanitizeRemote(remoteUrl)) {
    throw new SingularityFlowError(`Git remote '${name}' already points somewhere other than the approved configuration authority.`);
  }
  if (!existing) run('git', ['remote', 'add', name, remoteUrl], { cwd: root });
  return name;
}

/**
 * Add the caller's current Git identity to approved authority groups and publish one exact commit.
 *
 * The approved branch is cloned into scratch. The caller's index, worktree, HEAD and Story snapshot
 * are never edited; only a durable retention ref and, when required, a configuration remote are
 * added to `.git` so a failed push remains recoverable through `singularity-flow push`.
 */
export async function publishCurrentIdentityToConfiguration(root, {
  target = '*', solo = false, allowSelfApproval = null,
  autoEnrollNewIdentities = null, automatic = false, transport = {}
} = {}) {
  for (const [name, value] of Object.entries({ allowSelfApproval, autoEnrollNewIdentities })) {
    if (value != null && typeof value !== 'boolean') {
      throw new SingularityFlowError(`${name} must be boolean when supplied.`);
    }
  }
  const actor = identity(root);
  const member = normalizedMember(actor);
  const remoteUrl = await resolveConfigurationRemote(root);
  if (!remoteUrl) {
    throw new SingularityFlowError(
      `No approved '${CONFIGURATION_BRANCH}' branch is available. Initialize or refresh the workspace configuration authority first.`
    );
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-configuration-people-'));
  try {
    const clone = run('git', [
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--branch', CONFIGURATION_BRANCH, remoteUrl, scratch
    ], { allowFailure: true });
    if (clone.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read approved configuration: ${(clone.stderr || clone.stdout).trim().split('\n')[0]}`
      );
    }
    const previousCommit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch }).stdout.trim();
    const workflowText = await readFile(path.join(scratch, WORKFLOW_PATH), 'utf8').catch(() => null);
    if (workflowText == null) throw new SingularityFlowError(`${CONFIGURATION_BRANCH} does not contain ${WORKFLOW_PATH}.`);
    const workflow = parseDocument(workflowText, WORKFLOW_PATH);
    const currentSecurity = normalizeApprovalSecurity(workflow.toJS()?.approvalSecurity ?? {});
    if (automatic && !currentSecurity.autoEnrollNewIdentities) {
      return {
        changed: false, pushed: false, branch: CONFIGURATION_BRANCH, commit: previousCommit,
        identity: member, groups: [], profile: currentSecurity.profile,
        approvalSecurity: currentSecurity, automatic: true, skipped: 'automatic-enrollment-disabled'
      };
    }
    if (!member.email && !member.githubLogin) {
      throw new SingularityFlowError('No usable Git email or authenticated GitHub login was resolved. Configure git user.email and try again.');
    }
    const portfolioText = await readFile(path.join(scratch, PORTFOLIO_PATH), 'utf8').catch(() => null);
    const portfolio = portfolioText == null ? null : parseDocument(portfolioText, PORTFOLIO_PATH);
    const story = authorityRows(workflow, 'story');
    const initiative = portfolio ? authorityRows(portfolio, 'initiative') : [];
    const selected = selectedAuthorities(story, initiative, target);
    const changedGroups = [];

    for (const entry of selected) {
      const document = entry.scope === 'story' ? workflow : portfolio;
      const merged = mergeMember(entry.authority?.members, actor, entry.scope);
      if (!merged.changed) continue;
      document.setIn(['approvalAuthorities', entry.id, 'members'], merged.members);
      changedGroups.push({ id: entry.id, scope: entry.scope });
    }
    const previousProfile = currentSecurity.profile;
    const profileChanged = solo && previousProfile !== 'poc';
    if (profileChanged) workflow.setIn(['approvalSecurity', 'profile'], 'poc');
    const desiredSelfApproval = allowSelfApproval == null
      ? (solo ? true : null)
      : Boolean(allowSelfApproval);
    const desiredAutoEnrollment = autoEnrollNewIdentities == null
      ? null
      : Boolean(autoEnrollNewIdentities);
    const selfApprovalChanged = desiredSelfApproval != null
      && workflow.getIn(['approvalSecurity', 'allowSelfApproval']) !== desiredSelfApproval;
    const autoEnrollmentChanged = desiredAutoEnrollment != null
      && workflow.getIn(['approvalSecurity', 'autoEnrollNewIdentities']) !== desiredAutoEnrollment;
    if (selfApprovalChanged) {
      workflow.setIn(['approvalSecurity', 'allowSelfApproval'], desiredSelfApproval);
    }
    if (autoEnrollmentChanged) {
      workflow.setIn(['approvalSecurity', 'autoEnrollNewIdentities'], desiredAutoEnrollment);
    }
    if (!changedGroups.length && !profileChanged && !selfApprovalChanged && !autoEnrollmentChanged) {
      return {
        changed: false, pushed: false, branch: CONFIGURATION_BRANCH, commit: previousCommit,
        identity: member, groups: selected.map(({ id, scope }) => ({ id, scope })),
        profile: previousProfile, approvalSecurity: currentSecurity, automatic: Boolean(automatic)
      };
    }

    const nextWorkflow = String(workflow);
    validateDefinition(YAML.parse(nextWorkflow));
    await writeFile(path.join(scratch, WORKFLOW_PATH), nextWorkflow);
    const files = [WORKFLOW_PATH];
    if (portfolio && changedGroups.some((entry) => entry.scope === 'initiative')) {
      const nextPortfolio = String(portfolio);
      validatePortfolio(YAML.parse(nextPortfolio));
      await writeFile(path.join(scratch, PORTFOLIO_PATH), nextPortfolio);
      files.push(PORTFOLIO_PATH);
    }
    run('git', ['add', '--', ...files], { cwd: scratch });
    run('git', [
      '-c', `user.name=${member.name || 'Singularity Flow contributor'}`,
      '-c', `user.email=${member.email || 'unknown@invalid'}`,
      'commit', '-m', `[configuration] add ${member.email || member.githubLogin} to approval authorities`
    ], { cwd: scratch });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch }).stdout.trim();

    const retained = run('git', ['fetch', '--no-tags', '--', scratch, commit], {
      cwd: root, allowFailure: true
    });
    if (retained.status !== 0) {
      throw new SingularityFlowError('The approved configuration commit could not be retained for recoverable publication.');
    }
    run('git', ['update-ref', `refs/singularity/transport/configuration/${commit}`, commit], { cwd: root });
    const remote = configurationRemoteName(root, remoteUrl);
    const publication = await createAndPushTransportIntent({
      repositoryRoot: root,
      remote,
      sourceCommit: commit,
      targetRef: `refs/heads/${CONFIGURATION_BRANCH}`,
      expectedRemote: previousCommit,
      scope: {
        operation: 'sflow.configuration.people.add-current-identity',
        target,
        groups: changedGroups,
        solo: Boolean(solo),
        allowSelfApproval: desiredSelfApproval,
        autoEnrollNewIdentities: desiredAutoEnrollment,
        automatic: Boolean(automatic)
      }
    }, transport);
    return {
      changed: true,
      pushed: publication.status === 'succeeded',
      branch: CONFIGURATION_BRANCH,
      commit,
      identity: member,
      groups: changedGroups,
      profile: profileChanged ? 'poc' : previousProfile,
      approvalSecurity: normalizeApprovalSecurity(workflow.toJS()?.approvalSecurity ?? {}),
      automatic: Boolean(automatic),
      transportIntent: publication.intentId,
      transportStatus: publication.status,
      nextAction: publication.nextAction ?? null
    };
  } finally {
    await removeTemporaryTree(scratch);
  }
}
