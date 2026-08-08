import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { run, commandExists, exists, SingularityFlowError } from './util.mjs';
import { githubAuthStatus } from './github-evidence.mjs';

// Where the story's pull request goes. Materialization records the branch the story was cut from;
// for a story in the epic's own repository that is the epic branch, so the pull request targets the
// epic branch and the epic lands on the default branch once every blocking story has merged.
export function pullRequestTarget(workflow, seed = null) {
  const base = seed?.story?.parentBranch
    ?? workflow.workItem.baseBranch
    ?? 'main';
  return { base, head: workflow.workItem.branch ?? workflow.workItem.id };
}

function bulleted(values, empty) {
  const items = (values ?? []).filter(Boolean);
  return items.length ? items.map((item) => `- ${item}`).join('\n') : `_${empty}_`;
}

// A pull-request body assembled entirely from committed, governed state: the epic and story
// identity, the acceptance criteria, and every approved artifact with the exact hash it was
// approved at. Nothing here is invented.
export function storyPullRequestBody(workflow, seed = null, { mergeSequence = null } = {}) {
  const story = seed?.story ?? {};
  const initiative = seed?.initiative ?? {};
  const lines = [];

  lines.push(`## ${workflow.workItem.id} — ${workflow.workItem.title}`, '');
  if (story.description) lines.push(story.description, '');

  lines.push('### Lineage', '');
  if (initiative.id) lines.push(`- Epic: \`${initiative.id}\`${story.epicJiraKey ? ` (Jira ${story.epicJiraKey})` : ''}`);
  if (initiative.branch) lines.push(`- Epic branch: \`${initiative.branch}\``);
  if (story.jiraKey) lines.push(`- Story: Jira ${story.jiraKey}`);
  if (story.parentBranch) lines.push(`- Branched from: \`${story.parentBranch}\`${story.baseCommit ? ` at \`${story.baseCommit.slice(0, 8)}\`` : ''}`);
  lines.push(`- Work type: \`${workflow.workItem.workType}\``, '');

  lines.push('### Lifecycle status', '');
  lines.push(...(workflow.phaseOrder ?? []).map((phaseId) => {
    const phase = workflow.phases[phaseId];
    const approvals = (phase.approvals ?? []).filter((item) => !item.invalidatedAt && item.decision === 'approved');
    return `- ${phase.label ?? phase.id}: **${phase.status}** · generation ${phase.generation ?? 0} · ${approvals.length} approval${approvals.length === 1 ? '' : 's'}`;
  }), '');

  lines.push('### Acceptance criteria', '', bulleted(story.acceptanceCriteria, 'None recorded in the story seed.'), '');

  const artifacts = seed?.approvedArtifacts ?? [];
  lines.push('### Approved epic artifacts', '');
  lines.push(artifacts.length
    ? artifacts.map((item) => `- \`${item.path}\` — ${item.phase}/${item.output} @ \`${String(item.sha256).slice(0, 12)}\``).join('\n')
    : '_No approved epic artifacts were recorded._');
  lines.push('');

  const checks = story.requiredChecks ?? [];
  if (checks.length) lines.push('### Required checks', '', bulleted(checks, ''), '');

  const claims = [...new Set((workflow.phaseOrder ?? []).flatMap((phaseId) => workflow.phases?.[phaseId]?.claims ?? []))];
  if (claims.length) lines.push('### Specification claims', '', bulleted(claims, ''), '');

  const warnings = [];
  const selfApprovals = (workflow.phaseOrder ?? []).flatMap((phaseId) => (workflow.phases?.[phaseId]?.approvals ?? [])
    .filter((item) => !item.invalidatedAt && item.selfApproval)
    .map(() => `${phaseId} contains self-approval; it is valid but not independent review.`));
  warnings.push(...selfApprovals);
  if (workflow.publication?.status === 'pending') warnings.push('Publication is pending synchronization with the remote.');
  if (warnings.length) lines.push('### Governance warnings', '', bulleted(warnings, ''), '');

  lines.push('### Worldline', '', `- Story: \`${workflow.workItem.id}\` at \`${workflow.source?.commit ?? workflow.workItem.sourceCommit ?? 'unavailable'}\``);
  lines.push(`- Workflow state: \`${workflow.workItem.branch ?? workflow.workItem.id}:singularity/work-items/${workflow.workItem.id}/workflow.json\``, '');

  if (mergeSequence) {
    const entry = mergeSequence.stories?.find((item) => item.workId === workflow.workItem.id || item.id === workflow.workItem.id);
    if (entry) {
      lines.push('### Merge sequence', '');
      lines.push(`- Position ${entry.order} of ${mergeSequence.stories.length}${entry.blocking ? ' (blocking)' : ''}`);
      if (entry.blockedBy?.length) lines.push(`- Blocked by: ${entry.blockedBy.join(', ')}`);
      if (entry.mergeBlockedBy?.length) lines.push(`- Earlier stack entries still outstanding: ${entry.mergeBlockedBy.join(', ')}`);
      if (entry.status) lines.push(`- Stack status: ${entry.status}`);
      lines.push('');
    }
  }

  lines.push('---', '', 'Editable draft generated deterministically by Singularity Flow from committed workflow state. This description is not a governed lifecycle artifact.');
  return lines.join('\n');
}

