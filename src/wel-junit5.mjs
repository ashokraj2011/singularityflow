/**
 * WEL's observe-only JUnit 5/Surefire identity adapter.
 *
 * Source is parsed in a separate JDK compiler process. Candidate classes are never compiled,
 * loaded, or executed here. The adapter can strengthen a report occurrence from name-only to an
 * exact static identity, but it cannot create approval, independent execution authority, or an
 * enforce-grade pass.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { canonicalJson, recordSha256 } from './records.mjs';
import { assertCredentialFreeRemote, remoteFingerprint } from './git-remote-diagnostics.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { posix, run, secureRepositoryPath } from './util.mjs';

const HELPER = path.join(PACKAGE_ROOT, 'src', 'wel', 'WelJunitCatalog.java');
const QUALIFIED_CLAUSE = /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/;
const MAX_SOURCES = 256;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const PARSER_TIMEOUT_MS = 30_000;
const MAVEN_EXECUTABLES = new Set(['mvn', 'mvn.cmd', 'mvnw', 'mvnw.cmd']);
const SUREFIRE_FOCUS_PROPERTIES = new Set([
  'test', 'it.test', 'groups', 'excludedgroups', 'includes', 'excludes',
  'surefire.includes', 'surefire.excludes', 'surefire.includegroups',
  'surefire.excludegroups', 'surefire.includejunit5engines',
  'surefire.excludejunit5engines'
]);
const SUREFIRE_RETRY_PROPERTIES = new Set([
  'rerunfailingtestscount', 'surefire.rerunfailingtestscount'
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function prefixed(value) {
  return `sha256:${sha256(value)}`;
}

function parserUnavailable(reason, details = null) {
  const gaps = (Array.isArray(reason) ? reason : [reason])
    .map(String).filter(Boolean).sort();
  return Object.freeze({
    status: 'unavailable', exact: false, catalog: null, mappingProposals: [], occurrences: [],
    gaps: [...new Set(gaps)],
    notice: details
      ? `exact JUnit source identity is unavailable: ${details}`
      : 'exact JUnit source identity is unavailable'
  });
}

function mavenProperty(token) {
  const match = String(token).match(/^-D([^=]+)(?:=.*)?$/u);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Freeze the observe-only pilot's command subset before source/report reconciliation.
 *
 * The full argv is already digest-bound by the test-execution receipt. This classifier decides
 * whether that argv is eligible for an exact-static identity observation. It deliberately does
 * not reject the ordinary module test: unsupported focus or retry controls only remove WEL's
 * optional exact mapping proposal.
 */
export function classifyJunit5SurefireCommandScope(command) {
  const argv = Array.isArray(command?.argv) ? command.argv.map(String) : [];
  const executable = argv[0]?.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  const gaps = new Set();
  if (!MAVEN_EXECUTABLES.has(executable)) gaps.add('MAVEN_SUREFIRE_COMMAND_UNSUPPORTED');
  for (const token of argv.slice(1)) {
    const property = mavenProperty(token);
    if (SUREFIRE_FOCUS_PROPERTIES.has(property)) gaps.add('FOCUSED_TEST_EXECUTION_UNSUPPORTED');
    if (SUREFIRE_RETRY_PROPERTIES.has(property)) gaps.add('FRAMEWORK_RETRY_UNSUPPORTED');
  }
  return Object.freeze({
    status: gaps.size ? 'unsupported' : 'complete',
    gaps: [...gaps].sort()
  });
}

function moduleTestSource(relative, moduleRoot) {
  const root = moduleRoot === '.' ? '' : `${posix(moduleRoot).replace(/\/$/, '')}/`;
  return relative.startsWith(`${root}src/test/java/`) && relative.endsWith('.java');
}

