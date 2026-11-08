/**
 * Which dependencies this Story added or changed [CQF:REQ-050]: what makes a dependency audit's
 * finding new code. Each manifest and lockfile the Story's change set touches is read at the Story's
 * base (as its changed lines are, src/findings/changed-lines.mjs) and in the working tree; a package
 * is new when its name or its installed version at the head is not at the base, or, where no lockfile
 * names its version, when its declared range changed. A manifest the base did not have makes every
 * package in it new.
 *
 * An audit runs only when the Story changed a manifest or lockfile the tool reads: with none changed,
 * there is no new dependency to audit. Names are compared as each ecosystem compares them (PyPI's
 * `-`, `_` and `.` alike, case aside); a package of the same name in two ecosystems reads as one,
 * which can only make a finding new, never hide one.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { exactFileAtObject } from '../git.mjs';
import { storyChangeBase } from './changed-lines.mjs';

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const NPM = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'];
const PNPM = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const PYTHON = ['pyproject.toml', 'poetry.lock', 'Pipfile', 'Pipfile.lock', 'uv.lock', 'setup.py', 'setup.cfg', 'pdm.lock'];
const OTHER = ['yarn.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'gradle.lockfile', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
  'Gemfile', 'Gemfile.lock', 'composer.json', 'composer.lock', 'packages.lock.json', 'Directory.Packages.props'];
const REQUIREMENTS = /^(?:.*[-_])?requirements(?:[-_.][\w.-]+)?\.(?:txt|in)$/iu;

/** The manifests and lockfiles each audit reads, by file name. */
export const AUDIT_MANIFESTS = Object.freeze({
  'npm-audit': Object.freeze(NPM),
  'pnpm-audit': Object.freeze(PNPM),
  'pip-audit': Object.freeze(PYTHON),
  'osv-scanner': Object.freeze([...new Set([...NPM, ...PNPM, ...PYTHON, ...OTHER])]),
  'dependency-check': Object.freeze([...new Set([...NPM, ...PNPM, ...PYTHON, ...OTHER])])
});

/** Whether `relative` is a manifest or lockfile the audit read through `adapter` reads. */
export function auditsManifest(adapter, relative) {
  const name = path.posix.basename(String(relative ?? ''));
  if (REQUIREMENTS.test(name)) return ['pip-audit', 'osv-scanner', 'dependency-check'].includes(adapter);
  return (AUDIT_MANIFESTS[adapter] ?? []).includes(name);
}

/** A package's name as its ecosystem compares it. */
export function dependencyKey(name) {
  return String(name ?? '').trim().toLowerCase().replace(/[-_.]+/gu, '-');
}

function add(inventory, name, { version = null, spec = null } = {}) {
  if (!name || typeof name !== 'string') return;
  const key = dependencyKey(name);
  if (!key) return;
  const entry = inventory.get(key) ?? { versions: new Set(), specs: new Set() };
  if (version != null && version !== '') entry.versions.add(String(version).replace(/^[=v]+/u, ''));
  if (spec != null && spec !== '') entry.specs.add(String(spec).trim());
  inventory.set(key, entry);
}

const json = (text) => { try { return JSON.parse(text); } catch { return null; } };

