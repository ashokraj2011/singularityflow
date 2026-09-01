import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
  SOURCE_LIKE, adapterFiles, evidenceDescriptor, factDraft, implementationSha256,
  languageForPath, result, unavailableDraft, exactText
} from './common.mjs';
import {
  isTestSourcePath, scanInterfaceContracts, scanSignaturesAndExports
} from './closed-structure.mjs';

export const CHANGE_REGION_ID = 'change-region';
export const CHANGE_REGION_VERSION = '1.0.0';
export const CHANGE_REGION_IMPLEMENTATION_SHA256 = implementationSha256(
  CHANGE_REGION_ID,
  CHANGE_REGION_VERSION,
  'constant-process-exact-first-parent-zero-context-change-regions-v2'
);

const MAXIMUM_CHANGED_FILES = 512;
const MAXIMUM_REGIONS_PER_FILE = 256;
const MAXIMUM_STRUCTURAL_SCAN_BYTES = 512 * 1024;

function git(root, args, { allowFailure = false, observer = null } = {}) {
  if (observer != null) observer(Object.freeze([...args]));
  const resultValue = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  if ((resultValue.error || resultValue.status !== 0) && !allowFailure) {
    const error = new Error(resultValue.error?.message ?? resultValue.stderr.trim() ?? 'git failed');
    error.code = 'WMB_CHANGE_REGION_GIT_FAILED';
    throw error;
  }
  return resultValue;
}

function scanUnifiedZeroContextDiff(value) {
  const regions = [];
  let truncated = false;
  for (const line of String(value).split(/\r?\n/)) {
    const match = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (!match) continue;
    const startLine = Number(match[1]);
    const count = match[2] == null ? 1 : Number(match[2]);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(count) || count <= 0) continue;
    const region = { startLine, endLine: startLine + count - 1 };
    if (regions.some((candidate) => (
      candidate.startLine === region.startLine && candidate.endLine === region.endLine
    ))) continue;
    if (regions.length >= MAXIMUM_REGIONS_PER_FILE) {
      truncated = true;
      continue;
    }
    regions.push(region);
  }
  return { regions, truncated };
}

/** Parse only current-side line ranges from a Git zero-context unified diff. */
export function parseUnifiedZeroContextDiff(value) {
  return scanUnifiedZeroContextDiff(value).regions;
}

function baselineCommit(root, sourceSnapshot, observer) {
  if (sourceSnapshot.authority?.baseRevision?.commit) {
    return sourceSnapshot.authority.baseRevision.commit;
  }
  const resultValue = git(root, ['rev-list', '--parents', '-n', '1', sourceSnapshot.revision.commit], {
    allowFailure: true, observer
  });
  if (resultValue.error || resultValue.status !== 0) return null;
  return resultValue.stdout.trim().split(/\s+/)[1] ?? null;
}

function scopePathspecs(scopeManifest) {
  const include = [...scopeManifest.allowedPaths, ...scopeManifest.sharedPaths]
    .map((pattern) => `:(top,glob)${pattern}`);
  const exclude = scopeManifest.excludedPaths
    .map((pattern) => `:(top,exclude,glob)${pattern}`);
  return [...(include.length ? include : [':(top,glob)**']), ...exclude];
}

function currentPathFromHeader(line, currentPaths) {
  let cursor = line.length;
  while (cursor > 0) {
    const boundary = line.lastIndexOf(' b/', cursor);
    if (boundary < 0) return null;
    const candidate = line.slice(boundary + 3);
    if (currentPaths.has(candidate)) return candidate;
    cursor = boundary - 1;
  }
  return null;
}

/** Parse all scoped file hunks from one exact Git diff stream. */
export function parseScopedUnifiedDiff(value, currentPathsValue) {
  const currentPaths = currentPathsValue instanceof Set
    ? currentPathsValue : new Set(currentPathsValue);
  const byPath = new Map();
  let current = null;
  let truncated = false;
  let malformed = false;
  for (const line of String(value).split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      current = currentPathFromHeader(line, currentPaths);
      if (current && !byPath.has(current)) {
        if (byPath.size >= MAXIMUM_CHANGED_FILES) {
          truncated = true;
          current = null;
        } else byPath.set(current, { regions: [], truncated: false });
      }
      continue;
    }
    if (!current || !line.startsWith('@@')) continue;
    const match = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (!match) { malformed = true; continue; }
    const startLine = Number(match[1]);
    const count = match[2] == null ? 1 : Number(match[2]);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(count)) {
      malformed = true;
      continue;
    }
    if (count <= 0) continue;
    const region = { startLine, endLine: startLine + count - 1 };
    const entry = byPath.get(current);
    if (entry.regions.some((candidate) => (
      candidate.startLine === region.startLine && candidate.endLine === region.endLine
    ))) continue;
    if (entry.regions.length >= MAXIMUM_REGIONS_PER_FILE) entry.truncated = true;
    else entry.regions.push(region);
  }
  return { byPath, paths: [...byPath.keys()], truncated, malformed };
}

