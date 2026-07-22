import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition, migrateLegacyConfig, normalizePhaseInputs, normalizeSequenceGates, normalizeSessionPolicy, personaPrompt, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { groundingMode } from '../src/grounding.mjs';

test('starter YAML resolves feature, bugfix, and Figma-mobile templates and personas', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-')); await mkdir(path.join(root, '.git'), { recursive: true }); await initializeDefinition(root);
  const definition = await loadDefinition(root); const feature = resolveWorkType(definition, 'feature'); const bugfix = resolveWorkType(definition, 'bugfix'); const figmaMobile = resolveWorkType(definition, 'figma-mobile');
  assert.equal(feature.phases.find((item) => item.id === 'implementation-spec').template, 'feature/implementation-spec.md');
  assert.equal(bugfix.phases.find((item) => item.id === 'fix-spec').template, 'bugfix/fix-spec.md');
  assert.deepEqual(feature.documents.allowedPhases, ['intake', 'requirements', 'design', 'implementation-spec']);
  assert.deepEqual(bugfix.documents.allowedPhases, ['intake', 'reproduction', 'fix-design', 'fix-spec']);
  assert.match(await personaPrompt(root, definition, 'architect'), /boundaries, contracts/);
  assert.equal(definition.inputsMode, 'record');
  assert.equal(definition.worldModel.grounding, 'enforce');
  assert.deepEqual(definition.session, { personaSelection: 'prompt', promptOnNewSession: true, promptOnResume: false, requireBeforeTools: true });
  assert.equal(feature.sequenceGates.phaseStatus, 'soft');
  assert.equal(feature.sequenceGates.documentPhase, 'soft');
  assert.equal(feature.sequenceGates.publicationPending, 'hard');
  assert.deepEqual(feature.phases.find((item) => item.id === 'design').inputs, [{ phase: 'requirements', optional: false, maxBytes: null, path: 'artifacts/requirements/requirements.md' }]);
  assert.deepEqual(bugfix.phases.find((item) => item.id === 'verification').inputs.map((item) => item.phase), ['fix-spec', 'implementation']);
  assert.deepEqual(figmaMobile.phases.map((item) => item.id), ['design-intake', 'design-inventory', 'component-mapping', 'mobile-spec', 'implementation', 'visual-verification', 'conformance']);
  assert.deepEqual(figmaMobile.documents.allowedPhases, ['design-intake', 'design-inventory']);
  assert.equal(figmaMobile.sequenceGates.documentPhase, 'hard');
  assert.equal(figmaMobile.phases.find((item) => item.id === 'mobile-spec').template, 'figma-mobile/mobile-spec.md');
  assert.deepEqual(figmaMobile.phases.find((item) => item.id === 'implementation').inputs.map((item) => item.phase), ['component-mapping', 'mobile-spec']);
  assert.equal(figmaMobile.phases.find((item) => item.id === 'visual-verification').approval.minimum, 2);
  assert.equal(figmaMobile.phases.find((item) => item.id === 'conformance').approval.minimum, 2);
  assert.match(await personaPrompt(root, definition, 'product-designer'), /exported design package/i);
  assert.match(await readFile(path.join(root, '.singularity/templates/figma-mobile/visual-verification.md'), 'utf8'), /Screen comparison/);
});

test('Copilot session persona policy is configurable and absent configuration stays inert', () => {
  assert.deepEqual(normalizeSessionPolicy(), { personaSelection: 'off', promptOnNewSession: false, promptOnResume: false, requireBeforeTools: false });
  assert.deepEqual(normalizeSessionPolicy({ personaSelection: 'reuse', requireBeforeTools: true }), { personaSelection: 'reuse', promptOnNewSession: false, promptOnResume: false, requireBeforeTools: true });
  assert.throws(() => normalizeSessionPolicy({ personaSelection: 'always' }), /must be off, reuse, or prompt/);
  assert.throws(() => normalizeSessionPolicy({ promptOnResume: 'yes' }), /must be boolean/);
  assert.throws(() => normalizeSessionPolicy({ defaultPersona: 'developer' }), /unknown field/);
});

test('world-model grounding is configurable and legacy-safe', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-grounding-config-')); await initializeDefinition(root);
  const definition = await loadDefinition(root);
  definition.worldModel.grounding = 'warn';
  assert.equal(validateDefinition(definition).worldModel.grounding, 'warn');
  assert.equal(groundingMode(definition, { resolution: {} }), 'off');
  assert.equal(groundingMode(definition, { resolution: { worldModelGrounding: 'enforce' } }), 'enforce');
  delete definition.worldModel.grounding;
  assert.doesNotThrow(() => validateDefinition(definition));
  definition.worldModel.grounding = 'sometimes';
  assert.throws(() => validateDefinition(definition), /worldModel\.grounding must be off, warn, or enforce/);
});

test('sequence gates default safely to hard and support work-type overrides', async () => {
  const legacySafe = normalizeSequenceGates();
  assert.equal(legacySafe.default, 'hard');
  assert.ok(Object.values(legacySafe).every((mode) => mode === 'hard'));

  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sequence-config-')); await initializeDefinition(root);
  const definition = await loadDefinition(root);
  definition.workTypes.feature.sequenceGates = { phaseStatus: 'hard', generationCommit: 'soft' };
  const gates = resolveWorkType(definition, 'feature').sequenceGates;
  assert.equal(gates.default, 'soft');
  assert.equal(gates.phaseStatus, 'hard');
  assert.equal(gates.generationCommit, 'soft');
  assert.equal(gates.publicationPending, 'hard');

  definition.sequenceGates.phaseStatus = 'sometimes';
  assert.throws(() => validateDefinition(definition), /sequenceGates\.phaseStatus must be hard or soft/);
  definition.sequenceGates.phaseStatus = 'soft';
  definition.sequenceGates.unknown = 'soft';
  assert.throws(() => validateDefinition(definition), /unknown gate 'unknown'/);
});

