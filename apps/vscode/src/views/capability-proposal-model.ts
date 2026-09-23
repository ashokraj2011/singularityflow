/**
 * Activation is an authority boundary, not a presentation inference.
 *
 * Older or malformed command output may omit `activated`; only the kernel's explicit positive
 * attestation can unlock a dependent workspace or onboarding journey.
 */
export function capabilityActivationSucceeded(value: unknown): boolean {
  return value != null && typeof value === 'object'
    && (value as { activated?: unknown }).activated === true;
}
