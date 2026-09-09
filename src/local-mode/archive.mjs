/** Deterministic, bounded ZIP STORE writer/reader for loc.zip.store.v1. */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';

import {
  assertUniquePortablePaths, LOC_LIMITS, locFail, portablePath
} from './contracts.mjs';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8 = 0x0800;
const DOS_DATE = 0x0021;
const UNIX_VERSION = 0x0314;
const VERSION = 20;
const REGULAR = 0o100000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crcUpdate(crc, bytes) {
  let value = crc;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

export function crc32(bytes) {
  return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

async function writeAll(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (!result.bytesWritten) locFail('Archive writer made no progress.', 'EXPORT_PROFILE_UNSUPPORTED');
    offset += result.bytesWritten;
  }
}

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (!result.bytesRead) locFail('Archive ended before its declared structure.', 'BUNDLE_INTEGRITY_INVALID');
    offset += result.bytesRead;
  }
  return buffer;
}

function localHeader(nameBytes, size) {
  const value = Buffer.alloc(30 + nameBytes.length);
  value.writeUInt32LE(LOCAL, 0);
  value.writeUInt16LE(VERSION, 4);
  value.writeUInt16LE(UTF8, 6);
  value.writeUInt16LE(0, 8);
  value.writeUInt16LE(0, 10);
  value.writeUInt16LE(DOS_DATE, 12);
  value.writeUInt32LE(0, 14);
  value.writeUInt32LE(size, 18);
  value.writeUInt32LE(size, 22);
  value.writeUInt16LE(nameBytes.length, 26);
  value.writeUInt16LE(0, 28);
  nameBytes.copy(value, 30);
  return value;
}

function externalMode(mode) {
  return ((REGULAR | Number.parseInt(mode, 8)) << 16) >>> 0;
}

function centralHeader(entry) {
  const name = Buffer.from(entry.path);
  const value = Buffer.alloc(46 + name.length);
  value.writeUInt32LE(CENTRAL, 0);
  value.writeUInt16LE(UNIX_VERSION, 4);
  value.writeUInt16LE(VERSION, 6);
  value.writeUInt16LE(UTF8, 8);
  value.writeUInt16LE(0, 10);
  value.writeUInt16LE(0, 12);
  value.writeUInt16LE(DOS_DATE, 14);
  value.writeUInt32LE(entry.crc32, 16);
  value.writeUInt32LE(entry.sizeBytes, 20);
  value.writeUInt32LE(entry.sizeBytes, 24);
  value.writeUInt16LE(name.length, 28);
  value.writeUInt16LE(0, 30);
  value.writeUInt16LE(0, 32);
  value.writeUInt16LE(0, 34);
  value.writeUInt16LE(0, 36);
  value.writeUInt32LE(externalMode(entry.mode), 38);
  value.writeUInt32LE(entry.localOffset, 42);
  name.copy(value, 46);
  return value;
}

async function withSource(entry, consume) {
  if (entry.bytes != null) {
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes);
    return consume(bytes.length, async (writer) => writer(bytes));
  }
  const handle = await open(entry.source,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(LOC_LIMITS.maximumFileBytes)) {
      locFail('Archive source ' + entry.path + ' is not a supported regular file.',
        'EXPORT_PROFILE_UNSUPPORTED');
    }
    return await consume(Number(before.size), async (writer) => {
      let position = 0;
      const buffer = Buffer.alloc(1024 * 1024);
      while (position < Number(before.size)) {
        const wanted = Math.min(buffer.length, Number(before.size) - position);
        const result = await handle.read(buffer, 0, wanted, position);
        if (!result.bytesRead) {
          locFail('Archive source ' + entry.path + ' changed while it was read.', 'INPUT_CHANGED');
        }
        await writer(buffer.subarray(0, result.bytesRead));
        position += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (after.size !== before.size || after.mtimeNs !== before.mtimeNs
          || after.ino !== before.ino || after.dev !== before.dev) {
        locFail('Archive source ' + entry.path + ' changed while it was read.', 'INPUT_CHANGED');
      }
    });
  } finally {
    await handle.close();
  }
}

