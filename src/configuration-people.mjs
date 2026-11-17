import { repositoryCommitPolicyModule } from './util.mjs';
/** Publish approval membership to the shared configuration authority without touching a Story checkout. */
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';

import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { normalizeApprovalSecurity } from './approval-authority.mjs';
import {
  CONFIGURATION_BRANCH, configurationBranchHead, resolveConfigurationRemote,
  takeStoryConfigurationCheckout, captureEnrolledConfigurationSnapshot, withRetainedConfigurationSnapshot
} from './configuration-branch.mjs';
import { PORTFOLIO_PATH, validatePortfolio } from './initiative-config.mjs';
import { configurationCommitIdentity, identity } from './git.mjs';
import { assertCredentialFreeRemote, sanitizeRemote, frozenRemoteTransport, failureEvidence, safeGitDiagnosticReference } from './git-remote-diagnostics.mjs';
import { gitDisabledHooksPath } from './platform-process.mjs';
import { createAndPushTransportIntent } from './transport-intents.mjs';
import { gitReadOutput, removeTemporaryTree, run, SingularityFlowError } from './util.mjs';
import { configurationProposerKey } from './configuration-state-contract.mjs';
import { canonicalJson } from './records.mjs';
import { GitRemoteSession, gitCommonDir } from './git-execution.mjs';
import { renderPreservingFormatting } from './yaml-formatting.mjs';

const TARGETS = new Set(['*', 'story:*', 'initiative:*']);
const PEOPLE_PREFIX = 'sflow/config-change/people/';

/** This person's people proposal of `label` still waiting on the authority, or null [SCF:REQ-012]. */
async function waitingPeopleProposal(remoteUrl, label, key, session) {
  const observed = await session.observeAsync(remoteUrl, { refs: [`refs/heads/${PEOPLE_PREFIX}*`], includeHead: false, refresh: true });
  if (!observed?.ok) return null;
  const pattern = new RegExp(`^refs/heads/${PEOPLE_PREFIX}${label}-${key}-[0-9a-f]{8}-[0-9a-f]{12}$`, 'u');
  const found = [...observed.refs].find(([ref]) => pattern.test(ref));
  return found ? { branch: found[0].slice('refs/heads/'.length), commit: found[1] } : null;
}
const ENROLLMENT_SNAPSHOTS = new WeakMap();

/** Machine-local handoff; never serialized into the public enrollment result. */
export function enrolledConfigurationAuthority(result, authority) {
  return withRetainedConfigurationSnapshot(authority, ENROLLMENT_SNAPSHOTS.get(result));
}
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

/**
 * A configured remote's URL, '' when Git says there is no such remote, or a refusal otherwise.
 *
 * An empty URL decides that no existing remote names the approved authority and that a new one is
 * added, so a URL Git failed to read must not look like a remote that does not exist.
 */
function configuredRemoteUrl(root, name) {
  return gitReadOutput(run('git', ['remote', 'get-url', name], { cwd: root, allowFailure: true }),
    `Git remote '${name}'`, { absentStatus: 2 })?.trim() ?? '';
}

function configurationRemoteName(root, remoteUrl) {
  const remoteIdentity = assertCredentialFreeRemote(remoteUrl);
  const names = run('git', ['remote'], { cwd: root }).stdout.trim().split('\n').filter(Boolean);
  const matching = names.find((name) => {
    const url = configuredRemoteUrl(root, name);
    if (!url) return false;
    try { return assertCredentialFreeRemote(url) === remoteIdentity; }
    catch { return false; }
  });
  if (matching) return matching;
  const name = 'sflow-configuration';
  const existing = configuredRemoteUrl(root, name);
  let existingIdentity = null;
  try { existingIdentity = existing ? assertCredentialFreeRemote(existing) : null; }
  catch { /* an unsafe existing remote never matches approved authority */ }
  if (existing && existingIdentity !== remoteIdentity) {
    throw new SingularityFlowError(`Git remote '${name}' already points somewhere other than the approved configuration authority.`);
  }
  if (!existing) run('git', ['remote', 'add', name, remoteUrl], { cwd: root });
  return name;
}

