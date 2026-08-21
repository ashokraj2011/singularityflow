/**
 * Model-free bug triage for the golden journey.
 *
 * The result names suspects and observations. It never upgrades a commit, path, or text match into
 * a cause: causation still requires a reproducer or equivalent governed evidence.
 */
import path from 'node:path';

import { branch, head } from '../../git.mjs';
import { analyzeRegression } from '../../regression-analysis.mjs';
import { SingularityFlowError, run } from '../../util.mjs';
import { noEffects, preservedAll, sflowResult } from '../result.mjs';

const MAX_MATCHES = 80;
const MAX_COMMITS = 20;
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'before', 'could', 'does', 'failed', 'failure', 'from',
  'have', 'into', 'issue', 'that', 'this', 'when', 'where', 'which', 'with', 'would'
]);

function nul(output) { return String(output ?? '').split('\0').filter(Boolean); }

function investigationTerms(symptom) {
  return [...new Set(String(symptom).toLowerCase().match(/[a-z0-9][a-z0-9_.-]{2,}/g) ?? [])]
    .filter((term) => !STOP_WORDS.has(term))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .slice(0, 5);
}

function changedPaths(root) {
  const status = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root, allowFailure: true
  });
  if (status.status !== 0) return null;
  return nul(status.stdout).map((row) => row.slice(3)).filter(Boolean).sort().slice(0, 200);
}

function textMatches(root, terms) {
  const matches = [];
  for (const term of terms) {
    const found = run('git', ['grep', '-n', '-I', '-F', '-e', term, '--', '.'], {
      cwd: root, allowFailure: true, maxBuffer: 2 * 1024 * 1024
    });
    if (![0, 1].includes(found.status)) continue;
    for (const row of found.stdout.split(/\r?\n/).filter(Boolean)) {
      const [file, line] = row.split(':', 3);
      if (!file || !/^\d+$/.test(line ?? '')) continue;
      matches.push({ term, path: file, line: Number(line) });
      if (matches.length >= MAX_MATCHES) return matches;
    }
  }
  return matches;
}

function recentCommits(root) {
  const result = run('git', [
    'log', `--max-count=${MAX_COMMITS}`, '--format=%H%x00%aI%x00%s'
  ], { cwd: root, allowFailure: true });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean).map((row) => {
    const [commit, authoredAt, subject] = row.split('\0');
    return { commit, short: commit.slice(0, 8), authoredAt, subject };
  });
}

function repositoryMatches(root, requested, context) {
  if (!requested) return true;
  return [root, context.repositoryId, context.repository?.id]
    .filter(Boolean).map(String).includes(String(requested));
}

function regressionCandidates(root, sinceRef) {
  if (!sinceRef) return { status: 'not-requested', candidates: [], caveat: null };
  try {
    const report = analyzeRegression(root, { base: sinceRef, bad: 'HEAD', maxCandidates: 20 });
    return {
      status: 'observed',
      range: report.range,
      candidates: report.candidates,
      caveat: report.caveat
    };
  } catch (error) {
    return {
      status: 'unavailable', candidates: [],
      reason: error.code ?? error.name ?? 'regression-analysis-unavailable', caveat: null
    };
  }
}

export function problemInvestigationResult({
  symptom, repositoryId, repository, terms, matches, paths, commits, regression, subject = null,
  assistedRequested = false
} = {}) {
  const boundedMatches = [...new Map(matches.map((entry) => [
    `${entry.path}:${entry.line}`, { path: entry.path, line: entry.line }
  ])).values()];
  return sflowResult({
    kind: 'read',
    operation: {
      id: assistedRequested ? 'problem.investigate.assisted' : 'problem.investigate',
      classification: 'read'
    },
    subject,
    outcome: {
      status: 'succeeded', messageId: 'gateway.read',
      slots: { matches: String(boundedMatches.length), commits: String(commits.length) }
    },
    effects: noEffects(),
    why: [{
      code: 'investigation.deterministic-triage', source: 'deterministic', reference: repository.head,
      slots: { matches: String(boundedMatches.length), terms: String(terms.length) }
    }],
    warnings: assistedRequested ? [{
      code: 'investigation.assistance-not-invoked', source: 'unavailable', slots: {}
    }] : [],
    preserved: preservedAll('investigation.nothing-was-carried-out', { reference: repositoryId }),
    restState: 'informational',
    data: {
      symptomProvided: Boolean(symptom),
      repository: { id: repositoryId, ...repository },
      observations: {
        searchTermCount: terms.length,
        textMatches: boundedMatches,
        changedPaths: paths,
        recentCommits: commits,
        regression
      },
      bounds: {
        maximumTextMatches: MAX_MATCHES,
        maximumRecentCommits: MAX_COMMITS,
        sourceBodiesIncluded: false
      },
      conclusion: null,
      caveat: 'These observations narrow investigation. Only a reproducer or equivalent evidence can establish a cause.',
      assisted: { requested: assistedRequested, invoked: false }
    }
  });
}

export async function problemInvestigate({ arguments: args = {}, subject = null, root = null, context = {}, assistedRequested = false } = {}) {
  const operationId = assistedRequested ? 'problem.investigate.assisted' : 'problem.investigate';
  if (!root) throw new SingularityFlowError(`${operationId} requires the repository root it should read.`, { code: 'PROBLEM_INVESTIGATE_NO_ROOT' });
  if (!repositoryMatches(root, args.repositoryId, context)) {
    return sflowResult({
      kind: 'refusal', operation: { id: operationId, classification: 'read' },
      outcome: { status: 'refused', messageId: 'gateway.refused', slots: { repository: args.repositoryId } },
      effects: noEffects(),
      why: [{ code: 'investigation.wrong-repository', source: 'deterministic', slots: { repository: args.repositoryId } }],
      preserved: preservedAll('investigation.nothing-was-carried-out', { reference: args.repositoryId }),
      restState: 'blocked'
    });
  }
  const terms = investigationTerms(args.symptom);
  return problemInvestigationResult({
    symptom: args.symptom,
    repositoryId: args.repositoryId ?? context.repositoryId ?? path.basename(root),
    // Machine paths are not evidence and must not cross into a result card or model context.
    repository: { branch: branch(root), head: head(root) },
    terms,
    matches: textMatches(root, terms),
    paths: changedPaths(root),
    commits: recentCommits(root),
    regression: regressionCandidates(root, args.sinceRef ?? null),
    subject,
    assistedRequested
  });
}

export function problemInvestigateAssisted(input = {}) {
  // The optional model boundary belongs to a host. The kernel planner returns the complete
  // deterministic fallback and truthfully says that no model was invoked in-process.
  return problemInvestigate({ ...input, assistedRequested: true });
}
