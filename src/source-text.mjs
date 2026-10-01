/**
 * Derive a text rendition of a pinned binary source.
 *
 * The governed context hands Copilot a filesystem path, and native clients commonly read it as UTF-8. A
 * pinned PDF, DOCX or XLSX therefore arrived as mojibake while the sources pane invited exactly
 * those formats — "the specification, research, designs, or spreadsheets this phase must be based
 * on". Requirements could not cite what Copilot could not read.
 *
 * This stays dependency-light. The engine has a single runtime dependency (`yaml`) and
 * `npm run check` asserts no Python and no embedded MCP transport. MCP processes remain owned by
 * VS Code or Copilot; the rendition is another file written beside the
 * cached bytes, and the engine keeps treating it as one.
 *
 * DOCX and XLSX are ZIP containers of XML, so Node's own zlib is enough. PDF is not: extracting its
 * text properly needs a font- and encoding-aware parser, and a half-working one would quietly
 * produce wrong requirements. A PDF is reported as unreadable instead, which is honest and lets the
 * pane say so.
 */
import { inflateRawSync } from 'node:zlib';

// A small Office file can inflate to gigabytes; nothing a prompt or review cites needs more.
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

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
  if (method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_INFLATED_BYTES });
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

/** Paragraph text in document order, keeping tabs and line breaks between runs as whitespace. */
function wordParagraph(xml) {
  let text = '';
  for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g)) {
    if (match[1] !== undefined) text += decodeXmlText(match[1].replace(/<[^>]*>/g, ''));
    else text += match[0].startsWith('<w:tab') ? '\t' : '\n';
  }
  return text.trim();
}

