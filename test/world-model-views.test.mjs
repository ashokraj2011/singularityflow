import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { parseAgentDependencies } from '../src/agents.mjs';
import { validateDefinition } from '../src/config.mjs';
import {
  addWorldModelView,
  markdownWorldModelViews,
  removeWorldModelView,
  structuredWorldModelViewReferences,
  worldModelViewCatalog,
  worldModelViewContractCatalog,
  worldModelWorkflowViewUsage
} from '../src/world-model-views.mjs';
import { resolveWorldModelViewIds } from '../src/worldmodel.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function definition() {
  const workflow = YAML.parse(await readFile(path.join(root, 'templates/workflow.yml'), 'utf8'));
  const agentFiles = ['architect', 'developer', 'mobile-architect', 'product-designer', 'product-owner', 'qa'];
  workflow.agents = Object.fromEntries(await Promise.all(agentFiles.map(async (id) => {
    const text = await readFile(path.join(root, `templates/agents/${id}.agent.md`), 'utf8');
    return [id, parseAgentDependencies(text, { source: `templates/agents/${id}.agent.md` })];
  })));
  return workflow;
}

test('world-model view registry catalogs structured prompt dependencies', async () => {
  const workflow = await definition();
  const references = structuredWorldModelViewReferences(workflow);
  assert.ok(references.get('architecture').includes("agent 'architect' prompt"));
  assert.ok(references.get('testing').includes("agent 'qa' prompt"));
  assert.deepEqual(worldModelViewCatalog(workflow), workflow.worldModel.views);
  assert.deepEqual(markdownWorldModelViews('Use views/security.md, `views/data-governance.md`, and views/dev.impact.md; ignore https://example.test/view.md.'), ['data-governance', 'dev.impact', 'security']);
});

test('world-model view designer adds unused views and protects referenced views', async () => {
  const workflow = await definition();
  const added = addWorldModelView(workflow, 'data-governance');
  assert.ok(added.worldModel.views.includes('data-governance'));
  assert.ok(!workflow.worldModel.views.includes('data-governance'));
  assert.deepEqual(removeWorldModelView(added, 'data-governance').worldModel.views, workflow.worldModel.views);
  assert.throws(() => removeWorldModelView(workflow, 'architecture'), /still used by/);
  assert.throws(() => removeWorldModelView(added, 'data-governance', ["Markdown 'singularity/prompts/worldmodel-builder.md'"]), /Markdown/);
});

test('registered-v4 joins exact repository contracts to bare phase and agent IDs', () => {
  const workflow = {
    // Advanced injection paths are logical artifact names and therefore remain unversioned.
    worldModel: {
      format: 'registered-v4', views: ['dev.impact@4'],
      injection: { rules: [{ include: ['views/dev.impact.md'] }] }
    },
    phases: { implementation: { worldModel: { views: ['dev.impact'] } } },
    agents: { developer: { worldModelViews: ['dev.impact'] } },
    workTypes: { feature: { phases: ['implementation'] } }
  };
  assert.deepEqual(worldModelViewCatalog(workflow), ['dev.impact']);
  assert.deepEqual(worldModelViewContractCatalog(workflow), [
    { id: 'dev.impact', reference: 'dev.impact@4', version: 4 }
  ]);
  assert.deepEqual(structuredWorldModelViewReferences(workflow).get('dev.impact'), [
    "phase 'implementation'", "agent 'developer' prompt", 'world-model injection rule 1'
  ]);
  assert.deepEqual(worldModelWorkflowViewUsage(workflow)[0].phases[0].views, ['dev.impact']);
  assert.throws(() => addWorldModelView(workflow, 'dev.impact'), /already exists/);
  const added = addWorldModelView(workflow, 'arch.contracts');
  assert.deepEqual(added.worldModel.views, ['dev.impact@4', 'arch.contracts@4']);
  const unreferenced = {
    ...workflow, phases: {}, agents: {}, workTypes: {},
    worldModel: { ...workflow.worldModel, injection: { rules: [] } }
  };
  assert.deepEqual(removeWorldModelView(unreferenced, 'dev.impact').worldModel.views, []);
});

test('registered-v4 omission expands to every installed active exact contract', () => {
  const definition = { worldModel: { format: 'registered-v4' }, phases: {} };
  assert.deepEqual(worldModelViewCatalog(definition), [
    'arch.contracts', 'biz.rules', 'dev.hotspots', 'dev.impact'
  ]);
  assert.deepEqual(worldModelViewContractCatalog(definition).map((entry) => entry.reference), [
    'arch.contracts@4', 'biz.rules@4', 'dev.hotspots@4', 'dev.impact@4'
  ]);
});

