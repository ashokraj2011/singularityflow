/** Pure preferences; reading accounting settings must not load artifact execution. */
import { SingularityFlowError } from './util.mjs';
export const HARNESS_IMPORTS_HARD_MAXIMUM_BYTES = 65_536;
export const HARNESS_IMPORTS_DEFAULT_PREVIEW_BYTES = 16_384;
export const HARNESS_IMPORTS_DEFAULT_ENVELOPE_BYTES = 32_768;
export const HARNESS_IMPORTS_MODES = new Set(['off', 'record', 'enforce']);

export function normalizeHarnessImports(value = null) {
  if (value == null) return {
    mode: 'off', previewTextBytes: HARNESS_IMPORTS_DEFAULT_PREVIEW_BYTES,
    totalEnvelopeBytes: HARNESS_IMPORTS_DEFAULT_ENVELOPE_BYTES,
    knowledge: { enabled: false, maximumBytes: 8192 },
    conformance: { questionPrecedesMutation: 'off', maximumActions: 'off' }
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('harnessImports must be an object.');
  for (const key of Object.keys(value)) if (!['mode', 'previewTextBytes', 'totalEnvelopeBytes', 'knowledge', 'conformance'].includes(key)) throw new SingularityFlowError(`harnessImports contains unknown field '${key}'.`);
  const mode = value.mode ?? 'off';
  if (!HARNESS_IMPORTS_MODES.has(mode)) throw new SingularityFlowError('harnessImports.mode must be off, record, or enforce.');
  const previewTextBytes = value.previewTextBytes ?? HARNESS_IMPORTS_DEFAULT_PREVIEW_BYTES;
  if (!Number.isInteger(previewTextBytes) || previewTextBytes < 1 || previewTextBytes > HARNESS_IMPORTS_HARD_MAXIMUM_BYTES) {
    throw new SingularityFlowError(`harnessImports.previewTextBytes must be an integer from 1 through ${HARNESS_IMPORTS_HARD_MAXIMUM_BYTES}.`);
  }
  const totalEnvelopeBytes = value.totalEnvelopeBytes ?? HARNESS_IMPORTS_DEFAULT_ENVELOPE_BYTES;
  if (!Number.isInteger(totalEnvelopeBytes) || totalEnvelopeBytes < 1024 || totalEnvelopeBytes > HARNESS_IMPORTS_HARD_MAXIMUM_BYTES) {
    throw new SingularityFlowError(`harnessImports.totalEnvelopeBytes must be an integer from 1024 through ${HARNESS_IMPORTS_HARD_MAXIMUM_BYTES}.`);
  }
  if (previewTextBytes >= totalEnvelopeBytes) {
    throw new SingularityFlowError('harnessImports.previewTextBytes must be smaller than totalEnvelopeBytes so metadata remains bounded.');
  }
  const knowledge = value.knowledge ?? {};
  if (!knowledge || typeof knowledge !== 'object' || Array.isArray(knowledge)) throw new SingularityFlowError('harnessImports.knowledge must be an object.');
  for (const key of Object.keys(knowledge)) if (!['enabled', 'maximumBytes'].includes(key)) throw new SingularityFlowError(`harnessImports.knowledge contains unknown field '${key}'.`);
  const maximumBytes = knowledge.maximumBytes ?? 8192;
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > HARNESS_IMPORTS_HARD_MAXIMUM_BYTES) throw new SingularityFlowError(`harnessImports.knowledge.maximumBytes must be an integer from 1 through ${HARNESS_IMPORTS_HARD_MAXIMUM_BYTES}.`);
  const conformance = value.conformance ?? {};
  if (!conformance || typeof conformance !== 'object' || Array.isArray(conformance)) throw new SingularityFlowError('harnessImports.conformance must be an object.');
  const allowedCheckers = new Set(['verbatimRelay', 'questionPrecedesMutation', 'maximumActions', 'previewRespected']);
  const allowedModes = new Set(['off', 'observe', 'warn', 'enforce']);
  for (const [key, checkerMode] of Object.entries(conformance)) {
    if (!allowedCheckers.has(key)) throw new SingularityFlowError(`harnessImports.conformance contains unknown checker '${key}'.`);
    if (!allowedModes.has(checkerMode)) throw new SingularityFlowError(`harnessImports.conformance.${key} must be off, observe, warn, or enforce.`);
  }
  if (mode === 'enforce' && ['verbatimRelay', 'previewRespected'].some((key) => conformance[key] === 'enforce')) {
    throw new SingularityFlowError('Host-observed harness checkers cannot be enforced until exact host instrumentation is configured.');
  }
  return {
    mode, previewTextBytes, totalEnvelopeBytes,
    knowledge: { enabled: knowledge.enabled === true, maximumBytes },
    conformance: {
      verbatimRelay: conformance.verbatimRelay ?? 'off',
      questionPrecedesMutation: conformance.questionPrecedesMutation ?? 'off',
      maximumActions: conformance.maximumActions ?? 'off',
      previewRespected: conformance.previewRespected ?? 'off'
    }
  };
}
