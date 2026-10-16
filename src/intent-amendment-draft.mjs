/**
 * A drafted intent amendment: where the specification must catch up with the code. [spec-code sync]
 *
 * An intent amendment is the Story's whole scope document with its clauses changed, proposed for a
 * person to approve (`story intent-amendment propose`). Writing it from nothing meant finding, by
 * hand, every clause a person had already said the code was right about. This drafts it from the
 * approved bytes, model-free, with a marked slot wherever the text must change:
 *
 * - a clause dispositioned `update-intent` in convergence gets a revise slot in its own row, with the
 *   finding and the reason a person gave;
 * - a clause of a closed Story that `spec drift decide --adopt --story <this Story>` handed here gets
 *   a new clause in this Story's namespace, with the old statement, the drift and the paths, and a
 *   planned-evidence row marking that code `existing`.
 *
 * Slots are single-line HTML comments, so tables stay tables. A person or the Story's agent writes
 * the wording; `propose` refuses while any `sflow-draft:` slot is left.
 */
export const DRAFT_MARKER = 'sflow-draft:';

/** One single-line comment slot, safe inside a table cell. */
export function draftSlot(text) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').replace(/-->/gu, '- ->').replace(/\|/gu, '/').trim().slice(0, 1200);
  return `<!-- ${DRAFT_MARKER} ${clean} -->`;
}

/** Whether a document still has a slot nobody filled. */
export function hasDraftSlots(text) {
  return String(text ?? '').includes(DRAFT_MARKER);
}

const isRow = (line) => /^\s*\|.*\|\s*$/u.test(line);
const cells = (line) => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());

/** Every Markdown table: its first and last line (0-based) and its header cells. */
function tables(lines) {
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isRow(lines[index]) || (index > 0 && isRow(lines[index - 1]))) continue;
    let end = index;
    while (end + 1 < lines.length && isRow(lines[end + 1])) end += 1;
    if (end - index >= 1) found.push({ start: index, end, header: cells(lines[index]).map((cell) => cell.toLowerCase()) });
    index = end;
  }
  return found;
}

/** Insert a slot into the clause's own line: in a table row, inside its last cell. */
function withSlot(line, slot) {
  return isRow(line) ? line.replace(/\s*\|\s*$/u, ` ${slot} |`) : `${line.replace(/\s+$/u, '')} ${slot}`;
}

/**
 * The draft text and what it marked. `clauses` is `extractClauses` over `text`; `namespace` is this
 * Story's; `revisions` are `{ clauseId, why[] }`; `additions` are `{ fromWorkId, fromClauseId, type,
 * statement, evidence[], productPaths[], testPaths[] }`.
 */
export function buildIntentAmendmentDraft({ text, clauses, namespace, revisions = [], additions = [], proposeCommand }) {
  const lines = String(text).split('\n');
  const slots = [];
  const inserts = new Map();
  for (const revision of revisions) {
    const clause = clauses.find((entry) => entry.id === revision.clauseId);
    if (!clause) continue;
    const index = Number(clause.source?.line) - 1;
    if (!(index >= 0 && index < lines.length)) continue;
    lines[index] = withSlot(lines[index], draftSlot(`revise ${clause.id} so it says what the code does. ${revision.why.join(' ')}`));
    slots.push({ kind: 'revise', clauseId: clause.id, line: index + 1 });
  }
  const used = new Map();
  const nextId = (type) => {
    const highest = Math.max(0, ...clauses.filter((entry) => entry.namespace === namespace && entry.type === type).map((entry) => Number(entry.number) || 0),
      used.get(type) ?? 0);
    used.set(type, highest + 1);
    return `${namespace}:${type}-${String(highest + 1).padStart(3, '0')}`;
  };
  const found = tables(lines);
  const appended = [];
  for (const addition of additions) {
    const type = /^[A-Z]{2,4}$/u.test(String(addition.type ?? '')) ? addition.type : 'REQ';
    const id = nextId(type);
    const statement = draftSlot(`state the behaviour that replaces ${addition.fromClauseId} of closed Story ${addition.fromWorkId}`
      + `${addition.statement ? ` ("${addition.statement}")` : ''} as the code now has it. ${addition.evidence.join(' ')}`);
    // The table that already holds this kind of clause, else a section of its own at the end.
    const clauseTable = found.find((table) => lines.slice(table.start, table.end + 1).some((line) => line.includes(`[${namespace}:${type}-`)));
    if (clauseTable) {
      const row = [`[${id}]`, statement, ...Array(Math.max(0, clauseTable.header.length - 2)).fill('')];
      const list = inserts.get(clauseTable.end) ?? [];
      list.push(`| ${row.join(' | ')} |`);
      inserts.set(clauseTable.end, list);
    } else {
      appended.push(`- [${id}] ${statement}`);
    }
    const plan = found.find((table) => table.header.some((cell) => cell.includes('expected paths')));
    if (plan) {
      const code = (paths) => paths.map((entry) => `\`${entry}\``).join(', ');
      const row = plan.header.map((cell) => cell.startsWith('clause') ? `\`${id}\``
        : cell.includes('expected paths') ? code(addition.productPaths)
          : cell.includes('planned tests') ? code(addition.testPaths)
            : cell.startsWith('fulfillment') ? 'existing'
              : cell.includes('observable') ? draftSlot(`what the adopted behaviour visibly does for ${id}`) : '');
      const list = inserts.get(plan.end) ?? [];
      list.push(`| ${row.join(' | ')} |`);
      inserts.set(plan.end, list);
    }
    slots.push({ kind: 'add', clauseId: id, from: addition.fromClauseId });
  }
  const output = [];
  lines.forEach((line, index) => {
    output.push(line);
    for (const extra of inserts.get(index) ?? []) output.push(extra);
  });
  if (appended.length) output.push('', '## Adopted behaviour', '', ...appended);
  output.push('', draftSlot(`drafted from the approved specification. Replace every ${DRAFT_MARKER} slot with the clause wording and delete`
    + ` this line, then propose it: ${proposeCommand}`));
  return { text: `${output.join('\n').replace(/\n*$/u, '')}\n`, slots };
}
