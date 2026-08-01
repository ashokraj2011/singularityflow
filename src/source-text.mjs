/**
 * Derive a text rendition of a pinned binary source.
 *
 * The governed context hands Copilot a filesystem path, and the ACP file reader returns UTF-8. A
 * pinned PDF, DOCX or XLSX therefore arrived as mojibake while the sources pane invited exactly
 * those formats — "the specification, research, designs, or spreadsheets this phase must be based
 * on". Requirements could not cite what Copilot could not read.
 *
 * This lives in the Electron layer on purpose. The engine has a single dependency (`yaml`) and
 * `npm run check` asserts no Python and no MCP; adding a document parser there would be a real
 * change in what the engine is. Here the rendition is just another file written beside the cached
 * bytes, and the engine keeps treating it as one.
 *
 * DOCX and XLSX are ZIP containers of XML, so Node's own zlib is enough. PDF is not: extracting its
 * text properly needs a font- and encoding-aware parser, and a half-working one would quietly
 * produce wrong requirements. A PDF is reported as unreadable instead, which is honest and lets the
 * pane say so.
 */
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_COMMENT = 0xffff;

/** Locate the end-of-central-directory record, which may be followed by a comment. */
function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - MAX_COMMENT - 22);
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * Read a ZIP central directory into { name -> {offset, method, compressedSize} }.
 *
 * Only what is needed to pull a couple of known entries out of an Office file; this is not a
 * general-purpose archive reader and deliberately refuses anything it does not fully understand.
 */
function readCentralDirectory(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('Not a ZIP container.');
  const total = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buffer, entry) {
  const { localOffset, method, compressedSize } = entry;
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + compressedSize);
  if (method === 0) return raw;
  if (method === 8) return inflateRawSync(raw);
  throw new Error(`Unsupported ZIP compression method ${method}.`);
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlText(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (match, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return XML_ENTITIES[entity] ?? match;
  });
}

/** Collect the text of every occurrence of a tag, in document order. */
function textOf(xml, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  return [...xml.matchAll(pattern)].map((match) => decodeXmlText(match[1].replace(/<[^>]*>/g, '')));
}

function extractDocx(buffer) {
  const entries = readCentralDirectory(buffer);
  const entry = entries.get('word/document.xml');
  if (!entry) throw new Error('DOCX has no word/document.xml.');
  const xml = readEntry(buffer, entry).toString('utf8');
  // Paragraphs carry the structure a reader relies on; runs inside one paragraph are joined.
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .map((match) => textOf(match[1], 'w:t').join('').trim())
    .filter(Boolean);
  return paragraphs.join('\n\n');
}

function extractXlsx(buffer) {
  const entries = readCentralDirectory(buffer);
  const shared = entries.has('xl/sharedStrings.xml')
    ? textOf(readEntry(buffer, entries.get('xl/sharedStrings.xml')).toString('utf8'), 'si')
    : [];
  const sheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort();
  const lines = [];
  for (const name of sheets) {
    const xml = readEntry(buffer, entries.get(name)).toString('utf8');
    lines.push(`# ${name.replace('xl/worksheets/', '').replace('.xml', '')}`);
    for (const row of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
      const cells = [...row[1].matchAll(/<c(?:\s([^>]*))?>([\s\S]*?)<\/c>/g)].map(([, attributes = '', body]) => {
        const value = textOf(body, 'v')[0] ?? textOf(body, 't')[0] ?? '';
        // t="s" means the value is an index into the shared string table.
        return /\bt="s"/.test(attributes) ? (shared[Number(value)] ?? '') : value;
      });
      if (cells.some((cell) => cell !== '')) lines.push(cells.join('\t'));
    }
  }
  return lines.join('\n');
}

/**
 * Where a derived rendition is written, relative to the cached original.
 *
 * Defined here rather than in the context module so the source pipeline can write renditions without
 * importing the composer, which imports it.
 */
export const TEXT_RENDITION_SUFFIX = '.sflow-text.md';

/** A source already readable as UTF-8 needs no rendition; handing Copilot the original is better. */
export function isTextualSource(mimeType, name = '') {
  const mime = String(mimeType ?? '');
  if (mime.startsWith('text/')) return true;
  if (['application/json', 'application/yaml', 'application/xml'].includes(mime)) return true;
  const extension = String(name).slice(String(name).lastIndexOf('.')).toLowerCase();
  return ['.md', '.markdown', '.txt', '.csv', '.json', '.yml', '.yaml', '.xml'].includes(extension);
}

/** Formats that arrive as bytes but carry no text this can honestly recover. */
export const UNREADABLE_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);

const EXTRACTORS = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': extractDocx,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': extractXlsx
};

/**
 * @returns {{ status: 'extracted', text: string } | { status: 'unreadable', reason: string }}
 *
 * Never throws: a source that cannot be rendered is reported so the pane and the governed context
 * can say so, which is the whole point — the previous behaviour was to hand Copilot the bytes and
 * let it invent from noise.
 */
export function renderSourceRendition(record, text) {
  return [
    `# Text extracted from ${record.name ?? record.sourceId}`,
    '',
    `- Source: \`${record.sourceId}\``,
    `- SHA-256 of the original: \`${record.sha256}\``,
    '',
    text,
    ''
  ].join('\n');
}

export function extractSourceText(bytes, mimeType) {
  const extractor = EXTRACTORS[mimeType];
  if (!extractor) {
    return {
      status: 'unreadable',
      reason: UNREADABLE_MIME_TYPES.has(mimeType)
        ? `${mimeType} carries no recoverable text layer here`
        : `no text extractor for ${mimeType}`
    };
  }
  try {
    const text = extractor(Buffer.from(bytes)).trim();
    if (!text) return { status: 'unreadable', reason: 'the document contained no extractable text' };
    return { status: 'extracted', text };
  } catch (error) {
    return { status: 'unreadable', reason: error.message };
  }
}
