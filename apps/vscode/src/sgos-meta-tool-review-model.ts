/** Pure command and review helpers for the native governed Meta-tool wizard. */

export const META_TOOL_SHA256 = /^sha256:[a-f0-9]{64}$/;
export const META_TOOL_IDENTIFIER = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const META_TOOL_OUTCOMES = Object.freeze(['degraded', 'failed', 'succeeded'] as const);
export const META_TOOL_TARGET_KINDS = Object.freeze([
  'pack-operation', 'device-operation'
] as const);

type CommonSelection = {
  readonly store: string;
  readonly traceTrust: string;
  readonly evaluatorTrust: string;
};

export type MetaToolSelection = CommonSelection & ({
  readonly action: 'activate';
  readonly candidateSha256: string;
  readonly evaluationSha256: string;
  readonly promotionSha256: string;
  readonly targetKind?: (typeof META_TOOL_TARGET_KINDS)[number];
  readonly domain: string;
  readonly device?: string;
  readonly operation: string;
  readonly maximumObservations: number;
  readonly maximumEvidenceRefs: number;
  readonly acceptedOutcomes: readonly (typeof META_TOOL_OUTCOMES)[number][];
} | {
  readonly action: 'observe';
  readonly activationSha256: string;
  readonly outcome: (typeof META_TOOL_OUTCOMES)[number];
  readonly evidenceRefs: readonly string[];
} | {
  readonly action: 'revoke';
  readonly activationSha256: string;
  readonly reason: string;
} | {
  readonly action: 'rollback';
  readonly operation: string;
  readonly targetActivationSha256: string;
  readonly reason: string;
});

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function digest(value: string, label: string): string {
  const normalized = required(value, label);
  if (!META_TOOL_SHA256.test(normalized)) throw new Error(`${label} must be an exact SHA-256 digest.`);
  return normalized;
}

function integer(value: number, label: string, maximum: number): string {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be from 1 through ${maximum}.`);
  }
  return String(value);
}

/** Build the exact preview or confirmed mutation argv. Authority details are never caller fields. */
export function metaToolArguments(
  selection: MetaToolSelection, confirmationSha256: string | null = null
): string[] {
  const args = [
    'meta-tool', selection.action,
    '--store', required(selection.store, 'Authority Store'),
    '--trace-trust', required(selection.traceTrust, 'Trace trust file'),
    '--evaluator-trust', required(selection.evaluatorTrust, 'Evaluator trust file')
  ];
  if (selection.action === 'activate') {
    const targetKind = selection.targetKind ?? 'pack-operation';
    if (!META_TOOL_TARGET_KINDS.includes(targetKind)) {
      throw new Error('Meta-tool target kind is invalid.');
    }
    const outcomes = [...new Set(selection.acceptedOutcomes)].sort();
    if (!outcomes.length || outcomes.some((value) => !META_TOOL_OUTCOMES.includes(value))) {
      throw new Error('At least one supported observation outcome is required.');
    }
    args.push(
      '--candidate-sha256', digest(selection.candidateSha256, 'Candidate'),
      '--evaluation-sha256', digest(selection.evaluationSha256, 'Evaluation'),
      '--promotion-sha256', digest(selection.promotionSha256, 'Promotion'),
      '--target-kind', targetKind,
      '--domain', required(selection.domain, 'Pack domain'),
      ...(targetKind === 'device-operation'
        ? ['--device', required(selection.device ?? '', 'Device ID')]
        : []),
      '--operation', required(selection.operation,
        targetKind === 'device-operation' ? 'Device operation' : 'Pack operation'),
      '--maximum-observations', integer(selection.maximumObservations, 'Maximum observations', 10_000),
      '--maximum-evidence-refs', integer(selection.maximumEvidenceRefs, 'Maximum evidence references', 64),
      '--accepted-outcomes', outcomes.join(',')
    );
  } else if (selection.action === 'observe') {
    const evidenceRefs = [...new Set(selection.evidenceRefs.map((value) =>
      digest(value, 'Evidence reference'))) ].sort();
    if (!evidenceRefs.length) throw new Error('At least one evidence reference is required.');
    args.push(
      '--activation-sha256', digest(selection.activationSha256, 'Activation'),
      '--outcome', selection.outcome,
      '--evidence-refs', evidenceRefs.join(',')
    );
  } else if (selection.action === 'revoke') {
    args.push(
      '--activation-sha256', digest(selection.activationSha256, 'Activation'),
      '--reason', required(selection.reason, 'Revocation reason')
    );
  } else {
    args.push(
      '--operation', required(selection.operation, 'Operation'),
      '--target-activation-sha256', digest(selection.targetActivationSha256, 'Rollback target'),
      '--reason', required(selection.reason, 'Rollback reason')
    );
  }
  if (confirmationSha256 !== null) {
    args.push('--confirm', digest(confirmationSha256, 'Mutation plan'));
  }
  args.push('--json');
  return args;
}

export type MetaToolMutationPlan = {
  readonly profile?: string;
  readonly operation?: string;
  readonly actorId?: string;
  readonly expectedRevision?: number;
  readonly expectedStateSha256?: string;
  readonly confirmationSha256?: string;
  readonly input?: Record<string, unknown>;
};

/** Render bounded plan facts for the final native modal; never show complete trust documents. */
export function metaToolPlanReview(plan: MetaToolMutationPlan): string {
  const target = plan.input?.target as Record<string, unknown> | undefined;
  const lines = [
    `Operation: ${plan.operation ?? 'unknown'}`,
    `Actor: ${plan.actorId ?? 'unavailable'}`,
    `Authority Store revision: ${plan.expectedRevision ?? 'unavailable'}`,
    `Authority Store state: ${plan.expectedStateSha256 ?? 'unavailable'}`
  ];
  if (target) {
    lines.push(
      `Target: ${String(target.kind ?? 'unknown')} / ${String(target.operationId ?? 'unknown')}`,
      `Target version: ${String(target.version ?? 'unknown')}`,
      `Target manifest: ${String(target.manifestSha256 ?? 'unknown')}`,
      `Approving Pack review: ${String(target.approvalSha256 ?? 'unknown')}`
    );
  }
  if (plan.input?.activationSha256) {
    lines.push(`Activation: ${String(plan.input.activationSha256)}`);
  }
  if (plan.input?.activeActivationSha256) {
    lines.push(`Current activation: ${String(plan.input.activeActivationSha256)}`);
  }
  if (plan.input?.targetActivationSha256) {
    lines.push(`Target activation: ${String(plan.input.targetActivationSha256)}`);
  }
  lines.push(
    `Confirmation: ${plan.confirmationSha256 ?? 'unavailable'}`,
    '',
    'The engine will re-resolve approved configuration, signed Pack authority, and this exact CAS state before changing anything.'
  );
  return lines.join('\n');
}
