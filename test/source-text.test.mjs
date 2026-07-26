import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { extractSourceText } from '../apps/desktop/electron/source-text.mjs';

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
