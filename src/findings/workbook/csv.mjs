/**
 * A CSV file read as one sheet of text cells [CQF:REQ-060], bounded like the workbook reader.
 *
 * RFC 4180 quoting, CRLF or LF, a leading byte-order mark, and the separator Excel writes in the
 * user's locale: a comma, or a semicolon or tab when the header row uses that instead.
 */
import { ZIP_LIMITS } from './zip.mjs';
import { SHEET_LIMITS } from './xlsx.mjs';
import { SingularityFlowError } from '../../util.mjs';

function unreadable(message, details = {}) {
  return new SingularityFlowError(`The CSV file cannot be read: ${message}`, { code: 'FINDINGS_WORKBOOK_UNREADABLE', details });
}

function separatorOf(text) {
  const header = text.slice(0, text.search(/\r?\n|$/u));
  const count = (character) => header.split(character).length - 1;
  const [best] = [[',', count(',')], [';', count(';')], ['\t', count('\t')]].sort((left, right) => right[1] - left[1]);
  return best[1] > 0 ? best[0] : ',';
}

/** `[{ name, rows: [{ number, cells: [{ type: 'string', value }] }] }]`, the same shape as readXlsx. */
export function readCsv(bytes, { name = 'CSV', fileBytes = ZIP_LIMITS.fileBytes } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf8');
  if (buffer.length > fileBytes) throw unreadable(`it is larger than ${fileBytes} bytes.`, { bytes: buffer.length });
  const text = buffer.toString('utf8').replace(/^﻿/u, '');
  const separator = separatorOf(text);
  const rows = [];
  let cells = [];
  let field = '';
  let quoted = false;
  let number = 1;
  let started = false;
  const pushField = () => {
    if (cells.length < SHEET_LIMITS.columns) cells.push(field.length > SHEET_LIMITS.cellCharacters ? field.slice(0, SHEET_LIMITS.cellCharacters) : field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (rows.length >= SHEET_LIMITS.rows + 1) throw unreadable(`it has more than ${SHEET_LIMITS.rows} rows.`);
    rows.push({ number, cells: cells.map((value) => (value === '' ? undefined : { type: 'string', value })) });
    cells = [];
    number += 1;
    started = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"' && field === '') { quoted = true; started = true; continue; }
    if (character === separator) { pushField(); started = true; continue; }
    if (character === '\r' && text[index + 1] === '\n') continue;
    if (character === '\n' || character === '\r') { pushRow(); continue; }
    field += character;
    started = true;
  }
  if (quoted) throw unreadable(`a quoted value on row ${number} is never closed.`, { row: number });
  if (started || field || cells.length) pushRow();
  return [{ name, rows }];
}
