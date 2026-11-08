/**
 * `findings import FILE` [CQF:REQ-062]: an uploaded workbook or CSV file into the register.
 *
 * Reads, validates, normalises and de-duplicates the rows; an invalid row is reported with its sheet,
 * row number and reason while the rest import. The rows go in through `addItemsToRegister`, the same
 * seam a later `findings sync` uses. The import is recorded in the register's history: who imported,
 * when, the file's SHA-256 and name, the counts and every rejected row. The file itself is never
 * committed or copied anywhere; only the normalised rows are.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import { identity } from '../../git.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { ZIP_LIMITS } from '../workbook/zip.mjs';
import { readCsv } from '../workbook/csv.mjs';
import { readXlsx } from '../workbook/xlsx.mjs';
import { defaultSource, readFindingsConfig, sourceColumns } from './config.mjs';
import { FEEDS, matchHeaders, normalizeRow, repositoryMatches, sheetFeed } from './format.mjs';
import { addItemsToRegister, withImportRecord } from './model.mjs';
import { currentRepository, readRegister, registerDestination, registerLedger, writeRegister } from './store.mjs';

const SOURCE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MAXIMUM_REJECTED_KEPT = 200;

function fail(message, code = 'FINDINGS_IMPORT_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

/** A file name as it may be shown and kept: its base name, one line, bounded. */
const shownName = (file) => path.basename(file).replace(/[\u0000-\u001f\u007f]+/gu, ' ').slice(0, 128);

/** The feed a sheet whose name says nothing is: the one whose required headers it has, if only one. */
function feedFromHeaders(cells, columnsFor) {
  const fits = FEEDS.filter((feed) => !matchHeaders(feed, cells, columnsFor(feed)).missing.length);
  return fits.length === 1 ? fits[0] : null;
}

/** The sheets to read and the feed each is, and the sheets left out with why. */
function chooseSheets(sheets, { feed, csv, columnsFor }) {
  const chosen = [];
  const ignored = [];
  for (const sheet of sheets) {
    const named = csv ? null : sheetFeed(sheet.name);
    const headers = sheet.rows[0]?.number === 1 ? sheet.rows[0].cells : [];
    let as = named;
    if (feed) as = named === feed || (!named && (sheets.length === 1 || csv)) ? feed : null;
    else if (!named && (csv || sheets.length === 1)) as = feedFromHeaders(headers, columnsFor);
    if (as) chosen.push({ sheet, feed: as });
    else ignored.push({ sheet: sheet.name, reason: feed ? `it is not the ${feed === 'tlm' ? 'TLM' : 'Security'} sheet`
      : named ? 'not chosen' : 'its name is not Security or TLM; name the list with --feed security|tlm' });
  }
  return { chosen, ignored };
}

/** Rows of one sheet as valid items and rejected rows. */
function readSheet(sheet, feed, columns) {
  const name = sheet.name;
  const header = sheet.rows[0];
  if (!header || header.number !== 1) return { items: [], rejected: [{ sheet: name, row: 1, reason: 'the first row holds no headers' }], unknown: [] };
  const { indexes, missing, unknown } = matchHeaders(feed, header.cells, columns);
  const dataRows = sheet.rows.slice(1);
  if (missing.length) {
    const reason = `the sheet has no ${missing.join(', ')} column (map other headers in singularity/findings.yml columns:)`;
    return { items: [], rejected: [{ sheet: name, row: 1, reason }], sheetError: reason, unknown, skippedRows: dataRows.length };
  }
  const items = [];
  const rejected = [];
  const first = new Map();
  for (const row of dataRows) {
    const result = normalizeRow(feed, row, indexes);
    if (result.empty) continue;
    if (result.reason) { rejected.push({ sheet: name, row: row.number, reason: result.reason }); continue; }
    if (first.has(result.item.id)) {
      rejected.push({ sheet: name, row: row.number, reason: `ID ${result.item.id} appears again (first on row ${first.get(result.item.id)})` });
      continue;
    }
    first.set(result.item.id, row.number);
    items.push({ ...result.item, sheet: name, row: row.number });
  }
  return { items, rejected, unknown };
}

/**
 * Import `file` into the register. Returns what was read, what changed and where the register went.
 * `runCommand` stands in for the process runner in tests (the visibility check's gh).
 */
