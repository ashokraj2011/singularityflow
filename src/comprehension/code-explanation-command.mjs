/** Public read-only XPL command over the leased comprehension projection. */
import path from 'node:path';

import { loadDefinition } from '../config.mjs';
import { repoRoot } from '../git.mjs';
import { resolveModelProvider, invokeModel } from '../model-runner.mjs';
import {
  action, commandResult, noEffects, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { buildCodeExplanation } from './code-explanation.mjs';
import {
  buildCodeExplanationNarrativePrompt, codeExplanationNarrativeWordLimit,
  validateCodeExplanationNarrative
} from './code-explanation-narrative.mjs';
import { loadComprehensionIdeSlice } from './ide-slice.mjs';

function drilldown(options) {
  const values = ['hunk', 'symbol', 'clause']
    .map((name) => [name, optionString(options, name)])
    .filter(([, value]) => value != null);
  if (values.length > 1) throw new SingularityFlowError(
    'Code explanation accepts exactly one of --hunk, --symbol, or --clause.',
    { code: 'CMP_EXPLANATION_QUERY_INVALID' }
  );
  return values.length ? { [values[0][0]]: values[0][1] } : {};
}

function narrativeModelInput(explanation) {
  // The computed record contains only relative identities and bounded metadata. Clone before
  // sending so future presentation-only fields cannot accidentally widen the model boundary.
  return structuredClone(explanation);
}

function guidanceWord(value) {
  const text = String(value);
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(text)) {
    throw new SingularityFlowError('Code-explanation guidance contains an unsafe control character.', {
      code: 'CMP_EXPLANATION_QUERY_INVALID'
    });
  }
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(text)
    ? text
    : `'${text.replaceAll("'", `'"'"'`)}'`;
}

function narrationFollowup(options) {
  const argv = ['singularity-flow', 'explain', 'code'];
  for (const [name, flag] of [
    ['since', '--since'], ['work-id', '--work-id'], ['phase', '--phase'],
    ['hunk', '--hunk'], ['symbol', '--symbol'], ['clause', '--clause']
  ]) {
    const value = optionString(options, name);
    if (value != null) argv.push(flag, value);
  }
  argv.push('--narrate');
  return argv.map(guidanceWord).join(' ');
}

export function codeExplanationNarrativeSubject(root, { workId = null, phase = null } = {}) {
  return workId ? {
    kind: 'story', id: workId, workId, phase,
    repositoryId: path.basename(root), purpose: 'code-explanation-advisory'
  } : {
    kind: 'repository-code-explanation', id: path.basename(root), phase
  };
}

async function optionalNarrative(root, explanation, {
  requested, operation, length, workId, phase
}) {
  if (!requested) return null;
  if (operation?.id !== 'explain.code.narrate') return {
    status: 'unavailable', reason: 'model-disabled-fallback',
    banner: 'Narrative — advisory, not a record', authority: 'none', stored: false
  };
  try {
    const definition = await loadDefinition(root);
    const provider = resolveModelProvider(definition);
    const prompt = buildCodeExplanationNarrativePrompt(
      narrativeModelInput(explanation), { length }
    );
    const invocation = await invokeModel({
      provider: provider.provider,
      providerConfig: provider.providerConfig,
      model: provider.model,
      task: 'summarize',
      cwd: root,
      allowedRoots: [root],
      prompt: { text: prompt },
      channel: 'code-explanation-advisory',
      subject: codeExplanationNarrativeSubject(root, { workId, phase }),
      tools: { mode: 'none', names: [] },
      limits: { timeoutMs: 2 * 60 * 1000, outputBytes: 64 * 1024 }
    });
    return {
      status: 'available',
      ...validateCodeExplanationNarrative(invocation.output, explanation, { length })
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error?.code ?? 'XPL_NARRATIVE_UNAVAILABLE',
      banner: 'Narrative — advisory, not a record',
      authority: 'none',
      stored: false
    };
  }
}

export async function runCodeExplanation(_argv, {
  positionals, options, operation
}) {
  if (positionals[1] !== 'code' || positionals.length !== 2) {
    throw new SingularityFlowError(
      'Usage: singularity-flow explain code [--hunk H-ID | --symbol SYMBOL-ID | --clause CLAUSE-ID] '
      + '[--since REVISION] [--narrate] [--length brief|standard|long] [--json]',
      { code: 'CMP_EXPLANATION_QUERY_INVALID' }
    );
  }
  const root = repoRoot();
  const wantsNarrative = optionBoolean(options, 'narrate');
  const length = optionString(options, 'length', 'standard');
  if (!wantsNarrative && options.length != null) throw new SingularityFlowError(
    '--length is valid only with --narrate.', { code: 'XPL_NARRATIVE_LENGTH_INVALID' }
  );
  // A bad option is a command-contract error, not a provider outage. Validate it before entering
  // the optional-model fallback boundary so typos remain actionable refusals.
  if (wantsNarrative) codeExplanationNarrativeWordLimit(length);
  const slice = await loadComprehensionIdeSlice(root, {
    base: optionString(options, 'since'),
    workId: optionString(options, 'work-id'),
    phase: optionString(options, 'phase')
  });
  const explanation = buildCodeExplanation({
    context: slice.context,
    manifest: slice.manifest,
    diff: slice.diff,
    structure: slice.structure,
    evidence: slice.evidence,
    graph: slice.graph
  }, drilldown(options));
  const narrative = await optionalNarrative(root, explanation, {
    requested: wantsNarrative,
    operation,
    length,
    workId: slice.context.workId,
    phase: slice.context.phase
  });
  const next = [action({
    id: 'code-explanation.precheck',
    label: 'Inspect repository readiness without changing it.',
    command: 'singularity-flow precheck --quick --json',
    kind: 'informational'
  })];
  if (!wantsNarrative) next.unshift(action({
    id: 'code-explanation.narrate',
    label: 'Request a citation-checked advisory walkthrough.',
    command: narrationFollowup(options),
    skill: '/sf-explain-code',
    kind: 'informational',
    modelPolicy: 'optional'
  }));
  return emitCommandResult(commandResult({
    operation,
    subject: slice.context.workId
      ? { kind: 'story', id: slice.context.workId }
      : { kind: 'repository', id: path.basename(root) },
    outcome: succeeded('code-explanation.reported', {
      units: explanation.counts.returnedUnits,
      unexplained: explanation.unexplained.hunkIds.length
        + explanation.unexplained.opaqueUnitIds.length
    }),
    effects: noEffects(),
    next,
    restState: 'informational',
    data: {
      mode: 'observe-only',
      context: slice.context,
      explanation,
      narrative
    }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}
