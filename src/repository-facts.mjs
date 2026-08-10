/**
 * Repository facts, computed rather than described.
 *
 * The generated world model's `Facts` blocks were its most valuable content and its least reliable:
 * on the calc POC they were 7% of the markdown and carried every path, line number and command the
 * reading agent would act on — and a model wrote them, so any of them could be quietly wrong, and
 * nothing checked. Meanwhile the remaining 92% was prose a parser could never produce and a reader
 * could rarely falsify.
 *
 * So the split is: everything derivable is derived here, exactly, and cited; and the model is left
 * with the judgement it is actually for. Every field below is something you could verify by opening
 * the repository, which is the property that makes it worth putting in front of an agent.
 *
 * **Deliberately dependency-free.** This package ships one runtime dependency (`yaml`), and a real
 * parser is not worth changing that for. The symbol extractor below is lexical: it finds top-level
 * declarations that are exported, which is the shape almost all real code has, and it says nothing
 * at all about files it cannot read confidently. `unindexed` is part of the output for that reason —
 * a fact set that quietly omitted half a repository would be worse than one that admits the gap.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mapLimit, posix, run } from './util.mjs';

const READ_CONCURRENCY = 12;
/** Beyond this a file is almost certainly generated or vendored; scanning it buys nothing. */
const MAX_SCAN_BYTES = 512 * 1024;

const JS_LIKE = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

/**
 * Frameworks worth naming, recognised from declared dependencies.
 *
 * Detection by dependency name rather than by reading code: it is exact, it costs nothing, and it
 * is the same signal a human would use. There was no framework detection anywhere before this.
 */
const FRAMEWORK_SIGNALS = new Map([
  ['react', 'React'], ['next', 'Next.js'], ['vue', 'Vue'], ['nuxt', 'Nuxt'],
  ['@angular/core', 'Angular'], ['svelte', 'Svelte'], ['express', 'Express'],
  ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'], ['koa', 'Koa'],
  ['vite', 'Vite'], ['webpack', 'webpack'], ['rollup', 'Rollup'], ['esbuild', 'esbuild'],
  ['jest', 'Jest'], ['vitest', 'Vitest'], ['mocha', 'Mocha'], ['@playwright/test', 'Playwright'],
  ['cypress', 'Cypress'], ['typescript', 'TypeScript'], ['electron', 'Electron'],
  ['tailwindcss', 'Tailwind CSS'], ['prisma', 'Prisma'], ['mongoose', 'Mongoose']
]);

/** Manifests that identify a build system, and how to read what they declare. */
const MANIFEST_READERS = new Map([
  ['package.json', readNodeManifest],
  ['go.mod', readGoManifest],
  ['pyproject.toml', readPyprojectManifest],
  ['requirements.txt', readRequirementsManifest],
  ['pom.xml', readPomManifest],
  ['cargo.toml', readCargoManifest]
]);

function line(text, index) {
  // 1-indexed, because that is what an editor and a citation both mean by "line".
  return text.slice(0, index).split('\n').length;
}

async function readNodeManifest(text, relative) {
  const parsed = JSON.parse(text);
  const lines = text.split('\n');
  const lineOf = (key) => {
    const at = lines.findIndex((value) => value.trimStart().startsWith(`"${key}"`));
    return at < 0 ? null : at + 1;
  };
  const seen = new Set();
  const entries = [];
  for (const field of ['main', 'module', 'exports', 'bin']) {
    if (parsed[field] === undefined) continue;
    // These are the repository's own declaration of where it starts, and they were parsed and
    // thrown away: light mode read package.json only for `name`, `scripts` and dependency keys.
    const value = parsed[field];
    const targets = typeof value === 'string' ? [value]
      : (value && typeof value === 'object') ? Object.values(value).filter((item) => typeof item === 'string')
        : [];
    for (const target of targets) {
      const resolved = posix(path.join(path.dirname(relative), target));
      // `bin` commonly maps several command names onto one file; that is one entry point, not four.
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      entries.push({ field, path: resolved, declaredAt: `${relative}:${lineOf(field) ?? '?'}` });
    }
  }
  return {
    kind: 'node',
    path: relative,
    name: typeof parsed.name === 'string' ? parsed.name : null,
    workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : (parsed.workspaces?.packages ?? []),
    entries,
    commands: Object.entries(parsed.scripts ?? {}).map(([script, body]) => ({
      // Cited to the script's own line, not to the `scripts` key. A citation every command shares
      // is not a citation.
      command: `npm run ${script}`, runs: String(body), declaredAt: `${relative}:${lineOf(script) ?? lineOf('scripts') ?? '?'}`
    })),
    dependencies: [...new Set([
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {})
    ])].sort()
  };
}