export async function importFindings(root, file, {
  feed = null, source = null, dryRun = false, env = process.env, runCommand = undefined, now = new Date()
} = {}) {
  if (feed && !FEEDS.includes(feed)) fail(`--feed is security or tlm, not '${String(feed).slice(0, 40)}'.`);
  if (source != null && (!SOURCE.test(source) || source.length > 64)) fail('--source is a lower-kebab name of at most 64 characters, such as security-team.');
  const absolute = path.resolve(file);
  const entry = await lstat(absolute).catch(() => null);
  if (!entry?.isFile()) fail(`${absolute} is not a file.`, 'FINDINGS_IMPORT_FILE_MISSING', { path: absolute });
  if (entry.size > ZIP_LIMITS.fileBytes) fail(`${absolute} is larger than ${ZIP_LIMITS.fileBytes} bytes.`, 'FINDINGS_WORKBOOK_UNREADABLE', { path: absolute });
  const bytes = await readFile(absolute);
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const zip = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
  const extension = path.extname(absolute).toLowerCase();
  const csv = !zip && ['.csv', '.tsv', '.txt'].includes(extension);
  if (!zip && !csv) fail(`${shownName(absolute)} is neither an .xlsx workbook nor a CSV file. Save it from Excel as .xlsx, or export the sheet as CSV.`, 'FINDINGS_WORKBOOK_UNREADABLE');
  const sheets = csv ? readCsv(bytes, { name: shownName(absolute) }) : readXlsx(bytes);

  const config = await readFindingsConfig(root);
  const chosenSource = source ?? defaultSource(config, feed ? [feed] : FEEDS);
  const columnsFor = (name) => sourceColumns(config, name, chosenSource);
  const { chosen, ignored } = chooseSheets(sheets, { feed, csv, columnsFor });
  const perFeed = Object.fromEntries(FEEDS.map((name) => [name, { items: [], rejected: [], unknown: [], sheets: [] }]));
  for (const { sheet, feed: as } of chosen) {
    const read = readSheet(sheet, as, columnsFor(as));
    const target = perFeed[as];
    // Two sheets of one list: the later sheet's repeat of an ID is rejected like a repeat in one sheet.
    const known = new Map(target.items.map((item) => [item.id, item]));
    for (const item of read.items) {
      if (known.has(item.id)) target.rejected.push({ sheet: sheet.name, row: item.row, reason: `ID ${item.id} appears again (first on ${known.get(item.id).sheet} row ${known.get(item.id).row})` });
      else { known.set(item.id, item); target.items.push(item); }
    }
    target.rejected.push(...read.rejected);
    target.unknown.push(...read.unknown);
    target.sheets.push({ name: sheet.name, ...(read.sheetError ? { error: read.sheetError, rowsSkipped: read.skippedRows } : {}) });
  }
  const feeds = FEEDS.filter((name) => perFeed[name].sheets.length);

  const ledger = await registerLedger(root);
  const repository = await currentRepository(root, ledger, { env });
  const at = now.toISOString();
  const importId = `IMP-${at.replace(/[-:]/gu, '').slice(0, 15)}-${sha256.slice(7, 13)}`;
  const who = identity(root, { offline: true, env });
  const counts = {};
  const apply = (register) => {
    let next = register;
    for (const name of feeds) {
      const { register: added, changes } = addItemsToRegister(next, name, perFeed[name].items, { source: chosenSource, importId, at });
      next = added;
      counts[name] = {
        rows: perFeed[name].items.length + perFeed[name].rejected.length,
        imported: perFeed[name].items.length,
        rejected: perFeed[name].rejected.length,
        otherRepositories: perFeed[name].items.filter((item) => !repositoryMatches(item.repository, repository)).length,
        ...Object.fromEntries(Object.entries(changes).map(([key, ids]) => [key, ids.length])),
        changed: { added: changes.added.slice(0, 50), reopened: changes.reopened.slice(0, 50), closed: changes.closed.slice(0, 50), notInLatest: changes.notInLatest.slice(0, 50) }
      };
    }
    const rejected = feeds.flatMap((name) => perFeed[name].rejected);
    return withImportRecord(next, {
      importId, at, by: { name: who?.name ?? null, email: who?.email ?? null }, source: chosenSource,
      file: { name: shownName(absolute), sha256, bytes: bytes.length, format: csv ? 'csv' : 'xlsx' }, feeds,
      counts: Object.fromEntries(feeds.map((name) => [name, Object.fromEntries(Object.entries(counts[name]).filter(([key]) => key !== 'changed'))])),
      rejected: rejected.slice(0, MAXIMUM_REJECTED_KEPT), rejectedNotKept: Math.max(0, rejected.length - MAXIMUM_REJECTED_KEPT),
      ignoredSheets: ignored
    });
  };

  const base = {
    schemaVersion: 1, resultType: 'sflow-findings-import', dryRun, importId, source: chosenSource,
    file: { name: shownName(absolute), sha256, bytes: bytes.length, format: csv ? 'csv' : 'xlsx' },
    repository: { slug: repository.slug, name: repository.name },
    sheets: feeds.flatMap((name) => perFeed[name].sheets.map((sheet) => ({ ...sheet, feed: name }))),
    ignoredSheets: ignored,
    unknownHeaders: Object.fromEntries(feeds.filter((name) => perFeed[name].unknown.length).map((name) => [name, [...new Set(perFeed[name].unknown)]])),
    rejected: feeds.flatMap((name) => perFeed[name].rejected),
    warnings: [...config.warnings]
  };
  if (!feeds.length) {
    return { ...base, store: null, feeds: {}, nothingImported: true,
      message: 'No sheet was read. Name the sheets Security and TLM, or name the list with --feed security|tlm.' };
  }
  if (dryRun) {
    const current = await readRegister(root, { env, ledger });
    apply(current.register);
    const destination = await registerDestination(root, ledger, { env, ...(runCommand ? { runCommand } : {}) });
    return { ...base, feeds: counts, store: destination.store, storeReason: destination.reason, storeMessage: destination.message, written: false };
  }
  const destination = await registerDestination(root, ledger, { env, ...(runCommand ? { runCommand } : {}) });
  const written = await writeRegister(root, ledger, destination, apply,
    `import ${importId} from ${chosenSource}: ${feeds.map((name) => `${name} ${counts[name]?.imported ?? 0} rows`).join(', ')}`, { env });
  return {
    ...base, feeds: counts, store: written.store, storeReason: written.reason, storeMessage: written.message,
    ...(written.store === 'state-branch' ? { branch: ledger.branch, commit: written.commit ?? null } : {}), written: true
  };
}
