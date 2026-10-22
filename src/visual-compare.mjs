import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listMcpEvidence } from './mcp-evidence.mjs';
import { decodePngRgba8, encodePngRgba8 } from './png-rgba8.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { nowIso, posix, secureRepositoryPath, SingularityFlowError, snapshot, writeAtomic, writeJson } from './util.mjs';

function itemRoot(root, workflow, itemDirectory) {
  return itemDirectory ?? path.join(root, workflow.resolution?.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
}

const DOCUMENT_ID = /^DOC-\d+$/u;
const NATIVE_CAPTURE_ID = /^vnc-[0-9a-f-]{36}$/u;

/**
 * A Story document (DOC-nnn) as a comparison input: its catalogued bytes, verified against the
 * catalog SHA-256 (a machine-local document is read from this machine's store).
 */
async function resolveDocumentImage(root, config, workflow, reference) {
  if (!config) throw new SingularityFlowError(`Visual comparison cannot read document ${reference} without the Story's configuration.`, { code: 'VISUAL_COMPARISON_INPUT_UNRESOLVED' });
  const { viewDocument } = await import('./documents-read.mjs');
  const viewed = await viewDocument(root, config, workflow, reference);
  if (!viewed.absolutePath) {
    throw new SingularityFlowError(`Document ${viewed.record.id} is a link, not an image file; compare an uploaded image document, a capture record or a repository path.`, { code: 'VISUAL_COMPARISON_INPUT_UNRESOLVED' });
  }
  const captured = await snapshot(viewed.absolutePath);
  // A machine-local document has no repository path to show; its ID and SHA-256 identify it.
  return { record: { id: viewed.record.id }, path: viewed.record.path ?? null, absolute: viewed.absolutePath,
    sha256: captured.sha256, bytes: captured.size, mediaType: viewed.record.mimeType ?? (path.extname(viewed.absolutePath).toLowerCase() === '.png' ? 'image/png' : 'application/octet-stream') };
}

/**
 * A comparison input named the way the template and coverage name it: an MCP record ID, a native
 * capture ID (vnc-...), a Story document ID (DOC-nnn), or a repository path.
 */
async function resolveImage(root, workflow, reference, itemDirectory, config = null) {
  const directory = itemRoot(root, workflow, itemDirectory);
  if (NATIVE_CAPTURE_ID.test(reference)) {
    const { nativeCaptures } = await import('./visual-coverage.mjs');
    const { records, errors } = await nativeCaptures(directory, workflow);
    const found = records.find((entry) => entry.record.id === reference);
    if (!found) {
      const problem = errors.find((message) => message.includes(`'${reference}'`));
      throw new SingularityFlowError(problem ?? `Native capture ${reference} is not recorded for ${workflow.workItem.id}; visual status lists its captures.`, { code: 'VISUAL_COMPARISON_INPUT_UNRESOLVED' });
    }
    const captured = await snapshot(found.absolute);
    return { record: found.record, path: found.record.output.path, absolute: found.absolute, sha256: captured.sha256, bytes: captured.size, mediaType: 'image/png' };
  }
  if (DOCUMENT_ID.test(reference)) return resolveDocumentImage(root, config, workflow, reference);
  const records = await listMcpEvidence(root, workflow, { itemDirectory });
  const record = records.find((entry) => entry.id === reference);
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
  expected, actual, profileId = null, itemDirectory = null, config = null
} = {}) {
  if (!expected || !actual) throw new SingularityFlowError('Visual comparison requires expected and actual record IDs (MCP, native capture vnc-... or document DOC-nnn) or repository paths.');
  const comparison = workflow.resolution?.verification?.comparison ?? { mode: 'off', channelTolerance: 0, maxPixels: 40_000_000 };
  if (comparison.mode === 'off') throw new SingularityFlowError('Visual comparison is disabled for this Story.', { code: 'VISUAL_COMPARISON_DISABLED' });
  const left = await resolveImage(root, workflow, expected, itemDirectory, config), right = await resolveImage(root, workflow, actual, itemDirectory, config);
  const profile = profileId ? (workflow.resolution?.verification?.profiles ?? []).find((entry) => entry.id === profileId) : null;
  if (profileId && !profile) throw new SingularityFlowError(`Unknown verification profile '${profileId}'.`);
  const identity = { workId: workflow.workItem.id, profileId: profileId ?? left.record?.profileId ?? right.record?.profileId ?? 'unprofiled', expectedSha256: left.sha256, actualSha256: right.sha256, policy: comparison };
  const id = `visual-${recordSha256(identity).slice(0, 24)}`;
  const base = posix(path.join('artifacts', 'visual-verification', 'evidence', identity.profileId, id));
  const directory = itemRoot(root, workflow, itemDirectory);
  let result = {
    schemaVersion: currentSchemaVersion('visual-comparison'), id, kind: 'visual-comparison', ...identity, generatedAt: nowIso(),
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
        const relative = posix(path.relative(itemRoot(root, workflow, itemDirectory), absolute));
        /*
         * Unreadable evidence is reported, not discarded.
         *
         * The comment here used to say governed checks report malformed evidence elsewhere. Nothing
         * does — this module is the only reader, writer and validator of this tree, unlike
         * `context/mcp`, which `verifyMcpEvidence` audits record by record. So truncating or editing
         * a comparison recorded as `fail` made it vanish: the gate counted zero failures and passed,
         * and the dashboard card simply disappeared. Damaging a failing piece of evidence was an
         * undetectable way through the gate, which is the exact opposite of what this record is for.
         */
        try {
          const value = readRecord('visual-comparison', await read(absolute)).record;
          if (value.kind === 'visual-comparison') results.push({ ...value, path: relative });
        } catch (error) {
          results.push({
            id: `unreadable:${relative}`,
            kind: 'visual-comparison',
            unreadable: true,
            status: 'fail',
            path: relative,
            error: error.message
          });
        }
      }
    }
  }
  await walk(directory);
  return results.sort((a, b) => a.id.localeCompare(b.id));
}
