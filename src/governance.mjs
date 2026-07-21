import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { approvalPath, currentPhase, validateWorkflow, workDir } from './state.mjs';
import { exists, snapshot, run } from './util.mjs';

function trackedFiles(root) {
  return run('git', ['ls-files', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean);
}

async function verifyGithubCommit(root, relativePath) {
  if (!process.env.GITHUB_REPOSITORY || !process.env.GITHUB_TOKEN) return { warning: `signature check skipped for ${relativePath} (GitHub credentials unavailable)` };
  const sha = run('git', ['log', '-1', '--format=%H', '--', relativePath], { cwd: root }).stdout.trim();
  if (!sha) return { error: `approval has no Git commit: ${relativePath}` };
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/commits/${sha}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
  });
  if (!response.ok) return { error: `could not verify approval commit ${sha.slice(0, 8)} (${response.status})` };
  const commit = await response.json();
  const login = commit.committer?.login ?? '';
  if (commit.commit?.verification?.verified !== true || !/github-actions(?:\[bot\])?/.test(login)) {
    return { error: `approval commit ${sha.slice(0, 8)} is not a verified github-actions commit` };
  }
  return {};
}

function acceptanceIds(text) {
  return [...new Set([...text.matchAll(/\bAC-\d+\b/g)].map((match) => match[0]))];
}

export async function runGovernanceGate(root, config, workflow, { terminal = false } = {}) {
  const errors = [], warnings = [], passes = [];
  const base = await validateWorkflow(root, config, workflow, { strict: true });
  errors.push(...base.errors); warnings.push(...base.warnings);

  const baseRef = workflow.workItem.baseBranch;
  const diff = run('git', ['diff', '--name-only', `${baseRef}...HEAD`], { cwd: root, allowFailure: true });
  if (diff.status === 0) {
    const changed = new Set(diff.stdout.split(/\r?\n/).filter(Boolean));
    for (const protectedPath of config.governance?.protectedPaths ?? []) {
      if (changed.has(protectedPath)) errors.push(`protected process file changed on work branch: ${protectedPath}`);
    }
  } else warnings.push(`could not compare protected process files with base branch ${baseRef}`);

  for (const phaseId of workflow.phaseOrder) {
    const phase = workflow.phases[phaseId];
    if (phase.status !== 'approved') continue;
    const file = approvalPath(root, config, workflow.workItem.id, phaseId);
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (!(await exists(file))) { errors.push(`approved phase ${phaseId} has no approval record`); continue; }
    const approval = JSON.parse(await readFile(file, 'utf8'));
    for (const artifact of approval.artifacts ?? []) {
      const current = await snapshot(path.join(root, artifact.path));
      if (current.exists !== artifact.exists || current.size !== artifact.size || current.sha256 !== artifact.sha256) {
        errors.push(`STALE ${phaseId} approval: ${artifact.path} changed after approval`);
      }
    }
    for (const [priorId, approvedHash] of Object.entries(approval.intakeApprovals ?? {})) {
      const prior = approvalPath(root, config, workflow.workItem.id, priorId);
      const currentHash = (await exists(prior)) ? (await snapshot(prior)).sha256 : null;
      if (currentHash !== approvedHash) errors.push(`CASCADE ${phaseId}: upstream ${priorId} approval changed`);
    }
    if (config.governance?.requireGithubApprovals) {
      if (approval.provenance?.channel !== 'github-pr-comment') errors.push(`${phaseId} approval was not created from an authenticated GitHub PR comment`);
      const allowed = config.governance?.roles?.[phase.owner] ?? [];
      if (!allowed.includes(approval.approvedBy)) errors.push(`${phaseId} approver @${approval.approvedBy} is not authorized for ${phase.owner}`);
      const signature = await verifyGithubCommit(root, relative);
      if (signature.error) errors.push(signature.error);
      if (signature.warning) warnings.push(signature.warning);
    }
    passes.push(`approval integrity: ${phaseId}`);
  }

  if (config.governance?.requireAcceptanceCriteriaTags) {
    const req = path.join(workDir(root, config, workflow.workItem.id), 'artifacts/requirements/requirements.md');
    if (await exists(req)) {
      const ids = acceptanceIds(await readFile(req, 'utf8'));
      const testFiles = trackedFiles(root).filter((file) => /(^|\/)(test|tests|__tests__)(\/|\.|$)|\.(test|spec)\./i.test(file));
      const tags = new Set();
      for (const file of testFiles) {
        const text = await readFile(path.join(root, file), 'utf8').catch(() => '');
        for (const match of text.matchAll(/@ac:\s*(AC-\d+)/g)) tags.add(match[1]);
      }
      if (!ids.length) warnings.push('requirements contain no AC-n identifiers; deterministic AC coverage was not evaluated');
      for (const id of ids) if (!tags.has(id)) errors.push(`AC coverage: ${id} has no test tagged @ac:${id}`);
      if (ids.length && ids.every((id) => tags.has(id))) passes.push(`acceptance coverage: ${ids.length} criteria mapped to tests`);
    }
  }

  if (terminal) {
    for (const phaseId of workflow.phaseOrder) if (workflow.phases[phaseId]?.status !== 'approved') errors.push(`terminal: phase ${phaseId} is not approved`);
    if (workflow.status !== 'complete' || currentPhase(workflow)) errors.push('terminal: workflow is not complete');
    else passes.push('terminal lifecycle');
  }
  return { errors, warnings, passes };
}
