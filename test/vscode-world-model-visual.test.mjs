import test from 'node:test';
import assert from 'node:assert/strict';
import { configurationCenterView } from '../apps/vscode/src/views/configuration-center-model.ts';
import { worldModelVisualGraphs, selectVisualGraph, layoutVisualGraph } from '../apps/vscode/src/views/world-model-visual-model.ts';
import { worldModelVisualization, WORLD_MODEL_VISUAL_SCRIPT, WORLD_MODEL_VISUAL_STYLES } from '../apps/vscode/src/views/world-model-visual-page.ts';
import { configurationCenterHtml, CONFIGURATION_CENTER_SCRIPT } from '../apps/vscode/src/views/configuration-center-page.ts';
import { page } from '../apps/vscode/src/views/webview.ts';

export function visualFixture() {
  const digest = 'a'.repeat(64);
  return configurationCenterView({
    definition: { worldModel: { format: 'registered-v4', views: ['arch.contracts@4', 'dev.impact@4', 'biz.rules@4'],
      projections: { 'arch.calm': { enabled: true } } } },
    worldModel: {
      root: 'singularity/world-model', format: 'wmb-v4', status: 'ready', generatedAt: '2026-10-08T04:34:43Z',
      authority: { ref: 'origin/state', commit: 'd4c6a92'.repeat(5), manifestSha256: digest },
      source: { status: 'fresh', fresh: true }, summary: { facts: 42, evidence: 80, derivations: 12 },
      views: ['arch.contracts', 'dev.impact', 'biz.rules'].map((id) => ({
        id, status: 'available', references: [], path: `views/${id}.md`,
        counts: { total: 14, available: 12, partial: 1, unavailable: 1, contradicted: 0, stale: 0 },
        expansion: [{ kind: 'view', id, sha256: digest, ref: `sfref:world-model:view:${id}:${digest}` }]
      })),
      workflows: [{ id: 'web', label: 'Web delivery', mode: 'optional', phases: [
        { id: 'specification', label: 'Specification', views: ['biz.rules'], depth: 'brief', source: 'shared-phase' },
        { id: 'planning', label: 'Planning', views: ['arch.contracts', 'dev.impact'], depth: 'full', source: 'workflow-override' },
        { id: 'implementation', label: 'Implementation', views: ['dev.impact'], depth: 'full', source: 'shared-phase' }
      ] }, { id: 'off', label: 'Offline workflow', mode: 'off', phases: [
        { id: 'planning', label: 'Planning', views: ['arch.contracts'], depth: 'brief', source: 'disabled' }
      ] }],
      projections: [{ id: 'arch.calm', version: 1, status: 'available', required: false, sha256: digest,
        counts: { nodes: 5, interfaces: 2, relationships: 5, controls: 2, flows: 1, unavailable: 1, contradictions: 0 },
        nodes: [
          { id: 'reviewer', name: 'Engineering reviewer', type: 'actor', layer: 'governance', status: 'declared-only' },
          { id: 'web', name: 'Web application', type: 'webclient', layer: 'delivery', status: 'confirmed', sources: [{ kind: 'capability', reference: 'singularity/capabilities.yml', assurance: 'human-confirmed' }], sourceCount: 2 },
          { id: 'api', name: 'Order service', type: 'service', layer: 'delivery', status: 'observed-only' },
          { id: 'data', name: 'Order database', type: 'database', layer: 'delivery', status: 'confirmed' },
          { id: 'payments', name: 'Payment provider', type: 'service', layer: 'external', status: 'declared-only' }
        ],
        relationships: [
          { id: 'review', kind: 'interacts', source: 'reviewer', destinations: ['web'], status: 'declared-only' },
          { id: 'calls', kind: 'connects', source: 'web', destinations: ['api'], status: 'confirmed' },
          { id: 'store', kind: 'connects', source: 'api', destinations: ['data'], status: 'confirmed' },
          { id: 'pay', kind: 'connects', source: 'api', destinations: ['payments'], status: 'declared-only' },
          { id: 'return', kind: 'connects', source: 'api', destinations: ['web'], status: 'observed-only' }
        ], expansion: { kind: 'projection', id: 'arch.calm', sha256: digest, ref: `sfref:world-model:projection:arch.calm:${digest}` }
      }]
    }
  }, { name: 'Casey', role: 'architect' });
}
const filters = (overrides = {}) => ({ query: '', group: '', status: '', workflow: '', selected: null, neighbors: false, ...overrides });

