/** Public read-only XPL command over the leased comprehension projection. */
import path from 'node:path';

import { loadDefinition } from '../config.mjs';
import { repoRoot } from '../git.mjs';
import { resolveModelProvider, invokeModel } from '../model-runner.mjs';
import { summarizingRoute } from '../model-tiers.mjs';
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
      ...(await summarizingRoute(root, provider.model)),
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

const REPOSITORY_INCOMPATIBLE = ['narrate', 'length', 'since', 'hunk', 'symbol', 'clause', 'work-id', 'phase'];

/**
 * The `--repository` request, or null. `--repository` also takes a value in workspace commands, so
 * the parser hands it the next word: `explain code --repository src/pay` reads as that scope.
 */
function repositoryRequest(options) {
  const value = Array.isArray(options.repository) ? options.repository.at(-1) : options.repository;
  if (value === undefined) return null;
  const word = String(value).toLowerCase();
  if (['false', '0', 'no', 'off'].includes(word)) return null;
  const named = value === true || ['true', '1', 'yes', 'on'].includes(word) ? null : String(value);
  return { scope: optionString(options, 'path') ?? named };
}

/** `explain code --repository [--path DIR]`: what the repository holds, not what changed. */
async function runRepositoryExplanation(root, options, operation, scope) {
  const conflicting = REPOSITORY_INCOMPATIBLE.filter((name) => options[name] != null);
  if (conflicting.length) throw new SingularityFlowError(
    `--repository explains what the repository holds; it does not take ${conflicting.map((name) => `--${name}`).join(', ')}.`,
    { code: 'CMP_EXPLANATION_QUERY_INVALID' }
  );
  const { explainRepository } = await import('./repository-explanation.mjs');
  const explanation = await explainRepository(root, { scope, index: !optionBoolean(options, 'no-index') });
  const shown = explanation.scope.path ?? null;
  const overBudget = explanation.budget.status === 'over-budget';
  const folders = explanation.entries.filter((entry) => entry.kind === 'folder');
  const next = (overBudget ? folders : folders.filter((entry) => entry.files > 1)).slice(0, 3).map((entry, index) => action({
    id: `code-explanation.repository-folder-${index + 1}`,
    label: `Explain ${entry.path} (${entry.files} file${entry.files === 1 ? '' : 's'}).`,
    command: `singularity-flow explain code --repository --path ${guidanceWord(entry.path)}`,
    kind: 'informational'
  }));
  return emitCommandResult(commandResult({
    operation,
    subject: { kind: 'repository', id: path.basename(root) },
    outcome: overBudget
      ? succeeded('code-explanation.repository-over-budget', {
        scope: shown ?? 'The repository', files: explanation.budget.files ?? 'more',
        maxFiles: explanation.budget.maxFiles, maxMiB: Math.round(explanation.budget.maxBytes / (1024 * 1024))
      })
      : succeeded('code-explanation.repository-reported', {
        scope: shown ?? 'the repository', files: explanation.counts.files, symbols: explanation.counts.symbols,
        clauses: explanation.counts.clauses, indexed: explanation.index.built ? 'yes' : 'no'
      }),
    effects: noEffects(),
    next,
    restState: 'informational',
    data: { mode: 'observe-only', repository: explanation }
  }), { json: optionBoolean(options, 'json'), restStateWhenIdle: 'informational' });
}

export async function runCodeExplanation(_argv, {
  positionals, options, operation
}) {
  if (positionals[1] !== 'code' || positionals.length !== 2) {
    throw new SingularityFlowError(
      'Usage: singularity-flow explain code [--hunk H-ID | --symbol SYMBOL-ID | --clause CLAUSE-ID] '
      + '[--since REVISION] [--narrate] [--length brief|standard|long] [--json], '
      + 'or singularity-flow explain code --repository [--path DIR-OR-FILE] [--json]',
      { code: 'CMP_EXPLANATION_QUERY_INVALID' }
    );
  }
  const root = repoRoot();
  const repository = repositoryRequest(options);
  if (repository) return runRepositoryExplanation(root, options, operation, repository.scope);
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
    graph: slice.graph,
    codeScope: slice.codeScope
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
        + explanation.unexplained.opaqueUnitIds.length,
      hidden: explanation.scope.hiddenEntries
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
