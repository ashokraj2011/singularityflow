/**
 * The kind of software each project is, from its committed files (step intents spec §12.1): web, backend, job, cli,
 * library, mobile or artifact. A report only: these fixtures pin what each kind is read from.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { detectSoftwareKinds, SOFTWARE_KINDS, softwareKindTextFiles } from '../src/software-kinds.mjs';

const json = (value) => JSON.stringify(value);
/** A repository from `{ path: text }`; a null text is a file whose text is not read. */
const repository = (entries) => {
  const files = Object.keys(entries);
  const wanted = new Set(softwareKindTextFiles(files).files);
  const text = new Map(Object.entries(entries).filter(([file, body]) => body != null && wanted.has(file)));
  return detectSoftwareKinds({ files, text });
};
const kindOf = (entries) => {
  const { projects } = repository(entries);
  assert.equal(projects.length, 1);
  return [projects[0].kind, projects[0].confidence];
};

const pom = (dependencies, extra = '') => `<project><artifactId>orders</artifactId>${extra}<dependencies>${dependencies
  .map((artifact) => `<dependency><groupId>org.springframework.boot</groupId><artifactId>${artifact}</artifactId></dependency>`).join('')}</dependencies></project>`;

test('the kinds, in the order a tie is settled', () => {
  assert.deepEqual(SOFTWARE_KINDS, ['mobile', 'web', 'backend', 'job', 'cli', 'artifact', 'library']);
});

test('a Java service, a batch job and a command-line tool, from their build files', () => {
  const service = repository({ 'pom.xml': pom(['spring-boot-starter-web']), 'src/main/java/Orders.java': null, 'api/openapi.yaml': null });
  assert.deepEqual([service.layout, service.projects[0].id, service.projects[0].kind, service.projects[0].confidence], ['single', 'repository-root', 'backend', 'certain']);
  assert.deepEqual(service.projects[0].signals, ['spring-boot-starter-web in pom.xml', 'an OpenAPI file']);
  assert.deepEqual(kindOf({ 'pom.xml': pom(['spring-boot-starter-batch']) }), ['job', 'certain']);
  assert.deepEqual(kindOf({ 'build.gradle.kts': 'dependencies { implementation("info.picocli:picocli:4.7.5") }' }), ['cli', 'certain']);
  assert.deepEqual(kindOf({ 'app/build.gradle': "plugins { id 'com.android.application' }", 'app/src/main/AndroidManifest.xml': null }), ['mobile', 'certain']);
  // Server-rendered pages are web; the service beside them is named too.
  const pages = repository({ 'pom.xml': pom(['spring-boot-starter-web', 'spring-boot-starter-thymeleaf']) }).projects[0];
  assert.deepEqual([pages.kind, pages.also], ['web', ['backend']]);
});

test('Node, Python, Go, Rust and .NET projects', () => {
  assert.deepEqual(kindOf({ 'package.json': json({ private: true, dependencies: { react: '18', 'react-dom': '18' } }), 'src/App.tsx': null }), ['web', 'certain']);
  assert.deepEqual(kindOf({ 'package.json': json({ scripts: { start: 'node server.js' }, dependencies: { express: '4' } }) }), ['backend', 'certain']);
  assert.deepEqual(kindOf({ 'package.json': json({ name: 'tool', bin: { tool: 'bin/tool.js' }, dependencies: { commander: '12' } }) }), ['cli', 'certain']);
  assert.deepEqual(kindOf({ 'package.json': json({ name: 'shared', main: 'index.js' }) }), ['library', 'likely']);
  assert.deepEqual(kindOf({ 'package.json': json({ dependencies: { 'react-native': '0.74' } }) }), ['mobile', 'certain']);
  assert.deepEqual(kindOf({ 'requirements.txt': 'fastapi==0.110\nuvicorn\n' }), ['backend', 'certain']);
  assert.deepEqual(kindOf({ 'pyproject.toml': '[project]\nname = "tool"\ndescription = "Click the button to run it"\n[project.scripts]\ntool = "tool:main"\n' }), ['cli', 'certain']);
  assert.deepEqual(kindOf({ 'pyproject.toml': '[project]\nname = "lib"\ndescription = "Click the button"\n' }), ['library', 'likely'], 'a word in prose is no dependency');
  const host = ['github', 'com'].join('.');
  assert.deepEqual(kindOf({ 'go.mod': `module example.com/tool\nrequire ${host}/spf13/cobra v1.8.0\n`, 'main.go': null }), ['cli', 'certain']);
  assert.deepEqual(repository({ 'go.mod': `module example.com/tool\nrequire ${host}/spf13/cobra v1.8.0\n`, 'main.go': null }).projects[0].signals,
    ['spf13/cobra in go.mod']);
  assert.deepEqual(kindOf({ 'go.mod': 'module example.com/lib\n', 'lib.go': null }), ['library', 'likely']);
  assert.deepEqual(kindOf({ 'Cargo.toml': '[package]\nname = "srv"\n[dependencies]\naxum = "0.7"\n', 'src/main.rs': null }), ['backend', 'certain']);
  assert.deepEqual(kindOf({ 'Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' }), ['backend', 'certain']);
});

test('infrastructure, migrations and docs are artifacts; a repository with nothing to read says it cannot tell', () => {
  assert.deepEqual(kindOf({ 'infra/main.tf': null, 'infra/variables.tf': null }), ['artifact', 'likely']);
  assert.deepEqual(kindOf({ 'db/migration/V1__init.sql': null }), ['artifact', 'likely']);
  const nothing = repository({ 'README.md': null });
  assert.deepEqual([nothing.projects[0].kind, nothing.projects[0].confidence], [null, 'unclear']);
  assert.deepEqual(nothing.notes, ['SFlow could not tell the kind of every project from its files.']);
  // A service with its infrastructure beside it is a service.
  assert.deepEqual(kindOf({ 'pom.xml': pom(['spring-boot-starter-web']), 'deploy/main.tf': null }), ['backend', 'certain']);
});

test('a monorepo has one kind per declared project, and installed folders are never read', () => {
  const result = repository({
    'package.json': json({ private: true, workspaces: ['apps/*', 'packages/*'] }),
    'apps/web/package.json': json({ name: '@acme/web', private: true, dependencies: { next: '14', react: '18' } }),
    'apps/web/pages/index.tsx': null,
    'apps/api/package.json': json({ name: '@acme/api', private: true, scripts: { start: 'node .' }, dependencies: { fastify: '4' } }),
    'packages/ui/package.json': json({ name: '@acme/ui', main: 'index.js' }),
    'node_modules/react/package.json': json({ name: 'react', main: 'index.js' })
  });
  assert.equal(result.layout, 'workspace');
  assert.deepEqual(result.projects.map((project) => [project.id, project.root, project.kind]),
    [['api', 'apps/api', 'backend'], ['web', 'apps/web', 'web'], ['ui', 'packages/ui', 'library']]);
  assert.ok(!softwareKindTextFiles(['node_modules/x/requirements.txt', 'svc/requirements-dev.txt']).files.includes('node_modules/x/requirements.txt'));
  assert.ok(softwareKindTextFiles(['svc/requirements-dev.txt']).files.includes('svc/requirements-dev.txt'));
});
