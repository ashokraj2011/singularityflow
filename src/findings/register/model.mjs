/**
 * The findings register [CQF:REQ-062, REQ-063]: every security finding and TLM item SFlow knows of,
 * with the state SFlow keeps for it. One file per feed and one import history.
 *
 * `addItemsToRegister` is the one way items come in. An import calls it with an uploaded workbook's
 * rows; `findings sync` will call it with a source's rows (REQ-064). A later run from the same source
 * replaces that source's rows: what it no longer lists is marked, never deleted, and an item SFlow
 * fixed that only the security team can rescan closes once their list stops calling it open.
 *
 * The register is data. Nothing here reads a cell as an instruction; ids and repositories are the
 * validated forms from format.mjs.
 */
import { severityRank } from '../model.mjs';
import { FEEDS } from './format.mjs';

export const REGISTER_PATHS = Object.freeze({ security: 'findings/security.json', tlm: 'findings/tlm.json', imports: 'findings/imports.json' });

/**
 * What SFlow says of an item: open; in a Story (with the Story); fixed and waiting for its proof, or
 * for the security team's rescan; closed; an accepted risk or a waiver the source recorded; or open
 * in an earlier import and missing from the latest one.
 */
export const ITEM_STATES = Object.freeze(['open', 'in-story', 'fixed-awaiting-proof', 'fixed-awaiting-rescan', 'closed',
  'accepted-risk', 'waiver', 'not-in-latest-import']);
export const STATE_LABELS = Object.freeze({
  open: 'Open', 'in-story': 'In a Story', 'fixed-awaiting-proof': 'Fixed, awaiting proof', 'fixed-awaiting-rescan': 'Fixed, awaiting rescan',
  closed: 'Closed', 'accepted-risk': 'Accepted risk', waiver: 'Waiver', 'not-in-latest-import': 'Not in the latest import'
});
// Only an open item can be picked for a Story.
export const PICKABLE_STATES = Object.freeze(['open']);
export const MAXIMUM_ITEMS_PER_FEED = 10_000;
const MAXIMUM_IMPORTS_KEPT = 100;
const MAXIMUM_HISTORY = 20;

export function emptyRegister() {
  return {
    security: { schemaVersion: 1, kind: 'sflow-findings-register', feed: 'security', items: [] },
    tlm: { schemaVersion: 1, kind: 'sflow-findings-register', feed: 'tlm', items: [] },
    imports: { schemaVersion: 1, kind: 'sflow-findings-imports', imports: [] }
  };
}

/** One feed file, as stored, or an empty one; a file that is not a register is reported, not used. */
export function registerFile(feed, value) {
  const empty = emptyRegister()[feed];
  if (value == null) return { file: empty };
  if (!value || typeof value !== 'object' || !Array.isArray(feed === 'imports' ? value.imports : value.items)) {
    return { file: empty, damaged: true };
  }
  return { file: { ...empty, ...value } };
}

const isPast = (date, today) => Boolean(date) && date < today;

/** The state a source's row asks for: its Status, honouring an exception or waiver until it expires. */
function sourceState(item, today) {
  switch (item.status) {
    case 'fixed': case 'done': case 'false-positive': return 'closed';
    case 'accepted-risk': return isPast(item.exceptionExpiresAt, today) ? 'open' : 'accepted-risk';
    case 'waiver': return isPast(item.waiverExpiresAt, today) ? 'open' : 'waiver';
    default: return 'open';
  }
}

function withState(item, state, at, reason) {
  if (item.state === state) return item;
  const history = [...(item.history ?? []), { at, from: item.state ?? null, to: state, reason }].slice(-MAXIMUM_HISTORY);
  return { ...item, state, history };
}

const ROW_FIELDS_IGNORED = new Set(['sheet', 'row']);
const sameRow = (left, right) => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)].filter((key) => !ROW_FIELDS_IGNORED.has(key)));
  return [...keys].every((key) => JSON.stringify(left[key] ?? null) === JSON.stringify(right[key] ?? null));
};

/**
 * The register with `rows` from `source` added to `feed`, and what changed. `rows` are validated items
 * (format.mjs normalizeRow). With `replaceSource`, an open item of that source the rows no longer list
 * becomes "not in the latest import", and one fixed awaiting rescan closes.
 */
