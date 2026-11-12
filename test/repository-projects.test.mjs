/**
 * Capability mapping reads a monorepo's projects from what its build tools declare [owner, 2026-11-12: "build it"].
 *
 * `capability projects` lists them (src/repository-projects.mjs), each with the `capability map` command that scopes
 * it: its folder as source root, the folders it depends on inside the repository as shared roots, both as its sparse
 * clone. From a checkout at HEAD, or from a remote without a working tree. It maps nothing.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { detectRepositoryProjects, projectManifestFiles } from '../src/repository-projects.mjs';
import { remoteProjectFiles } from '../src/repository-projects-source.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const detect = (entries, extra = []) => {
  const text = new Map(Object.entries(entries));
  return detectRepositoryProjects({ files: [...text.keys(), ...extra], text });
};
const summary = (result) => result.projects.map((project) => `${project.id} ${project.root} [${project.sharedRoots.join(',')}]`);

test('npm, Yarn and pnpm workspaces, lerna and Nx name their projects, and a project\'s workspace dependencies are its shared roots', () => {
  const pnpmNx = detect({
    'package.json': '{}', 'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - libs/**\n  - "!**/test/**"\n', 'nx.json': '{}', 'turbo.json': '{}',
    'apps/web/package.json': JSON.stringify({ name: '@acme/web', dependencies: { '@acme/ui': 'workspace:*', react: '18' } }),
    'apps/web/project.json': JSON.stringify({ name: 'web', implicitDependencies: ['api'] }),
    'apps/api/package.json': JSON.stringify({ name: '@acme/api' }), 'apps/api/project.json': JSON.stringify({ name: 'api' }),
    'libs/ui/package.json': JSON.stringify({ name: '@acme/ui' }), 'libs/test/fixtures/package.json': JSON.stringify({ name: 'fixtures' }),
    'node_modules/react/package.json': JSON.stringify({ name: 'react' })
  });
  assert.equal(pnpmNx.layout, 'workspace');
  assert.deepEqual(pnpmNx.tools, ['nx', 'pnpm', 'turborepo']);
  assert.deepEqual(summary(pnpmNx), ['api apps/api []', 'web apps/web [apps/api,libs/ui]', 'ui libs/ui []'],
    'an Nx implicit dependency and a workspace dependency both count; a negated folder and node_modules do not');
  assert.deepEqual(pnpmNx.projects.find((project) => project.id === 'web').sparseCone, ['apps/api', 'apps/web', 'libs/ui']);

  const yarn = detect({ 'package.json': JSON.stringify({ workspaces: { packages: ['packages/*'] } }),
    'packages/a/package.json': JSON.stringify({ name: 'a', devDependencies: { b: '*' } }), 'packages/b/package.json': JSON.stringify({ name: 'b' }) }, ['yarn.lock']);
  assert.deepEqual(yarn.tools, ['yarn-workspaces']);
  assert.deepEqual(summary(yarn), ['a packages/a [packages/b]', 'b packages/b []']);
  const lerna = detect({ 'lerna.json': '{}', 'packages/x/package.json': JSON.stringify({ name: 'x' }), 'packages/y/package.json': JSON.stringify({ name: 'y' }) });
  assert.deepEqual(lerna.tools, ['lerna'], 'lerna\'s default packages/* without a packages list');
  assert.deepEqual(summary(lerna), ['x packages/x []', 'y packages/y []']);
});

test('Maven modules, Gradle includes, go.work, Cargo and uv members and .NET solutions name their projects and in-repository dependencies', () => {
  const maven = detect({
    'pom.xml': '<project><!-- <module>old</module> --><modules><module>core</module><module>services</module></modules></project>',
    'core/pom.xml': '<project><parent><artifactId>root</artifactId></parent><artifactId>core</artifactId></project>',
    'services/pom.xml': '<project><artifactId>services</artifactId><modules><module>billing</module></modules></project>',
    'services/billing/pom.xml': '<project><parent><artifactId>services</artifactId></parent><artifactId>billing</artifactId><dependencies><dependency><groupId>x</groupId><artifactId>core</artifactId></dependency></dependencies></project>'
  });
  assert.deepEqual(summary(maven), ['core core []', 'billing services/billing [core]'], 'an aggregator module is a folder of projects, not one; a commented module is none');
  const gradle = detect({ 'settings.gradle.kts': 'rootProject.name = "x"\ninclude(":app", ":lib:util")\n// include(":old")\n',
    'app/build.gradle.kts': 'dependencies { implementation(project(":lib:util")) }', 'lib/util/build.gradle.kts': '' });
  assert.deepEqual(summary(gradle), ['app app [lib/util]', 'util lib/util []']);
  const goAndCargo = detect({
    'go.work': 'go 1.22\nuse (\n  ./svc/a\n  ./svc/b\n)\nuse ./tools\n', 'svc/a/go.mod': 'module example.com/svc/a', 'svc/b/go.mod': 'module b', 'tools/go.mod': 'module tools',
    'Cargo.toml': '[workspace]\nmembers = [\n "crates/*",\n]\nexclude = ["crates/old"]\n', 'crates/core/Cargo.toml': '[package]\nname = "core"\n',
    'crates/cli/Cargo.toml': '[package]\nname = "cli"\n[dependencies]\ncore = { path = "../core" }\n', 'crates/old/Cargo.toml': '[package]\nname = "old"\n'
  });
  assert.deepEqual(summary(goAndCargo), ['cli crates/cli [crates/core]', 'core crates/core []', 'a svc/a []', 'b svc/b []', 'tools tools []']);
  const dotnetAndUv = detect({
    'App.sln': 'Project("{FAE04EC0}") = "Api", "src\\Api\\Api.csproj", "{1}"\nProject("{2150E333}") = "Docs", "Docs", "{2}"\nProject("{FAE04EC0}") = "Domain", "src\\Domain\\Domain.csproj", "{3}"\n',
    'src/Api/Api.csproj': '<Project><ItemGroup><ProjectReference Include="..\\Domain\\Domain.csproj" /></ItemGroup></Project>', 'src/Domain/Domain.csproj': '<Project/>',
    'pyproject.toml': '[tool.uv.workspace]\nmembers = ["packages/*"]\n', 'packages/etl/pyproject.toml': '[project]\nname = "etl"\n'
  });
  assert.deepEqual(summary(dotnetAndUv), ['etl packages/etl []', 'api src/Api [src/Domain]', 'domain src/Domain []'], 'a solution folder is not a project');
});

test('one project is a single layout; IDs are capability IDs, unique, never reserved; manifests come only from the tree outside vendored folders', () => {
  assert.deepEqual(detect({ 'package.json': JSON.stringify({ name: 'solo' }) }), { layout: 'single', tools: [], projects: [], notes: [], truncated: false });
  const ids = detect({ 'package.json': JSON.stringify({ workspaces: ['a/*', 'b/*'] }),
    'a/web/package.json': JSON.stringify({ name: '@one/Web App' }), 'b/web/package.json': JSON.stringify({ name: '@two/web-app' }),
    'a/root/package.json': JSON.stringify({ name: 'repository-root' }) });
  assert.deepEqual(ids.projects.map((project) => project.id), ['root', 'web-app', 'web'], 'a taken name falls back to the folder');
  for (const id of ids.projects.map((project) => project.id)) assert.match(id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
  assert.deepEqual(projectManifestFiles(['a/package.json', 'node_modules/b/package.json', 'src/x.ts', 'X.sln', 'Cargo.toml', 'dist/package.json']),
    { files: ['a/package.json', 'X.sln', 'Cargo.toml'], truncated: false });
  const nested = detect({ 'package.json': JSON.stringify({ workspaces: ['apps/*', 'apps/*/e2e'] }),
    'apps/web/package.json': JSON.stringify({ name: 'web' }), 'apps/web/e2e/package.json': JSON.stringify({ name: 'web-e2e' }) });
  assert.deepEqual(nested.projects.find((project) => project.id === 'web').contains, ['apps/web/e2e']);
  assert.match(nested.notes.join(' '), /inside another project's folder/u);
});

