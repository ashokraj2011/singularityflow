import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import { crc32, openZip, writeStoredZip } from '../src/findings/workbook/zip.mjs';
import { excelSerialDate, isoDateSerial, readXlsx, writeXlsx } from '../src/findings/workbook/xlsx.mjs';
import { readCsv } from '../src/findings/workbook/csv.mjs';
import { matchHeaders, normalizeRow, repositoryKey, repositoryMatches, sheetFeed, templateSheets } from '../src/findings/register/format.mjs';
import { readFindingsConfig, sourceColumns } from '../src/findings/register/config.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

// CQF M6 piece 1: the findings workbook format, its bounded reader and the template writer.
// Every fixture is made up: example-org repositories, invented IDs.

const engine = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(engine, 'bin', 'singularity-flow.mjs');
const fixture = (name) => path.join(engine, 'test', 'fixtures', 'findings', name);

/** A zip whose parts are deflated, as Excel writes them, built here so each part's XML is visible. */
function deflatedZip(files) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const size = directory.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}

const WORKBOOK = (date1904 = false) => `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets><sheet name="Security" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>';
const STYLES = '<styleSheet><numFmts count="1"><numFmt numFmtId="170" formatCode="dd&quot;/&quot;mm&quot;/&quot;yyyy"/></numFmts><cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="170"/><xf numFmtId="4"/></cellXfs></styleSheet>';
const SHARED = '<sst><si><t>ID</t></si><si><t>Title</t></si><si><r><t>Seve</t></r><r><rPr><b/></rPr><t>rity</t></r><rPh><t>ignored</t></rPh></si><si><t>Repository</t></si><si><t xml:space="preserve">Due date</t></si><si><t>Line</t></si><si><t>SEC-9 &amp; more</t></si><si><t>Tom &lt;b&gt;bold&lt;/b&gt;_x000D_ text</t></si></sst>';
const SHEET = `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>SEC-1</t></is></c><c r="B2" t="str"><f>CONCAT("a","b")</f><v>Cached title</v></c><c r="C2" t="inlineStr"><is><t>high</t></is></c><c r="D2" t="inlineStr"><is><t>git@git.example.test:example-org/orders-api.git</t></is></c><c r="E2" s="1"><v>46387</v></c><c r="F2"><f>40+2</f><v>42</v></c></row>
<row r="4"><c r="A4" t="inlineStr"><is><t>SEC-2</t></is></c><c r="B4" t="s"><v>7</v></c><c r="C4" t="inlineStr"><is><t>Low</t></is></c><c r="D4" t="inlineStr"><is><t>orders-api</t></is></c><c r="E4" s="2"><v>46387.75</v></c><c r="F4"><f>NOW()</f></c></row>
<row r="5"><c r="A5" t="b"><v>1</v></c><c r="B5" t="e"><v>#N/A</v></c><c r="C5" t="inlineStr"><is><t>info</t></is></c><c r="D5" t="inlineStr"><is><t>orders-api</t></is></c><c r="E5" t="d"><v>2027-02-01T00:00:00</v></c></row>
<row><c t="inlineStr"><is><t>SEC-4</t></is></c><c t="inlineStr"><is><t>No refs</t></is></c><c t="inlineStr"><is><t>medium</t></is></c><c t="inlineStr"><is><t>orders-api</t></is></c><c s="3"><v>12</v></c></row>
</sheetData></worksheet>`;

test('a deflated workbook reads shared, rich and inline strings, cached formula values, booleans, errors and both kinds of date (CQF:REQ-061)', () => {
  const bytes = deflatedZip({
    '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': WORKBOOK(), 'xl/_rels/workbook.xml.rels': RELS,
    'xl/styles.xml': STYLES, 'xl/sharedStrings.xml': SHARED, 'xl/worksheets/sheet1.xml': SHEET
  });
  const [sheet] = readXlsx(bytes);
  assert.equal(sheet.name, 'Security');
  assert.deepEqual(sheet.rows.map((row) => row.number), [1, 2, 4, 5, 6]);
  const [, first, second, third, fourth] = sheet.rows;
  assert.deepEqual(first.cells[1], { type: 'string', value: 'Cached title' }, 'a formula is its cached value, never evaluated');
  assert.deepEqual(first.cells[4], { type: 'date', value: '2026-12-31' }, 'a built-in date format');
  assert.deepEqual(first.cells[5], { type: 'number', value: 42 });
  assert.equal(sheet.rows[0].cells[2].value, 'Severity', 'rich text runs join and the phonetic guide is left out');
  assert.equal(second.cells[1].value, 'Tom <b>bold</b>\r text', 'entities and _x000D_ escapes decode to plain text, never markup');
  assert.deepEqual(second.cells[4], { type: 'date', value: '2026-12-31' }, 'a custom date format; the time of day is dropped');
  assert.equal(second.cells[5], undefined, 'a formula with no cached value is empty');
  assert.deepEqual(third.cells[0], { type: 'boolean', value: true });
  assert.equal(third.cells[1].type, 'error');
  assert.deepEqual(third.cells[4], { type: 'date', value: '2027-02-01' });
  assert.deepEqual(fourth.cells[4], { type: 'number', value: 12 }, 'cells without references fill from the left; a number format is not a date');

  const { indexes, missing } = matchHeaders('security', sheet.rows[0].cells);
  assert.deepEqual(missing, []);
  const item = normalizeRow('security', first, indexes).item;
  assert.equal(item.repository, 'example-org/orders-api', 'an SSH URL names its owner and repository');
  assert.equal(item.line, 42);
  assert.equal(item.dueAt, '2026-12-31');
  assert.equal(normalizeRow('security', third, indexes).reason, 'Title is empty', 'an error cell is empty');
});

test('the 1904 date system, serial edge cases and the writer\'s serials agree with Excel', () => {
  assert.equal(excelSerialDate(1), '1900-01-01');
  assert.equal(excelSerialDate(59), '1900-02-28');
  assert.equal(excelSerialDate(60), '1900-02-29');
  assert.equal(excelSerialDate(61), '1900-03-01');
  assert.equal(excelSerialDate(46387), '2026-12-31');
  assert.equal(excelSerialDate(0, { date1904: true }), '1904-01-01');
  assert.equal(isoDateSerial('2026-12-31'), 46387);
  const bytes = deflatedZip({
    'xl/workbook.xml': WORKBOOK(true), 'xl/_rels/workbook.xml.rels': RELS, 'xl/styles.xml': STYLES,
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>44925</v></c></row></sheetData></worksheet>'
  });
  assert.deepEqual(readXlsx(bytes)[0].rows[0].cells[0], { type: 'date', value: '2026-12-31' });
});

test('the reader is bounded: size, parts, checksum, zip bombs, encryption and a non-zip file are refused as unreadable', () => {
  const small = { fileBytes: 1_000_000, entries: 3, partBytes: 4096, totalBytes: 8192 };
  assert.throws(() => openZip(Buffer.alloc(30), small), { code: 'FINDINGS_WORKBOOK_UNREADABLE' });
  assert.throws(() => openZip(Buffer.from('ID,Title\n'), small), /not a zip file/u);
  const bomb = deflatedZip({ 'xl/workbook.xml': 'x'.repeat(100_000) });
  assert.ok(bomb.length < 1000, 'a hundred kilobytes deflate to a few hundred bytes');
  assert.throws(() => openZip(bomb, small).read('xl/workbook.xml'), /unzips to more than 4096 bytes/u);
  // A part that lies about its size is stopped at the size it declared.
  const liar = Buffer.from(bomb);
  const directory = liar.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  liar.writeUInt32LE(100, directory + 24);
  assert.throws(() => openZip(liar, small).read('xl/workbook.xml'), /could not be unzipped|checksum/u);
  const many = deflatedZip({ a: '1', b: '2', c: '3', d: '4' });
  assert.throws(() => openZip(many, small), /more than 3 parts/u);
  const damaged = Buffer.from(writeStoredZip([{ name: 'xl/workbook.xml', data: 'hello' }]));
  damaged[30 + 'xl/workbook.xml'.length] ^= 1;
  assert.throws(() => openZip(damaged).read('xl/workbook.xml'), /checksum/u);
  const encrypted = Buffer.from(writeStoredZip([{ name: 'xl/workbook.xml', data: 'hello' }]));
  encrypted.writeUInt16LE(0x0801, encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
  assert.throws(() => openZip(encrypted).read('xl/workbook.xml'), /encrypted/u);
  assert.throws(() => openZip(Buffer.alloc(30, 1), { ...small, fileBytes: 10 }), /larger than 10 bytes/u);
});

test('the template has both sheets, every header and one example row each, and reads back as valid items (CQF:REQ-060)', () => {
  const bytes = writeXlsx(templateSheets());
  assert.equal(bytes.equals(writeXlsx(templateSheets())), true, 'the template is byte-for-byte reproducible');
  const sheets = readXlsx(bytes);
  assert.deepEqual(sheets.map((sheet) => sheet.name), ['Security', 'TLM']);
  assert.deepEqual(sheets[0].rows[0].cells.map((cell) => cell.value), ['ID', 'Title', 'Severity', 'Repository', 'Type', 'File', 'Line', 'Package',
    'Installed version', 'Fixed version', 'CVE', 'CWE', 'Rule', 'Tool', 'Description', 'Due date', 'Status', 'Exception expiry', 'Owner']);
  assert.deepEqual(sheets[1].rows[0].cells.map((cell) => cell.value), ['ID', 'Component', 'Repository', 'Target version', 'Ecosystem', 'Current version',
    'End of life date', 'Due date', 'Status', 'Waiver expiry', 'Owner', 'Notes']);
  for (const sheet of sheets) {
    const feed = sheetFeed(sheet.name);
    const { indexes, missing, unknown } = matchHeaders(feed, sheet.rows[0].cells);
    assert.deepEqual([missing, unknown], [[], []]);
    assert.equal(sheet.rows.length, 2);
    const { item } = normalizeRow(feed, sheet.rows[1], indexes);
    assert.equal(item.repository, 'example-org/payments-api');
    assert.equal(item.dueAt, '2026-12-31', 'the example due date is a real date cell');
  }
});

test('an openpyxl workbook reads with its aliases; an invalid row is reported with its reason and the rest import', async () => {
  const sheets = readXlsx(await readFile(fixture('openpyxl-findings.xlsx')));
  assert.deepEqual(sheets.map((sheet) => [sheet.name, sheetFeed(sheet.name)]), [['Security', 'security'], ['TLM', 'tlm'], ['Notes', null]]);
  const security = sheets[0];
  const { indexes, missing } = matchHeaders('security', security.rows[0].cells);
  assert.deepEqual(missing, [], 'Ticket, Summary, Risk and Repo are ID, Title, Severity and Repository');
  const results = security.rows.slice(1).map((row) => ({ row: row.number, ...normalizeRow('security', row, indexes) }));
  assert.deepEqual(results.filter((result) => result.item).map((result) => result.item.id), ['SEC-501', 'SEC-502', 'SEC-503', 'SEC-505']);
  assert.deepEqual(results.find((result) => result.row === 5), { row: 5, reason: "Severity 'Urgent' is not Critical, High, Medium, Low or Info" });
  assert.equal(results.find((result) => result.row === 6).empty, true, 'a blank row is neither imported nor reported');
  const [lodash, secret, accepted] = results.filter((result) => result.item).map((result) => result.item);
  assert.equal(lodash.type, 'dependency');
  assert.equal(lodash.installedVersion, '4.17.15');
  assert.equal(lodash.repository, 'example-org/orders-api');
  assert.equal(secret.title, 'Hard-coded password in config loader');
  assert.equal(secret.status, 'open', 'In progress is still open');
  assert.equal(accepted.status, 'accepted-risk');
  assert.equal(accepted.dueAt, '2027-01-31', 'a date typed as ISO text');
  const tlm = sheets[1];
  const tlmMatch = matchHeaders('tlm', tlm.rows[0].cells);
  const items = tlm.rows.slice(1).map((row) => normalizeRow('tlm', row, tlmMatch.indexes).item);
  assert.deepEqual(items.map((item) => [item.id, item.ecosystem, item.endOfLifeAt, item.status]),
    [['TLM-77', 'maven', '2023-11-24', 'open'], ['TLM-78', 'runtime', '2025-04-30', 'waiver']]);
});

test('a CSV file reads with quotes, line breaks and a semicolon separator; a columns map names other headers', async (t) => {
  const csv = '﻿Key;Headline;Risk;Repo;SLA;Notes\r\n"SEC-7";"Token in ""logs""; rotate it";High;orders-api;2026-12-01;"two\nlines"\r\nSEC-8;No date;Low;orders-api;12/31/2026;\r\n';
  const [sheet] = readCsv(Buffer.from(csv));
  assert.deepEqual(sheet.rows[1].cells.map((cell) => cell?.value), ['SEC-7', 'Token in "logs"; rotate it', 'High', 'orders-api', '2026-12-01', 'two\nlines']);
  const plain = matchHeaders('security', sheet.rows[0].cells);
  assert.deepEqual(plain.missing, ['Title']);
  assert.deepEqual(plain.unknown, ['Headline', 'SLA', 'Notes']);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-findings-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'singularity'));
  await writeFile(path.join(directory, 'singularity', 'findings.yml'), [
    'schemaVersion: 1',
    'security:',
    '  sources:',
    '    - { id: security-team, type: upload, columns: { title: Headline, dueAt: SLA, nonsense: X } }',
    '    - { id: leaky, type: link, url: "https://user:pa55word@tlm.example.test/x.csv" }',
    '  stories: { maximumFindings: 99 }'
  ].join('\n'));
  const config = await readFindingsConfig(directory);
  assert.deepEqual(config.sources.security.map((source) => source.id), ['security-team'], 'a source with a credential in it is left out');
  assert.equal(config.stories.security.maximumFindings, 10);
  assert.equal(config.warnings.length, 3, config.warnings.join('\n'));
  const mapped = matchHeaders('security', sheet.rows[0].cells, sourceColumns(config, 'security', 'security-team'));
  assert.deepEqual(mapped.missing, []);
  const rows = sheet.rows.slice(1).map((row) => normalizeRow('security', row, mapped.indexes));
  assert.equal(rows[0].item.dueAt, '2026-12-01');
  assert.match(rows[1].reason, /Due date '12\/31\/2026' is not an ISO date/u);
  assert.equal((await readFindingsConfig(path.join(directory, 'absent'))).present, false);
});

test('repositories match by owner and name from any URL form, or by a bare name', () => {
  assert.equal(repositoryKey('https://git.example.test/Example-Org/Orders-API.git'), 'example-org/orders-api');
  assert.equal(repositoryKey('ssh://git@git.example.test:7999/example-org/orders-api.git'), 'example-org/orders-api');
  assert.equal(repositoryKey('orders-api'), 'orders-api');
  assert.equal(repositoryKey('not a repo'), null);
  const current = { slug: 'example-org/orders-api', name: 'orders-api' };
  assert.equal(repositoryMatches('example-org/orders-api', current), true);
  assert.equal(repositoryMatches('orders-api', current), true);
  assert.equal(repositoryMatches('other-org/orders-api', current), false);
  assert.equal(repositoryMatches('billing-web', current), false);
});

test('findings template writes the workbook once and never overwrites a file', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-findings-template-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: directory });
  const out = path.join(directory, 'findings.xlsx');
  const run = () => spawnSync(process.execPath, [bin, 'findings', 'template', '--out', out, '--json'], {
    cwd: directory, encoding: 'utf8', timeout: childTimeout(60_000),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const result = JSON.parse(first.stdout);
  assert.equal(result.path, out);
  assert.deepEqual(result.sheets.map((sheet) => sheet.required), [['ID', 'Title', 'Severity', 'Repository'], ['ID', 'Component', 'Repository', 'Target version']]);
  assert.deepEqual(readXlsx(await readFile(out)).map((sheet) => sheet.name), ['Security', 'TLM']);
  const second = run();
  assert.notEqual(second.status, 0);
  assert.match(second.stdout + second.stderr, /FINDINGS_OUTPUT_EXISTS/u);
});
