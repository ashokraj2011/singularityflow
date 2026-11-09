/** Specification clause/index values. Observation, retention and publication remain engine/SDA responsibilities. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,textDigestCapability,SPECIFICATION_INDEX_SCHEMA} from '../foundation/record-schema.mjs';
import {GOVERNED_CLAUSE_TYPES,GOVERNED_CLAUSE_TYPE_PATTERN,qualifiedClauseIds} from '../foundation/traceability-ids.mjs';
import {DEFAULT_SPECIFICATION_LIMITS as DEFAULT_LIMITS} from './configuration-policy.mjs';
import {authoredArtifactText} from './artifact-content.mjs';
import {parseVerificationIntent} from './verification-policy.mjs';

const CLAUSE_TYPES = new Set(GOVERNED_CLAUSE_TYPES);
const NAMESPACE = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const ANCHOR = new RegExp(`\\[(${NAMESPACE}):(${GOVERNED_CLAUSE_TYPE_PATTERN})-(\\d{3})\\]`, 'gi');


function lineNumber(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

/**
 * Regions where an anchor-looking string is not an anchor: fenced and inline code, and the
 * kernel-managed blocks.
 *
 * Exported because `[SPK:REQ-063]` requires clarification-marker extraction to ignore exactly the
 * same regions as clause extraction. "Consistently with" is only true if it is the same function —
 * a second copy of this list would agree today and drift on the first change to either.
 */
