/**
 * WEL's observe-only Jest/Vitest static identity adapter.
 *
 * The reviewed v1 subset is deliberately small: a repository-tracked JavaScript/TypeScript test
 * file, one or more top-level `// @sflow-ac:<WORK-ID>:AC-NNN` lines, followed immediately by a
 * top-level `test("literal", () => {` or `it("literal", () => {` declaration. Dynamic titles,
 * suites, modifiers, parameterization, retries, templates, block comments, and focused execution
 * remain inexact. No candidate source is loaded or executed by this adapter.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertCredentialFreeRemote, remoteFingerprint } from './git-remote-diagnostics.mjs';
import { recordSha256 } from './records.mjs';
import { posix, run, secureRepositoryPath } from './util.mjs';

const PROFILES = Object.freeze({
  'jest-static-v1': 'jest-json',
  'vitest-static-v1': 'vitest-json'
});
const QUALIFIED_CLAUSE = /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/;
const SOURCE_FILE = /(?:^|\/)(?:__tests__\/[^/]+|[^/]+\.(?:test|spec))\.(?:[cm]?[jt]sx?)$/i;
const CLAUSE_LINE = /^\/\/\s*@sflow-ac:([A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3})\s*$/;
const DECLARATION_LINE = /^(?:test|it)\(\s*("(?:[^"\\]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*")\s*,\s*(?:async\s+)?\(\s*\)\s*=>\s*\{/;
const MAX_SOURCES = 256;
const MAX_SOURCE_BYTES = 1024 * 1024;
const UNSUPPORTED_COMMAND = new Set([
  '-t', '--testnamepattern', '--runtestsbypath', '--findrelatedtests', '--changed',
  '--changedsince', '--onlychanged', '--retry', '--retries', '--shard'
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function prefixed(value) {
  return `sha256:${sha256(value)}`;
}

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

function sourceLineContexts(source) {
  const contexts = [];
  let state = 'code';
  let escaped = false;
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  let lastSignificant = null;
  let line = 0;
  contexts.push({ state, braces, parentheses, brackets, lastSignificant });
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (character === '\n') {
        state = 'code';
        line += 1;
        contexts[line] = { state, braces, parentheses, brackets, lastSignificant };
      }
      continue;
    }
    if (state === 'single' || state === 'double') {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if ((state === 'single' && character === "'")
          || (state === 'double' && character === '"')) state = 'code';
      else if (character === '\n') return { contexts, unsupported: true };
      continue;
    }
    if (character === '/' && next === '/') { state = 'line-comment'; index += 1; continue; }
    if (character === '/' && next === '*') return { contexts, unsupported: true };
    if (character === '`') return { contexts, unsupported: true };
    if (character === "'") { state = 'single'; continue; }
    if (character === '"') { state = 'double'; continue; }
    if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    if (braces < 0 || parentheses < 0 || brackets < 0) return { contexts, unsupported: true };
    if (!/\s/u.test(character)) lastSignificant = character;
    if (character === '\n') {
      line += 1;
      contexts[line] = { state, braces, parentheses, brackets, lastSignificant };
    }
  }
  return {
    contexts,
    unsupported: !['code', 'line-comment'].includes(state)
      || braces !== 0 || parentheses !== 0 || brackets !== 0
  };
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

function declarationCatalog(sources, framework) {
  const declarations = [];
  const gaps = new Set();
  for (const captured of sources) {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(captured.bytes); }
    catch { gaps.add('JAVASCRIPT_SOURCE_NOT_UTF8'); continue; }
    // The v1 grammar is line-oriented. Refuse multiline lexical forms that can make a line which
    // looks like code actually belong to a comment or template. This is intentionally conservative.
    const lexical = sourceLineContexts(source);
    if (lexical.unsupported || source.includes('*/') || /\\\r?\n/u.test(source)) {
      if (source.includes('@sflow-ac:')) gaps.add('UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE');
      continue;
    }
    const lines = source.split(/(?<=\n)/u);
    let offset = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      const line = raw.replace(/\r?\n$/u, '');
      const marker = line.match(CLAUSE_LINE);
      if (!marker) { offset += raw.length; continue; }
      const context = lexical.contexts[index];
      if (!context || context.state !== 'code' || context.braces !== 0
          || context.parentheses !== 0 || context.brackets !== 0
          || ![null, ';', '}'].includes(context.lastSignificant)) {
        gaps.add('UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE');
        offset += raw.length;
        continue;
      }
      const clauseIds = [];
      const startCharacter = offset;
      let cursor = index;
      let cursorOffset = offset;
      while (cursor < lines.length) {
        const candidate = lines[cursor].replace(/\r?\n$/u, '');
        const clause = candidate.match(CLAUSE_LINE);
        if (!clause) break;
        clauseIds.push(clause[1]);
        cursorOffset += lines[cursor].length;
        cursor += 1;
      }
      const declarationLine = (lines[cursor] ?? '').replace(/\r?\n$/u, '');
      const declaration = declarationLine.match(DECLARATION_LINE);
      if (!declaration || clauseIds.some((clause) => !QUALIFIED_CLAUSE.test(clause))) {
        gaps.add('UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE');
        offset += raw.length;
        continue;
      }
      let testName;
      try { testName = JSON.parse(declaration[1]); }
      catch { gaps.add('UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE'); offset += raw.length; continue; }
      if (typeof testName !== 'string' || !testName || Buffer.byteLength(testName) > 1024) {
        gaps.add('UNSUPPORTED_JAVASCRIPT_SOURCE_SHAPE');
        offset += raw.length;
        continue;
      }
      const endCharacter = cursorOffset + declaration[0].length;
      const identity = {
        identitySchema: 'javascript-static-test-v1', repositorySha256: null,
        sourcePath: captured.path, framework, testName
      };
      const declarationBytes = Buffer.from(source.slice(startCharacter, endCharacter), 'utf8');
      declarations.push({
        ...identity, logicalTestId: `sha256:${recordSha256(identity)}`,
        sourceDeclarationSha256: prefixed(declarationBytes),
        sourceRange: { startCharacter, endCharacter, bytes: declarationBytes.length },
        clauseIds: [...new Set(clauseIds)].sort()
      });
      for (let skipped = index; skipped < cursor; skipped += 1) offset += lines[skipped].length;
      index = cursor - 1;
    }
  }
  return { declarations, gaps: [...gaps].sort() };
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
    schemaVersion: 1, // schema-transient: embedded proposal in test-execution v3.
    kind: 'wel-witness-mapping-proposal', clauseId, witnessType: 'test',
    executionProfile: profile, logicalTestId: declaration.logicalTestId,
    sourcePath: declaration.sourcePath,
    sourceDeclarationSha256: declaration.sourceDeclarationSha256,
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
    id: 'sflow-javascript-static-parser', version: 1,
    manifestSha256: `sha256:${recordSha256({ id: 'sflow-javascript-static-parser', version: 1 })}`
  };
  const declarations = catalog.declarations.map((entry) => {
    const identity = {
      identitySchema: entry.identitySchema, repositorySha256: repositoryIdentity,
      sourcePath: entry.sourcePath, framework: entry.framework, testName: entry.testName
    };
    return { ...entry, ...identity, logicalTestId: `sha256:${recordSha256(identity)}` };
  });
  const reportByName = new Map();
  for (const occurrence of parsed.testcaseObservation.occurrences ?? []) {
    if ((occurrence.ancestorTitles ?? []).length || occurrence.fullName !== occurrence.name) continue;
    const entries = reportByName.get(occurrence.name) ?? [];
    entries.push(occurrence);
    reportByName.set(occurrence.name, entries);
  }
  const gaps = new Set();
  const proposals = [];
  const exactOccurrences = [];
  const declarationNames = new Set();
  for (const declaration of declarations) {
    if (declarationNames.has(declaration.testName)) {
      gaps.add('TEST_DECLARATION_COLLISION');
      continue;
    }
    declarationNames.add(declaration.testName);
    const matches = reportByName.get(declaration.testName) ?? [];
    if (matches.length !== 1 || matches[0].identityStatus !== 'observed-name-only') {
      gaps.add(matches.length > 1 ? 'REPORT_TEST_IDENTITY_AMBIGUOUS' : 'REPORT_SOURCE_DECLARATION_UNMATCHED');
      continue;
    }
    for (const clauseId of declaration.clauseIds) {
      proposals.push(exactProposal(declaration, clauseId, parser, profile));
    }
    exactOccurrences.push({
      ...matches[0], logicalTestId: declaration.logicalTestId,
      declarationSha256: declaration.sourceDeclarationSha256,
      sourcePath: declaration.sourcePath, clauseIds: declaration.clauseIds,
      exact: true, identityStatus: 'exact-static-identity',
      verdict: matches[0].outcome === 'failed' ? 'failed' : 'inconclusive'
    });
  }
  if (!declarations.length) gaps.add('TAGGED_TEST_DECLARATIONS_UNAVAILABLE');
  if (!proposals.length) gaps.add('WITNESS_MAPPING_PROPOSALS_UNAVAILABLE');
  if (new Set(proposals.map((entry) => entry.mappingSha256)).size !== proposals.length) {
    gaps.add('WITNESS_MAPPING_COLLISION');
  }
  const exact = gaps.size === 0 && exactOccurrences.length > 0;
  const catalogCore = {
    schemaVersion: 1, // schema-transient: embedded catalog in test-execution v3.
    kind: 'wel-javascript-static-catalog', parser, repositorySha256: repositoryIdentity,
    framework, sourceCount: sourceSet.sources.length, declarations
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

function rawOccurrenceProjection(occurrence) {
  if (occurrence.identityStatus !== 'exact-static-identity') return occurrence;
  const { sourcePath: _sourcePath, clauseIds: _clauseIds, ...raw } = occurrence;
  return {
    ...raw, verdict: 'inconclusive', logicalTestId: null, declarationSha256: null,
    exact: false, identityStatus: 'observed-name-only'
  };
}

export async function verifyJavascriptTestIdentityObservation(root, observation, {
  evidenceCommit = null
} = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (observation?.exact !== true || !Object.hasOwn(PROFILES, observation?.profile)
      || observation?.verdict !== 'inconclusive'
      || observation?.disposition !== 'unreviewed-witness-observed') {
    return { valid: false, errors: ['exact local JavaScript observation envelope is invalid'], rawOccurrences: [] };
  }
  const catalog = observation.catalog;
  if (!catalog || catalog.kind !== 'wel-javascript-static-catalog'
      || catalog.parser?.id !== 'sflow-javascript-static-parser'
      || !/^sha256:[a-f0-9]{64}$/.test(catalog.parser?.manifestSha256 ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(catalog.repositorySha256 ?? '')
      || catalog.framework !== (observation.profile.startsWith('jest-') ? 'jest' : 'vitest')) {
    return { valid: false, errors: ['exact local JavaScript catalog identity is invalid'], rawOccurrences: [] };
  }
  const { catalogSha256, ...catalogCore } = catalog;
  if (catalogSha256 !== `sha256:${recordSha256(catalogCore)}`) fail('JavaScript catalog digest is invalid');
  const declarations = new Map();
  for (const declaration of catalog.declarations ?? []) {
    const identity = {
      identitySchema: declaration.identitySchema, repositorySha256: declaration.repositorySha256,
      sourcePath: declaration.sourcePath, framework: declaration.framework, testName: declaration.testName
    };
    if (declaration.identitySchema !== 'javascript-static-test-v1'
        || declaration.repositorySha256 !== catalog.repositorySha256
        || declaration.framework !== catalog.framework
        || declaration.logicalTestId !== `sha256:${recordSha256(identity)}`
        || !Array.isArray(declaration.clauseIds)
        || declaration.clauseIds.some((clause) => !QUALIFIED_CLAUSE.test(clause))) {
      fail(`JavaScript declaration '${declaration.logicalTestId ?? 'unknown'}' has an invalid identity`);
      continue;
    }
    let sourceBytes;
    if (evidenceCommit) {
      const source = run('git', ['show', `${evidenceCommit}:${declaration.sourcePath}`], {
        cwd: root, allowFailure: true, encoding: 'buffer', maxBuffer: MAX_SOURCE_BYTES + 1
      });
      if (source.status !== 0) {
        fail(`JavaScript declaration source '${declaration.sourcePath}' is absent from the evidence commit`);
        continue;
      }
      sourceBytes = source.stdout;
    } else {
      try {
        const secured = await secureRepositoryPath(root, declaration.sourcePath, {
          label: 'WEL JavaScript replay source', mustExist: true, type: 'file'
        });
        sourceBytes = await readFile(secured.absolute);
      } catch {
        fail(`JavaScript declaration source '${declaration.sourcePath}' is unavailable`);
        continue;
      }
    }
    let sourceText;
    try { sourceText = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes); }
    catch { fail(`JavaScript declaration source '${declaration.sourcePath}' is not UTF-8`); continue; }
    const range = declaration.sourceRange;
    if (!Number.isSafeInteger(range?.startCharacter) || !Number.isSafeInteger(range?.endCharacter)
        || range.startCharacter < 0 || range.endCharacter <= range.startCharacter
        || range.endCharacter > sourceText.length) {
      fail(`JavaScript declaration '${declaration.logicalTestId}' has an invalid source range`);
      continue;
    }
    const bytes = Buffer.from(sourceText.slice(range.startCharacter, range.endCharacter), 'utf8');
    if (bytes.length !== range.bytes || prefixed(bytes) !== declaration.sourceDeclarationSha256) {
      fail(`JavaScript declaration '${declaration.logicalTestId}' bytes changed`);
    }
    if (declarations.has(declaration.logicalTestId)) fail('JavaScript catalog repeats a logical identity');
    declarations.set(declaration.logicalTestId, declaration);
  }
  const proposals = new Map();
  for (const proposal of observation.mappingProposals ?? []) {
    const { mappingSha256, reviewStatus, ...core } = proposal;
    const declaration = declarations.get(proposal.logicalTestId);
    if (reviewStatus !== 'unreviewed' || mappingSha256 !== `sha256:${recordSha256(core)}`
        || core.schemaVersion !== 1 || core.kind !== 'wel-witness-mapping-proposal' // schema-transient: embedded proposal in test-execution v3.
        || core.witnessType !== 'test' || !QUALIFIED_CLAUSE.test(core.clauseId ?? '')
        || proposal.executionProfile !== observation.profile
        || !declaration || proposal.sourcePath !== declaration.sourcePath
        || proposal.sourceDeclarationSha256 !== declaration.sourceDeclarationSha256
        || proposal.parserManifestSha256 !== catalog.parser.manifestSha256
        || !declaration.clauseIds.includes(proposal.clauseId)) {
      fail(`JavaScript witness proposal '${mappingSha256 ?? 'unknown'}' is invalid`);
      continue;
    }
    if (proposals.has(mappingSha256)) fail('JavaScript observation repeats a mapping proposal');
    proposals.set(mappingSha256, proposal);
  }
  if (!declarations.size || !proposals.size) fail('exact JavaScript observation has no declaration or mapping proposal');
  const seenLogical = new Set();
  const reportIdentities = new Set();
  for (const occurrence of observation.occurrences ?? []) {
    const reportIdentity = JSON.stringify([
      occurrence.fullName, occurrence.name, occurrence.ancestorTitles, occurrence.framework
    ]);
    if (reportIdentities.has(reportIdentity)) fail('JavaScript observation repeats a report identity');
    reportIdentities.add(reportIdentity);
    if (!['passed', 'failed', 'skipped'].includes(occurrence.outcome)
        || occurrence.framework !== catalog.framework
        || occurrence.fullName == null || !Array.isArray(occurrence.ancestorTitles)) {
      fail(`JavaScript occurrence '${occurrence.name ?? 'unknown'}' is malformed`);
      continue;
    }
    if (occurrence.identityStatus !== 'exact-static-identity') {
      if (occurrence.exact !== false || occurrence.verdict !== 'inconclusive'
          || occurrence.logicalTestId != null || occurrence.declarationSha256 != null) {
        fail(`JavaScript occurrence '${occurrence.name ?? 'unknown'}' overstates an inexact identity`);
      }
      continue;
    }
    const declaration = declarations.get(occurrence.logicalTestId);
    if (!declaration || occurrence.name !== declaration.testName
        || occurrence.fullName !== declaration.testName || occurrence.ancestorTitles.length !== 0
        || occurrence.declarationSha256 !== declaration.sourceDeclarationSha256
        || occurrence.sourcePath !== declaration.sourcePath
        || occurrence.exact !== true
        || seenLogical.has(occurrence.logicalTestId)) {
      fail(`exact JavaScript occurrence '${occurrence.name ?? 'unknown'}' does not bind its declaration`);
      continue;
    }
    seenLogical.add(occurrence.logicalTestId);
  }
  for (const declaration of declarations.values()) {
    if (!seenLogical.has(declaration.logicalTestId)) {
      fail(`JavaScript declaration '${declaration.logicalTestId}' has no exact report occurrence`);
    }
    for (const clauseId of declaration.clauseIds) {
      const found = [...proposals.values()].some((proposal) =>
        proposal.logicalTestId === declaration.logicalTestId && proposal.clauseId === clauseId);
      if (!found) fail(`JavaScript declaration '${declaration.logicalTestId}' has an incomplete proposal set`);
    }
  }
  return {
    valid: errors.length === 0, errors,
    rawOccurrences: (observation.occurrences ?? []).map(rawOccurrenceProjection)
  };
}

export function javascriptWelAdapterManifest(profile) {
  if (!Object.hasOwn(PROFILES, profile)) return null;
  return Object.freeze({
    id: profile, parser: 'sflow-javascript-static-parser', resultAdapter: PROFILES[profile],
    limits: { sources: MAX_SOURCES, sourceBytes: MAX_SOURCE_BYTES },
    manifestSha256: `sha256:${recordSha256({ id: profile, parser: 'sflow-javascript-static-parser', version: 1 })}`
  });
}

export function javascriptWelResultAdapter(profile) {
  return PROFILES[profile] ?? null;
}
