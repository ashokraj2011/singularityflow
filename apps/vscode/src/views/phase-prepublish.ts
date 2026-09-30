/** Keep the editor's Publish button on the same read-only phase gate as the CLI. */
export interface PhasePrepublishDecision {
  ready: boolean;
  headline: string;
  details: string[];
  skill: string | null;
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
      skill: null
    };
  }
  const findings = Array.isArray(projection.findings) ? projection.findings : null;
  const commands = record(projection.commands);
  const readiness = record(projection.readiness);
  const publishCommand = line(commands?.publish, 500);
  const expectedPublish = `singularity-flow phase publish ${expected.phaseId}`;
  if (projection.status === 'ready' && findings?.length === 0
      && readiness?.lifecycle === true && readiness.authoring === true
      && readiness.knownRecoveryBlockers === true
      && readiness.publicationTransaction === 'not-run'
      && (publishCommand === expectedPublish || publishCommand?.startsWith(`${expectedPublish} `))) {
    const testsPending = record(projection.testExecution)?.status === 'not-run';
    return {
      ready: true,
      headline: testsPending
        ? `${expected.phaseId} is ready for a publication attempt; required tests run during publication.`
        : `${expected.phaseId} is ready to publish.`,
      details: [], skill: null
    };
  }
  const details = (findings ?? []).slice(0, 5)
    .map((finding) => line(record(finding)?.message))
    .filter((message): message is string => Boolean(message));
  const guidance = line(record(projection.correction)?.guidance, 500);
  if (guidance) details.push(guidance);
  const skill = line(record(projection.correction)?.skill, 80);
  const exactSkill = skill && /^\/sf-[a-z0-9-]+$/u.test(skill) ? skill : null;
  if (exactSkill) details.push(`Next in Copilot: ${exactSkill}`);
  const next = line(commands?.next, 500);
  if (next?.startsWith('singularity-flow ')) details.push(`Next in Shell: ${next}`);
  details.push(`Shell: singularity-flow phase prepublish ${expected.phaseId} --json`);
  return {
    ready: false,
    headline: `Publication of ${expected.phaseId} stopped: correct this phase first.`,
    details,
    skill: exactSkill
  };
}
