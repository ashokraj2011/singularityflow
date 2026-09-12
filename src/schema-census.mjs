/** Read-only repository census for registered durable-record schemas. */
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { SingularityFlowError } from './util.mjs';
import { familyForStoredPath, migrationRegistrySnapshot, readRecord } from './schema-migrations.mjs';
import { loadDefinition } from './config.mjs';
import { loadPortfolio } from './initiative-config.mjs';

function isInside(boundary, candidate) {
  const relative = path.relative(boundary, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function verifiedScanRoot(base, boundary) {
  const requestedBase = path.resolve(base);
  const requestedBoundary = path.resolve(boundary);
  if (!isInside(requestedBoundary, requestedBase)) {
    throw new SingularityFlowError(
      'Schema census refused a governed root outside its verified repository or Git-state boundary.',
      { code: 'SCHEMA_CENSUS_ROOT_UNSAFE' }
    );
  }
  const relative = path.relative(requestedBoundary, requestedBase);
  let cursor = requestedBoundary;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) return null;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new SingularityFlowError(
        'Schema census refused a governed root that is not a real directory inside its verified boundary.',
        { code: 'SCHEMA_CENSUS_ROOT_UNSAFE' }
      );
    }
  }
  const [canonicalBase, canonicalBoundary] = await Promise.all([
    realpath(requestedBase), realpath(requestedBoundary)
  ]);
  if (!isInside(canonicalBoundary, canonicalBase)) {
    throw new SingularityFlowError(
      'Schema census refused a governed root that resolves outside its verified repository or Git-state boundary.',
      { code: 'SCHEMA_CENSUS_ROOT_UNSAFE' }
    );
  }
  return requestedBase;
}

async function jsonFiles(base, prefix, files, {
  maximumFiles, excludedDirectories = [], boundary = base
}) {
  const scanBase = await verifiedScanRoot(base, boundary);
  if (!scanBase) return;
  const excluded = new Set(excludedDirectories.map((directory) => path.resolve(directory)));
  async function visit(directory, relative = '') {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= maximumFiles) return;
      const absolute = path.join(directory, entry.name);
      const nested = relative ? `${relative}/${entry.name}` : entry.name;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory() && !excluded.has(path.resolve(absolute))) await visit(absolute, nested);
      else if (info.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'))) {
        files.push({ absolute, relative: `${prefix}${nested}`, bytes: info.size });
      }
    }
  }
  await visit(scanBase);
}

function resultFor(entry) {
  return {
    family: entry.id,
    currentVersion: entry.currentVersion,
    readable: { minimum: entry.minimumReadableVersion, maximum: entry.maximumReadableVersion },
    records: 0,
    unversionedRecords: 0,
    validatedRecords: 0,
    readTimeMigrationRecords: 0,
    readTimeMigrationSteps: 0,
    versions: {},
    outsideRange: [],
    unreadable: []
  };
}

