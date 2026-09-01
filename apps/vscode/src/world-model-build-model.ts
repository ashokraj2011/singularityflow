/** Pure host choreography for the native exact-confirm World Model build. */

export type WorldModelBuildArguments = {
  readonly views: readonly string[];
  readonly depth: 'quick' | 'standard' | 'deep';
  readonly consumer: 'developer' | 'architect' | 'tester' | 'business' | 'operations' | 'security' | 'release';
  readonly composer: 'deterministic' | 'auto' | 'model';
  readonly cachePolicy: 'reuse-valid' | 'rebuild';
};

export type GatewayResult = {
  readonly kind: string;
  readonly operation?: { readonly id?: string; readonly classification?: string };
  readonly outcome?: { readonly status?: string; readonly messageId?: string };
  readonly why?: readonly { readonly code?: string; readonly slots?: Record<string, unknown> }[];
  readonly warnings?: readonly { readonly code?: string; readonly slots?: Record<string, unknown> }[];
  readonly next?: readonly { readonly handle?: string }[];
  readonly data?: Readonly<Record<string, any>>;
};

export type ExactBuildKernel = {
  resolve(request: { utterance: string; arguments: WorldModelBuildArguments }): GatewayResult | Promise<GatewayResult>;
  confirmPlan(request: { planId: string; requestSha256: string; planSha256: string }): {
    readonly receiptId: string; readonly value: string;
  };
  run(request: { planId: string }, confirmation: {
    confirmationReceiptId: string; confirmationValue: string;
  }): GatewayResult | Promise<GatewayResult>;
};

export type ExactWorldModelBuildOutcome = {
  readonly status: 'cancelled' | 'refused' | 'completed';
  readonly planned: GatewayResult | null;
  readonly result: GatewayResult | null;
};

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length ? value : fallback;
}

/** Content shown before the host issues the out-of-band confirmation receipt. */
export function exactWorldModelPlanDetail(review: Readonly<Record<string, any>>): string {
  const publication = review.publication && typeof review.publication === 'object'
    ? review.publication as Readonly<Record<string, unknown>> : {};
  const remote = stringField(publication.remote, 'configured remote');
  const branch = stringField(publication.branch, 'state');
  const lines = [
    `Request: ${stringField(review.requestSha256, 'unavailable')}`,
    `Plan: ${stringField(review.planSha256, 'unavailable')}`,
    `Source: ${stringField(review.sourceManifestSha256, 'unavailable')}`,
    `Scope: ${stringField(review.scopeManifestSha256, 'unavailable')}`,
    `Views: ${Array.isArray(review.effectiveViews) ? review.effectiveViews.join(', ') : 'unavailable'}`,
    `Depth / composer: ${stringField(review.depth, 'unavailable')} / ${stringField(review.composer, 'unavailable')}`,
    `Publish target: ${remote}/${branch} · ${stringField(publication.outputDir, 'singularity/world-model')}`
  ];
  const expected = Object.hasOwn(publication, 'expectedRemoteHead')
    ? publication.expectedRemoteHead
    : Object.hasOwn(publication, 'expectedTargetCommit')
      ? publication.expectedTargetCommit
      : Object.hasOwn(review, 'expectedRemoteHead')
        ? review.expectedRemoteHead : review.expectedTargetCommit;
  if (typeof expected === 'string' && expected.length) lines.push(`Expected target head: ${expected}`);
  else if (expected === null) lines.push('Expected target head: branch absent');
  lines.push('', 'No provider, Git ref, or repository file has been changed by this preview.');
  lines.push('If the source, scope, policy, or publication target moves, execution is refused and must be reviewed again.');
  return lines.join('\n');
}

/** Host-only exact confirmation choreography, independent from VS Code widgets. */
export async function runExactWorldModelBuild(
  kernel: ExactBuildKernel,
  args: WorldModelBuildArguments,
  reviewPlan: (review: Readonly<Record<string, any>>) => boolean | Promise<boolean>,
  executeConfirmed: <T>(operation: () => Promise<T>) => PromiseLike<T> = (operation) => operation()
): Promise<ExactWorldModelBuildOutcome> {
  const planned = await kernel.resolve({
    utterance: 'build and publish registered world model', arguments: args
  });
  const plan = planned.data?.plan;
  const planId = stringField(plan?.handle ?? planned.next?.[0]?.handle, '');
  const review = plan?.review;
  if (planned.kind !== 'plan' || !planId || !review
      || typeof review.requestSha256 !== 'string' || typeof review.planSha256 !== 'string') {
    return { status: 'refused', planned, result: planned };
  }
  if (!await reviewPlan(review)) return { status: 'cancelled', planned, result: null };

  // Receipt id and secret stay in this lexical host boundary and are never rendered, logged, put in
  // command arguments, or returned to a model-facing tool.
  const receipt = kernel.confirmPlan({
    planId,
    requestSha256: review.requestSha256,
    planSha256: review.planSha256
  });
  const result = await executeConfirmed(() => Promise.resolve(kernel.run(
    { planId },
    { confirmationReceiptId: receipt.receiptId, confirmationValue: receipt.value }
  )));
  return {
    status: result.kind === 'refusal' || result.outcome?.status === 'refused' ? 'refused' : 'completed',
    planned,
    result
  };
}
