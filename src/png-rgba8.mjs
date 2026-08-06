import { deflateSync, inflateSync } from 'node:zlib';
import { SingularityFlowError } from './util.mjs';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0); name.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePngRgba8(bytes, { maxPixels = 40_000_000, maxCompressedBytes = 25 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > maxCompressedBytes) throw new SingularityFlowError('PNG exceeds the configured compressed-byte limit.', { code: 'PNG_LIMIT' });
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) throw new SingularityFlowError('Input is not a PNG file.', { code: 'PNG_INVALID' });
  let offset = 8, ihdr = null, ended = false;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); offset += 4;
    if (length > maxCompressedBytes || offset + 8 + length > bytes.length) throw new SingularityFlowError('PNG chunk length is invalid.', { code: 'PNG_INVALID' });
    const type = bytes.toString('ascii', offset, offset + 4); offset += 4;
    const data = bytes.subarray(offset, offset + length); offset += length;
    const expected = bytes.readUInt32BE(offset); offset += 4;
    if (crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) !== expected) throw new SingularityFlowError(`PNG ${type} chunk CRC is invalid.`, { code: 'PNG_INVALID' });
    if (type === 'IHDR') {
      if (ihdr || length !== 13) throw new SingularityFlowError('PNG IHDR is invalid.', { code: 'PNG_INVALID' });
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], compression: data[10], filter: data[11], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { ended = true; break; }
  }
  if (!ihdr || !ended || !idat.length) throw new SingularityFlowError('PNG is missing IHDR, IDAT, or IEND.', { code: 'PNG_INVALID' });
  const { width, height, bitDepth, colorType, compression, filter, interlace } = ihdr;
  if (!width || !height || width * height > maxPixels) throw new SingularityFlowError('PNG dimensions exceed the configured pixel limit.', { code: 'PNG_LIMIT' });
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || compression !== 0 || filter !== 0 || interlace !== 0) {
    throw new SingularityFlowError('Only non-interlaced 8-bit RGB/RGBA PNG files are supported.', { code: 'PNG_UNSUPPORTED' });
  }
  const channels = colorType === 6 ? 4 : 3, stride = width * channels, expectedBytes = (stride + 1) * height;
  let raw;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedBytes }); }
  catch (error) { throw new SingularityFlowError(`PNG decompression failed: ${error.message}`, { code: 'PNG_INVALID' }); }
  if (raw.length !== expectedBytes) throw new SingularityFlowError('PNG decompressed size does not match its dimensions.', { code: 'PNG_INVALID' });
  const scan = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const input = y * (stride + 1), kind = raw[input];
    if (kind > 4) throw new SingularityFlowError(`PNG filter ${kind} is unsupported.`, { code: 'PNG_UNSUPPORTED' });
    for (let x = 0; x < stride; x += 1) {
      const value = raw[input + 1 + x], left = x >= channels ? scan[y * stride + x - channels] : 0;
      const up = y ? scan[(y - 1) * stride + x] : 0;
      const upperLeft = y && x >= channels ? scan[(y - 1) * stride + x - channels] : 0;
      const predictor = kind === 0 ? 0 : kind === 1 ? left : kind === 2 ? up : kind === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      scan[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < scan.length; i += channels, j += 4) {
    rgba[j] = scan[i]; rgba[j + 1] = scan[i + 1]; rgba[j + 2] = scan[i + 2]; rgba[j + 3] = channels === 4 ? scan[i + 3] : 255;
  }
  return { width, height, data: rgba, colorType };
}

export function encodePngRgba8({ width, height, data }, { compressionLevel = 9 } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new SingularityFlowError('PNG output dimensions are invalid.');
  const rgba = Buffer.from(data);
  if (rgba.length !== width * height * 4) throw new SingularityFlowError('PNG RGBA byte count does not match its dimensions.');
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * 4 + 1); raw[offset] = 0;
    rgba.copy(raw, offset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: compressionLevel })), chunk('IEND', Buffer.alloc(0))]);
}

export function pngDimensions(bytes, options = {}) {
  const decoded = decodePngRgba8(bytes, options);
  return { width: decoded.width, height: decoded.height };
}
