/**
 * `.xlsx` workbooks read and written by SFlow itself [CQF:REQ-060, REQ-061], with no dependency.
 *
 * The reader returns each sheet as rows of typed cells: shared and inline strings, numbers, booleans
 * and dates (date-formatted numbers, in either of Excel's date systems, and ISO `d` cells). A formula
 * is never evaluated: its cached value is the cell, and a formula without one is empty. Every bound is
 * checked before the text it guards is built, so a hostile workbook costs at most the limits.
 *
 * The writer makes the template and the report: inline strings, numbers and date cells, a bold
 * header, a frozen first row, stored in a plain zip. Excel, LibreOffice and Numbers open it.
 */
import { openZip, writeStoredZip, ZIP_LIMITS } from './zip.mjs';
import { SingularityFlowError } from '../../util.mjs';

export const SHEET_LIMITS = Object.freeze({ rows: 20_000, columns: 128, cellCharacters: 32_767, sharedStrings: 200_000 });

function unreadable(message, details = {}) {
  return new SingularityFlowError(`The workbook cannot be read: ${message}`, { code: 'FINDINGS_WORKBOOK_UNREADABLE', details });
}

const ENTITIES = Object.freeze({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" });

/** XML text as the characters it stands for, including OOXML's `_x000D_` escapes. */
export function xmlText(value) {
  return String(value ?? '')
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/giu, (whole, name) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
      const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/_x([0-9a-f]{4})_/giu, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function attributes(text) {
  const found = {};
  for (const match of String(text ?? '').matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/gu)) {
    found[match[1]] = xmlText(match[3] ?? match[4] ?? '');
  }
  return found;
}

/** The text of every `<t>` run in a string item, leaving out phonetic guides (`<rPh>`). */
function runText(xml) {
  const plain = String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/gu, '');
  let text = '';
  for (const match of plain.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/gu)) text += xmlText(match[1] ?? '');
  return text;
}

function part(zip, name, label) {
  const bytes = zip.read(name);
  if (!bytes) throw unreadable(`it has no ${label} (${name}).`);
  return bytes.toString('utf8');
}

/** `xl/worksheets/sheet1.xml` from a relationship target, which may be relative to `xl/` or absolute. */
function partName(target) {
  const value = String(target ?? '').replaceAll('\\', '/');
  if (value.startsWith('/')) return value.slice(1);
  const parts = [];
  for (const piece of `xl/${value}`.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece && piece !== '.') parts.push(piece);
  }
  return parts.join('/');
}

// Excel's built-in date and time formats.
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** Whether a custom number format shows a date: a d, m, y, h or s outside quotes and brackets. */
function isDateFormat(code) {
  const bare = String(code ?? '').replace(/"[^"]*"/gu, '').replace(/\[[^\]]*\]/gu, '').replace(/\\./gu, '');
  return /[dmyhs]/iu.test(bare) && !/^[#0.,%\s]*$/u.test(bare);
}

function dateStyles(stylesXml) {
  if (!stylesXml) return new Set();
  const custom = new Map();
  for (const match of stylesXml.matchAll(/<numFmt\b([^>]*)\/?>/gu)) {
    const found = attributes(match[1]);
    custom.set(Number(found.numFmtId), found.formatCode);
  }
  const styles = new Set();
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/u.exec(stylesXml)?.[1] ?? '';
  let index = 0;
  for (const match of cellXfs.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/gu)) {
    const id = Number(attributes(match[1]).numFmtId ?? 0);
    if (DATE_FORMAT_IDS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)))) styles.add(index);
    index += 1;
  }
  return styles;
}

/** An Excel serial day as an ISO date (time of day dropped), in the 1900 or the 1904 date system. */
export function excelSerialDate(serial, { date1904 = false } = {}) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const day = Math.floor(serial);
  // The 1900 system counts a 29 February 1900 that never was (serial 60), as Lotus did.
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : day >= 61 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31);
  if (!date1904 && day === 60) return '1900-02-29';
  return new Date(epoch + day * 86_400_000).toISOString().slice(0, 10);
}

/** The ISO date's Excel serial in the 1900 system, for the writer's date cells. */
export function isoDateSerial(iso) {
  const time = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(time) ? Math.round((time - Date.UTC(1899, 11, 30)) / 86_400_000) : null;
}