/** A name@version key of a lockfile (`/name/1.2.3`, `/name@1.2.3(peer)`, `@scope/name@1.2.3`) → its parts. */
function pnpmPackage(key, legacy) {
  const bare = String(key).replace(/^\//u, '').replace(/\(.*$/u, '');
  if (legacy) {
    const cut = bare.lastIndexOf('/');
    return cut > 0 ? { name: bare.slice(0, cut), version: bare.slice(cut + 1) } : null;
  }
  const cut = bare.lastIndexOf('@');
  return cut > 0 ? { name: bare.slice(0, cut), version: bare.slice(cut + 1) } : null;
}

const PARSERS = [
  [/^package\.json$/u, (text, inventory) => {
    const manifest = json(text) ?? {};
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) add(inventory, name, { spec });
    }
  }],
  [/^(?:package-lock|npm-shrinkwrap)\.json$/u, (text, inventory) => {
    const lock = json(text) ?? {};
    for (const [where, entry] of Object.entries(lock.packages ?? {})) {
      // The root and a workspace's own folder are the project, not a dependency of it.
      const at = where.lastIndexOf('node_modules/');
      if (at < 0 || entry?.link) continue;
      add(inventory, where.slice(at + 'node_modules/'.length), { version: entry?.version });
    }
    const walk = (dependencies) => {
      for (const [name, entry] of Object.entries(dependencies ?? {})) { add(inventory, name, { version: entry?.version }); walk(entry?.dependencies); }
    };
    walk(lock.dependencies);
  }],
  [/^pnpm-lock\.yaml$/u, (text, inventory) => {
    let lock;
    try { lock = YAML.parse(text, { maxAliasCount: 100 }) ?? {}; } catch { return; }
    const legacy = /^5/u.test(String(lock.lockfileVersion ?? ''));
    for (const key of [...Object.keys(lock.packages ?? {}), ...Object.keys(lock.snapshots ?? {})]) {
      const found = pnpmPackage(key, legacy);
      if (found) add(inventory, found.name, { version: found.version });
    }
    for (const importer of Object.values(lock.importers ?? { '.': lock })) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, entry] of Object.entries(importer?.[field] ?? {})) {
          add(inventory, name, typeof entry === 'object' ? { spec: entry?.specifier, version: String(entry?.version ?? '').replace(/\(.*$/u, '') } : { version: entry });
        }
      }
    }
  }],
  [/^yarn\.lock$/u, (text, inventory) => {
    let names = [];
    for (const line of text.split(/\r?\n/u)) {
      if (/^\S.*:\s*$/u.test(line) && !line.startsWith('#')) {
        names = line.replace(/:\s*$/u, '').split(/,\s*/u).map((selector) => selector.replace(/^"|"$/gu, ''))
          .map((selector) => selector.slice(0, Math.max(selector.indexOf('@', 1), 0) || selector.length)).filter(Boolean);
      } else {
        const version = /^\s+version:?\s+"?([^"\s]+)"?/u.exec(line)?.[1];
        if (version) for (const name of new Set(names)) add(inventory, name, { version });
      }
    }
  }],
  [REQUIREMENTS, (text, inventory) => {
    for (const raw of text.split(/\r?\n/u)) {
      const line = raw.replace(/\s+#.*$/u, '').trim();
      if (!line || line.startsWith('#') || line.startsWith('-')) continue;
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(.*)$/u.exec(line);
      if (!match) continue;
      const spec = match[2].split(';')[0].trim();
      add(inventory, match[1], { spec, version: /^===?\s*([^\s,;]+)$/u.exec(spec)?.[1] ?? null });
    }
  }],
  [/^pyproject\.toml$/u, (text, inventory) => {
    // PEP 621's dependency arrays and dependency groups, and Poetry's dependency tables: enough of TOML for these.
    let table = '';
    let array = null;
    const requirement = (item) => {
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*([^;]*)/u.exec(item.trim());
      if (match) add(inventory, match[1], { spec: match[2].trim() });
    };
    for (const line of text.split(/\r?\n/u)) {
      if (array != null) {
        array += line;
        if (!line.includes(']')) continue;
      } else {
        const header = /^\s*\[([^\]]+)\]\s*$/u.exec(line)?.[1];
        if (header) { table = header.trim(); continue; }
        const key = /^\s*([\w-]+)\s*=\s*(.*)$/u.exec(line);
        if (!key) continue;
        const lists = (key[1] === 'dependencies' && table === 'project') || ['project.optional-dependencies', 'dependency-groups'].includes(table);
        if (lists && key[2].startsWith('[')) {
          array = key[2];
          if (!key[2].includes(']')) continue;
        } else {
          if (/^tool\.poetry\.(?:(?:group\.[\w-]+\.)?dependencies|dev-dependencies)$/u.test(table) && key[1] !== 'python') {
            const value = key[2].trim();
            add(inventory, key[1], { spec: value.startsWith('{') ? /version\s*=\s*["']([^"']+)["']/u.exec(value)?.[1] ?? null : value.replace(/^["']|["']$/gu, '') });
          }
          continue;
        }
      }
      for (const item of array.matchAll(/["']([^"']+)["']/gu)) requirement(item[1]);
      array = null;
    }
  }],
  [/^(?:poetry|uv|pdm|Cargo)\.lock$/u, (text, inventory) => {
    for (const block of text.split(/^\[\[package\]\]\s*$/mu).slice(1)) {
      const name = /^name\s*=\s*"([^"]+)"/mu.exec(block)?.[1];
      const version = /^version\s*=\s*"([^"]+)"/mu.exec(block)?.[1];
      add(inventory, name, { version });
    }
  }],
  [/^Pipfile\.lock$/u, (text, inventory) => {
    const lock = json(text) ?? {};
    for (const section of ['default', 'develop']) for (const [name, entry] of Object.entries(lock[section] ?? {})) add(inventory, name, { version: String(entry?.version ?? '').replace(/^==/u, '') });
  }],
  [/^pom\.xml$/u, (text, inventory) => {
    for (const block of text.matchAll(/<(dependency|plugin)>([\s\S]*?)<\/\1>/gu)) {
      const field = (name) => new RegExp(`<${name}>\\s*([^<\\s]+)\\s*</${name}>`, 'u').exec(block[2])?.[1] ?? null;
      const [group, artifact, version] = [field('groupId'), field('artifactId'), field('version')];
      if (artifact) add(inventory, `${group ?? ''}:${artifact}`, { version: version && !version.includes('${') ? version : null, spec: version });
    }
  }],
  [/^(?:build\.gradle(?:\.kts)?|gradle\.lockfile)$/u, (text, inventory) => {
    for (const match of text.matchAll(/["']?([\w.-]+):([\w.-]+):([\w.+-]+)["']?/gu)) add(inventory, `${match[1]}:${match[2]}`, { version: match[3] });
  }],
  [/^go\.mod$/u, (text, inventory) => {
    for (const match of text.matchAll(/^\s*(?:require\s+)?([\w.-]+\/[\w./-]+)\s+(v[\w.+-]+)/gmu)) add(inventory, match[1], { version: match[2] });
  }],
  [/^Gemfile\.lock$/u, (text, inventory) => {
    for (const match of text.matchAll(/^ {4}([A-Za-z0-9][\w.-]*) \(([^)\s]+)\)$/gmu)) add(inventory, match[1], { version: match[2] });
  }],
  [/^composer\.lock$/u, (text, inventory) => {
    const lock = json(text) ?? {};
    for (const entry of [...(lock.packages ?? []), ...(lock['packages-dev'] ?? [])]) add(inventory, entry?.name, { version: entry?.version });
  }]
];

/** Every package a manifest or lockfile's text names, with its versions and declared ranges. */
export function manifestInventory(relative, text, inventory = new Map()) {
  const name = path.posix.basename(String(relative ?? ''));
  const parser = PARSERS.find(([pattern]) => pattern.test(name))?.[1];
  if (parser && typeof text === 'string') parser(text, inventory);
  return inventory;
}

function workingText(root, relative) {
  try {
    const absolute = path.join(root, ...relative.split('/'));
    return statSync(absolute).size <= MAX_MANIFEST_BYTES ? readFileSync(absolute, 'utf8') : null;
  } catch { return null; }
}

function baseText(root, base, relative) {
  try { return exactFileAtObject(root, base, relative, { maximumBytes: MAX_MANIFEST_BYTES })?.toString('utf8') ?? null; } catch { return null; }
}

/**
 * The manifests and lockfiles this Story changed, and the packages they name at its base and in the
 * working tree. `manifests` are repository paths; `base` and `head` map a package key to its versions
 * and declared ranges.
 */
export function storyDependencyChanges(root, workflow, changeSet) {
  const commit = storyChangeBase(workflow, changeSet);
  const manifests = [...new Set((changeSet?.entries ?? []).flatMap((entry) => [entry?.newPath, entry?.oldPath]).filter(Boolean))]
    .filter((relative) => auditsManifest('osv-scanner', relative)).sort();
  const base = new Map();
  const head = new Map();
  for (const relative of manifests) {
    const before = commit ? baseText(root, commit, relative) : null;
    if (before != null) manifestInventory(relative, before, base);
    manifestInventory(relative, workingText(root, relative), head);
  }
  return { base: commit, manifests, before: base, after: head };
}

/** The manifests and lockfiles this Story changed that `adapter` reads: none means the audit has nothing new to read. */
export function auditedManifests(changes, adapter) {
  return (changes?.manifests ?? []).filter((relative) => auditsManifest(adapter, relative));
}

/**
 * Mark each dependency finding new code when this Story added its package or changed its version
 * [CQF:REQ-050]: the package at its installed version is in a changed manifest or lockfile now and was
 * not at the base, or its declared range changed. Any other finding is left as it is.
 */
export function markNewDependencies(findings, changes) {
  return findings.map((finding) => {
    if (finding.kind !== 'dependency' || !finding.package) return finding;
    const key = dependencyKey(finding.package);
    const now = changes?.after?.get(key);
    const before = changes?.before?.get(key);
    let newCode = false;
    if (now) {
      const version = finding.installedVersion ? String(finding.installedVersion).replace(/^[=v]+/u, '') : null;
      // A lockfile's versions say what is installed; a manifest's range speaks only where no lockfile names the package.
      newCode = !before || (now.versions.size
        ? (version ? now.versions.has(version) && !before.versions.has(version) : [...now.versions].some((entry) => !before.versions.has(entry)))
        : [...now.specs].some((spec) => !before.specs.has(spec)));
    }
    return newCode === finding.newCode ? finding : Object.freeze({ ...finding, newCode });
  });
}
