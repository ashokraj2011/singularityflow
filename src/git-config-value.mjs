/**
 * One Git configuration value as Git reads it (git-config(1), "Syntax"; config.c parse_value), for
 * the readers that take a value from the file without starting Git. Git writes a Windows path with
 * its backslashes escaped (`url = C:\\Users\\...`) and quotes a value with `#` or `;`, so a raw read
 * names a different remote than Git does.
 */
const ESCAPES = Object.freeze({ '\\': '\\', '"': '"', n: '\n', t: '\t', b: '\b' });

/**
 * `raw` is what follows the `=` on one line. Quotes are removed, escapes decoded, and an unquoted `#`
 * or `;` starts a comment. Whitespace outside quotes is dropped before the value and after it and
 * kept as written inside it, as Git keeps it. A trailing backslash continues the value on the line
 * `next()` returns (undefined when there is none). Null where Git would refuse the value, or for one
 * continued past the last line.
 */
export function gitConfigValue(raw, next = () => undefined) {
  let value = '';
  let quoted = false;
  let spaces = '';
  for (let line = raw; ;) {
    let continued = false;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (!quoted && /\s/u.test(char)) { if (value) spaces += char; continue; }
      if (!quoted && (char === '#' || char === ';')) return value;
      value += spaces;
      spaces = '';
      if (char === '\\') {
        if (index === line.length - 1) { continued = true; break; }
        const decoded = ESCAPES[line[++index]];
        if (decoded === undefined) return null;
        value += decoded;
      } else if (char === '"') quoted = !quoted;
      else value += char;
    }
    if (!continued) return quoted ? null : value;
    line = next();
    if (line === undefined) return null;
  }
}

/**
 * The remotes a Git configuration file's text names, read as Git reads it with no Git process: section
 * names without case (`[REMOTE "origin"]`), the legacy `[remote.origin]` form, and the
 * `url.<base>.insteadOf` rewrites. `includes` are its `include.path` and `includeIf.<condition>.path`
 * entries as written (condition null for `[include]`), never followed. `confident` is false for a line
 * Git would refuse (U1).
 */
export function gitConfigRemotes(text) {
  const remotes = []; const rewrites = []; const includes = [];
  let confident = true; let section = null; let subsection = null;
  const lines = text.split(/\r?\n/u);
  for (const cursor = { index: 0 }; cursor.index < lines.length; cursor.index += 1) {
    let rest = lines[cursor.index].replace(/^\s+/u, '');
    if (!rest || rest[0] === '#' || rest[0] === ';') continue;
    if (rest[0] === '[') {
      const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\\n]|\\.)*)")?\s*\]/u.exec(rest);
      if (!header) { confident = false; section = null; continue; }
      const [name, ...dotted] = header[1].split('.');
      section = name.toLowerCase();
      subsection = header[2] !== undefined ? header[2].replace(/\\(.)/gu, '$1')
        : dotted.length ? dotted.join('.').toLowerCase() : null;
      if (header[2] !== undefined && dotted.length) confident = false;
      rest = rest.slice(header[0].length).replace(/^\s+/u, '');
      if (!rest || rest[0] === '#' || rest[0] === ';') continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(=)?/u.exec(rest);
    if (!entry || section === null) { confident = false; continue; }
    const key = entry[1].toLowerCase();
    const include = key === 'path' && (section === 'include' ? subsection === null : section === 'includeif' && subsection !== null);
    // A key with no `=` is a boolean: never a URL or a rewrite, and an include path Git refuses.
    if (!entry[2]) { if (include) confident = false; continue; }
    const value = gitConfigValue(rest.slice(entry[0].length), () => lines[++cursor.index]);
    if (value === null) { confident = false; continue; }
    if (section === 'remote' && subsection !== null && (key === 'url' || key === 'pushurl') && value) {
      remotes.push({ remote: subsection, key, url: value });
    } else if (section === 'url' && subsection !== null && (key === 'insteadof' || key === 'pushinsteadof')) {
      rewrites.push({ base: subsection, key, value });
    } else if (include) includes.push({ condition: section === 'includeif' ? subsection : null, path: value });
  }
  return { remotes, rewrites, includes, confident };
}

/** The URL of one remote (`origin` by default) the text names, or null. */
export function gitConfigRemoteUrl(text, remote = 'origin') {
  return gitConfigRemotes(text).remotes.find((entry) => entry.remote === remote && entry.key === 'url')?.url ?? null;
}
