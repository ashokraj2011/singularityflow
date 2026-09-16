import { skillForCommandLine } from './command-skills.mjs';

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

/** Return the installed skill id without any invocation arguments. */
export function directCopilotSkillId(skill) {
  const value = directCopilotSkill(skill);
  return value?.match(/^\/sf-[a-z0-9]+(?:-[a-z0-9]+)*(?=\s|$)/u)?.[0] ?? null;
}

export function copilotSkillForCommand(command, fallback = '/sf-next') {
  return directCopilotSkill(skillForCommandLine(command)) ?? fallback;
}

/**
 * Return the complete Copilot invocation for one shell command.
 *
 * Most guided skills intentionally discover their remaining inputs from governed state, so their
 * direct id is the complete invocation. The SGOS relay is different: its contract requires the
 * exact CLI family and subcommand, and therefore receives the complete argument tail.
 */
export function copilotCommandForCommand(command, skill = null, fallback = '/sf-next') {
  const explicit = directCopilotSkill(skill);
  if (explicit && /\s/u.test(explicit)) return explicit;
  const selected = explicit ?? copilotSkillForCommand(command, fallback);
  const value = String(command ?? '').trim();
  if (selected === '/sf-sgos') {
    const match = value.match(/^(?:singularity-flow|sflow)\s+(.+)$/u);
    return match ? `${selected} ${match[1]}` : selected;
  }
  if (selected === '/sf-auto') {
    const match = value.match(/^(?:singularity-flow|sflow)\s+auto(?:\s+(.+))?$/u);
    return match?.[1] ? `${selected} ${match[1]}` : selected;
  }
  return selected;
}

export function copilotAction({ skill = null, command, ...rest }) {
  const directSkill = directCopilotSkill(skill) ?? copilotSkillForCommand(command);
  return {
    ...rest,
    skill: directSkill,
    command,
    copilotCommand: copilotCommandForCommand(command, directSkill)
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
 * The paired routes that offer one action: the shell command, then the Copilot skill that wraps it.
 *
 * The command leads. This rendered the other way round — the skill as the headline and the command
 * beneath it — which told someone reading a terminal that the thing in front of them was the
 * secondary way to use the product. `label` is retained for callers that introduce the pair.
 */
export function actionCommandLines({ skill, command }, label = 'Run') {
  return [
    `${label}:`,
    `Shell: ${command}`,
    `Copilot: ${copilotCommandForCommand(command, skill)}`
  ];
}
