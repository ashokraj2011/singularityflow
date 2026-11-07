/** Pure artifact text, structure and authored-content rules. No file, hash or provider access. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { qualifiedClauseMatches } from '../foundation/traceability-ids.mjs';
import { nextPhaseGeneration } from './phase-policy.mjs';

export const MANAGED_INPUTS = /<!-- singularity-flow:inputs:start -->[\s\S]*?<!-- singularity-flow:inputs:end -->/g;
export const MANAGED_METADATA = /^<!-- singularity-flow:(?:initiative-)?metadata\r?\n[\s\S]*?\r?\n-->\s*/;
export const MANAGED_METADATA_MARKER = /<!-- singularity-flow:(?:initiative-)?metadata/u;

export function maskBlock(block) {
  return '\n'.repeat((block.match(/\n/g) ?? []).length);
}

export function authoredArtifactText(text, { preserveLines = false } = {}) {
  const source = String(text ?? '');
  const withoutMetadata = source.replace(MANAGED_METADATA, (block) => preserveLines ? maskBlock(block) : '');
  return withoutMetadata.replace(MANAGED_INPUTS, (block) => preserveLines ? maskBlock(block) : '');
}

export function artifactTextCheckoutMatches(published, current) {
  if (published === current) return true;
  const lf = published.replaceAll('\r\n', '\n');
  if (lf.includes('\r')) return false;
  const crlf = lf.replaceAll('\n', '\r\n');
  return (published === lf || published === crlf) && (current === lf || current === crlf);
}

export function inspectManagedArtifactMetadata(text) {
  const source = String(text ?? '');
  const leading = source.match(MANAGED_METADATA)?.[0] ?? null;
  const authoredRegion = (leading == null ? source : source.slice(leading.length))
    // Keep offsets stable so the reported line still refers to the original artifact.
    .replace(MANAGED_INPUTS, (block) => block.replace(/[^\n]/gu, ' '));
  const markerIndex = authoredRegion.search(MANAGED_METADATA_MARKER);
  if (leading != null && markerIndex < 0) {
    return Object.freeze({ status: 'valid', line: null, leading });
  }
  if (leading == null && markerIndex < 0) {
    return Object.freeze({ status: 'missing', line: 1, leading: null });
  }
  const absoluteIndex = leading == null
    ? markerIndex
    : leading.length + markerIndex;
  return Object.freeze({
    status: leading == null && absoluteIndex === 0 ? 'malformed' : 'duplicate-or-misplaced',
    line: lineAt(source, Math.max(0, absoluteIndex)),
    leading
  });
}

