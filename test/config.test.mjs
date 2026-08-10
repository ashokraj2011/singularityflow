import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  initializeDefinition,
  loadDefinition,
  normalizePhaseInputs,
  normalizePlanning,
  normalizeSequenceGates,
  normalizeSessionPolicy,
  agentPrompt,
  renderArtifactTemplate,
  resolveWorkType,
  snapshotResolution,
  validateDefinition
} from '../src/config.mjs';
import { groundingMode } from '../src/grounding.mjs';
import {
  contextBoundaryHandoff, normalizeContextPolicy
} from '../src/context-policy.mjs';

test('starter YAML resolves feature, bugfix, and Figma-mobile templates and agents', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-')); await mkdir(path.join(root, '.git'), { recursive: true }); await initializeDefinition(root);
  const definition = await loadDefinition(root); const feature = resolveWorkType(definition, 'feature'); const bugfix = resolveWorkType(definition, 'bugfix'); const figmaMobile = resolveWorkType(definition, 'figma-mobile');
  assert.equal(feature.phases.find((item) => item.id === 'implementation-spec').template, 'feature/implementation-spec.md');
  assert.equal(bugfix.phases.find((item) => item.id === 'fix-spec').template, 'bugfix/fix-spec.md');
  assert.deepEqual(feature.documents.allowedPhases, ['intake', 'requirements', 'design', 'implementation-spec']);
  assert.deepEqual(bugfix.documents.allowedPhases, ['intake', 'reproduction', 'fix-design', 'fix-spec']);
  assert.deepEqual(feature.contextPolicy, { onApproval: 'new', onRejection: 'keep', phaseOverrides: {} });
  assert.match(await agentPrompt(root, definition, 'architect'), /boundaries, contracts/);
  assert.equal(definition.inputsMode, 'enforce');
  // The shipped default reports rather than blocks: a repository with no world model yet, or no
  // model provider at all, must still be able to run its lifecycle.
  assert.equal(definition.worldModel.grounding, 'warn');
  assert.deepEqual(definition.session, { workItemSelection: 'prompt', requireBeforeTools: false });
  assert.equal(feature.sequenceGates.phaseStatus, 'soft');
  assert.equal(feature.sequenceGates.documentPhase, 'soft');
  assert.equal(feature.sequenceGates.publicationPending, 'hard');
  assert.deepEqual(feature.phases.find((item) => item.id === 'design').inputs, [{ phase: 'requirements', optional: false, maxBytes: null, path: 'artifacts/requirements/requirements.md' }]);
  assert.deepEqual(feature.phases.find((item) => item.id === 'intake').clarification, {
    mode: 'required', maxQuestions: 5, topics: ['problem', 'outcome', 'users', 'scope', 'constraints']
  });
  assert.equal(feature.phases.find((item) => item.id === 'requirements').clarification.mode, 'required');
  assert.equal(feature.phases.find((item) => item.id === 'design').clarification.mode, 'required');
  assert.equal(feature.phases.find((item) => item.id === 'implementation-spec').clarification.mode, 'required');
  assert.equal(bugfix.phases.find((item) => item.id === 'reproduction').clarification.mode, 'required');
  assert.equal(figmaMobile.phases.find((item) => item.id === 'design-intake').clarification.mode, 'required');
  assert.equal(figmaMobile.phases.find((item) => item.id === 'mobile-spec').clarification.mode, 'required');
  assert.deepEqual(bugfix.phases.find((item) => item.id === 'verification').inputs.map((item) => item.phase), ['fix-spec', 'implementation']);
  assert.deepEqual(figmaMobile.phases.map((item) => item.id), ['design-intake', 'design-inventory', 'component-mapping', 'mobile-spec', 'implementation', 'visual-verification', 'conformance']);
  assert.deepEqual(figmaMobile.documents.allowedPhases, ['design-intake', 'design-inventory']);
  assert.equal(figmaMobile.sequenceGates.documentPhase, 'hard');
  assert.equal(figmaMobile.phases.find((item) => item.id === 'mobile-spec').template, 'figma-mobile/mobile-spec.md');
  assert.deepEqual(figmaMobile.phases.find((item) => item.id === 'implementation').inputs.map((item) => item.phase), ['component-mapping', 'mobile-spec']);
  assert.equal(figmaMobile.phases.find((item) => item.id === 'visual-verification').approval.minimum, 2);
  assert.equal(figmaMobile.phases.find((item) => item.id === 'conformance').approval.minimum, 2);
  assert.deepEqual(figmaMobile.designSources, {
    capturePhase: 'design-intake',
    consumeIn: ['design-inventory', 'component-mapping', 'mobile-spec', 'visual-verification', 'conformance'],
    staleness: 'warn',
    requireApprovedSet: true,
    inventoryDigest: 'optional'
  });
  const figmaSnapshot = await snapshotResolution(root, definition, figmaMobile);
  assert.deepEqual(figmaSnapshot.worldModelMaterialization, {
    mode: 'explicit', publish: 'governed', lookahead: 'none', depth: 'phase', confirmation: 'prompt'
  });
  assert.deepEqual(figmaSnapshot.designSources, figmaMobile.designSources);
  assert.match(await agentPrompt(root, definition, 'product-designer'), /hash-pinned exports/i);
  assert.match(await readFile(path.join(root, 'singularity/templates/figma-mobile/visual-verification.md'), 'utf8'), /Screen comparison/);
});

