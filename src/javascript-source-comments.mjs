/**
 * Bounded lexical comment locations for JavaScript/TypeScript with JSX. Never imports or
 * executes repository code. JSX child text, attribute strings, regex bodies and template text
 * are not comments; expressions inside JSX/template containers are scanned as code.
 * This is comment provenance, not an AST or a proof of application behavior.
 */
const REGEX_KEYWORDS = new Set([
  'return', 'throw', 'case', 'typeof', 'void', 'delete', 'yield', 'await', 'new', 'in', 'of', 'else', 'do'
]);
const CONTROL_PARENTHESES = new Set(['if', 'while', 'for', 'with', 'switch', 'catch']);
const OBJECT_PREFIXES = new Set(['=', '(', '[', ',', ':', 'return', 'yield']);
const MAX_DEPTH = 128;
const MAX_COMMENTS = 200_000;

export function javascriptSourceComments(source, { jsx: allowJsx = true } = {}) {
  const text = String(source ?? '');
  if (text.length >= 16 * 1024 * 1024) return [];
  const comments = [];
  let index = 0;
  let failed = false;
  const whitespace = () => { while (/\s/u.test(text[index] ?? '') && index < text.length) index += 1; };
  const quoted = (quote, multiline = false) => {
    index += 1;
    while (index < text.length) {
      if (!multiline && text[index] === '\\') {
        index += text[index + 1] === '\r' && text[index + 2] === '\n' ? 3 : 2;
        continue;
      }
      if (text[index++] === quote) return;
      if (!multiline && /[\r\n]/u.test(text[index - 1])) break;
    }
    failed = true;
  };
  const template = depth => {
    index += 1;
    while (index < text.length && !failed) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index] === '`') { index += 1; return; }
      if (text[index] === '$' && text[index + 1] === '{') {
        index += 2;
        code(depth + 1, true);
      } else index += 1;
    }
    failed = true;
  };
  const regex = () => {
    index += 1;
    let inClass = false;
    while (index < text.length) {
      const character = text[index++];
      if (character === '\\') { index += 1; continue; }
      if (/[\r\n]/u.test(character)) break;
      if (character === '[') inClass = true;
      else if (character === ']') inClass = false;
      else if (character === '/' && !inClass) {
        while (/[A-Za-z]/u.test(text[index] ?? '')) index += 1;
        return;
      }
    }
    failed = true;
  };
  const comment = (kind, expressionStart) => {
    const start = index;
    const close = kind === 'block' ? text.indexOf('*/', start + 2) : text.indexOf('\n', start + 2);
    if (kind === 'block' && close < 0) { failed = true; return; }
    index = close < 0 ? text.length : close + (kind === 'block' ? 2 : 0);
    let after = index;
    while (/\s/u.test(text[after] ?? '') && after < text.length) after += 1;
    // Only a comment-only JSX expression container confers the wrapped/inline syntax.
    const jsxContainer = kind === 'block' && expressionStart != null
      && /^\s*$/u.test(text.slice(expressionStart, start)) && text[after] === '}';
    comments.push({ start, end: index, kind, jsxContainer });
    if (comments.length > MAX_COMMENTS) failed = true;
  };
  const jsx = depth => {
    if (depth > MAX_DEPTH) { failed = true; return; }
    index += 1; // '<'
    const name = text[index] === '>' ? ''
      : /^[A-Za-z_$][A-Za-z0-9_$:.-]*/u.exec(text.slice(index))?.[0];
    if (name == null) { failed = true; return; }
    index += name.length;
    // Tag attributes are literal data except within {...} expressions.
    while (index < text.length && !failed) {
      whitespace();
      if (text.startsWith('/>', index)) { index += 2; return; }
      if (text[index] === '>') { index += 1; break; }
      if (text[index] === '"' || text[index] === "'") quoted(text[index], true);
      else if (text[index] === '{') { index += 1; code(depth + 1, true, index); }
      else if (text[index] === '<' || text[index] === '/') { failed = true; return; }
      else index += 1;
    }
    // Quotes and comment-looking prose in child text are data, not JavaScript.
    while (index < text.length && !failed) {
      if (text.startsWith('</', index)) {
        index += 2;
        const closeName = name ? /^[A-Za-z_$][A-Za-z0-9_$:.-]*/u.exec(text.slice(index))?.[0] : '';
        if (closeName !== name) { failed = true; return; }
        index += closeName.length;
        whitespace();
        if (text[index++] !== '>') failed = true;
        return;
      }
      if (text[index] === '<') jsx(depth + 1);
      else if (text[index] === '{') { index += 1; code(depth + 1, true, index); }
      else index += 1;
    }
    failed = true;
  };
  const code = (depth = 0, nested = false, expressionStart = null) => {
    if (depth > MAX_DEPTH) { failed = true; return; }
    let regexAllowed = true;
    let previous = null;
    const parentheses = [];
    while (index < text.length && !failed) {
      const character = text[index];
      if (/\s/u.test(character)) { index += 1; continue; }
      if (character === '}' && nested) { index += 1; return; }
      if (text.startsWith('//', index)) { comment('line', expressionStart); continue; }
      if (text.startsWith('/*', index)) { comment('block', expressionStart); continue; }
      if (character === '"' || character === "'") { quoted(character); regexAllowed = false; continue; }
      if (character === '`') { template(depth + 1); regexAllowed = false; continue; }
      if (character === '/' && regexAllowed) { regex(); regexAllowed = false; continue; }
      // A TSX generic arrow (comma or constrained/default type parameter) is not JSX.
      const genericArrow = character === '<' && (
        /^<[A-Za-z_$][A-Za-z0-9_$]*\s*,/u.test(text.slice(index))
        || /^<[A-Za-z_$][A-Za-z0-9_$]*\s*(?:extends\b|=)[^;{}]{0,1024}>\s*\([^)]{0,1024}\)\s*(?::[^=\n]{1,512})?=>/u.test(text.slice(index))
      );
      if (allowJsx && !genericArrow && character === '<' && regexAllowed && /[A-Za-z_$>]/u.test(text[index + 1] ?? '')) {
        jsx(depth + 1);
        regexAllowed = false;
        previous = 'jsx';
        continue;
      }
      if (character === '{') {
        const object = OBJECT_PREFIXES.has(previous);
        index += 1;
        code(depth + 1, true);
        regexAllowed = !object;
        previous = '}';
        continue;
      }
      const word = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(index))?.[0];
      if (word) { index += word.length; regexAllowed = REGEX_KEYWORDS.has(word); previous = word; continue; }
      if (/[0-9]/u.test(character)) {
        index += 1;
        while (/[A-Za-z0-9_.]/u.test(text[index] ?? '')) index += 1;
        regexAllowed = false;
        previous = 'literal';
        continue;
      }
      const operator = text.slice(index, index + 2);
      index += ['=>', '++', '--', '?.'].includes(operator) ? 2 : 1;
      if (character === '(') {
        if (parentheses.length >= MAX_DEPTH) { failed = true; return; }
        parentheses.push(CONTROL_PARENTHESES.has(previous));
        regexAllowed = true;
      } else if (character === ')') regexAllowed = parentheses.pop() === true;
      else regexAllowed = operator === '=>' || (!['++', '--', '?.'].includes(operator)
          && ![']', '.', '}'].includes(character));
      previous = ['=>', '++', '--', '?.'].includes(operator) ? operator : character;
    }
    if (nested) failed = true;
  };
  if (text.startsWith('#!')) { const end = text.indexOf('\n'); index = end < 0 ? text.length : end; }
  code();
  return failed ? [] : comments;
}
