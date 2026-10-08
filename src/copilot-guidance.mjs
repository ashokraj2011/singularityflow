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

function approvalSelectors(command) {
  const match = command.match(/^(?:singularity-flow|sflow)\s+approve(?:\s+(.+))?$/u);
  if (!match || /[\u0000-\u001f\u007f]/u.test(command)) return '';
  const tokens = (match[1] ?? '').split(/\s+/u).filter(Boolean);
  const literal = (value, maximum) => {
    const unquoted = String(value ?? '').replace(/^(['"])([A-Za-z0-9._-]+)\1$/u, '$2');
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(unquoted) && unquoted.length <= maximum
      ? unquoted : null;
  };
  let phase = null;
  let workId = null;
  if (tokens[0] && !tokens[0].startsWith('--')) {
    phase = literal(tokens.shift(), 128);
    if (!phase) return '';
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const [option, ...assigned] = tokens[index].split('=');
    // The former approve WORK-ID --phase PHASE grammar must never reinterpret a Work ID as a phase.
    if (option === '--phase' || !/^--[a-z][a-z0-9-]*$/u.test(option)) return '';
    if (option === '--work-id') {
      if (workId !== null) return '';
      workId = literal(assigned.length ? assigned.join('=') : tokens[++index], 64);
      if (!workId) return '';
    } else if (!assigned.length && !['--fetch', '--yes', '--json'].includes(option)
        && tokens[index + 1] && !tokens[index + 1].startsWith('--')) {
      index += 1;
    }
  }
  return [phase, workId ? `--work-id ${workId}` : null].filter(Boolean).join(' ');
}

/**
 * Return the complete Copilot invocation for one shell command.
 *
 * Most guided skills intentionally discover their remaining inputs from governed state, so their
 * direct id is the complete invocation. Approval retains only literal phase and Story selectors;
 * execution flags and private receipts are never transferred into its human review invocation.
 * Exact relay skills receive the command arguments required by their individual contracts.
 */
export function copilotCommandForCommand(command, skill = null, fallback = '/sf-next') {
  const explicit = directCopilotSkill(skill);
  if (explicit && /\s/u.test(explicit)
      && !['/sf-approve', '/sf-worldmodel', '/sf-review-source', '/sf-appeal'].includes(directCopilotSkillId(explicit))) return explicit;
  const selected = directCopilotSkillId(explicit) ?? explicit ?? copilotSkillForCommand(command, fallback);
  const value = String(command ?? '').trim();
  if (selected === '/sf-appeal') {
    const match = !/[\u0000-\u001f\u007f]/u.test(value)
      && value.match(/^(?:singularity-flow|sflow)\s+appeal\s+(evidence-prepare|evidence-accept|resolve|resolve-run|resolve-resume)(?:\s+(.+))?$/u);
    return match ? `${selected} ${match[1]}${match[2] ? ` ${match[2]}` : ''}` : selected;
  }
  if (selected === '/sf-worldmodel') {
    // Bare worldmodel is inspection, not an interchangeable substitute for compose/build/doctor.
    // The shell action owns its operation and selectors; an asserted skill cannot change them.
    const match = !/[\u0000-\u001f\u007f]/u.test(value)
      && value.match(/^(?:singularity-flow|sflow)\s+(?:wm|world-model)(?:\s+(.+))?$/u);
    return match?.[1] ? `${selected} ${match[1]}` : selected;
  }
  if (selected === '/sf-review-source') {
    // Keep the phase and the human-decision route distinct from starting another reviewer turn.
    const match = !/[\u0000-\u001f\u007f]/u.test(value)
      && value.match(/^(?:singularity-flow|sflow)\s+review-source\s+(context|status|decide)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\s+(.+))?$/u);
    if (!match) return selected;
    return match[1] === 'context' ? `${selected} ${match[2]}`
      : `${selected} ${match[1]} ${match[2]}${match[3] ? ` ${match[3]}` : ''}`;
  }
  if (selected === '/sf-pause') {
    const match = value.match(/^(?:singularity-flow|sflow)\s+pause(?:\s+(on|off|status))?(?:\s+--json)?$/u);
    return match?.[1] ? `${selected} ${match[1]}` : selected;
  }
  if (selected === '/sf-approve') {
    const selectors = approvalSelectors(value);
    return selectors ? `${selected} ${selectors}` : selected;
  }
  if (selected === '/sf-sgos') {
    const match = value.match(/^(?:singularity-flow|sflow)\s+(.+)$/u);
    return match ? `${selected} ${match[1]}` : selected;
  }
  if (selected === '/sf-auto') {
    const match = value.match(/^(?:singularity-flow|sflow)\s+auto(?:\s+(.+))?$/u);
    return match?.[1] ? `${selected} ${match[1]}` : selected;
  }
  if (selected === '/sf-explain') {
    // `/sf-explain <subject> ...` receives the exact subject and selectors of the CLI route.
    const match = value.match(/^(?:singularity-flow|sflow)\s+explain\s+--subject\s+(.+)$/u);
    return match?.[1] ? `${selected} ${match[1]}` : selected;
  }
  if (selected === '/sf-explain-code') {
    const match = value.match(/^(?:singularity-flow|sflow)\s+explain\s+code(?:\s+(.+))?$/u);
    return match?.[1] ? `${selected} ${match[1]}` : selected;
  }
  if (selected === '/sf-phase-documents') {
    const match = value.match(/^(?:singularity-flow|sflow)\s+phase\s+show(?:\s+([A-Za-z0-9][A-Za-z0-9._-]*))?(?:\s+(?:--json|--show-artifact))*$/u);
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
