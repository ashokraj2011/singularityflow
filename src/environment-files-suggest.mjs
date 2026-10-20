/**
 * `env files suggest` [ENVF]: framework-known environment files of a checkout, from file names only,
 * and a `localFiles` draft for the configuration proposal.
 *
 * The walk reads directory entries (never following a link), plus a Python project's
 * requirements.txt or pyproject.toml to tell FastAPI from Flask. It never opens an environment file
 * or a template, so no value can reach the result. Candidates are what a framework reads per
 * environment: Spring `application-<env>.yml|.yaml|.properties` under `src/main/resources` or
 * `config/`, Node `.env.<env>`, Django `settings/<env>.py` and `.env`, FastAPI and Flask `.env`,
 * .NET `appsettings.<Env>.json`, Go `config.<env>.yaml` and `.env`, and Rails credential keys.
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import {
  captureEnvironmentDeclaration, ENVIRONMENT_DECLARATION_PATH, ENVIRONMENT_IDENTIFIER, matchEnvironmentLocalPath, parseEnvironmentDeclaration
} from './environment-declaration.mjs';
import { declaredEnvironmentFiles, templateCandidates } from './environment-files.mjs';
import { trackedPaths } from './git.mjs';

const MAXIMUM_ENTRIES = 50_000;
const MAXIMUM_DEPTH = 12;
const SKIPPED = new Set(['.git', 'node_modules', 'target', 'build', 'dist', 'out', '.venv', 'venv', '__pycache__', '.gradle', '.idea',
  '.vscode', 'bin', 'obj', 'vendor', '.next', '.nuxt', 'coverage', '.terraform', '.tox', '.mypy_cache', '.pytest_cache', '.sflow', 'singularity']);
const NOT_ENVIRONMENTS = new Set(['example', 'template', 'sample', 'local', 'default', 'defaults', 'dist', 'bak', 'backup', 'orig', 'old', 'keep', 'vault', 'enc', 'base', 'common', 'settings']);
const MARKER = /\.(?:example|template|sample)(?=\.|$)/u;

async function walk(checkout) {
  const directories = new Map();
  let visited = 0;
  let truncated = false;
  const pending = [['', 0]];
  while (pending.length) {
    const [relative, depth] = pending.pop();
    let entries;
    try { entries = await readdir(path.join(checkout, ...relative.split('/').filter(Boolean)), { withFileTypes: true }); } catch { continue; }
    const files = new Set();
    for (const entry of entries) {
      visited += 1;
      if (visited > MAXIMUM_ENTRIES) { truncated = true; break; }
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name) && depth < MAXIMUM_DEPTH) pending.push([child, depth + 1]);
      } else if (entry.isFile() || entry.isSymbolicLink()) files.add(entry.name);
    }
    directories.set(relative, files);
    if (truncated) break;
  }
  return { directories, truncated };
}

function environmentToken(raw) {
  const token = String(raw ?? '').toLowerCase();
  return ENVIRONMENT_IDENTIFIER.test(token) && !NOT_ENVIRONMENTS.has(token) ? token : null;
}

/** The real file a name stands for: itself, or the file a template stands in for. */
function realName(name) {
  return MARKER.test(name) ? name.replace(MARKER, '') : name;
}

function hasAncestorWith(directories, directory, names) {
  let cursor = directory;
  for (;;) {
    const files = directories.get(cursor);
    if (files && names.some((name) => files.has(name))) return true;
    if (!cursor) return false;
    cursor = cursor.includes('/') ? cursor.slice(0, cursor.lastIndexOf('/')) : '';
  }
}

async function pythonFramework(checkout, directories, directory) {
  for (const name of ['requirements.txt', 'pyproject.toml']) {
    if (!directories.get(directory)?.has(name)) continue;
    const info = await lstat(path.join(checkout, ...directory.split('/').filter(Boolean), name)).catch(() => null);
    if (!info?.isFile() || info.size > 256 * 1024) continue;
    const text = (await readFile(path.join(checkout, ...directory.split('/').filter(Boolean), name), 'utf8').catch(() => '')).toLowerCase();
    if (/\bfastapi\b/u.test(text)) return 'fastapi';
    if (/\bflask\b/u.test(text)) return 'flask';
  }
  return null;
}

