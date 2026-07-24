import { createHash } from 'node:crypto';
import path from 'node:path';
import { branch, identity } from './git.mjs';
import { run, commandExists, nowIso, SingularityFlowError, writeJson } from './util.mjs';
import {
  commitAndPublish, saveWorkflow, workflowPublicationBranch, workDir
} from './state.mjs';
import { readStoryReviewPacket } from './story-lineage.mjs';
import { runGovernanceGate } from './governance.mjs';

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

export function githubAuthStatus(root, remote, { runCommand = run } = {}) {
  if (runCommand === run && !commandExists('gh')) throw new SingularityFlowError('GitHub review requires the GitHub CLI. Install gh and run gh auth login.');
  const target = parseGitHubRemote(remote);
  const result = runCommand('gh', ['auth', 'status', '--hostname', target.host], { cwd: root, allowFailure: true });
  if (result.status !== 0) throw new SingularityFlowError(`GitHub CLI is not authenticated for ${target.host}. Run gh auth login --hostname ${target.host}.`);
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

function origin(root, runCommand = run) {
  const result = runCommand('git', ['remote', 'get-url', 'origin'], { cwd: root, allowFailure: true });
  if (result.status !== 0 || !result.stdout.trim()) throw new SingularityFlowError('The Story repository has no origin remote.');
  return result.stdout.trim();
}

export async function runAndRecordStoryChecks(root, config, workflow, {
  packetSha256 = null,
  requiredChecks = null,
  runCommand = run
} = {}) {
  const packet = await readStoryReviewPacket(root, config, workflow, packetSha256);
  const seedChecks = workflow.lineage?.requiredChecks ?? [];
  const required = requiredChecks ?? seedChecks;
  const github = collectGitHubEvidence(root, {
    remote: origin(root, runCommand),
    commit: packet.sourceCommit ?? packet.submissionCommit,
    submittedBranch: packet.submittedBranch,
    canonicalBranch: packet.canonicalBranch,
    requiredChecks: required,
    runCommand
  });
  const gate = await runGovernanceGate(root, config, workflow, { terminal: false });
  const base = {
    schemaVersion: 1,
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
      phaseStatus: workflow.phases.conformance?.status ?? null,
      treeSha256: workflow.phases.conformance?.conformanceTree ?? null,
      fresh: workflow.phases.conformance?.conformanceTree === packet.sourceTreeSha256
    },
    actor: identity(root),
    recordedAt: nowIso()
  };
  const evidenceSha256 = hash(base);
  const evidence = { ...base, evidenceSha256, ready: github.ready && base.governance.valid && (base.conformance.phaseStatus == null || base.conformance.fresh) };
  const file = path.join(workDir(root, config, workflow.workItem.id), 'evidence', 'github', `${evidenceSha256}.json`);
  await writeJson(file, evidence);
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
  await saveWorkflow(root, config, workflow);
  const publication = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][checks] ${packet.packetSha256.slice(0, 12)}`, [path.relative(root, file)]);
  return { evidence, publication, branch: workflowPublicationBranch(root, workflow) };
}
