/** Publication-operation policy; frequent phase/session reads need none of this operation's intent handling. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { effectivePhasePublicationProducer, normalizeAuthorshipOptions, assertProducerAllowed, isConvergencePhase } from './phase-policy.mjs';

/** Resolve the same pinned producer defaults before any publication effect. */
export function publicationAuthorshipIntent(phase, input, { modelEnabled = true } = {}) {
  const implicit = effectivePhasePublicationProducer(phase, { modelEnabled });
  const authored = input.authored ?? (implicit === 'deterministic' ? 'deterministic' : null);
  const authorship = normalizeAuthorshipOptions({ producer: authored, channel: input.channel,
    imported: Boolean(input.from), externalAiUse: input.externalAiUse,
    changeOrigins: input.changeOrigins?.length ? input.changeOrigins : null });
  return Object.freeze({ authorship, legacyWarning: !input.authored && authored !== 'deterministic' });
}

export function assertPublicationAuthorshipIntent(phase, input, intent) {
  if (isConvergencePhase(phase) && input.from) {
    // Compatibility diagnostics remain exact; command rendering belongs to the host adapter.
    throw new SingularityFlowError('A deterministic convergence artifact cannot be imported.', {
      code: 'CONVERGENCE_ARTIFACT_KERNEL_OWNED', details: { phase: phase.id }
    });
  }
  if (input.from && !['human', 'external-tool'].includes(intent.authorship.producer)) {
    throw new SingularityFlowError('--from requires --authored human or --authored external-tool.', { code: 'MANUAL_AUTHORSHIP_REQUIRED' });
  }
  if ((input.usageFile || input.usage != null) && intent.authorship.producer !== 'governed-agent') {
    throw new SingularityFlowError('--usage-json is valid only with --authored governed-agent. Manual and deterministic publication record model usage as not-invoked.');
  }
  assertProducerAllowed(phase, intent.authorship.producer);
}