test('world-model on-demand policy permits automatic deterministic light builds only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-materialization-config-'));
  await initializeDefinition(root);
  const definition = await loadDefinition(root);
  definition.worldModel.materialization = {
    mode: 'on-demand', publish: 'governed', lookahead: 'none', depth: 'light', confirmation: 'automatic'
  };
  assert.doesNotThrow(() => validateDefinition(definition));
  const resolution = await snapshotResolution(root, definition, resolveWorkType(definition, 'feature'));
  assert.deepEqual(resolution.worldModelMaterialization, definition.worldModel.materialization);

  definition.worldModel.materialization.depth = 'phase';
  assert.throws(
    () => validateDefinition(definition),
    /automatic.*requires depth 'light'/
  );
});

test('design-source policy rejects inactive, duplicate, and invalid lifecycle declarations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-design-source-config-'));
  await initializeDefinition(root);
  const definition = await loadDefinition(root);
  definition.workTypes['figma-mobile'].designSources.consumeIn = ['mobile-spec', 'mobile-spec'];
  assert.throws(() => validateDefinition(definition), /consumeIn must not contain duplicates/);
  definition.workTypes['figma-mobile'].designSources.consumeIn = ['requirements'];
  assert.throws(() => validateDefinition(definition), /inactive phase 'requirements'/);
  definition.workTypes['figma-mobile'].designSources.consumeIn = ['mobile-spec'];
  definition.workTypes['figma-mobile'].designSources.capturePhase = 'requirements';
  assert.throws(() => validateDefinition(definition), /capturePhase 'requirements' is not active/);
  definition.workTypes['figma-mobile'].designSources.capturePhase = 'design-intake';
  definition.workTypes['figma-mobile'].designSources.staleness = 'sometimes';
  assert.throws(() => validateDefinition(definition), /staleness must be ignore, warn, or fail/);
});

test('workflow loading rejects symlinked governance templates instead of reading outside the repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-boundary-'));
  await initializeDefinition(root);
  const outside = path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-config-outside-')), 'design.md');
  await writeFile(outside, '# external instructions\n');
  const template = path.join(root, 'singularity/templates/feature/design.md');
  await unlink(template);
  await symlink(outside, template);
  await assert.rejects(() => loadDefinition(root), /Template for work type 'feature' phase 'design'.*symbolic link/);
});