export function addItemsToRegister(register, feed, rows, { source, importId, at, replaceSource = true }) {
  if (!FEEDS.includes(feed)) throw new TypeError(`Unknown findings feed ${feed}.`);
  const today = at.slice(0, 10);
  const changes = { added: [], updated: [], unchanged: [], reopened: [], closed: [], notInLatest: [] };
  const byId = new Map(register[feed].items.map((item) => [item.id, item]));
  const seen = new Set();
  for (const row of rows) {
    seen.add(row.id);
    const { sheet, row: rowNumber, ...fields } = row;
    const existing = byId.get(row.id);
    const wanted = sourceState(fields, today);
    if (!existing) {
      byId.set(row.id, withState({ ...fields, source, firstSeenAt: at, lastSeenAt: at, lastImportId: importId, inLatestImport: true,
        story: null, evidence: [], history: [] }, wanted, at, `listed by ${source}`));
      changes.added.push(row.id);
      continue;
    }
    const previousRow = Object.fromEntries(Object.keys(fields).map((key) => [key, existing[key]]));
    let next = { ...existing, ...fields, source, lastSeenAt: at, lastImportId: importId, inLatestImport: true };
    if (wanted !== 'open') next = withState(next, wanted, at, `${source} lists it as ${fields.status}`);
    else if (['closed', 'accepted-risk', 'waiver', 'not-in-latest-import'].includes(existing.state)) {
      next = withState(next, 'open', at, `${source} lists it as open again`);
      changes.reopened.push(row.id);
    }
    // In a Story, fixed awaiting proof, or fixed awaiting a rescan the source has not done yet: kept.
    byId.set(row.id, next);
    if (next.state === 'closed' && existing.state !== 'closed') changes.closed.push(row.id);
    if (!changes.reopened.includes(row.id)) (sameRow(previousRow, fields) && next.state === existing.state ? changes.unchanged : changes.updated).push(row.id);
  }
  if (replaceSource) {
    for (const [id, item] of byId) {
      if (seen.has(id) || item.source !== source) continue;
      let next = { ...item, inLatestImport: false };
      if (item.state === 'fixed-awaiting-rescan') {
        next = withState(next, 'closed', at, `${source} no longer lists it`);
        changes.closed.push(id);
      } else if (item.state === 'open') {
        next = withState(next, 'not-in-latest-import', at, `${source} no longer lists it`);
        changes.notInLatest.push(id);
      }
      byId.set(id, next);
    }
  }
  const items = [...byId.values()].sort(compareItems).slice(0, MAXIMUM_ITEMS_PER_FEED);
  return { register: { ...register, [feed]: { ...register[feed], updatedAt: at, items } }, changes };
}

/** Most severe first, then nearest due date, then ID: the order every list shows. */
export function compareItems(left, right) {
  return severityRank(left.severity ?? 'info') - severityRank(right.severity ?? 'info')
    || String(left.dueAt ?? '9999').localeCompare(String(right.dueAt ?? '9999'))
    || String(left.id).localeCompare(String(right.id));
}

/** The register with one import's record added to its history (the newest 100 are kept). */
export function withImportRecord(register, record) {
  const imports = [...register.imports.imports.filter((entry) => entry.importId !== record.importId), record].slice(-MAXIMUM_IMPORTS_KEPT);
  return { ...register, imports: { ...register.imports, imports } };
}

/** Change the state of named items (a Story picked them, its change merged, ...), returning what moved. */
export function setItemStates(register, feed, ids, state, { at, reason, story = undefined, evidence = null }) {
  const wanted = new Set(ids);
  const moved = [];
  const items = register[feed].items.map((item) => {
    if (!wanted.has(item.id)) return item;
    let next = withState(item, state, at, reason);
    if (story !== undefined) next = { ...next, story };
    if (evidence) next = { ...next, evidence: [...(next.evidence ?? []), evidence].slice(-MAXIMUM_HISTORY) };
    if (next !== item) moved.push(item.id);
    return next;
  });
  return { register: { ...register, [feed]: { ...register[feed], updatedAt: at, items } }, moved };
}

/** Two copies of the register as one: per item, the copy changed last; every import once. */
export function mergeRegisters(base, overlay) {
  if (!overlay) return base;
  const merged = { ...base };
  for (const feed of FEEDS) {
    const byId = new Map(base[feed].items.map((item) => [item.id, item]));
    for (const item of overlay[feed].items) {
      const current = byId.get(item.id);
      const stamp = (entry) => entry?.history?.at(-1)?.at ?? entry?.lastSeenAt ?? '';
      if (!current || stamp(item) >= stamp(current)) byId.set(item.id, item);
    }
    merged[feed] = { ...base[feed], items: [...byId.values()].sort(compareItems) };
  }
  const imports = new Map(base.imports.imports.map((entry) => [entry.importId, entry]));
  for (const entry of overlay.imports.imports) imports.set(entry.importId, entry);
  merged.imports = { ...base.imports, imports: [...imports.values()].sort((left, right) => String(left.at).localeCompare(String(right.at))).slice(-MAXIMUM_IMPORTS_KEPT) };
  return merged;
}