function changedProjection(root, baseline, revision, scopeManifest, currentPaths, observer) {
  const resultValue = git(root, [
    '-c', 'core.quotepath=false', 'diff', '--unified=0', '--no-color', '--no-renames',
    '--no-ext-diff', '--no-textconv', baseline, revision, '--', ...scopePathspecs(scopeManifest)
  ], { observer, allowFailure: true });
  if (resultValue.error || resultValue.status !== 0) {
    return {
      byPath: new Map(), paths: [], truncated: false, malformed: false,
      failure: resultValue.error?.message ?? String(resultValue.stderr ?? '').trim() ?? 'git diff failed'
    };
  }
  return parseScopedUnifiedDiff(resultValue.stdout, currentPaths);
}

function overlaps(line, region) {
  return line >= region.startLine && line <= region.endLine;
}

function explicitSchemaPath(relative) {
  const basename = path.posix.basename(relative).toLowerCase();
  return /(?:\.schema\.json|^openapi\.(?:json|ya?ml)$|^asyncapi\.(?:json|ya?ml)$)/.test(basename);
}

function unavailableChangeFacts(context, code, detail) {
  return [
    ['changed-symbol', 'symbol'],
    ['contract-change', 'contract'],
    ['structural-impact', 'analysis'],
    ['test-impact', 'test']
  ].filter(([, kind]) => context.scopeManifest.allowedSubjects.includes(kind))
    .map(([factType, kind]) => unavailableDraft({
      factType,
      subject: { kind, id: `change-region:${factType}` },
      attemptedProducer: CHANGE_REGION_ID,
      code,
      detail: `${detail} ${factType} extraction is unavailable.`
    }));
}