test('phase inputs normalize shorthand and reject invalid declarations', async () => {
  assert.deepEqual(normalizePhaseInputs(['requirements', { phase: 'design', optional: true, maxBytes: 128 }]), [
    { phase: 'requirements', optional: false, maxBytes: null },
    { phase: 'design', optional: true, maxBytes: 128 }
  ]);
  assert.throws(() => normalizePhaseInputs(['requirements', 'requirements']), /more than once/);
  assert.throws(() => normalizePhaseInputs([{ phase: 'requirements', maxBytes: 0 }]), /positive integer/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-input-order-')); await initializeDefinition(root);
  const definition = await loadDefinition(root);
  definition.workTypes.feature.phaseOverrides.design.inputs = ['verification'];
  assert.throws(() => validateDefinition(definition), /must precede the consumer/);
  definition.workTypes.feature.phaseOverrides.design.inputs = ['reproduction'];
  assert.throws(() => validateDefinition(definition), /inactive phase/);
  definition.inputsMode = 'sometimes';
  assert.throws(() => validateDefinition(definition), /inputsMode must be off, record, or enforce/);
});

test('work-type phase overrides merge world model, quality, comparison, and approval policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-overrides-')); await initializeDefinition(root);
  const definition = await loadDefinition(root);
  definition.workTypes.feature.phaseOverrides = { design: {
    worldModel: { depth: 'deep' }, qualityCommands: ['npm test'], comparison: { requireFiles: true }, approval: { minimum: 2 }
  } };
  const design = resolveWorkType(definition, 'feature').phases.find((phase) => phase.id === 'design');
  assert.equal(design.worldModel.depth, 'deep'); assert.deepEqual(design.worldModel.views, ['architecture', 'security']);
  assert.deepEqual(design.qualityCommands, ['npm test']); assert.equal(design.comparison.requireFiles, true);
  assert.equal(design.approval.minimum, 2); assert.deepEqual(design.approval.personas, ['architect']);
});

test('invalid persona approval capability is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-invalid-')); await initializeDefinition(root);
  const file = path.join(root, '.singularity/workflow.yml'); const definition = YAML.parse(await readFile(file, 'utf8')); definition.personas.architect.mayApprove = [];
  await writeFile(file, YAML.stringify(definition)); await assert.rejects(() => loadDefinition(root), /must list 'design' in mayApprove/);
});

test('optional token pricing accepts non-negative per-million rates and rejects invalid rates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-pricing-')); await initializeDefinition(root);
  const definition = await loadDefinition(root);
  definition.tokens.pricing = { 'provider-model': { input: 2.5, output: 10, cachedInput: 0.25 } };
  assert.equal(validateDefinition(definition).tokens.pricing['provider-model'].output, 10);
  definition.tokens.pricing['provider-model'].output = -1;
  assert.throws(() => validateDefinition(definition), /must be a non-negative number/);
});

test('legacy JSON configuration migrates to YAML without deleting source state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-migrate-')); const previousRoot = path.join(root, `.${['s', 'd', 'l', 'c'].join('')}`); await mkdir(previousRoot, { recursive: true });
  const legacy = { schemaVersion: 1, defaultBaseBranch: 'main', workItemRoot: '.singularity/work-items', idPattern: '^[A-Z0-9-]+$', phases: [{ id: 'requirements', label: 'Requirements', owner: 'product-owner', requiredArtifact: { path: 'artifacts/requirements/requirements.md', kind: 'requirements', minimumBytes: 100 }, qualityCommands: [] }] };
  await writeFile(path.join(previousRoot, 'config.json'), JSON.stringify(legacy));
  const stateDir = path.join(previousRoot, 'work-items/LEGACY-1'); await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, 'workflow.json'), JSON.stringify({ schemaVersion: 1, workItem: { id: 'LEGACY-1', title: 'Legacy', branch: 'LEGACY-1' }, status: 'in_progress', currentPhase: 'requirements', phaseOrder: ['requirements'], phases: { requirements: { id: 'requirements', label: 'Requirements', owner: 'product-owner', status: 'in_progress', artifacts: [], checks: [] } }, history: [] }));
  const result = await migrateLegacyConfig(root); assert.equal(result.migrated, true); assert.equal(result.migratedWorkItems, 1); assert.equal(result.movedStateRoot, true);
  const migrated = YAML.parse(await readFile(path.join(root, '.singularity/workflow.yml'), 'utf8')); assert.deepEqual(migrated.workTypes.legacy.phases, ['requirements']);
  assert.equal(JSON.parse(await readFile(path.join(root, '.singularity/config.json'), 'utf8')).schemaVersion, 1);
  const state = JSON.parse(await readFile(path.join(root, '.singularity/work-items/LEGACY-1/workflow.json'), 'utf8')); assert.equal(state.schemaVersion, 2); assert.equal(state.workItem.workType, 'legacy'); assert.ok(state.resolution.templates.requirements.sha256);
});
