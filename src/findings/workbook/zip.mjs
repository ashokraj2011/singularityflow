/**
 * The smallest zip a workbook needs [CQF:REQ-061], with no dependency: a reader over node:zlib and a
 * writer of stored (uncompressed) entries.
 *
 * An uploaded workbook is someone else's file, so the reader is bounded before it inflates anything:
 * the file's size, the number of entries, each part's declared and actual unzipped size, and the total
 * it unzips. Only the parts asked for are inflated, a part's CRC is checked, and an encrypted, split
 * or zip64 archive is refused as unreadable rather than guessed at.
 */
import { inflateRawSync } from 'node:zlib';

import { SingularityFlowError } from '../../util.mjs';

export const ZIP_LIMITS = Object.freeze({
  // A findings workbook of 20,000 rows is well under 5 MB; four times that is a misnamed file.
  fileBytes: 20 * 1024 * 1024,
  entries: 2_000,
  partBytes: 32 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024
});

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function unreadable(message, details = {}) {
  return new SingularityFlowError(`The workbook cannot be read: ${message}`, { code: 'FINDINGS_WORKBOOK_UNREADABLE', details });
}

/**
 * The entries of a zip archive, by name, without inflating any of them. `read(name)` inflates one
 * part within the limits; a name not in the archive reads as null.
 */
export function openZip(bytes, limits = ZIP_LIMITS) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length > limits.fileBytes) throw unreadable(`it is larger than ${limits.fileBytes} bytes.`, { bytes: buffer.length });
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw unreadable('it is not a zip file (an .xlsx workbook is one).');
  // The end-of-directory record is in the last 22 bytes plus at most a 65,535-byte comment.
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 0xffff); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw unreadable('its zip directory is missing.');
  const count = buffer.readUInt16LE(end + 10);
  const directoryBytes = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) throw unreadable('it is a split archive.');
  if (count === 0xffff || directoryOffset === 0xffffffff) throw unreadable('it is a zip64 archive, which a findings workbook never needs.');
  if (count > limits.entries) throw unreadable(`it has more than ${limits.entries} parts.`, { entries: count });
  if (directoryOffset + directoryBytes > end) throw unreadable('its zip directory points outside the file.');
  const entries = new Map();
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw unreadable('its zip directory is damaged.');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedBytes = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!entries.has(name)) entries.set(name, { name, flags, method, crc, compressedBytes, size, localOffset });
  }
  let inflated = 0;
  const read = (name) => {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.flags & 0x1) throw unreadable(`its part ${name} is encrypted.`);
    if (entry.size > limits.partBytes) throw unreadable(`its part ${name} unzips to more than ${limits.partBytes} bytes.`, { part: name, bytes: entry.size });
    if (inflated + entry.size > limits.totalBytes) throw unreadable(`it unzips to more than ${limits.totalBytes} bytes.`);
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw unreadable(`its part ${name} is damaged.`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + entry.compressedBytes > buffer.length) throw unreadable(`its part ${name} runs past the end of the file.`);
    const raw = buffer.subarray(start, start + entry.compressedBytes);
    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: Math.min(limits.partBytes, Math.max(entry.size, 1)) }); }
      catch (error) { throw unreadable(`its part ${name} could not be unzipped (${error.code ?? 'damaged'}).`, { part: name }); }
    } else throw unreadable(`its part ${name} uses zip method ${entry.method}, which is not supported.`, { part: name });
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw unreadable(`its part ${name} does not match its checksum.`, { part: name });
    inflated += data.length;
    return Buffer.from(data);
  };
  return { names: [...entries.keys()], has: (name) => entries.has(name), read };
}

// 1 January 1980, the earliest time a zip can say: every written file is byte-for-byte reproducible.
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

/** A zip of stored entries, `[{ name, data }]` in order. Excel, LibreOffice and Numbers read these. */
export function writeStoredZip(files) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    // Bit 11: the name is UTF-8.
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directoryBytes = directory.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryBytes, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}
