/**
 * The projects a repository holds, as its build tools declare them [owner, 2026-11-12: "build it", monorepo
 * detection for capability mapping].
 *
 * `capability map` scoped a capability inside a monorepo only with roots a person typed. This reads the files the
 * repository's own tools list their projects in and proposes one capability per project: its folder as source
 * root, the folders of the projects it depends on inside the repository as shared roots, and both as the sparse
 * clone cone. A person still chooses which to map, and each map is its own reviewed proposal.
 *
 * Read: npm/Yarn workspaces (package.json), pnpm-workspace.yaml, lerna.json, Nx project.json files, Maven
 * <modules>, Gradle settings includes, go.work, Cargo [workspace] members, .NET solutions and uv workspaces.
 * Turborepo (turbo.json) runs tasks over the workspaces and is named as a tool. Pure: the committed file list and
 * the manifests' text come in; nothing is run, fetched or written.
 */
import path from 'node:path';

// Folders whose contents are installed, generated or vendored: never a project of the repository.
const SKIPPED_SEGMENTS = new Set(['node_modules', '.git', 'vendor', 'dist', 'target', 'out', 'bower_components', '.yarn',
  '.pnpm-store', '__pycache__', '.venv', 'venv', '.gradle', '.nx', '.turbo', 'coverage']);
const MANIFEST_NAMES = new Set(['package.json', 'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'project.json',
  'pom.xml', 'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts', 'go.work', 'go.mod',
  'cargo.toml', 'pyproject.toml']);
const MANIFEST_EXTENSIONS = /\.(?:sln|csproj|fsproj|vbproj)$/iu;
export const PROJECT_LIMITS = Object.freeze({ manifests: 4000, manifestBytes: 1024 * 1024, projects: 400 });
const RESERVED_IDS = new Set(['repository-root']);

const posixDir = (file) => { const dir = path.posix.dirname(file); return dir === '.' ? '' : dir; };
const skipped = (file) => file.split('/').some((segment) => SKIPPED_SEGMENTS.has(segment));
const parseJson = (text) => { try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };

/** The committed files whose text says what the projects are: read these, and only these, before detecting. */
export function projectManifestFiles(files, { limit = PROJECT_LIMITS.manifests } = {}) {
  const found = files.filter((file) => !skipped(file)
    && (MANIFEST_NAMES.has(path.posix.basename(file).toLowerCase()) || MANIFEST_EXTENSIONS.test(file)));
  return { files: found.slice(0, limit), truncated: found.length > limit };
}

/** A workspace glob (`packages/*`, `apps/**`, `libs/*\/*`) as a test for a folder; negation is the caller's. */
function globTest(pattern) {
  const clean = pattern.trim().replace(/^\.\//u, '').replace(/\/+$/u, '').replace(/\/package\.json$/u, '');
  if (!clean || clean.includes('..')) return null;
  let source = '';
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (char === '*' && clean[index + 1] === '*') {
      // `a/**` is a and every folder under it; `**/b` is b at any depth.
      const slashAfter = clean[index + 2] === '/';
      source += slashAfter ? '(?:.*/)?' : '.*';
      index += slashAfter ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  const test = new RegExp(`^${source}$`, 'u');
  return (folder) => test.test(folder);
}

/** The folders, among `folders`, that `patterns` (with `!negations`) select. */
function selectFolders(patterns, folders) {
  const include = []; const exclude = [];
  for (const raw of patterns.filter((value) => typeof value === 'string')) {
    const negated = raw.trim().startsWith('!');
    const test = globTest(negated ? raw.trim().slice(1) : raw);
    if (test) (negated ? exclude : include).push(test);
  }
  return folders.filter((folder) => folder && include.some((test) => test(folder)) && !exclude.some((test) => test(folder)));
}

/** The string values of a TOML array assigned to `key` inside `[section]` (members = ["a", "b/*"]). */
function tomlArray(text, section, key) {
  const lines = String(text).split(/\r?\n/u);
  let inside = false; let collecting = null;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (header && collecting === null) { inside = header[1].trim() === section; continue; }
    if (!inside) continue;
    if (collecting !== null) {
      collecting += ` ${line}`;
      if (line.includes(']')) break;
      continue;
    }
    const assigned = line.match(new RegExp(`^\\s*${key.replace(/[.]/gu, '\\.')}\\s*=\\s*(\\[.*)$`, 'u'));
    if (assigned) { collecting = assigned[1]; if (assigned[1].includes(']')) break; }
  }
  if (collecting === null) return [];
  return [...collecting.replace(/#[^\n]*/gu, '').matchAll(/"([^"]*)"|'([^']*)'/gu)].map((match) => match[1] ?? match[2]);
}

function tomlString(text, section, key) {
  let inside = false;
  for (const line of String(text).split(/\r?\n/u)) {
    const header = line.match(/^\s*\[([^\]]+)\]/u);
    if (header) { inside = header[1].trim() === section; continue; }
    const value = inside ? line.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'u')) : null;
    if (value) return value[1];
  }
  return null;
}

