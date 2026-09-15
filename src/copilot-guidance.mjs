import { primarySkillForCommand } from './command-skills.mjs';

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
  if (first === 'intent' && (second === 'workflow-guide' || second === 'workflow-create')) {
    return '/sf-sgos-create';
  }
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
  try {
    return directCopilotSkill(primarySkillForCommand(first)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function copilotAction({ skill = null, command, ...rest }) {
  return {
    ...rest,
    skill: directCopilotSkill(skill) ?? copilotSkillForCommand(command),
    command
  };
}

function phaseDisplayName(phaseId) {
  return String(phaseId ?? 'phase')
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function generationAction(readiness) {
  const phaseId = readiness.phaseId;
  const skill = typeof readiness.nextSkill === 'string'
    && /^\/sf-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(readiness.nextSkill)
    ? readiness.nextSkill
    : null;
  const command = typeof readiness.nextCommand === 'string'
    && /^singularity-flow\s+/u.test(readiness.nextCommand)
    ? readiness.nextCommand
    : null;
  if (!phaseId || !skill || !command) return null;
  return {
    label: `Generate and publish ${readiness.phaseLabel ?? phaseDisplayName(phaseId)}`,
    skill,
    command,
    enabled: true,
    primary: true,
    kind: 'generate-and-publish'
  };
}

/**
 * Convert the engine-owned submission-readiness projection into bounded Copilot presentation.
 *
 * This adapter deliberately does not infer lifecycle readiness. It only makes the explicit engine
 * result difficult to mis-present: a seeded generation-zero file is not a generated artifact,
 * while an immutable current publication is ready for a separate submission attempt. Generation
 * remains owned by the engine-selected generation skill; this adapter never executes or combines
 * lifecycle mutations.
 */
export function submissionReadinessPresentation(readiness) {
  const phaseId = readiness?.phaseId ?? null;
  const generation = Number.isInteger(readiness?.currentGeneration)
    ? readiness.currentGeneration
    : null;
  const publicationRecorded = readiness?.publicationRecorded === true;
  const lifecycleReady = readiness?.lifecycleReady === true;
  const seededDraft = generation === 0
    && readiness?.draftExists === true
    && !publicationRecorded;
  const publishedGeneration = Number.isInteger(readiness?.publishedGeneration)
    ? readiness.publishedGeneration
    : null;
  const generationRequired = new Set([
    'generation-required',
    'generation-commit-required'
  ]).has(readiness?.classification);
  const exactSubmitRoute = readiness?.nextSkill === '/sf-submit'
    && typeof readiness?.nextCommand === 'string'
    && /^singularity-flow\s+/u.test(readiness.nextCommand);

  let statusLabel = readiness?.classification ?? 'Submission status unavailable';
  if (seededDraft) statusLabel = 'Seeded draft — not published';
  else if (publicationRecorded && publishedGeneration !== null) {
    const suffix = lifecycleReady
      ? 'ready to submit'
      : readiness?.classification === 'already-submitted'
        ? 'submitted for approval'
        : readiness?.classification === 'synchronization-required'
          ? 'synchronization required'
          : 'not ready to submit';
    statusLabel = `Published generation ${publishedGeneration} — ${suffix}`;
  }

  const primaryActions = [];
  if (generationRequired && !lifecycleReady) {
    const next = generationAction(readiness);
    if (next) primaryActions.push(next);
  } else if (lifecycleReady && phaseId && exactSubmitRoute) {
    primaryActions.push({
      label: `Submit ${readiness?.phaseLabel ?? phaseDisplayName(phaseId)}`,
      skill: readiness.nextSkill,
      command: readiness.nextCommand,
      enabled: true,
      primary: true,
      kind: 'submit'
    });
  }

  return {
    statusLabel,
    submitEnabled: lifecycleReady && exactSubmitRoute,
    primaryActions
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
