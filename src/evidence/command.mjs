/**
 * `singularity-flow evidence matrix [WORK-ID]` — the read-only evidence matrix [E2G-029].
 *
 * A view: it evaluates committed records in projection mode, runs no test and makes no network
 * call. The label it prints comes from the label module, so it can never read "Complete" from
 * lifecycle state alone.
 */
import { repoRoot } from '../git.mjs';
import { evaluateEvidence } from './evaluate.mjs';
import { loadEvidenceGraph } from './graph.mjs';
import { matrixCsv, matrixPage } from './matrix.mjs';
import { because, commandResult, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

export async function run(_argv, { positionals, options }) {
  const root = repoRoot();
  const format = optionString(options, 'format', optionBoolean(options, 'json') ? 'json' : 'human');
  if (!['human', 'json', 'csv'].includes(format)) throw new SingularityFlowError('--format must be human, json, or csv.');
  const graph = await loadEvidenceGraph(root, { workId: positionals[2] ?? null });
  const evaluation = evaluateEvidence(graph);
  let page;
  try {
    page = matrixPage(evaluation, {
      row: optionString(options, 'row'),
      facet: optionString(options, 'facet'),
      result: optionString(options, 'result'),
      page: optionString(options, 'page'),
      pageSize: optionString(options, 'page-size')
    });
  } catch (error) {
    throw new SingularityFlowError(error.message, { code: 'EVIDENCE_MATRIX_FILTER_INVALID' });
  }
  if (format === 'csv') return console.log(matrixCsv(page.rows));
  const { rows: _rows, ...overview } = evaluation;
  return emitCommandResult(commandResult({
    operation: { id: 'evidence.matrix', classification: 'read' },
    subject: { kind: 'story', id: evaluation.workId },
    outcome: succeeded('evidence.matrix.reported', {
      workId: evaluation.workId,
      rows: evaluation.summary.rows,
      satisfied: evaluation.summary.results.satisfied + evaluation.summary.results['satisfied-with-exception'],
      label: evaluation.completion.label
    }),
    effects: noEffects(),
    why: [because('evidence.from-committed-records', 'evidence', { ref: evaluation.workId })],
    restState: 'informational',
    data: { matrix: { evaluation: overview, page } }
  }), { json: format === 'json', restStateWhenIdle: 'informational' });
}