export async function readStorySeed(root, workflow) {
  const relative = workflow.source?.seed ?? path.posix.join('singularity', 'seeds', `${workflow.workItem.id}.yml`);
  const absolute = path.join(root, relative);
  if (!(await exists(absolute))) return null;
  try { return YAML.parse(await readFile(absolute, 'utf8')); }
  catch { throw new SingularityFlowError(`Story seed ${relative} is not valid YAML.`); }
}

// Build the complete pull request without contacting GitHub. Always safe to run.
export async function storyPullRequestPlan(root, config, workflow, { mergeSequence = null } = {}) {
  const seed = await readStorySeed(root, workflow);
  const { base, head } = pullRequestTarget(workflow, seed);
  const policy = seed?.story?.branchCompletionPolicy ?? workflow.source?.branchCompletionPolicy ?? 'pr';
  if (policy === 'direct') {
    throw new SingularityFlowError(`Repository policy for ${workflow.workItem.id} is 'direct'; it does not use pull requests.`);
  }
  if (base === head) throw new SingularityFlowError(`Pull request base and head are both '${base}'.`);
  return {
    workId: workflow.workItem.id,
    base,
    head,
    policy,
    title: `${workflow.workItem.id}: ${workflow.workItem.title}`,
    body: storyPullRequestBody(workflow, seed, { mergeSequence }),
    requiredChecks: seed?.story?.requiredChecks ?? [],
    blockedBy: (() => {
      const entry = mergeSequence?.stories?.find((item) => item.workId === workflow.workItem.id || item.id === workflow.workItem.id);
      if (!entry) return [];
      const blockers = [...new Set([...(entry.blockedBy ?? []), ...(entry.mergeBlockedBy ?? [])])];
      if (!['ready', 'merged'].includes(entry.status)) blockers.push(`${workflow.workItem.id} workflow is ${entry.status}`);
      return blockers;
    })()
  };
}

// Create the pull request. Outward action: callers must obtain explicit confirmation first.
export function createStoryPullRequest(root, plan, { remote = 'origin', runCommand = run } = {}) {
  if (plan.blockedBy.length) {
    throw new SingularityFlowError(`${plan.workId} cannot open a pull request yet: ${plan.blockedBy.join(', ')} must merge or otherwise become ready first.`);
  }
  if (runCommand === run && !commandExists('gh')) {
    throw new SingularityFlowError('Opening a pull request requires the GitHub CLI. Install gh and run gh auth login, or open the pull request manually using the generated body.');
  }
  const url = runCommand('git', ['remote', 'get-url', remote], { cwd: root, allowFailure: true });
  if (url.status !== 0) throw new SingularityFlowError(`Remote '${remote}' is not configured.`);
  githubAuthStatus(root, url.stdout.trim(), { runCommand });

  const existing = runCommand('gh', ['pr', 'list', '--head', plan.head, '--base', plan.base, '--json', 'url', '--jq', '.[0].url'], { cwd: root, allowFailure: true });
  if (existing.status === 0 && existing.stdout.trim()) {
    return { status: 'existing', url: existing.stdout.trim(), base: plan.base, head: plan.head };
  }
  const created = runCommand('gh', ['pr', 'create', '--base', plan.base, '--head', plan.head, '--title', plan.title, '--body', plan.body], { cwd: root, allowFailure: true });
  if (created.status !== 0) throw new SingularityFlowError(`Unable to open the pull request: ${(created.stderr || created.stdout).trim()}`);
  return { status: 'created', url: created.stdout.trim().split(/\s+/).pop(), base: plan.base, head: plan.head };
}

// Update is deliberately separate from creation: `pr describe --write` can never create a PR.
export function updateStoryPullRequest(root, plan, { runCommand = run } = {}) {
  if (runCommand === run && !commandExists('gh')) {
    return { status: 'unavailable', reason: 'GitHub CLI is not installed.', body: plan.body };
  }
  const existing = runCommand('gh', ['pr', 'list', '--head', plan.head, '--base', plan.base, '--json', 'number,url', '--jq', '.[0]'], { cwd: root, allowFailure: true });
  if (existing.status !== 0 || !existing.stdout.trim()) {
    return { status: 'unavailable', reason: 'No existing pull request targets this branch.', body: plan.body };
  }
  let record;
  try { record = JSON.parse(existing.stdout.trim()); }
  catch { return { status: 'unavailable', reason: 'The existing pull request could not be identified.', body: plan.body }; }
  const updated = runCommand('gh', ['pr', 'edit', String(record.number), '--body', plan.body], { cwd: root, allowFailure: true });
  if (updated.status !== 0) return { status: 'unavailable', reason: (updated.stderr || updated.stdout).trim(), body: plan.body };
  return { status: 'updated', url: record.url, number: record.number };
}
