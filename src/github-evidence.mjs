import { conformancePhaseOf } from './kernel/phase-policy.mjs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { branch, identity } from './git.mjs';
import { run, commandExists, nowIso, SingularityFlowError, writeJson } from './util.mjs';
import { workDir } from './story-paths.mjs';
import { commitAndPublish, saveStoryDraft, workflowPublicationBranch } from './state-stores.mjs';
import { readStoryReviewPacket } from './story-lineage.mjs';
import { runGovernanceGate } from './governance.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { classifyGitHost } from './git-host.mjs';

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function parseGitHubRemote(value) {
  const remote = String(value ?? '').trim();
  let host, owner, repository;
  if (/^git@[^:]+:.+/.test(remote)) {
    const matched = remote.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
    if (matched) [, host, owner, repository] = matched;
  } else {
    try {
      const parsed = new URL(remote);
      const pieces = parsed.pathname.replace(/^\/+|\.git$/g, '').split('/');
      if (pieces.length === 2) {
        host = parsed.hostname;
        [owner, repository] = pieces;
      }
    } catch { /* handled below */ }
  }
  if (!host || !owner || !repository) throw new SingularityFlowError(`Remote '${remote}' is not a supported GitHub repository URL.`);
  return { host, owner, repository, slug: `${owner}/${repository}` };
}

function ghJson(root, args, runCommand = run) {
  const result = runCommand('gh', args, { cwd: root, allowFailure: true });
  if (result.status !== 0) throw new SingularityFlowError(`GitHub CLI request failed: ${(result.stderr || result.stdout).trim()}`);
  try { return JSON.parse(result.stdout); } catch { throw new SingularityFlowError('GitHub CLI returned invalid JSON.'); }
}

/**
 * Recent GitHub Actions runs for a repository, read-only. `[INT:IFC-041]` `[INT:CON-094]`
 *
 * The reference build-provider read: `gh run list` and nothing that reruns, cancels, approves or
 * deploys. Authentication stays in gh's own store; nothing here takes or stores a credential.
 */
export function githubActionsRuns(root, remote, { branch = null, commit = null, limit = 30, runCommand = run } = {}) {
  const target = parseGitHubRemote(remote);
  const fields = 'databaseId,headSha,headBranch,workflowName,conclusion,status,createdAt,updatedAt,url,displayTitle,event';
  return ghJson(root, ['run', 'list', '--repo', target.slug, '--limit', String(Math.max(1, Math.min(Number(limit) || 30, 100))),
    '--json', fields, ...(branch ? ['--branch', branch] : []), ...(commit ? ['--commit', commit] : [])], runCommand);
}

/**
 * The real host behind an SSH remote's host alias (`git@github-work:owner/repo`), from `ssh -G`, which
 * applies ~/.ssh/config exactly as Git's own push does. gh cannot sign in to an alias, so the hint
 * `gh auth login --hostname github-work` was a dead end (2026-10-29). Anything else is unchanged.
 */
export function resolveGitHubSshHost(root, remote, target, { runCommand = run } = {}) {
  if (!/^(?:[^@/\s]+@[^:/]+:|ssh:\/\/)/u.test(String(remote ?? '').trim())) return target;
  const result = runCommand('ssh', ['-G', target.host], { cwd: root, allowFailure: true });
  const real = result.status === 0 ? String(result.stdout ?? '').match(/^hostname\s+(\S+)\s*$/mu)?.[1] : null;
  return real && real.toLowerCase() !== target.host.toLowerCase() ? { ...target, host: real, alias: target.host } : target;
}

export function githubAuthStatus(root, remote, { runCommand = run } = {}) {
  if (runCommand === run && !commandExists('gh')) throw new SingularityFlowError('GitHub review requires the GitHub CLI. Install gh and run gh auth login.');
  const target = resolveGitHubSshHost(root, remote, parseGitHubRemote(remote), { runCommand });
  const result = runCommand('gh', ['auth', 'status', '--hostname', target.host], { cwd: root, allowFailure: true });
  if (result.status !== 0) throw new SingularityFlowError(`GitHub CLI is not authenticated for ${target.host}${target.alias ? ` (the SSH alias ${target.alias})` : ''}. Run gh auth login --hostname ${target.host}.`);
  return target;
}

