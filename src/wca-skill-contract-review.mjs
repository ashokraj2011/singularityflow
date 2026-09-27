/** Reconstruct the bounded replacement catalog from exact raw approved policy, without I/O. */
import { validateDefinition } from './config.mjs';
import { normalizeExternalCommand } from './external-command-policy.mjs';
import { validateConfiguredSkillPhase } from './skp-contract.mjs';
import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

export function sharedSkillContractCatalog(rawDefinition, phaseId) {
  const definition = validateDefinition(structuredClone(rawDefinition));
  const phase = definition.phases[phaseId];
  validateConfiguredSkillPhase(phase, phaseId);
  const selected = phase.skillBinding.bindingRefs.skill;
  const checks = {}; const ambiguous = new Set();
  for (const source of Object.values(definition.phases)) for (const [index, raw] of (source.qualityCommands ?? []).entries()) {
    const command = normalizeExternalCommand(raw, index); const previous = checks[command.id];
    if (previous && canonicalJson(previous) !== canonicalJson(command)) ambiguous.add(command.id);
    checks[command.id] = command;
  }
  if (Object.keys(definition.phases).length > 512 || Object.keys(checks).length > 512) {
    throw new SingularityFlowError('The complete source catalog exceeds the bounded skill replacement profile.', { code: 'WCA_CHANGE_LIMIT' });
  }
  return JSON.parse(canonicalJson({
    skillPackages: { [selected.id]: { packageSha256: selected.packageSha256, eligibility: 'candidate-producer' } },
    phases: Object.fromEntries(Object.entries(definition.phases).map(([id, source]) => [id,
      { outputs: source.kind === 'skill' ? source.skillBinding.bindingRefs.outputs : [{ id: 'primary', path: source.artifact.path }] }])),
    checks: Object.fromEntries(Object.entries(checks).filter(([id]) => !ambiguous.has(id)).map(([id, command]) => {
      const { command: shell, ...argvCommand } = command;
      return [id, shell === null && Array.isArray(command.argv) ? argvCommand : command];
    })),
    approvalAuthorities: definition.approvalAuthorities, approvalSecurity: definition.approvalSecurity,
    artifactSets: definition.artifactSets ?? {}, readPaths: [], sourceScopes: {}, codeDelivery: definition.codeDelivery
  }));
}
