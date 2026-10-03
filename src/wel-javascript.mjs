/**
 * WEL's observe-only Jest/Vitest projection over the one JavaScript declaration reader.
 *
 * Declarations come from src/verification/javascript-declarations.mjs: literal `describe` paths,
 * single or double quotes, the whole test body in the revision digest, and the `@ac` criterion
 * tags in the comments directly above each test. This projection joins tagged declarations to
 * reporter occurrences without granting approval or execution authority. No Candidate source is
 * loaded or executed.
 */
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import { assertCredentialFreeRemote, remoteFingerprint } from './git-remote-diagnostics.mjs';
import { recordSha256 } from './records.mjs';
import { posix, run, secureRepositoryPath } from './util.mjs';
import { scanJavaScriptDeclarations } from './verification/javascript-declarations.mjs';
import { joinDeclaration } from './verification/join.mjs';

const PROFILES = Object.freeze({
  'jest-static-v1': 'jest-json',
  'vitest-static-v1': 'vitest-json'
});
const QUALIFIED_CLAUSE = /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/;
const SOURCE_FILE = /(?:^|\/)(?:__tests__\/[^/]+|[^/]+\.(?:test|spec))\.(?:[cm]?[jt]sx?)$/i;
const MAX_SOURCES = 256;
const MAX_SOURCE_BYTES = 1024 * 1024;
const UNSUPPORTED_COMMAND = new Set([
  '-t', '--testnamepattern', '--runtestsbypath', '--findrelatedtests', '--changed',
  '--changedsince', '--onlychanged', '--retry', '--retries', '--shard'
]);

function unavailable(reason, details = null) {
  const gaps = [...new Set((Array.isArray(reason) ? reason : [reason]).map(String).filter(Boolean))]
    .sort();
  return Object.freeze({
    status: 'unavailable', exact: false, catalog: null, mappingProposals: [], occurrences: [], gaps,
    notice: details
      ? `exact JavaScript test identity is unavailable: ${details}`
      : 'exact JavaScript test identity is unavailable'
  });
}

function repositorySha256(root) {
  const remote = run('git', ['config', '--get', 'remote.origin.url'], {
    cwd: root, allowFailure: true
  }).stdout.trim();
  if (!remote) return null;
  try { return `sha256:${remoteFingerprint(assertCredentialFreeRemote(remote))}`; }
  catch { return null; }
}

function sourceInsideModule(relative, moduleRoot) {
  const prefix = moduleRoot === '.' ? '' : `${posix(moduleRoot).replace(/\/$/, '')}/`;
  return relative.startsWith(prefix) && SOURCE_FILE.test(relative.slice(prefix.length));
}

async function trackedSources(root, moduleRoot) {
  const listing = run('git', ['ls-files', '-z', '--', moduleRoot === '.' ? '.' : moduleRoot], {
    cwd: root, maxBuffer: 8 * 1024 * 1024
  }).stdout.split('\0').filter(Boolean).map(posix)
    .filter((entry) => sourceInsideModule(entry, moduleRoot));
  if (listing.length > MAX_SOURCES) return { sources: [], gap: 'TEST_SOURCE_LIMIT_EXCEEDED' };
  const sources = [];
  for (const relative of listing) {
    if (/[\\\u0000-\u001f\u007f]/u.test(relative)) {
      return { sources: [], gap: 'SOURCE_PATH_INVALID' };
    }
    const secured = await secureRepositoryPath(root, relative, {
      label: 'WEL JavaScript test source', mustExist: true, type: 'file'
    });
    let handle;
    try {
      handle = await open(secured.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const before = await handle.stat();
      const link = await lstat(secured.absolute);
      if (!before.isFile() || link.isSymbolicLink() || before.nlink !== 1
          || link.dev !== before.dev || link.ino !== before.ino || before.size > MAX_SOURCE_BYTES) {
        return { sources: [], gap: 'TEST_SOURCE_LIMIT_EXCEEDED' };
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
          || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        return { sources: [], gap: 'TEST_SOURCE_CHANGED_DURING_CAPTURE' };
      }
      sources.push({ path: relative, bytes });
    } catch {
      return { sources: [], gap: 'JAVASCRIPT_TEST_SOURCE_UNAVAILABLE' };
    } finally {
      await handle?.close();
    }
  }
  return { sources, gap: null };
}

/** Every tagged declaration of the captured sources, or the first reason none can be exact. */
function declarationCatalog(sources, framework) {
  const declarations = [];
  const gaps = new Set();
  for (const captured of sources) {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(captured.bytes); }
    catch { gaps.add('JAVASCRIPT_SOURCE_NOT_UTF8'); continue; }
    const scanned = scanJavaScriptDeclarations(source, { sourcePath: captured.path, framework });
    if (scanned.unattachedTags.length) gaps.add('UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE');
    for (const declaration of scanned.declarations.filter((entry) => entry.clauseIds.length)) {
      if (declaration.gaps.some((entry) => entry.code === 'DUPLICATE_DECLARATION')) { gaps.add('TEST_DECLARATION_COLLISION'); continue; }
      if (declaration.gaps.length || declaration.parameters) { gaps.add('UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE'); continue; }
      declarations.push(declaration);
    }
  }
  return { declarations, gaps: [...gaps].sort() };
}

