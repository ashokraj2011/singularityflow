import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseManifest,
  parseConsumerHeader,
  parseTldr,
  parseFactsBlock,
  parseAnchors,
  parseProseSections,
  parseEvidence,
  buildExplorerModel
} from '../src/world-model/parse.mjs';

const v2View = `> **Grounding** · demo-repo @ \`abc1234def5\` · view: \`development\` · tier: \`full\`
> **Generated** 27 July 2026 (2026-07-27T14:32:07Z) · depth: \`standard\` · builder \`2.0\`
> **Authoritative for:** file locations.

## TL;DR {#dev.tldr}
Start at src/cli.mjs. Do not edit generated files.

## Facts {#dev.facts}

\`\`\`yaml
components: [cli-engine, desktop-app]
entrypoints:
  - { id: cli-main, path: src/cli.mjs, line: 42, invocation: "sflow <command>" }
commands:
  - { command: "npm test", purpose: "full suite", source: "package.json:14" }
hotspots:
  - { path: src/state.mjs, reason: "largest surface" }
\`\`\`

## Change-impact guide {#dev.impact}
Touching src/state.mjs ripples widely.
`;

function worldModelWith(files, extra = {}) {
  return { root: 'singularity/world-model', generatedAt: '2026-07-27T14:32:07Z', rebuildReason: null, views: [], files, ...extra };
}

function manifestFile(overrides = {}) {
  return {
    name: 'manifest.json', path: 'x/manifest.json', content: JSON.stringify({
      schema_version: '2.0', repository_commit: 'abc1234def5'.padEnd(40, '0'), repository_branch: 'main',
      generated_at: '2026-07-27T14:32:07Z', generated_date: '27 July 2026', working_tree_clean: true,
      builder_version: '2.0', analysis_depth: 'standard', views_generated: ['development'],
      source_tree_sha256: 'sha256:' + 'a'.repeat(64),
      views: { development: { path: 'views/development.md', anchors: ['dev.tldr', 'dev.facts'], generated: true } },
      domains: [{ id: 'payments', path: 'domains/payments.md', relevant_views: ['development'] }],
      task_guides: [{ id: 'add-endpoint', path: 'task-guides/add-endpoint.md', task: 'add a payment endpoint' }],
      evidence: { path: 'evidence/evidence.jsonl' }, ...overrides
    })
  };
}

test('parseManifest normalizes v2.0 fields (snake_case → camelCase)', () => {
  const manifest = parseManifest(worldModelWith([manifestFile()]));
  assert.equal(manifest.schemaVersion, '2.0');
  assert.equal(manifest.branch, 'main');
  assert.equal(manifest.workingTreeClean, true);
  assert.equal(manifest.analysisDepth, 'standard');
  assert.equal(manifest.views.development.path, 'views/development.md');
  assert.deepEqual(manifest.domains[0], { id: 'payments', path: 'domains/payments.md', relevantViews: ['development'] });
  assert.equal(manifest.taskGuides[0].task, 'add a payment endpoint');
  assert.equal(manifest.evidencePath, 'evidence/evidence.jsonl');
});

test('parseManifest returns null when manifest is absent or invalid', () => {
  assert.equal(parseManifest(worldModelWith([])), null);
  assert.equal(parseManifest(worldModelWith([{ name: 'manifest.json', content: '{not json' }])), null);
});

test('parseConsumerHeader reads grounding + generated fields, both with and without a UTC paren', () => {
  const header = parseConsumerHeader(v2View);
  assert.equal(header.view, 'development');
  assert.equal(header.tier, 'full');
  assert.equal(header.depth, 'standard');
  assert.equal(header.builder, '2.0');
  assert.equal(header.generatedDate, '27 July 2026');
  assert.equal(header.generatedUtc, '2026-07-27T14:32:07Z');
  const noUtc = parseConsumerHeader('> **Generated** 3 August 2026 · depth: `deep` · builder `2.0`');
  assert.equal(noUtc.generatedDate, '3 August 2026');
  assert.equal(noUtc.depth, 'deep');
});

