const TITLES = {
  history: 'Retained work history',
  'committer-date': 'Git commits by committer date',
  'activity-during': 'Work with activity during the period',
  'completed-during': 'Work completed during the period',
  'currently-complete': 'Currently complete work',
  'as-of': 'Retained work status as of date'
};

function countText({ status, count }) {
  if (status === 'unavailable') return 'Coverage unavailable';
  const unit = count.unit.replace('-', ' ');
  if (status === 'partial') return [count.retrieved, unit, 'retrieved so far · Partial coverage'].join(' ');
  return count.total === 0 ? 'No matching ' + unit + ' · Complete coverage' : count.total + ' ' + unit + ' · Complete coverage';
}

/** Presentation labels shared by shell, the workspace page and VS Code. */
export function askHistoryDisplay({ history, comparison, coverage }) {
  if (!coverage) return null;
  const summary = [countText(coverage)];
  if (history) {
    const { scope, mode, basis, window } = history;
    if (scope.reference) summary.push([scope.reference, scope.revision, 'reachable Git ancestry'].filter(Boolean).join(' · '));
    else summary.push(['Retained state', scope.namespace, scope.snapshot, scope.workKind, scope.workId].filter(Boolean).join(' · '));
    if (window) summary.push(mode === 'as-of' ? ['Through', window.endDate, 'in', window.timeZone].join(' ')
      : [window.startDate, 'to', window.endDate, 'in', window.timeZone].join(' '));
    const rows = history.rows.map(row => basis === 'committed' ? {
      evidenceId: row.evidenceId,
      label: row.subject || row.commit.slice(0, 12),
      detail: row.committedAt + ' · ' + row.commit
    } : {
      evidenceId: row.evidenceId,
      label: [row.id, row.title && row.title !== row.id ? row.title : null].filter(Boolean).join(' · '),
      detail: [row.kind, row.status?.replaceAll('_', ' '), row.phase, row.event, row.completedAt ?? row.eventAt,
        row.activityCount ? String(row.activityCount) + ' events' : null, row.commit].filter(Boolean).join(' · ')
    });
    return { title: TITLES[mode], summary, rows };
  }
  if (comparison) {
    for (const end of [comparison.left, comparison.right]) summary.push(end.reference + ' · ' + (end.revision ?? 'Unavailable'));
    if (comparison.path) summary.push('Path · ' + comparison.path);
    const rows = comparison.rows.map(row => ({
      evidenceId: row.evidenceId,
      label: row.oldPath ? row.oldPath + ' → ' + row.path : row.path,
      detail: [
        { A: 'Added', D: 'Deleted', M: 'Modified', R: 'Renamed', T: 'Type changed' }[row.status] ?? row.status,
        row.binary ? 'Binary' : row.added === null ? 'Line counts unavailable' : '+' + row.added + ' / −' + row.removed
      ].join(' · ')
    }));
    return { title: 'Revision comparison', summary, rows, patch: comparison.patch };
  }
  return null;
}