export function authoredArtifactFingerprintText(text) {
  return authoredArtifactText(text)
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function utf8Bytes(value) {
  let count=0;
  for(const character of value) {
    const code=character.codePointAt(0);
    count+=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;
  }
  return count;
}

/**
 * Parse the small, security-relevant Markdown structure used by governed artifacts.
 *
 * This is deliberately not a renderer. It provides one line/offset-preserving view for lifecycle
 * validation and deterministic projections so those surfaces cannot disagree about HTML comments,
 * fenced code, or headings. HTML comments are masked with spaces while newlines and every source
 * offset remain stable. Comment-looking text inside fenced or inline code remains visible text.
 */

export function normalizeMarkdownHeading(value) {
  return String(value ?? '')
    .replace(/\s*\{#[^}]+\}\s*$/u, '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US');
}

function sourceLines(source) {
  const lines = [];
  let offset = 0;
  let line = 1;
  while (offset < source.length) {
    let end = offset;
    while (end < source.length && source[end] !== '\n' && source[end] !== '\r') end += 1;
    let breakEnd = end;
    if (source[breakEnd] === '\r') breakEnd += 1;
    if (source[breakEnd] === '\n') breakEnd += 1;
    lines.push({ line, start: offset, end, breakEnd, text: source.slice(offset, end) });
    offset = breakEnd;
    line += 1;
  }
  if (source.length === 0 || /(?:\r\n|\r|\n)$/u.test(source)) {
    lines.push({ line, start: offset, end: offset, breakEnd: offset, text: '' });
  }
  return lines;
}

function fenceMarker(line) {
  const match = String(line).match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
  return match ? { character: match[1][0], length: match[1].length, rest: match[2] } : null;
}

function closesFence(line, fence) {
  const marker = fenceMarker(line);
  return Boolean(marker
    && marker.character === fence.character
    && marker.length >= fence.length
    && /^[ \t]*$/u.test(marker.rest));
}

function matchingBacktickRun(line, start, length) {
  let index = start;
  while (index < line.length) {
    if (line[index] !== '`') {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < line.length && line[end] === '`') end += 1;
    if (end - index === length) return index;
    index = end;
  }
  return -1;
}

function maskRange(characters, source, start, end) {
  for (let index = start; index < end; index += 1) {
    if (source[index] !== '\r' && source[index] !== '\n') characters[index] = ' ';
  }
}

/**
 * Return a shared structural projection of Markdown without executing or interpreting it.
 *
 * @returns {{source:string, visibleText:string, headings:ReadonlyArray<object>,
 *   comments:ReadonlyArray<object>, unclosedComments:ReadonlyArray<object>}}
 */
export function parseMarkdownStructure(value) {
  const source = String(value ?? '');
  const visible = source.split('');
  const lines = sourceLines(source);
  const comments = [];
  let comment = null;
  let fence = null;

  for (const record of lines) {
    const line = record.text;
    if (!comment && fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (!comment) {
      const openingFence = fenceMarker(line);
      if (openingFence) {
        fence = { character: openingFence.character, length: openingFence.length };
        continue;
      }
    }

    let index = 0;
    while (index < line.length) {
      if (comment) {
        const close = line.indexOf('-->', index);
        if (close < 0) {
          maskRange(visible, source, record.start + index, record.end);
          index = line.length;
          continue;
        }
        maskRange(visible, source, record.start + index, record.start + close + 3);
        comments.push(Object.freeze({
          start: comment.start,
          end: record.start + close + 3,
          line: comment.line,
          closed: true
        }));
        comment = null;
        index = close + 3;
        continue;
      }

      if (line[index] === '`') {
        let runEnd = index + 1;
        while (runEnd < line.length && line[runEnd] === '`') runEnd += 1;
        const close = matchingBacktickRun(line, runEnd, runEnd - index);
        index = close < 0 ? runEnd : close + (runEnd - index);
        continue;
      }

      if (line.startsWith('<!--', index)) {
        comment = { start: record.start + index, line: record.line };
        const close = line.indexOf('-->', index + 4);
        if (close < 0) {
          maskRange(visible, source, record.start + index, record.end);
          index = line.length;
          continue;
        }
        maskRange(visible, source, record.start + index, record.start + close + 3);
        comments.push(Object.freeze({
          start: comment.start,
          end: record.start + close + 3,
          line: comment.line,
          closed: true
        }));
        comment = null;
        index = close + 3;
        continue;
      }
      index += 1;
    }
  }

  if (comment) comments.push(Object.freeze({
    start: comment.start,
    end: source.length,
    line: comment.line,
    closed: false
  }));

  const visibleText = visible.join('');
  const headings = [];
  fence = null;
  for (const record of sourceLines(visibleText)) {
    if (fence) {
      if (closesFence(record.text, fence)) fence = null;
      continue;
    }
    const openingFence = fenceMarker(record.text);
    if (openingFence) {
      fence = { character: openingFence.character, length: openingFence.length };
      continue;
    }
    const match = record.text.match(/^( {0,3})(#{1,6})[ \t]+(.+?)\s*#*\s*$/u);
    if (!match) continue;
    const title = match[3].trim();
    headings.push({
      level: match[2].length,
      title,
      normalized: normalizeMarkdownHeading(title),
      line: record.line,
      index: record.start + match[1].length,
      contentStart: record.end
    });
  }
  const boundedHeadings = headings.map((heading, index) => Object.freeze({
    ...heading,
    end: headings.slice(index + 1)
      .find((candidate) => candidate.level <= heading.level)?.index ?? source.length
  }));
  const frozenComments = Object.freeze(comments);
  return Object.freeze({
    source,
    visibleText,
    headings: Object.freeze(boundedHeadings),
    comments: frozenComments,
    unclosedComments: Object.freeze(frozenComments.filter((entry) => !entry.closed))
  });
}

// "todo" is also an ordinary word (a to-do list Story could never publish), so TODO counts only in
// capitals; tbd, tbc and fixme stay case-free (2026-10-29).
const PLACEHOLDER = /\b(?:TBD|FIXME|TBC)\b|\{\{[^}]+\}\}|\[\s*(?:describe|add|insert|provide|record)[^\]]*\]/gi;
const UPPERCASE_TODO = /\bTODO\b/g;
// These words are useful in ordinary prose when lower-cased. Treat only the conventional uppercase
// authoring markers as unfinished work so a sentence such as "no placeholder remains" is not itself
// rejected by the placeholder guard.
const EXPLICIT_UPPERCASE_PLACEHOLDER = /\b(?:XXX|PLACEHOLDER)\b/g;
const SINGLE_WORD_ANGLE_PLACEHOLDERS = new Set([
  'benefit', 'capability', 'decision', 'module', 'owner', 'path', 'requirement', 'role'
]);

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function normalizedHeading(line) {
  return String(line ?? '').trim()
    .replace(/[\u2010-\u2015-]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US');
}

function dedentMarkdown(text) {
  const lines = String(text).replaceAll('\r\n', '\n').split('\n');
  const indents = lines.filter((line) => line.trim()).map((line) => /^ */u.exec(line)?.[0].length ?? 0);
  const indent = indents.length ? Math.min(...indents) : 0;
  return indent > 0 ? lines.map((line) => line.slice(Math.min(indent, line.length))).join('\n') : lines.join('\n');
}

/**
 * Repair only the bounded corruption produced when an editor starts authoring inside the managed
 * JSON prefix and a later prepare prepends a fresh canonical envelope.
 *
 * The candidate must begin where author-owned content normally begins, share a substantial exact
 * prefix with the canonical envelope, and resume at the same first Markdown heading as the Git
 * baseline. Anything less certain remains a refusal; this helper never guesses where prose starts.
 */
export function repairPreparedArtifactMetadata(text, { canonicalMetadata, baselineText = null } = {}) {
  const source = String(text ?? '');
  const canonical = String(canonicalMetadata ?? '').trimEnd();
  const placement = inspectManagedArtifactMetadata(source);
  if (placement.status === 'valid') return Object.freeze({ status: 'unchanged', text: source });
  if (placement.status === 'missing') {
    return Object.freeze({ status: 'inserted', text: `${canonical}\n\n${source}` });
  }

  const initial = source.match(MANAGED_METADATA)?.[0] ?? '';
  const authoredRegion = source.slice(initial.length);
  const candidate = authoredRegion.trimStart();
  if (candidate.search(MANAGED_METADATA_MARKER) !== 0) return null;

  const candidateLines = candidate.replaceAll('\r\n', '\n').split('\n');
  const canonicalLines = canonical.replaceAll('\r\n', '\n').split('\n');
  let shared = 0;
  while (shared < candidateLines.length && shared < canonicalLines.length
      && candidateLines[shared] === canonicalLines[shared]) shared += 1;
  if (shared < 4) return null;

  const recoveredBody = dedentMarkdown(candidateLines.slice(shared).join('\n')).trimStart();
  const recoveredHeading = recoveredBody.split('\n').find((line) => /^#{1,6}\s+\S/u.test(line.trim())) ?? '';
  const baselineBody = baselineText == null ? '' : authoredArtifactText(baselineText).trimStart();
  const baselineHeading = baselineBody.split(/\r?\n/u)
    .find((line) => /^#{1,6}\s+\S/u.test(line.trim())) ?? '';
  if (!recoveredHeading
      || (!baselineHeading && !initial)
      || (baselineHeading && normalizedHeading(recoveredHeading) !== normalizedHeading(baselineHeading))) return null;

  return Object.freeze({
    status: initial ? 'removed-duplicate-truncated-envelope' : 'replaced-truncated-envelope',
    text: `${canonical}\n\n${recoveredBody}`
  });
}

/** Human/model-facing rendering of the same authored-content boundary the kernel enforces. */
function anglePlaceholderFindings(text) {
  const findings = [];
  for (const candidate of text.matchAll(/<([^<>\r\n]+)>/g)) {
    const body = candidate[1].trim();
    if (!body || /^(?:https?:|mailto:|\/|!|\?)/i.test(body) || body.includes('=')) continue;
    // Uppercase command metavariables are executable documentation, not unfinished prose. They
    // intentionally occur in phase artifacts such as `--url <AUTHORIZED-URL>` and `<DIRECTORY>`.
    if (/^[A-Z][A-Z0-9 _-]+$/.test(body)) continue;
    const singleWord = body.toLocaleLowerCase('en-US');
    const placeholder = /\s/.test(body)
      || /(?:…|\.\.\.)/.test(body)
      || SINGLE_WORD_ANGLE_PLACEHOLDERS.has(singleWord);
    if (placeholder) findings.push({ value: candidate[0], index: candidate.index });
  }
  return findings;
}

/**
 * Locate every unfinished marker in the current producer's authored bytes.
 *
 * Managed approved inputs and kernel metadata preserve their line count but cannot make the
 * consumer fail publication: those bytes were governed by their producer and are evidence here.
 */
export function artifactPlaceholderFindings(text, { structure = null } = {}) {
  const authored = authoredArtifactText(text, { preserveLines: true });
  const visible = (structure ?? parseMarkdownStructure(authored)).visibleText;
  // Clause namespaces are user-chosen: ADD-FACTORIAL and even TODO are legal. Mask only
  // complete, valid identities (bracketed, inline code, or prose), not their surrounding
  // instructions or unfinished markers.
  // Keep offsets/newlines intact so every remaining finding still points at the source line.
  let placeholderText = visible;
  for (const match of qualifiedClauseMatches(visible)) {
    const bracketed = visible[match.index - 1] === '[' && visible[match.index + match[0].length] === ']';
    const start = match.index - (bracketed ? 1 : 0);
    const length = match[0].length + (bracketed ? 2 : 0);
    placeholderText = placeholderText.slice(0, start) + ' '.repeat(length)
      + placeholderText.slice(start + length);
  }
  const regular = [...placeholderText.matchAll(PLACEHOLDER), ...placeholderText.matchAll(UPPERCASE_TODO)].map((match) => ({
    value: visible.slice(match.index, match.index + match[0].length), index: match.index
  }));
  const explicitUppercase = [...placeholderText.matchAll(EXPLICIT_UPPERCASE_PLACEHOLDER)]
    .map((match) => ({ value: match[0], index: match.index }))
    .filter((finding) => !regular.some((candidate) => finding.index >= candidate.index
      && finding.index + finding.value.length <= candidate.index + candidate.value.length));
  const seen = new Set();
  return [...regular, ...explicitUppercase, ...anglePlaceholderFindings(visible)]
    .sort((left, right) => left.index - right.index)
    .filter((finding) => {
      const key = `${finding.index}:${finding.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((finding) => ({ value: finding.value, line: lineAt(visible, finding.index) }));
}

function requiredHeadingFindings(structure, required, pathName) {
  if (!required?.length) return [];
  const { headings, visibleText } = structure;
  const findings = [];
  for (const requested of required) {
    const normalized = normalizeMarkdownHeading(requested);
    const index = headings.findIndex((heading) => heading.normalized === normalized);
    if (index < 0) {
      // A numbered, bold or colon-ended heading, or a bold line, reads as missing: name it.
      const loose = (text) => normalizeMarkdownHeading(String(text).replace(/^[\s#]*/u, '').replace(/^\d+(?:\.\d+)*[.)]?\s+/u, '')
        .replace(/[*_`]+/gu, '').replace(/[:.]\s*$/u, ''));
      const lines = visibleText.split('\n');
      const near = headings.find((heading) => loose(heading.title) === normalized)
        ?? (() => { const at = lines.findIndex((line) => /^\s*(?:\*\*|__)/u.test(line) && loose(line) === normalized);
          return at < 0 ? null : { line: at + 1, title: lines[at].trim() }; })();
      findings.push({
        code: 'artifact.heading.missing', category: 'authoring', path: pathName, line: near?.line ?? null,
        value: String(requested), bytes: null, minimumBytes: null, ...(near ? { near: near.title } : {})
      });
      continue;
    }
    const heading = headings[index];
    const body = visibleText.slice(heading.contentStart, heading.end).trim();
    if (!body) findings.push({
      code: 'artifact.heading.empty', category: 'authoring', path: pathName, line: heading.line,
      value: String(requested), bytes: null, minimumBytes: null
    });
  }
  return findings;
}

const FINDING_PRIORITY = Object.freeze({
  'artifact.metadata.invalid': 0,
  'artifact.comment.unclosed': 5,
  'artifact.placeholder.unresolved': 10,
  'artifact.template.unchanged': 20,
  'artifact.heading.missing': 30,
  'artifact.heading.empty': 30,
  'artifact.required.too-short': 40,
  'artifact.required.too-large': 40
});

/** Preserve diagnostic priority, optional member order and exact source-line order. */
export function sortArtifactFindings(findings, { byPath = false } = {}) {
  return findings.sort((left, right) => (FINDING_PRIORITY[left.code] ?? 100) - (FINDING_PRIORITY[right.code] ?? 100)
    || (byPath ? left.path.localeCompare(right.path) : 0)
    || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER));
}

/** One structural pass; byte hashing remains an explicit storage/host responsibility. */
export function artifactContentObservation(text) {
  const authored = authoredArtifactText(text);
  const inspectionText = authoredArtifactText(text, { preserveLines: true });
  return Object.freeze({ source: text, authored, structure: parseMarkdownStructure(inspectionText),
    bytes: utf8Bytes(authored), fingerprintText: authoredArtifactFingerprintText(authored) });
}

/** Rules consume one pure structural observation and its adapter-computed normalized digest. */
export function inspectArtifactContentObservation(observation, {
  path: pathName = 'artifact', contract = {}, baseline = null, fingerprint
} = {}) {
  if (!observation || typeof observation.authored !== 'string' || !Number.isSafeInteger(observation.bytes)
      || observation.bytes < 0 || !observation.structure || !Array.isArray(observation.structure.headings)
      || !Array.isArray(observation.structure.unclosedComments) || typeof observation.structure.visibleText !== 'string'
      || typeof fingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new SingularityFlowError('Artifact inspection requires a content observation and its normalized fingerprint.',
      { code: 'ARTIFACT_OBSERVATION_INVALID' });
  }
  const { source: text, authored, structure, bytes } = observation;
  const findings = [];

  for (const comment of structure.unclosedComments) findings.push({
    code: 'artifact.comment.unclosed', category: 'authoring', path: pathName,
    line: comment.line, value: '<!--', bytes, minimumBytes: null, fingerprint
  });
  for (const placeholder of artifactPlaceholderFindings(text, { structure })) findings.push({
    code: 'artifact.placeholder.unresolved', category: 'authoring', path: pathName,
    line: placeholder.line, value: placeholder.value, bytes, minimumBytes: null, fingerprint
  });
  for (const forbidden of contract.validation?.forbiddenPlaceholders ?? []) {
    const escaped = String(forbidden).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(escaped, 'i').exec(structure.visibleText);
    if (match && !findings.some((finding) => finding.value.toLocaleLowerCase('en-US') === String(forbidden).toLocaleLowerCase('en-US'))) {
      findings.push({
        code: 'artifact.placeholder.unresolved', category: 'authoring', path: pathName,
        line: lineAt(structure.visibleText, match.index), value: String(forbidden), bytes,
        minimumBytes: null, fingerprint
      });
    }
  }
  if (baseline?.generation != null && baseline.generation === contract.generation
      && baseline.fingerprint === fingerprint) findings.push({
    code: 'artifact.template.unchanged', category: 'authoring', path: pathName, line: null,
    value: null, bytes, minimumBytes: null, fingerprint
  });
  findings.push(...requiredHeadingFindings(structure, contract.validation?.requiredHeadings, pathName)
    .map((finding) => ({ ...finding, bytes, fingerprint })));
  const minimum = contract.minimumBytes ?? 1;
  const maximum = contract.maximumBytes ?? Number.MAX_SAFE_INTEGER;
  if (bytes < minimum) findings.push({
    code: 'artifact.required.too-short', category: 'authoring', path: pathName, line: null,
    value: null, bytes, minimumBytes: minimum, fingerprint
  });
  if (bytes > maximum) findings.push({
    code: 'artifact.required.too-large', category: 'authoring', path: pathName, line: null,
    value: null, bytes, maximumBytes: maximum, minimumBytes: null, fingerprint
  });
  sortArtifactFindings(findings);
  return { authored, bytes, fingerprint, findings };
}

/** The same phase contract applies during authoring and to its submitted generation. */
export function requiredArtifactContentContract(phase, {
  generation = null, placeholders = true, minimumBytes = true
} = {}) {
  const contract = {
    ...phase.requiredArtifact,
    // During authoring the contract describes the next generation; after publication it describes
    // the current submitted generation. This lets submit/approval retain the unchanged-template
    // invariant instead of accidentally comparing generation N's bytes with an N+1 contract.
    generation: generation ?? (phase.status === 'in_progress'
      ? nextPhaseGeneration(phase)
      : Number(phase.generation)),
    ...(minimumBytes ? {} : { minimumBytes: 0 }),
    ...(!placeholders ? {
      validation: { ...phase.requiredArtifact.validation, forbiddenPlaceholders: [] }
    } : {})
  };
  return contract;
}

export function artifactMetadataInvalid(metadata) {
  return Boolean(metadata && !['valid', 'missing'].includes(metadata.status));
}

/** Compose metadata integrity with the already-inspected authored bytes. */
export function requiredArtifactContentFindings(inspected, {
  path: required = 'artifact', metadata = null, rawBytes = null, placeholders = true
} = {}) {
  const metadataFindings = artifactMetadataInvalid(metadata) ? [{
    code: 'artifact.metadata.invalid', category: 'integrity', path: required,
    line: metadata.line, value: metadata.status, bytes: rawBytes,
    minimumBytes: null, fingerprint: inspected.fingerprint
  }] : [];
  const findings = [...metadataFindings, ...inspected.findings];
  return placeholders ? findings : findings.filter(finding => finding.code !== 'artifact.placeholder.unresolved');
}

export function inspectBinaryArtifactSize(byteCount, phase, { path: required, minimumBytes = true } = {}) {
  if (!Number.isSafeInteger(byteCount) || byteCount < 0) throw new SingularityFlowError(
    'Binary artifact inspection requires a finite non-negative byte count.', { code: 'ARTIFACT_OBSERVATION_INVALID' });
  const contract = phase.requiredArtifact ?? {};
  const minimum = minimumBytes ? (contract.minimumBytes ?? 1) : 0;
  const maximum = contract.maximumBytes ?? Number.MAX_SAFE_INTEGER;
  const base = { category: 'authoring', path: required, line: null, value: null, bytes: byteCount };
  const findings = [];
  if (byteCount < minimum) findings.push({ ...base, code: 'artifact.required.too-short', minimumBytes: minimum });
  if (byteCount > maximum) findings.push({ ...base, code: 'artifact.required.too-large', maximumBytes: maximum });
  if (contract.validation?.requiredHeadings?.length || contract.validation?.forbiddenPlaceholders?.length) {
    findings.push({ ...base, code: 'artifact.binary.text-contract', minimumBytes: null });
  }
  return findings;
}
