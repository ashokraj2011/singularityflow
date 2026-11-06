/**
 * Where a runner's own configuration says its tests are, read as data from the Story's base commit.
 *
 * `vitest run src` drops a test file only if the base commit ran it. A file `test.include`, Jest's `testMatch`,
 * Playwright's `testDir` or pytest's `testpaths` never collected read as dropped, and a person was asked about
 * tests that never ran. A configuration is tokenized, never imported or run, and only plain literals count: what
 * this cannot read comes back as `unread`, so the refusal can say this may be why and keep the person's route.
 */
import { TEST_RUNNERS } from './test-runners.mjs';
import { tokenizeJavaScript } from './verification/javascript-declarations.mjs';

const clean = (value) => String(value).replaceAll('\\', '/').replace(/^<rootDir>\/?/u, '').replace(/^\.\//u, '').replace(/\/+$/u, '');
const within = (file, folder) => !folder || folder === '.' || file === folder || file.startsWith(`${folder}/`);

/** A glob as the runners write them: `**`, `*`, `?`, `{a,b}` and `?(c|m)`. Null for one this does not read. */
function globMatcher(glob) {
  const source = clean(glob);
  if (/[[\]!+@]/u.test(source.replace(/\?\(/gu, ''))) return null;
  const escaped = source.replace(/[.+^$\\]/gu, '\\$&')
    .replace(/\?\(([^)]*)\)/gu, '\u0003$1\u0004')
    .replace(/\*\*\//gu, '\u0001').replace(/\*\*/gu, '\u0005').replace(/\*/gu, '\u0002').replace(/\?/gu, '[^/]')
    .replace(/\{([^}]*)\}/gu, (_, list) => `(?:${list.replaceAll(',', '|')})`)
    .replaceAll('\u0001', '(?:.*/)?').replaceAll('\u0005', '.*').replaceAll('\u0002', '[^/]*').replaceAll('\u0003', '(?:').replaceAll('\u0004', ')?');
  try { const pattern = new RegExp(`^${escaped}$`, 'u'); return (file) => pattern.test(file); } catch { return null; }
}

/** Each named option's plain values in a configuration's text, or `unread` when any of them is not plain. */
function literalOptions(text, { keys, opaque = [], within: block = null }) {
  let tokens;
  try { tokens = tokenizeJavaScript(text).filter((token) => token.type !== 'comment'); } catch { return { unread: true }; }
  const stringOf = (token) => (token?.type === 'string' || (token?.type === 'template' && !token.substitutions) ? token.value : null);
  // A shared configuration brought in or spread here may set them: this file alone cannot say.
  const importsOwn = tokens.some((token, index) => /^\.\.?\//u.test(stringOf(token) ?? '') && (tokens[index - 1]?.value === 'from' || tokens[index - 1]?.value === '('));
  if (importsOwn || tokens.some((token) => token.value === 'mergeConfig')) return { unread: true };
  let [start, end] = [0, tokens.length];
  if (block) {
    const at = tokens.findIndex((token, index) => (token.value === block) && tokens[index + 1]?.value === ':');
    if (at < 0) return { values: {} };
    if (tokens[at + 2]?.value !== '{') return { unread: true };
    let depth = 0;
    for (let index = at + 2; index < tokens.length; index += 1) {
      if (tokens[index].value === '{') depth += 1;
      else if (tokens[index].value === '}' && --depth === 0) { [start, end] = [at + 3, index]; break; }
    }
  }
  const values = {};
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (token.value === '...') return { unread: true };
    const name = token.type === 'identifier' || token.type === 'string' ? token.value : null;
    if (tokens[index + 1]?.value !== ':' || tokens[index - 1]?.value === '.' || !name) continue;
    if (opaque.includes(name)) return { unread: true };
    if (!keys.includes(name)) continue;
    // The same option twice is per project: which one applies is not this read's to say.
    if (Object.hasOwn(values, name)) return { unread: true };
    const single = stringOf(tokens[index + 2]);
    if (single !== null) { values[name] = [single]; continue; }
    if (tokens[index + 2]?.value !== '[') return { unread: true };
    const list = [];
    let cursor = index + 3;
    for (; cursor < end && tokens[cursor].value !== ']'; cursor += 1) {
      if (tokens[cursor].value === ',') continue;
      const item = stringOf(tokens[cursor]);
      if (item === null) return { unread: true };
      list.push(item);
    }
    values[name] = list;
    index = cursor;
  }
  return { values };
}

const anyGlob = (globs) => {
  const matchers = globs.map(globMatcher);
  return matchers.every(Boolean) ? (file) => matchers.some((match) => match(file)) : null;
};

/** What one runner's options accept, as a predicate on a path relative to the configuration's folder; null when beyond this read. */
function accepts(runner, values) {
  const tests = [];
  const add = (test) => { if (!test) return false; tests.push(test); return true; };
  if (runner === 'vitest') {
    const folder = values.dir ? clean(values.dir[0]) : null;
    const relative = (file) => (folder && folder !== '.' ? file.slice(folder.length + 1) : file);
    if (folder) tests.push((file) => within(file, folder));
    if (values.include) { const match = anyGlob(values.include); if (!match) return null; tests.push((file) => match(relative(file))); }
    if (values.exclude) { const match = anyGlob(values.exclude); if (!match) return null; tests.push((file) => !match(relative(file))); }
  } else if (runner === 'jest') {
    if (values.roots) { const roots = values.roots.map(clean); tests.push((file) => roots.some((root) => within(file, root))); }
    if (values.testMatch && !add(anyGlob(values.testMatch))) return null;
    for (const [name, wanted] of [['testRegex', true], ['testPathIgnorePatterns', false]]) {
      if (!values[name]) continue;
      let patterns;
      try { patterns = values[name].map((text) => new RegExp(clean(text), 'u')); } catch { return null; }
      tests.push((file) => patterns.some((pattern) => pattern.test(file)) === wanted);
    }
  } else if (runner === 'playwright') {
    const folder = values.testDir ? clean(values.testDir[0]) : null;
    if (folder) tests.push((file) => within(file, folder));
    // Playwright matches the absolute path, so a pattern with no leading `**/` still means anywhere below.
    const anywhere = (globs) => anyGlob(globs.map((glob) => (glob.startsWith('**/') ? glob : `**/${clean(glob)}`)));
    if (values.testMatch && !add(anywhere(values.testMatch))) return null;
    if (values.testIgnore) { const match = anywhere(values.testIgnore); if (!match) return null; tests.push((file) => !match(file)); }
  } else if (runner === 'mocha') {
    if (values.spec) {
      const places = values.spec.map(clean);
      const match = anyGlob(places);
      if (!match) return null;
      tests.push((file) => match(file) || places.some((place) => within(file, place)));
    }
    if (values.ignore) { const match = anyGlob(values.ignore); if (!match) return null; tests.push((file) => !match(file)); }
  }
  return tests.length ? (file) => tests.every((test) => test(file)) : null;
}

/** `testpaths` of the first pytest configuration file with a section, which is the one pytest reads. */
function pytestLimit(names, read) {
  for (const [name, header] of TEST_RUNNERS.pytest.collection.sections) {
    if (!names.includes(name)) continue;
    const lines = String(read(name) ?? '').split(/\r?\n/u);
    const start = lines.findIndex((line) => line.trim().toLowerCase().startsWith(header));
    if (start < 0) continue;
    const end = lines.findIndex((line, index) => index > start && /^\s*\[/u.test(line) && !line.trim().toLowerCase().startsWith(header));
    const section = lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
    const written = /^testpaths\s*=\s*((?:.*\n?)(?:[ \t]+.*\n?)*)/mu.exec(section)?.[1];
    if (!written) return { accepts: null, unread: [], operandsWin: true };
    const places = (/[[\]"']/u.test(written) ? [...written.matchAll(/["']([^"']+)["']/gu)].map((match) => match[1]) : written.trim().split(/\s+/u)).map(clean);
    if (!places.length || places.some((place) => /[*?{]/u.test(place))) return { accepts: null, unread: [name], operandsWin: true };
    return { accepts: (file) => places.some((place) => within(file, place)), unread: [], operandsWin: true, ownPlace: true };
  }
  return null;
}

/**
 * What a runner's configuration in one folder limits it to. `names` are the folder's file names and `read(name)`
 * their text. `accepts(file)` is a predicate on a folder-relative path, null when it says nothing it can read;
 * `unread` names the files that limit in a way this cannot read. Null when there is no configuration to read.
 */
export function collectionLimit(runner, names, read) {
  if (runner === 'pytest') return pytestLimit(names, read);
  const source = TEST_RUNNERS[runner]?.collection;
  if (!source) return null;
  const files = [];
  for (const pattern of source.names) files.push(...names.filter((name) => pattern.test(name)));
  const unread = names.filter((name) => source.unreadable?.test(name));
  const predicates = [];
  let ownPlace = false;
  const consider = (name, text) => {
    const options = literalOptions(text, source);
    if (options.unread) { unread.push(name); return; }
    const predicate = accepts(runner, options.values);
    if (predicate) predicates.push(predicate);
    else if (Object.keys(options.values).length) unread.push(name);
    if (options.values.spec) ownPlace = true;
  };
  // Vitest takes vitest.config over vite.config: only the first one found applies.
  for (const name of source.first ? files.slice(0, 1) : files) {
    const text = read(name);
    if (text != null) consider(name, text);
  }
  if (source.packageKey && names.includes('package.json')) {
    let value = null;
    try { value = JSON.parse(read('package.json') ?? 'null')?.[source.packageKey] ?? null; } catch { /* unreadable: nothing here says it limits */ }
    if (value) consider('package.json', `(${JSON.stringify(value)})`);
  }
  if (!predicates.length && !unread.length) return null;
  return { accepts: predicates.length ? (file) => predicates.every((predicate) => predicate(file)) : null, unread, ownPlace };
}

/** The names `collectionLimit` would read for a runner among a folder's file names, so a caller reads only those. */
export function collectionConfigNames(runner, names) {
  if (runner === 'pytest') return TEST_RUNNERS.pytest.collection.sections.map(([name]) => name).filter((name) => names.includes(name));
  const source = TEST_RUNNERS[runner]?.collection;
  if (!source) return [];
  return names.filter((name) => source.names.some((pattern) => pattern.test(name)) || (source.packageKey && name === 'package.json'));
}
