/**
 * The runtime check end to end (step intents spec §12.3, D6), on self-contained repositories with planted defects:
 * a backend that answers 500 to bad input and logs the exception, and whose OpenAPI file lost an operation; a CLI
 * that exits 0 on an argument it does not accept; a library that dropped an export; and a web app whose graph resizes
 * on every keystroke. Each must be a breaks-use finding. A change with no defect gets none, and a check that cannot
 * run here (no start entry) says what is missing and blocks nothing. Run & Test's start entries start and stop the
 * apps; nothing reaches the network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeApplicationReview } from '../src/application-review-contract.mjs';
import { readRuntimeCheck, runRuntimeCheck, runtimeCheckForReview, runtimeCheckWords, runtimeFindings, runtimeTryIt } from '../src/runtime-check.mjs';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A Git repository from `{ path: text }` at two commits: `base`, then `head` on top; returns `{ root, base }`. */
async function repository(t, base, head = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-runtime-check-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q', '-b', 'main');
  const write = async (files) => { for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); } };
  await write(base);
  git('add', '.'); git('-c', 'user.name=Runtime Tester', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'base');
  const baseCommit = git('rev-parse', 'HEAD');
  if (Object.keys(head).length) {
    await write(head);
    git('add', '.'); git('-c', 'user.name=Runtime Tester', '-c', 'user.email=runtime@example.invalid', 'commit', '-qm', 'the change');
  }
  return { root, base: baseCommit };
}

const capabilities = (entry) => JSON.stringify({ version: 1, capabilities: { app: { kind: 'delivery', repository: 'app', application: { start: entry ? [entry] : [] } } } });
const story = (base, sourcePaths, mode = 'optional') => ({ workItem: { id: 'RT-1', baseCommit: base }, currentPhase: 'implement', phaseOrder: ['implement'],
  phases: { implement: { id: 'implement', status: 'in_progress', generation: 1, generationPolicy: { task: 'code', requirement: 'required' }, deliveryEvidence: { sourcePaths } } },
  resolution: { applicationReview: normalizeApplicationReview({ mode }) } });
const breaking = (capture) => runtimeFindings(capture).filter((finding) => finding.class === 'breaks-use');

const SERVER = (port) => `import http from 'node:http';
const routes = [];
const app = { get: (route, handler) => routes.push(['GET', route, handler]), post: (route, handler) => routes.push(['POST', route, handler]) };
app.get('/health', (request, response) => response.end('ok'));
app.post('/items', (request, response, body) => {
  // The defect: the body is parsed with no check, so bad input is a 500.
  const item = JSON.parse(body);
  response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 1, name: item.name }));
});
app.get('/items/:id', (request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"id":1,"name":"sample"}'); });
http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const route = routes.find(([method, pattern]) => method === request.method && new RegExp('^' + pattern.replace(/:\\w+/g, '[^/]+') + '$').test(request.url));
    if (!route) { response.writeHead(404); response.end(); return; }
    try { route[2](request, response, body); }
    catch (error) { console.error(error.stack); response.writeHead(500); response.end('Internal Server Error'); }
  });
}).listen(${port}, '127.0.0.1', () => console.log('Listening on ${port}'));
`;
const OPENAPI = (withDelete) => `openapi: 3.0.3
info: { title: Items, version: 1.0.0 }
paths:
  /items:
    post:
      requestBody:
        content:
          application/json:
            schema: { type: object, required: [name], properties: { name: { type: string } } }
      responses: { '201': { description: created }, '400': { description: bad input } }
  /items/{id}:
    get:
      responses: { '200': { description: one item } }
${withDelete ? `    delete:
      responses: { '204': { description: gone } }
` : ''}`;

