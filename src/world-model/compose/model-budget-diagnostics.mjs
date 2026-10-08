/** Safe budget facts and reviewed recovery; provider transcripts never enter this projection. */
export function worldModelBudgetRecovery(runtime, refusal) {
  const failure = Array.isArray(refusal?.failures)
    ? refusal.failures.find(entry => entry?.code === 'MODEL_TOKEN_BUDGET_EXCEEDED') : null;
  if (!failure) return null;
  const details = failure.details ?? {};
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const modelBudget = Object.freeze({
    viewId: refusal.view,
    logicalPromptTokensEstimate: count(details.logicalPromptTokensEstimate),
    maximumPromptTokensEstimate: count(details.maximumPromptTokensEstimate),
    maximumOutputBytes: count(details.maximumOutputBytes),
    maximumTotalTokens: count(details.maximumTotalTokens),
    observedTotalTokens: count(details.observedTotalTokens),
    providerInputTokens: count(details.usage?.inputTokens),
    providerOutputTokens: count(details.usage?.outputTokens)
  });
  // Only the exact Plan can establish whether a model-free retry is allowed for every view.
  // Never silently downgrade a required-model contract or change the user's confirmed Plan.
  const requested = runtime?.planned?.requestedViews;
  const deterministicAllowed = Array.isArray(requested) && requested.length > 0
    && requested.every(entry => ['optional', 'never'].includes(entry?.contract?.model?.mode));
  return Object.freeze({
    modelBudget,
    actions: Object.freeze([
      {
        command: 'singularity-flow wm doctor --format registered-v4 --json',
        label: 'Inspect the registered World Model and retained build diagnostics.'
      },
      {
        label: deterministicAllowed
          ? 'In World Model → Build / refresh effective model, choose the deterministic composer and review a new exact build Plan. This uses no model tokens; all view validation and publication review remain required. Do not retry the unchanged model call.'
          : 'A model-free retry is not verified for this Plan. Ask the configuration authority to review provider context and the model-required view contracts, then review a fresh build Plan. Do not retry the unchanged model call or weaken validation.'
      }
    ])
  });
}
