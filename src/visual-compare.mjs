import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listMcpEvidence } from './mcp-evidence.mjs';
import { decodePngRgba8, encodePngRgba8 } from './png-rgba8.mjs';
import { recordSha256 } from './records.mjs';
import { nowIso, posix, secureRepositoryPath, SingularityFlowError, snapshot, writeAtomic, writeJson } from './util.mjs';

function itemRoot(root, workflow, itemDirectory) {
  return itemDirectory ?? path.join(root, workflow.resolution?.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
}

async function resolveImage(root, workflow, reference, itemDirectory) {
  const records = await listMcpEvidence(root, workflow, { itemDirectory });
  const record = records.find((entry) => entry.id === reference);
  const directory = itemRoot(root, workflow, itemDirectory);
  const target = record
    ? await secureRepositoryPath(directory, record.output?.path ?? '', { label: `Visual evidence '${reference}'`, mustExist: true, type: 'file' })
    : await secureRepositoryPath(root, reference, { label: 'Visual comparison input', mustExist: true, type: 'file' });
  const captured = await snapshot(target.absolute);
  return { record, path: record?.output?.path ?? target.relative, absolute: target.absolute, sha256: captured.sha256, bytes: captured.size, mediaType: record?.output?.mediaType ?? (path.extname(target.absolute).toLowerCase() === '.png' ? 'image/png' : 'application/octet-stream') };
}

function regions(mask, width, height, limit = 100) {
  const seen = new Uint8Array(mask.length), found = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || seen[index]) continue;
    const queue = [index]; seen[index] = 1;
    let cursor = 0, pixels = 0, minX = width, minY = height, maxX = 0, maxY = 0;
    while (cursor < queue.length) {
      const current = queue[cursor++], x = current % width, y = Math.floor(current / width);
      pixels += 1; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      for (const next of [x ? current - 1 : -1, x + 1 < width ? current + 1 : -1, y ? current - width : -1, y + 1 < height ? current + width : -1]) {
        if (next >= 0 && mask[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
      }
    }
    found.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels });
  }
  found.sort((a, b) => b.pixels - a.pixels || a.y - b.y || a.x - b.x);
  return { regions: found.slice(0, limit), overflowRegions: Math.max(0, found.length - limit) };
}

function thresholdStatus(differingPixels, totalPixels, comparison) {
  const ratio = totalPixels ? differingPixels / totalPixels : 0;
  const exceeded = (comparison.maxDifferingPixels != null && differingPixels > comparison.maxDifferingPixels)
    || (comparison.maxDifferingPixelRatio != null && ratio > comparison.maxDifferingPixelRatio);
  if (!exceeded) return 'pass';
  return comparison.mode === 'enforce' ? 'fail' : 'warn';
}