function identityOf(declaration, repositoryIdentity) {
  return {
    schema: declaration.schema, repositorySha256: repositoryIdentity, sourcePath: declaration.sourcePath,
    framework: declaration.framework, suitePath: declaration.suitePath, testName: declaration.name
  };
}

export function classifyJavascriptTestCommandScope(command) {
  const argv = Array.isArray(command?.argv) ? command.argv.map(String) : [];
  const gaps = new Set();
  for (const token of argv.slice(1)) {
    const flag = token.toLowerCase().split('=')[0];
    if (UNSUPPORTED_COMMAND.has(flag)) gaps.add('FOCUSED_OR_RETRIED_TEST_EXECUTION_UNSUPPORTED');
  }
  return Object.freeze({ status: gaps.size ? 'unsupported' : 'complete', gaps: [...gaps].sort() });
}

function exactProposal(declaration, clauseId, parser, profile) {
  const core = {
    schemaVersion: 1, // schema-transient: embedded proposal in current test-execution v4 (introduced by v3).
    kind: 'wel-witness-mapping-proposal', clauseId, witnessType: 'test',
    executionProfile: profile, logicalTestId: declaration.logicalTestId,
    sourcePath: declaration.sourcePath,
    sourceDeclarationSha256: declaration.declarationSha256,
    parserManifestSha256: parser.manifestSha256
  };
  return { ...core, mappingSha256: `sha256:${recordSha256(core)}`, reviewStatus: 'unreviewed' };
}

