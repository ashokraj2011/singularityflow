/**
 * `singularity-flow explain --subject <change|clause|test|line|gap|generation>` [XPL2 4.1].
 *
 * A read-only, model-free route over the same leased comprehension projection that `explain code`
 * and the VS Code Comprehension Center use. It never captures the global documentation route:
 * `explain <topic>` and `explain code` keep their exact existing meaning, and combining a positional
 * topic with `--subject` is refused rather than guessed.
 */
import path from 'node:path';

import { repoRoot } from '../../git.mjs';
import {
  action, commandResult, noEffects, succeeded
} from '../../narration/command-result.mjs';
import { emitCommandResult } from '../../narration/emit.mjs';
import { optionBoolean, optionNumber, optionString, SingularityFlowError } from '../../util.mjs';
import { loadComprehensionIdeSlice } from '../ide-slice.mjs';
import { explainXpl2Subject, normalizeXpl2Query } from './subjects.mjs';

/**
 * The initial wire payload goal [XPL2 18]: a bounded, labelled page rather than a silently truncated
 * whole. Measured as the compact UTF-8 JSON of the explanation after serialization; the shared
 * `--json` envelope around it is indented by the common emitter and is not part of this bound.
 */
export const XPL2_DEFAULT_MAXIMUM_BYTES = 64 * 1024;
const MINIMUM_BYTES = 8 * 1024;
const MAXIMUM_BYTES = 8 * 1024 * 1024;

const USAGE = 'Usage: singularity-flow explain --subject change|clause|test|line|gap|generation '
  + '[--id ID] [--path PATH --line N [--side before|after]] [--phase PHASE --gen N] '
  + '[--since REVISION] [--work-id ID] [--for reviewer|auditor|developer] [--max-bytes N] [--json]';

function refuse(message, code = 'XPL2_SUBJECT_INVALID') {
  throw new SingularityFlowError(message, { code });
}

function queryFromOptions(options) {
  return normalizeXpl2Query({
    subject: optionString(options, 'subject'),
    audience: optionString(options, 'for') ?? 'reviewer',
    id: optionString(options, 'id'),
    path: optionString(options, 'path'),
    line: optionString(options, 'line'),
    side: optionString(options, 'side'),
    phase: optionString(options, 'subject') === 'generation' ? optionString(options, 'phase') : null,
    generation: optionString(options, 'gen')
  });
}

/** Read the shadow-proof gap register through its owner. Absence is data, never an empty green set. */
async function readProofGaps(root, workId) {
  if (!workId) return null;
  try {
    const [{ loadDefinition }, { observeShadowProof }, { resolveShadowPassportDiagnostic }] = await Promise.all([
      import('../../config.mjs'),
      import('../../delivery-modes/proof-kernel.mjs'),
      import('../../delivery-modes/shadow-passport-service.mjs')
    ]);
    const definition = await loadDefinition(root);
    const { diagnostic } = await resolveShadowPassportDiagnostic(root, definition, workId, { proofProfile: 'standard' });
    const observation = observeShadowProof(diagnostic);
    return {
      proofSubjectSha256: observation.proofSubject?.proofSubjectSha256 ?? null,
      proofSummarySha256: observation.summary?.summarySha256 ?? null,
      gaps: Array.isArray(observation.gaps) ? observation.gaps : []
    };
  } catch {
    return null;
  }
}

function boundedModel(input, query, proof, maximumBytes) {
  let maximumUnits = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const model = explainXpl2Subject(input, query, { proof, maximumUnits });
    const bytes = Buffer.byteLength(JSON.stringify(model), 'utf8');
    if (bytes <= maximumBytes) return { model, bytes };
    const total = model.inventory.units.length;
    const current = maximumUnits ?? total;
    if (current <= 1) return { model, bytes };
    maximumUnits = Math.max(1, Math.floor(current / 2));
  }
  const model = explainXpl2Subject(input, query, { proof, maximumUnits: 1 });
  return { model, bytes: Buffer.byteLength(JSON.stringify(model), 'utf8') };
}

export async function runExplanationSubject(_argv, { positionals, options, operation }) {
  if (positionals.length !== 1) {
    refuse(`Choose either a documentation topic or --subject, not both. ${USAGE}`);
  }
  if (optionBoolean(options, 'narrate')) {
    refuse('Narration for --subject views is not part of this release; the computed view is complete without a model. '
      + '`singularity-flow explain code --narrate` remains available.', 'XPL2_NARRATION_UNAVAILABLE');
  }
  if (optionString(options, 'snapshot') != null) {
    refuse('Retained snapshots cannot be selected in this release. Use --since REVISION for an explicit Git baseline.', 'XPL2_SNAPSHOT_UNAVAILABLE');
  }
  const query = queryFromOptions(options);
  const requestedBytes = optionNumber(options, 'max-bytes');
  const maximumBytes = requestedBytes == null ? XPL2_DEFAULT_MAXIMUM_BYTES : requestedBytes;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < MINIMUM_BYTES || maximumBytes > MAXIMUM_BYTES) {
    refuse(`--max-bytes must be an integer from ${MINIMUM_BYTES} through ${MAXIMUM_BYTES}.`);
  }
  const root = repoRoot();
  // One leased capture supplies every input, including the Story state and clause sources, so a
  // subject view never mixes two repository moments [XPL2-REQ-004]. For the generation subject,
  // --phase names the subject, not the evidence context, so the context resolves as usual.
  const slice = await loadComprehensionIdeSlice(root, {
    base: optionString(options, 'since'),
    workId: optionString(options, 'work-id'),
    phase: query.subject === 'generation' ? null : optionString(options, 'phase'),
    includeExplanationInputs: true
  });
  const input = {
    context: slice.context,
    manifest: slice.manifest,
    codeExplanation: slice.codeExplanation,
    evidence: slice.evidence,
    workflow: slice.explanationInputs?.workflow ?? null,
    clauseSources: slice.explanationInputs?.clauseSources ?? null,
    replay: slice.replay,
    sourceReferences: slice.sourceReferences
  };
  const proof = query.subject === 'gap' ? await readProofGaps(root, slice.context.workId) : null;
  const { model, bytes } = boundedModel(input, query, proof, maximumBytes);
  const next = [
    action({
      id: 'explanation.gap',
      label: 'Inspect known gaps and visibility limits without changing anything.',
      command: 'singularity-flow explain --subject gap --json',
      kind: 'informational'
    }),
    action({
      id: 'explanation.code',
      label: 'Show the compatible code explanation for the same change.',
      command: 'singularity-flow explain code --json',
      skill: '/sf-explain-code',
      kind: 'informational'
    })
  ].filter((entry) => !(query.subject === 'gap' && entry.id === 'explanation.gap'));
  return emitCommandResult(commandResult({
    operation,
    subject: slice.context.workId
      ? { kind: 'story', id: slice.context.workId }
      : { kind: 'repository', id: path.basename(root) },
    outcome: succeeded('explanation.subject-reported', {
      subject: query.subject,
      status: model.subject.status,
      statements: model.selection.statements.length + model.derived.length
    }),
    effects: noEffects(),
    next,
    restState: 'informational',
    data: {
      mode: 'observe-only',
      context: {
        workId: slice.context.workId, phase: slice.context.phase,
        base: slice.context.base, source: slice.context.source
      },
      explanation: model,
      wire: { bytes, maximumBytes, measure: 'compact-utf8-json' }
    }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}