/** Strip XML comments and the named elements' whole blocks. */
function xmlWithout(text, tags) {
  let value = String(text).replace(/<!--[\s\S]*?-->/gu, '');
  for (const tag of tags) value = value.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'gu'), '');
  return value;
}

const resolveFrom = (base, relative) => {
  const joined = path.posix.normalize(path.posix.join(base || '.', relative.replace(/\\/gu, '/')));
  return joined === '.' ? '' : joined.replace(/\/+$/u, '');
};

class ProjectSet {
  constructor() { this.byRoot = new Map(); this.tools = new Set(); this.notes = []; }
  add(root, { name = null, ecosystem, tool, deps = [] } = {}) {
    if (!root || skipped(`${root}/x`) || root.startsWith('../')) return null;
    const project = this.byRoot.get(root) ?? { root, name: null, names: new Set(), ecosystems: new Set(), tools: new Set(), deps: new Set(), dependsOnRoots: new Set() };
    project.name ??= name;
    // An Nx project and its workspace package can name one folder differently; a dependency may use either.
    if (name) project.names.add(name);
    if (ecosystem) project.ecosystems.add(ecosystem);
    if (tool) { project.tools.add(tool); this.tools.add(tool); }
    for (const dep of deps) project.deps.add(dep);
    this.byRoot.set(root, project);
    return project;
  }
}

function nodeWorkspaces(set, files, text, folders) {
  const root = parseJson(text.get('package.json') ?? '');
  const declared = Array.isArray(root?.workspaces) ? root.workspaces : Array.isArray(root?.workspaces?.packages) ? root.workspaces.packages : [];
  const pnpm = text.get('pnpm-workspace.yaml');
  const pnpmPatterns = pnpm ? [...pnpm.matchAll(/^\s*-\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/gmu)].map((match) => match[1].trim()) : [];
  const lerna = parseJson(text.get('lerna.json') ?? '');
  const lernaPatterns = lerna ? (Array.isArray(lerna.packages) ? lerna.packages : ['packages/*']) : [];
  const patterns = [...declared, ...pnpmPatterns, ...lernaPatterns];
  if (!patterns.length) return;
  const tool = pnpm ? 'pnpm' : files.includes('yarn.lock') ? 'yarn-workspaces' : declared.length ? 'npm-workspaces' : 'lerna';
  if (lerna) set.tools.add('lerna');
  if (text.has('turbo.json')) set.tools.add('turborepo');
  const packageFolders = folders.filter((folder) => text.has(folder ? `${folder}/package.json` : 'package.json'));
  for (const folder of selectFolders(patterns, packageFolders)) {
    const pkg = parseJson(text.get(`${folder}/package.json`) ?? '');
    if (!pkg) continue;
    const deps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .flatMap((field) => Object.keys(pkg[field] && typeof pkg[field] === 'object' ? pkg[field] : {}));
    set.add(folder, { name: typeof pkg.name === 'string' ? pkg.name : null, ecosystem: 'node', tool, deps });
  }
}

function nxProjects(set, text) {
  if (!text.has('nx.json') && ![...text.keys()].some((file) => file.endsWith('/project.json'))) return;
  for (const [file, body] of text) {
    if (!file.endsWith('/project.json')) continue;
    const project = parseJson(body);
    if (!project) continue;
    const implicit = Array.isArray(project.implicitDependencies) ? project.implicitDependencies.filter((name) => typeof name === 'string' && !name.startsWith('!')) : [];
    set.add(posixDir(file), { name: typeof project.name === 'string' ? project.name : null, ecosystem: 'node', tool: 'nx', deps: implicit });
  }
}

