/**
 * JUnit 5 test declarations from the packaged JDK parser's records [E2G-015].
 *
 * Pure: the JDK compiler tree API (run by wel-junit5.mjs, never compiling or loading Candidate
 * classes) reports every test-like method with its exact source range, class path, kind, @Disabled
 * state and statically known invocation count, plus the class's lifecycle methods. This module
 * turns those records into declarations: the criterion tags in the comments directly above each
 * method, the identity (`package.Outer$Nested#method` plus its signature), the revision of the whole
 * method and a support digest over the lifecycle methods that run around it. Lifecycle hooks are
 * allowed; a change to one is a change to the tests they wrap. Anything the parser cannot pin down
 * stays a gap of the declaration it affects.
 */
import { createHash } from 'node:crypto';

import { acceptanceTagLines, acceptanceTagsAboveLine } from './tags.mjs';

export const JUNIT_DECLARATION_SCHEMA = 'junit5-method-v2';
const KINDS = new Set(['test', 'parameterized', 'repeated', 'factory', 'template']);
const PROBLEM_MESSAGES = Object.freeze({
  CONFLICTING_TEST_ANNOTATIONS: 'the method carries more than one test or lifecycle annotation',
  ABSTRACT_TEST: 'the test method has no body',
  NOT_A_RUNNABLE_TEST: 'JUnit Jupiter does not run static or private test methods',
  SOURCE_RANGE_UNAVAILABLE: 'the parser could not locate the method in the source'
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function gap(code, message) {
  return { code, message };
}

function lineOf(text, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) if (text[index] === '\n') line += 1;
  return line;
}

/** The report class name of a declaration: `package.Outer$Nested`. */
export function junitReportClassName(declaration) {
  return `${declaration.packageName}.${declaration.classPath.join('$')}`;
}

/**
 * Normalize the parser's records for the captured sources. `sources` are `{ path, text }`; records
 * are the parser's NDJSON objects. Malformed records are file gaps, never declarations.
 */
export function junitDeclarationsFromParser({ sources, records }) {
  const byPath = new Map(sources.map((source) => [source.path, source.text]));
  const fileGaps = new Map();
  const addFileGap = (sourcePath, code, message) => {
    const list = fileGaps.get(sourcePath) ?? [];
    if (!list.some((entry) => entry.code === code)) list.push(gap(code, message));
    fileGaps.set(sourcePath, list);
  };
  const lifecycles = [];
  const raw = [];
  for (const record of records) {
    if (record.kind === 'gap') { addFileGap(record.path, record.code, `the parser reported ${record.code}`); continue; }
    const text = byPath.get(record.path);
    const validRange = Number.isSafeInteger(record.start) && Number.isSafeInteger(record.end)
      && record.start >= 0 && record.end > record.start && text != null && record.end <= text.length;
    if (record.kind === 'lifecycle') {
      if (validRange && Array.isArray(record.classPath)) lifecycles.push(record);
      else if (text != null) addFileGap(record.path, 'JUNIT_SOURCE_PARSER_MALFORMED', 'the parser returned a malformed lifecycle record');
      continue;
    }
    if (record.kind !== 'declaration' || !validRange || !KINDS.has(record.testKind) || !Array.isArray(record.classPath)
        || !record.classPath.length || typeof record.methodName !== 'string' || typeof record.packageName !== 'string') {
      if (record.path && text != null) addFileGap(record.path, 'JUNIT_SOURCE_PARSER_MALFORMED', 'the parser returned a malformed declaration record');
      continue;
    }
    raw.push(record);
  }
  const declarations = [];
  for (const record of raw) {
    const text = byPath.get(record.path);
    if (fileGaps.get(record.path)?.length) continue;
    const lines = text.split(/\r?\n/u);
    const line = lineOf(text, record.start);
    const tags = acceptanceTagsAboveLine(lines, line - 1);
    const identity = {
      schema: JUNIT_DECLARATION_SCHEMA, sourcePath: record.path, packageName: record.packageName,
      classPath: record.classPath, methodName: record.methodName, signature: record.signature ?? null
    };
    // Lifecycle methods of the declaring class and every enclosing class run around the test.
    const support = lifecycles
      .filter((entry) => entry.path === record.path && entry.classPath.length <= record.classPath.length
        && entry.classPath.every((name, index) => record.classPath[index] === name))
      .sort((left, right) => left.start - right.start);
    const gaps = (record.problems ?? []).map((code) => gap(code, PROBLEM_MESSAGES[code] ?? code));
    if (record.nestedRunnable === false) {
      gaps.push(gap('NESTED_CLASS_NOT_RUN', 'the test is in a nested class that is not a JUnit @Nested inner class, so Jupiter does not run it with its outer class'));
    }
    let parameters = null;
    if (['parameterized', 'repeated'].includes(record.testKind)) {
      const count = Number.isSafeInteger(record.staticCount) && record.staticCount >= 0 ? record.staticCount : null;
      parameters = { kind: count == null ? 'dynamic' : 'static', count };
      if (count == null) gaps.push(gap('DYNAMIC_PARAMETER_SET', 'the invocations come from a method, enum, file or provider, so the expected instances are unknown'));
      else if (count === 0) gaps.push(gap('EMPTY_PARAMETER_SET', 'the parameter source is empty'));
    }
    if (['factory', 'template'].includes(record.testKind)) {
      parameters = { kind: 'dynamic', count: null };
      gaps.push(gap('DYNAMIC_TEST_FACTORY', 'a test factory or template creates its tests at run time'));
    }
    declarations.push({
      ...identity,
      logicalTestId: `sha256:${sha256(canonical(identity))}`,
      className: `${record.packageName}.${record.classPath.join('$')}`,
      testKind: record.testKind,
      line,
      tagLine: tags.firstCommentLine == null ? null : tags.firstCommentLine + 1,
      span: { start: record.start, end: record.end },
      declarationSha256: `sha256:${sha256(Buffer.from(text.slice(record.start, record.end), 'utf8'))}`,
      supportSha256: support.length
        ? `sha256:${sha256(Buffer.from(support.map((entry) => text.slice(entry.start, entry.end)).join('\n\u0000\n'), 'utf8'))}`
        : null,
      skipped: record.disabled === true,
      focused: false,
      parameters,
      clauseIds: tags.clauseIds,
      gaps
    });
  }
  // Overloaded methods share a report identity, so every overload is ambiguous.
  const byReportIdentity = new Map();
  for (const declaration of declarations) {
    const key = `${declaration.className}#${declaration.methodName}`;
    byReportIdentity.set(key, [...(byReportIdentity.get(key) ?? []), declaration]);
  }
  for (const group of byReportIdentity.values()) {
    if (group.length < 2) continue;
    for (const declaration of group) declaration.gaps.push(gap('DUPLICATE_DECLARATION', `${group.length} test methods share the name ${declaration.methodName} in ${declaration.className}`));
  }
  const unattachedTags = [];
  for (const source of sources) {
    const gaps = fileGaps.get(source.path) ?? [];
    const attachedLines = new Set();
    for (const declaration of declarations.filter((entry) => entry.sourcePath === source.path && entry.tagLine != null)) {
      for (let tagLine = declaration.tagLine; tagLine < declaration.line; tagLine += 1) attachedLines.add(tagLine);
    }
    for (const tag of acceptanceTagLines(source.text)) {
      if (attachedLines.has(tag.line)) continue;
      const existing = unattachedTags.find((entry) => entry.sourcePath === source.path && entry.line === tag.line);
      if (existing) { existing.clauseIds.push(tag.clauseId); continue; }
      unattachedTags.push({
        sourcePath: source.path, line: tag.line, clauseIds: [tag.clauseId],
        code: gaps[0]?.code ?? 'AC_TAG_NOT_ATTACHED',
        message: gaps[0] ? `the file cannot be read as data: ${gaps[0].message}` : 'the tag is not directly above a JUnit test method'
      });
    }
  }
  return {
    schema: JUNIT_DECLARATION_SCHEMA,
    declarations: declarations.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.span.start - right.span.start),
    unattachedTags,
    fileGaps: Object.fromEntries([...fileGaps.entries()].sort(([left], [right]) => left.localeCompare(right)))
  };
}