test('world-model workflow usage resolves inherited, overridden, empty, and disabled view routes', () => {
  const usage = worldModelWorkflowViewUsage({
    phases: {
      intake: { label: 'Intake', worldModel: { views: ['business'], depth: 'quick' } },
      implementation: { label: 'Implementation', worldModel: { views: ['development'], depth: 'standard' } }
    },
    workTypes: {
      feature: { label: 'Feature', phases: ['intake', 'implementation'] },
      secure: {
        label: 'Secure', phases: ['intake', 'implementation'],
        phaseOverrides: {
          intake: { worldModel: { views: [] } },
          implementation: { worldModel: { views: ['security'], depth: 'deep' } }
        }
      },
      generic: { label: 'Generic', phases: ['intake'], intelligence: { worldModel: 'off' } }
    }
  });
  assert.deepEqual(usage.find((workflow) => workflow.id === 'feature').phases.map((phase) => phase.views), [
    ['business'], ['development']
  ]);
  assert.deepEqual(usage.find((workflow) => workflow.id === 'secure').phases.map((phase) => phase.views), [[], ['security']]);
  assert.equal(usage.find((workflow) => workflow.id === 'secure').phases[1].source, 'workflow-override');
  assert.equal(usage.find((workflow) => workflow.id === 'secure').phases[1].depth, 'deep');
  assert.deepEqual(usage.find((workflow) => workflow.id === 'generic').phases[0].views, []);
  assert.equal(usage.find((workflow) => workflow.id === 'generic').phases[0].source, 'disabled');
});

test('workflow validation rejects undeclared structured world-model views', async () => {
  const workflow = await definition();
  workflow.worldModel.views = workflow.worldModel.views.filter((view) => view !== 'architecture');
  assert.throws(() => validateDefinition(workflow), /architecture.*not declared/);
});

test('the command sentinel all resolves once to concrete approved view IDs', () => {
  const config = {
    definition: { worldModel: { views: ['business', 'architecture', 'testing'] } },
    phases: { implementation: { views: ['development', 'testing'] } }
  };
  assert.deepEqual(resolveWorldModelViewIds(config, ['all']), ['architecture', 'business', 'testing']);
  assert.deepEqual(resolveWorldModelViewIds({
    phases: { implementation: { views: ['development'] }, verification: { views: ['testing'] } }
  }, ['all']), ['development', 'testing'], 'legacy/state-backed configs derive a catalog from phase views');
  assert.throws(
    () => resolveWorldModelViewIds({ definition: { worldModel: { views: [] } }, phases: {} }, ['all']),
    (error) => error.code === 'WORLD_MODEL_VIEWS_UNRESOLVED'
  );
  assert.throws(
    () => resolveWorldModelViewIds(config, ['Not A View']),
    (error) => error.code === 'WORLD_MODEL_VIEW_INVALID'
  );
});

test('the builder manifest declares nothing nobody reads', async () => {
  /**
   * The manifest is a machine index: the CLI resolves named fields out of it, and unlike the
   * documents it points at, it is never injected into an agent's prompt — verified against a real
   * composed prompt, which contained none of these keys. So "no reader in src/" is the whole test,
   * and ten keys failed it after shipping.
   *
   * Most were merely dead. The dangerous ones restated decisions the repository had already made:
   * `phase_map` and `agent_map` named the views a phase or agent should load, and a task guide's
   * `required_views`/`required_domains` did the same for one task — all owned by `workflow.yml` and
   * the agent catalog, and all approved by a human. Unread they were clutter; read, a model's guess
   * would have competed with pinned configuration.
   *
   * Scope matters: this holds for the manifest, not for `core/model.json` or the evidence records.
   * A reader consumes those whole, so they legitimately carry detail no resolver names.
   */
  const builder = await readFile(new URL('../templates/worldmodel-builder.md', import.meta.url), 'utf8');
  const source = new URL('../src/', import.meta.url);
  const modules = (await readdir(source, { recursive: true })).filter((name) => name.endsWith('.mjs'));
  const code = (await Promise.all(modules.map((name) => readFile(new URL(name, source), 'utf8')))).join('\n');

  for (const key of ['phase_map', 'agent_map', 'recommended_loading_rules', 'load_when', 'budget_hints']) {
    assert.ok(!builder.includes(`"${key}"`), `the builder emits '${key}', which nothing reads`);
  }

  // Every manifest key must have a consumer, at any depth — the advice that survived the first pass
  // of this test was nested one level down. Anything new without a reader is the same bug.
  const start = builder.indexOf('```json', builder.indexOf('# Step 7:')) + '```json'.length;
  const manifest = builder.slice(start, builder.indexOf('```', start));
  assert.match(manifest, /"schema_version"/, 'the manifest example moved; this test is reading the wrong block');
  const declared = [...new Set([...manifest.matchAll(/"([a-z_]+)":/g)].map((match) => match[1]))];
  const unread = declared.filter((key) => !code.includes(key));
  assert.deepEqual(unread, [], `the builder manifest declares key(s) no module reads: ${unread.join(', ')}`);
});
