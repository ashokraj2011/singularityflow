/**
 * What kind of software each project in a repository is, read from its committed files (step intents spec §12.1):
 * web, backend, job, cli, library, mobile or artifact.
 *
 * The kind decides, later, which runtime check a code step gets and which baseline criteria an intake adds (§12.2,
 * §12.3). Today it is a read-only report in `workflow check`: nothing uses it, nothing records it, and nobody is asked
 * to confirm it yet.
 *
 * One kind per project, as the repository's build tools declare projects (repository-projects.mjs); a repository that
 * declares none is one project. Each kind is scored from what the build files name (a framework or dependency counts
 * twice) and which files exist (once); the highest score wins, ties going to the kind listed first in SOFTWARE_KINDS.
 * A library is what a package with nothing runnable is. Every kind found besides the winner is listed under `also`.
 *
 * Pure: the committed file list and the text of the files softwareKindTextFiles names come in; nothing is run,
 * fetched or written.
 */
import path from 'node:path';

import { detectRepositoryProjects, projectManifestFiles, PROJECT_LIMITS } from './repository-projects.mjs';

/** The kinds, in the order a tie is settled. */
export const SOFTWARE_KINDS = Object.freeze(['mobile', 'web', 'backend', 'job', 'cli', 'artifact', 'library']);

// Build and dependency files beyond the project manifests whose text names a framework.
const EXTRA_TEXT = /(?:^|\/)(?:requirements[\w.-]*\.txt|setup\.py|setup\.cfg|Pipfile|Gemfile|composer\.json|pubspec\.yaml)$/u;
const SKIPPED = new Set(['node_modules', '.git', 'vendor', 'dist', 'target', 'out', 'build', 'bower_components', '.yarn', '.venv', 'venv', '__pycache__', '.gradle', 'coverage']);
const skipped = (file) => file.split('/').some((segment) => SKIPPED.has(segment));

/** The committed files whose text says what kind of software a project is: read these, and only these. */
export function softwareKindTextFiles(files, { limit = PROJECT_LIMITS.manifests } = {}) {
  const manifests = projectManifestFiles(files, { limit });
  const extra = files.filter((file) => !skipped(file) && EXTRA_TEXT.test(file));
  const all = [...new Set([...manifests.files, ...extra])];
  return { files: all.slice(0, limit), truncated: manifests.truncated || all.length > limit };
}

const parseJson = (text) => { try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };
const lower = (text) => String(text ?? '').toLowerCase();
/** A dependency name standing on its own in a build file (not inside a longer name). */
const names = (text, name) => new RegExp(`(?:^|[\\s"'\`\\[(,=<>~!:/])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:$|[\\s"'\`\\](,=<>~!;:@/])`, 'mu').test(lower(text));