test('visual maps retain exact routing, overrides, record references and component provenance', () => {
  const [knowledge, calm] = worldModelVisualGraphs(visualFixture());
  assert.equal(knowledge.edges.length, 4);
  assert.equal(knowledge.nodes.filter((node) => node.kind === 'phase').length, 4);
  assert.ok(knowledge.nodes.some((node) => node.status === 'disabled'));
  const view = knowledge.nodes.find((node) => node.label === 'arch.contracts');
  assert.equal(view.details.find(([name]) => name === 'View-ledger facts')[1], '14');
  assert.match(view.references[0].ref, /:view:arch\.contracts:/);
  assert.equal(calm.edges.length, 5);
  assert.equal(calm.nodes.find((node) => node.label === 'Order database').group, 'Data');
  assert.deepEqual(calm.nodes.find((node) => node.label === 'Web application').details.at(-1), ['More sources', '1 in the exact source map']);
  assert.ok(calm.notices.some((message) => message.includes('connections here do not imply flow order')));
});

test('disabled assignments never appear as injection and missing views are not invented', () => {
  const view = visualFixture();
  view.worldModelStatus.workflows[0].phases[0].views.push('nonexistent');
  const [graph] = worldModelVisualGraphs(view);
  assert.ok(graph.edges.every((edge) => edge.workflow !== 'off'));
  assert.ok(graph.nodes.every((node) => node.label !== 'nonexistent'));
  assert.ok(graph.notices.some((message) => message.includes('Bounded map')));
});

test('same phase IDs in distinct workflows have collision-free identities', () => {
  const [graph] = worldModelVisualGraphs(visualFixture());
  const planning = graph.nodes.filter((node) => node.label === 'Planning');
  assert.equal(planning.length, 2);
  assert.notEqual(planning[0].key, planning[1].key);
  assert.equal(new Set(graph.nodes.map((node) => node.key)).size, graph.nodes.length);
});

test('search, states, workflow scopes and neighbors filter nodes and edges consistently', () => {
  const [knowledge, calm] = worldModelVisualGraphs(visualFixture());
  assert.equal(selectVisualGraph(calm, filters({ query: 'ORDER DATABASE' })).nodes.length, 1);
  assert.equal(selectVisualGraph(calm, filters({ query: 'order database' })).edges.length, 0);
  assert.equal(selectVisualGraph(calm, filters({ group: 'Data', status: 'confirmed' })).nodes.length, 1);
  assert.equal(selectVisualGraph(knowledge, filters({ workflow: 'web' })).edges.length, 4);
  assert.equal(selectVisualGraph(knowledge, filters({ workflow: 'off' })).edges.length, 0);
  const selected = calm.nodes.find((node) => node.label === 'Order service').key;
  const near = selectVisualGraph(calm, filters({ selected, neighbors: true }));
  assert.equal(near.nodes.length, 4);
  assert.equal(near.edges.length, 4);
  assert.equal(selectVisualGraph(calm, filters({ query: 'not found' })).nodes.length, 0);
});

test('bounded graph does not invent omitted CALM endpoints or duplicate component nodes', () => {
  const view = visualFixture();
  const projection = view.worldModelStatus.projections[0];
  projection.nodes.push(projection.nodes[0]);
  projection.relationships.push({ id: 'outside', kind: 'connects', source: 'web', destinations: ['outside-preview'], status: 'confirmed' });
  projection.truncated = { nodes: true, relationships: true, controls: false };
  const [,graph] = worldModelVisualGraphs(view);
  assert.equal(graph.nodes.length, 5);
  assert.equal(graph.edges.length, 5);
  assert.ok(graph.notices.some((message) => message.includes('Duplicate component')));
  assert.ok(graph.notices.some((message) => message.includes('no placeholder architecture')));
  assert.ok(graph.notices.some((message) => message.includes('Bounded architecture preview')));
});

test('composed-of fans out exact destinations, deduplicating endpoints without guessing topology', () => {
  const view = visualFixture();
  view.worldModelStatus.projections[0].relationships = [{ id: 'composed', kind: 'composed-of', source: 'web', destinations: ['api','data','api'], status: 'confirmed' }];
  const [,graph] = worldModelVisualGraphs(view);
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.edges.every((edge) => edge.kind === 'composed-of'));
});

test('large inventories cap both graph nodes and graph edges and disclose the bound', () => {
  const view = visualFixture();
  view.worldModelStatus.workflows = Array.from({ length: 200 }, (_, i) => ({ id: `flow-${i}`, label: `Flow ${i}`, mode: 'required', phases: [{ id: 'plan', label: 'Plan', views: ['biz.rules','dev.impact','arch.contracts'], depth: 'full', source: 'shared-phase' }] }));
  const [graph] = worldModelVisualGraphs(view);
  assert.equal(graph.nodes.length, 160);
  assert.equal(graph.edges.length, 320);
  assert.ok(graph.notices.some((message) => message.includes('Bounded map')));
  const allKeys = new Set(graph.nodes.map((node) => node.key));
  assert.ok(graph.edges.every((edge) => allKeys.has(edge.from) && allKeys.has(edge.to)));
});

