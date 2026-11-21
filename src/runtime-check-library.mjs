/**
 * The runtime check of a library (step intents spec §12.3): its public API compared with the base branch, with
 * nothing run. For a JavaScript or TypeScript package SFlow reads what its entry file exports (and the files it
 * re-exports, one level), at the base and now; for Java, the public classes and methods of each changed file.
 * What becomes a finding: an export or public method that is gone, or an exported function that now needs more
 * arguments (breaks use: an undeclared breaking change), unless the package's major version went up (advice then,
 * since the change is declared).
 */
import path from 'node:path';

const JS_ENTRY_CANDIDATES = Object.freeze(['src/index.ts', 'src/index.mts', 'src/index.js', 'src/index.mjs', 'index.ts', 'index.mjs', 'index.js', 'lib/index.js']);

/** The entry file a package's manifest names (exports, module, main, types), or the usual index file. */
export function packageEntry(manifest, exists) {
  const exported = manifest?.exports;
  const dot = typeof exported === 'string' ? exported : exported?.['.'] ?? null;
  const fromExports = typeof dot === 'string' ? dot : dot?.import ?? dot?.default ?? dot?.require ?? null;
  const named = [typeof fromExports === 'string' ? fromExports : null, manifest?.module, manifest?.main, manifest?.types, manifest?.typings]
    .filter((entry) => typeof entry === 'string').map((entry) => path.posix.normalize(entry.replace(/^\.\//u, '')));
  // A built entry (dist/) is not committed: its source, when there is one, is what changes.
  for (const entry of named) {
    if (exists(entry)) return entry;
    const source = entry.replace(/^(?:dist|build|lib|out)\//u, 'src/').replace(/\.d\.ts$|\.c?js$|\.mjs$/u, '');
    for (const extension of ['.ts', '.mts', '.tsx', '.js', '.mjs']) if (exists(`${source}${extension}`)) return `${source}${extension}`;
  }
  return JS_ENTRY_CANDIDATES.find(exists) ?? null;
}

/** A JavaScript or TypeScript file's exports: `Map(name → { kind, required })`, and the files it re-exports. */
export function jsExports(text) {
  const exports = new Map();
  const from = [];
  const source = String(text ?? '').replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/[^\n]*/gu, '$1');
  const required = (parameters) => parameters.split(',').map((part) => part.trim()).filter(Boolean)
    .filter((part) => !part.includes('=') && !part.startsWith('...') && !/^\w+\?\s*:/u.test(part)).length;
  for (const match of source.matchAll(/\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/gu)) exports.set(match[1], { kind: 'function', required: required(match[2]) });
  for (const match of source.matchAll(/\bexport\s+(?:declare\s+)?(?:abstract\s+)?(class|const|let|var|interface|type|enum|namespace)\s+(\w+)/gu)) if (!exports.has(match[2])) exports.set(match[2], { kind: match[1] });
  for (const match of source.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/gu)) {
    for (const part of match[1].split(',').map((entry) => entry.trim()).filter(Boolean)) {
      const name = part.split(/\s+as\s+/u).pop().replace(/^type\s+/u, '').trim();
      if (name && !exports.has(name)) exports.set(name, { kind: 'name' });
    }
  }
  if (/\bexport\s+default\b/u.test(source) && !exports.has('default')) exports.set('default', { kind: 'default' });
  for (const match of source.matchAll(/\bexport\s+\*\s+(?:as\s+(\w+)\s+)?from\s*['"]([^'"]+)['"]/gu)) {
    if (match[1]) exports.set(match[1], { kind: 'namespace' });
    else from.push(match[2]);
  }
  return { exports, from };
}

/** A Java file's public types and methods: a set of signatures like `Orders#add(Order,int)`. */
export function javaPublicApi(text) {
  const source = String(text ?? '').replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
  const type = /\bpublic\s+(?:final\s+|abstract\s+|sealed\s+)*(?:class|interface|enum|record)\s+(\w+)/u.exec(source)?.[1] ?? null;
  const api = new Set(type ? [type] : []);
  for (const match of source.matchAll(/\bpublic\s+(?:static\s+|final\s+|abstract\s+|synchronized\s+|default\s+)*(?:<[^>]+>\s+)?[\w<>[\],.? ]+?\s+(\w+)\s*\(([^)]*)\)/gu)) {
    const parameters = match[2].split(',').map((part) => part.trim().replace(/\s+\w+$/u, '').replace(/^final\s+/u, '').replace(/\s+/gu, '')).filter(Boolean);
    api.add(`${type ?? '?'}#${match[1]}(${parameters.join(',')})`);
  }
  return api;
}

const major = (version) => Number(/^\D*(\d+)/u.exec(String(version ?? ''))?.[1] ?? NaN);

/**
 * The public-API differences between `base` and `head`, each `{ files: Map(path → text), manifest }`, for a package at
 * `folder`. Returns `{ ran, findings, compared }`.
 */
export function publicApiChanges({ base, head, folder = '', changedPaths = [] }) {
  const ran = [];
  const findings = [];
  const declared = Number.isFinite(major(head.manifest?.version)) && Number.isFinite(major(base.manifest?.version)) && major(head.manifest.version) > major(base.manifest.version);
  const verdict = declared ? 'improvement' : 'breaks-use';
  const within = (file) => path.posix.join(folder, file);
  const exists = (files) => (file) => files.has(within(file));
  const entry = head.manifest || base.manifest ? packageEntry(head.manifest ?? base.manifest, exists(head.files)) ?? packageEntry(base.manifest ?? head.manifest, exists(base.files)) : null;
  const compared = [];
  if (entry) {
    const collect = (files) => {
      const all = new Map();
      const first = jsExports(files.get(within(entry)));
      for (const [name, value] of first.exports) all.set(name, value);
      for (const relative of first.from.filter((target) => target.startsWith('.')).slice(0, 20)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry), relative)).replace(/\.js$/u, '');
        const text = ['', '.ts', '.mts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js'].map((extension) => files.get(within(`${target}${extension}`))).find((value) => value != null);
        for (const [name, value] of jsExports(text).exports) if (name !== 'default' && !all.has(name)) all.set(name, value);
      }
      return all;
    };
    const before = collect(base.files);
    const after = collect(head.files);
    ran.push(`compared the exports of ${within(entry)} with the base`);
    compared.push(within(entry));
    for (const [name, value] of before) {
      const now = after.get(name);
      if (!now) findings.push({ type: 'export-removed', class: verdict, title: `${name} is no longer exported`,
        detail: `${within(entry)} exported ${name} (${value.kind}) at the base and does not now.${declared ? ` The major version went up (${base.manifest.version} → ${head.manifest.version}), so the change is declared.` : ' Callers that import it break.'}`,
        evidence: { name, kind: value.kind, entry: within(entry) } });
      else if (value.kind === 'function' && now.kind === 'function' && now.required > value.required) findings.push({ type: 'export-needs-more-arguments', class: verdict,
        title: `${name} now needs ${now.required} argument${now.required === 1 ? '' : 's'} (it needed ${value.required})`,
        detail: `Callers that pass ${value.required} break${declared ? '; the major version went up, so the change is declared' : ''}.`, evidence: { name, before: value.required, after: now.required } });
    }
  }
  for (const file of changedPaths.filter((entry) => entry.endsWith('.java') && /(?:^|\/)src\/main\//u.test(entry)).slice(0, 50)) {
    if (!base.files.has(file)) continue;
    const before = javaPublicApi(base.files.get(file));
    const after = javaPublicApi(head.files.get(file) ?? '');
    compared.push(file);
    for (const signature of before) {
      if (after.has(signature)) continue;
      findings.push({ type: 'public-method-removed', class: verdict, title: `${signature.replace('#', '.')} is no longer public API`,
        detail: `${file} had it at the base and does not now${declared ? '; the major version went up, so the change is declared' : ': callers break'}.`, evidence: { file, signature } });
    }
  }
  if (compared.some((file) => file.endsWith('.java'))) ran.push('compared the public classes and methods of the changed Java files with the base');
  return { ran, findings, compared };
}
