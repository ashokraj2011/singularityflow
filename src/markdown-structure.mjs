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