/** Every candidate a name in a directory stands for (a file or its template), with its framework. */
async function candidatesIn(checkout, directories, directory, files) {
  const found = [];
  const at = (name) => (directory ? `${directory}/${name}` : name);
  const add = (framework, environment, name, app) => found.push({ framework, environment, path: at(name), app: app ?? (directory || '.') });
  for (const original of files) {
    const name = realName(original);
    let match;
    if ((match = /^application-([A-Za-z0-9-]+)\.(?:ya?ml|properties)$/u.exec(name))
        && (/(?:^|\/)src\/main\/resources$/u.test(directory) || /(?:^|\/)config$/u.test(directory))) {
      const environment = environmentToken(match[1]);
      const module = directory.replace(/\/?(?:src\/main\/resources|config)$/u, '');
      if (environment) add('spring', environment, name, module || '.');
    } else if ((match = /^appsettings\.([A-Za-z0-9-]+)\.json$/u.exec(name))) {
      const environment = environmentToken(match[1]);
      if (environment) add('dotnet', environment, name);
    } else if ((match = /^config\.([A-Za-z0-9-]+)\.(?:ya?ml|json|toml)$/u.exec(name)) && hasAncestorWith(directories, directory, ['go.mod'])) {
      const environment = environmentToken(match[1]);
      if (environment) add('go', environment, name);
    } else if (/^settings$/u.test(path.posix.basename(directory)) && (match = /^([a-z][a-z0-9_]*)\.py$/u.exec(name)) && files.has('__init__.py')) {
      const environment = environmentToken(match[1].replaceAll('_', '-'));
      if (environment) add('django', environment, name, path.posix.dirname(directory) === '.' ? '.' : path.posix.dirname(directory));
    } else if ((match = /^([a-z0-9-]+)\.yml\.enc$/u.exec(name)) && /(?:^|\/)config\/credentials$/u.test(directory)) {
      const environment = environmentToken(match[1]);
      if (environment) add('rails', environment, `${match[1]}.key`, directory.replace(/\/?config\/credentials$/u, '') || '.');
    } else if (name === 'credentials.yml.enc' && /(?:^|\/)config$/u.test(directory)) {
      add('rails', null, 'master.key', directory.replace(/\/?config$/u, '') || '.');
    } else if (name === '.env' || /^\.env\.[A-Za-z0-9-]+$/u.test(name)) {
      const environment = name === '.env' ? null : environmentToken(name.slice(5));
      if (name !== '.env' && !environment) continue;
      const framework = files.has('package.json') ? 'node' : files.has('manage.py') ? 'django' : files.has('go.mod') ? 'go'
        : await pythonFramework(checkout, directories, directory) ?? (files.has('requirements.txt') || files.has('pyproject.toml') ? 'python' : 'dotenv');
      add(framework, environment, name);
    }
  }
  return found;
}

function draftDocument(source, additions) {
  if (!additions.length) return { document: null, valid: true, error: null };
  if (!source) return { document: null, valid: false, error: `${ENVIRONMENT_DECLARATION_PATH} does not exist yet` };
  const document = YAML.parseDocument(source.toString('utf8'));
  for (const [environment, paths] of additions) {
    if (!document.hasIn(['environments', environment])) continue;
    const node = document.getIn(['environments', environment, 'localFiles'], true);
    if (YAML.isSeq(node)) for (const entry of paths) node.add(entry);
    else document.setIn(['environments', environment, 'localFiles'], document.createNode([...paths]));
  }
  const text = document.toString();
  try { parseEnvironmentDeclaration(Buffer.from(text)); return { document: text, valid: true, error: null }; }
  catch (error) { return { document: text, valid: false, error: error.message }; }
}

