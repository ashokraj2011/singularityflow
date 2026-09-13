/**
 * Lightweight, content-free TKR shadow records.
 *
 * This module deliberately has no dependency on the candidate composer. It is safe to load from
 * the legacy prompt path even when the optional shadow implementation is absent or damaged.
 */
import { createHash } from 'node:crypto';

import { deepFreeze, recordSha256 } from '../world-model/canonicalize.mjs';

export const TOKEN_REDUCTION_SHADOW_KIND = 'tkr/shadow-evaluation';
export const TOKEN_REDUCTION_SHADOW_FORMAT_VERSION = 1;

export function tokenReductionShadowDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function boundedTokenReductionShadowScope(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const boundedText = (entry) => entry == null ? null : String(entry).slice(0, 4096);
  const generation = source.generation == null ? null : Number(source.generation);
  return {
    workId: boundedText(source.workId),
    phase: boundedText(source.phase),
    generation: Number.isSafeInteger(generation) && generation >= 1 ? generation : null,
    sourceRevision: boundedText(source.sourceRevision),
    configurationSha256: boundedText(source.configurationSha256),
    executionMode: boundedText(source.executionMode)
  };
}

/** A non-authoritative failure projection which retains no diagnostic or prompt content. */
export function tokenReductionShadowFailure(error, scope = {}) {
  const suppliedCode = typeof error?.code === 'string' ? error.code : '';
  // Provider/module exceptions may put paths or free-form diagnostics in `code`. A durable
  // content-free observation carries only a stable machine code; the diagnostic itself is hashed.
  const code = /^[A-Z][A-Z0-9_.-]{0,127}$/u.test(suppliedCode)
    ? suppliedCode : 'TKR_SHADOW_FAILED';
  const core = {
    kind: TOKEN_REDUCTION_SHADOW_KIND,
    version: TOKEN_REDUCTION_SHADOW_FORMAT_VERSION,
    status: 'unavailable',
    scope: boundedTokenReductionShadowScope(scope),
    code,
    diagnosticSha256: tokenReductionShadowDigest(
      String(error?.message ?? error ?? 'unknown').slice(0, 4096)
    ),
    delivery: { state: 'shadow-not-delivered', candidateDelivered: false },
    receiptSha256: null
  };
  return deepFreeze({ ...core, shadowSha256: recordSha256(core), receipt: null });
}

export function verifyTokenReductionShadow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.kind !== TOKEN_REDUCTION_SHADOW_KIND
      || value.version !== TOKEN_REDUCTION_SHADOW_FORMAT_VERSION) return false;
  const copy = structuredClone(value);
  const received = copy.shadowSha256;
  delete copy.shadowSha256;
  delete copy.receipt;
  return received === recordSha256(copy);
}
