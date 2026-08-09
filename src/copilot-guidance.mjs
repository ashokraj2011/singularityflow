/**
 * User-facing Copilot commands use the direct, globally installed `/sf-*` aliases.
 * Packaged plugin sources keep their `sflow-*` ids internally; exposing those ids in
 * lifecycle guidance forces users back through a plugin namespace and is therefore
 * deliberately normalized at this presentation boundary.
 */
export function directCopilotSkill(skill) {
  if (!skill) return null;
  const value = String(skill).startsWith('/') ? String(skill) : `/${skill}`;
  return value.replace(/^\/sflow-/, '/sf-');
}

export function copilotSkillForCommand(command, fallback = '/sf-next') {
  const value = String(command ?? '').trim();
  const match = value.match(/^singularity-flow\s+([^\s]+)(?:\s+([^\s]+))?/);
  if (!match) return fallback;
  const [, first, second] = match;
  if (first === 'phase' || first === 'prepare') return '/sf-phase';
  if (first === 'gate') return '/sf-next';
  if (first === 'sync') return '/sf-next';
  if (first === 'documents') return '/sf-documents';
  if (first === 'agents') return '/sf-agents';
  if (first === 'initiative') {
    const mapped = {
      approve: 'approve', checklist: 'checklist', documents: 'documents', evidence: 'evidence',
      materialize: 'materialize', next: 'next', phase: 'phase', start: 'start', status: 'status'
    }[second];
    return mapped ? `/sf-initiative-${mapped}` : '/sf-initiative-next';
  }
  if (first === 'epic') {
    const mapped = {
      'create-stories': 'publish',
      report: 'status'
    }[second] ?? second;
    return mapped ? `/sf-epic-${mapped}` : '/sf-epic-next';
  }
  const direct = new Set([
    'approve', 'cancel', 'doctor', 'help', 'init', 'inputs', 'next', 'nextsteps',
    'progress', 'reject', 'report', 'resume', 'review', 'start', 'submit'
  ]);
  return direct.has(first) ? `/sf-${first}` : fallback;
}

export function copilotAction({ skill = null, command, ...rest }) {
  return {
    ...rest,
    skill: directCopilotSkill(skill) ?? copilotSkillForCommand(command),
    command
  };
}

/**
 * The two lines that offer one action: the command, then the Copilot skill that wraps it.
 *
 * The command leads. This rendered the other way round — the skill as the headline and the command
 * beneath it — which told someone reading a terminal that the thing in front of them was the
 * secondary way to use the product. `label` is retained for callers that introduce the pair.
 */
export function actionCommandLines({ skill, command }, label = 'Run') {
  return [
    `${label}: ${command}`,
    `In Copilot: ${directCopilotSkill(skill) ?? copilotSkillForCommand(command)}`
  ];
}