/** Candidates and a localFiles draft for one repository scope; nothing is written. */
export async function suggestEnvironmentFiles(scope) {
  const { directories, truncated } = await walk(scope.checkout);
  const seen = new Map();
  for (const [directory, files] of directories) {
    for (const candidate of await candidatesIn(scope.checkout, directories, directory, files)) {
      const key = `${candidate.environment}\0${candidate.path}`;
      if (!seen.has(key)) seen.set(key, candidate);
    }
  }
  const captured = scope.kind === 'repository' ? await captureEnvironmentDeclaration(scope.checkout, { optional: true }).catch(() => null) : null;
  const declaration = captured?.declaration ?? null;
  const candidates = [...seen.values()].sort((left, right) => left.path.localeCompare(right.path) || String(left.environment).localeCompare(String(right.environment)));
  const present = (relative) => directories.get(path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative))?.has(path.posix.basename(relative)) ?? false;
  const existing = candidates.map((candidate) => candidate.path).filter(present);
  const tracked = new Set(scope.kind === 'repository' && existing.length ? trackedPaths(scope.checkout, [...new Set(existing)]) : []);
  const shown = candidates.map((candidate) => {
    const template = templateCandidates(candidate.path).find(present) ?? null;
    const declared = candidate.environment ? declaredEnvironmentFiles(declaration, candidate.environment).includes(candidate.path)
      : Object.keys(declaration?.environments ?? {}).some((environment) => declaredEnvironmentFiles(declaration, environment).includes(candidate.path));
    return {
      ...candidate, template, exists: present(candidate.path), tracked: tracked.has(candidate.path), declared,
      protected: Boolean(matchEnvironmentLocalPath(declaration, candidate.path))
    };
  });
  const additions = new Map();
  for (const candidate of shown) {
    if (!candidate.environment || candidate.declared || candidate.tracked) continue;
    if (!additions.has(candidate.environment)) additions.set(candidate.environment, []);
    additions.get(candidate.environment).push(candidate.path);
  }
  const declaredEnvironments = Object.keys(declaration?.environments ?? {});
  const undeclared = [...additions.keys()].filter((environment) => !declaredEnvironments.includes(environment)).sort();
  const draft = draftDocument(captured?.bytes ?? null, [...additions].filter(([environment]) => declaredEnvironments.includes(environment)));
  const notes = [];
  if (undeclared.length) notes.push(`Environment(s) ${undeclared.join(', ')} are not declared; declaring one needs at least one requires entry, so they are not in the draft.`);
  const shared = shown.filter((candidate) => !candidate.environment && !candidate.declared);
  if (shared.length) notes.push(`${shared.map((candidate) => candidate.path).join(', ')} ${shared.length === 1 ? 'is' : 'are'} shared by every environment: declare ${shared.length === 1 ? 'it' : 'each'} under each environment that uses it; a run switches the link.`);
  if (shown.some((candidate) => candidate.tracked)) notes.push('A tracked candidate is already in Git: remove it from the repository before declaring it.');
  if (!candidates.length || !additions.size) notes.push(candidates.length ? 'Every candidate is already declared or tracked; there is nothing to draft.' : 'No framework environment file was found by name.');
  if (truncated) notes.push(`The walk stopped after ${MAXIMUM_ENTRIES} entries; candidates deeper in the tree are not listed.`);
  return {
    schemaVersion: 1, resultType: 'sflow-env-files-suggest', repository: scope.repositoryId, checkout: scope.checkout,
    declaration: declaration ? 'ready' : 'missing',
    candidates: shown,
    draft: {
      path: ENVIRONMENT_DECLARATION_PATH,
      localFiles: Object.fromEntries([...additions].filter(([environment]) => declaredEnvironments.includes(environment)).sort(([left], [right]) => left.localeCompare(right))),
      undeclaredEnvironments: Object.fromEntries(undeclared.map((environment) => [environment, additions.get(environment)])),
      document: draft.document, valid: draft.valid, ...(draft.error ? { error: draft.error } : {})
    },
    // The reviewed route for the draft: the document goes on standard input; env files never edits the declaration.
    proposal: draft.valid && draft.document ? { command: `singularity-flow configuration save ${ENVIRONMENT_DECLARATION_PATH} --propose`, stdin: 'draft.document' } : null,
    notes, truncated
  };
}

export function suggestionText(result) {
  const lines = [`Environment-file candidates in ${result.repository ? `repository ${result.repository}` : 'this repository'} (declaration ${result.declaration}):`];
  if (!result.candidates.length) lines.push('  None found from Spring, Node, Django, FastAPI, Flask, .NET, Go or Rails file names.');
  for (const candidate of result.candidates) {
    const marks = [candidate.declared ? 'declared' : null, candidate.exists ? 'present' : null, candidate.template ? `template ${candidate.template}` : null,
      candidate.tracked ? 'TRACKED in Git' : null, !candidate.declared && candidate.protected ? 'protected by a glob' : null].filter(Boolean);
    lines.push(`  ${candidate.environment ?? 'shared'} · ${candidate.framework} · ${candidate.path}${marks.length ? ` (${marks.join(', ')})` : ''}`);
  }
  const entries = Object.entries(result.draft.localFiles);
  if (entries.length) {
    lines.push(`Draft localFiles for ${result.draft.path}:`);
    for (const [environment, paths] of entries) lines.push(`  ${environment}: ${paths.join(', ')}`);
    if (result.proposal) lines.push(`Propose it for review: pipe the draft document (--json: draft.document) into ${result.proposal.command}`);
  }
  for (const note of result.notes) lines.push(note);
  return lines.join('\n');
}
