import { branch, repoRoot } from '../git.mjs';
import { ledgerStatus } from '../ledger.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { optionBoolean, table } from '../util.mjs';

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

/** The optional shadow candidate is never the authoritative Story selector. */
export async function galStatusBranchCandidate(root) {
  const { createGitRuntime } = await import('../git-access.mjs');
  const created = await createGitRuntime();
  if (!created.ok) throw Object.assign(new Error('GAL runtime unavailable'), {
    code: created.code
  });
  const runtime = created.value;
  try {
    const opened = await runtime.openRepository(root);
    if (!opened.ok) throw Object.assign(new Error('GAL repository unavailable'), {
      code: opened.code
    });
    const invocation = opened.value.beginInvocation();
    try {
      const observed = await invocation.head();
      if (!observed.ok) throw Object.assign(new Error('GAL branch unavailable'), {
        code: observed.code
      });
      const symbolic = observed.value.symbolicRef;
      return symbolic?.startsWith('refs/heads/')
        ? symbolic.slice('refs/heads/'.length) : null;
    } finally { await invocation.dispose(); }
  } finally { await runtime.dispose(); }
}

export async function run(_argv, { positionals, options }) {
  const root = repoRoot();
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
        reference: () => branch(root),
        candidate: () => galStatusBranchCandidate(root),
        record(value) { gitShadowObservations.push(value); }
      }));
    } else currentBranch = branch(root);
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
