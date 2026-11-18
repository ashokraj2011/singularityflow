/**
 * The approve view [SCF:REQ-008]: what approving a proposal lands on `sflow/config`, after any
 * re-apply, as plain lines: each workflow, field and value before and after, each file with its
 * changed lines, and each field both sides changed with the two values to pick from. The terminal
 * prints these lines, `workflow proposal --json` carries them as `viewLines` for Copilot and VS Code,
 * so every surface shows the same thing (finding ER-F6: the terminal showed only file names).
 */
import YAML from 'yaml';

const INLINE = 100;
const BLOCK_LINES = 40;
const TEXT_LINES = 60;
const DIFF_CELLS = 1_000_000;

/** A JSON pointer as a person reads it: `/workTypes/team-flow/phases` → `workTypes › team-flow › phases`. */
export function readablePointer(pointer) {
  if (!pointer || pointer === '/') return '(whole file)';
  return pointer.slice(1).split('/').map((part) => part.replace(/~1/gu, '/').replace(/~0/gu, '~')).join(' › ');
}

function valueLines(side, indent) {
  if (side == null) return { inline: '(not set)' };
  const { value } = side;
  if (value === null || typeof value !== 'object') return { inline: JSON.stringify(value) ?? String(value) };
  const inline = JSON.stringify(value);
  if (inline.length <= INLINE) return { inline };
  const block = YAML.stringify(value, { lineWidth: 0 }).trimEnd().split('\n');
  return { block: [...block.slice(0, BLOCK_LINES).map((line) => `${indent}${line}`),
    ...(block.length > BLOCK_LINES ? [`${indent}… ${block.length - BLOCK_LINES} more lines`] : [])] };
}

function fieldLines(change, indent) {
  const label = `${indent}${readablePointer(change.pointer)}:`;
  const before = valueLines(change.before, `${indent}    `);
  const after = valueLines(change.after, `${indent}    `);
  if (before.inline !== undefined && after.inline !== undefined) return [`${label} ${before.inline} → ${after.inline}`];
  // A long list or record on both sides: the lines that changed in it, not both whole copies.
  if (change.before && change.after) {
    const render = (side) => YAML.stringify(side.value, { lineWidth: 0 });
    return [label, ...changedTextLines(render(change.before), render(change.after), `${indent}  `)];
  }
  return [label,
    ...(before.inline !== undefined ? [`${indent}  before: ${before.inline}`] : [`${indent}  before:`, ...before.block]),
    ...(after.inline !== undefined ? [`${indent}  after:  ${after.inline}`] : [`${indent}  after:`, ...after.block])];
}

/** Lines removed and added between two texts, with unchanged runs folded; bounded for very long files. */
export function changedTextLines(before, after, indent = '    ') {
  const a = before == null ? [] : before.replace(/\n$/u, '').split('\n');
  const b = after == null ? [] : after.replace(/\n$/u, '').split('\n');
  if (a.length * b.length > DIFF_CELLS) return [`${indent}(${a.length} lines before, ${b.length} after: too long to show here; read it with git diff)`];
  // Longest common subsequence, then a walk that keeps one line of context around each change.
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const operations = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { operations.push([' ', a[i]]); i += 1; j += 1; }
    else if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) { operations.push(['+', b[j]]); j += 1; }
    else { operations.push(['-', a[i]]); i += 1; }
  }
  const keep = operations.map((operation, index) => operation[0] !== ' '
    || operations[index - 1]?.[0] === '+' || operations[index - 1]?.[0] === '-'
    || operations[index + 1]?.[0] === '+' || operations[index + 1]?.[0] === '-');
  const lines = [];
  let folded = false;
  operations.forEach(([kind, line], index) => {
    if (!keep[index]) { if (!folded) lines.push(`${indent}…`); folded = true; return; }
    folded = false;
    lines.push(`${indent}${kind} ${line}`);
  });
  if (lines.length > TEXT_LINES) return [...lines.slice(0, TEXT_LINES), `${indent}… ${lines.length - TEXT_LINES} more changed lines`];
  return lines;
}

