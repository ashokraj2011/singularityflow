import { branch, head } from './git.mjs';
import { interfaceContractStatus } from './initiative-contracts.mjs';
import { evaluateInitiativePhase, readInitiativeRecords } from './initiative-evidence.mjs';
import { initiativeMilestoneReadiness } from './initiative-repositories.mjs';
import { loadInitiative } from './initiative-state.mjs';
import { run } from './util.mjs';

export async function runInitiativeGate(root, initiativeId, { terminal = false } = {}) {
  const { portfolio, initiative } = await loadInitiative(root, initiativeId);
  const errors = [], warnings = [], passes = [];
  if (branch(root) !== initiative.initiative.branch) errors.push(`current branch ${branch(root)} does not match initiative branch ${initiative.initiative.branch}`);
  if (initiative.resolution.profile !== initiative.initiative.profile) errors.push('initiative profile differs from immutable resolution');
  if (!initiative.resolution.portfolioSha256 || !initiative.resolution.resolutionSha256) errors.push('initiative immutable configuration hashes are missing');
  for (const category of ['evidence', 'approvals', 'invalidations']) {
    try {
      const records = await readInitiativeRecords(root, portfolio, initiativeId, category);
      passes.push(`${category} integrity: ${records.length} content-addressed records`);
    } catch (error) {
      errors.push(error.message);
    }
  }
  for (const phaseId of initiative.phaseOrder) {
    const phase = initiative.phases[phaseId];
    if (['approved', 'awaiting_approval'].includes(phase.status)) {
      const gate = await evaluateInitiativePhase(root, portfolio, initiative, phaseId);
      errors.push(...gate.errors.map((message) => `${phaseId}: ${message}`));
      warnings.push(...gate.warnings.map((message) => `${phaseId}: ${message}`));
      if (!gate.errors.length) passes.push(`${phaseId} bundle ${gate.bundleSha256.slice(0, 12)}`);
    }
  }
  for (const contract of await interfaceContractStatus(root, initiativeId)) {
    if (contract.integrity !== 'verified') errors.push(`contract ${contract.key} is ${contract.integrity}`);
    else passes.push(`contract ${contract.key}@${contract.sha256.slice(0, 12)}`);
  }
  for (const phaseId of ['construction', 'delivery'].filter((id) => initiative.phaseOrder.includes(id))) {
    const readiness = initiativeMilestoneReadiness(initiative, phaseId);
    if ((initiative.phases[phaseId].status === 'approved' || terminal) && !readiness.ready) errors.push(`${phaseId}: ${readiness.incomplete.length} blocking stories have not reached ${readiness.requiredMilestone}`);
    else if (readiness.ready) passes.push(`${phaseId}: all ${readiness.blockingStories} blocking stories reached ${readiness.requiredMilestone}`);
  }
  if (terminal) {
    for (const phaseId of initiative.phaseOrder) if (initiative.phases[phaseId].status !== 'approved') errors.push(`terminal: phase ${phaseId} is ${initiative.phases[phaseId].status}`);
    if (initiative.status !== 'complete' || initiative.currentPhase !== null) errors.push('terminal: initiative lifecycle is not complete');
  }
  if ((portfolio.git?.publish ?? 'required') === 'required') {
    const remote = portfolio.git?.remote ?? 'origin';
    const remoteHead = run('git', ['ls-remote', remote, `refs/heads/${initiative.initiative.branch}`], { cwd: root, allowFailure: true }).stdout.trim().split(/\s+/)[0];
    if (remoteHead !== head(root)) errors.push(`local initiative HEAD is not published to ${remote}/${initiative.initiative.branch}`);
    else passes.push('remote publication');
  }
  return { valid: errors.length === 0, initiativeId, terminal, errors, warnings, passes };
}