function snapshotDocument(snapshot, relative, label) {
  const entry = snapshot?.assets?.find((candidate) => candidate.relative === relative);
  if (!entry) return null;
  if (createHash('sha256').update(entry.contents).digest('hex') !== entry.sha256) {
    throw new SingularityFlowError(
      `Verified Story configuration snapshot changed in memory: ${relative}.`,
      { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' }
    );
  }
  return parseDocument(Buffer.from(entry.contents).toString('utf8'), label);
}

/** Return the existing result when the verified snapshot proves enrollment is already a no-op. */
function snapshotEnrollmentResult(snapshot, actor, member, {
  target, solo, allowSelfApproval, autoEnrollNewIdentities, automatic
}) {
  if (!snapshot?.assets || !snapshot?.sourceCommit) return null;
  const workflow = snapshotDocument(snapshot, WORKFLOW_PATH, WORKFLOW_PATH);
  if (!workflow) return null;
  const currentSecurity = normalizeApprovalSecurity(workflow.toJS()?.approvalSecurity ?? {});
  if (automatic && !currentSecurity.autoEnrollNewIdentities) {
    return {
      changed: false, pushed: false, branch: CONFIGURATION_BRANCH, commit: snapshot.sourceCommit,
      identity: member, groups: [], profile: currentSecurity.profile,
      approvalSecurity: currentSecurity, automatic: true, skipped: 'automatic-enrollment-disabled'
    };
  }
  if (!member.email && !member.githubLogin) {
    throw new SingularityFlowError(
      'No usable Git email or authenticated GitHub login was resolved. Configure git user.email and try again.'
    );
  }
  const portfolio = snapshotDocument(snapshot, PORTFOLIO_PATH, PORTFOLIO_PATH);
  const selected = selectedAuthorities(
    authorityRows(workflow, 'story'), portfolio ? authorityRows(portfolio, 'initiative') : [], target
  );
  const membershipChanged = selected.some((entry) =>
    mergeMember(entry.authority?.members, actor, entry.scope).changed);
  const desiredSelfApproval = allowSelfApproval == null ? (solo ? true : null) : Boolean(allowSelfApproval);
  const desiredAutoEnrollment = autoEnrollNewIdentities == null ? null : Boolean(autoEnrollNewIdentities);
  const settingsChanged = (solo && currentSecurity.profile !== 'poc')
    || (desiredSelfApproval != null
      && workflow.getIn(['approvalSecurity', 'allowSelfApproval']) !== desiredSelfApproval)
    || (desiredAutoEnrollment != null
      && workflow.getIn(['approvalSecurity', 'autoEnrollNewIdentities']) !== desiredAutoEnrollment);
  if (membershipChanged || settingsChanged) return null;
  return {
    changed: false, pushed: false, branch: CONFIGURATION_BRANCH, commit: snapshot.sourceCommit,
    identity: member, groups: selected.map(({ id, scope }) => ({ id, scope })),
    profile: currentSecurity.profile, approvalSecurity: currentSecurity,
    automatic: Boolean(automatic), source: 'verified-configuration-snapshot'
  };
}

/**
 * Whether Story start's automatic enrollment could publish a membership commit for this identity.
 *
 * Answered from the verified snapshot alone, exactly as enrollment's own no-op path decides it. Story
 * start uses it to skip work whose only purpose is to refuse before such a commit exists.
 */
export function automaticEnrollmentMayPublish(root, configurationSnapshot) {
  const actor = identity(root);
  try {
    return snapshotEnrollmentResult(configurationSnapshot, actor, normalizedMember(actor), {
      target: '*', solo: false, allowSelfApproval: null, autoEnrollNewIdentities: null, automatic: true
    }) === null;
  } catch {
    // Enrollment itself reports an unusable identity. Until then, assume it could publish.
    return true;
  }
}

/** The repository's main checkout when `root` is a linked worktree of it, else `root` itself. */
function durableCheckout(root) {
  try {
    const common = gitCommonDir(root);
    const main = path.basename(common) === '.git' ? path.dirname(common) : null;
    return main && existsSync(common) && existsSync(main) ? main : root;
  } catch {
    return root;
  }
}

/**
 * What a Story start says when its automatic approval enrollment did not land on `sflow/config`. The Story
 * starts anyway with the approved configuration it inspected. Either the enrollment waits as a people
 * proposal for someone who may approve it [SCF:REQ-012], or Git refused the push: this names Git's reason
 * and its fix, and the retry that publishes the retained commit once that is fixed. A branch that moved
 * meanwhile cannot take this commit: the next Story start enrolls again.
 */
export function enrollmentPendingNotice(enrollment) {
  const fault = enrollment?.fault ?? null;
  const diverged = enrollment?.transportStatus === 'remote-diverged' || fault?.classification === 'remote-diverged';
  const retry = enrollment?.transportIntent && !diverged ? `singularity-flow sync ${enrollment.transportIntent}` : null;
  const proposal = enrollment?.proposed && enrollment?.proposal?.branch ? enrollment.proposal : null;
  if (proposal && !fault) {
    const why = enrollment.removalCheck === 'unknown'
      ? ` SFlow could not read ${CONFIGURATION_BRANCH}'s history to check that no approved change removed you, so you cannot approve it yourself.`
      : enrollment.approvalSecurity?.allowSelfApproval === false
        ? ' This repository needs another person to approve configuration changes.' : '';
    const command = `singularity-flow configuration approve ${proposal.branch}`;
    return {
      message: `Your Git identity waits for approval as people proposal ${proposal.branch}; until someone approves it, approvals need someone already in the groups.${why} Someone who may approve configuration runs: ${command}.`,
      intentId: enrollment?.transportIntent ?? null, status: enrollment?.transportStatus ?? null, classification: null,
      proposal: proposal.branch,
      nextAction: { command: 'singularity-flow configuration proposals', label: 'See the proposal waiting for approval', skill: '/sf-configuration' }
    };
  }
  const reason = diverged
    ? ` ${CONFIGURATION_BRANCH} moved before the push landed, so the next Story start adds you again.`
    : fault?.classification === 'git-identity-required'
      ? ' A configuration commit names who made it, and Git has no user.name and user.email for you: set them '
        + '(git config --global user.name <NAME>, git config --global user.email <EMAIL>), and the next Story start adds you.'
    : fault ? ` Git refused the push${proposal ? ` of people proposal ${proposal.branch}` : ` to ${CONFIGURATION_BRANCH}`}${fault.classification ? ` (${fault.classification})` : ''}`
      + `${fault.evidence?.diagnostic?.trim() ? `: "${fault.evidence.diagnostic.trim()}"` : ''}.${fault.advice ? ` ${fault.advice}` : ''}` : '';
  const then = retry ? ` ${fault ? 'After fixing that, run' : 'Run'}: ${retry}.` : '';
  return {
    message: `Your Git identity was not added to the approval groups on ${CONFIGURATION_BRANCH}; until it is, approvals need someone already in them.${reason}${then}`,
    intentId: enrollment?.transportIntent ?? null, status: enrollment?.transportStatus ?? null,
    classification: fault?.classification ?? null,
    nextAction: retry ? { command: retry, skill: '/sf-push' } : null
  };
}

/**
 * Add the caller's current Git identity to approved authority groups and publish one exact commit.
 *
 * The approved branch is projected into scratch. The caller's index, worktree, HEAD and Story snapshot
 * are never edited; only a durable retention ref and, when required, a configuration remote are
 * added to `.git` so a failed push remains recoverable through `singularity-flow push`.
 */
export async function publishCurrentIdentityToConfiguration(root, {
  target = '*', solo = false, allowSelfApproval = null,
  autoEnrollNewIdentities = null, automatic = false, transport = {},
  configurationSnapshot = null, expectedSourceCommit = null, session = null
} = {}) {
  for (const [name, value] of Object.entries({ allowSelfApproval, autoEnrollNewIdentities })) {
    if (value != null && typeof value !== 'boolean') {
      throw new SingularityFlowError(`${name} must be boolean when supplied.`);
    }
  }
  const actor = identity(root);
  const member = normalizedMember(actor);
  // Who the configuration commit names, from the person's own checkout and Git configuration before the isolated
  // clone below (SCF:REQ-018): never the OS login or a placeholder address.
  let author = null, authorRequired = null;
  try { author = configurationCommitIdentity(root); } catch (error) {
    if (error?.code !== 'GIT_COMMIT_IDENTITY_REQUIRED') throw error;
    authorRequired = error;
  }
  if (expectedSourceCommit != null) {
    if (!/^[0-9a-f]{40,64}$/u.test(String(expectedSourceCommit))) {
      throw new SingularityFlowError('Expected configuration source commit must be one exact Git commit.');
    }
    if (configurationSnapshot?.sourceCommit !== expectedSourceCommit) {
      throw new SingularityFlowError(
        'The expected configuration source commit does not match the verified Story snapshot.',
        { code: 'STORY_CONFIGURATION_AUTHORITY_STALE' }
      );
    }
  }
  const snapshotResult = snapshotEnrollmentResult(configurationSnapshot, actor, member, {
    target, solo, allowSelfApproval, autoEnrollNewIdentities, automatic
  });
  // Ordinary configuration UI calls retain the no-network no-op fast path. Story start supplies an
  // expected source commit: it must compare the live authority even when the frozen snapshot says
  // no edit is needed, otherwise a concurrent policy advance can be silently ignored.
  if (snapshotResult && expectedSourceCommit == null) return snapshotResult;
  // Resolution already makes a fresh exact-ref observation. Keep its per-invocation session so
  // the no-op comparison can use that same authority result instead of another network round trip.
  // Story start passes the session that made its own fresh pre-enrollment observation of this
  // authority, so resolution and comparison both answer from that one look.
  const remoteSession = session ?? new GitRemoteSession({ cwd: root });
  const remoteUrl = await resolveConfigurationRemote(root, 'origin', { session: remoteSession });
  if (!remoteUrl) {
    throw new SingularityFlowError(
      `No approved '${CONFIGURATION_BRANCH}' branch is available. Initialize or refresh the workspace configuration authority first.`
    );
  }

  if (snapshotResult) {
    // Story start must recheck the live authority after intake, but a verified no-op needs only
    // its exact ref, not another transfer and checkout of every configuration asset. The fresh
    // resolution above rejects symbolic/malformed refs and transport failures; no local tracking
    // ref or earlier snapshot is allowed to stand in for the current remote tip.
    const head = await configurationBranchHead(remoteUrl, { session: remoteSession });
    if (!head.reachable) {
      throw new SingularityFlowError(
        `Cannot read approved configuration: ${head.error}`,
        { code: head.observation?.failure?.code ?? 'REMOTE_UNKNOWN' }
      );
    }
    if (head.sha !== expectedSourceCommit) {
      throw new SingularityFlowError(
        'Approved configuration changed after Story choices were frozen. Refresh Story intake and retry; no enrollment was published.',
        {
          code: 'STORY_CONFIGURATION_AUTHORITY_STALE',
          details: { selectedCommit: expectedSourceCommit, currentCommit: head.sha }
        }
      );
    }
    return {
      ...snapshotResult,
      commit: head.sha,
      source: 'verified-current-configuration-snapshot'
    };
  }

  const reused = await takeStoryConfigurationCheckout(configurationSnapshot, remoteUrl, expectedSourceCommit);
  const scratch = reused ?? await mkdtemp(path.join(os.tmpdir(), 'sflow-configuration-people-'));
  try {
    // No clone (SDA-AC-013): the authority's tip is fetched into the repository's object store, from
    // the checkout that outlives a Story, and projected from those exact objects.
    if (!reused) {
      const { fetchConfigurationBase, createConfigurationProjection } = await import('./configuration-projection.mjs');
      const transport = frozenRemoteTransport(remoteUrl);
      const base = await fetchConfigurationBase(durableCheckout(root), transport,
        { branch: CONFIGURATION_BRANCH });
      if (!base.commit) {
        const failed = base.failure;
        throw new SingularityFlowError(
          `Cannot read approved configuration: ${failed?.failure?.advice ?? safeGitDiagnosticReference(failed)}`,
          { code: failed?.failure?.code ?? 'CONFIGURATION_PROJECTION_BASE_UNAVAILABLE', details: { evidence: failureEvidence(failed), classification: failed?.failure?.classification ?? 'unknown' } }
        );
      }
      await createConfigurationProjection(durableCheckout(root), scratch, base.commit,
        { branch: CONFIGURATION_BRANCH, env: transport.env, transport, config: { 'core.autocrlf': 'false' } });
    }
    const previousCommit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch }).stdout.trim();
    if (expectedSourceCommit != null && previousCommit !== expectedSourceCommit) {
      throw new SingularityFlowError(
        'Approved configuration changed after Story choices were frozen. Refresh Story intake and retry; no enrollment was published.',
        {
          code: 'STORY_CONFIGURATION_AUTHORITY_STALE',
          details: { selectedCommit: expectedSourceCommit, currentCommit: previousCommit }
        }
      );
    }
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
    // A group a reviewed change removed this person from is one they are never added back to by their own
    // approval [SCF:REQ-012, finding ER-F3]. Story start leaves those groups alone; an explicit request still
    // proposes, for someone else to approve. The groups they would join are read from sflow/config's history.
    // Read only when someone would join a group, so Story start's eager graph does not carry the history reader.
    const { listsMember, removedApprovalMemberships } = await import('./configuration-people-history.mjs');
    const joining = selected.filter((entry) => mergeMember(entry.authority?.members, actor, entry.scope).changed
      && !listsMember(entry.authority?.members, member, entry.scope));
    const removal = joining.length
      ? removedApprovalMemberships(scratch, previousCommit, member, joining.map(({ id, scope }) => ({ id, scope })))
      : { status: 'known', removed: [] };
    const removedKeys = new Set((removal.removed ?? []).map((entry) => `${entry.scope}:${entry.id}`));
    const keptOut = [];

    for (const entry of selected) {
      const document = entry.scope === 'story' ? workflow : portfolio;
      const merged = mergeMember(entry.authority?.members, actor, entry.scope);
      if (!merged.changed) continue;
      if (automatic && removedKeys.has(`${entry.scope}:${entry.id}`)) { keptOut.push({ id: entry.id, scope: entry.scope }); continue; }
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
    // Never self-approval off with nobody else named (review 11-17).
    if (selfApprovalChanged && desiredSelfApproval === false) {
      (await import('./configuration-approvers.mjs')).refuseLastApprover(workflow.toJS(), portfolio?.toJS(), [member, author]);
    }
    if (!changedGroups.length && !profileChanged && !selfApprovalChanged && !autoEnrollmentChanged) {
      return {
        changed: false, pushed: false, branch: CONFIGURATION_BRANCH, commit: previousCommit,
        identity: member, groups: selected.map(({ id, scope }) => ({ id, scope })),
        profile: previousProfile, approvalSecurity: currentSecurity, automatic: Boolean(automatic),
        ...(keptOut.length ? { keptOut, keptOutReason: 'removed-by-approved-change' } : {})
      };
    }

    // People maintain these files by hand: only the membership and policy lines change.
    const nextWorkflow = renderPreservingFormatting(workflowText, workflow);
    validateDefinition(YAML.parse(nextWorkflow));
    await writeFile(path.join(scratch, WORKFLOW_PATH), nextWorkflow);
    const files = [WORKFLOW_PATH];
    if (portfolio && changedGroups.some((entry) => entry.scope === 'initiative')) {
      const nextPortfolio = renderPreservingFormatting(portfolioText, portfolio);
      validatePortfolio(YAML.parse(nextPortfolio));
      await writeFile(path.join(scratch, PORTFOLIO_PATH), nextPortfolio);
      files.push(PORTFOLIO_PATH);
    }
    run('git', ['add', '--', ...files], { cwd: scratch });
    // The typed intent (SDA M3): which groups gained this person and which policy fields changed.
    const intent = { kind: 'approval-membership', operations: [
      ...changedGroups.map(({ id, scope }) => ({ op: 'member.add', scope, group: id,
        member: { email: member.email ?? null, githubLogin: member.githubLogin ?? null } })),
      ...(profileChanged ? [{ op: 'approval-security.set', field: 'profile', value: 'poc' }] : []),
      ...(selfApprovalChanged ? [{ op: 'approval-security.set', field: 'allowSelfApproval', value: desiredSelfApproval }] : []),
      ...(autoEnrollmentChanged ? [{ op: 'approval-security.set', field: 'autoEnrollNewIdentities', value: desiredAutoEnrollment }] : [])
    ] };
    const intentSha256 = `sha256:${createHash('sha256').update(canonicalJson(intent)).digest('hex')}`;
    if (authorRequired) {
      if (!automatic) throw authorRequired;
      // A Story starts without the person in the approval groups, as it does when Git refuses the push.
      return {
        changed: true, pushed: false, branch: CONFIGURATION_BRANCH, commit: previousCommit, identity: member,
        groups: changedGroups, profile: previousProfile, approvalSecurity: currentSecurity, automatic: true,
        transportIntent: null, transportStatus: null,
        fault: { classification: 'git-identity-required', advice: authorRequired.message },
        nextAction: authorRequired.details?.nextAction ?? null
      };
    }
    await (await repositoryCommitPolicyModule('writer', scratch)).runPolicyCommit(scratch, [
      '-c', `core.hooksPath=${gitDisabledHooksPath()}`,
      '-c', `user.name=${author.name}`,
      '-c', `user.email=${author.email}`,
      'commit', '-m', `[configuration] add ${member.email || member.githubLogin} to approval authorities`,
      '-m', `Sflow-Intent-Kind: ${intent.kind}\nSflow-Intent-Sha256: ${intentSha256}`
    ], {
      env: process.env, legacyRun: (argv, opts) => run('git', argv, {...opts, cwd: scratch})
    });
    const proposalCommit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch }).stdout.trim();
    // The index is the commit just made, so writing it names the commit's tree without another read.
    const proposalTree = run('git', ['write-tree'], { cwd: scratch }).stdout.trim();
    // Every people or policy edit is a people proposal [SCF:REQ-012]. At Story start, where the repository
    // allows self-approval and the person was never removed from these groups, the starter approves their
    // own enrollment in the same step [D5]: one approval commit records them as proposer and approver.
    // Otherwise the proposal waits for someone who may approve it, and the Story starts without them.
    const policyEdit = profileChanged || selfApprovalChanged || autoEnrollmentChanged;
    const inline = Boolean(automatic) && !policyEdit && currentSecurity.allowSelfApproval && removal.status === 'known';
    const label = automatic ? 'enroll' : policyEdit ? 'approval-policy' : 'add-identity';
    const proposalBranch = `${PEOPLE_PREFIX}${label}-${configurationProposerKey(author)}-${previousCommit.slice(0, 8)}-${proposalTree.slice(0, 12)}`;
    let commit = proposalCommit;
    if (inline) {
      const person = `${author.name} <${author.email}>`;
      const approvalMessage = `[configuration] approve people proposal ${proposalBranch}\n\n`
        + `Proposed-by: ${person}\nApproved-by: ${person}\nSelf-approved: yes\nSflow-Approved-At: story-start\n`;
      commit = run('git', ['commit-tree', proposalTree, '-p', previousCommit, '-p', proposalCommit, '-F', '-'], {
        cwd: scratch, input: approvalMessage,
        env: { ...process.env, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email }
      }).stdout.trim();
      run('git', ['update-ref', 'HEAD', commit, proposalCommit], { cwd: scratch });
    } else if (automatic) {
      // One waiting enrollment per person: a later Story start does not propose it again.
      const waiting = await waitingPeopleProposal(remoteUrl, label, configurationProposerKey(author), remoteSession);
      if (waiting) {
        return {
          changed: true, pushed: false, proposed: true, selfApproved: false, branch: CONFIGURATION_BRANCH, commit: previousCommit,
          identity: member, groups: changedGroups, profile: previousProfile, approvalSecurity: currentSecurity, automatic: true,
          proposal: { branch: waiting.branch, commit: waiting.commit, existing: true }, removalCheck: removal.status,
          ...(keptOut.length ? { keptOut, keptOutReason: 'removed-by-approved-change' } : {}),
          transportIntent: null, transportStatus: 'succeeded-existing', fault: null, nextAction: null
        };
      }
    }

    // A Story starts in its own checkout, which a failed start removes. Retain and push the commit
    // from the repository's main checkout, which outlives it, so a later `sync <INTENT-ID>` can still run.
    const publisher = durableCheckout(root);
    const retained = run('git', ['fetch', '--no-tags', '--', scratch, commit], {
      cwd: publisher, allowFailure: true
    });
    if (retained.status !== 0) {
      throw new SingularityFlowError('The approved configuration commit could not be retained for recoverable publication.');
    }
    run('git', ['update-ref', `refs/singularity/transport/configuration/${commit}`, commit], { cwd: publisher });
    const remote = configurationRemoteName(publisher, remoteUrl);
    const publication = await createAndPushTransportIntent({
      repositoryRoot: publisher,
      remote,
      sourceCommit: commit,
      // The approval lands on sflow/config; a proposal is a new branch of its own, created only if absent.
      targetRef: inline ? `refs/heads/${CONFIGURATION_BRANCH}` : `refs/heads/${proposalBranch}`,
      expectedRemote: inline ? previousCommit : null,
      scope: {
        operation: 'sflow.configuration.people.add-current-identity',
        target,
        groups: changedGroups,
        solo: Boolean(solo),
        allowSelfApproval: desiredSelfApproval,
        autoEnrollNewIdentities: desiredAutoEnrollment,
        automatic: Boolean(automatic),
        proposal: proposalBranch,
        selfApproved: inline
      }
    }, transport);
    const succeeded = publication.status === 'succeeded';
    const result = {
      changed: true,
      // Whether sflow/config now lists them: only an approval lands there.
      pushed: inline && succeeded,
      proposed: !inline,
      selfApproved: inline,
      branch: CONFIGURATION_BRANCH,
      commit,
      identity: member,
      groups: changedGroups,
      profile: profileChanged ? 'poc' : previousProfile,
      approvalSecurity: normalizeApprovalSecurity(workflow.toJS()?.approvalSecurity ?? {}),
      automatic: Boolean(automatic),
      proposal: { branch: proposalBranch, commit: proposalCommit, published: inline ? null : succeeded },
      removalCheck: removal.status,
      ...(keptOut.length ? { keptOut, keptOutReason: 'removed-by-approved-change' } : {}),
      ...(!automatic && removedKeys.size ? { previouslyRemoved: [...removedKeys] } : {}),
      transportIntent: publication.intentId,
      transportStatus: publication.status,
      fault: publication.fault ?? null,
      nextAction: publication.nextAction ?? (!inline && succeeded
        ? { command: `singularity-flow configuration approve ${proposalBranch}`, label: 'Approve the people proposal (someone who may approve configuration)' }
        : null)
    };
    if (result.pushed) {
      const snapshot = await captureEnrolledConfigurationSnapshot(scratch, remoteUrl, previousCommit, commit);
      if (snapshot) ENROLLMENT_SNAPSHOTS.set(result, snapshot);
    }
    return result;
  } finally {
    if (!reused) await removeTemporaryTree(scratch);
  }
}
