import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { run, commandExists, exists, SingularityFlowError } from './util.mjs';
import { githubAuthStatus } from './github-evidence.mjs';
import { defaultBranchName } from './git.mjs';
import { recap } from './narration/recap.mjs';

// Where the story's pull request goes. Materialization records the branch the story was cut from;
// for a story in the epic's own repository that is the epic branch, so the pull request targets the
// epic branch and the epic lands on the default branch once every blocking story has merged.
export function pullRequestTarget(workflow, seed = null, { root = null, config = {} } = {}) {
  const base = seed?.story?.parentBranch
    ?? workflow.workItem.baseBranch
    ?? (root ? defaultBranchName(root, config) : config.defaultBaseBranch ?? 'main');
  return { base, head: workflow.workItem.branch ?? workflow.workItem.id };
}

function bulleted(values, empty) {
  const items = (values ?? []).filter(Boolean);
  return items.length ? items.map((item) => `- ${item}`).join('\n') : `_${empty}_`;
}

// A pull-request body assembled entirely from committed, governed state: the epic and story
// identity, the acceptance criteria, and every approved artifact with the exact hash it was
// approved at. Nothing here is invented.
export function storyPullRequestBody(workflow, seed = null, { mergeSequence = null, evidenceReceipt = null } = {}) {
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

  // How the work actually went, from the same normalized beats the CLI recap reads. Rendered with a
  // pinned locale and timezone so two people generating this body from the same history get the
  // same bytes — a reviewer comparing it against the branch must not find drift that is only
  // formatting. The phase table above says where the Story ended; this says how it got there.
  const account = recap(workflow, { locale: 'en-GB', timeZone: 'UTC', length: 'brief' });
  if (account) lines.push('### How this Story got here', '', '```', account, '```', '');

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

  if (evidenceReceipt) {
    const value = (entry) => entry == null ? 'unavailable' : String(entry);
    lines.push('### Submission evidence receipt', '');
    lines.push(`- Phase: \`${evidenceReceipt.work.phase}\` generation ${evidenceReceipt.work.generation}`);
    lines.push(`- Source: \`${evidenceReceipt.source.commit}\``);
    lines.push(`- Changed paths: **${value(evidenceReceipt.changes.count)}** (${evidenceReceipt.changes.status})`);
    lines.push(`- Requirements: **${value(evidenceReceipt.requirements.claimed)}/${value(evidenceReceipt.requirements.clauses)}** (${evidenceReceipt.requirements.status})`);
    lines.push(`- Checks: **${evidenceReceipt.checks.passed} passed**, **${evidenceReceipt.checks.failed} failed**, **${evidenceReceipt.checks.unavailable} unavailable**`);
    lines.push(`- Approvals: **${evidenceReceipt.approvals.current}/${evidenceReceipt.approvals.required}**`);
    lines.push(`- Review packet: \`${evidenceReceipt.reviewPacket.sha256}\``);
    lines.push(`- Receipt: \`${evidenceReceipt.receiptSha256}\``, '');
  }

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

// The final Epic pull request is equally deterministic. It contains no generated prose: its title,
// lifecycle state, Story merge sequence, and blockers all come from committed initiative state and
// live Git ancestry observations.
export function epicPullRequestBody(initiative, mergeSequence) {
  const id = initiative.initiative.id;
  const lines = [
    `## ${id} — ${initiative.initiative.title}`,
    '',
    '### Initiative',
    '',
    `- Profile: \`${initiative.initiative.profile}\``,
    `- Status: **${initiative.status}**`,
    `- Epic branch: \`${mergeSequence.epicBranch}\``,
    '',
    '### Story delivery',
    ''
  ];
  lines.push(...mergeSequence.stories.map((story) => {
    const blockers = [...new Set([...(story.blockedBy ?? []), ...(story.mergeBlockedBy ?? [])])];
    return `- ${story.workId ?? story.id}: **${story.status}**${story.blocking ? ' · blocking' : ''}${blockers.length ? ` · waits for ${blockers.join(', ')}` : ''}`;
  }));
  lines.push('', '### Landing readiness', '');
  lines.push(mergeSequence.epicReady
    ? '- Every blocking Story has merged into the Epic branch.'
    : `- Not ready: ${(mergeSequence.outstanding ?? []).join(', ') || 'blocking Story state is incomplete'}.`);
  if (mergeSequence.unreachable?.length) {
    lines.push(`- Unreachable Story branches: ${mergeSequence.unreachable.join(', ')}.`);
  }
  lines.push('', '---', '', 'Generated deterministically by Singularity Flow from committed Initiative state and observed Git ancestry.');
  return lines.join('\n');
}

export async function readStorySeed(root, workflow) {
  const relative = workflow.source?.seed ?? path.posix.join('singularity', 'seeds', `${workflow.workItem.id}.yml`);
  const absolute = path.join(root, relative);
  if (!(await exists(absolute))) return null;
  try { return YAML.parse(await readFile(absolute, 'utf8')); }
  catch { throw new SingularityFlowError(`Story seed ${relative} is not valid YAML.`); }
}

export function storyLifecycleBlockers(workflow) {
  const blockers = [];
  if (workflow.status !== 'complete' || workflow.currentPhase != null) {
    const current = workflow.currentPhase ? ` at ${workflow.currentPhase}` : '';
    blockers.push(`${workflow.workItem.id} workflow is ${workflow.status}${current}`);
  }
  for (const phaseId of workflow.phaseOrder ?? []) {
    const phase = workflow.phases?.[phaseId];
    if (phase?.status !== 'approved') blockers.push(`${phaseId} is ${phase?.status ?? 'missing'}`);
  }
  return [...new Set(blockers)];
}

// Build the complete pull request without contacting GitHub. Always safe to run.
export async function storyPullRequestPlan(root, config, workflow, { mergeSequence = null } = {}) {
  const seed = await readStorySeed(root, workflow);
  const { base, head } = pullRequestTarget(workflow, seed, { root, config });
  const policy = seed?.story?.branchCompletionPolicy ?? workflow.source?.branchCompletionPolicy ?? 'pr';
  if (policy === 'direct') {
    throw new SingularityFlowError(`Repository policy for ${workflow.workItem.id} is 'direct'; it does not use pull requests.`);
  }
  if (base === head) throw new SingularityFlowError(`Pull request base and head are both '${base}'.`);
  let evidenceReceipt = null;
  if (workflow.lineage?.submissions?.length) {
    try {
      const [{ readStoryReviewPacket }, { composeEvidenceReceipt }] = await Promise.all([
        import('./story-lineage.mjs'), import('./evidence-receipt.mjs')
      ]);
      evidenceReceipt = await composeEvidenceReceipt(
        root, config, workflow, await readStoryReviewPacket(root, config, workflow)
      );
    } catch {
      // A malformed or unavailable packet remains a blocker elsewhere. PR preview must not invent
      // evidence or hide the lifecycle state it can still render.
      evidenceReceipt = null;
    }
  }
  return {
    workId: workflow.workItem.id,
    base,
    head,
    policy,
    title: `${workflow.workItem.id}: ${workflow.workItem.title}`,
    body: storyPullRequestBody(workflow, seed, { mergeSequence, evidenceReceipt }),
    evidenceReceipt,
    requiredChecks: seed?.story?.requiredChecks ?? [],
    blockedBy: (() => {
      const blockers = storyLifecycleBlockers(workflow);
      const entry = mergeSequence?.stories?.find((item) => item.workId === workflow.workItem.id || item.id === workflow.workItem.id);
      if (!entry) return blockers;
      blockers.push(...(entry.blockedBy ?? []), ...(entry.mergeBlockedBy ?? []));
      if (!['ready', 'merged'].includes(entry.status)) blockers.push(`${workflow.workItem.id} workflow is ${entry.status}`);
      return [...new Set(blockers)];
    })()
  };
}

export function epicPullRequestPlan(root, config, initiative, mergeSequence) {
  const subjectId = initiative.initiative.id;
  const base = defaultBranchName(root, config);
  const head = initiative.initiative.branch ?? subjectId;
  if (base === head) throw new SingularityFlowError(`Pull request base and head are both '${base}'.`);
  const blockedBy = [
    ...(mergeSequence.epicReady ? [] : (mergeSequence.outstanding ?? [])),
    ...(mergeSequence.unreachable ?? []).map((id) => `${id} is unreachable`)
  ];
  return {
    subjectKind: 'Epic',
    subjectId,
    workId: subjectId,
    base,
    head,
    policy: 'pr',
    title: `${subjectId}: ${initiative.initiative.title}`,
    body: epicPullRequestBody(initiative, mergeSequence),
    requiredChecks: [],
    blockedBy: [...new Set(blockedBy)]
  };
}

// Create the pull request. Outward action: callers must obtain explicit confirmation first.
export function createPullRequest(root, plan, { remote = 'origin', runCommand = run } = {}) {
  if ((plan.blockedBy ?? []).length) {
    throw new SingularityFlowError(`${plan.subjectId ?? plan.workId} cannot open a pull request yet: ${plan.blockedBy.join(', ')} must merge or otherwise become ready first.`);
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

export function createStoryPullRequest(root, plan, options = {}) {
  return createPullRequest(root, plan, options);
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
