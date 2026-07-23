#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'apps', 'desktop', 'build', 'icon.png');
const target = path.join(root, 'apps', 'desktop', 'build', 'icon.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-icon-'));

try {
  const images = [];
  for (const size of sizes) {
    const output = path.join(temporary, `${size}.png`);
    const resized = spawnSync('sips', ['-z', String(size), String(size), source, '--out', output], { encoding: 'utf8' });
    if (resized.status !== 0) throw new Error(`sips failed while creating ${size}px icon: ${resized.stderr || resized.stdout}`);
    images.push({ size, data: await readFile(output) });
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(images.length * 16);
  let offset = header.length + entries.length;
  images.forEach((image, index) => {
    const position = index * 16;
    entries.writeUInt8(image.size === 256 ? 0 : image.size, position);
    entries.writeUInt8(image.size === 256 ? 0 : image.size, position + 1);
    entries.writeUInt8(0, position + 2);
    entries.writeUInt8(0, position + 3);
    entries.writeUInt16LE(1, position + 4);
    entries.writeUInt16LE(32, position + 6);
    entries.writeUInt32LE(image.data.length, position + 8);
    entries.writeUInt32LE(offset, position + 12);
    offset += image.data.length;
  });
  await writeFile(target, Buffer.concat([header, entries, ...images.map((image) => image.data)]));
  console.log(`Created ${path.relative(root, target)} with ${images.length} PNG icon sizes.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