async function monorepo(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-projects-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'shop');
  const git = (args, cwd = root) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  for (const folder of ['apps/web', 'apps/api', 'libs/ui']) await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'shop', private: true }));
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "libs/*"\n');
  await writeFile(path.join(root, 'apps/web/package.json'), JSON.stringify({ name: '@shop/web', dependencies: { '@shop/ui': 'workspace:*' } }));
  await writeFile(path.join(root, 'apps/web/index.ts'), 'export {};\n');
  await writeFile(path.join(root, 'apps/api/package.json'), JSON.stringify({ name: '@shop/api' }));
  await writeFile(path.join(root, 'libs/ui/package.json'), JSON.stringify({ name: '@shop/ui' }));
  git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'projects@example.test']); git(['config', 'user.name', 'Projects Test']);
  git(['add', '-A']); git(['commit', '-qm', 'monorepo']);
  git(['remote', 'add', 'origin', 'https://git.example/shop.git']);
  const bare = path.join(directory, 'shop.git');
  git(['clone', '-q', '--bare', root, bare], directory);
  git(['config', 'uploadpack.allowFilter', 'true'], bare);
  git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], bare);
  // A temp folder of this test's own, so another run's throwaway clone is never mistaken for one left behind.
  const temporary = path.join(directory, 'tmp');
  await mkdir(temporary);
  const cli = (...args) => spawnSync(process.execPath, [CLI, '--no-model', 'capability', 'projects', ...args],
    { cwd: directory, encoding: 'utf8', env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary } });
  return { directory, root, bare, cli, temporary };
}