export function extractChangeRegions(context) {
  const observations = [];
  const facts = [];
  const baseline = baselineCommit(
    context.root, context.sourceSnapshot, context.changeRegionGitObserver ?? null
  );
  if (!baseline) return result(CHANGE_REGION_ID, observations, unavailableChangeFacts(
    context, 'NO_BASELINE', 'The pinned source revision has no exact first-parent baseline;'
  ));
  const currentFiles = new Map(adapterFiles(context).map((file) => [file.path, file]));
  const changed = changedProjection(
    context.root,
    baseline,
    context.sourceSnapshot.revision.commit,
    context.scopeManifest,
    new Set(currentFiles.keys()),
    context.changeRegionGitObserver ?? null
  );
  if (changed.failure) return result(CHANGE_REGION_ID, observations, unavailableChangeFacts(
    context, 'PARSE_FAILURE', 'The bounded exact first-parent Git diff could not be read;'
  ));
  if (changed.truncated && context.scopeManifest.allowedSubjects.includes('analysis')) {
    facts.push(unavailableDraft({
      factType: 'structural-impact',
      subject: { kind: 'analysis', id: 'change-region:changed-path-limit' },
      attemptedProducer: CHANGE_REGION_ID,
      code: 'PARSE_FAILURE',
      detail: `Change-region extraction reached the registered ${MAXIMUM_CHANGED_FILES}-path bound; omitted paths were not analyzed.`
    }));
  }
  if (changed.malformed && context.scopeManifest.allowedSubjects.includes('analysis')) {
    facts.push(unavailableDraft({
      factType: 'structural-impact',
      subject: { kind: 'analysis', id: 'change-region:malformed-diff' },
      attemptedProducer: CHANGE_REGION_ID,
      code: 'PARSE_FAILURE',
      detail: 'The bounded exact Git diff contained an invalid zero-context hunk header.'
    }));
  }
  for (const relative of changed.paths) {
    const file = currentFiles.get(relative);
    if (!file) continue; // A deletion has no current pinned bytes and cannot mint Evidence.
    const scannedRegions = changed.byPath.get(relative);
    const regions = scannedRegions.regions;
    const sourceLike = SOURCE_LIKE.has(path.posix.extname(relative).toLowerCase());
    const regionsOrFile = regions.length ? regions : [{ startLine: 1, endLine: 1 }];
    if (scannedRegions.truncated && context.scopeManifest.allowedSubjects.includes('analysis')) {
      const subject = { kind: 'analysis', id: `${relative}#change-region-limit` };
      const evidence = evidenceDescriptor(file, { kind: 'symbol', subject });
      observations.push(evidence);
      facts.push(unavailableDraft({
        factType: 'structural-impact',
        subject,
        attemptedProducer: CHANGE_REGION_ID,
        code: 'PARSE_FAILURE',
        detail: `${relative} exceeds the registered ${MAXIMUM_REGIONS_PER_FILE}-region change bound.`,
        evidence: [evidence]
      }));
    }
    let source = null;
    let language = null;
    let declarations = [];
    let interfaces = [];
    if (sourceLike && file.bytes <= MAXIMUM_STRUCTURAL_SCAN_BYTES) {
      try {
        source = exactText(context, file);
        language = languageForPath(relative);
        declarations = language ? scanSignaturesAndExports(source, language) : [];
        interfaces = language ? scanInterfaceContracts(source, language) : [];
      } catch (error) {
        if (error?.code !== 'WMB_EXTRACTION_UNAVAILABLE') throw error;
      }
    }
    if (sourceLike && file.bytes > MAXIMUM_STRUCTURAL_SCAN_BYTES
        && context.scopeManifest.allowedSubjects.includes('contract')) {
      const subject = { kind: 'contract', id: `${relative}#unparsed-change` };
      const evidence = evidenceDescriptor(file, { kind: 'signature', subject });
      observations.push(evidence);
      facts.push(unavailableDraft({
        factType: 'contract-change',
        subject,
        attemptedProducer: CHANGE_REGION_ID,
        code: 'PARSE_FAILURE',
        detail: `${relative} exceeds the registered ${MAXIMUM_STRUCTURAL_SCAN_BYTES}-byte structural change bound.`,
        evidence: [evidence]
      }));
    }
    if (sourceLike && context.scopeManifest.allowedSubjects.includes('symbol')) {
      for (const region of regionsOrFile) {
        const subject = {
          kind: 'symbol', id: `${relative}#change:${region.startLine}-${region.endLine}`
        };
        const evidence = evidenceDescriptor(file, {
          kind: 'symbol', locator: { range: region }, subject
        });
        observations.push(evidence);
        facts.push(factDraft({
          factType: 'changed-symbol',
          subject,
          claim: `${relative} lines ${region.startLine}-${region.endLine} differ from the exact first-parent baseline; no semantic symbol boundary is inferred.`,
          status: 'partial',
          assurance: 'source-exact',
          evidence: [evidence]
        }));
      }
    }
    if (context.scopeManifest.allowedSubjects.includes('contract')) {
      const structural = [
        ...declarations.map((item) => ({
          name: item.name, line: item.line, kind: 'signature'
        })),
        ...interfaces.map((item) => ({
          name: item.kind === 'implementation'
            ? `${item.implementation}->${item.interface}` : item.name,
          line: item.line,
          kind: item.kind === 'implementation' ? 'interface-implementation' : 'signature'
        }))
      ].filter((item, index, values) => values.findIndex((candidate) => (
        candidate.name === item.name && candidate.line === item.line && candidate.kind === item.kind
      )) === index);
      for (const item of structural.filter((candidate) => regionsOrFile.some((region) => (
        overlaps(candidate.line, region)
      )))) {
        const subject = { kind: 'contract', id: `${relative}#${item.name}` };
        const evidence = evidenceDescriptor(file, {
          kind: item.kind,
          locator: {
            symbol: item.name,
            range: { startLine: item.line, endLine: item.line }
          },
          subject
        });
        observations.push(evidence);
        facts.push(factDraft({
          factType: 'contract-change',
          subject,
          claim: `Registered contract declaration ${item.name} in ${relative} at line ${item.line} differs from the exact first-parent baseline.`,
          assurance: 'structurally-derived',
          evidence: [evidence]
        }));
        facts.push(factDraft({
          factType: 'structural-impact',
          subject,
          claim: `The exact change region in ${relative} overlaps registered structural declaration ${item.name}; downstream semantic impact is not inferred.`,
          status: 'partial',
          assurance: 'structurally-derived',
          evidence: [evidence]
        }));
      }
      if (explicitSchemaPath(relative) && regionsOrFile.length) {
        const subject = { kind: 'contract', id: `${relative}#schema` };
        const evidence = evidenceDescriptor(file, {
          kind: 'configuration-object', locator: { range: regionsOrFile[0] }, subject
        });
        observations.push(evidence);
        facts.push(factDraft({
          factType: 'contract-change',
          subject,
          claim: `Explicit schema source ${relative} differs from the exact first-parent baseline.`,
          assurance: 'source-exact',
          evidence: [evidence]
        }));
      }
    }
    if (sourceLike && isTestSourcePath(relative)
        && context.scopeManifest.allowedSubjects.includes('test')) {
      const subject = { kind: 'test', id: `${relative}#changed-test-source` };
      const evidence = evidenceDescriptor(file, {
        kind: 'test-symbol-binding', locator: { range: regionsOrFile[0] }, subject
      });
      observations.push(evidence);
      facts.push(factDraft({
        factType: 'test-impact',
        subject,
        claim: `Test source ${relative} differs from the exact first-parent baseline; test outcome impact is not inferred.`,
        status: 'partial',
        assurance: 'source-exact',
        evidence: [evidence]
      }));
    }
  }
  return result(CHANGE_REGION_ID, observations, facts);
}
