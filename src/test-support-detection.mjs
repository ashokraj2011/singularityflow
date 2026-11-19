/**
 * Test support outside a test folder, by evidence, never by name [owner, 2026-11-19, C3, page objects]. On a real Story,
 * `pages/QuestionnairePage.ts` and its interface sat outside any test folder and became a person's question, which no row
 * could take. `src/pages/HomePage.tsx` in a React or Next.js app is product code, so a name proves nothing. Two signals do:
 *
 *   test-root     the repository's own test configuration, read at the Story's base (Playwright's testDir, Cypress's
 *                 specPattern and support folder, WebdriverIO's specs, pytest's testpaths, or the folder holding a browser
 *                 runner's configuration), ignored when this Story changed that configuration [T2]
 *   test-content  the file imports a browser test library, every file that imports it is a test or such a file (at least one
 *                 does), no other file imports it, and the library is a devDependency of the nearest package.json, which this
 *                 Story did not change; an interface such a file imports, imported only by tests and such files, is one too [T3]
 *
 * Either one is settled with its evidence and an undo (out-of-plan-classes.mjs), never a silent reclassification: a
 * framework that loads files by convention (Next.js `pages/`) imports nothing, so a person can still undo it. The pure parts
 * take what files hold from the caller; `detectTestSupport` reads them.
 */
import path from 'node:path';

const LIBRARIES = Object.freeze(['@playwright/test', 'playwright', 'playwright-core', 'cypress', 'webdriverio', 'selenium-webdriver', 'puppeteer', 'protractor', 'testcafe']);
const PYTHON_LIBRARIES = /^(?:playwright(?:\.[\w.]+)?|selenium(?:\.[\w.]+)?)$/u;
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/u;
const PYTHON = /\.py$/u;
const JS_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/gu;
const PY_IMPORT = /^\s*(?:from\s+([\w.]+)\s+import\b|import\s+([\w.]+))/gmu;

/** The browser test library a module specifier names, or null (`@wdio/globals` is WebdriverIO's). */
export function libraryOf(spec) {
  const text = String(spec ?? '');
  if (text.startsWith('@wdio/')) return text;
  return LIBRARIES.find((library) => text === library || text.startsWith(`${library}/`)) ?? (PYTHON_LIBRARIES.test(text) ? text.split('.')[0] : null);
}

/** Each module a file imports, with its line: specifiers for a script, dotted names for Python. */
export function importsOf(file, text) {
  const found = [];
  const source = String(text ?? '');
  const lineAt = (index) => source.slice(0, index).split('\n').length;
  if (SCRIPT.test(file)) for (const match of source.matchAll(JS_IMPORT)) found.push({ spec: match[1], line: lineAt(match.index) });
  else if (PYTHON.test(file)) for (const match of source.matchAll(PY_IMPORT)) found.push({ spec: match[1] ?? match[2], line: lineAt(match.index) });
  return found;
}

const withoutExtension = (file) => file.replace(/\.(?:[cm]?[jt]sx?|py)$/u, '').replace(/\/index$/u, '');