/** Body blocks in order: a table becomes one `| a | b |` line per row, any other paragraph its text. */
function wordBlocks(xml) {
  const lines = [];
  for (const block of xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g)) {
    if (block[0].startsWith('<w:tbl')) {
      for (const row of block[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
        const cells = [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((cell) => [...cell[0]
          .matchAll(/<w:p\b[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g)].map((paragraph) => wordParagraph(paragraph[0]))
          .filter(Boolean).join(' ').replace(/\s+/g, ' '));
        if (cells.some(Boolean)) lines.push(`| ${cells.join(' | ')} |`);
      }
    } else {
      const paragraph = wordParagraph(block[0]);
      if (paragraph) lines.push(paragraph);
    }
  }
  return lines;
}

function extractDocx(buffer) {
  const entries = readCentralDirectory(buffer);
  const entry = entries.get('word/document.xml');
  if (!entry) throw new Error('DOCX has no word/document.xml.');
  const blocks = wordBlocks(readEntry(buffer, entry).toString('utf8'));
  // Footnotes and endnotes often carry the conditions a requirement depends on.
  for (const notes of ['word/footnotes.xml', 'word/endnotes.xml']) {
    if (!entries.has(notes)) continue;
    const text = [...readEntry(buffer, entries.get(notes)).toString('utf8')
      .matchAll(/<w:(?:footnote|endnote)\b([^>]*)>([\s\S]*?)<\/w:(?:footnote|endnote)>/g)]
      .filter(([, attributes]) => !/w:type="(?:separator|continuationSeparator|continuationNotice)"/.test(attributes))
      .flatMap(([, , body]) => wordBlocks(body));
    if (text.length) blocks.push(notes.includes('foot') ? 'Footnotes:' : 'Endnotes:', ...text);
  }
  return blocks.join('\n\n').replace(/\n\n(\|)/g, '\n$1');
}

/** Zero-based column of a cell reference such as `BC12`, or null without one. */
function columnIndex(reference) {
  const letters = /^([A-Z]{1,3})\d*$/.exec(String(reference ?? ''))?.[1];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function numberedEntry(name) {
  return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

/** Workbook sheet names by worksheet part, from xl/workbook.xml and its relationships. */
function sheetNames(buffer, entries) {
  const names = new Map();
  if (!entries.has('xl/workbook.xml') || !entries.has('xl/_rels/workbook.xml.rels')) return names;
  const targets = new Map([...readEntry(buffer, entries.get('xl/_rels/workbook.xml.rels')).toString('utf8')
    .matchAll(/<Relationship\b[^>]*?\bId="([^"]+)"[^>]*?\bTarget="([^"]+)"/g)]
    .map(([, id, target]) => [id, `xl/${target.replace(/^\/?xl\//, '').replace(/^\.\//, '')}`]));
  for (const [, attributes] of readEntry(buffer, entries.get('xl/workbook.xml')).toString('utf8').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(attributes)?.[1];
    const id = /\br:id="([^"]+)"/.exec(attributes)?.[1];
    if (name && targets.has(id)) names.set(targets.get(id), decodeXmlText(name));
  }
  return names;
}

function extractXlsx(buffer) {
  const entries = readCentralDirectory(buffer);
  const shared = entries.has('xl/sharedStrings.xml')
    ? textOf(readEntry(buffer, entries.get('xl/sharedStrings.xml')).toString('utf8'), 'si')
    : [];
  const names = sheetNames(buffer, entries);
  const sheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((left, right) => numberedEntry(left) - numberedEntry(right));
  const lines = [];
  for (const name of sheets) {
    const xml = readEntry(buffer, entries.get(name)).toString('utf8');
    lines.push(`# ${names.get(name) ?? name.replace('xl/worksheets/', '').replace('.xml', '')}`);
    // A self-closing row or cell (an empty or style-only one) has no body; matching it as an
    // opening tag used to swallow the next cell and shift every later value one column left.
    for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells = [];
      for (const cell of String(row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attributes = cell[1] ?? '';
        const body = cell[2] ?? '';
        const column = columnIndex(/\br="([A-Z]+\d*)"/.exec(attributes)?.[1]);
        const raw = textOf(body, 'v')[0] ?? textOf(body, 't')[0] ?? '';
        // t="s" means the value is an index into the shared string table.
        cells[column ?? cells.length] = /\bt="s"/.test(attributes) ? (shared[Number(raw)] ?? '') : raw;
      }
      const values = Array.from(cells, (value) => value ?? '');
      if (values.some((value) => value !== '')) lines.push(values.join('\t'));
    }
  }
  return lines.join('\n');
}

function extractPptx(buffer) {
  const entries = readCentralDirectory(buffer);
  const slides = [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((left, right) => numberedEntry(left) - numberedEntry(right));
  const lines = [];
  for (const name of slides) {
    const paragraphs = [...readEntry(buffer, entries.get(name)).toString('utf8').matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
      .map((paragraph) => textOf(paragraph[0], 'a:t').join('').trim()).filter(Boolean);
    const notesName = name.replace('ppt/slides/slide', 'ppt/notesSlides/notesSlide');
    const notes = entries.has(notesName)
      ? [...readEntry(buffer, entries.get(notesName)).toString('utf8').matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
        .map((paragraph) => textOf(paragraph[0], 'a:t').join('').trim())
        .filter((text) => text && !/^\d+$/.test(text))
      : [];
    if (!paragraphs.length && !notes.length) continue;
    lines.push(`# Slide ${numberedEntry(name)}`, ...paragraphs, ...(notes.length ? ['Notes:', ...notes] : []), '');
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

/**
 * File extensions whose bytes are UTF-8 text. Prompts inline these and source review cites them, so
 * both read this one list: a format a phase is shown as text is also one a reviewer can cite.
 */
export const TEXT_SOURCE_EXTENSIONS = new Set([
  '.adoc', '.c', '.cc', '.clj', '.cljs', '.cmake', '.cpp', '.cs', '.css', '.csv', '.dart', '.feature', '.go', '.gradle',
  '.graphql', '.groovy', '.h', '.hpp', '.html', '.ini', '.java', '.js', '.jsx', '.json', '.kt', '.kts', '.less', '.log',
  '.lua', '.m', '.md', '.markdown', '.mdx', '.mm', '.mmd', '.php', '.properties', '.proto', '.puml', '.py', '.r', '.rb',
  '.rs', '.rst', '.sass', '.scala', '.scss', '.sh', '.sql', '.svg', '.swift', '.tf', '.toml', '.ts', '.tsx', '.tsv',
  '.txt', '.vue', '.xml', '.yaml', '.yml'
]);

// File extension to the MIME type a Story document is catalogued with.
const DOCUMENT_MIME_TYPES = {
  '.c': 'text/x-c', '.cc': 'text/x-c++', '.cpp': 'text/x-c++', '.cs': 'text/x-csharp', '.css': 'text/css', '.csv': 'text/csv',
  '.dart': 'text/x-dart', '.fig': 'application/x-figma', '.gif': 'image/gif', '.go': 'text/x-go', '.gradle': 'text/x-gradle',
  '.groovy': 'text/x-groovy', '.h': 'text/x-c', '.hpp': 'text/x-c++', '.html': 'text/html', '.java': 'text/x-java-source',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.jsx': 'text/jsx', '.json': 'application/json',
  '.kt': 'text/x-kotlin', '.kts': 'text/x-kotlin', '.lua': 'text/x-lua', '.md': 'text/markdown', '.markdown': 'text/markdown', '.mdx': 'text/markdown',
  '.pdf': 'application/pdf', '.php': 'text/x-php', '.png': 'image/png', '.properties': 'text/plain', '.py': 'text/x-python',
  '.r': 'text/x-r', '.rb': 'text/x-ruby', '.rs': 'text/x-rust', '.scala': 'text/x-scala', '.scss': 'text/x-scss',
  '.sh': 'text/x-shellscript', '.sql': 'text/x-sql', '.svg': 'image/svg+xml', '.swift': 'text/x-swift', '.tf': 'text/x-terraform',
  '.ts': 'text/typescript', '.tsx': 'text/tsx', '.txt': 'text/plain', '.vue': 'text/x-vue', '.webp': 'image/webp',
  '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.adoc': 'text/asciidoc', '.rst': 'text/x-rst', '.toml': 'text/x-toml', '.ini': 'text/plain', '.tsv': 'text/tab-separated-values',
  '.graphql': 'text/x-graphql', '.feature': 'text/x-gherkin', '.log': 'text/plain', '.puml': 'text/plain', '.mmd': 'text/plain',
  '.proto': 'text/x-protobuf', '.less': 'text/x-less', '.sass': 'text/x-sass', '.mm': 'text/x-objcpp', '.m': 'text/x-objc',
  '.clj': 'text/x-clojure', '.cljs': 'text/x-clojure', '.cmake': 'text/x-cmake',
  // Office formats: DOCX and XLSX text is extracted for prompts and reviews; the others are named honestly.
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint'
};

/** The MIME type for a file name, by extension. */
export function documentMimeType(name) {
  const value = String(name ?? '');
  const dot = value.lastIndexOf('.');
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  const extension = dot > slash + 1 ? value.slice(dot).toLowerCase() : '';
  return DOCUMENT_MIME_TYPES[extension] ?? 'application/octet-stream';
}

/**
 * The type a document's bytes have. A record stored before non-Latin file names kept their
 * extension (要件.md stored as `.md`) was catalogued as application/octet-stream; its original
 * name still says what it is.
 */
export function effectiveDocumentMimeType(record) {
  const recorded = record?.mimeType ?? 'application/octet-stream';
  if (recorded !== 'application/octet-stream' || !record?.sourceName) return recorded;
  return documentMimeType(record.sourceName);
}

/** A source already readable as UTF-8 needs no rendition; handing Copilot the original is better. */
export function isTextualSource(mimeType, name = '') {
  const mime = String(mimeType ?? '');
  if (mime.startsWith('text/')) return true;
  if (['application/json', 'application/yaml', 'application/xml'].includes(mime)) return true;
  const extension = String(name).slice(String(name).lastIndexOf('.')).toLowerCase();
  return TEXT_SOURCE_EXTENSIONS.has(extension);
}

/** Formats that arrive as bytes but carry no text this can honestly recover. */
export const UNREADABLE_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint'
]);

const EXTRACTORS = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': extractDocx,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': extractXlsx,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': extractPptx
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

/** Whether a text rendition can be derived for this MIME type at all; cheap, reads no bytes. */
export function hasTextExtractor(mimeType) {
  return Object.hasOwn(EXTRACTORS, String(mimeType ?? ''));
}

const EXTRACTOR_MIME_BY_EXTENSION = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
};

/** Extract text by file name rather than MIME type, for callers that only have a path. */
export function extractSourceTextForPath(bytes, name) {
  const extension = String(name ?? '').slice(String(name ?? '').lastIndexOf('.')).toLowerCase();
  return extractSourceText(bytes, EXTRACTOR_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream');
}

/** Version of the extractors above, recorded with every rendition a prompt or review uses. */
// 2: column-correct XLSX cells and workbook sheet names, DOCX tabs/breaks/tables/notes, PPTX slides.
export const SOURCE_TEXT_EXTRACTOR_VERSION = 2;

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
    // Readable but empty (a document of pictures, say): there is nothing to cite or to scan.
    if (!text) return { status: 'unreadable', reason: 'the document contained no extractable text', empty: true };
    return { status: 'extracted', text };
  } catch (error) {
    return { status: 'unreadable', reason: error.message };
  }
}