test('parseTldr and parseFactsBlock extract the machine-readable preamble', () => {
  assert.match(parseTldr(v2View), /Start at src\/cli\.mjs/);
  const facts = parseFactsBlock(v2View);
  assert.deepEqual(facts.components, ['cli-engine', 'desktop-app']);
  assert.equal(facts.entrypoints[0].path, 'src/cli.mjs');
  assert.equal(facts.hotspots[0].reason, 'largest surface');
});

test('parseFactsBlock returns null for pre-v2 docs (graceful degradation)', () => {
  assert.equal(parseFactsBlock('## Overview\nJust prose, no facts block.\n'), null);
  assert.equal(parseConsumerHeader('# Title\nprose'), null);
});

test('parseAnchors and parseProseSections skip the TL;DR and Facts sections', () => {
  const anchors = parseAnchors(v2View).map((entry) => entry.anchor);
  assert.deepEqual(anchors, ['dev.tldr', 'dev.facts', 'dev.impact']);
  const sections = parseProseSections(v2View).map((section) => section.title);
  assert.deepEqual(sections, ['Change-impact guide']);
});

test('parseEvidence tolerates blank and malformed lines', () => {
  const { records, errors } = parseEvidence('{"claim":"a","confidence":"high"}\n\n{bad\n{"claim":"b","confidence":"low"}\n');
  assert.equal(records.length, 2);
  assert.equal(errors, 1);
  assert.equal(records[1].confidence, 'low');
});

test('buildExplorerModel assembles a normalized model from a full build', () => {
  const worldModel = worldModelWith([
    manifestFile(),
    { name: 'views/development.md', content: v2View },
    { name: 'core/summary.md', content: '## Orientation {#core.overview}\nA demo repo.\n' },
    { name: 'domains/payments.md', content: '## Payments {#domain.payments.tldr}\nHandles money.\n' },
    { name: 'task-guides/add-endpoint.md', content: '## Steps {#task.add-endpoint.tldr}\nAdd a route.\n' },
    { name: 'evidence/evidence.jsonl', content: '{"claim":"cli entry","path":"src/cli.mjs:42","confidence":"high"}\n{"claim":"x","confidence":"low"}\n' }
  ], { views: [{ id: 'development', references: ["phase 'implementation'"] }] });

  const model = buildExplorerModel(worldModel, { root: '/tmp/demo-repo', branch: 'main', head: 'abc1234def5'.padEnd(40, '0'), changes: [] });
  assert.equal(model.present, true);
  assert.equal(model.provenance.name, 'demo-repo');
  assert.equal(model.provenance.shortCommit, 'abc1234def');
  assert.equal(model.provenance.workingTreeClean, true);
  assert.equal(model.provenance.stale, false);
  assert.deepEqual(model.views.map((view) => view.id), ['development']);
  assert.deepEqual(model.views[0].references, ["phase 'implementation'"]);
  assert.equal(model.views[0].facts.components.length, 2);
  assert.equal(model.stats.entryPoints, 1);
  assert.equal(model.stats.components, 2);
  assert.equal(model.domains[0].present, true);
  assert.equal(model.taskGuides[0].task, 'add a payment endpoint');
  assert.equal(model.evidence.records.length, 2);
  assert.deepEqual(model.availability, { manifest: true, core: true, views: true, facts: true, domains: true, taskGuides: true, evidence: true });
});

test('buildExplorerModel degrades: no manifest, dirty tree, pre-v2 view', () => {
  const worldModel = worldModelWith([
    { name: 'views/architecture.md', content: '## Boundaries {#arch.boundaries}\nModule A talks to B.\n' }
  ], { rebuildReason: 'World model is stale.' });
  const model = buildExplorerModel(worldModel, { root: '/tmp/demo', branch: 'feature', head: 'deadbeef', changes: ['src/a.js'] });
  assert.equal(model.present, true); // a view exists even without a manifest
  assert.equal(model.provenance.stale, true);
  assert.equal(model.provenance.workingTreeClean, false); // one change in the tree
  assert.equal(model.views[0].facts, null); // no Facts block → null, not a throw
  assert.equal(model.views[0].sections[0].title, 'Boundaries');
  assert.equal(model.availability.facts, false);
});

test('buildExplorerModel reports absent when there is nothing to show', () => {
  const model = buildExplorerModel(worldModelWith([]), {});
  assert.equal(model.present, false);
});