test('artifact rendering enforces the work-item template hash snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-template-pin-'));
  await initializeDefinition(root);
  const definition = await loadDefinition(root);
  const resolved = resolveWorkType(definition, 'feature');
  const pinned = await snapshotResolution(root, definition, resolved);
  const design = resolved.phases.find((phase) => phase.id === 'design');
  await writeFile(path.join(root, pinned.templates.design.path), '# changed after intake\n');
  await assert.rejects(
    () => renderArtifactTemplate(root, definition, design, {
      id: 'PIN-1',
      title: 'Pinned template',
      workType: 'feature',
      templateSnapshot: pinned.templates.design
    }),
    /changed after this work item was created/
  );
});

test('Copilot session policy configures work selection while phase agents remain automatic', () => {
  assert.deepEqual(normalizeSessionPolicy(), { workItemSelection: 'off', requireBeforeTools: false });
  assert.deepEqual(normalizeSessionPolicy({ workItemSelection: 'prompt', requireBeforeTools: true }), { workItemSelection: 'prompt', requireBeforeTools: true });
  assert.throws(() => normalizeSessionPolicy({ workItemSelection: 'always' }), /workItemSelection must be off, reuse, or prompt/);
  assert.throws(() => normalizeSessionPolicy({ agentSelection: 'prompt' }), /unknown field 'agentSelection'/);
  assert.throws(() => normalizeSessionPolicy({ promptOnResume: true }), /unknown field 'promptOnResume'/);
  assert.throws(() => normalizeSessionPolicy({ defaultAgent: 'developer' }), /unknown field/);
});

test('phase context boundaries default legacy configs to keep and support approval overrides', () => {
  assert.deepEqual(normalizeContextPolicy(), { onApproval: 'keep', onRejection: 'keep', phaseOverrides: {} });
  assert.deepEqual(
    normalizeContextPolicy({
      onApproval: 'new',
      onRejection: 'keep',
      phaseOverrides: { implementation: 'compact' }
    }, { phaseIds: ['requirements', 'implementation'] }),
    { onApproval: 'new', onRejection: 'keep', phaseOverrides: { implementation: 'compact' } }
  );
  assert.deepEqual(contextBoundaryHandoff({ onApproval: 'new' }, 'requirements', { nextPhase: 'design' }).commands, ['/clear', '/sf-next']);
  assert.deepEqual(contextBoundaryHandoff({ onApproval: 'compact' }, 'requirements', { nextSkill: '/sflow-initiative-next' }).commands, ['/compact', '/sflow-initiative-next']);
  assert.deepEqual(contextBoundaryHandoff({ onApproval: 'new' }, 'conformance', { complete: true }).commands, ['/clear']);
  assert.throws(() => normalizeContextPolicy({ onApproval: 'reset' }), /must be keep, compact, or new/);
  assert.throws(() => normalizeContextPolicy({ phaseOverrides: { missing: 'new' } }, { phaseIds: ['intake'] }), /unknown phase 'missing'/);
  assert.throws(() => normalizeContextPolicy({ phaseBoundary: 'new', onApproval: 'compact' }), /must match/);
});

test('governed Copilot planning configuration has bounded, repository-safe defaults', () => {
  assert.deepEqual(normalizePlanning(), {
    enabled: true,
    promptSource: 'singularity/prompts/copilot-planning.md',
    maxContextBytes: 1048576
  });
  assert.deepEqual(normalizePlanning({ enabled: false, promptSource: 'singularity/prompts/custom-planner.md', maxContextBytes: 32768 }), {
    enabled: false,
    promptSource: 'singularity/prompts/custom-planner.md',
    maxContextBytes: 32768
  });
  assert.throws(() => normalizePlanning({ promptSource: '../outside.md' }), /repository-relative path/);
  assert.throws(() => normalizePlanning({ maxContextBytes: 1024 }), /16384 through 10485760/);
  assert.throws(() => normalizePlanning({ model: 'forced-model' }), /unknown field/);
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
  delete definition.worldModel.grounding;
  // staleness only ever matched 'fail' and 'warn' at the call sites, so a typo used to disarm the
  // freshness guard in silence. The accepted set must match schemas/workflow-definition.schema.json.
  for (const mode of ['warn', 'fail', 'ignore']) {
    definition.worldModel.staleness = mode;
    assert.doesNotThrow(() => validateDefinition(definition), `expected staleness '${mode}' to be accepted`);
  }
  delete definition.worldModel.staleness;
  assert.doesNotThrow(() => validateDefinition(definition));
  definition.worldModel.staleness = 'Fail';
  assert.throws(() => validateDefinition(definition), /worldModel\.staleness must be 'warn', 'fail', or 'ignore'/);
});

