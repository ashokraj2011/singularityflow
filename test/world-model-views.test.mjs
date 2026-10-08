import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  worldModelAssignmentViews,
  worldModelViewCatalog,
  worldModelViewContractCatalog,
  worldModelWorkflowViewUsage
} from '../src/world-model-views.mjs';
import { resolveWorldModelViewIds } from '../src/worldmodel.mjs';
import { resolveGroundingPlan, selectionId } from '../src/world-model-selection.mjs';

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
  assert.ok(references.get('arch.contracts').includes("agent 'architect' prompt"));
  assert.ok(references.get('dev.impact').includes("agent 'qa' prompt"));
  assert.deepEqual(worldModelViewCatalog(workflow), workflow.worldModel.views.map(view => view.split('@')[0]));
  assert.deepEqual(markdownWorldModelViews('Use views/security.md, `views/data-governance.md`, and views/dev.impact.md; ignore https://example.test/view.md.'), ['data-governance', 'dev.impact', 'security']);
});

test('world-model view designer adds unused views and protects referenced views', async () => {
  const workflow = { worldModel: { format: 'registered-v4', views: ['arch.contracts@4'] },
    phases: { design: { worldModel: { views: ['arch.contracts'] } } } };
  const added = addWorldModelView(workflow, 'biz.rules');
  assert.ok(added.worldModel.views.includes('biz.rules@4'));
  assert.ok(!workflow.worldModel.views.includes('biz.rules@4'));
  assert.deepEqual(removeWorldModelView(added, 'biz.rules').worldModel.views, workflow.worldModel.views);
  assert.throws(() => removeWorldModelView(workflow, 'arch.contracts'), /still used by/);
  assert.throws(() => removeWorldModelView(added, 'biz.rules', ["Markdown 'singularity/agents/architect.agent.md'"]), /Markdown/);
  // Free-form and retired legacy-v3 names are not installed contracts and cannot be added.
  assert.throws(() => addWorldModelView(workflow, 'data-governance'), /not an installed active registered contract/);
  assert.throws(() => addWorldModelView(workflow, 'architecture'), /not an installed active registered contract/);
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

test('registered-v4 validation refuses retired legacy names and unknown assignments', async () => {
  const workflow = await definition();
  workflow.worldModel.format = 'registered-v4';
  workflow.phases.implementation.worldModel.views = ['development', 'dev.impact'];
  assert.throws(
    () => validateDefinition(workflow),
    (error) => error.code === 'WMB_FORMAT_RETIRED'
      && /phase 'implementation'=development/.test(error.message)
  );

  const unknown = await definition();
  unknown.worldModel.format = 'registered-v4';
  unknown.phases.implementation.worldModel.views = ['telepathy'];
  assert.throws(
    () => validateDefinition(unknown),
    (error) => error.code === 'WMB_VIEW_UNKNOWN'
      && /phase 'implementation'=telepathy/.test(error.message)
      && error.details.views.includes('telepathy')
      && error.details.invalidEntries.some((entry) => (
        entry.view === 'telepathy'
          && entry.source === "phase 'implementation'"
          && entry.sourceKind === 'structured-assignment'
      ))
  );
});

test('view catalogs accept single-use iterable prompt references on every supported Node runtime', () => {
  const promptReferences = new Map([
    ['dev.impact', 'prompt'],
    ['arch.contracts', 'prompt']
  ]).keys();
  assert.deepEqual(
    worldModelViewCatalog({ worldModel: { views: [] }, phases: {} }, promptReferences),
    ['arch.contracts', 'dev.impact']
  );
});

test('phase and agent assignments are trimmed registered view IDs', () => {
  assert.deepEqual(worldModelAssignmentViews([' dev.impact ', '', 'arch.contracts']), ['dev.impact', 'arch.contracts']);
  assert.deepEqual(worldModelAssignmentViews(undefined), []);
  assert.deepEqual(worldModelAssignmentViews('dev.impact'), []);
});

test('world-model workflow usage resolves inherited, overridden, empty, and disabled view routes', () => {
  const usage = worldModelWorkflowViewUsage({
    phases: {
      intake: { label: 'Intake', worldModel: { views: ['biz.rules'], depth: 'quick' } },
      implementation: { label: 'Implementation', worldModel: { views: ['dev.impact'], depth: 'standard' } }
    },
    workTypes: {
      feature: { label: 'Feature', phases: ['intake', 'implementation'] },
      secure: {
        label: 'Secure', phases: ['intake', 'implementation'],
        phaseOverrides: {
          intake: { worldModel: { views: [] } },
          implementation: { worldModel: { views: ['arch.contracts'], depth: 'deep' } }
        }
      },
      generic: { label: 'Generic', phases: ['intake'], intelligence: { worldModel: 'off' } }
    }
  });
  assert.deepEqual(usage.find((workflow) => workflow.id === 'feature').phases.map((phase) => phase.views), [
    ['biz.rules'], ['dev.impact']
  ]);
  assert.deepEqual(usage.find((workflow) => workflow.id === 'secure').phases.map((phase) => phase.views), [[], ['arch.contracts']]);
  assert.equal(usage.find((workflow) => workflow.id === 'secure').phases[1].source, 'workflow-override');
  assert.equal(usage.find((workflow) => workflow.id === 'secure').phases[1].depth, 'deep');
  assert.deepEqual(usage.find((workflow) => workflow.id === 'generic').phases[0].views, []);
  assert.equal(usage.find((workflow) => workflow.id === 'generic').phases[0].source, 'disabled');
});

test('workflow validation rejects undeclared structured world-model views', async () => {
  const workflow = await definition();
  workflow.worldModel.views = workflow.worldModel.views.filter((view) => view !== 'arch.contracts@4');
  assert.throws(() => validateDefinition(workflow), /arch\.contracts.*not declared/);
});

test('the command sentinel all resolves once to concrete approved view IDs', () => {
  const config = {
    definition: { worldModel: { views: ['dev.impact', 'biz.rules', 'arch.contracts'] } },
    phases: { implementation: { views: ['dev.impact', 'dev.hotspots'] } }
  };
  assert.deepEqual(resolveWorldModelViewIds(config, ['all']), ['arch.contracts', 'biz.rules', 'dev.impact']);
  assert.deepEqual(resolveWorldModelViewIds({
    phases: { implementation: { views: ['dev.impact'] }, verification: { views: ['dev.hotspots'] } }
  }, ['all']), ['dev.hotspots', 'dev.impact'], 'configs without a catalog derive one from phase views');
  assert.throws(
    () => resolveWorldModelViewIds({ definition: { worldModel: { views: [] } }, phases: {} }, ['all']),
    (error) => error.code === 'WORLD_MODEL_VIEWS_UNRESOLVED'
  );
  assert.throws(
    () => resolveWorldModelViewIds(config, ['Not A View']),
    (error) => error.code === 'WORLD_MODEL_VIEW_INVALID'
  );
});

test('explicit phase view order survives resolution so composition and publication agree on tiers', () => {
  const config = {
    definition: { worldModel: { views: ['arch.contracts', 'dev.hotspots', 'dev.impact'] } },
    phases: { verification: { views: ['dev.impact', 'arch.contracts', 'dev.hotspots'] } }
  };
  const phaseViews = resolveWorldModelViewIds(config, config.phases.verification.views);
  assert.deepEqual(phaseViews, ['dev.impact', 'arch.contracts', 'dev.hotspots']);
  const plan = resolveGroundingPlan({ phase: 'verification', phaseViews, depth: 'standard' });
  assert.deepEqual(plan.selections.map(selectionId), [
    'core/brief', 'dev.impact/full', 'arch.contracts/brief', 'dev.hotspots/brief'
  ]);
  assert.deepEqual(
    resolveWorldModelViewIds(config, ['dev.impact', 'arch.contracts', 'dev.impact']),
    ['dev.impact', 'arch.contracts'],
    'deduplication must not move the primary phase view'
  );
});