export function collectGitHubEvidence(root, {
  remote,
  commit,
  submittedBranch,
  canonicalBranch,
  requiredChecks = [],
  runCommand = run
} = {}) {
  if (!commit) throw new SingularityFlowError('GitHub evidence requires an exact submitted commit.');
  const target = githubAuthStatus(root, remote, { runCommand });
  const checksPayload = ghJson(root, [
    'api', '--hostname', target.host,
    `repos/${target.slug}/commits/${commit}/check-runs?per_page=100`
  ], runCommand);
  const checkRuns = (checksPayload.check_runs ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    status: item.status,
    conclusion: item.conclusion,
    startedAt: item.started_at ?? null,
    completedAt: item.completed_at ?? null,
    url: item.html_url ?? null,
    app: item.app?.name ?? null,
    headSha: item.head_sha ?? commit
  }));
  const byName = new Map(checkRuns.map((item) => [item.name, item]));
  const required = requiredChecks.map((name) => {
    const check = byName.get(name);
    return {
      name,
      status: !check ? 'missing' : check.status !== 'completed' ? 'pending' : check.conclusion === 'success' ? 'passed' : 'failed',
      conclusion: check?.conclusion ?? null,
      checkId: check?.id ?? null
    };
  });
  let pullRequests = [];
  if (submittedBranch && canonicalBranch && submittedBranch !== canonicalBranch) {
    const query = `repos/${target.slug}/pulls?state=all&head=${encodeURIComponent(`${target.owner}:${submittedBranch}`)}&base=${encodeURIComponent(canonicalBranch)}&per_page=100`;
    pullRequests = ghJson(root, ['api', '--hostname', target.host, query], runCommand).map((item) => ({
      number: item.number,
      state: item.state,
      merged: item.merged_at != null,
      mergedAt: item.merged_at ?? null,
      headSha: item.head?.sha ?? null,
      base: item.base?.ref ?? null,
      url: item.html_url ?? null
    }));
  }
  return {
    provider: 'github-actions',
    repository: target.slug,
    host: target.host,
    commit,
    observedAt: nowIso(),
    checkRuns,
    required,
    pullRequests,
    ready: required.every((entry) => entry.status === 'passed')
  };
}

/**
 * The Story's configured remote URL. A review checkout made by SFlow names its only remote
 * `origin`, whatever the contributor's repository calls it, so that name is the fallback.
 */
export function storyCheckRemote(root, config, runCommand = run) {
  const configured = config?.git?.remote ?? 'origin';
  for (const name of [...new Set([configured, 'origin'])]) {
    const result = runCommand('git', ['remote', 'get-url', name], { cwd: root, allowFailure: true });
    if (result.status === 0 && result.stdout.trim()) return { name, url: result.stdout.trim() };
  }
  throw new SingularityFlowError(`The Story repository has no remote '${configured}'. Configure it (git remote add), then record the checks again.`, {
    code: 'STORY_CHECKS_REMOTE_MISSING', details: { remote: configured }
  });
}

/** Ready evidence for a packet with no required checks: nothing to ask a provider. */
function notRequiredEvidence(host, commit) {
  return {
    provider: 'not-required',
    repository: null,
    host: host.host,
    commit,
    observedAt: nowIso(),
    checkRuns: [],
    required: [],
    pullRequests: [],
    ready: true
  };
}

/**
 * Required checks are read from GitHub only. Another host's pipeline cannot be read here, and a
 * check that cannot be read is never recorded as passed: refuse with the person's route instead.
 */
function unsupportedHostRefusal(workId, host, remote, required, commit) {
  return new SingularityFlowError(
    `Story checks read required checks from GitHub only; remote '${remote}' is ${host.label}${host.host ? ` (${host.host})` : ''}. `
    + `Nothing was recorded, so ${required.join(', ')} still count as not passed for commit ${String(commit ?? '').slice(0, 12)}.`,
    {
      code: 'STORY_CHECKS_HOST_UNSUPPORTED',
      details: {
        workId, provider: host.provider, host: host.host, remote, requiredChecks: required, commit,
        recoveryCommands: [{ command: `singularity-flow pr describe ${workId} --clipboard`,
          label: `Copy the review description to open or update the ${host.label} merge request by hand.` }],
        actions: [{ label: `Confirm ${required.join(', ')} passed for commit ${String(commit ?? '').slice(0, 12)} in ${host.label}'s own pipeline view, and have its required-check rule protect the merge there; the Story's required checks cannot be read from this host.` }]
      }
    }
  );
}