test('world-model parallel generation policy is bounded and view-scoped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-world-model-generation-'));
  await initializeDefinition(root);
  const definition = await loadDefinition(root);
  assert.deepEqual(definition.worldModel.generation, { parallel: true, maxWorkers: 4, strategy: 'view' });
  definition.worldModel.generation.maxWorkers = 17;
  assert.throws(() => validateDefinition(definition), /maxWorkers must be an integer from 1 through 16/);
  definition.worldModel.generation.maxWorkers = 2;
  definition.worldModel.generation.strategy = 'component';
  assert.throws(() => validateDefinition(definition), /strategy must be 'view'/);
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
  assert.equal(design.approval.minimum, 2); assert.deepEqual(design.approval.authorities, ['architecture-reviewers']);
});

test('invalid approval authority reference is rejected independently of governed agents', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-invalid-')); await initializeDefinition(root);
  const file = path.join(root, 'singularity/workflow.yml'); const definition = YAML.parse(await readFile(file, 'utf8')); definition.phases.design.approval.authorities = ['missing-reviewers'];
  await writeFile(file, YAML.stringify(definition)); await assert.rejects(() => loadDefinition(root), /unknown authority 'missing-reviewers'/);
});

test('optional token pricing accepts non-negative per-million rates and rejects invalid rates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-pricing-')); await initializeDefinition(root);
  const definition = await loadDefinition(root);
  definition.tokens.pricing = { 'provider-model': { input: 2.5, output: 10, cachedInput: 0.25 } };
  assert.equal(validateDefinition(definition).tokens.pricing['provider-model'].output, 10);
  definition.tokens.pricing['provider-model'].output = -1;
  assert.throws(() => validateDefinition(definition), /must be a non-negative number/);
});

test('workflow.yml storage providers normalize and reject invalid SharePoint config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-storage-')); await mkdir(path.join(root, '.git'), { recursive: true }); await initializeDefinition(root);
  const base = await loadDefinition(root);

  const valid = structuredClone(base);
  valid.storage = { providers: { onedrive: { type: 'sharepoint', tenantId: 't', clientId: 'c', siteId: 's', driveId: 'd' } } };
  const normalized = validateDefinition(valid);
  assert.equal(normalized.storage.defaultProvider, 'onedrive');
  assert.deepEqual(normalized.storage.providers.onedrive.scopes, ['offline_access', 'User.Read', 'Files.ReadWrite.All']);

  const missingField = structuredClone(base);
  missingField.storage = { providers: { onedrive: { type: 'sharepoint', tenantId: 't', clientId: 'c', siteId: 's' } } };
  assert.throws(() => validateDefinition(missingField), /SharePoint provider 'onedrive' requires driveId/);

  const badType = structuredClone(base);
  badType.storage = { providers: { onedrive: { type: 'dropbox' } } };
  assert.throws(() => validateDefinition(badType), /unsupported type 'dropbox'/);

  const badDefault = structuredClone(base);
  badDefault.storage = { defaultProvider: 'ghost', providers: { onedrive: { type: 'sharepoint', tenantId: 't', clientId: 'c', siteId: 's', driveId: 'd' } } };
  assert.throws(() => validateDefinition(badDefault), /defaultProvider references unknown provider 'ghost'/);
});
