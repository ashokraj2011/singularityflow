/** Read-only repository census for registered durable-record schemas. */
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { exists, SingularityFlowError } from './util.mjs';
import { familyForStoredPath, migrationRegistrySnapshot } from './schema-migrations.mjs';

async function jsonFiles(base, prefix, files, { maximumFiles }) {
  if (!(await exists(base))) return;
  async function visit(directory, relative = '') {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maximumFiles) return;
      const absolute = path.join(directory, entry.name);
      const nested = relative ? `${relative}/${entry.name}` : entry.name;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(absolute, nested);
      else if (info.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'))) {
        files.push({ absolute, relative: `${prefix}${nested}`, bytes: info.size });
      }
    }
  }
  await visit(base);
}

function resultFor(entry) {
  return {
    family: entry.id,
    currentVersion: entry.currentVersion,
    readable: { minimum: entry.minimumReadableVersion, maximum: entry.maximumReadableVersion },
    records: 0,
    versions: {},
    outsideRange: [],
    unreadable: []
  };
}

/**
 * Scan only governed and Git-local state roots. Application JSON is intentionally excluded: a
 * product data file that happens to say schemaVersion is not automatically an SFlow durable family.
 */
export async function schemaCensus(root, { maximumFiles = 20_000, maximumRecords = 100_000, maximumFileBytes = 8 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(maximumFiles) || maximumFiles < 1 || maximumFiles > 100_000) {
    throw new SingularityFlowError('Schema census maximumFiles must be an integer from 1 through 100000.', {
      code: 'SCHEMA_CENSUS_LIMIT_INVALID'
    });
  }
  if (!Number.isInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 1_000_000
      || !Number.isInteger(maximumFileBytes) || maximumFileBytes < 1024 || maximumFileBytes > 64 * 1024 * 1024) {
    throw new SingularityFlowError('Schema census record and byte limits are invalid.', {
      code: 'SCHEMA_CENSUS_LIMIT_INVALID'
    });
  }
  const files = [];
  await jsonFiles(path.join(root, 'singularity'), 'singularity/', files, { maximumFiles });
  await jsonFiles(path.join(root, '.sdlc'), '.sdlc/', files, { maximumFiles });
  const gitState = path.join(gitCommonDir(root), 'singularity-flow');
  await jsonFiles(gitState, '$git/', files, { maximumFiles });

  const families = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, resultFor(entry)]));
  const unregistered = [];
  const unreadable = [];
  let scannedRecords = 0;
  let recordLimitReached = false;
  const observe = (record, filePath, familyPath) => {
    if (scannedRecords >= maximumRecords) { recordLimitReached = true; return; }
    scannedRecords += 1;
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.schemaVersion == null) return;
    const family = familyForStoredPath(familyPath);
    if (!family) {
      unregistered.push({ path: filePath, schemaVersion: record.schemaVersion });
      return;
    }
    const summary = families.get(family.id);
    summary.records += 1;
    const key = String(record.schemaVersion);
    summary.versions[key] = (summary.versions[key] ?? 0) + 1;
    if (!Number.isInteger(record.schemaVersion)
        || record.schemaVersion < family.minimumReadableVersion
        || record.schemaVersion > family.maximumReadableVersion) {
      summary.outsideRange.push({ path: filePath, storedVersion: record.schemaVersion ?? null });
    }
  };
  for (const file of files) {
    if (recordLimitReached) break;
    // Command timings are private, rotating diagnostics. Counting them would make the census (and
    // therefore two otherwise identical repository snapshots) change merely because a read ran.
    // They remain a registered record family and are tested through their own reader/writer path,
    // but are not part of repository schema-upgrade readiness.
    if (/^\$git\/(?:dx|performance)\//.test(file.relative)) continue;
    if (file.bytes > maximumFileBytes) {
      unreadable.push({ path: file.relative, reason: `file exceeds the ${maximumFileBytes}-byte census bound` });
      continue;
    }
    let content;
    try { content = await readFile(file.absolute, 'utf8'); }
    catch (error) {
      unreadable.push({ path: file.relative, reason: error.message });
      continue;
    }
    if (file.relative.endsWith('.jsonl')) {
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        if (scannedRecords >= maximumRecords) { recordLimitReached = true; break; }
        try { observe(JSON.parse(line), `${file.relative}#L${index + 1}`, file.relative); }
        catch (error) { unreadable.push({ path: `${file.relative}#L${index + 1}`, reason: error.message }); }
      }
    } else {
      try { observe(JSON.parse(content), file.relative, file.relative); }
      catch (error) { unreadable.push({ path: file.relative, reason: error.message }); }
    }
  }
  const selected = [...families.values()].filter((entry) => entry.records || entry.outsideRange.length)
    .sort((left, right) => left.family.localeCompare(right.family));
  const outsideRange = selected.reduce((total, entry) => total + entry.outsideRange.length, 0);
  return Object.freeze({
    schemaVersion: 1,
    resultType: 'schema-census',
    roots: Object.freeze(['singularity/', '.sdlc/', '$git/']),
    scanned: scannedRecords,
    scannedFiles: files.length,
    truncated: files.length >= maximumFiles || recordLimitReached,
    healthy: outsideRange === 0 && unreadable.length === 0,
    totals: Object.freeze({
      registeredFamilies: migrationRegistrySnapshot().length,
      observedFamilies: selected.length,
      registeredRecords: selected.reduce((total, entry) => total + entry.records, 0),
      outsideRange,
      unregistered: unregistered.length,
      unreadable: unreadable.length
    }),
    families: Object.freeze(selected),
    unregistered: Object.freeze(unregistered.sort((left, right) => left.path.localeCompare(right.path))),
    unreadable: Object.freeze(unreadable.sort((left, right) => left.path.localeCompare(right.path)))
  });
}

export function schemaCensusText(census) {
  const lines = [
    `Schema census — ${census.healthy ? 'readable' : 'attention required'}`,
    `${census.totals.registeredRecords} registered record(s) across ${census.totals.observedFamilies} observed family/families.`
  ];
  for (const entry of census.families) {
    const versions = Object.entries(entry.versions).sort(([left], [right]) => Number(left) - Number(right))
      .map(([version, count]) => `v${version}: ${count}`).join(', ');
    lines.push(`- ${entry.family}: ${versions || 'none'} · current v${entry.currentVersion} · reads v${entry.readable.minimum}–v${entry.readable.maximum}`);
  }
  if (census.totals.outsideRange) lines.push(`! ${census.totals.outsideRange} record(s) are outside their family read range.`);
  if (census.totals.unregistered) lines.push(`! ${census.totals.unregistered} versioned record(s) are not yet classified as durable families.`);
  if (census.totals.unreadable) lines.push(`! ${census.totals.unreadable} JSON record(s) could not be parsed.`);
  if (census.truncated) lines.push('! Census stopped at its bounded file limit.');
  return `${lines.join('\n')}\n`;
}