/** `B12` → 1 (zero-based column). */
function columnIndex(reference) {
  const letters = /^([A-Z]{1,3})\d*$/u.exec(String(reference ?? '').toUpperCase())?.[1];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

export function columnLetters(index) {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

function boundedCell(text) {
  return text.length > SHEET_LIMITS.cellCharacters ? text.slice(0, SHEET_LIMITS.cellCharacters) : text;
}

function cellValue(attrs, inner, shared, dates, date1904) {
  const type = attrs.t ?? 'n';
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/u.exec(inner)?.[1];
  if (type === 'inlineStr') return { type: 'string', value: boundedCell(runText(/<is\b[^>]*>([\s\S]*?)<\/is>/u.exec(inner)?.[1] ?? '')) };
  if (raw == null) return null;
  const text = xmlText(raw);
  if (type === 's') {
    const value = shared[Number(text)];
    return value == null ? null : { type: 'string', value };
  }
  if (type === 'str') return { type: 'string', value: boundedCell(text) };
  if (type === 'b') return { type: 'boolean', value: text.trim() === '1' || text.trim().toLowerCase() === 'true' };
  if (type === 'e') return { type: 'error', value: boundedCell(text) };
  if (type === 'd') return { type: 'date', value: text.trim().slice(0, 10) };
  const number = Number(text);
  if (!Number.isFinite(number)) return { type: 'string', value: boundedCell(text) };
  if (dates.has(Number(attrs.s ?? 0))) {
    const iso = excelSerialDate(number, { date1904 });
    if (iso) return { type: 'date', value: iso };
  }
  return { type: 'number', value: number };
}

function sheetRows(xml, shared, dates, date1904, sheet) {
  const rows = [];
  const data = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/u.exec(xml)?.[1] ?? '';
  let nextRow = 1;
  for (const match of data.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gu)) {
    const rowAttrs = attributes(match[1]);
    const number = Number.parseInt(rowAttrs.r ?? '', 10) || nextRow;
    nextRow = number + 1;
    if (number > SHEET_LIMITS.rows + 1) throw unreadable(`the ${sheet} sheet has more than ${SHEET_LIMITS.rows} rows.`, { sheet });
    const cells = [];
    let nextColumn = 0;
    for (const cell of String(match[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const attrs = attributes(cell[1]);
      const column = attrs.r ? columnIndex(attrs.r) ?? nextColumn : nextColumn;
      nextColumn = column + 1;
      if (column >= SHEET_LIMITS.columns) continue;
      const value = cellValue(attrs, cell[2] ?? '', shared, dates, date1904);
      if (value) cells[column] = value;
    }
    rows.push({ number, cells });
  }
  return rows;
}

/**
 * The sheets of an `.xlsx` workbook: `[{ name, rows: [{ number, cells: [{ type, value }] }] }]`, in
 * the workbook's order. Cells left blank are holes in `cells`.
 */
export function readXlsx(bytes, { limits = ZIP_LIMITS } = {}) {
  const zip = openZip(bytes, limits);
  const workbook = part(zip, 'xl/workbook.xml', 'workbook part');
  const date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/u.test(workbook);
  const relationships = new Map();
  for (const match of part(zip, 'xl/_rels/workbook.xml.rels', 'workbook relationships').matchAll(/<Relationship\b([^>]*)\/?>/gu)) {
    const found = attributes(match[1]);
    if (found.Id) relationships.set(found.Id, partName(found.Target));
  }
  const shared = [];
  const sharedXml = zip.read('xl/sharedStrings.xml')?.toString('utf8') ?? null;
  if (sharedXml) {
    for (const match of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/gu)) {
      if (shared.length >= SHEET_LIMITS.sharedStrings) throw unreadable(`it has more than ${SHEET_LIMITS.sharedStrings} distinct texts.`);
      shared.push(boundedCell(runText(match[1] ?? '')));
    }
  }
  const dates = dateStyles(zip.read('xl/styles.xml')?.toString('utf8') ?? null);
  const sheets = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/gu)) {
    const found = attributes(match[1]);
    const target = relationships.get(found['r:id'] ?? Object.entries(found).find(([key]) => key.endsWith(':id'))?.[1]);
    const name = String(found.name ?? '').slice(0, 64);
    if (!target || !zip.has(target)) continue;
    sheets.push({ name, rows: sheetRows(zip.read(target).toString('utf8'), shared, dates, date1904, name) });
  }
  if (!sheets.length) throw unreadable('it has no worksheet.');
  return sheets;
}

const escapeXml = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
  .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

const CONTENT_TYPES = (count) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
  Array.from({ length: count }, (_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`;

const ROOT_RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

// Style 0 plain, 1 a yyyy-mm-dd date, 2 the bold header.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function writtenCell(value, reference, style = null) {
  if (value == null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (value && typeof value === 'object' && value.date) {
    const serial = isoDateSerial(value.date);
    if (serial != null) return `<c r="${reference}" s="1"><v>${serial}</v></c>`;
    value = value.date;
  }
  return `<c r="${reference}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function worksheet(sheet) {
  const width = sheet.headers.length;
  const columns = sheet.headers.map((header, index) => `<col min="${index + 1}" max="${index + 1}" width="${Math.min(60, Math.max(12, String(header).length + 4, ...(sheet.widths?.[index] ? [sheet.widths[index]] : [])))}" customWidth="1"/>`).join('');
  const rows = [
    `<row r="1">${sheet.headers.map((header, index) => writtenCell(header, `${columnLetters(index)}1`, 2)).join('')}</row>`,
    ...sheet.rows.map((row, rowIndex) => `<row r="${rowIndex + 2}">${Array.from({ length: width }, (_, index) => writtenCell(row[index], `${columnLetters(index)}${rowIndex + 2}`)).join('')}</row>`)
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${columnLetters(Math.max(0, width - 1))}${sheet.rows.length + 1}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${columns}</cols><sheetData>${rows}</sheetData></worksheet>`;
}

/**
 * An `.xlsx` workbook of `sheets`: `[{ name, headers: [text], rows: [[value]] }]`. A value is text, a
 * number, a boolean or `{ date: 'YYYY-MM-DD' }`, written as a date cell.
 */
export function writeXlsx(sheets) {
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${
  sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
  sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')
}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  return writeStoredZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES(sheets.length) },
    { name: '_rels/.rels', data: ROOT_RELATIONSHIPS },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: relationships },
    { name: 'xl/styles.xml', data: STYLES },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: worksheet(sheet) }))
  ]);
}
