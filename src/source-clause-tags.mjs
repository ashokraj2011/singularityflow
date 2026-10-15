/**
 * Source-comment clause tags, with their pure analysis reused by content. `[perf]`
 *
 * Kept apart from traceability-ids.mjs, which holds only clause-ID helpers: the Copilot edit guard
 * runs on every tool call and needs those helpers, never this scanner or its cache.
 */
import { javascriptSourceComments } from './javascript-source-comments.mjs';
import { createSourceAnalysisCache } from './source-analysis-cache.mjs';
import { clauseTagsInComment } from './traceability-ids.mjs';

const analyzedSourceTags = createSourceAnalysisCache();

/**
 * Read explicit source-comment witnesses, never identifiers from executable text or strings.
 * Legacy bare and NFR annotations remain observable to older World Models, but only the
 * qualified governed form is suitable for a new code-delivery publication contract.
 */
export function scanSourceClauseTags(source, { legacy = false, sourcePath = null } = {}) {
  const text = String(source ?? '');
  const analyze = () => analyzeSourceClauseTags(text, { legacy, sourcePath });
  if (sourcePath !== null && typeof sourcePath !== 'string') return analyze();
  return analyzedSourceTags(text, JSON.stringify(['source-clause-tags-v1', Boolean(legacy), sourcePath]), analyze);
}

function analyzeSourceClauseTags(text, { legacy, sourcePath }) {
  // Preserve polyglot comment syntax. JavaScript/JSX gets lexical provenance so literal text
  // cannot become a witness, including multiline templates and JSX attributes/children.
  const javascript = /\.(?:[cm]?[jt]sx?|[cm][jt]s)$/iu.test(sourcePath ?? '')
    || (sourcePath == null && /\{\s*\/\*/u.test(text));
  const comments = javascript ? javascriptSourceComments(text, {
    jsx: !/\.(?:[cm]?ts)$/iu.test(sourcePath ?? '')
  }) : null;
  const result = [];
  const seen = new Set();
  const lineOffsets = [];
  let offset = 0;
  const decode = ({ clauseId, tag }, line) => {
    const key = `${line}:${clauseId}:${tag}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ clauseId, line, tag });
  };
  const lines = text.split('\n');
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  // Parse every marker in each lexical comment, never bytes following its closing delimiter.
  // Keep the leading-comment convention; comment-only JSX containers also permit inline tags.
  for (const comment of comments ?? []) {
    let low = 0;
    let high = lineOffsets.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineOffsets[middle] <= comment.start) low = middle + 1;
      else high = middle;
    }
    const firstLine = low;
    text.slice(comment.start, comment.end).split('\n').forEach((line, index) => {
      if (index === 0 && !comment.jsxContainer
          && !/^\s*$/u.test(text.slice(lineOffsets[firstLine - 1], comment.start))) return;
      for (const tag of clauseTagsInComment(line, { legacy })) decode(tag, firstLine + index);
    });
  }
  if (!comments) lines.forEach((line, index) => {
    const prefix = /^\s*(\/\/|#|\/\*+|\*|<!--|--)/u.exec(line);
    if (!prefix) return;
    const close = prefix[1] === '<!--' ? '-->' : /^\*/u.test(prefix[1]) || prefix[1].startsWith('/*') ? '*/' : null;
    const end = close ? line.indexOf(close, prefix[0].length) : -1;
    for (const tag of clauseTagsInComment(end < 0 ? line : line.slice(0, end), { legacy })) decode(tag, index + 1);
  });
  return result.sort((left, right) => left.line - right.line);
}