export async function observeJavascriptTestIdentities(root, command, parsed, testcasePolicy) {
  const profile = testcasePolicy?.adapter;
  const resultAdapter = PROFILES[profile];
  if (testcasePolicy?.mode !== 'observe' || !resultAdapter
      || parsed?.adapter !== resultAdapter || !parsed?.testcaseObservation) return null;
  const commandScope = classifyJavascriptTestCommandScope(command);
  if (commandScope.gaps.length) return unavailable(commandScope.gaps);
  let sourceSet;
  try { sourceSet = await trackedSources(root, command.workingDirectory); }
  catch (error) { return unavailable('JAVASCRIPT_SOURCE_CATALOG_UNAVAILABLE', error.message); }
  if (sourceSet.gap) return unavailable(sourceSet.gap);
  if (!sourceSet.sources.length) return unavailable('JAVASCRIPT_TEST_SOURCES_UNAVAILABLE');
  const framework = profile.startsWith('jest-') ? 'jest' : 'vitest';
  const catalog = declarationCatalog(sourceSet.sources, framework);
  if (catalog.gaps.length) return unavailable(catalog.gaps[0]);
  const repositoryIdentity = repositorySha256(root);
  if (!repositoryIdentity) return unavailable('REPOSITORY_IDENTITY_UNAVAILABLE');
  const parser = {
    id: 'sflow-javascript-static-parser', version: 2,
    manifestSha256: `sha256:${recordSha256({ id: 'sflow-javascript-static-parser', version: 2 })}`
  };
  const declarations = catalog.declarations.map((entry) => ({
    ...entry, repositorySha256: repositoryIdentity, logicalTestId: `sha256:${recordSha256(identityOf(entry, repositoryIdentity))}`
  }));
  const gaps = new Set();
  const proposals = [];
  const exactOccurrences = [];
  for (const declaration of declarations) {
    const joined = joinDeclaration(declaration, parsed.testcaseObservation.occurrences ?? [], { language: 'javascript' });
    if (!['passed', 'failed', 'unverified-skipped', 'flaky'].includes(joined.outcome)) {
      gaps.add(joined.outcome === 'ambiguous' ? 'REPORT_TEST_IDENTITY_AMBIGUOUS' : 'REPORT_SOURCE_DECLARATION_UNMATCHED');
      continue;
    }
    const match = (parsed.testcaseObservation.occurrences ?? []).find((occurrence) => occurrence.name === declaration.name
      && JSON.stringify(occurrence.ancestorTitles ?? []) === JSON.stringify(declaration.suitePath));
    for (const clauseId of declaration.clauseIds) proposals.push(exactProposal(declaration, clauseId, parser, profile));
    exactOccurrences.push({
      ...match, logicalTestId: declaration.logicalTestId,
      declarationSha256: declaration.declarationSha256,
      sourcePath: declaration.sourcePath, clauseIds: declaration.clauseIds,
      exact: true, identityStatus: 'exact-static-identity',
      verdict: match.outcome === 'failed' ? 'failed' : 'inconclusive'
    });
  }
  if (!declarations.length) gaps.add('TAGGED_TEST_DECLARATIONS_UNAVAILABLE');
  if (!proposals.length) gaps.add('WITNESS_MAPPING_PROPOSALS_UNAVAILABLE');
  if (new Set(proposals.map((entry) => entry.mappingSha256)).size !== proposals.length) {
    gaps.add('WITNESS_MAPPING_COLLISION');
  }
  const exact = gaps.size === 0 && exactOccurrences.length > 0;
  const catalogCore = {
    schemaVersion: 1, // schema-transient: embedded catalog in current test-execution v4 (introduced by v3).
    kind: 'wel-javascript-static-catalog', parser, repositorySha256: repositoryIdentity,
    framework, sourceCount: sourceSet.sources.length,
    declarations: declarations.map((declaration) => ({
      schema: declaration.schema, repositorySha256: repositoryIdentity, sourcePath: declaration.sourcePath,
      framework: declaration.framework, suitePath: declaration.suitePath, testName: declaration.name,
      logicalTestId: declaration.logicalTestId, declarationSha256: declaration.declarationSha256,
      span: declaration.span, clauseIds: declaration.clauseIds
    }))
  };
  return Object.freeze({
    status: 'observed', exact,
    catalog: { ...catalogCore, catalogSha256: `sha256:${recordSha256(catalogCore)}` },
    mappingProposals: exact
      ? proposals.sort((left, right) => left.mappingSha256.localeCompare(right.mappingSha256)) : [],
    occurrences: exact ? exactOccurrences : [], gaps: [...gaps].sort(),
    notice: exact
      ? `exact static ${framework} identities observed locally; mappings remain unreviewed and execution remains non-authoritative`
      : `${framework} source/report identities could not be joined exactly; local observation remains inconclusive`
  });
}

export function javascriptWelAdapterManifest(profile) {
  if (!Object.hasOwn(PROFILES, profile)) return null;
  return Object.freeze({
    id: profile, parser: 'sflow-javascript-static-parser', resultAdapter: PROFILES[profile],
    limits: { sources: MAX_SOURCES, sourceBytes: MAX_SOURCE_BYTES },
    manifestSha256: `sha256:${recordSha256({ id: profile, parser: 'sflow-javascript-static-parser', version: 2 })}`
  });
}

export function javascriptWelResultAdapter(profile) {
  return PROFILES[profile] ?? null;
}
