import { SingularityFlowError, run } from './util.mjs';

function git(root, args, { allowFailure = false } = {}) {
  return run('git', args, { cwd: root, allowFailure });
}

function resolveCommit(root, ref, label) {
  const result = git(root, ['rev-parse', '--verify', `${ref}^{commit}`], { allowFailure: true });
  if (result.status !== 0) throw new SingularityFlowError(`${label} '${ref}' is not a commit.`);
  return result.stdout.trim();
}

function changedFiles(root, commit) {
  return [...new Set(git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', commit]).stdout.split(/\r?\n/).filter(Boolean))].sort();
}

function numstat(root, commit) {
  let added = 0; let deleted = 0;
  for (const line of git(root, ['diff-tree', '--no-commit-id', '--numstat', '-r', '-m', commit]).stdout.split(/\r?\n/)) {
    const [a, d] = line.split('\t');
    if (/^\d+$/.test(a)) added += Number(a);
    if (/^\d+$/.test(d)) deleted += Number(d);
  }
  return { added, deleted };
}

/** Read-only Git-history triage. It identifies suspects; it never claims causation without a reproducer. */
export function analyzeRegression(root, { base = 'main', good = null, bad = 'HEAD', paths = [], maxCandidates = 20 } = {}) {
  const badCommit = resolveCommit(root, bad, 'Bad revision');
  const remoteBase = git(root, ['rev-parse', '--verify', `origin/${base}^{commit}`], { allowFailure: true });
  const baseRef = remoteBase.status === 0 ? `origin/${base}` : base;
  const baseCommit = resolveCommit(root, baseRef, 'Base revision');
  const goodCommit = good
    ? resolveCommit(root, good, 'Good revision')
    : git(root, ['merge-base', baseCommit, badCommit]).stdout.trim();
  if (goodCommit === badCommit) throw new SingularityFlowError('The good and bad revisions resolve to the same commit; there is no regression range to analyze.');
  if (git(root, ['merge-base', '--is-ancestor', goodCommit, badCommit], { allowFailure: true }).status !== 0) {
    throw new SingularityFlowError(`Good revision ${goodCommit.slice(0, 8)} is not an ancestor of bad revision ${badCommit.slice(0, 8)}.`);
  }
  const commits = git(root, ['rev-list', '--ancestry-path', '--reverse', `${goodCommit}..${badCommit}`]).stdout.split(/\r?\n/).filter(Boolean);
  const candidates = commits.map((commit, index) => {
    const fields = git(root, ['show', '-s', '--format=%H%x00%P%x00%an%x00%aI%x00%s', commit]).stdout.trim().split('\0');
    const files = changedFiles(root, commit);
    const matchedPaths = paths.filter((requested) => files.some((file) => file === requested || file.startsWith(`${requested.replace(/\/$/, '')}/`)));
    const parents = (fields[1] ?? '').split(/\s+/).filter(Boolean);
    const keyword = /\b(fix|bug|regression|hotfix|revert|incident)\b/i.test(fields[4] ?? '');
    // A merge wrapper is important context, but the direct path-changing commit is normally the
    // more useful code-level suspect. Avoid counting the same path at full weight twice.
    const score = matchedPaths.length * (parents.length > 1 ? 2 : 10) + (parents.length > 1 ? 4 : 0) + (keyword ? 3 : 0) + Math.max(0, 2 - index / Math.max(commits.length, 1));
    return {
      commit: fields[0], short: fields[0].slice(0, 8), parents, merge: parents.length > 1,
      author: fields[2], authoredAt: fields[3], subject: fields[4], files, matchedPaths,
      ...numstat(root, commit), score: Number(score.toFixed(3))
    };
  }).sort((a, b) => b.score - a.score || a.authoredAt.localeCompare(b.authoredAt));
  const limit = Number.isInteger(maxCandidates) && maxCandidates > 0 ? Math.min(maxCandidates, 100) : 20;
  return {
    schemaVersion: 1,
    base: { ref: baseRef, commit: baseCommit },
    good: goodCommit,
    bad: badCommit,
    range: `${goodCommit}..${badCommit}`,
    paths,
    commitCount: commits.length,
    candidates: candidates.slice(0, limit),
    mergeCommits: candidates.filter((candidate) => candidate.merge).map((candidate) => candidate.commit),
    caveat: 'Ranking narrows investigation. Only a reproducible failing test or equivalent evidence can establish the causal commit.'
  };
}

export function regressionReportMarkdown(report) {
  const lines = [
    '# Regression investigation', '',
    `Range: \`${report.good.slice(0, 8)}..${report.bad.slice(0, 8)}\` (${report.commitCount} commits)`,
    report.paths.length ? `Focused paths: ${report.paths.map((item) => `\`${item}\``).join(', ')}` : 'Focused paths: none', '',
    '| Rank | Commit | Kind | Subject | Files | Score |', '|---:|---|---|---|---:|---:|'
  ];
  report.candidates.forEach((item, index) => lines.push(`| ${index + 1} | \`${item.short}\` | ${item.merge ? 'merge' : 'commit'} | ${item.subject.replace(/\|/g, '\\|')} | ${item.files.length} | ${item.score} |`));
  lines.push('', `> ${report.caveat}`, '', 'Inspect the highest-ranked diffs, correlate them with the failing behavior and repository world model, then prove or reject each hypothesis with a reproducer.');
  return `${lines.join('\n')}\n`;
}