function safeReadFailure(error, family, storedVersion) {
  const code = typeof error?.code === 'string' && /^SCHEMA_[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : 'SCHEMA_RECORD_READ_FAILED';
  const subject = code === 'SCHEMA_VERSION_INVALID'
    ? `registered ${family} record with invalid schema version`
    : storedVersion == null
    ? `registered ${family} unversioned record`
    : `registered ${family} v${storedVersion} record`;
  return {
    family,
    storedVersion: storedVersion ?? null,
    code,
    // Do not copy arbitrary exception text into diagnostics. Migration implementations may inspect
    // sensitive durable fields; the family, version, and stable error code are enough to select the
    // recovery path without echoing record content, paths embedded by a dependency, or a stack.
    reason: `${subject} failed non-writing migration validation (${code})`
  };
}

function unreadableFile(pathname, code, reason) {
  return { path: pathname, code, reason };
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
  const [definition, portfolio] = await Promise.all([
    loadDefinition(root).catch(() => null),
    loadPortfolio(root, { required: false }).catch(() => null)
  ]);
  const familyRoots = {
    workItemRoot: definition?.workItemRoot ?? null,
    initiativeRoot: portfolio?.initiativeRoot ?? null
  };
  const repositoryBoundary = path.resolve(root);
  const repositoryRoots = [
    { relative: 'singularity', absolute: path.join(root, 'singularity') },
    { relative: '.sdlc', absolute: path.join(root, '.sdlc') },
    ...(familyRoots.workItemRoot ? [{ relative: familyRoots.workItemRoot, absolute: path.resolve(root, familyRoots.workItemRoot) }] : []),
    ...(familyRoots.initiativeRoot ? [{ relative: familyRoots.initiativeRoot, absolute: path.resolve(root, familyRoots.initiativeRoot) }] : [])
  ].sort((left, right) => left.absolute.length - right.absolute.length);
  const selectedRoots = [];
  for (const candidate of repositoryRoots) {
    if (selectedRoots.some((selected) => candidate.absolute === selected.absolute
      || candidate.absolute.startsWith(`${selected.absolute}${path.sep}`))) continue;
    selectedRoots.push(candidate);
  }
  for (const selected of selectedRoots) {
    await jsonFiles(selected.absolute, `${selected.relative.replaceAll('\\', '/').replace(/\/+$/, '')}/`, files, {
      maximumFiles,
      boundary: repositoryBoundary
    });
  }
  const gitBoundary = path.resolve(gitCommonDir(root));
  const gitState = path.join(gitBoundary, 'singularity-flow');
  // Managed SGOS quarantine contains preserved opaque or incomplete bytes which this build must
  // not reinterpret. Only active Process state participates in migration readiness; quarantined
  // bytes can never be restored or resumed as current authority. Exclude the preview-era archive
  // directory too so an existing installation remains healthy after upgrading the command label.
  await jsonFiles(gitState, '$git/', files, {
    maximumFiles,
    excludedDirectories: [
      path.join(gitState, 'sgos', 'archives'),
      path.join(gitState, 'sgos', 'quarantine')
    ],
    boundary: gitBoundary
  });

  const families = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, resultFor(entry)]));
  const unregistered = [];
  const unreadable = [];
  let scannedRecords = 0;
  let recordLimitReached = false;
  const recordFailure = (summary, error, familyId, storedVersion, filePath) => {
    const failure = { path: filePath, ...safeReadFailure(error, familyId, storedVersion) };
    summary.unreadable.push(failure);
    unreadable.push(failure);
  };
  const observe = (record, filePath, familyPath) => {
    if (scannedRecords >= maximumRecords) { recordLimitReached = true; return; }
    scannedRecords += 1;
    const family = familyForStoredPath(familyPath, familyRoots);
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      if (!family) return;
      const summary = families.get(family.id);
      summary.records += 1;
      summary.unversionedRecords += 1;
      try { readRecord(family.id, record); }
      catch (error) { recordFailure(summary, error, family.id, null, filePath); }
      return;
    }
    if (!family) {
      if (record.schemaVersion == null) return;
      const schemaVersion = Number.isSafeInteger(record.schemaVersion)
        ? record.schemaVersion : null;
      unregistered.push({
        path: filePath,
        schemaVersion,
        ...(schemaVersion == null ? { code: 'SCHEMA_VERSION_INVALID' } : {})
      });
      return;
    }
    const storedVersion = record.schemaVersion ?? family.unversionedAs;
    // Some explicitly registered families have a documented legacy unversioned shape. Those bytes
    // are not exempt from the proof: readRecord applies the declared compatibility version before
    // running the same migrations as an ordinary application read.
    const summary = families.get(family.id);
    summary.records += 1;
    if (record.schemaVersion == null) summary.unversionedRecords += 1;
    if (storedVersion != null) {
      if (!Number.isSafeInteger(storedVersion)) {
        recordFailure(summary, { code: 'SCHEMA_VERSION_INVALID' }, family.id, null, filePath);
        return;
      }
      const key = String(storedVersion);
      summary.versions[key] = (summary.versions[key] ?? 0) + 1;
      if (storedVersion < family.minimumReadableVersion
          || storedVersion > family.maximumReadableVersion) {
        summary.outsideRange.push({ path: filePath, storedVersion });
        return;
      }
    }
    try {
      const readable = readRecord(family.id, record);
      summary.validatedRecords += 1;
      if (readable.migratedThrough.length) {
        summary.readTimeMigrationRecords += 1;
        summary.readTimeMigrationSteps += readable.migratedThrough.length;
      }
    } catch (error) {
      recordFailure(summary, error, family.id, storedVersion, filePath);
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
      unreadable.push(unreadableFile(
        file.relative,
        'SCHEMA_CENSUS_FILE_TOO_LARGE',
        `file exceeds the ${maximumFileBytes}-byte census bound`
      ));
      continue;
    }
    let content;
    try { content = await readFile(file.absolute, 'utf8'); }
    catch {
      // OS errors may contain an absolute path, username, share name, or other machine-local
      // material. The bounded relative path already identifies the record for repair.
      unreadable.push(unreadableFile(
        file.relative,
        'SCHEMA_CENSUS_FILE_READ_FAILED',
        'file could not be read'
      ));
      continue;
    }
    if (file.relative.endsWith('.jsonl')) {
      for (const [index, line] of content.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        if (scannedRecords >= maximumRecords) { recordLimitReached = true; break; }
        try { observe(JSON.parse(line), `${file.relative}#L${index + 1}`, file.relative); }
        catch {
          // Current Node versions include an excerpt of malformed input in JSON.parse messages.
          // Never copy that message into doctor/reinitialization diagnostics.
          unreadable.push(unreadableFile(
            `${file.relative}#L${index + 1}`,
            'SCHEMA_CENSUS_JSON_INVALID',
            'record is not valid JSON'
          ));
        }
      }
    } else {
      try { observe(JSON.parse(content), file.relative, file.relative); }
      catch {
        unreadable.push(unreadableFile(
          file.relative,
          'SCHEMA_CENSUS_JSON_INVALID',
          'record is not valid JSON'
        ));
      }
    }
  }
  const selected = [...families.values()].filter((entry) => entry.records || entry.outsideRange.length)
    .sort((left, right) => left.family.localeCompare(right.family));
  const outsideRange = selected.reduce((total, entry) => total + entry.outsideRange.length, 0);
  const validatedRecords = selected.reduce((total, entry) => total + entry.validatedRecords, 0);
  const readTimeMigrationRecords = selected.reduce((total, entry) => total + entry.readTimeMigrationRecords, 0);
  const readTimeMigrationSteps = selected.reduce((total, entry) => total + entry.readTimeMigrationSteps, 0);
  return Object.freeze({
    schemaVersion: 1,
    resultType: 'schema-census',
    roots: Object.freeze([...selectedRoots.map((entry) => `${entry.relative.replaceAll('\\', '/').replace(/\/+$/, '')}/`), '$git/']),
    scanned: scannedRecords,
    scannedFiles: files.length,
    truncated: files.length >= maximumFiles || recordLimitReached,
    healthy: outsideRange === 0 && unreadable.length === 0,
    totals: Object.freeze({
      registeredFamilies: migrationRegistrySnapshot().length,
      observedFamilies: selected.length,
      registeredRecords: selected.reduce((total, entry) => total + entry.records, 0),
      validatedRecords,
      readTimeMigrationRecords,
      readTimeMigrationSteps,
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
    `${census.totals.registeredRecords} registered record(s) across ${census.totals.observedFamilies} observed family/families; `
      + `${census.totals.validatedRecords ?? 0} validated through the non-writing reader.`
  ];
  for (const entry of census.families) {
    const versions = Object.entries(entry.versions).sort(([left], [right]) => Number(left) - Number(right))
      .map(([version, count]) => `v${version}: ${count}`).join(', ');
    lines.push(`- ${entry.family}: ${versions || 'none'} · current v${entry.currentVersion} · reads v${entry.readable.minimum}–v${entry.readable.maximum}`);
  }
  if (census.totals.outsideRange) lines.push(`! ${census.totals.outsideRange} record(s) are outside their family read range.`);
  if (census.totals.unregistered) lines.push(`! ${census.totals.unregistered} versioned record(s) are not yet classified as durable families.`);
  if (census.totals.readTimeMigrationRecords) {
    lines.push(`~ ${census.totals.readTimeMigrationRecords} legacy record(s) validated through ${census.totals.readTimeMigrationSteps} read-time migration step(s); stored bytes were unchanged.`);
  }
  if (census.totals.unreadable) lines.push(`! ${census.totals.unreadable} JSON record(s) could not be read or migrated.`);
  if (census.truncated) lines.push('! Census stopped at its bounded file limit.');
  return `${lines.join('\n')}\n`;
}
