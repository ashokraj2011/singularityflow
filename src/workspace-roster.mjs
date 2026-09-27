/** Deterministic, read-only presentation of the already-observed workspace registry. */

function cell(value) {
  return String(value ?? '—')
    .replace(/\r\n|[\r\n\u2028\u2029]/gu, ' ↵ ')
    .replace(/\t/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\\`|*_\[\]{}()#!]/gu, '\\$&');
}

function activeValue(row) {
  if (row.active === true || row.active === 'yes') return 'yes';
  if (row.active === false || row.active === '') return 'no';
  return row.active ?? '—';
}

function jiraValue(row) {
  // A local workspace anchor is not a Jira observation, even when it has an anchor key.
  if (row.siteId === 'local' || row.anchorType === 'Workspace') return null;
  return typeof row.anchorKey === 'string' && row.anchorKey ? row.anchorKey : null;
}

function hasCapabilities(row) {
  return typeof row.capabilities === 'string'
    || Array.isArray(row.capabilities) && row.capabilities.every((entry) => typeof entry === 'string');
}

function capabilitiesValue(row) {
  if (!hasCapabilities(row)) return '—';
  return Array.isArray(row.capabilities) ? row.capabilities.join(', ') || 'none'
    : row.capabilities || '—';
}

/**
 * Accept the existing workspace-list JSON array. No manifest, filesystem, Git, or selection is
 * consulted: row numbers are display-only and registry order/identity are preserved exactly.
 */
export function renderWorkspaceRoster(result) {
  if (!Array.isArray(result) || result.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new TypeError('Workspace roster requires the observed workspace-list array.');
  }
  const rows = result.filter((row) => !row.archivedAt);
  const footer = [
    'Row numbers are display-only. Choose one exact workspace ID, or its exact path when the ID is ambiguous.',
    '',
    'Copilot: `/sf-workspace`',
    'Shell: `singularity-flow workspace use <EXACT-WORKSPACE-ID-OR-PATH>`'
  ];
  if (!rows.length) return ['No non-archived registered workspaces.', '', ...footer].join('\n');

  const jira = rows.some((row) => jiraValue(row) !== null);
  const capabilities = rows.some(hasCapabilities);
  const headers = ['#', 'Workspace ID', 'Name', 'Active', 'Path',
    ...(jira ? ['Jira'] : []), ...(capabilities ? ['Capabilities'] : [])];
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row, index) => `| ${[index + 1, row.id, row.name, activeValue(row), row.path,
      ...(jira ? [jiraValue(row)] : []), ...(capabilities ? [capabilitiesValue(row)] : [])]
      .map(cell).join(' | ')} |`)
  ];
  const pathsById = new Map();
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id) continue;
    if (!pathsById.has(row.id)) pathsById.set(row.id, new Set());
    pathsById.get(row.id).add(row.path);
  }
  const ambiguous = [...pathsById].filter(([, paths]) => paths.size > 1).map(([id]) => cell(id));
  if (ambiguous.length) lines.push('',
    `Ambiguous workspace ID${ambiguous.length === 1 ? '' : 's'}: ${ambiguous.join(', ')}. The same ID is registered at different paths; select the exact path shown above, not the ID.`);
  return [...lines, '', ...footer].join('\n');
}