test('a checkout\'s projects come with the exact map command that scopes each, to its own repository and the map\'s lead', async (t) => {
  const { root, cli } = await monorepo(t);
  const ran = cli('--path', root, '--lead', 'https://git.example/map.git', '--json');
  assert.equal(ran.status, 0, ran.stderr);
  const result = JSON.parse(ran.stdout);
  assert.equal(result.resultType, 'sflow-repository-projects');
  assert.equal(result.repository, 'https://git.example/shop.git', 'the checkout\'s own origin');
  assert.deepEqual(result.tools, ['pnpm']);
  const web = result.projects.find((project) => project.root === 'apps/web');
  assert.deepEqual(web.sharedRoots, ['libs/ui']);
  assert.equal(web.map.command, 'singularity-flow capability map web --lead https://git.example/map.git --kind delivery --repository https://git.example/shop.git '
    + '--name @shop/web --source-roots apps/web --shared-roots libs/ui --clone-mode blobless-sparse --sparse-cone apps/web,libs/ui --clone-fallback refuse --json');
  assert.equal(web.map.copilotCommand, '/sf-capability-map');
  assert.match(result.instruction, /Ask the person which of these projects to map/u);
  const text = cli('--path', root, '--lead', 'https://git.example/map.git');
  assert.match(text.stdout, /3 projects \(pnpm\)\. Each can be its own capability; nothing was mapped\./u);
  assert.match(text.stdout, /web — apps\/web \(uses libs\/ui\)/u);
});

test('a remote is read without a working tree: only its manifests are fetched, and nothing is left behind', async (t) => {
  const { bare, cli, temporary } = await monorepo(t);
  const ran = cli(pathToFileURL(bare).href, '--json');
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const result = JSON.parse(ran.stdout);
  assert.deepEqual(result.projects.map((project) => `${project.id} ${project.root}`), ['api apps/api', 'web apps/web', 'ui libs/ui']);
  assert.ok(result.projects.every((project) => project.map.command.includes(`--repository ${pathToFileURL(bare).href}`)));
  assert.deepEqual((await readdir(temporary)).filter((name) => name.startsWith('sflow-repository-projects-')), [], 'the throwaway clone is removed');
});

test('a wrong form or a folder outside Git is refused with what to run', async (t) => {
  const { directory, root, cli } = await monorepo(t);
  for (const args of [['https://git.example/shop.git', '--path', root, '--json'], ['--json'], ['--path', root, '--branch', 'main', '--json'], ['--path', root, '--force', '--json']]) {
    const refused = cli(...args);
    assert.notEqual(refused.status, 0, args.join(' '));
    assert.equal(JSON.parse(refused.stdout).error.code, 'CAPABILITY_PROJECTS_USAGE', args.join(' '));
  }
  const outside = path.join(directory, 'plain');
  await mkdir(outside);
  const refused = cli('--path', outside, '--json');
  assert.equal(JSON.parse(refused.stdout).error.code, 'REPOSITORY_PROJECTS_NOT_A_CHECKOUT');
});

test('from a remote only the trees and then exactly the manifest blobs come over the network, never a source file', async (t) => {
  const { bare } = await monorepo(t);
  const calls = [];
  const read = await remoteProjectFiles(pathToFileURL(bare).href, { runRemoteCommand: async (args, options) => {
    const outcome = await runRemoteGitAsync(args, options);
    calls.push({ verb: args.find((arg) => ['clone', 'fetch'].includes(arg)), blobs: args.filter((arg) => /^[a-f0-9]{40,64}$/u.test(arg)).length, filtered: args.includes('--filter=blob:none') });
    return outcome;
  } });
  assert.deepEqual(calls, [{ verb: 'clone', blobs: 0, filtered: true }, { verb: 'fetch', blobs: 5, filtered: true }]);
  assert.deepEqual([...read.text.keys()].sort(), ['apps/api/package.json', 'apps/web/package.json', 'libs/ui/package.json', 'package.json', 'pnpm-workspace.yaml']);
  assert.ok(read.files.includes('apps/web/index.ts') && !read.text.has('apps/web/index.ts'), 'listed, never read');
});