function mavenModules(set, text, pom = 'pom.xml', seen = new Set()) {
  const body = text.get(pom);
  if (body == null || seen.has(pom) || seen.size > 2000) return;
  seen.add(pom);
  const base = posixDir(pom);
  const modules = [...xmlWithout(body, []).matchAll(/<module>\s*([^<\s]+)\s*<\/module>/gu)].map((match) => resolveFrom(base, match[1]));
  if (pom !== 'pom.xml' && !modules.length) {
    const own = xmlWithout(body, ['parent', 'dependencies', 'dependencyManagement', 'build', 'profiles', 'reporting', 'plugins']);
    const artifactId = own.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/u)?.[1] ?? null;
    const deps = [...xmlWithout(body, ['parent', 'dependencyManagement', 'build', 'reporting']).matchAll(/<dependency>[\s\S]*?<artifactId>\s*([^<\s]+)\s*<\/artifactId>[\s\S]*?<\/dependency>/gu)].map((match) => match[1]);
    set.add(base, { name: artifactId, ecosystem: 'java', tool: 'maven', deps });
    return;
  }
  if (modules.length) set.tools.add('maven');
  for (const module of modules) {
    const child = module.endsWith('.xml') ? module : `${module ? `${module}/` : ''}pom.xml`;
    mavenModules(set, text, child, seen);
  }
}

function gradleProjects(set, text) {
  const settings = text.get('settings.gradle.kts') ?? text.get('settings.gradle');
  if (!settings) return;
  const body = settings.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
  const included = [];
  for (const statement of body.matchAll(/\binclude\s*\(?([^\n)]*)\)?/gu)) {
    for (const name of statement[1].matchAll(/["']([^"']+)["']/gu)) included.push(name[1]);
  }
  for (const name of included) {
    const root = name.replace(/^:/u, '').split(':').filter(Boolean).join('/');
    if (!root) continue;
    const build = text.get(`${root}/build.gradle.kts`) ?? text.get(`${root}/build.gradle`) ?? '';
    const deps = [...build.matchAll(/project\(\s*(?:path\s*[:=]\s*)?["']([^"']+)["']/gu)]
      .map((match) => `gradle:${match[1].replace(/^:/u, '').split(':').filter(Boolean).join('/')}`);
    set.add(root, { name: root.split('/').at(-1), ecosystem: 'java', tool: 'gradle', deps });
  }
}

