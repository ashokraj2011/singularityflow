/**
 * One Git configuration value as Git reads it (git-config(1), "Syntax"; config.c parse_value), for
 * the readers that take a value from the file without starting Git. Git writes a Windows path with
 * its backslashes escaped (`url = C:\\Users\\...`) and quotes a value with `#` or `;`, so a raw read
 * names a different remote than Git does.
 */
const ESCAPES = Object.freeze({ '\\': '\\', '"': '"', n: '\n', t: '\t', b: '\b' });

/**
 * `raw` is what follows the `=` on one line. Quotes are removed, escapes decoded, whitespace outside
 * quotes trimmed at both ends and kept as one space for each character inside, and an unquoted `#`
 * or `;` starts a comment. Null where Git would refuse the value, or for one continued on the next line.
 */
export function gitConfigValue(raw) {
  let value = '';
  let quoted = false;
  let spaces = 0;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (!quoted && /\s/u.test(char)) { if (value) spaces += 1; continue; }
    if (!quoted && (char === '#' || char === ';')) break;
    value += ' '.repeat(spaces);
    spaces = 0;
    if (char === '\\') {
      const decoded = ESCAPES[raw[++index]];
      if (decoded === undefined) return null;
      value += decoded;
    } else if (char === '"') quoted = !quoted;
    else value += char;
  }
  return quoted ? null : value;
}