async function trackedJavaSources(root, moduleRoot) {
  const listing = run('git', ['ls-files', '-z', '--', moduleRoot === '.' ? '.' : moduleRoot], {
    cwd: root, maxBuffer: 8 * 1024 * 1024
  }).stdout.split('\0').filter(Boolean).map(posix).filter((entry) => moduleTestSource(entry, moduleRoot));
  if (listing.length > MAX_SOURCES) return { paths: [], gap: 'TEST_SOURCE_LIMIT_EXCEEDED' };
  const sources = [];
  for (const relative of listing) {
    if (/[\\\u0000-\u001f\u007f]/u.test(relative)) {
      return { paths: [], gap: 'SOURCE_PATH_INVALID' };
    }
    const secured = await secureRepositoryPath(root, relative, {
      label: 'WEL JUnit source', mustExist: true, type: 'file'
    });
    let handle;
    try {
      handle = await open(secured.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const before = await handle.stat();
      const link = await lstat(secured.absolute);
      if (!before.isFile() || link.isSymbolicLink()
          || link.dev !== before.dev || link.ino !== before.ino
          || before.size > MAX_SOURCE_BYTES) {
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
      return { sources: [], gap: 'JUNIT_TEST_SOURCE_UNAVAILABLE' };
    } finally {
      await handle?.close();
    }
    if (sources.at(-1).bytes.length > MAX_SOURCE_BYTES) {
      return { paths: [], gap: 'TEST_SOURCE_LIMIT_EXCEEDED' };
    }
  }
  return { sources, gap: null };
}

function parseHelperOutput(output) {
  const records = [];
  for (const line of String(output).split(/\r?\n/u).filter(Boolean)) {
    const record = JSON.parse(line);
    if (!record || !['gap', 'declaration'].includes(record.kind)) {
      throw new Error('parser emitted an unknown record');
    }
    records.push(record);
  }
  return records;
}

async function sourceDeclarations(root, sources) {
  const helperBytes = await readFile(HELPER);
  const parser = {
    id: 'jdk-compiler-tree-api',
    version: 1,
    manifestSha256: prefixed(helperBytes)
  };
  const captured = new Map(sources.map((source) => [source.path, source.bytes]));
  const staging = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-parser-'));
  try {
    for (const source of sources) {
      const target = path.join(staging, source.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source.bytes, { flag: 'wx', mode: 0o600 });
    }
    const paths = sources.map((source) => source.path);
    const input = `${staging}\n${paths.join('\n')}${paths.length ? '\n' : ''}`;
    const invocation = spawnSync('java', [HELPER], {
      cwd: staging,
      input,
      encoding: 'utf8',
      timeout: PARSER_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        JAVA_HOME: process.env.JAVA_HOME,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8'
      }
    });
    if (invocation.error || invocation.status !== 0 || invocation.signal) {
      const reason = invocation.error?.code === 'ETIMEDOUT' || invocation.signal
        ? 'JUNIT_SOURCE_PARSER_TIMEOUT' : 'JUNIT_SOURCE_PARSER_UNAVAILABLE';
      return { parser, declarations: [], gaps: [reason] };
    }
    let records;
    try { records = parseHelperOutput(invocation.stdout); }
    catch { return { parser, declarations: [], gaps: ['JUNIT_SOURCE_PARSER_MALFORMED'] }; }
    const gaps = records.filter((record) => record.kind === 'gap').map((record) => record.code);
    const declarations = [];
    for (const record of records.filter((entry) => entry.kind === 'declaration')) {
      if (!captured.has(record.path)
          || !Number.isSafeInteger(record.start) || !Number.isSafeInteger(record.end)
          || record.start < 0 || record.end <= record.start
          || !Array.isArray(record.clauseIds) || !record.clauseIds.length
          || record.clauseIds.some((clause) => !QUALIFIED_CLAUSE.test(clause))) {
        gaps.push('JUNIT_SOURCE_PARSER_MALFORMED');
        continue;
      }
      let source;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(captured.get(record.path)); }
      catch { gaps.push('JUNIT_SOURCE_NOT_UTF8'); continue; }
      if (record.end > source.length) {
        gaps.push('JUNIT_SOURCE_PARSER_MALFORMED');
        continue;
      }
      const bytes = Buffer.from(source.slice(record.start, record.end), 'utf8');
      const identity = {
        identitySchema: 'junit5-static-method-v1',
        repositorySha256: null,
        sourcePath: record.path,
        packageName: record.packageName,
        declaringClass: record.className,
        methodName: record.methodName,
        signature: record.signature
      };
      declarations.push({
        ...identity,
        logicalTestId: `sha256:${recordSha256(identity)}`,
        sourceDeclarationSha256: prefixed(bytes),
        sourceRange: {
          startCharacter: record.start,
          endCharacter: record.end,
          bytes: bytes.length
        },
        clauseIds: [...record.clauseIds].sort()
      });
    }
    return { parser, declarations, gaps };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function repositorySha256(root) {
  const remote = run('git', ['config', '--get', 'remote.origin.url'], {
    cwd: root, allowFailure: true
  }).stdout.trim();
  if (!remote) return null;
  try { return `sha256:${remoteFingerprint(assertCredentialFreeRemote(remote))}`; }
  catch { return null; }
}

function exactProposal(declaration, clauseId, parser) {
  const core = {
    schemaVersion: 1, // schema-transient: embedded proposal in test-execution v3.
    kind: 'wel-witness-mapping-proposal',
    clauseId,
    witnessType: 'test',
    executionProfile: 'junit5-surefire-v1',
    logicalTestId: declaration.logicalTestId,
    sourcePath: declaration.sourcePath,
    sourceDeclarationSha256: declaration.sourceDeclarationSha256,
    parserManifestSha256: parser.manifestSha256
  };
  return { ...core, mappingSha256: `sha256:${recordSha256(core)}`, reviewStatus: 'unreviewed' };
}

/**
 * Resolve exact static identities for the enrolled local-observe adapter.
 *
 * Any parser/toolchain/source ambiguity returns an inconclusive observation. It never throws a
 * lifecycle blocker merely because exact WEL evidence is unavailable.
 */
export async function observeJunit5SurefireIdentities(root, command, parsed, testcasePolicy) {
  if (testcasePolicy?.mode !== 'observe' || testcasePolicy?.adapter !== 'junit5-surefire-v1'
      || parsed?.adapter !== 'junit-xml' || !parsed?.testcaseObservation) {
    return null;
  }
  const commandScope = classifyJunit5SurefireCommandScope(command);
  if (commandScope.gaps.length) {
    return parserUnavailable(
      commandScope.gaps,
      'the JUnit exact-static pilot does not admit focused, retried, or non-Maven/Surefire executions'
    );
  }
  let sourceSet;
  try { sourceSet = await trackedJavaSources(root, command.workingDirectory); }
  catch (error) { return parserUnavailable('JUNIT_SOURCE_CATALOG_UNAVAILABLE', error.message); }
  if (sourceSet.gap) return parserUnavailable(sourceSet.gap);
  if (!sourceSet.sources.length) return parserUnavailable('JUNIT_TEST_SOURCES_UNAVAILABLE');
  const catalog = await sourceDeclarations(root, sourceSet.sources);
  if (catalog.gaps.length) return parserUnavailable(catalog.gaps.sort()[0]);
  const repositoryIdentity = repositorySha256(root);
  if (!repositoryIdentity) return parserUnavailable('REPOSITORY_IDENTITY_UNAVAILABLE');
  const declarations = catalog.declarations.map((declaration) => {
    const identity = {
      identitySchema: declaration.identitySchema,
      repositorySha256: repositoryIdentity,
      sourcePath: declaration.sourcePath,
      packageName: declaration.packageName,
      declaringClass: declaration.declaringClass,
      methodName: declaration.methodName,
      signature: declaration.signature
    };
    return { ...declaration, ...identity, logicalTestId: `sha256:${recordSha256(identity)}` };
  });
  const byFrameworkIdentity = new Map();
  const gaps = new Set();
  for (const declaration of declarations) {
    const key = `${declaration.packageName}.${declaration.declaringClass}#${declaration.methodName}`;
    if (byFrameworkIdentity.has(key)) gaps.add('TEST_DECLARATION_COLLISION');
    byFrameworkIdentity.set(key, declaration);
  }
  const reportIdentities = new Map();
  for (const occurrence of parsed.testcaseObservation.occurrences ?? []) {
    const key = `${occurrence.className ?? ''}#${occurrence.name ?? ''}`;
    const entries = reportIdentities.get(key) ?? [];
    entries.push(occurrence);
    reportIdentities.set(key, entries);
  }
  const proposals = [];
  const exactOccurrences = [];
  for (const declaration of declarations) {
    const key = `${declaration.packageName}.${declaration.declaringClass}#${declaration.methodName}`;
    const matches = reportIdentities.get(key) ?? [];
    if (matches.length !== 1 || matches[0].identityStatus !== 'observed-name-only') {
      gaps.add(matches.length > 1 ? 'REPORT_TEST_IDENTITY_AMBIGUOUS' : 'REPORT_SOURCE_DECLARATION_UNMATCHED');
      continue;
    }
    const occurrence = matches[0];
    for (const clauseId of declaration.clauseIds) proposals.push(
      exactProposal(declaration, clauseId, catalog.parser)
    );
    exactOccurrences.push({
      ...occurrence,
      logicalTestId: declaration.logicalTestId,
      declarationSha256: declaration.sourceDeclarationSha256,
      sourcePath: declaration.sourcePath,
      clauseIds: declaration.clauseIds,
      exact: true,
      identityStatus: 'exact-static-identity',
      verdict: occurrence.outcome === 'failed' ? 'failed' : 'inconclusive'
    });
  }
  if (!declarations.length) gaps.add('TAGGED_TEST_DECLARATIONS_UNAVAILABLE');
  if (!proposals.length) gaps.add('WITNESS_MAPPING_PROPOSALS_UNAVAILABLE');
  const mappingKeys = new Set();
  for (const proposal of proposals) {
    if (mappingKeys.has(proposal.mappingSha256)) gaps.add('WITNESS_MAPPING_COLLISION');
    mappingKeys.add(proposal.mappingSha256);
  }
  const exact = gaps.size === 0 && exactOccurrences.length > 0;
  const catalogCore = {
    schemaVersion: 1, // schema-transient: embedded catalog in test-execution v3.
    kind: 'wel-junit5-static-catalog',
    parser: catalog.parser,
    repositorySha256: repositoryIdentity,
    sourceCount: sourceSet.sources.length,
    declarations
  };
  return Object.freeze({
    status: 'observed',
    exact,
    catalog: { ...catalogCore, catalogSha256: `sha256:${recordSha256(catalogCore)}` },
    mappingProposals: proposals.sort((left, right) => left.mappingSha256.localeCompare(right.mappingSha256)),
    occurrences: exactOccurrences,
    gaps: [...gaps].sort(),
    notice: exact
      ? 'exact static JUnit identities observed locally; mappings remain unreviewed and execution remains non-authoritative'
      : 'JUnit source/report identities could not be joined exactly; local observation remains inconclusive'
  });
}

export function welJunitAdapterManifest() {
  return Object.freeze({
    id: 'junit5-surefire-v1',
    parser: 'jdk-compiler-tree-api',
    parserSource: 'wel/WelJunitCatalog.java',
    limits: {
      sources: MAX_SOURCES,
      sourceBytes: MAX_SOURCE_BYTES,
      outputBytes: MAX_OUTPUT_BYTES,
      timeoutMs: PARSER_TIMEOUT_MS
    },
    manifestSha256: `sha256:${recordSha256({
      id: 'junit5-surefire-v1', parser: 'jdk-compiler-tree-api', version: 1
    })}`
  });
}

function rawOccurrenceProjection(occurrence) {
  if (occurrence.identityStatus !== 'exact-static-identity') return occurrence;
  return {
    suite: occurrence.suite ?? null,
    className: occurrence.className ?? null,
    name: occurrence.name ?? null,
    outcome: occurrence.outcome,
    verdict: 'inconclusive',
    durationMs: occurrence.durationMs ?? null,
    logicalTestId: null,
    declarationSha256: null,
    exact: false,
    identityStatus: 'observed-name-only'
  };
}

/** Replay the exact static part of a durable local observation without granting it authority. */
export async function verifyJunit5SurefireIdentityObservation(root, observation, {
  evidenceCommit = null
} = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (observation?.exact !== true || observation?.profile !== 'junit5-surefire-v1'
      || observation?.verdict !== 'inconclusive'
      || observation?.disposition !== 'unreviewed-witness-observed') {
    return { valid: false, errors: ['exact local JUnit observation envelope is invalid'], rawOccurrences: [] };
  }
  const catalog = observation.catalog;
  if (!catalog || catalog.kind !== 'wel-junit5-static-catalog'
      || catalog.parser?.id !== 'jdk-compiler-tree-api'
      || !/^sha256:[a-f0-9]{64}$/.test(catalog.parser?.manifestSha256 ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(catalog.repositorySha256 ?? '')) {
    return { valid: false, errors: ['exact local JUnit catalog identity is invalid'], rawOccurrences: [] };
  }
  const { catalogSha256, ...catalogCore } = catalog;
  if (catalogSha256 !== `sha256:${recordSha256(catalogCore)}`) fail('JUnit catalog digest is invalid');
  const declarations = new Map();
  for (const declaration of catalog.declarations ?? []) {
    const identity = {
      identitySchema: declaration.identitySchema,
      repositorySha256: declaration.repositorySha256,
      sourcePath: declaration.sourcePath,
      packageName: declaration.packageName,
      declaringClass: declaration.declaringClass,
      methodName: declaration.methodName,
      signature: declaration.signature
    };
    if (declaration.repositorySha256 !== catalog.repositorySha256
        || declaration.logicalTestId !== `sha256:${recordSha256(identity)}`
        || !Array.isArray(declaration.clauseIds)
        || declaration.clauseIds.some((clause) => !QUALIFIED_CLAUSE.test(clause))) {
      fail(`JUnit declaration '${declaration.logicalTestId ?? 'unknown'}' has an invalid identity`);
      continue;
    }
    let sourceBytes;
    if (evidenceCommit) {
      const source = run('git', ['show', `${evidenceCommit}:${declaration.sourcePath}`], {
        cwd: root, allowFailure: true, encoding: 'buffer', maxBuffer: MAX_SOURCE_BYTES + 1
      });
      if (source.status !== 0) {
        fail(`JUnit declaration source '${declaration.sourcePath}' is absent from the evidence commit`);
        continue;
      }
      sourceBytes = source.stdout;
    } else {
      try {
        const secured = await secureRepositoryPath(root, declaration.sourcePath, {
          label: 'WEL JUnit replay source', mustExist: true, type: 'file'
        });
        sourceBytes = await readFile(secured.absolute);
      } catch {
        fail(`JUnit declaration source '${declaration.sourcePath}' is unavailable`);
        continue;
      }
    }
    let sourceText;
    try { sourceText = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes); }
    catch { fail(`JUnit declaration source '${declaration.sourcePath}' is not UTF-8`); continue; }
    const range = declaration.sourceRange;
    if (!Number.isSafeInteger(range?.startCharacter) || !Number.isSafeInteger(range?.endCharacter)
        || range.startCharacter < 0 || range.endCharacter <= range.startCharacter
        || range.endCharacter > sourceText.length) {
      fail(`JUnit declaration '${declaration.logicalTestId}' has an invalid source range`);
      continue;
    }
    const declarationBytes = Buffer.from(
      sourceText.slice(range.startCharacter, range.endCharacter), 'utf8'
    );
    if (range.bytes !== declarationBytes.length
        || declaration.sourceDeclarationSha256 !== prefixed(declarationBytes)) {
      fail(`JUnit declaration '${declaration.logicalTestId}' bytes changed`);
      continue;
    }
    if (declarations.has(declaration.logicalTestId)) fail('JUnit catalog repeats a logical identity');
    declarations.set(declaration.logicalTestId, declaration);
  }
  const proposals = new Map();
  for (const proposal of observation.mappingProposals ?? []) {
    const { mappingSha256, reviewStatus, ...core } = proposal;
    const declaration = declarations.get(proposal.logicalTestId);
    if (reviewStatus !== 'unreviewed'
        || mappingSha256 !== `sha256:${recordSha256(core)}`
        || !declaration
        || !declaration.clauseIds.includes(proposal.clauseId)
        || proposal.sourcePath !== declaration.sourcePath
        || proposal.sourceDeclarationSha256 !== declaration.sourceDeclarationSha256
        || proposal.parserManifestSha256 !== catalog.parser.manifestSha256) {
      fail(`JUnit witness proposal '${mappingSha256 ?? 'unknown'}' is invalid`);
      continue;
    }
    if (proposals.has(mappingSha256)) fail('JUnit observation repeats a mapping proposal');
    proposals.set(mappingSha256, proposal);
  }
  if (!declarations.size || !proposals.size) fail('exact JUnit observation has no declaration or mapping proposal');
  const occurrenceKeys = new Set();
  const occurrenceLogicalIds = new Set();
  for (const occurrence of observation.occurrences ?? []) {
    if (occurrence.identityStatus !== 'exact-static-identity') {
      if (occurrence.identityStatus !== 'observed-name-only'
          || occurrence.exact !== false
          || occurrence.verdict !== 'inconclusive'
          || occurrence.logicalTestId != null
          || occurrence.declarationSha256 != null) {
        fail('exact JUnit observation contains an invalid supplemental occurrence');
      }
      continue;
    }
    const declaration = declarations.get(occurrence.logicalTestId);
    const key = `${occurrence.className ?? ''}#${occurrence.name ?? ''}`;
    if (occurrenceKeys.has(key)) fail('exact JUnit observation repeats a report identity');
    occurrenceKeys.add(key);
    if (occurrenceLogicalIds.has(occurrence.logicalTestId)) {
      fail('exact JUnit observation repeats a logical identity');
    }
    occurrenceLogicalIds.add(occurrence.logicalTestId);
    if (!declaration
        || occurrence.exact !== true
        || occurrence.declarationSha256 !== declaration.sourceDeclarationSha256
        || occurrence.sourcePath !== declaration.sourcePath
        || occurrence.className !== `${declaration.packageName}.${declaration.declaringClass}`
        || occurrence.name !== declaration.methodName
        || !['passed', 'failed', 'skipped'].includes(occurrence.outcome)
        || occurrence.verdict !== (occurrence.outcome === 'failed' ? 'failed' : 'inconclusive')
        || canonicalJson(occurrence.clauseIds) !== canonicalJson(declaration.clauseIds)) {
      fail(`exact JUnit occurrence '${key}' does not bind its declaration`);
    }
  }
  for (const declaration of declarations.values()) {
    if (!occurrenceLogicalIds.has(declaration.logicalTestId)) {
      fail(`JUnit declaration '${declaration.logicalTestId}' has no exact report occurrence`);
    }
    const expectedClauses = new Set(declaration.clauseIds);
    const proposedClauses = new Set([...proposals.values()]
      .filter((proposal) => proposal.logicalTestId === declaration.logicalTestId)
      .map((proposal) => proposal.clauseId));
    if (canonicalJson([...expectedClauses].sort()) !== canonicalJson([...proposedClauses].sort())) {
      fail(`JUnit declaration '${declaration.logicalTestId}' has an incomplete proposal set`);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    rawOccurrences: (observation.occurrences ?? []).map(rawOccurrenceProjection)
  };
}
