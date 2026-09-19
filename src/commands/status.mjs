import { branch } from '../git.mjs';
import { executeGitQuery } from '../git-query.mjs';
import { ledgerStatus } from '../ledger.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { optionBoolean, SingularityFlowError, table } from '../util.mjs';

function activePhase(workflow) {
  return workflow.currentPhase ? workflow.phases?.[workflow.currentPhase] ?? null : null;
}

function summary(workflow) {
  const active = activePhase(workflow);
  console.log(`\n${workflow.workItem.id} — ${workflow.workItem.title}`);
  console.log(`Branch: ${workflow.workItem.branch}`);
  console.log(`World-model grounding: ${workflow.resolution?.worldModelGrounding ?? 'off'}`);
  console.log(`Status: ${workflow.status}`);
  console.log(`Current phase: ${active ? `${active.id} (${active.status})` : 'complete'}`);
  if (active) {
    console.log(`Governed agent: ${active.defaultAgent ?? 'unassigned'}`);
    console.log(`Required artifact: ${active.requiredArtifact?.path ?? 'none'}`);
    console.log(`Registered artifacts: ${active.artifacts.length}`);
  }
  if (workflow.sequenceOverrides?.length) console.warn(`Warning: ${workflow.sequenceOverrides.length} confirmed soft sequence override(s) are recorded for this work item.`);
}

/**
 * One-spawn, registered branch observation for Story selection.
 *
 * Do not replace this with the general repository facade: status needs only one worktree-local
 * symbolic ref, and paying discovery plus HEAD stability probes was a measured 10x regression.
 */
export async function galStatusBranchCandidate(root, options = {}) {
  return executeGitQuery(root, 'repository.branch', {}, options);
}

export async function galStatusBranch(root, options = {}) {
  const current = await galStatusBranchCandidate(root, options);
  if (!current) throw new SingularityFlowError('Detached HEAD is not supported.');
  return current;
}

/** Resolve the status repository through the same selector-safe registered boundary. */
export function galStatusRepositoryRoot(cwd = process.cwd(), options = {}) {
  const root = executeGitQuery(cwd, 'repository.root', {}, options);
  if (!root) {
    throw new SingularityFlowError('Run Singularity Flow from inside a Git repository.');
  }
  return root;
}

/** Complete repository/branch selection used by the status command. */
export async function galStatusSelection(cwd = process.cwd(), options = {}) {
  const root = galStatusRepositoryRoot(cwd, options);
  return Object.freeze({ root, branch: await galStatusBranch(root, options) });
}

export async function run(_argv, { positionals, options }) {
  const root = galStatusRepositoryRoot();
  if (optionBoolean(options, 'submission-readiness')) {
    const [
      { loadAcceptedStoryExecution },
      { storyPublicationPending },
      { submissionReadiness, submissionReadinessText }
    ] = await Promise.all([
      import('../accepted-story-execution.mjs'),
      import('../state-stores.mjs'),
      import('../submission-readiness.mjs')
    ]);
    const { definition, workflow } = await loadAcceptedStoryExecution(root, positionals[1]);
    const pendingSynchronization = await storyPublicationPending(
      root, definition, workflow.workItem.id, { migrate: false }
    );
    const readiness = await submissionReadiness(root, definition, workflow, { pendingSynchronization });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(readiness, null, 2));
    else console.log(submissionReadinessText(readiness));
    return;
  }
  const gitShadow = optionBoolean(options, 'git-shadow');
  const gitShadowObservations = [];
  let currentBranch = null;
  if (!positionals[1]) {
    if (gitShadow) {
      const { runFosGitShadowRead } = await import('../fos-git-shadow.mjs');
      ({ value: currentBranch } = await runFosGitShadowRead({
        operation: 'status.repository-branch',
        mode: 'shadow',
        // The registered one-spawn read is authoritative. `--git-shadow` now compares the retired
        // direct helper without allowing it to select another Story.
        reference: () => galStatusBranch(root),
        candidate: () => branch(root),
        record(value) { gitShadowObservations.push(value); }
      }));
    } else currentBranch = await galStatusBranch(root);
  }
  const reference = positionals[1] ?? currentBranch;
  const selected = resolveContext(await buildRepositorySubjectIndex(root), {
    reference,
    kind: 'story',
    required: true
  });
  const workflow = selected.state;
  let gitShadowSummary = null;
  if (gitShadow) {
    const { summarizeFosGitShadowObservations } = await import('../fos-git-shadow.mjs');
    gitShadowSummary = summarizeFosGitShadowObservations(gitShadowObservations);
  }
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify({
    ...workflow,
    ...(gitShadowSummary ? { gitShadow: gitShadowSummary } : {})
  }, null, 2));

  summary(workflow);
  if (gitShadowSummary) {
    console.log(`Git shadow: ${gitShadowSummary.equivalent}/${gitShadowSummary.comparisons} equivalent · reference remains authoritative`);
  }
  console.log(`\n${table(workflow.phaseOrder.map((id, index) => {
    const phase = workflow.phases[id];
    return { index: index + 1, phase: id, agent: phase.defaultAgent ?? '', status: phase.status, artifacts: phase.artifacts.length };
  }), [
    { key: 'index', label: '#' }, { key: 'phase', label: 'PHASE' }, { key: 'agent', label: 'AGENT' },
    { key: 'status', label: 'STATUS' }, { key: 'artifacts', label: 'ARTIFACTS' }
  ])}`);
  const selfApprovals = workflow.phaseOrder.flatMap((id) => workflow.phases[id].approvals
    .filter((item) => !item.invalidatedAt && item.selfApproval)
    .map((item) => `${id}: ${item.actor?.name ?? 'unknown'}; agent ${item.agent ?? 'unavailable'}`));
  if (selfApprovals.length) console.warn(`\nSelf-approval warnings (not independent review):\n- ${selfApprovals.join('\n- ')}`);
  const ledger = await ledgerStatus(root, workflow.resolution?.ledger ?? {}, { offline: true });
  if (ledger.enabled) {
    console.log(`\nCapability ledger: ${ledger.initialized ? ledger.verification.valid ? 'verified' : 'invalid' : 'not initialized'} · pending ${ledger.pending?.length ?? 0} · local outbox ${ledger.outbox}`);
  }
}