function fileLines(file) {
  const head = `  ${file.status === 'added' ? 'New file' : file.status === 'removed' ? 'Removed file' : 'Changed file'} ${file.path}`;
  if (file.binary) return [`${head} (not text)`];
  if (Array.isArray(file.values)) {
    if (!file.values.length) return [`${head}: no value changes`];
    return [`${head}:`, ...file.values.flatMap((change) => fieldLines(change, '    '))];
  }
  return [`${head}:`, ...(file.mode ? [`    mode ${file.mode.before} → ${file.mode.after}`] : []),
    ...changedTextLines(file.text?.before ?? null, file.text?.after ?? null)];
}

/** A changed file by name only, for a proposal whose landing was not computed. */
function changedFileLine(entry) {
  if (typeof entry === 'string') return entry;
  const status = String(entry?.status ?? '').charAt(0);
  const verb = { A: 'new', M: 'changed', D: 'removed', R: 'renamed', C: 'copied' }[status] ?? 'changed';
  const paths = Array.isArray(entry?.paths) ? entry.paths : [entry?.path ?? entry?.file].filter(Boolean);
  return `${verb}: ${paths.join(' → ') || 'a file'}`;
}

function clashLines(clash, number) {
  const where = clash.kind === 'file' ? `${clash.path} (the whole file)` : clash.kind === 'mode' ? `${clash.path} (its file mode)`
    : `${clash.path}: ${readablePointer(clash.pointer)}`;
  const show = (label, side) => {
    if (clash.kind === 'file') {
      const text = side?.value ?? null;
      if (text == null) return [`    ${label}: (removed)`];
      const body = text.replace(/\n$/u, '').split('\n');
      return [`    ${label}:`, ...body.slice(0, 12).map((line) => `      ${line}`), ...(body.length > 12 ? [`      … ${body.length - 12} more lines`] : [])];
    }
    const value = valueLines(side, '      ');
    return value.inline !== undefined ? [`    ${label}: ${value.inline}`] : [`    ${label}:`, ...value.block];
  };
  return [`  ${number}. ${where}`, ...show('this proposal', clash.proposal), ...show('sflow/config now', clash.current),
    `    Pick one: --pick '${clash.key}=proposal' or --pick '${clash.key}=current'`];
}

/**
 * The approve view of `reviewed` (from `workflow proposal` / `inspectWorkflowConfigurationProposal`)
 * as lines. `approver`, when known, says whether approving is a self-approval [SCF:REQ-011, REQ-018].
 */