export function ignoredRanges(markdown, { includeInlineCode = true } = {}) {
  const ranges = [];
  const patterns = [
    /```[\s\S]*?```/g,
    /~~~[\s\S]*?~~~/g,
    ...(includeInlineCode ? [/`[^`\n]*`/g] : []),
    // The kernel's paired blocks, whose *contents* sit between two comments rather than inside one,
    // so the generic rule below cannot reach them.
    /<!--\s*singularity-flow:inputs:start\s*-->[\s\S]*?<!--\s*singularity-flow:inputs:end\s*-->/g,
    /<!--\s*singularity-flow:metadata:start\s*-->[\s\S]*?<!--\s*singularity-flow:metadata:end\s*-->/g,
    /* Any HTML comment `[SPK:REQ-063]`.
     *
     * This used to name only `singularity-flow:` comments, which meant an author's own commentary
     * was live text: a clause anchor or a `[NEEDS CLARIFICATION: ...]` written inside `<!-- -->`
     * counted. The starter specification template found it — its explanatory comment shows the
     * marker grammar, so every first generation from the template would have been blocked under
     * `markers: block` by the template's own example.
     *
     * The general rule is the right one anyway. A comment is invisible in the rendered document,
     * and a requirement nobody can read is not a requirement.
     */
    /<!--[\s\S]*?-->/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(markdown))) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

export function isIgnored(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function dependencies(body) {
  return [...qualifiedClauseIds(body)].sort();
}

/**
 * Every clause a text cites, by exact ID: the same reference grammar a clause uses to name the
 * clauses it depends on, so `W-1:AC-001` is never found inside `XW-1:AC-001` or `W-1:AC-0010`.
 */
export function clauseReferences(text) {
  return dependencies(String(text ?? ''));
}

const HEADING_LINE = /^\s{0,3}#{1,6}(?:\s|$)/;
const HEADING_PREFIX = /^\s{0,3}#{1,6}\s*/;
const TABLE_LINE = /^\s*\|/;
const LIST_LINE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;

function lineKind(line) {
  if (!line.trim()) return 'blank';
  if (HEADING_LINE.test(line)) return 'heading';
  if (TABLE_LINE.test(line)) return 'table';
  if (LIST_LINE.test(line)) return 'list';
  return 'text';
}

/** Replace every character in the ranges with a space, keeping offsets and line breaks exact. */
function maskRanges(text, ranges) {
  if (!ranges.length) return text;
  const characters = text.split('');
  for (const [start, end] of ranges) {
    for (let index = start; index < end; index += 1) if (characters[index] !== '\n') characters[index] = ' ';
  }
  return characters.join('');
}

function normalizeStatement(raw, kind) {
  // Removing an anchor leaves a gap ("now ." or ". Do Y"); close it so the hash follows the words.
  const tidy = (text) => text.replace(/\s+/g, ' ').replace(/ ([.,;:!?)\]])/g, '$1').trim();
  const text = kind === 'table'
    ? raw.split('|').map(tidy).filter(Boolean).join(' | ')
    : raw.split('\n').map(tidy).filter(Boolean).join('\n');
  return text.replace(/^[.,;:!?)\]]+\s*/u, '');
}

/**
 * The statement each anchor identifies: the text of the block it sits in.
 *
 * Authors place anchors in three ways, and the shipped templates use all of them: at the end of the
 * sentence (`- Export CSV. [W:REQ-001]`), at the start of a table row (`| [W:AC-001] | outcome |`),
 * or on a line of their own above the sentence. A clause is the block holding its anchor — the list
 * item, table row, paragraph or heading section — never "the text up to the next anchor", which made
 * REQ-001 hash REQ-002's sentence whenever anchors ended their lines. Two anchors in one block split
 * it: leading anchors own the text after them, trailing anchors the text before them. Fenced code,
 * comments and kernel-managed blocks are masked, so they bound blocks and never join a statement.
 */
function clauseStatements(markdown, anchors) {
  const masked = maskRanges(markdown, ignoredRanges(markdown, { includeInlineCode: false }));
  const lines = masked.split('\n');
  const starts = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  const kinds = lines.map(lineKind);
  const lineOf = (index) => {
    let low = 0; let high = starts.length - 1;
    while (low < high) { const middle = (low + high + 1) >> 1; if (starts[middle] <= index) low = middle; else high = middle - 1; }
    return low;
  };
  const anchorLines = new Set(anchors.map((anchor) => lineOf(anchor.index)));
  const extent = (lineIndex) => {
    if (kinds[lineIndex] === 'table' || kinds[lineIndex] === 'heading') return [lineIndex, lineIndex];
    let first = lineIndex; let last = lineIndex;
    if (kinds[lineIndex] === 'text') {
      while (first > 0 && kinds[first - 1] === 'text') first -= 1;
      // A paragraph line directly under a list item continues that item.
      if (first > 0 && kinds[first - 1] === 'list') first -= 1;
    }
    while (last + 1 < lines.length && kinds[last + 1] === 'text') last += 1;
    return [first, last];
  };
  const contentStart = (lineIndex) => {
    const line = lines[lineIndex];
    if (kinds[lineIndex] === 'list') return starts[lineIndex] + line.match(LIST_LINE)[0].length;
    if (kinds[lineIndex] === 'heading') return starts[lineIndex] + line.match(HEADING_PREFIX)[0].length;
    return starts[lineIndex];
  };
  const hasWords = (text) => /[\p{L}\p{N}]/u.test(text);
  // The lines after a heading or a lone anchor, up to the next heading or the next anchored line.
  const sectionAfter = (lineIndex) => {
    let end = lineIndex;
    while (end + 1 < lines.length && kinds[end + 1] !== 'heading' && !anchorLines.has(end + 1)) end += 1;
    return end > lineIndex ? normalizeStatement(lines.slice(lineIndex + 1, end + 1).join('\n'), 'text') : '';
  };
  return anchors.map((anchor) => {
    const anchorLine = lineOf(anchor.index);
    const [first, last] = extent(anchorLine);
    const kind = kinds[first];
    const blockStart = contentStart(first);
    const blockEnd = starts[last] + lines[last].length;
    const siblings = anchors.filter((candidate) => candidate.index >= starts[first] && candidate.index < blockEnd);
    const position = siblings.indexOf(anchor);
    let pieces;
    if (siblings.length === 1) {
      pieces = [[blockStart, anchor.index], [anchor.end, blockEnd]];
    } else if (!hasWords(masked.slice(blockStart, siblings[0].index))) {
      pieces = [[anchor.end, siblings[position + 1]?.index ?? blockEnd]];
    } else {
      pieces = [[position ? siblings[position - 1].end : blockStart, anchor.index]];
      if (position === siblings.length - 1 && hasWords(masked.slice(anchor.end, blockEnd))) pieces.push([anchor.end, blockEnd]);
    }
    let statement = normalizeStatement(pieces.map(([start, end]) => masked.slice(start, end)).join(' '), kind);
    if (kind === 'heading' && siblings.length === 1) {
      // A heading anchor owns its section.
      statement = [statement, sectionAfter(anchorLine)].filter(Boolean).join('\n');
    } else if (!statement && siblings.length === 1) {
      // An anchor alone in its block heads the text that follows it, like a heading would.
      statement = sectionAfter(last);
    }
    return statement;
  });
}

export function plannedClaimSource(markdown) {
  const authored = authoredArtifactText(markdown);
  const ranges = ignoredRanges(authored, { includeInlineCode: false });
  if (!ranges.length) return authored;
  let cursor = 0;
  let visible = '';
  for (const [start, end] of ranges.sort((left, right) => left[0] - right[0])) {
    if (start < cursor) continue;
    visible += authored.slice(cursor, start);
    visible += authored.slice(start, end).replace(/[^\n]/g, ' ');
    cursor = end;
  }
  return visible + authored.slice(cursor);
}

/** UTF-8 hashing is the only capability required by the clause/index value rules. */
export function specificationValuePolicies(digests) {
const {sha256Utf8:sha256}=textDigestCapability(digests);
function extractClauses(markdown, {
  sourcePath = null, namespace = null, limits = DEFAULT_LIMITS, externalClauseIds = [], externalClauses = []
} = {}) {
  if (typeof markdown !== 'string') throw new SingularityFlowError('Specification artifact must be UTF-8 Markdown.');
  const ignored = ignoredRanges(markdown);
  const matches = [];
  let match;
  ANCHOR.lastIndex = 0;
  while ((match = ANCHOR.exec(markdown))) {
    if (!isIgnored(match.index, ignored)) matches.push({ match, index: match.index, end: ANCHOR.lastIndex });
  }
  if (matches.length > limits.maxClausesPerArtifact) {
    throw new SingularityFlowError(`Specification contains ${matches.length} clauses; configured maximum is ${limits.maxClausesPerArtifact}.`);
  }
  const seen = new Map();
  const statements = clauseStatements(markdown, matches);
  const clauses = matches.map((entry, index) => {
    const [anchor, rawNamespace, rawType, number] = entry.match;
    const actualNamespace = rawNamespace.toUpperCase();
    const type = rawType.toUpperCase();
    const id = `${actualNamespace}:${type}-${number}`;
    if (namespace && namespace !== actualNamespace) {
      throw new SingularityFlowError(`Clause ${id} does not use configured namespace ${namespace}.`);
    }
    if (!CLAUSE_TYPES.has(type)) throw new SingularityFlowError(`Clause ${id} has unsupported type ${type}.`);
    if (seen.has(id)) throw new SingularityFlowError(`Clause ${id} is duplicated at lines ${seen.get(id)} and ${lineNumber(markdown, entry.index)}. Brackets define a clause, once; cite it elsewhere as \`${id}\` in backticks, without brackets.`);
    const line = lineNumber(markdown, entry.index);
    seen.set(id, line);
    // Line numbers and source hashes come from the complete published artifact, but the body is the
    // clause's own statement and contains only producer-authored bytes: managed input envelopes,
    // comments and fenced code are masked before the statement is read.
    const body = statements[index];
    const dependsOn = dependencies(body).filter((candidate) => candidate !== id);
    if (dependsOn.length > limits.maxDependenciesPerClause) {
      throw new SingularityFlowError(`Clause ${id} references more than ${limits.maxDependenciesPerClause} dependencies.`);
    }
    return {
      id,
      namespace: actualNamespace,
      type,
      number: Number(number),
      anchor,
      source: { path: sourcePath, line },
      body,
      bodySha256: sha256(body),
      dependsOn
    };
  });
  const external = externalClauses.map((clause) => ({
    ...clause,
    id: String(clause.id).toUpperCase(),
    dependsOn: (clause.dependsOn ?? []).map((id) => String(id).toUpperCase())
  }));
  // An earlier phase's clause is the Story's definition of that ID. Re-anchoring it here used to
  // replace it silently, so coverage was computed against a statement no reviewer approved.
  const predecessors = new Map(external.map((clause) => [clause.id, clause]));
  for (const clause of clauses) {
    const prior = predecessors.get(clause.id);
    if (!prior) continue;
    const where = prior.source?.path ? ` in ${prior.source.path}${prior.source.line ? ` line ${prior.source.line}` : ''}` : '';
    throw new SingularityFlowError(
      `Clause ${clause.id} at line ${clause.source.line} is already defined by an earlier phase${where}. `
      + `A clause is defined once per Story: cite it as ${clause.id} without brackets, or give the new clause its own number.`,
      { code: 'SPEC_CLAUSE_REDEFINED' }
    );
  }
  const graphClauses = new Map([...external, ...clauses].map((clause) => [clause.id, clause]));
  const ids = new Set([...graphClauses.keys(), ...externalClauseIds.map((id) => String(id).toUpperCase())]);
  for (const clause of clauses) {
    for (const dependency of clause.dependsOn) {
      if (!ids.has(dependency)) {
        throw new SingularityFlowError(`Clause ${clause.id} references missing dependency ${dependency}. A clause may depend only on a clause this Story defines.`, {
          code: 'SPEC_CLAUSE_DEPENDENCY_MISSING', details: { clause: clause.id, dependency, line: clause.source?.line ?? null }
        });
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, trail = []) => {
    if (visiting.has(id)) {
      throw new SingularityFlowError(`Specification clause dependency cycle: ${[...trail, id].join(' -> ')}.`, {
        code: 'SPEC_CLAUSE_DEPENDENCY_CYCLE', details: { cycle: [...trail, id] }
      });
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const clause = graphClauses.get(id);
    for (const dependency of clause?.dependsOn ?? []) visit(dependency, [...trail, id]);
    visiting.delete(id);
    visited.add(id);
  };
  graphClauses.forEach((clause) => visit(clause.id));
  const verification = parseVerificationIntent(plannedClaimSource(markdown), clauses, { externalClauses: external });
  for (const clause of clauses) if (verification.has(clause.id)) clause.verification = verification.get(clause.id);
  return clauses;
}

/** An index value, not retained evidence or an acceptance/approval claim. Source facts must be observed by the caller. */
function specificationIndexRecord({workId,phase,generation=0,source,clauses}) {
  const indexWithoutHash={
    schemaVersion:SPECIFICATION_INDEX_SCHEMA.currentVersion,
    workId:workId??null,phase:phase??null,generation:Number(generation??0),
    source:{path:source.path,sha256:source.sha256,bytes:source.bytes},clauses
  };
  return {...indexWithoutHash,indexSha256:sha256(canonicalJson(indexWithoutHash))};
}
return Object.freeze({extractClauses,specificationIndexRecord});
}
