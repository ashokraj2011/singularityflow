/**
 * The JUnit 5 source reader and its observe-only WEL projection.
 *
 * Source is parsed in a separate JDK compiler process. Candidate classes are never compiled,
 * loaded, or executed here. `parseJunitTestSources` returns every test method's exact declaration
 * (src/verification/junit-declarations.mjs) with the `@ac` criterion tags in the comments above it;
 * the observe projection joins those declarations to Surefire occurrences without granting
 * approval or independent execution authority.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants, rmSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { recordSha256 } from './records.mjs';
import { assertCredentialFreeRemote, remoteFingerprint } from './git-remote-diagnostics.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { runQualityCommand } from './quality-command-runner.mjs';
import { posix, run, secureRepositoryPath } from './util.mjs';
import { junitDeclarationsFromParser } from './verification/junit-declarations.mjs';
import { joinDeclaration } from './verification/join.mjs';

const HELPER = path.join(PACKAGE_ROOT, 'src', 'wel', 'WelJunitCatalog.java');
const QUALIFIED_CLAUSE = /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/;
const PARSER_RECORD_KINDS = new Set(['gap', 'declaration', 'lifecycle']);
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
let compiledHelperPromise = null;
let compiledHelperDirectory = null;

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

function parserEnvironment() {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    JAVA_HOME: process.env.JAVA_HOME,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8'
  };
}

/**
 * Compile the verified packaged parser once per SFlow process, then reuse its private class files.
 *
 * Java's source-file launcher compiles the helper on every observation. A reviewed corpus invokes
 * the adapter repeatedly, so host load could make a later compile hit the parser deadline even
 * after earlier cases passed. The cache is process-private, created with mkdtemp, and removed at
 * exit; it never contains Candidate source and is not durable evidence. A toolchain without a
 * separately resolvable `javac` falls back to the existing source-file launch and therefore keeps
 * the previous behavior.
 */
async function compiledHelperLaunch() {
  compiledHelperPromise ??= (async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-helper-'));
    const compilation = await runQualityCommand('javac', [
      '-proc:none', '-encoding', 'UTF-8', '-d', directory, HELPER
    ], {
      cwd: directory,
      timeoutMs: PARSER_TIMEOUT_MS,
      captureBytes: MAX_OUTPUT_BYTES,
      killTree: true,
      env: parserEnvironment()
    });
    const classFile = path.join(directory, 'WelJunitCatalog.class');
    const classStat = await lstat(classFile).catch(() => null);
    const classBytes = compilation.status === 0 && !compilation.error && !compilation.signal
      && !compilation.timedOut && !compilation.stdoutTruncated && !compilation.stderrTruncated
      && classStat?.isFile() && classStat.size > 0 && classStat.size <= MAX_OUTPUT_BYTES
      ? await readFile(classFile).catch(() => null)
      : null;
    if (!classBytes?.length) {
      await rm(directory, { recursive: true, force: true });
      return null;
    }
    compiledHelperDirectory = directory;
    return Object.freeze({ command: 'java', args: ['-cp', directory, 'WelJunitCatalog'] });
  })();
  return await compiledHelperPromise;
}

process.once('exit', () => {
  if (compiledHelperDirectory) rmSync(compiledHelperDirectory, { recursive: true, force: true });
});

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

async function trackedJavaSources(root, moduleRoot, { signal = null } = {}) {
  if (signal?.aborted) return { paths: [], gap: 'JUNIT_SOURCE_PARSER_CANCELLED' };
  const listing = run('git', ['ls-files', '-z', '--', moduleRoot === '.' ? '.' : moduleRoot], {
    cwd: root, maxBuffer: 8 * 1024 * 1024
  }).stdout.split('\0').filter(Boolean).map(posix).filter((entry) => moduleTestSource(entry, moduleRoot));
  if (listing.length > MAX_SOURCES) return { paths: [], gap: 'TEST_SOURCE_LIMIT_EXCEEDED' };
  const sources = [];
  for (const relative of listing) {
    if (signal?.aborted) return { sources: [], gap: 'JUNIT_SOURCE_PARSER_CANCELLED' };
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
    if (!record || !PARSER_RECORD_KINDS.has(record.kind)) {
      throw new Error('parser emitted an unknown record');
    }
    records.push(record);
  }
  return records;
}