test('a backend that answers 500 to bad input, logs the exception and lost an API operation: blocking findings, with ready requests to try it', { timeout: 120_000 }, async (t) => {
  const port = await freePort();
  const entry = { id: 'api', argv: ['node', 'server.mjs'], workingDirectory: '.', url: `http://127.0.0.1:${port}/`, ready: { http: '/health', timeoutMs: 20000 } };
  const { root, base } = await repository(t,
    { 'package.json': JSON.stringify({ name: 'items', private: true, scripts: { start: 'node server.mjs' }, dependencies: { express: '4.0.0' } }),
      'openapi.yaml': OPENAPI(true), 'server.mjs': 'export {};\n', 'singularity/capabilities.yml': capabilities(entry) },
    { 'server.mjs': SERVER(port), 'openapi.yaml': OPENAPI(false) });
  const workflow = story(base, ['server.mjs', 'openapi.yaml']);
  const capture = await runRuntimeCheck(root, {}, workflow, 'implement');
  const [check] = capture.checks;
  assert.equal(check.kind, 'backend');
  assert.equal(check.status, 'ran', JSON.stringify(check.missing));
  const types = breaking(capture).map((finding) => finding.type).sort();
  assert.deepEqual(types, ['contract-removed', 'exception-in-log', 'server-error-on-bad-input'], JSON.stringify(runtimeFindings(capture), null, 1));
  const bad = runtimeFindings(capture).find((finding) => finding.type === 'server-error-on-bad-input');
  assert.match(bad.title, /^POST \/items answered 500 to a malformed JSON body$/u);
  assert.match(bad.id, /^RT-\d{3}$/u);
  assert.equal(bad.where.file, 'server.mjs');
  assert.ok(check.observed.calls.some((call) => call.endpoint === 'POST /items' && call.input === 'valid' && call.status === 201), 'the valid call succeeds');
  const [tryIt] = runtimeTryIt(capture);
  assert.equal(tryIt.kind, 'backend');
  assert.ok(tryIt.requests.includes(`curl -i -X POST 'http://127.0.0.1:${port}/items' -H 'content-type: application/json' -d '{"name":"sample"}'`), tryIt.requests.join('\n'));
  // Kept for this version: the review and "Try it" read it again without running anything.
  assert.equal((await readRuntimeCheck(root, workflow, 'implement')).id, capture.id);
  assert.equal((await runRuntimeCheck(root, {}, workflow, 'implement')).finishedAt, capture.finishedAt, 'the same version is not checked twice');
  const review = runtimeCheckForReview(await readRuntimeCheck(root, workflow, 'implement'));
  assert.equal(review.checks[0].findings.find((finding) => finding.type === 'server-error-on-bad-input').use, 'breaks-use');
  assert.match(review.guidance, /runtimeFinding/u);
  assert.match(runtimeCheckWords(capture), /^Runtime check: ran backend; 3 findings that break use, \d+ advice\.$/u);
  // The kind is not confirmed yet: the capture carries the one line a person answers.
  assert.match(capture.kinds.question, /SFlow sees this repository as a backend \(API or service\) \(express in package\.json/u);
});

test('a command-line tool that exits 0 on an argument it does not accept is a blocking finding', { timeout: 60_000 }, async (t) => {
  const tool = "const [option] = process.argv.slice(2);\nif (option === '--help') { console.log('Usage: tool [--name NAME]'); process.exit(0); }\nif (option && option !== '--name') { console.log('unknown option ' + option); process.exit(0); }\nconsole.log('hello');\n";
  const { root, base } = await repository(t,
    { 'package.json': JSON.stringify({ name: 'tool', version: '1.0.0', bin: { tool: 'bin/tool.mjs' }, dependencies: { commander: '12.0.0' } }), 'bin/tool.mjs': 'console.log("hello");\n' },
    { 'bin/tool.mjs': tool });
  const capture = await runRuntimeCheck(root, {}, story(base, ['bin/tool.mjs']), 'implement');
  assert.equal(capture.checks[0].kind, 'cli');
  assert.deepEqual(breaking(capture).map((finding) => [finding.type, finding.title]), [['exit-zero-on-bad-argument', 'tool exits 0 for an argument it does not accept']]);
  assert.deepEqual(runtimeTryIt(capture)[0].commands, ['node bin/tool.mjs --help']);
});

test('a library that dropped an export and needs more arguments is a breaking change; the same with a major version is advice', async (t) => {
  const before = 'export function add(a, b) { return a + b; }\nexport function sub(a, b) { return a - b; }\n';
  const after = 'export function add(a, b, c) { return a + b + c; }\n';
  const manifest = (version) => JSON.stringify({ name: '@acme/math', version, type: 'module', main: 'src/index.js', exports: './src/index.js' });
  const minor = await repository(t, { 'package.json': manifest('1.2.0'), 'src/index.js': before }, { 'package.json': manifest('1.3.0'), 'src/index.js': after });
  const capture = await runRuntimeCheck(minor.root, {}, story(minor.base, ['src/index.js', 'package.json']), 'implement');
  assert.equal(capture.checks[0].kind, 'library');
  assert.deepEqual(breaking(capture).map((finding) => finding.title), ['add now needs 3 arguments (it needed 2)', 'sub is no longer exported']);
  const major = await repository(t, { 'package.json': manifest('1.2.0'), 'src/index.js': before }, { 'package.json': manifest('2.0.0'), 'src/index.js': after });
  const declared = await runRuntimeCheck(major.root, {}, story(major.base, ['src/index.js', 'package.json']), 'implement');
  assert.deepEqual(breaking(declared), []);
  assert.deepEqual(runtimeFindings(declared).map((finding) => finding.class), ['improvement', 'improvement']);
});

test('a change with no defect gets no finding, and a check that cannot run says what is missing and blocks nothing', async (t) => {
  const lib = 'export function add(a, b) { return a + b; }\n';
  const clean = await repository(t, { 'package.json': JSON.stringify({ name: '@acme/math', version: '1.0.0', main: 'src/index.js' }), 'src/index.js': lib },
    { 'src/index.js': `${lib}// faster now\n` });
  assert.deepEqual(runtimeFindings(await runRuntimeCheck(clean.root, {}, story(clean.base, ['src/index.js']), 'implement')), []);
  // A web app with no saved start entry: not available, naming the route that saves one.
  const web = await repository(t, { 'package.json': JSON.stringify({ name: 'grapher', private: true, dependencies: { react: '18.0.0' } }), 'src/App.jsx': 'export default 1;\n',
    'singularity/capabilities.yml': capabilities(null) }, { 'src/App.jsx': 'export default 2;\n' });
  const capture = await runRuntimeCheck(web.root, {}, story(web.base, ['src/App.jsx']), 'implement');
  assert.equal(capture.checks[0].kind, 'web');
  assert.equal(capture.checks[0].status, 'not-available');
  assert.deepEqual(capture.checks[0].missing.map((entry) => entry.command), ['singularity-flow app suggest --json']);
  assert.match(runtimeCheckWords(capture), /could not run here; 0 findings that break use, 0 advice; missing here: a saved start entry\./u);
  // Off while the Story does not adopt it.
  assert.equal((await runRuntimeCheck(web.root, {}, story(web.base, ['src/App.jsx'], 'off'), 'implement')).status, 'off');
});

const GRAPH = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Grapher</title>
<label>Formula <input id="formula" aria-label="Formula"></label>
<svg id="graph" width="400" height="300"></svg>
<script>document.querySelector('#formula').addEventListener('input', (event) => { document.querySelector('#graph').setAttribute('width', String(400 + event.target.value.length * 12)); });</script></html>`;

test('a web app whose graph resizes while the person types: the app is started from its start entry, driven, stopped, and the jump is a blocking finding', { timeout: 120_000 }, async (t) => {
  const port = await freePort();
  const serve = `import http from 'node:http';\nimport { readFileSync } from 'node:fs';\nhttp.createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(readFileSync('index.html')); }).listen(${port}, '127.0.0.1');\n`;
  const entry = { id: 'web', argv: ['node', 'serve.mjs'], workingDirectory: '.', url: `http://127.0.0.1:${port}/`, ready: { http: '/', timeoutMs: 20000 } };
  const { root, base } = await repository(t, { 'package.json': JSON.stringify({ name: 'grapher', private: true, dependencies: { react: '18.0.0' } }), 'serve.mjs': serve,
    'index.html': '<!doctype html><title>Grapher</title>', 'src/Graph.jsx': 'export default 1;\n', 'singularity/capabilities.yml': capabilities(entry) },
  { 'index.html': GRAPH, 'src/Graph.jsx': 'export default 2;\n' });
  const capture = await runRuntimeCheck(root, {}, story(base, ['index.html', 'src/Graph.jsx']), 'implement');
  const [check] = capture.checks;
  if (check.status === 'not-available' && /browser/u.test(check.missing?.[0]?.what ?? '')) return t.skip('The pinned review browser is not installed here: run singularity-flow app-review browser install');
  assert.equal(check.status, 'ran', JSON.stringify(check.missing));
  assert.deepEqual(breaking(capture).map((finding) => finding.type), ['layout-shift']);
  assert.equal(check.screenshots.length, 3);
  assert.equal(runtimeTryIt(capture)[0].url, `http://127.0.0.1:${port}/`);
  // SFlow stopped the app it started.
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }));
  assert.ok((await readFile(check.screenshots[0].path)).subarray(1, 4).toString() === 'PNG');
});
