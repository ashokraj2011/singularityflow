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

export async function run(_argv, { positionals, options }) {
  const root = repoRoot();
  const reference = positionals[1] ?? branch(root);
  const selected = resolveContext(await buildRepositorySubjectIndex(root), {
    reference,
    kind: 'story',
    required: true
  });
  const workflow = selected.state;
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(workflow, null, 2));

  summary(workflow);
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