/** Run the packaged parser over captured sources. Returns its raw records, or a process gap. */
async function sourceDeclarations(root, sources, {
  signal = null,
  runParser = runQualityCommand
} = {}) {
  const helperBytes = await readFile(HELPER);
  const parser = {
    id: 'jdk-compiler-tree-api',
    version: 2,
    manifestSha256: prefixed(helperBytes)
  };
  const staging = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-parser-'));
  try {
    for (const source of sources) {
      const target = path.join(staging, source.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source.bytes, { flag: 'wx', mode: 0o600 });
    }
    const paths = sources.map((source) => source.path);
    const input = `${staging}\n${paths.join('\n')}${paths.length ? '\n' : ''}`;
    const compiled = runParser === runQualityCommand ? await compiledHelperLaunch() : null;
    const invocation = await runParser(compiled?.command ?? 'java', compiled?.args ?? [HELPER], {
      cwd: staging,
      input,
      timeoutMs: PARSER_TIMEOUT_MS,
      captureBytes: MAX_OUTPUT_BYTES,
      signal,
      killTree: true,
      env: parserEnvironment()
    });
    if (invocation.aborted) return { parser, records: [], gaps: ['JUNIT_SOURCE_PARSER_CANCELLED'] };
    if (invocation.stdoutTruncated || invocation.stderrTruncated) {
      return { parser, records: [], gaps: ['JUNIT_SOURCE_PARSER_OUTPUT_LIMIT'] };
    }
    if (invocation.error || invocation.status !== 0 || invocation.signal) {
      const reason = invocation.timedOut || invocation.error?.code === 'ETIMEDOUT' || invocation.signal
        ? 'JUNIT_SOURCE_PARSER_TIMEOUT' : 'JUNIT_SOURCE_PARSER_UNAVAILABLE';
      return { parser, records: [], gaps: [reason] };
    }
    try { return { parser, records: parseHelperOutput(invocation.stdout), gaps: [] }; }
    catch { return { parser, records: [], gaps: ['JUNIT_SOURCE_PARSER_MALFORMED'] }; }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Decode captured sources and normalize the parser's records into declarations. */
async function capturedDeclarations(root, sources, options) {
  const decoded = [];
  const undecodable = {};
  for (const source of sources) {
    try { decoded.push({ path: source.path, bytes: source.bytes, text: new TextDecoder('utf-8', { fatal: true }).decode(source.bytes) }); }
    catch { undecodable[source.path] = [{ code: 'JUNIT_SOURCE_NOT_UTF8', message: 'the file is not UTF-8' }]; }
  }
  const parsed = decoded.length ? await sourceDeclarations(root, decoded, options) : { parser: null, records: [], gaps: [] };
  if (parsed.gaps.length) {
    const fileGaps = Object.fromEntries(decoded.map((source) => [source.path, parsed.gaps.map((code) => ({ code, message: `the JDK parser reported ${code}` }))]));
    return { parser: parsed.parser, gaps: parsed.gaps, declarations: [], unattachedTags: [], fileGaps: { ...fileGaps, ...undecodable } };
  }
  const normalized = junitDeclarationsFromParser({ sources: decoded, records: parsed.records });
  return { parser: parsed.parser, gaps: [], ...normalized, fileGaps: { ...normalized.fileGaps, ...undecodable } };
}

/**
 * The exact JUnit declarations of explicit repository test files. Reads each file through a
 * no-follow descriptor, bounded like the module catalog, and never executes Candidate code.
 */
export async function parseJunitTestSources(root, relativePaths, { signal = null, runParser = runQualityCommand } = {}) {
  const sources = [];
  const fileGaps = {};
  for (const relative of relativePaths) {
    if (/[\\\u0000-\u001f\u007f]/u.test(relative)) { fileGaps[relative] = [{ code: 'SOURCE_PATH_INVALID', message: 'the path is not a plain repository path' }]; continue; }
    let handle;
    try {
      const secured = await secureRepositoryPath(root, relative, { label: 'JUnit test source', mustExist: true, type: 'file' });
      handle = await open(secured.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const before = await handle.stat();
      const link = await lstat(secured.absolute);
      if (!before.isFile() || link.isSymbolicLink() || before.size > MAX_SOURCE_BYTES) {
        fileGaps[relative] = [{ code: 'TEST_SOURCE_LIMIT_EXCEEDED', message: `the file is not a regular file of at most ${MAX_SOURCE_BYTES} bytes` }];
        continue;
      }
      sources.push({ path: relative, bytes: await handle.readFile() });
    } catch {
      fileGaps[relative] = [{ code: 'JUNIT_TEST_SOURCE_UNAVAILABLE', message: 'the file could not be read' }];
    } finally {
      await handle?.close();
    }
  }
  const parsed = await capturedDeclarations(root, sources, { signal, runParser });
  return { ...parsed, fileGaps: { ...parsed.fileGaps, ...fileGaps } };
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
    schemaVersion: 1, // schema-transient: embedded proposal in current test-execution v4 (introduced by v3).
    kind: 'wel-witness-mapping-proposal',
    clauseId,
    witnessType: 'test',
    executionProfile: 'junit5-surefire-v1',
    logicalTestId: declaration.logicalTestId,
    sourcePath: declaration.sourcePath,
    sourceDeclarationSha256: declaration.declarationSha256,
    parserManifestSha256: parser.manifestSha256
  };
  return { ...core, mappingSha256: `sha256:${recordSha256(core)}`, reviewStatus: 'unreviewed' };
}

function identityOf(declaration, repositoryIdentity) {
  return {
    schema: declaration.schema, repositorySha256: repositoryIdentity, sourcePath: declaration.sourcePath,
    packageName: declaration.packageName, classPath: declaration.classPath,
    methodName: declaration.methodName, signature: declaration.signature
  };
}

/**
 * Resolve exact static identities for the enrolled local-observe adapter.
 *
 * Any parser/toolchain/source ambiguity returns an inconclusive observation. It never throws a
 * lifecycle blocker merely because exact WEL evidence is unavailable.
 */
export async function observeJunit5SurefireIdentities(root, command, parsed, testcasePolicy, {
  signal = null,
  runParser = runQualityCommand
} = {}) {
  if (testcasePolicy?.mode !== 'observe' || testcasePolicy?.adapter !== 'junit5-surefire-v1'
      || parsed?.adapter !== 'junit-xml' || !parsed?.testcaseObservation) {
    return null;
  }
  if (signal?.aborted) return parserUnavailable('JUNIT_SOURCE_PARSER_CANCELLED');
  const commandScope = classifyJunit5SurefireCommandScope(command);
  if (commandScope.gaps.length) {
    return parserUnavailable(
      commandScope.gaps,
      'the JUnit exact-static pilot does not admit focused, retried, or non-Maven/Surefire executions'
    );
  }
  let sourceSet;
  try { sourceSet = await trackedJavaSources(root, command.workingDirectory, { signal }); }
  catch (error) { return parserUnavailable('JUNIT_SOURCE_CATALOG_UNAVAILABLE', error.message); }
  if (sourceSet.gap) return parserUnavailable(sourceSet.gap);
  if (!sourceSet.sources.length) return parserUnavailable('JUNIT_TEST_SOURCES_UNAVAILABLE');
  const catalog = await capturedDeclarations(root, sourceSet.sources, { signal, runParser });
  if (catalog.gaps.length) return parserUnavailable(catalog.gaps.sort()[0]);
  const fileGaps = Object.values(catalog.fileGaps).flat().map((entry) => entry.code).sort();
  if (fileGaps.length) return parserUnavailable(fileGaps[0] === 'JAVA_PARSER_DIAGNOSTIC' ? fileGaps[0] : 'UNSUPPORTED_JUNIT5_SOURCE_SHAPE');
  const repositoryIdentity = repositorySha256(root);
  if (!repositoryIdentity) return parserUnavailable('REPOSITORY_IDENTITY_UNAVAILABLE');
  const tagged = catalog.declarations.filter((declaration) => declaration.clauseIds.length);
  const declarations = tagged.map((declaration) => {
    const identity = identityOf(declaration, repositoryIdentity);
    return { ...declaration, repositorySha256: repositoryIdentity, logicalTestId: `sha256:${recordSha256(identity)}` };
  });
  const gaps = new Set();
  if (catalog.unattachedTags.length) gaps.add('UNSUPPORTED_JUNIT5_SOURCE_SHAPE');
  const proposals = [];
  const exactOccurrences = [];
  for (const declaration of declarations) {
    if (declaration.gaps.length) {
      gaps.add(declaration.gaps.some((entry) => entry.code === 'DUPLICATE_DECLARATION') ? 'TEST_DECLARATION_COLLISION' : 'UNSUPPORTED_JUNIT5_SOURCE_SHAPE');
      continue;
    }
    if (declaration.parameters) { gaps.add('UNSUPPORTED_JUNIT5_SOURCE_SHAPE'); continue; }
    const joined = joinDeclaration(declaration, parsed.testcaseObservation.occurrences ?? [], { language: 'java', runner: 'surefire' });
    if (!['passed', 'failed', 'unverified-skipped', 'flaky'].includes(joined.outcome)) {
      gaps.add(joined.outcome === 'ambiguous' ? 'REPORT_TEST_IDENTITY_AMBIGUOUS' : 'REPORT_SOURCE_DECLARATION_UNMATCHED');
      continue;
    }
    const occurrence = (parsed.testcaseObservation.occurrences ?? []).find((entry) =>
      entry.className === declaration.className && [declaration.methodName, `${declaration.methodName}()`].includes(entry.name));
    for (const clauseId of declaration.clauseIds) proposals.push(exactProposal(declaration, clauseId, catalog.parser));
    exactOccurrences.push({
      ...occurrence,
      logicalTestId: declaration.logicalTestId,
      declarationSha256: declaration.declarationSha256,
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
    schemaVersion: 1, // schema-transient: embedded catalog in current test-execution v4 (introduced by v3).
    kind: 'wel-junit5-static-catalog',
    parser: catalog.parser,
    repositorySha256: repositoryIdentity,
    sourceCount: sourceSet.sources.length,
    declarations: declarations.map((declaration) => ({
      schema: declaration.schema, repositorySha256: repositoryIdentity, sourcePath: declaration.sourcePath,
      packageName: declaration.packageName, classPath: declaration.classPath, methodName: declaration.methodName,
      signature: declaration.signature, logicalTestId: declaration.logicalTestId,
      declarationSha256: declaration.declarationSha256, supportSha256: declaration.supportSha256,
      span: declaration.span, clauseIds: declaration.clauseIds
    }))
  };
  return Object.freeze({
    status: 'observed',
    exact,
    catalog: { ...catalogCore, catalogSha256: `sha256:${recordSha256(catalogCore)}` },
    mappingProposals: exact ? proposals.sort((left, right) => left.mappingSha256.localeCompare(right.mappingSha256)) : [],
    occurrences: exact ? exactOccurrences : [],
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
