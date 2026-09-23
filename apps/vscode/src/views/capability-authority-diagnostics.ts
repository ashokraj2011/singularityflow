/** Actionable, fail-closed presentation for an unavailable capability-authority lease. */
import { safeDisplayDiagnosticText } from '../cli/runner.ts';
import type { ObservedCapabilityAuthority } from './workspaces-model.ts';
import { commandGuidanceText } from './command-guidance.ts';

const FAILURE_CLASSIFICATION = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_ADVICE_CHARS = 1_000;

function oneLine(value: unknown, maximum: number): string {
  return safeDisplayDiagnosticText(value).replace(/\s+/gu, ' ').trim().slice(0, maximum);
}

/**
 * Keep the workspace-selection refusal, while retaining the engine's classified Git diagnosis.
 *
 * The organisation document crossed a child-process boundary. Treat its prose and continuation as
 * untrusted even though the current producer already redacts them: prose goes through the VS Code
 * display scrubber and command routes through the shared registered-command trust boundary.
 */
export function unavailableCapabilityAuthorityMessage(
  observed: ObservedCapabilityAuthority | null | undefined
): string {
  const rawClassification = oneLine(observed?.remoteFailure?.classification, 64);
  const classification = FAILURE_CLASSIFICATION.test(rawClassification)
    ? rawClassification : 'unknown';
  const advice = oneLine(observed?.remoteFailure?.advice, MAX_ADVICE_CHARS);
  const guidance = commandGuidanceText(observed?.diagnosticAction);
  return [
    'The capability authority could not be freshly verified.',
    advice
      ? `Git diagnosis (${classification}): ${advice}`
      : `Git diagnosis (${classification}): Check Git access and retry.`,
    ...(guidance ? [`Diagnose:\n${guidance}`] : []),
    'No local workspace was selected.'
  ].join('\n');
}