/**
 * The repository-check evidence for one exact commit, routed by host before anything is asked:
 * no required checks needs no provider, GitHub (or a host that may be GitHub Enterprise) is asked
 * through the GitHub CLI, and any other host is refused with its manual route.
 */
export function repositoryCheckEvidence(root, {
  workId, remote, commit, submittedBranch = null, canonicalBranch = null, requiredChecks = [], runCommand = run
} = {}) {
  const host = classifyGitHost(remote.url);
  if (!requiredChecks.length) return notRequiredEvidence(host, commit);
  if (!['github', 'unknown'].includes(host.provider)) {
    throw unsupportedHostRefusal(workId, host, remote.name, requiredChecks, commit);
  }
  return collectGitHubEvidence(root, {
    remote: remote.url, commit, submittedBranch, canonicalBranch, requiredChecks, runCommand
  });
}

export async function runAndRecordStoryChecks(root, config, workflow, {
  packetSha256 = null,
  requiredChecks = null,
  runCommand = run
} = {}) {
  const packet = await readStoryReviewPacket(root, config, workflow, packetSha256);
  const seedChecks = workflow.lineage?.requiredChecks ?? [];
  // Checks named on the command add to the Story's own; they never replace them.
  const required = [...new Set([...seedChecks, ...(requiredChecks ?? [])])];
  const github = repositoryCheckEvidence(root, {
    workId: workflow.workItem.id,
    remote: storyCheckRemote(root, config, runCommand),
    commit: packet.sourceCommit ?? packet.submissionCommit,
    submittedBranch: packet.submittedBranch,
    canonicalBranch: packet.canonicalBranch,
    requiredChecks: required,
    runCommand
  });
  const gate = await runGovernanceGate(root, config, workflow, { terminal: false });
  const base = {
    schemaVersion: currentSchemaVersion('github-review-evidence'),
    workId: workflow.workItem.id,
    epicId: workflow.lineage?.epicId ?? null,
    packetSha256: packet.packetSha256,
    sourceTreeSha256: packet.sourceTreeSha256,
    branch: packet.submittedBranch,
    github,
    governance: {
      valid: gate.errors.length === 0,
      errors: gate.errors,
      warnings: gate.warnings,
      passes: gate.passes
    },
    conformance: {
      phase: conformancePhaseOf(workflow)?.id ?? null,
      phaseStatus: conformancePhaseOf(workflow)?.status ?? null,
      treeSha256: conformancePhaseOf(workflow)?.conformanceTree ?? null,
      fresh: conformancePhaseOf(workflow)?.conformanceTree === packet.sourceTreeSha256
    },
    actor: identity(root),
    recordedAt: nowIso()
  };
  const evidenceSha256 = hash(base);
  const evidence = { ...base, evidenceSha256, ready: github.ready && base.governance.valid && (base.conformance.phaseStatus == null || base.conformance.fresh) };
  const file = path.join(workDir(root, config, workflow.workItem.id), 'evidence', 'github', `${evidenceSha256}.json`);
  workflow.lineage.reviewEvidence ??= [];
  workflow.lineage.reviewEvidence.push({
    evidenceSha256,
    packetSha256: packet.packetSha256,
    branch: branch(root),
    path: path.relative(root, file).split(path.sep).join('/'),
    ready: evidence.ready,
    recordedAt: evidence.recordedAt
  });
  workflow.history.push({
    at: evidence.recordedAt,
    actor: evidence.actor.email?.toLowerCase() ?? evidence.actor.name,
    event: 'story_checks_recorded',
    phase: packet.phase,
    detail: `${packet.packetSha256.slice(0, 12)} ready=${evidence.ready}`
  });
  // Both durable writes run inside the unit. The evidence file and the aggregate that references it
  // used to be written before publication, so a refusal left the recorded checks on disk with no
  // commit — and the aggregate's own rollback snapshot, captured after them, restored the version
  // that already contained them.
  const publication = await commitAndPublish(
    root,
    config,
    workflow,
    { type: LIFECYCLE_EVENT.EVIDENCE_RECORDED, phaseId: packet.phase, payload: { packetSha256: packet.packetSha256, evidenceSha256 } },
    `[${workflow.workItem.id}][checks] ${packet.packetSha256.slice(0, 12)}`,
    [path.relative(root, file)],
    {
      beforeStateWrite: async () => {
        await writeJson(file, evidence);
        await saveStoryDraft(root, config, workflow);
      }
    }
  );
  return { evidence, publication, branch: workflowPublicationBranch(root, workflow) };
}