export async function compareVisualArtifacts(root, workflow, {
  expected, actual, profileId = null, itemDirectory = null
} = {}) {
  if (!expected || !actual) throw new SingularityFlowError('Visual comparison requires expected and actual record IDs or repository paths.');
  const comparison = workflow.resolution?.verification?.comparison ?? { mode: 'off', channelTolerance: 0, maxPixels: 40_000_000 };
  if (comparison.mode === 'off') throw new SingularityFlowError('Visual comparison is disabled for this Story.', { code: 'VISUAL_COMPARISON_DISABLED' });
  const left = await resolveImage(root, workflow, expected, itemDirectory), right = await resolveImage(root, workflow, actual, itemDirectory);
  const profile = profileId ? (workflow.resolution?.verification?.profiles ?? []).find((entry) => entry.id === profileId) : null;
  if (profileId && !profile) throw new SingularityFlowError(`Unknown verification profile '${profileId}'.`);
  const identity = { workId: workflow.workItem.id, profileId: profileId ?? left.record?.profileId ?? right.record?.profileId ?? 'unprofiled', expectedSha256: left.sha256, actualSha256: right.sha256, policy: comparison };
  const id = `visual-${recordSha256(identity).slice(0, 24)}`;
  const base = posix(path.join('artifacts', 'visual-verification', 'evidence', identity.profileId, id));
  const directory = itemRoot(root, workflow, itemDirectory);
  let result = {
    schemaVersion: 1, id, kind: 'visual-comparison', ...identity, generatedAt: nowIso(),
    expected: { recordId: left.record?.id ?? null, path: left.path, sha256: left.sha256, bytes: left.bytes },
    actual: { recordId: right.record?.id ?? null, path: right.path, sha256: right.sha256, bytes: right.bytes },
    status: 'pass', disposition: 'identical-hash', dimensions: null, differingPixels: 0, differingPixelRatio: 0, regions: [], overflowRegions: 0, diffImage: null
  };
  if (left.sha256 !== right.sha256) {
    if (left.mediaType !== 'image/png' || right.mediaType !== 'image/png') {
      result = { ...result, status: comparison.mode === 'enforce' ? 'fail' : 'warn', disposition: 'different-hash-unsupported-format' };
    } else {
      const [a, b] = await Promise.all([
        readFile(left.absolute).then((bytes) => decodePngRgba8(bytes, { maxPixels: comparison.maxPixels })),
        readFile(right.absolute).then((bytes) => decodePngRgba8(bytes, { maxPixels: comparison.maxPixels }))
      ]);
      if (a.width !== b.width || a.height !== b.height) {
        result = { ...result, status: comparison.mode === 'enforce' ? 'fail' : 'warn', disposition: 'dimension-mismatch', dimensions: { expected: { width: a.width, height: a.height }, actual: { width: b.width, height: b.height } } };
      } else {
        const count = a.width * a.height, mask = new Uint8Array(count), diff = Buffer.alloc(count * 4);
        let differingPixels = 0;
        for (let pixel = 0; pixel < count; pixel += 1) {
          const offset = pixel * 4;
          const changed = [0, 1, 2, 3].some((channel) => Math.abs(a.data[offset + channel] - b.data[offset + channel]) > comparison.channelTolerance);
          mask[pixel] = changed ? 1 : 0;
          if (changed) { differingPixels += 1; diff[offset] = 255; diff[offset + 1] = 46; diff[offset + 2] = 85; diff[offset + 3] = 255; }
          else { const gray = Math.round((b.data[offset] + b.data[offset + 1] + b.data[offset + 2]) / 3); diff[offset] = gray; diff[offset + 1] = gray; diff[offset + 2] = gray; diff[offset + 3] = 80; }
        }
        const detected = regions(mask, a.width, a.height);
        const diffRelative = `${base}-diff.png`, diffTarget = await secureRepositoryPath(directory, diffRelative, { label: 'Visual comparison diff image' });
        await writeAtomic(diffTarget.absolute, encodePngRgba8({ width: a.width, height: a.height, data: diff }));
        const diffSnapshot = await snapshot(diffTarget.absolute);
        result = { ...result, status: thresholdStatus(differingPixels, count, comparison), disposition: differingPixels ? 'pixel-difference' : 'pixel-identical', dimensions: { width: a.width, height: a.height }, differingPixels, differingPixelRatio: differingPixels / count, ...detected, diffImage: { path: diffRelative, sha256: diffSnapshot.sha256, bytes: diffSnapshot.size } };
      }
    }
  }
  const summaryRelative = `${base}.json`, summary = await secureRepositoryPath(directory, summaryRelative, { label: 'Visual comparison summary' });
  await writeJson(summary.absolute, result);
  return { ...result, path: summaryRelative };
}

export async function listVisualComparisons(root, workflow, { itemDirectory = null } = {}) {
  const { readdir, readFile: read } = await import('node:fs/promises');
  const directory = path.join(itemRoot(root, workflow, itemDirectory), 'artifacts', 'visual-verification', 'evidence');
  const results = [];
  async function walk(current) {
    let entries; try { entries = await readdir(current, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try { const value = JSON.parse(await read(absolute, 'utf8')); if (value.kind === 'visual-comparison') results.push({ ...value, path: posix(path.relative(itemRoot(root, workflow, itemDirectory), absolute)) }); } catch { /* governed checks report malformed evidence elsewhere */ }
      }
    }
  }
  await walk(directory);
  return results.sort((a, b) => a.id.localeCompare(b.id));
}