async function readGoManifest(text, relative) {
  const module = text.match(/^module\s+(\S+)/m);
  const goVersion = text.match(/^go\s+(\S+)/m);
  const requires = [...text.matchAll(/^\s*([\w./-]+)\s+v\S+/gm)].map((match) => match[1]);
  return { kind: 'go', path: relative, name: module?.[1] ?? null, toolchain: goVersion?.[1] ?? null, dependencies: [...new Set(requires)].sort(), entries: [], commands: [], workspaces: [] };
}

async function readPyprojectManifest(text, relative) {
  const name = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  const deps = [...text.matchAll(/^\s*["']([A-Za-z0-9][\w.-]*)\s*[><=~!]/gm)].map((match) => match[1]);
  return { kind: 'python', path: relative, name: name?.[1] ?? null, dependencies: [...new Set(deps)].sort(), entries: [], commands: [], workspaces: [] };
}

async function readRequirementsManifest(text, relative) {
  const deps = text.split('\n')
    .map((row) => row.trim())
    .filter((row) => row && !row.startsWith('#') && !row.startsWith('-'))
    .map((row) => row.split(/[><=~!\[;]/)[0].trim())
    .filter(Boolean);
  return { kind: 'python', path: relative, name: null, dependencies: [...new Set(deps)].sort(), entries: [], commands: [], workspaces: [] };
}

async function readPomManifest(text, relative) {
  const artifact = text.match(/<artifactId>([^<]+)<\/artifactId>/);
  const deps = [...text.matchAll(/<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/g)].map((match) => match[1]);
  return { kind: 'maven', path: relative, name: artifact?.[1] ?? null, dependencies: [...new Set(deps)].sort(), entries: [], commands: [], workspaces: [] };
}

async function readCargoManifest(text, relative) {
  const name = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  const section = text.split(/^\[dependencies\]/m)[1] ?? '';
  const deps = [...section.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((match) => match[1]);
  return { kind: 'rust', path: relative, name: name?.[1] ?? null, dependencies: [...new Set(deps)].sort(), entries: [], commands: [], workspaces: [] };
}

/**
 * Top-level exported declarations, with the line they are on.
 *
 * Lexical, and honest about it. It matches an `export` at column zero followed by a declaration
 * keyword, which is what nearly all real modules look like, and it does not attempt to understand
 * re-exports, conditional definitions, decorators or anything nested. A file it cannot scan is
 * reported as unindexed rather than reported as empty — the distinction matters, because "this
 * module exports nothing" is a claim and "I did not read this module" is not.
 */
export function extractSymbols(text, relative) {
  const symbols = [];
  const declaration = /^export\s+(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of text.matchAll(declaration)) {
    const [, keyword, name] = match;
    symbols.push({
      name,
      kind: keyword.startsWith('function') ? 'function' : keyword === 'class' ? 'class' : 'binding',
      at: `${relative}:${line(text, match.index)}`
    });
  }
  return symbols;
}

/** `import`/`export … from` and `require()` targets, resolved only far enough to be a graph edge. */
export function extractImports(text) {
  const targets = [];
  for (const match of text.matchAll(/^\s*(?:import|export)[\s\S]{0,200}?from\s*['"]([^'"]+)['"]/gm)) targets.push(match[1]);
  for (const match of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) targets.push(match[1]);
  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) targets.push(match[1]);
  return [...new Set(targets)];
}

function resolveLocal(from, target, known) {
  if (!target.startsWith('.')) return null;
  const base = posix(path.join(path.dirname(from), target));
  const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].flatMap((extension) => [
    `${base}${extension}`, posix(path.join(base, `index${extension}`))
  ])];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

/**
 * Per-file churn, from Git rather than impression.
 *
 * "Hotspot" was previously a model's opinion. How often a file has actually changed is a fact, and
 * the regression analyser already parses this shape of output for its own purposes.
 */
export function fileChurn(root, { since = '12 months ago', limit = 4000 } = {}) {
  const log = run('git', ['log', `--since=${since}`, `--max-count=${limit}`, '--name-only', '--format=%H'], { cwd: root, allowFailure: true });
  if (log.status !== 0) return new Map();
  const counts = new Map();
  for (const row of log.stdout.split('\n')) {
    const file = row.trim();
    if (!file || /^[0-9a-f]{40}$/.test(file)) continue;
    counts.set(posix(file), (counts.get(posix(file)) ?? 0) + 1);
  }
  return counts;
}

const TEST_FILE = /(^|\/)(__tests__|tests?|specs?)\//i;
const TEST_NAME = /[._-](test|spec)\.[^/]+$/i;

/**
 * The injectable rendering: a page of facts, not a database.
 *
 * The full fact set for this repository is around 200 KB — larger than the entire generated world
 * model it is meant to improve on — because it holds every symbol and every import edge. That is
 * the right thing to keep on disk for tooling and the wrong thing to put in a prompt. What an agent
 * needs is the shape: where the repository starts, what it is built with, how to validate it, and
 * which few files everything else depends on.
 *
 * Everything here carries a path or a `path:line`, so any line of it can be checked in seconds.
 */
export function renderFactsDigest(facts, { symbolLimit = 40 } = {}) {
  const rows = [];
  const list = (values) => (values.length ? values.join(', ') : 'none identified');

  rows.push('```yaml');
  rows.push('# Derived from the repository, not inferred. Every path and line is checkable.');
  rows.push(`files: ${facts.counts.files}`);
  rows.push(`languages_scanned: ${facts.counts.scanned}`);
  if (facts.counts.unindexed) rows.push(`not_indexed: ${facts.counts.unindexed}   # too large or unreadable; no claim is made about these`);
  rows.push(`frameworks: [${list(facts.frameworks)}]`);

  if (facts.entryPoints.length) {
    rows.push('entrypoints:');
    for (const entry of facts.entryPoints.slice(0, 8)) rows.push(`  - { path: ${entry.path}, declared: ${entry.field}, at: "${entry.declaredAt}" }`);
  }
  if (facts.commands.length) {
    rows.push('commands:');
    for (const command of facts.commands.slice(0, 12)) rows.push(`  - { run: "${command.command}", at: "${command.declaredAt}" }`);
  }
  if (facts.mostImported.length) {
    rows.push('# What the rest of the repository depends on. A count, not an impression.');
    rows.push('most_depended_on:');
    for (const entry of facts.mostImported.slice(0, 8)) rows.push(`  - { path: ${entry.path}, imported_by: ${entry.importedBy} }`);
  }
  if (facts.mostChanged.length) {
    rows.push('# Commits touching each file in the last year, from Git history.');
    rows.push('most_changed:');
    for (const entry of facts.mostChanged.slice(0, 8)) rows.push(`  - { path: ${entry.path}, commits: ${entry.commits} }`);
  }
  if (facts.symbols.length) {
    rows.push(`# ${facts.counts.symbols} exported top-level declarations; the most-depended-on files' are listed.`);
    rows.push('key_symbols:');
    const priority = new Set(facts.mostImported.slice(0, 6).map((entry) => entry.path));
    const chosen = facts.symbols.filter((symbol) => priority.has(symbol.at.split(':')[0])).slice(0, symbolLimit);
    for (const symbol of chosen) rows.push(`  - { name: ${symbol.name}, kind: ${symbol.kind}, at: "${symbol.at}" }`);
  }
  rows.push(`tests: ${facts.counts.tests}`);
  rows.push('```');
  return rows.join('\n');
}

/**
 * Compute everything about a repository that does not require judgement.
 *
 * `sourceState` is the snapshot `worldModelSourceSnapshot` already produces — the tracked files with
 * their sizes and hashes — so this adds no extra tree walk to a build that already does four.
 */
export async function deriveRepositoryFacts(root, sourceState, { churn = true } = {}) {
  const files = (sourceState.files ?? []).filter((file) => file.status !== 'deleted');
  const known = new Set(files.map((file) => file.path));

  const manifests = [];
  for (const file of files) {
    const reader = MANIFEST_READERS.get(path.basename(file.path).toLowerCase());
    if (!reader) continue;
    try {
      manifests.push(await reader(await readFile(path.join(root, file.path), 'utf8'), file.path));
    } catch {
      // A manifest that will not parse is still evidence the build system exists; it is listed
      // without its contents rather than guessed at.
      manifests.push({ kind: 'unreadable', path: file.path, name: null, dependencies: [], entries: [], commands: [], workspaces: [] });
    }
  }

  const dependencies = [...new Set(manifests.flatMap((manifest) => manifest.dependencies))];
  const frameworks = [...new Set(dependencies.map((name) => FRAMEWORK_SIGNALS.get(name)).filter(Boolean))].sort();

  const scannable = files.filter((file) => JS_LIKE.has(path.extname(file.path)) && file.size <= MAX_SCAN_BYTES);
  const unindexed = files
    .filter((file) => !scannable.includes(file) && JS_LIKE.has(path.extname(file.path)))
    .map((file) => file.path);

  const scanned = await mapLimit(scannable, READ_CONCURRENCY, async (file) => {
    try {
      const text = await readFile(path.join(root, file.path), 'utf8');
      return { path: file.path, symbols: extractSymbols(text, file.path), imports: extractImports(text) };
    } catch {
      return { path: file.path, unreadable: true, symbols: [], imports: [] };
    }
  });

  const edges = [];
  const importedBy = new Map();
  for (const entry of scanned) {
    for (const target of entry.imports) {
      const resolved = resolveLocal(entry.path, target, known);
      if (!resolved) continue;
      edges.push({ from: entry.path, to: resolved });
      importedBy.set(resolved, (importedBy.get(resolved) ?? 0) + 1);
    }
  }

  const tests = files.filter((file) => TEST_FILE.test(file.path) || TEST_NAME.test(file.path)).map((file) => file.path);
  const churnCounts = churn ? fileChurn(root) : new Map();

  return {
    schemaVersion: 1,
    // Everything below is checkable against the repository at this commit; nothing is inferred.
    counts: {
      files: files.length,
      scanned: scanned.length,
      unindexed: unindexed.length + scanned.filter((entry) => entry.unreadable).length,
      symbols: scanned.reduce((total, entry) => total + entry.symbols.length, 0),
      edges: edges.length,
      tests: tests.length
    },
    manifests: manifests.map(({ dependencies: _ignored, ...rest }) => rest),
    frameworks,
    entryPoints: manifests.flatMap((manifest) => manifest.entries).filter((entry) => known.has(entry.path)),
    commands: manifests.flatMap((manifest) => manifest.commands),
    // Sorted by file, then by line *numerically* — a string sort puts line 585 before line 70,
    // which reads as though the extractor found them out of order.
    symbols: scanned.flatMap((entry) => entry.symbols).sort((a, b) => {
      const [fileA, lineA] = a.at.split(':');
      const [fileB, lineB] = b.at.split(':');
      return fileA.localeCompare(fileB) || Number(lineA) - Number(lineB);
    }),
    imports: edges,
    // Most-imported first: a fact, where "hotspot" used to be a guess.
    mostImported: [...importedBy.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([file, count]) => ({ path: file, importedBy: count })),
    mostChanged: [...churnCounts.entries()]
      .filter(([file]) => known.has(file))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([file, commits]) => ({ path: file, commits })),
    tests,
    // Named, so a reader can tell "nothing here" from "not looked at".
    unindexed: [...unindexed, ...scanned.filter((entry) => entry.unreadable).map((entry) => entry.path)].sort()
  };
}