/** Write exact archive bytes to a new staging file. */
export async function writeLocArchive(target, entries) {
  if (!Array.isArray(entries) || !entries.length
      || entries.length > LOC_LIMITS.maximumFiles + 2) {
    locFail('Archive member count exceeds the registered profile.',
      'EXPORT_PROFILE_UNSUPPORTED');
  }
  const ordered = [...entries]
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  assertUniquePortablePaths(ordered.map((entry) => entry.path));
  const handle = await open(target,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  let position = 0;
  let contentBytes = 0;
  const written = [];
  try {
    for (const entry of ordered) {
      portablePath(entry.path, {
        control: ['manifest.json', 'manifest.dsse.json'].includes(entry.path)
      });
      if (!['0644', '0755'].includes(entry.mode)) {
        locFail('Archive member ' + entry.path + ' has an invalid mode.');
      }
      await withSource(entry, async (size, pump) => {
        if (size > 0xffffffff) {
          locFail('ZIP64 is not supported by loc.zip.store.v1.',
            'EXPORT_PROFILE_UNSUPPORTED');
        }
        contentBytes += size;
        if (contentBytes > LOC_LIMITS.maximumContentBytes
            + LOC_LIMITS.maximumManifestBytes + LOC_LIMITS.maximumEnvelopeBytes) {
          locFail('Archive content exceeds the registered profile.',
            'EXPORT_PROFILE_UNSUPPORTED');
        }
        const name = Buffer.from(entry.path);
        const offset = position;
        const header = localHeader(name, size);
        await writeAll(handle, header, position);
        position += header.length;
        let crc = 0xffffffff;
        let observed = 0;
        await pump(async (chunk) => {
          await writeAll(handle, chunk, position);
          position += chunk.length;
          observed += chunk.length;
          crc = crcUpdate(crc, chunk);
        });
        if (observed !== size) {
          locFail('Archive source ' + entry.path + ' changed size.', 'INPUT_CHANGED');
        }
        crc = (crc ^ 0xffffffff) >>> 0;
        const crcBytes = Buffer.alloc(4);
        crcBytes.writeUInt32LE(crc, 0);
        await writeAll(handle, crcBytes, offset + 14);
        written.push({
          path: entry.path,
          mode: entry.mode,
          sizeBytes: size,
          crc32: crc,
          localOffset: offset
        });
      });
    }
    const centralOffset = position;
    for (const entry of written) {
      const central = centralHeader(entry);
      await writeAll(handle, central, position);
      position += central.length;
    }
    const centralSize = position - centralOffset;
    if (written.length > 0xffff || centralOffset > 0xffffffff
        || centralSize > 0xffffffff) {
      locFail('ZIP64 is not supported by loc.zip.store.v1.',
        'EXPORT_PROFILE_UNSUPPORTED');
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(written.length, 8);
    end.writeUInt16LE(written.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    await writeAll(handle, end, position);
    position += end.length;
    if (position > LOC_LIMITS.maximumArchiveBytes) {
      locFail('Archive exceeds the registered byte ceiling.',
        'EXPORT_PROFILE_UNSUPPORTED');
    }
    await handle.sync();
    return Object.freeze({ entries: Object.freeze(written), sizeBytes: position });
  } finally {
    await handle.close();
  }
}

function decodeName(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    locFail('Archive contains a non-UTF-8 member name.',
      'BUNDLE_INTEGRITY_INVALID');
  }
}

async function sha256Handle(handle, expected) {
  const hash = createHash('sha256');
  let position = 0;
  const buffer = Buffer.alloc(1024 * 1024);
  while (position < Number(expected.size)) {
    const result = await handle.read(buffer, 0,
      Math.min(buffer.length, Number(expected.size) - position), position);
    if (!result.bytesRead) locFail('Bundle changed while it was hashed.', 'INPUT_CHANGED');
    hash.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  return 'sha256:' + hash.digest('hex');
}

async function assertStableHandle(handle, expected) {
  const observed = await handle.stat({ bigint: true });
  if (!observed.isFile() || observed.size !== expected.size
      || observed.mtimeNs !== expected.mtimeNs
      || observed.ino !== expected.ino || observed.dev !== expected.dev) {
    locFail('Bundle changed while it was inspected.', 'INPUT_CHANGED');
  }
}

/** Validate every member in-place without extracting untrusted content. */
export async function inspectLocArchive(file) {
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    // Open once and retain this exact inode through hashing, structure validation, and member
    // reads. A path replacement can no longer make the digest describe different bytes from the
    // manifest that follows it.
    const retained = await handle.stat({ bigint: true });
    if (!retained.isFile() || retained.size < 22n
        || retained.size > BigInt(LOC_LIMITS.maximumArchiveBytes)) {
      locFail('Bundle archive is outside the registered size profile.',
        'BUNDLE_INTEGRITY_INVALID');
    }
    const sizeBytes = Number(retained.size);
    const archiveSha256 = await sha256Handle(handle, retained);
    await assertStableHandle(handle, retained);
    const end = await readExact(handle, 22, sizeBytes - 22);
    if (end.readUInt32LE(0) !== END || end.readUInt16LE(4) !== 0
        || end.readUInt16LE(6) !== 0
        || end.readUInt16LE(8) !== end.readUInt16LE(10)
        || end.readUInt16LE(20) !== 0) {
      locFail('Bundle does not use the registered single-disk ZIP profile.',
        'BUNDLE_INTEGRITY_INVALID');
    }
    const count = end.readUInt16LE(10);
    const centralSize = end.readUInt32LE(12);
    const centralOffset = end.readUInt32LE(16);
    if (!count || count > LOC_LIMITS.maximumFiles + 2
        || centralOffset + centralSize !== sizeBytes - 22) {
      locFail('Bundle central directory is inconsistent.',
        'BUNDLE_INTEGRITY_INVALID');
    }
    const entries = [];
    let declaredContentBytes = 0;
    let cursor = centralOffset;
    for (let index = 0; index < count; index += 1) {
      const fixed = await readExact(handle, 46, cursor);
      if (fixed.readUInt32LE(0) !== CENTRAL
          || fixed.readUInt16LE(4) !== UNIX_VERSION
          || fixed.readUInt16LE(6) !== VERSION
          || fixed.readUInt16LE(8) !== UTF8
          || fixed.readUInt16LE(10) !== 0
          || fixed.readUInt16LE(12) !== 0
          || fixed.readUInt16LE(14) !== DOS_DATE
          || fixed.readUInt16LE(30) !== 0
          || fixed.readUInt16LE(32) !== 0
          || fixed.readUInt16LE(34) !== 0
          || fixed.readUInt16LE(36) !== 0) {
        locFail('Bundle member metadata is outside loc.zip.store.v1.',
          'BUNDLE_INTEGRITY_INVALID');
      }
      const nameLength = fixed.readUInt16LE(28);
      if (!nameLength) {
        locFail('Bundle contains an empty member name.',
          'BUNDLE_INTEGRITY_INVALID');
      }
      const name = decodeName(await readExact(handle, nameLength, cursor + 46));
      portablePath(name, {
        control: ['manifest.json', 'manifest.dsse.json'].includes(name)
      });
      const rawMode = fixed.readUInt32LE(38);
      const mode = rawMode === externalMode('0644') ? '0644'
        : rawMode === externalMode('0755') ? '0755' : null;
      if (!mode) {
        locFail('Bundle member ' + name + ' has an unsupported file mode.',
          'BUNDLE_INTEGRITY_INVALID');
      }
      const sizeBytes = fixed.readUInt32LE(24);
      if (fixed.readUInt32LE(20) !== sizeBytes) {
        locFail('Bundle member ' + name + ' is not stored exactly.',
          'BUNDLE_INTEGRITY_INVALID');
      }
      const memberLimit = name === 'manifest.json' ? LOC_LIMITS.maximumManifestBytes
        : name === 'manifest.dsse.json' ? LOC_LIMITS.maximumEnvelopeBytes
          : LOC_LIMITS.maximumFileBytes;
      if (sizeBytes > memberLimit) {
        locFail(`Bundle member '${name}' exceeds its registered byte ceiling.`,
          'BUNDLE_INTEGRITY_INVALID');
      }
      if (!['manifest.json', 'manifest.dsse.json'].includes(name)) {
        declaredContentBytes += sizeBytes;
        if (declaredContentBytes > LOC_LIMITS.maximumContentBytes) {
          locFail('Bundle payload exceeds its registered byte ceiling.',
            'BUNDLE_INTEGRITY_INVALID');
        }
      }
      entries.push({
        path: name,
        mode,
        sizeBytes,
        crc32: fixed.readUInt32LE(16),
        localOffset: fixed.readUInt32LE(42)
      });
      cursor += 46 + nameLength;
    }
    if (cursor !== centralOffset + centralSize) {
      locFail('Bundle central directory has trailing bytes.',
        'BUNDLE_INTEGRITY_INVALID');
    }
    assertUniquePortablePaths(entries.map((entry) => entry.path));
    const sorted = [...entries]
      .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    if (entries.some((entry, index) => entry.path !== sorted[index].path)) {
      locFail('Bundle entries are not in canonical path order.',
        'BUNDLE_INTEGRITY_INVALID');
    }
    const summaries = new Map();
    let expectedOffset = 0;
    for (const entry of entries) {
      if (entry.localOffset !== expectedOffset || entry.localOffset >= centralOffset) {
        locFail('Bundle local members overlap or contain gaps.',
          'BUNDLE_INTEGRITY_INVALID');
      }
      const fixed = await readExact(handle, 30, entry.localOffset);
      const nameLength = fixed.readUInt16LE(26);
      if (fixed.readUInt32LE(0) !== LOCAL
          || fixed.readUInt16LE(4) !== VERSION
          || fixed.readUInt16LE(6) !== UTF8
          || fixed.readUInt16LE(8) !== 0
          || fixed.readUInt16LE(10) !== 0
          || fixed.readUInt16LE(12) !== DOS_DATE
          || fixed.readUInt32LE(14) !== entry.crc32
          || fixed.readUInt32LE(18) !== entry.sizeBytes
          || fixed.readUInt32LE(22) !== entry.sizeBytes
          || fixed.readUInt16LE(28) !== 0) {
        locFail('Bundle local header for ' + entry.path + ' is inconsistent.',
          'BUNDLE_INTEGRITY_INVALID');
      }
      const localName = decodeName(
        await readExact(handle, nameLength, entry.localOffset + 30)
      );
      if (localName !== entry.path) {
        locFail('Bundle central and local member names differ.',
          'BUNDLE_INTEGRITY_INVALID');
      }
      const dataOffset = entry.localOffset + 30 + nameLength;
      let offset = 0;
      let crc = 0xffffffff;
      const hash = createHash('sha256');
      while (offset < entry.sizeBytes) {
        const chunk = await readExact(handle,
          Math.min(1024 * 1024, entry.sizeBytes - offset),
          dataOffset + offset);
        hash.update(chunk);
        crc = crcUpdate(crc, chunk);
        offset += chunk.length;
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      if (crc !== entry.crc32) {
        locFail('Bundle member ' + entry.path + ' failed CRC validation.',
          'BUNDLE_INTEGRITY_INVALID');
      }
      summaries.set(entry.path, Object.freeze({
        ...entry,
        dataOffset,
        sha256: 'sha256:' + hash.digest('hex')
      }));
      expectedOffset = dataOffset + entry.sizeBytes;
    }
    if (expectedOffset !== centralOffset) {
      locFail('Bundle member layout does not end at its central directory.',
        'BUNDLE_INTEGRITY_INVALID');
    }
    await assertStableHandle(handle, retained);
    let closed = false;
    return Object.freeze({
      file,
      sizeBytes,
      archiveSha256,
      entries: summaries,
      async read(pathValue, maximumBytes = LOC_LIMITS.maximumManifestBytes) {
        if (closed) locFail('Bundle reader is already closed.', 'BUNDLE_INTEGRITY_INVALID');
        const entry = summaries.get(pathValue);
        if (!entry) {
          locFail('Bundle member ' + pathValue + ' is missing.',
            'BUNDLE_INTEGRITY_INVALID');
        }
        if (entry.sizeBytes > maximumBytes) {
          locFail('Bundle member ' + pathValue + ' exceeds its read limit.',
            'BUNDLE_INTEGRITY_INVALID');
        }
        await assertStableHandle(handle, retained);
        const bytes = await readExact(handle, entry.sizeBytes, entry.dataOffset);
        await assertStableHandle(handle, retained);
        return bytes;
      },
      async close() {
        if (!closed) {
          closed = true;
          await handle.close();
        }
      }
    });
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
