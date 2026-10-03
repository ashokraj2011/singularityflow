/**
 * Markdown to Confluence storage format, for after-step actions that publish an artifact as a page.
 *
 * Escape first: every character of the document is text unless a construct below claims it, and
 * what a construct emits is fixed markup around escaped text. A document can never inject HTML, a
 * macro or a script into the page, and a code block cannot close its own CDATA section.
 */

export function escapeStorageText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const SAFE_LINK = /^(?:https?:\/\/|mailto:)[^\s<>"']+$/i;

/** Code spans, links, bold and italic inside one line of text. */
function inline(text) {
  return String(text).split(/(`[^`]*`)/).map((part) => {
    if (/^`[^`]*`$/.test(part)) return `<code>${escapeStorageText(part.slice(1, -1))}</code>`;
    let html = '';
    let rest = part;
    // Links are found on the raw text, so their address is checked before anything is escaped.
    const link = /\[([^\]]+)\]\(([^)\s]+)\)/;
    let match;
    while ((match = link.exec(rest))) {
      html += emphasis(escapeStorageText(rest.slice(0, match.index)));
      const label = emphasis(escapeStorageText(match[1]));
      html += SAFE_LINK.test(match[2]) ? `<a href="${escapeStorageText(match[2])}">${label}</a>` : label;
      rest = rest.slice(match.index + match[0].length);
    }
    return html + emphasis(escapeStorageText(rest));
  }).join('');
}

function emphasis(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?=[^\w*]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?=[^\w]|$)/g, '$1<em>$2</em>');
}

function codeBlock(lines, language) {
  // CDATA ends at "]]>", so a literal one is split across two sections.
  const body = lines.join('\n').replace(/]]>/g, ']]]]><![CDATA[>');
  const lang = /^[a-z0-9+#-]{1,20}$/i.test(language ?? '') ? `<ac:parameter ac:name="language">${language.toLowerCase()}</ac:parameter>` : '';
  return `<ac:structured-macro ac:name="code">${lang}<ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body></ac:structured-macro>`;
}

function tableRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

/** The storage format of a Markdown document: headings, paragraphs, lists, tables, quotes and code. */
export function markdownToConfluenceStorage(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let index = 0;
  const isBlank = (line) => !line.trim();
  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) { index += 1; continue; }
    const fence = /^\s*(```|~~~)\s*([^\s`]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[index])) body.push(lines[index++]);
      index += 1;
      out.push(codeBlock(body, fence[2]));
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); index += 1; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr/>'); index += 1; continue; }
    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quoted.push(lines[index++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote><p>${quoted.map(inline).join('<br/>')}</p></blockquote>`);
      continue;
    }
    if (/^\s*\|/.test(line) && index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[index + 1])) {
      const header = tableRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && /^\s*\|/.test(lines[index])) rows.push(tableRow(lines[index++]));
      out.push(`<table><tbody><tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const pattern = bullet.test(line) ? bullet : numbered;
      const tag = pattern === bullet ? 'ul' : 'ol';
      const items = [];
      while (index < lines.length && pattern.test(lines[index])) items.push(pattern.exec(lines[index++])[1]);
      out.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && !isBlank(lines[index]) && !/^(#{1,6})\s|^\s*(```|~~~)|^\s*>|^\s*[-*+]\s|^\s*\d+[.)]\s|^\s*\|/.test(lines[index])) paragraph.push(lines[index++].trim());
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join(' ')}</p>`);
    else { out.push(`<p>${inline(lines[index].trim())}</p>`); index += 1; }
  }
  return out.join('\n');
}
