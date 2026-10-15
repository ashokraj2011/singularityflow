/** A bounded declarative XML subset. No DOM, HTML recovery, DTD, entities, imports or execution. */
import { SingularityFlowError, isPortableRepositoryPathComponent } from './util.mjs';

export const WORKFLOW_MARKUP_LIMITS = Object.freeze({ bytes: 256 * 1024, nodes: 2048, depth: 16, attributes: 24 });
const NAME = /^[a-z][a-z0-9-]*/u;

export function markupError(message, node = null, code = 'WORKFLOW_MARKUP_INVALID') {
  throw new SingularityFlowError(`${message}${node ? ` (line ${node.line})` : ''}`, {
    code, ...(node ? { details: { line: node.line, offset: node.start } } : {})
  });
}

function decode(value, node) {
  // Only the five predefined XML entities and literal Unicode scalar references are supported.
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#(?:[0-9]+|x[0-9a-fA-F]+);)/u.test(value)) {
    markupError('Unknown or unterminated entity; escape a literal ampersand as &amp;.', node);
  }
  return value.replace(/&(amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));/gu, (_, entity) => {
    if (entity[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
    const number = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isSafeInteger(number) || number > 0x10ffff || number < 0x20 && ![9, 10, 13].includes(number)
        || number >= 0xd800 && number <= 0xdfff || [0xfffe, 0xffff].includes(number)) {
      markupError('Entity is not an XML Unicode scalar.', node);
    }
    return String.fromCodePoint(number);
  });
}

export function parseWorkflowMarkup(source) {
  if (typeof source !== 'string' || !source.trim() || !source.isWellFormed()
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(source)) {
    markupError('Markup requires well-formed UTF-8 text.');
  }
  if (Buffer.byteLength(source) > WORKFLOW_MARKUP_LIMITS.bytes) markupError('Markup exceeds 256 KiB.', null, 'WORKFLOW_MARKUP_LIMIT');
  let offset = 0; let line = 1; let count = 0;
  const document = { name: '#document', children: [], start: 0, line: 1 };
  const stack = [document];
  const advance = end => { line += (source.slice(offset, end).match(/\n/gu) ?? []).length; offset = end; };
  const at = () => ({ line, start: offset });
  const spaces = () => { const m = /^[\t\r\n ]*/u.exec(source.slice(offset))[0]; advance(offset + m.length); return m.length; };
  const name = () => { const m = NAME.exec(source.slice(offset)); if (!m || m[0].length > 64) markupError('Expected a lower-case tag or attribute name of at most 64 characters.', at()); advance(offset + m[0].length); return m[0]; };
  while (offset < source.length) {
    const parent = stack.at(-1);
    if (source[offset] !== '<') {
      const end = source.indexOf('<', offset);
      const text = source.slice(offset, end < 0 ? source.length : end);
      if (text.includes(']]>')) markupError('CDATA terminator outside CDATA.', at());
      parent.children.push(decode(text, at())); advance(offset + text.length); continue;
    }
    if (source.startsWith('<!--', offset)) {
      const end = source.indexOf('-->', offset + 4);
      if (end < 0 || source.slice(offset + 4, end).includes('--')) markupError('Malformed comment.', at());
      advance(end + 3); continue;
    }
    if (source.startsWith('<![CDATA[', offset)) {
      const end = source.indexOf(']]>', offset + 9);
      if (end < 0 || stack.length === 1) markupError('Unterminated or misplaced CDATA.', at());
      parent.children.push(source.slice(offset + 9, end)); advance(end + 3); continue;
    }
    if (/^<[/]?(?:!|\?)/u.test(source.slice(offset))) markupError('Declarations, DTDs, processing instructions and external entities are not supported.', at());
    const position = at();
    advance(offset + 1);
    if (source[offset] === '/') {
      advance(offset + 1); const closing = name(); spaces();
      if (source[offset] !== '>' || stack.length === 1 || parent.name !== closing) markupError('Mismatched closing tag.', position);
      advance(offset + 1); parent.end = offset; stack.pop(); continue;
    }
    if (++count > WORKFLOW_MARKUP_LIMITS.nodes || stack.length > WORKFLOW_MARKUP_LIMITS.depth) markupError('Markup exceeds its node or depth budget.', position, 'WORKFLOW_MARKUP_LIMIT');
    const node = { name: name(), attrs: Object.create(null), children: [], ...position, end: null };
    let attrs = 0;
    while (offset < source.length) {
      const spaced = spaces();
      if (source[offset] === '>' || source.startsWith('/>', offset)) break;
      if (!spaced) markupError('Attributes must be separated by whitespace.', at());
      const key = name(); spaces();
      if (Object.hasOwn(node.attrs, key)) markupError(`Duplicate attribute '${key}'.`, node);
      if (++attrs > WORKFLOW_MARKUP_LIMITS.attributes) markupError('Too many attributes.', node, 'WORKFLOW_MARKUP_LIMIT');
      if (source[offset] !== '=') markupError('Attributes require quoted values.', at());
      advance(offset + 1); spaces(); const quote = source[offset];
      if (quote !== '"' && quote !== "'") markupError('Attributes require quoted values.', at());
      advance(offset + 1); const end = source.indexOf(quote, offset);
      if (end < 0 || source.slice(offset, end).includes('<')) markupError('Unterminated attribute or unescaped angle bracket.', at());
      node.attrs[key] = decode(source.slice(offset, end), node); advance(end + 1);
    }
    parent.children.push(node);
    if (source.startsWith('/>', offset)) { advance(offset + 2); node.end = offset; }
    else if (source[offset] === '>') { advance(offset + 1); stack.push(node); }
    else markupError('Unterminated opening tag.', node);
  }
  if (stack.length !== 1) markupError('Unclosed tag.', stack.at(-1));
  const roots = document.children.filter(child => typeof child !== 'string');
  if (roots.length !== 1 || document.children.some(child => typeof child === 'string' && child.trim())) markupError('Markup requires exactly one workflow root.');
  return roots[0];
}

export const markupChildren = node => node.children.filter(child => typeof child !== 'string');
export function markupShape(node, name, attributes = [], children = [], mixed = false) {
  if (node.name !== name) markupError(`Expected <${name}>.`, node);
  for (const key of Object.keys(node.attrs)) if (!attributes.includes(key)) markupError(`Unsupported attribute '${key}' on <${name}>.`, node);
  for (const child of markupChildren(node)) if (!children.includes(child.name)) markupError(`Unsupported <${child.name}> inside <${name}>.`, child);
  if (!mixed && node.children.some(child => typeof child === 'string' && child.trim())) markupError(`Place prose inside <description> in <${name}>.`, node);
}
export function markupId(value, node, label = 'ID') {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
      || !isPortableRepositoryPathComponent(value) || ['next', 'end'].includes(value)) markupError(`${label} requires a portable lower-case kebab-case name.`, node);
  return value;
}
export function markupText(node) {
  if (markupChildren(node).length) markupError('This text element cannot contain nested tags; use CDATA for literal markup.', node);
  return node.children.join('').trim();
}