test('missing, refused and empty models have explicit honest states, not sample architecture', () => {
  const view = visualFixture();
  view.worldModelStatus.views = []; view.worldModelStatus.workflows = []; view.worldModelStatus.built = false;
  view.worldModelStatus.projections = [{ id: 'arch.calm', version: 1, status: 'unavailable', required: false, refusalCode: 'WMC_STALE', nodes: [{ id: 'unsafe', name: 'Not usable' }] }];
  const [knowledge, calm] = worldModelVisualGraphs(view);
  assert.equal(knowledge.nodes.length, 0);
  assert.match(calm.empty, /WMC_STALE/);
  assert.equal(calm.nodes.length, 0);
  view.worldModelStatus.projections = [];
  assert.match(worldModelVisualGraphs(view)[1].empty, /enabled but has not been generated/);
  view.worldModel.projections.archCalm.enabled = false;
  assert.match(worldModelVisualGraphs(view)[1].empty, /not enabled/);
});

test('cycle-safe layout is deterministic, finite and separates same-column nodes', () => {
  const [,graph] = worldModelVisualGraphs(visualFixture());
  const layout = layoutVisualGraph(graph.nodes);
  assert.deepEqual(layout, layoutVisualGraph(graph.nodes));
  assert.ok(Number.isFinite(layout.width) && Number.isFinite(layout.height));
  assert.equal(new Set(layout.nodes.map((node) => `${node.x},${node.y}`)).size, graph.nodes.length);
  assert.ok(layout.nodes.every((node) => node.x >= 0 && node.y >= 0 && node.x + 230 < layout.width && node.y + 66 < layout.height));
  assert.ok(layoutVisualGraph([]).height > 0);
});

test('visual explorer preserves snapshot authority and shows stale, historical and unknown freshness', () => {
  const view = visualFixture();
  assert.match(worldModelVisualization(view), /Source fresh/);
  assert.match(worldModelVisualization(view), /origin\/state/);
  view.worldModelStatus.rebuildReason = 'Source changed';
  assert.match(worldModelVisualization(view), /Needs refresh/);
  view.worldModelStatus.rebuildReason = null; view.worldModelStatus.source = undefined;
  assert.match(worldModelVisualization(view), /Freshness unknown/);
  view.worldModelStatus.readiness = { historical: true };
  assert.match(worldModelVisualization(view), /Historical snapshot/);
});

test('untrusted names, paths and references are inert in HTML, SVG and the inspector', () => {
  const view = visualFixture();
  const attack = '</script><img src=x onerror="alert(1)">';
  view.worldModelStatus.projections[0].nodes[0].name = attack;
  view.worldModelStatus.authority.ref = attack;
  const html = worldModelVisualization(view);
  assert.doesNotMatch(html, /<img|<\/script>/);
  assert.match(html, /&lt;\/script&gt;/);
  assert.doesNotMatch(WORLD_MODEL_VISUAL_SCRIPT, /innerHTML|eval\(|fetch\(|postMessage/);
  assert.match(WORLD_MODEL_VISUAL_SCRIPT, /\.textContent =/);
});

test('configuration page integrates explorer, local interactions and nonce-protected styles', () => {
  const view = visualFixture();
  const body = configurationCenterHtml(view, 'world-model', null, null, null, []);
  assert.match(body, /World Model &amp; CALM/);
  assert.match(body, /Accessible item list/);
  assert.match(body, /CALM provenance, controls, flows &amp; evidence gaps/);
  assert.ok(body.indexOf('data-wm-graphs') < body.indexOf('View catalog'));
  const html = page('World Model', body, "default-src 'none'; style-src 'nonce-test'; script-src 'nonce-test'", 'test', CONFIGURATION_CENTER_SCRIPT, { nav: false, styles: WORLD_MODEL_VISUAL_STYLES });
  assert.match(html, /<style nonce="test">/);
  assert.match(html, /wm-visual-node:focus-visible/);
  assert.match(html, /prefers-reduced-motion/);
  new Function(WORLD_MODEL_VISUAL_SCRIPT);
  new Function(CONFIGURATION_CENTER_SCRIPT);
  assert.match(WORLD_MODEL_VISUAL_SCRIPT, /setPointerCapture/);
  assert.match(WORLD_MODEL_VISUAL_SCRIPT, /ArrowLeft/);
});

test('read-only map remains usable while pending configuration keeps editors disabled', () => {
  const html = configurationCenterHtml(visualFixture(), 'world-model', null, null, null, [], {
    branch: 'sflow/config-change/example', baseBranch: 'sflow/config'
  });
  assert.ok(html.indexOf('data-wm-graphs') < html.indexOf('<fieldset disabled'));
  assert.match(html.slice(html.indexOf('<fieldset disabled')), /id="world-model-form"/);
  assert.doesNotMatch(html.slice(html.indexOf('<fieldset disabled')), /data-wm-graphs/);
});
