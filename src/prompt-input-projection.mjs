/** Lossless prompt-only projection. Never rewrites approved inputs or their durable receipts. */
import { createHash } from 'node:crypto';
import { renderInputsBlock } from './inputs.mjs';
import { parseMarkdownStructure } from './markdown-structure.mjs';
import { extractClauses } from './specifications.mjs';
import { recordSha256 } from './records.mjs';

export const PROMPT_INPUT_RENDERER = 'approved-inputs-v2';
const CLAUSE_HEADINGS = new Set(['requirements', 'acceptance criteria']);
const digest = (value) => String(value ?? '').replace(/^sha256:/, '');
const hash = (value) => createHash('sha256').update(value).digest('hex');

function verifiedCapsule(capsule) {
  if (!capsule?.capsuleSha256 || !Array.isArray(capsule.clauses)) return false;
  const { capsuleSha256, ...payload } = capsule;
  return digest(capsuleSha256) === recordSha256(payload);
}

function eligibleSummary(entry) {
  return entry.status === 'captured' && entry.projection?.kind === 'approved-summary'
    && entry.representation?.kind === 'summary' && !entry.truncated
    && typeof entry.content === 'string' && entry.representation.expansionHandle
    && /^[a-f0-9]{64}$/u.test(digest(entry.sha256))
    && (!entry.source?.path || entry.source.path === entry.repositoryPath)
    && (!entry.source?.rawSha256 || digest(entry.source.rawSha256) === digest(entry.sha256))
    && digest(entry.representation.sha256) === hash(entry.content)
    && digest(entry.projection.briefSha256) === hash(entry.content);
}

/** Only entire leaf sections consisting of exact clause list items qualify. Retain everything else. */
function duplicatedSection(body, clauses) {
  if (/<!--|```|~~~/u.test(body)) return null;
  const blocks = [];
  for (const line of body.replace(/\r\n/gu, '\n').trim().split('\n')) {
    if (!line.trim()) continue;
    if (/^(?:[-*+]|\d{1,9}[.)])\s+/u.test(line)) blocks.push(line);
    else if (/^\s+\S/u.test(line) && blocks.length) blocks[blocks.length - 1] += `\n${line}`;
    else return null;
  }
  if (!blocks.length) return null;
  const ids = [];
  const externalClauseIds = [...clauses.keys()];
  for (const block of blocks) {
    let extracted;
    try { extracted = extractClauses(block, { externalClauseIds }); }
    catch { return null; }
    if (extracted.length !== 1) return null;
    const clause = extracted[0];
    if (clauses.get(clause.id)?.text !== clause.body || ids.includes(clause.id)) return null;
    ids.push(clause.id);
  }
  return ids;
}

function projectSummary(entry, capsule) {
  if (!eligibleSummary(entry)) return { content: entry.content, clauses: [] };
  const sourcePath = entry.source?.path ?? entry.repositoryPath;
  // Identical wording alone is insufficient: another source or generation must remain visible.
  const matching = capsule.clauses.filter((clause) => clause.source?.path === sourcePath
    && digest(clause.sourceSha256) === digest(entry.sha256));
  const clauses = new Map(matching.map((clause) => [clause.id, clause]));
  if (!clauses.size || clauses.size !== matching.length) return { content: entry.content, clauses: [] };
  const structure = parseMarkdownStructure(entry.content);
  if (structure.unclosedComments.length) return { content: entry.content, clauses: [] };
  const replacements = [];
  for (const heading of structure.headings) {
    if (!CLAUSE_HEADINGS.has(heading.normalized)
        || structure.headings.some((child) => child.index > heading.index && child.index < heading.end)) continue;
    const body = entry.content.slice(heading.contentStart, heading.end);
    const ids = duplicatedSection(body, clauses);
    if (!ids) continue;
    const content = `\n\n> Exact clauses in Active Clause Capsule: ${ids.join(', ')}.\n\n`;
    if (Buffer.byteLength(content) < Buffer.byteLength(body)) {
      replacements.push({ start: heading.contentStart, end: heading.end, content, ids });
    }
  }
  let content = entry.content;
  for (const replacement of [...replacements].reverse()) {
    content = content.slice(0, replacement.start) + replacement.content + content.slice(replacement.end);
  }
  return { content, clauses: replacements.flatMap((entry) => entry.ids) };
}

/** Call only after collectInputs and activeClauseCapsule have verified their approval bindings. */
export function renderPromptInputsBlock(result, capsule) {
  const original = renderInputsBlock(result);
  const projections = [];
  const valid = Boolean(original.text) && verifiedCapsule(capsule);
  const records = result.records.map((entry) => {
    const projected = valid ? projectSummary(entry, capsule) : { content: entry.content, clauses: [] };
    if (projected.content === entry.content) return entry;
    projections.push({
      phase: entry.phase, path: entry.repositoryPath ?? entry.path,
      sourceSha256: entry.sha256, briefSha256: entry.projection.briefSha256,
      originalSha256: entry.representation.sha256,
      renderedSha256: `sha256:${hash(projected.content)}`,
      deduplicatedClauseIds: projected.clauses,
      savedBytes: Buffer.byteLength(entry.content) - Buffer.byteLength(projected.content)
    });
    // The visible representation hash names the projected bytes; the brief hash still names the
    // unchanged approved brief. renderInputsBlock only reads these copies, never durable records.
    return {
      ...entry, content: projected.content,
      representation: {
        ...entry.representation,
        sha256: `sha256:${hash(projected.content)}`, bytes: Buffer.byteLength(projected.content)
      }
    };
  });
  const rendered = projections.length ? renderInputsBlock({ ...result, records }) : original;
  return {
    ...rendered,
    projection: {
      renderer: PROMPT_INPUT_RENDERER,
      capsuleSha256: valid ? capsule.capsuleSha256 : null,
      originalSha256: original.sha256, renderedSha256: rendered.sha256,
      originalBytes: Buffer.byteLength(original.text), renderedBytes: Buffer.byteLength(rendered.text),
      originalContentBytes: original.text ? result.records.reduce((total, entry) =>
        total + (entry.status === 'captured' ? Buffer.byteLength(entry.content ?? '') : 0), 0) : 0,
      renderedContentBytes: rendered.text ? records.reduce((total, entry) =>
        total + (entry.status === 'captured' ? Buffer.byteLength(entry.content ?? '') : 0), 0) : 0,
      savedBytes: Buffer.byteLength(original.text) - Buffer.byteLength(rendered.text),
      inputs: projections
    }
  };
}
