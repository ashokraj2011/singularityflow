/**
 * The workflow drawn as the graph it already is.
 *
 * `workflow.yml` has always carried a DAG: `implementation-spec` declares `inputs: [requirements,
 * design]` and `conformance` declares three. The phase rail in the designer draws one arrow per
 * phase, which can express exactly one predecessor — so it has been silently flattening the
 * structure since it was written. This is the view that stops doing that.
 *
 * Driven against the shipped configuration rather than a fixture, because the claim worth testing is
 * that the real workflows contain structure the old view could not show.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { readFile } from 'node:fs/promises';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelUrl = pathToFileURL(path.join(packageRoot, 'apps/vscode/src/views/workflow-graph-model.ts')).href;
const svgUrl = pathToFileURL(path.join(packageRoot, 'apps/vscode/src/views/workflow-graph-svg.ts')).href;

/** Run against the shipped workflow, shaped the way the snapshot presents it. */
function drive(body) {
  const source = `
    import { buildWorkflowGraph, graphableWorkTypes } from ${JSON.stringify(modelUrl)};
    import { renderWorkflowGraph } from ${JSON.stringify(svgUrl)};
    import YAML from 'yaml';
    import { readFileSync } from 'node:fs';
    const definition = YAML.parse(readFileSync(${JSON.stringify(path.join(packageRoot, 'templates/workflow.yml'))}, 'utf8'));
    const snapshot = { definition };
    ${body}
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source], {
    encoding: 'utf8', cwd: packageRoot, timeout: 60_000
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('the shipped workflows contain structure a rail cannot draw', async () => {
  /**
   * The justification for the whole view, asserted against real configuration. If no phase ever had
   * two inputs, a linear rail would be a faithful rendering and this would be decoration.
   */
  const source = YAML.parse(await readFile(path.join(packageRoot, 'templates/workflow.yml'), 'utf8'));
  const multiParent = Object.entries(source.workTypes)
    .flatMap(([id, workType]) => Object.entries(workType.phaseOverrides ?? {})
      .filter(([, phase]) => (phase.inputs ?? []).length > 1)
      .map(([phaseId, phase]) => `${id}/${phaseId} needs ${phase.inputs.length}`));
  assert.ok(multiParent.length >= 4, `expected multi-input phases in the shipped config, found ${multiParent.length}`);
});

test('a phase sits below every input it declares, not just the first', () => {
  // Longest-path layering. Shortest path would place `implementation-spec` beside `design`, which
  // reads as "these can run together" — the precise misreading this view exists to prevent.
  const graph = drive(`process.stdout.write(JSON.stringify(buildWorkflowGraph(snapshot, 'feature')));`);
  const depth = new Map(graph.nodes.map((node) => [node.id, node.depth]));
  for (const edge of graph.edges.filter((entry) => entry.kind === 'input')) {
    assert.ok(depth.get(edge.to) > depth.get(edge.from),
      `${edge.to} (layer ${depth.get(edge.to)}) is not below its input ${edge.from} (layer ${depth.get(edge.from)})`);
  }
  assert.equal(graph.cycle, null);
});

test('rejecting a phase back to itself is a property, not an edge', () => {
  /**
   * The shipped config gives most phases a `rejectTo` that includes themselves — "redo it here".
   * Drawn literally that is fifteen self-loops burying the eleven edges that carry the structure, so
   * it is recorded on the node instead. Discarding the fact would be the other error.
   */
  const graph = drive(`process.stdout.write(JSON.stringify(buildWorkflowGraph(snapshot, 'feature')));`);
  assert.deepEqual(graph.edges.filter((edge) => edge.from === edge.to), [], 'a self-loop was drawn as an edge');
  assert.ok(graph.nodes.some((node) => node.canRedo), 'the redo fact was dropped rather than moved');
  // Genuine backward edges survive: those are real transitions to somewhere else.
  assert.ok(graph.edges.some((edge) => edge.kind === 'rework'), 'no rework edge survived');
});

test('an input naming a phase this work type does not run is not drawn', () => {
  // Phases are shared across work types, so a phase can declare an input the current workflow has
  // no node for. Drawing it would invent a phase this workflow never runs.
  const graph = drive(`
    snapshot.definition.workTypes.tiny = { label: 'Tiny', phases: ['intake', 'requirements'],
      phaseOverrides: { requirements: { inputs: ['intake', 'design'] } } };
    process.stdout.write(JSON.stringify(buildWorkflowGraph(snapshot, 'tiny')));`);
  assert.deepEqual(graph.nodes.map((node) => node.id), ['intake', 'requirements']);
  assert.deepEqual(graph.edges.filter((edge) => edge.kind === 'input'), [{ from: 'intake', to: 'requirements', kind: 'input' }]);
});

test('a cycle is reported rather than drawn as a workflow that could run', () => {
  // The engine's phase order is linear so this should be unreachable, but a layout that recursed
  // forever on malformed configuration would hang the panel rather than fail it.
  const graph = drive(`
    snapshot.definition.workTypes.loop = { label: 'Loop', phases: ['a', 'b'],
      phaseOverrides: { a: { inputs: ['b'] }, b: { inputs: ['a'] } } };
    process.stdout.write(JSON.stringify(buildWorkflowGraph(snapshot, 'loop')));`);
  assert.ok(graph.cycle?.length, 'a circular workflow was laid out as though it were runnable');
});

test('every node lands inside the canvas, and none overlaps another', () => {
  /**
   * The layout is arithmetic, so it is checked as arithmetic. Two nodes sharing a rectangle is the
   * failure a reader notices immediately and a snapshot test would happily record forever.
   */
  const boxes = drive(`
    const out = {};
    for (const id of graphableWorkTypes(snapshot)) {
      const svg = renderWorkflowGraph(buildWorkflowGraph(snapshot, id));
      const view = svg.match(/viewBox="0 0 ([\\d.]+) ([\\d.]+)"/).slice(1).map(Number);
      const rects = [...svg.matchAll(/<rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)"/g)]
        .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
      out[id] = { view, rects };
    }
    process.stdout.write(JSON.stringify(out));`);

  for (const [id, { view, rects }] of Object.entries(boxes)) {
    assert.ok(rects.length, `${id} drew no nodes`);
    for (const rect of rects) {
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= view[0] && rect.y + rect.h <= view[1],
        `${id} places a node outside its canvas`);
    }
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const [a, b] = [rects[i], rects[j]];
        assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h),
          `${id} overlaps two phase nodes`);
      }
    }
  }
});

test('the drawing runs no script, because it is a read-only view', async () => {
  // The webview CSP is `default-src 'none'`; more to the point, a diagram of governed configuration
  // has no reason to execute anything.
  const svg = drive(`process.stdout.write(JSON.stringify(renderWorkflowGraph(buildWorkflowGraph(snapshot, 'feature'))));`);
  for (const forbidden of ['<script', 'onclick', 'javascript:']) {
    assert.ok(!svg.includes(forbidden), `the graph emits ${forbidden}`);
  }
  // Styles live in the shared nonce'd stylesheet, so the markup carries no inline <style> the CSP
  // would silently drop.
  assert.ok(!svg.includes('<style'), 'the graph inlines a style block the CSP will block');
});
