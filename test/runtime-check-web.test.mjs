/**
 * The web runtime check (step intents spec §12.3) on self-contained pages served on a loopback port: a graph that
 * resizes on every keystroke (Story arshy's defect) and a button whose handler throws must be blocking findings
 * (breaks use); a page whose only problems are of style gets advice at most. Needs the pinned review browser; a
 * machine without it skips, as the application review's browser test does.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { driveWebApplication, sampleText, sizeChanges } from '../src/runtime-check-web.mjs';

const GRAPH = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Grapher</title>
<label>Formula <input id="formula" aria-label="Formula"></label>
<button id="plot" type="button">Plot</button>
<div class="graph-area"><svg id="graph" width="400" height="300"><path d="M0 150 L400 150" stroke="black"/></svg></div>
<p id="status"></p>
<script>
const graph = document.querySelector('#graph');
document.querySelector('#formula').addEventListener('input', (event) => {
  // The defect: the graph's size follows the formula's length.
  graph.setAttribute('width', String(400 + event.target.value.length * 12));
  graph.setAttribute('height', String(300 + event.target.value.length * 6));
});
document.querySelector('#plot').addEventListener('click', () => { document.querySelector('#status').textContent = 'Plotting'; null.plot(); });
</script></html>`;

const STYLE_ONLY = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Notes</title>
<style>body{font-family:Comic Sans MS;color:#999;background:#eee} button{border:3px dashed red}</style>
<label>Note <input id="note"></label>
<button id="save" type="button">Save</button>
<div class="chart"><canvas id="chart" width="320" height="200" style="width:320px;height:200px"></canvas></div>
<p id="saved"></p>
<script>
document.querySelector('#save').addEventListener('click', () => { document.querySelector('#saved').textContent = 'Saved ' + document.querySelector('#note').value; });
</script></html>`;

async function serve(t, html) {
  const server = createServer((request, response) => {
    if (request.url === '/' || request.url === '/index.html') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); return; }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  return `http://127.0.0.1:${server.address().port}/`;
}

const unavailable = (result) => result.status === 'not-available' && /Executable doesn't exist|browser/iu.test(result.missing[0]?.why ?? '');

test('typing into a formula that resizes the graph, and a button that throws, are blocking findings with screenshots at three widths', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-rc-web-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await driveWebApplication(await serve(t, GRAPH), { screenshotDirectory: directory });
  if (unavailable(result)) return t.skip('The pinned review browser is not installed here: run singularity-flow app-review browser install');
  assert.equal(result.status, 'ran');
  const shift = result.findings.find((finding) => finding.type === 'layout-shift');
  assert.ok(shift, JSON.stringify(result.findings));
  assert.equal(shift.class, 'breaks-use');
  assert.match(shift.title, /svg#graph changes size while the page is used/u);
  assert.match(shift.detail, /typing "Sam" into Formula: 400×300 became 436×318/u);
  const thrown = result.findings.find((finding) => finding.type === 'page-error');
  assert.equal(thrown?.class, 'breaks-use');
  assert.match(thrown.detail, /while clicking "Plot"/u);
  assert.deepEqual(result.screenshots.map((shot) => shot.width), [390, 1280, 1920]);
  for (const shot of result.screenshots) assert.ok((await stat(shot.path)).size > 100);
  assert.deepEqual(result.ran.slice(0, 2), ['load the page', 'screenshots at 390px, 1280px, 1920px']);
});

test('a page whose only problems are of style gets no blocking finding', { timeout: 120_000 }, async (t) => {
  const result = await driveWebApplication(await serve(t, STYLE_ONLY));
  if (unavailable(result)) return t.skip('The pinned review browser is not installed here: run singularity-flow app-review browser install');
  assert.equal(result.status, 'ran');
  assert.deepEqual(result.findings.filter((finding) => finding.class === 'breaks-use'), [], JSON.stringify(result.findings));
  assert.equal(result.observed.inputs, 1);
  assert.equal(result.observed.controls, 1);
});

test('a browser that cannot start makes the check not available, naming what to install; it never fails the step', async () => {
  const result = await driveWebApplication('http://127.0.0.1:9/', { launch: async () => { throw new Error("browserType.launch: Executable doesn't exist at /x"); } });
  assert.equal(result.status, 'not-available');
  assert.deepEqual(result.missing.map((entry) => entry.command), ['singularity-flow app-review browser install']);
  assert.deepEqual(result.findings, []);
});

test('size changes count above the threshold only, and each input type gets a sample it accepts', () => {
  const before = { sizes: [{ key: 'svg', what: 'svg', width: 400, height: 300 }, { key: 'img', what: 'img', width: 200, height: 100 }] };
  const after = { sizes: [{ key: 'svg', what: 'svg', width: 403, height: 300 }, { key: 'img', what: 'img', width: 200, height: 140 }] };
  assert.deepEqual(sizeChanges(before, after).map((change) => change.key), ['img']);
  assert.deepEqual(sampleText('number'), ['12', '345']);
  assert.deepEqual(sampleText(null), ['Sam', 'ple text 123']);
});