/** Whether an import in `from` names `target`: a relative script path, or a dotted Python module ending at its path. */
export function importNames(from, spec, target) {
  if (SCRIPT.test(from) && /^\.\.?\//u.test(spec)) return withoutExtension(path.posix.normalize(path.posix.join(path.posix.dirname(from), spec))) === withoutExtension(target);
  if (PYTHON.test(from) && PYTHON.test(target) && !spec.startsWith('.')) {
    const module = withoutExtension(target).replaceAll('/', '.');
    return module === spec || module.endsWith(`.${spec}`);
  }
  return false;
}

/**
 * The files content shows are test support [T3]. `candidates` are changed files outside the plan; `texts` a Map of every file
 * that might import one (candidates included) to what it holds; `isTest(file)` whether a path is a test; `devDependency(file,
 * library)` `{ ok, words }` for the nearest package.json. Returns a Map of a file to `{ rule: 'test-content', evidence }`. Pure.
 */
export function contentTestSupport(candidates, { texts, isTest, devDependency = () => ({ ok: true, words: null }) }) {
  const imports = new Map([...texts].map(([file, text]) => [file, importsOf(file, text)]));
  const importers = new Map(candidates.map((file) => [file, [...texts.keys()].filter((other) => other !== file
    && (imports.get(other) ?? []).some((entry) => importNames(other, entry.spec, file)))]));
  const library = new Map();
  for (const file of candidates) {
    const named = (imports.get(file) ?? []).map((entry) => ({ ...entry, library: libraryOf(entry.spec) })).find((entry) => entry.library);
    if (!named) continue;
    const declared = PYTHON.test(file) ? { ok: true, words: null } : devDependency(file, named.library.startsWith('@wdio/') ? named.library : named.library.split('/').slice(0, named.library.startsWith('@') ? 2 : 1).join('/'));
    if (declared.ok) library.set(file, { ...named, declared: declared.words });
  }
  // The greatest set where each file is imported by at least one file, only by tests and members, and a file that imports no
  // library is imported by one that does.
  const kept = new Set(candidates.filter((file) => SCRIPT.test(file) || PYTHON.test(file)));
  for (let changed = true; changed;) {
    changed = false;
    for (const file of [...kept]) {
      const by = importers.get(file) ?? [];
      const fits = by.length > 0 && by.every((other) => isTest(other) || kept.has(other))
        && (library.has(file) || by.some((other) => kept.has(other) && library.has(other)));
      if (!fits) { kept.delete(file); changed = true; }
    }
  }
  const found = new Map();
  for (const file of kept) {
    const by = importers.get(file);
    const lib = library.get(file);
    const users = `${by.slice(0, 3).join(', ')}${by.length > 3 ? ` and ${by.length - 3} more` : ''}`;
    found.set(file, { rule: 'test-content', evidence: [
      lib ? { what: `it imports ${lib.library} (line ${lib.line})`, where: file }
        : { what: `it is used by ${by.filter((other) => library.has(other)).slice(0, 2).join(', ')}, which drives the browser in tests`, where: file },
      { what: `only tests and other test support use it: ${users}`, where: 'the files that import it' },
      { what: 'no application file imports it', where: 'the repository' },
      ...(lib?.declared ? [{ what: lib.declared, where: 'package.json' }] : [])] });
  }
  return found;
}

/** The nearest package.json above `file` that exists, as `read` finds it; null when none does. */
function nearestManifest(file, read) {
  for (let folder = path.posix.dirname(file); ; folder = path.posix.dirname(folder)) {
    const manifest = folder === '.' ? 'package.json' : `${folder}/package.json`;
    if (read(manifest) != null) return manifest;
    if (folder === '.' || folder === '/' || !folder) return null;
  }
}

/**
 * What the repository's own test configuration and the files' content say of `files` [T2, T3], read from this checkout and the
 * Story's base commit. Returns a Map of a file to `{ rule, evidence }`; empty on any doubt, which leaves the file a person's.
 */
export async function detectTestSupport(root, workflow, files) {
  const found = new Map();
  if (!files.length) return found;
  const [{ readFileSync }, git, { runnerTestRoots, isRunnerTestConfig }, { isTestAutomationPath }] = await Promise.all([import('node:fs'),
    import('./git.mjs'), import('./test-collection-limits.mjs'), import('./source-boundary.mjs')]);
  const now = (file) => { try { return readFileSync(path.join(root, ...file.split('/')), 'utf8'); } catch { return null; } };
  const base = workflow.workItem?.baseCommit ?? null;
  const atBase = (file) => { try { return base ? git.exactFileAtObject(root, base, file, { maximumBytes: 1024 * 1024 })?.toString('utf8') ?? null : null; } catch { return null; } };
  // T2: the folders the configuration at the Story's base names, unless this Story changed that configuration.
  const configs = base ? (git.exactTreePathsAtObject(root, base) ?? []).filter(isRunnerTestConfig) : [];
  const unchanged = configs.filter((config) => atBase(config) !== null && atBase(config) === now(config));
  const roots = runnerTestRoots(unchanged, atBase);
  for (const file of files) {
    const named = roots.find((entry) => file.startsWith(`${entry.root}/`));
    if (named) found.set(file, { rule: 'test-root', evidence: [{ what: named.words, where: named.config }, { what: `${file} is inside ${named.root}`, where: named.root }] });
  }
  // T3: content, and who imports it, among every file Git tracks or would add here.
  const candidates = files.filter((file) => !found.has(file) && (SCRIPT.test(file) || PYTHON.test(file)));
  if (!candidates.length) return found;
  const stems = [...new Set(candidates.map((file) => path.posix.basename(withoutExtension(file))).filter((stem) => stem.length >= 3))];
  const hits = git.trackedLinesContaining(root, stems, { untracked: true });
  if (!hits) return found;
  const texts = new Map();
  for (const file of new Set([...candidates, ...hits.map((hit) => hit.path)])) {
    const text = now(file);
    if (text != null) texts.set(file, text);
  }
  const devDependency = (file, library) => {
    const manifest = nearestManifest(file, now);
    if (!manifest) return { ok: false };
    if (atBase(manifest) !== now(manifest)) return { ok: false };
    let parsed = null;
    try { parsed = JSON.parse(now(manifest)); } catch { return { ok: false }; }
    const dev = Object.hasOwn(parsed?.devDependencies ?? {}, library);
    return dev && !Object.hasOwn(parsed?.dependencies ?? {}, library) ? { ok: true, words: `${library} is a devDependency of ${manifest}, unchanged by this Story` } : { ok: false };
  };
  for (const [file, entry] of contentTestSupport(candidates, { texts, isTest: (file) => isTestAutomationPath(file), devDependency })) found.set(file, entry);
  return found;
}
