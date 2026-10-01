import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { extractSourceText } from '../src/source-text.mjs';

/**
 * Build a real ZIP container so the reader is exercised against the format, not a mock.
 * Both storage methods are used: stored (0) and deflate (8), which is what Office actually emits.
 */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content, deflate = true] of entries) {
    const raw = Buffer.from(content, 'utf8');
    const body = deflate ? deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

test('a DOCX becomes readable text, with runs joined and entities decoded', () => {
  // Copilot is handed a filesystem path and reads it as UTF-8, so a pinned DOCX arrived as
  // mojibake while the pane invited exactly that format. Word splits a sentence across runs
  // arbitrarily, so joining them is what makes the sentence readable at all.
  const document = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
    <w:p><w:r><w:t>Auth V2 Requirements</w:t></w:r></w:p>
    <w:p><w:r><w:t>The system MUST support </w:t></w:r><w:r><w:t>JWT rotation &amp; IP fallback.</w:t></w:r></w:p>
    <w:p/>
  </w:body></w:document>`;
  const result = extractSourceText(zip([['[Content_Types].xml', '<Types/>', false], ['word/document.xml', document]]), DOCX);
  assert.equal(result.status, 'extracted');
  assert.equal(result.text, 'Auth V2 Requirements\n\nThe system MUST support JWT rotation & IP fallback.');
});

test('an XLSX resolves the shared string table rather than emitting indices', () => {
  // A cell with t="s" holds an index, not a value; emitting the index would give Copilot numbers
  // where the spreadsheet has words.
  const shared = '<?xml version="1.0"?><sst><si><t>Endpoint</t></si><si><t>Limit</t></si><si><t>/login</t></si></sst>';
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>100</v></c></row>
  </sheetData></worksheet>`;
  const result = extractSourceText(zip([['xl/sharedStrings.xml', shared], ['xl/worksheets/sheet1.xml', sheet]]), XLSX);
  assert.equal(result.status, 'extracted');
  assert.match(result.text, /Endpoint\tLimit/);
  assert.match(result.text, /\/login\t100/);
});

test('a format with no honest text layer is reported, never guessed at', () => {
  // A half-working PDF parser would quietly produce wrong requirements, which is worse than
  // admitting the source cannot be read.
  const pdf = extractSourceText(Buffer.from('%PDF-1.7\nbinary'), 'application/pdf');
  assert.equal(pdf.status, 'unreadable');
  assert.match(pdf.reason, /no recoverable text layer/);

  // Corruption and unknown types are reported, not thrown: a bad source must not break the pin.
  assert.equal(extractSourceText(Buffer.from('not a zip'), DOCX).status, 'unreadable');
  assert.equal(extractSourceText(Buffer.from(''), 'image/png').status, 'unreadable');
});

test('an empty document is unreadable rather than an empty rendition', () => {
  // Writing an empty rendition would tell the contract the source is readable when it says nothing.
  const empty = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p/></w:body></w:document>`;
  assert.equal(extractSourceText(zip([['word/document.xml', empty]]), DOCX).status, 'unreadable');
});

const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

test('an XLSX keeps every value in its column, even after an empty styled cell or row', () => {
  // Excel writes empty styled cells and rows as self-closing elements. Read as opening tags they
  // swallowed the next cell, so "Basic, (no fee), 100" came out as a fee of 100.
  const shared = '<sst><si><t>Plan</t></si><si><t>Fee</t></si><si><t>Limit</t></si><si><t>Basic</t></si><si><t>Pro</t></si></sst>';
  const sheet = '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"/><c r="C2"><v>100</v></c></row>'
    + '<row r="3" spans="1:3"/>'
    + '<row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4"><v>2.5</v></c><c r="C4"><v>1000</v></c></row>'
    + '</sheetData></worksheet>';
  const result = extractSourceText(zip([['xl/sharedStrings.xml', shared], ['xl/worksheets/sheet1.xml', sheet]]), XLSX);
  assert.equal(result.text, '# sheet1\nPlan\tFee\tLimit\nBasic\t\t100\nPro\t2.5\t1000');
});

test('XLSX sheets carry their workbook names, in sheet order', () => {
  const sheets = Array.from({ length: 11 }, (_, index) => [`xl/worksheets/sheet${index + 1}.xml`,
    `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Sheet ${index + 1}</t></is></c></row></sheetData></worksheet>`]);
  const workbook = '<workbook><sheets><sheet name="Prices &amp; Limits" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>';
  const relationships = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>';
  const result = extractSourceText(zip([['xl/workbook.xml', workbook], ['xl/_rels/workbook.xml.rels', relationships], ...sheets]), XLSX);
  const headings = result.text.split('\n').filter((line) => line.startsWith('# '));
  assert.deepEqual(headings.slice(0, 4), ['# Prices & Limits', '# Notes', '# sheet3', '# sheet4']);
  assert.equal(headings.at(-1), '# sheet11', 'sheet10 and sheet11 follow sheet9, not sheet1');
});

test('a DOCX keeps tabs, line breaks, table rows and footnotes', () => {
  const document = '<w:document><w:body>'
    + '<w:p><w:r><w:t>Duplicates</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>return HTTP 409</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>and are not retried.</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Code</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Meaning</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>409</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Duplicate</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '</w:body></w:document>';
  const footnotes = '<w:footnotes><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:t>---</w:t></w:r></w:p></w:footnote>'
    + '<w:footnote w:id="1"><w:p><w:r><w:t>Card payments only.</w:t></w:r></w:p></w:footnote></w:footnotes>';
  const result = extractSourceText(zip([['word/document.xml', document], ['word/footnotes.xml', footnotes]]), DOCX);
  assert.match(result.text, /^Duplicates\treturn HTTP 409\nand are not retried\./);
  assert.match(result.text, /\| Code \| Meaning \|\n\| 409 \| Duplicate \|/);
  assert.match(result.text, /Footnotes:\n\nCard payments only\./);
  assert.doesNotMatch(result.text, /---/, 'the separator footnote is not text');
});

test('a PPTX becomes its slide text in slide order, with speaker notes', () => {
  const slide = (text) => `<p:sld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
  const result = extractSourceText(zip([
    ['ppt/slides/slide10.xml', slide('Appendix')],
    ['ppt/slides/slide1.xml', slide('Retry button for operators')],
    ['ppt/slides/slide2.xml', slide('Second slide')],
    ['ppt/notesSlides/notesSlide1.xml', '<p:notes><a:p><a:r><a:t>Confirm with legal</a:t></a:r></a:p><a:p><a:r><a:t>1</a:t></a:r></a:p></p:notes>']
  ]), PPTX);
  assert.equal(result.status, 'extracted');
  assert.deepEqual(result.text.split('\n').filter((line) => line.startsWith('# ')), ['# Slide 1', '# Slide 2', '# Slide 10']);
  assert.match(result.text, /Retry button for operators\nNotes:\nConfirm with legal/);
});

test('an Office entry that inflates past the cap is unreadable instead of exhausting memory', () => {
  const bomb = '<w:document><w:body><w:p><w:r><w:t>' + 'A'.repeat(65 * 1024 * 1024) + '</w:t></w:r></w:p></w:body></w:document>';
  const result = extractSourceText(zip([['word/document.xml', bomb]]), DOCX);
  assert.equal(result.status, 'unreadable');
});