function goWorkspace(set, text) {
  const work = text.get('go.work');
  if (!work) return;
  const uses = [];
  for (const block of work.matchAll(/\buse\s*\(([\s\S]*?)\)/gu)) uses.push(...block[1].split(/\s+/u));
  for (const single of work.matchAll(/\buse\s+([^\s(][^\s]*)/gu)) uses.push(single[1]);
  for (const use of uses.map((value) => value.replace(/["`]/gu, '').trim()).filter(Boolean)) {
    const root = resolveFrom('', use);
    if (!root) continue;
    const module = text.get(`${root}/go.mod`)?.match(/^\s*module\s+(\S+)/mu)?.[1] ?? null;
    set.add(root, { name: module ? module.split('/').at(-1) : root.split('/').at(-1), ecosystem: 'go', tool: 'go-workspace' });
  }
}

function cargoWorkspace(set, text, folders) {
  const manifest = [...text.keys()].find((file) => file.toLowerCase() === 'cargo.toml');
  const members = manifest ? tomlArray(text.get(manifest), 'workspace', 'members') : [];
  if (!members.length) return;
  const excluded = tomlArray(text.get(manifest), 'workspace', 'exclude').map((value) => `!${value}`);
  const crateFolders = folders.filter((folder) => [...text.keys()].some((file) => file.toLowerCase() === `${folder}/cargo.toml`));
  for (const folder of selectFolders([...members, ...excluded], crateFolders)) {
    const file = [...text.keys()].find((name) => name.toLowerCase() === `${folder}/cargo.toml`);
    const body = text.get(file) ?? '';
    const deps = [...body.matchAll(/path\s*=\s*["']([^"']+)["']/gu)].map((match) => `path:${resolveFrom(folder, match[1])}`);
    set.add(folder, { name: tomlString(body, 'package', 'name'), ecosystem: 'rust', tool: 'cargo-workspace', deps });
  }
}

function dotnetSolutions(set, text) {
  for (const [file, body] of text) {
    if (!/\.sln$/iu.test(file)) continue;
    const base = posixDir(file);
    for (const match of body.matchAll(/^Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+\.(?:cs|fs|vb)proj)"/gmu)) {
      const project = resolveFrom(base, match[2]);
      const root = posixDir(project);
      const xml = text.get(project) ?? '';
      const deps = [...xml.matchAll(/<ProjectReference\s+Include="([^"]+)"/gu)].map((ref) => `path:${posixDir(resolveFrom(root, ref[1]))}`);
      set.add(root, { name: match[1], ecosystem: 'dotnet', tool: 'dotnet-solution', deps });
    }
  }
}

function uvWorkspace(set, text, folders) {
  const members = tomlArray(text.get('pyproject.toml') ?? '', 'tool.uv.workspace', 'members');
  if (!members.length) return;
  const excluded = tomlArray(text.get('pyproject.toml'), 'tool.uv.workspace', 'exclude').map((value) => `!${value}`);
  for (const folder of selectFolders([...members, ...excluded], folders.filter((folder) => text.has(`${folder}/pyproject.toml`)))) {
    set.add(folder, { name: tomlString(text.get(`${folder}/pyproject.toml`), 'project', 'name'), ecosystem: 'python', tool: 'uv-workspace' });
  }
}

/** A capability ID for a project: its name without an npm scope, else its folder; unique among `taken`. */
function capabilityIdFor(project, taken) {
  const slug = (value) => String(value ?? '').toLowerCase().replace(/^@[^/]+\//u, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 63).replace(/-+$/u, '');
  for (const candidate of [slug(project.name), slug(project.root.split('/').at(-1)), slug(project.root)]) {
    if (candidate && !taken.has(candidate) && !RESERVED_IDS.has(candidate)) { taken.add(candidate); return candidate; }
  }
  let index = 2;
  const base = slug(project.root) || 'project';
  while (taken.has(`${base}-${index}`)) index += 1;
  taken.add(`${base}-${index}`);
  return `${base}-${index}`;
}

/**
 * The repository's projects: `{ layout: 'workspace'|'single', tools, projects: [{ id, name, root, ecosystems, tools,
 * sharedRoots, sparseCone }], notes, truncated }`. `files` is every committed file path; `text` maps the manifest
 * paths `projectManifestFiles` named to their text (a missing or unreadable one is absent).
 */
export function detectRepositoryProjects({ files = [], text = new Map(), manifestsTruncated = false } = {}) {
  const set = new ProjectSet();
  const folders = [...new Set(files.filter((file) => !skipped(file)).map(posixDir))].sort();
  nodeWorkspaces(set, files, text, folders);
  nxProjects(set, text);
  mavenModules(set, text);
  gradleProjects(set, text);
  goWorkspace(set, text);
  cargoWorkspace(set, text, folders);
  dotnetSolutions(set, text);
  uvWorkspace(set, text, folders);
  if (text.has('nx.json')) set.tools.add('nx');

  // A project's own dependencies inside the repository are the folders it needs to see.
  const all = [...set.byRoot.values()];
  const byName = new Map(all.flatMap((project) => [...project.names].map((name) => [name, project.root])));
  for (const project of all) {
    for (const dep of project.deps) {
      const root = dep.startsWith('gradle:') ? dep.slice(7) : dep.startsWith('path:') ? dep.slice(5) : byName.get(dep);
      if (root && root !== project.root && set.byRoot.has(root)) project.dependsOnRoots.add(root);
    }
  }
  const sorted = all.sort((left, right) => left.root.localeCompare(right.root));
  const limited = sorted.slice(0, PROJECT_LIMITS.projects);
  const taken = new Set();
  const projects = limited.map((project) => {
    const sharedRoots = [...project.dependsOnRoots].sort();
    const inside = sorted.filter((other) => other !== project && other.root.startsWith(`${project.root}/`)).map((other) => other.root);
    return Object.freeze({
      id: capabilityIdFor(project, taken), name: project.name ?? project.root.split('/').at(-1), root: project.root,
      ecosystems: [...project.ecosystems].sort(), tools: [...project.tools].sort(), sharedRoots,
      sparseCone: [project.root, ...sharedRoots].sort(), ...(inside.length ? { contains: inside } : {})
    });
  });
  if (projects.some((project) => project.contains)) {
    set.notes.push('Some projects sit inside another project\'s folder (contains): map the inner one as its own capability, or leave it to the outer one.');
  }
  if (manifestsTruncated) set.notes.push(`More than ${PROJECT_LIMITS.manifests} manifest files: only the first were read, so some projects may be missing.`);
  if (sorted.length > projects.length) set.notes.push(`${sorted.length} projects found; the first ${projects.length} are listed.`);
  return Object.freeze({
    layout: projects.length > 1 ? 'workspace' : 'single',
    tools: [...set.tools].sort(),
    projects,
    notes: set.notes,
    truncated: manifestsTruncated || sorted.length > projects.length
  });
}
