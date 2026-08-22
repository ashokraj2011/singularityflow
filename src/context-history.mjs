/** Exact-overlap historical analogues from visible completed work in the current repository. */
import path from 'node:path';

import { readRecord } from './schema-migrations.mjs';
import { run, secureRepositoryPath } from './util.mjs';

function values(plan, kinds) {
  return new Set((plan?.findings ?? []).filter((finding) => kinds.includes(finding.kind)).map((finding) => finding.subject));
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return [...left].filter((value) => rightSet.has(value)).sort();
}

async function jsonAt(root, relative, family = null) {
  await secureRepositoryPath(root, relative, { label: 'Historical context record', mustExist: true, type: 'file' });
  const shown = run('git', ['show', `HEAD:${relative}`], { cwd: root, allowFailure: true, maxBuffer: 8 * 1024 * 1024 });
  if (shown.status !== 0) throw new Error(`Historical context record '${relative}' is not committed at HEAD.`);
  const parsed = JSON.parse(shown.stdout);
  return family ? readRecord(family, parsed).record : parsed;
}

export async function findHistoricalAnalogues(root, definition, { workId = null, flightPlan = null, limit = 20 } = {}) {
  const workRoot = definition.workItemRoot ?? 'singularity/work-items';
  const tracked = run('git', ['ls-files', '-z', '--', `${workRoot}/*/workflow.json`], { cwd: root }).stdout
    .split('\0').filter(Boolean).sort();
  const wanted = {
    symbols: values(flightPlan, ['code-symbol', 'code-relationship']),
    paths: values(flightPlan, ['code-file', 'test-file', 'configuration', 'database-migration', 'build-configuration']),
    clauses: values(flightPlan, ['requirement-clause']),
    tests: values(flightPlan, ['test-file'])
  };
  const analogues = [];
  for (const workflowPath of tracked) {
    const candidate = await jsonAt(root, workflowPath, 'story-workflow').catch(() => null);
    if (!candidate?.workItem?.id || candidate.workItem.id === workId || candidate.status !== 'completed') continue;
    const directory = path.posix.dirname(workflowPath);
    const receiptPath = `${directory}/context/change-flight-plan/receipt.json`;
    const receipt = await jsonAt(root, receiptPath, 'change-flight-plan-receipt').catch(() => null);
    if (!receipt) continue;
    const accepted = receipt.acceptedImpact ?? [];
    const actualPaths = receipt.actualImpact?.actualPaths ?? [];
    const relationships = {
      symbols: intersection(wanted.symbols, accepted.filter((item) => ['code-symbol', 'code-relationship'].includes(item.kind)).map((item) => item.subject)),
      paths: intersection(wanted.paths, actualPaths),
      clauses: intersection(wanted.clauses, accepted.filter((item) => item.kind === 'requirement-clause').map((item) => item.subject)),
      tests: intersection(wanted.tests, actualPaths.filter((value) => /(?:test|spec)/i.test(value)))
    };
    const overlap = Object.values(relationships).reduce((total, entries) => total + entries.length, 0);
    if (!overlap) continue;
    analogues.push({
      workId: candidate.workItem.id,
      status: candidate.status,
      relationships,
      references: [{ kind: 'receipt', reference: receiptPath }],
      overlap
    });
  }
  return analogues.sort((left, right) => right.overlap - left.overlap || left.workId.localeCompare(right.workId)).slice(0, limit);
}