// Framework and dependency names, per ecosystem file: each one found counts twice for its kind.
const NODE = {
  mobile: ['react-native', 'expo', '@capacitor/core', 'nativescript'],
  web: ['react', 'react-dom', 'vue', '@angular/core', 'svelte', '@sveltejs/kit', 'next', 'nuxt', 'preact', 'solid-js', 'astro', 'gatsby', '@remix-run/react', 'lit', 'ember-source'],
  backend: ['express', 'fastify', 'koa', '@nestjs/core', '@hapi/hapi', 'hapi', 'restify', '@apollo/server', 'apollo-server', 'hono'],
  job: ['node-cron', 'bullmq', 'bull', 'agenda', 'bree', '@temporalio/worker'],
  cli: ['commander', 'yargs', '@oclif/core', 'oclif', 'meow', 'cac', 'clipanion']
};
const JVM = {
  mobile: ['com.android.application'],
  web: ['spring-boot-starter-thymeleaf', 'spring-boot-starter-freemarker', 'vaadin'],
  backend: ['spring-boot-starter-web', 'spring-boot-starter-webflux', 'io.quarkus', 'quarkus-resteasy', 'io.micronaut', 'micronaut-http-server',
    'dropwizard', 'javalin', 'jakarta.ws.rs', 'javax.ws.rs', 'jersey-server', 'ktor-server', 'vertx-web', 'helidon'],
  job: ['spring-boot-starter-batch', 'spring-batch-core', 'quartz', 'spring-cloud-task'],
  cli: ['picocli', 'jcommander', 'args4j', 'spring-shell', 'commons-cli', 'clikt']
};
const PYTHON = {
  web: ['streamlit', 'gradio'],
  backend: ['fastapi', 'flask', 'django', 'aiohttp', 'tornado', 'starlette', 'sanic', 'falcon', 'pyramid', 'litestar'],
  job: ['celery', 'apache-airflow', 'prefect', 'dagster', 'rq', 'apscheduler', 'luigi'],
  cli: ['click', 'typer']
};
// Go module paths by their owner and name: the host before them is any.
const GO = {
  backend: ['gin-gonic/gin', 'labstack/echo', 'gofiber/fiber', 'go-chi/chi', 'gorilla/mux', 'google.golang.org/grpc'],
  job: ['robfig/cron', 'go.temporal.io/sdk'],
  cli: ['spf13/cobra', 'urfave/cli', 'alecthomas/kong']
};
const RUST = {
  web: ['yew', 'leptos', 'dioxus'],
  backend: ['actix-web', 'axum', 'rocket', 'warp', 'tide', 'poem'],
  job: ['tokio-cron-scheduler'],
  cli: ['clap', 'structopt', 'argh']
};
const RUBY_PHP = { backend: ['rails', 'sinatra', 'hanami', 'laravel/framework', 'symfony/framework-bundle', 'slim/slim'] };

// Files whose presence says a kind: each kind found this way counts once.
const FILE_SIGNALS = [
  ['mobile', /(?:^|\/)AndroidManifest\.xml$/u, 'AndroidManifest.xml'],
  ['mobile', /\.(?:xcodeproj|xcworkspace)\//u, 'an Xcode project'],
  ['mobile', /(?:^|\/)Podfile$/u, 'a Podfile'],
  ['web', /\.(?:jsx|tsx|vue|svelte)$/u, 'front-end component files'],
  ['web', /(?:^|\/)(?:angular\.json|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|nuxt\.config\.[cm]?[jt]s|svelte\.config\.[cm]?js)$/u, 'a front-end build file'],
  ['backend', /(?:^|\/)(?:openapi|swagger)\.(?:ya?ml|json)$/u, 'an OpenAPI file'],
  ['backend', /(?:^|\/)manage\.py$/u, 'a Django manage.py'],
  ['job', /(?:^|\/)dags\/[^/]+\.py$/u, 'Airflow DAGs'],
  ['artifact', /\.tf(?:\.json)?$/u, 'Terraform files'],
  ['artifact', /\.bicep$/u, 'Bicep files'],
  ['artifact', /(?:^|\/)(?:Chart\.yaml|kustomization\.ya?ml)$/u, 'Kubernetes packaging'],
  ['artifact', /(?:^|\/)(?:k8s|kubernetes|manifests)\/[^/]+\.ya?ml$/u, 'Kubernetes manifests'],
  ['artifact', /(?:^|\/)(?:migrations|db\/migration|db\/migrate)\/[^/]+\.sql$/u, 'SQL migrations'],
  ['artifact', /(?:^|\/)(?:mkdocs\.yml|docusaurus\.config\.[cm]?[jt]s|antora\.yml|hugo\.toml)$/u, 'a documentation site'],
  ['artifact', /(?:^|\/)(?:cdk\.json|serverless\.ya?ml|ansible\.cfg)$/u, 'infrastructure files']
];

function scoreSet() {
  const scores = new Map(SOFTWARE_KINDS.map((kind) => [kind, { score: 0, strong: false, signals: [] }]));
  return {
    scores,
    add(kind, signal, strong) {
      const entry = scores.get(kind);
      if (entry.signals.includes(signal)) return;
      entry.score += strong ? 2 : 1;
      entry.strong ||= strong;
      entry.signals.push(signal);
    }
  };
}

function frameworks(found, catalog, text, file, matches = names) {
  for (const [kind, list] of Object.entries(catalog)) {
    for (const name of list) if (matches(text, name)) found.add(kind, `${name} in ${file}`, true);
  }
}

/** A Python requirement: the name, any extras, then a version, a separator or the line's end; never a word in prose. */
const requirement = (text, name) => new RegExp(`(?:^|["'\\s,\\[])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*(?:\\[[^\\]]*\\])?\\s*(?:[<>=~!;"',\\]]|$)`, 'mu').test(lower(text));

function nodeManifest(found, text, file, files, base) {
  const pkg = parseJson(text);
  if (!pkg) return;
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) });
  for (const [kind, list] of Object.entries(NODE)) for (const name of list) if (deps.includes(name)) found.add(kind, `${name} in ${file}`, true);
  if (pkg.bin) found.add('cli', `a bin entry in ${file}`, true);
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const runnable = ['start', 'dev', 'serve'].some((name) => typeof scripts[name] === 'string');
  if (!pkg.private && !runnable && (pkg.main || pkg.module || pkg.exports || pkg.types || pkg.publishConfig)) found.add('library', `a published package (${file})`, false);
  if (!runnable && files.some((entry) => entry === path.posix.join(base, 'index.html'))) found.add('web', 'an index.html', false);
}