export function proposalViewLines(reviewed, { approver = null } = {}) {
  const made = reviewed.proposalCreatedAt ? `, made ${reviewed.proposalCreatedAt.slice(0, 16).replace('T', ' ')} UTC` : '';
  const by = reviewed.proposer?.name ? ` by ${reviewed.proposer.name}` : '';
  const lines = [`Proposal ${reviewed.branch}${made}${by}`, `  Revision ${reviewed.proposalCommit ?? '(unknown)'}`];
  if (reviewed.merged) return [...lines, `  Already in ${reviewed.targetBranch ?? 'sflow/config'}.`];
  for (const workflow of reviewed.workflows ?? []) lines.push(`  Workflow ${workflow.label ?? workflow.id}: ${workflow.change}`);
  const lands = reviewed.lands;
  if (!lands) {
    for (const entry of reviewed.changedFiles ?? []) lines.push(`  ${changedFileLine(entry)}`);
    if (!(reviewed.changedFiles ?? []).length) lines.push('  No file changes.');
  } else {
    lines.push('', `What approving it changes on ${reviewed.targetBranch ?? 'sflow/config'} now:`);
    if (!lands.fields.length) lines.push('  Nothing: sflow/config already has these changes.');
    for (const file of lands.fields) lines.push(...fileLines(file));
    for (const entry of lands.picked ?? []) lines.push(`  Your pick: ${entry.pick === 'proposal' ? "this proposal's value" : "sflow/config's value"} for ${entry.key}`);
    for (const key of lands.unused ?? []) lines.push(`  Not a field both changed, so this pick decides nothing: ${key}`);
    if (lands.clashes.length) {
      lines.push('', `Needs a choice: this proposal and ${reviewed.targetBranch ?? 'sflow/config'} both changed ${lands.clashes.length === 1 ? 'this field' : `these ${lands.clashes.length} fields`} since the proposal was made. Keep one value for each:`);
      lands.clashes.forEach((clash, index) => lines.push(...clashLines(clash, index + 1)));
    }
  }
  if ((reviewed.invalidFiles ?? []).length) lines.push(`  Not configuration, so it cannot be approved: ${reviewed.invalidFiles.join(', ')}`);
  if (reviewed.failure?.message) lines.push(`  It cannot be approved yet: ${reviewed.failure.message}`);
  const self = approver?.email && reviewed.proposer?.email && approver.email.trim().toLowerCase() === reviewed.proposer.email.trim().toLowerCase();
  // One policy for every approval [D4]: where self-approval is off, say so before anyone is asked to confirm.
  if (self && reviewed.approvalPolicy?.allowSelfApproval === false) {
    lines.push('', 'You proposed this, and this repository needs another person to approve configuration changes: someone else approves it.');
  } else if (self) {
    lines.push('', `You proposed this, so approving it is a self-approval: the approval commit records it as one${reviewed.approvalPolicy?.profile === 'poc' ? ' (a solo repository approves its own changes)' : ''}.`);
    // Whose approval it is when it names you in a group [owner, 2026-11-18]: said before anyone confirms.
    const groups = groupsAdding(reviewed, approver);
    if (groups.length) {
      lines.push((reviewed.workflows ?? []).some((row) => row.change === 'added')
        ? `This also puts you in ${groups.join(', ')}. If an earlier approved change removed you, you may still approve it yourself as the workflow's creator; the approval commit records that it put you back.`
        : `This also puts you in ${groups.join(', ')}. If an earlier approved change removed you, someone else must approve it.`);
    }
  }
  return lines;
}

/** The approval groups the landing adds `approver` to (by email or GitHub login), from its workflow.yml and portfolio.yml values. */
function groupsAdding(reviewed, approver) {
  const lower = (value) => String(value ?? '').trim().toLowerCase();
  const named = (entry) => Boolean(entry && typeof entry === 'object' && ((approver?.email && lower(entry.email) === lower(approver.email))
    || (approver?.githubLogin && lower(entry.githubLogin) === lower(approver.githubLogin))));
  const mentions = (value) => Boolean(value && typeof value === 'object'
    && (Array.isArray(value) ? value.some(mentions) : named(value) || Object.values(value).some(mentions)));
  const groups = new Set();
  for (const file of reviewed.lands?.fields ?? []) {
    if (!['singularity/workflow.yml', 'singularity/portfolio.yml'].includes(file.path) || !Array.isArray(file.values)) continue;
    for (const change of file.values) {
      const parts = String(change.pointer ?? '/').split('/').filter(Boolean).map((part) => part.replace(/~1/gu, '/').replace(/~0/gu, '~'));
      const before = change.before?.value, after = change.after?.value;
      if (parts.length && parts[0] !== 'approvalAuthorities') continue;
      if (parts.length >= 2) { if (mentions(after) && !mentions(before)) groups.add(parts[1]); continue; }
      // The whole file, or every group at once.
      const map = (value) => (parts.length ? value : value?.approvalAuthorities) ?? {};
      for (const [id, group] of Object.entries(map(after))) if (mentions(group) && !mentions(map(before)[id])) groups.add(id);
    }
  }
  return [...groups];
}
