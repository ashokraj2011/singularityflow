/** Keep the editor's Publish button on the same read-only phase gate as the CLI. */
export interface PhasePrepublishDecision {
  ready: boolean;
  headline: string;
  details: string[];
  skill: string | null;
  /** Documentation advisories (and why the check could not run). Never part of readiness. */
  advisories: string[];
  publishArgv?: string[];
}

/** Parse only the kernel's closed publication form, never shell text or arbitrary extra options. */
function publicationArgv(command: string | null, phaseId: string): string[] | null {
  const tokens = command?.split(' ') ?? [];
  if (tokens.slice(0, 4).join(' ') !== `singularity-flow phase publish ${phaseId}`) return null;
  for (let index = 4; index < tokens.length; index += 1) {
    if (tokens[index] === '--no-model') continue;
    const allowed = tokens[index] === '--authored' ? ['human', 'governed-agent', 'deterministic', 'external-tool']
      : tokens[index] === '--channel' ? ['manual-in-place', 'copilot-host', 'kernel-model', 'kernel-generator', 'external-tool'] : null;
    if (!allowed?.includes(tokens[index + 1] ?? '')) return null;
    index += 1;
  }
  return [...tokens.slice(1), '--json'];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function line(value: unknown, maximum = 280): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

/**
 * Malformed, stale, or wrong-Story projections are never publication authority. In particular,
 * `ready` without a publish route or with findings does not authorize the mutation.
 */
export function phasePrepublishDecision(
  result: unknown, expected: { workId: string; phaseId: string }
): PhasePrepublishDecision {
  const projection = record(result);
  if (!projection || projection.schemaVersion !== 1
      || projection.resultType !== 'sflow-phase-prepublish'
      || projection.workId !== expected.workId || projection.phase !== expected.phaseId
      || projection.mutates !== false || projection.modelInvocations !== 0) {
    return {
      ready: false,
      headline: `Publication of ${expected.phaseId} stopped: the pre-publish check is unavailable or stale.`,
      details: ['Refresh the Story and rerun the phase check. No publication was attempted.'],
      skill: null,
      advisories: []
    };
  }
  const advisories = (Array.isArray(projection.advisories) ? projection.advisories : []).slice(0, 10)
    .map((advisory) => {
      const value = record(advisory);
      const message = line(value?.message);
      return message && value?.requiredBefore === 'approve'
        ? `Before approval (not a publication blocker): ${message}` : message;
    })
    .filter((message): message is string => Boolean(message));
  const warnings = Array.isArray(projection.warnings) ? projection.warnings
    : record(projection.grounding)?.warnings;
  if (Array.isArray(warnings)) advisories.push(...warnings.slice(0, 10)
    .map((warning) => line(warning)).filter((message): message is string => Boolean(message)));
  const documentation = record(projection.documentation);
  if (projection.qualityDisposition === 'accepted-risk') {
    advisories.push('This phase has an authorized document-quality exception. The shortfall remains unmet, not a passing proof; tests and approval still apply.');
  }
  if (documentation?.status === 'unavailable') {
    advisories.push(`The documentation check could not run (${line(documentation.reason, 80) ?? 'unknown reason'}); it never blocks publication.`);
  }
  const findings = Array.isArray(projection.findings) ? projection.findings : null;
  const commands = record(projection.commands);
  const readiness = record(projection.readiness);
  const publishCommand = line(commands?.publish, 500);
  const publishArgv = publicationArgv(publishCommand, expected.phaseId);
  if (projection.status === 'ready' && findings?.length === 0
      && readiness?.lifecycle === true && readiness.authoring === true
      && readiness.knownRecoveryBlockers === true
      && readiness.publicationTransaction === 'not-run'
      && publishArgv) {
    const testsPending = record(projection.testExecution)?.status === 'not-run';
    return {
      ready: true,
      headline: testsPending
        ? `${expected.phaseId} is ready for a publication attempt; required tests run during publication.`
        : `${expected.phaseId} is ready to publish.`,
      details: [], skill: null, advisories, publishArgv
    };
  }
  const details = (findings ?? []).slice(0, 256)
    .map((finding) => {
      const value = record(finding);
      const location = record(value?.details);
      const message = line(value?.message);
      const field = line(location?.field, 60);
      const at = Number.isSafeInteger(value?.line) ? `line ${value?.line}` : null;
      return message && (field || at) ? `${[at, field].filter(Boolean).join(' · ')}: ${message}` : message;
    })
    .filter((message): message is string => Boolean(message));
  if (findings && findings.length > 256) details.push(`${findings.length - 256} additional findings are available in the phase check JSON.`);
  const guidance = line(record(projection.correction)?.guidance, 500);
  if (guidance) {
    // The correction usually restates the finding that blocked: show it once, in its fuller form.
    const repeated = details.findIndex((detail) => guidance.startsWith(detail));
    if (repeated >= 0) details[repeated] = guidance; else details.push(guidance);
  }
  const repair = record(projection.traceabilityRepair);
  if (repair?.status === 'producer-repair' && repair.sameTurn === true
      && record(projection.correction)?.sameTurn === true && Array.isArray(repair.actions)
      && repair.actions.some((action) => record(action)?.sameTurn === true)) {
    details.push('Missing traceability annotations can be repaired in the current producer loop; ambiguous mappings need clarification. No separate tag approval is required; behavior and test gates still apply.');
  }
  const skill = line(record(projection.correction)?.skill, 80);
  const exactSkill = skill && /^\/sf-[a-z0-9-]+$/u.test(skill) ? skill : null;
  const nextGuidance = record(record(projection.commandGuidance)?.next);
  const nextCopilot = line(nextGuidance?.copilotCommand, 500);
  if (nextCopilot && /^\/sf-[a-z0-9-]+(?:\s|$)/u.test(nextCopilot)) details.push(`Next in Copilot: ${nextCopilot}`);
  else if (exactSkill && !nextGuidance) details.push(`Next in Copilot: ${exactSkill}`);
  if (exactSkill && nextGuidance && nextCopilot !== exactSkill) details.push(`Repair in Copilot: ${exactSkill}`);
  const next = line(commands?.next, 500);
  if (next?.startsWith('singularity-flow ')) details.push(`Next in Shell: ${next}`);
  const modelFree = line(nextGuidance?.modelFreeCommand, 500);
  if (modelFree?.startsWith('@sflow /')) details.push(`VS Code (model-free): ${modelFree}`);
  details.push(`Shell: singularity-flow phase prepublish ${expected.phaseId} --json`);
  return {
    ready: false,
    headline: `Publication of ${expected.phaseId} stopped: correct this phase first.`,
    details,
    skill: exactSkill,
    advisories
  };
}