function jvmManifest(found, text, file) {
  frameworks(found, JVM, text, file);
  const body = lower(text);
  if (file.endsWith('pom.xml') && !/spring-boot-maven-plugin/u.test(body) && !/<packaging>\s*pom\s*<\/packaging>/u.test(body)
      && /<distributionmanagement>/u.test(body)) found.add('library', `published from ${file}`, false);
  if (/\bjava-library\b|\bmaven-publish\b|com\.android\.library/u.test(body)) found.add('library', `a library plugin in ${file}`, false);
}

function pythonManifest(found, text, file) {
  frameworks(found, PYTHON, text, file, requirement);
  if (/\[project\.scripts\]|console_scripts|\[tool\.poetry\.scripts\]/u.test(text)) found.add('cli', `command entry points in ${file}`, true);
  if (/\[project\]|\[tool\.poetry\]|setup\(/u.test(text)) found.add('library', `a package (${file})`, false);
}

function goManifest(found, text, file, files, base) {
  frameworks(found, GO, text, file);
  const runnable = files.some((entry) => entry === path.posix.join(base, 'main.go') || entry.startsWith(path.posix.join(base, 'cmd') + '/'));
  if (!runnable) found.add('library', `a Go module with no main package (${file})`, false);
}

function rustManifest(found, text, file, files, base) {
  frameworks(found, RUST, text, file);
  const has = (relative) => files.includes(path.posix.join(base, relative));
  if ((/^\s*\[lib\]/mu.test(text) || has('src/lib.rs')) && !has('src/main.rs') && !/^\s*\[\[bin\]\]/mu.test(text)) found.add('library', `a crate with no binary (${file})`, false);
}

function dotnetProject(found, text, file) {
  if (/Sdk="Microsoft\.NET\.Sdk\.BlazorWebAssembly"/u.test(text)) found.add('web', `Blazor in ${file}`, true);
  if (/Sdk="Microsoft\.NET\.Sdk\.Web"/u.test(text)) found.add('backend', `ASP.NET Core in ${file}`, true);
  if (/Sdk="Microsoft\.NET\.Sdk\.Worker"|Hangfire|Quartz/u.test(text)) found.add('job', `a worker in ${file}`, true);
  if (/<UseMaui>\s*true|Xamarin\./u.test(text)) found.add('mobile', `MAUI or Xamarin in ${file}`, true);
  if (/System\.CommandLine|CommandLineParser/u.test(text)) found.add('cli', `a command-line parser in ${file}`, true);
  if (!/<OutputType>\s*(?:Win)?Exe\s*<\/OutputType>/u.test(text) && /Sdk="Microsoft\.NET\.Sdk"/u.test(text)) found.add('library', `a .NET library (${file})`, false);
}

/** The kind of one project from its own files: `{ kind, confidence, signals, also }`. */
function projectKind(files, text, base) {
  const found = scoreSet();
  for (const [file, body] of text) {
    const name = path.posix.basename(file);
    const folder = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
    if (name === 'package.json') nodeManifest(found, body, file, files, folder);
    else if (/^(?:pom\.xml|build\.gradle(?:\.kts)?)$/u.test(name)) jvmManifest(found, body, file);
    else if (/^(?:pyproject\.toml|setup\.py|setup\.cfg|Pipfile)$|^requirements[\w.-]*\.txt$/u.test(name)) pythonManifest(found, body, file);
    else if (name === 'go.mod') goManifest(found, body, file, files, folder);
    else if (name.toLowerCase() === 'cargo.toml') rustManifest(found, body, file, files, folder);
    else if (/\.csproj$/iu.test(name)) dotnetProject(found, body, file);
    else if (/^(?:Gemfile|composer\.json)$/u.test(name)) frameworks(found, RUBY_PHP, body, file);
    else if (name === 'pubspec.yaml' && /^\s*flutter\s*:/mu.test(body)) found.add('mobile', `Flutter in ${file}`, true);
  }
  for (const [kind, pattern, words] of FILE_SIGNALS) if (files.some((file) => pattern.test(file))) found.add(kind, words, false);
  const ranked = SOFTWARE_KINDS.map((kind) => [kind, found.scores.get(kind)]).filter(([, entry]) => entry.score > 0);
  // A library is what a package is when nothing in it runs.
  const runnable = ranked.filter(([kind]) => kind !== 'library');
  const pool = runnable.length ? runnable : ranked;
  if (!pool.length) return { kind: null, confidence: 'unclear', signals: [], also: [] };
  const [kind, entry] = [...pool].sort(([leftKind, left], [rightKind, right]) => right.score - left.score
    || SOFTWARE_KINDS.indexOf(leftKind) - SOFTWARE_KINDS.indexOf(rightKind))[0];
  return {
    kind,
    confidence: entry.strong ? 'certain' : 'likely',
    signals: entry.signals.slice(0, 5),
    also: runnable.map(([other]) => other).filter((other) => other !== kind)
  };
}

/**
 * The kind of each project in a repository: `{ layout, projects: [{ id, name, root, kind, confidence, signals, also }],
 * notes, truncated }`. `files` is every committed file path; `text` maps the files softwareKindTextFiles named to their
 * text (a missing or unreadable one is absent). A repository that declares no projects is one, `repository-root`.
 */
export function detectSoftwareKinds({ files = [], text = new Map(), truncated = false } = {}) {
  const kept = files.filter((file) => !skipped(file));
  const detected = detectRepositoryProjects({ files: kept, text, manifestsTruncated: truncated });
  const targets = detected.projects.length
    ? detected.projects.map((project) => ({ id: project.id, name: project.name, root: project.root, inner: project.contains ?? [] }))
    : [{ id: 'repository-root', name: null, root: '', inner: [] }];
  const under = (root, inner) => (file) => (!root || file.startsWith(`${root}/`)) && !inner.some((other) => file.startsWith(`${other}/`));
  const projects = targets.map((target) => {
    const owns = under(target.root, target.inner);
    const own = kept.filter(owns);
    const ownText = new Map([...text].filter(([file]) => owns(file)));
    return Object.freeze({ id: target.id, name: target.name, root: target.root, ...projectKind(own, ownText, target.root) });
  });
  const notes = [...detected.notes];
  if (projects.some((project) => !project.kind)) notes.push('SFlow could not tell the kind of every project from its files.');
  return Object.freeze({ layout: detected.layout, projects, notes, truncated: Boolean(truncated || detected.truncated) });
}
