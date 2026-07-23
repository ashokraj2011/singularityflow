import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyInputsBlock, collectInputs, extractInputsBlock, recordInputs, renderInputsBlock, verifyInputsIntegrity
} from '../src/inputs.mjs';
import { snapshot } from '../src/util.mjs';

async function fixture(mode = 'record', declaration = { phase: 'requirements', optional: false, maxBytes: null, path: 'artifacts/requirements/requirements.md' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-inputs-'));
  const itemRelative = 'singularity/work-items/INPUT-1';
  const itemDirectory = path.join(root, itemRelative);
  const producerPath = path.join(itemDirectory, 'artifacts/requirements/requirements.md');
  await mkdir(path.dirname(producerPath), { recursive: true });
  await writeFile(producerPath, '# Requirements\n\nAC-001 complete behavior.\n');
  const info = await snapshot(producerPath);
  const repositoryPath = `${itemRelative}/artifacts/requirements/requirements.md`;
  const producer = {
    id: 'requirements', status: 'approved', generation: 1, approvedAt: '2026-01-01T00:00:00.000Z', approvedBy: 'reviewer',
    requiredArtifact: { path: 'artifacts/requirements/requirements.md' },
    artifacts: [{ path: repositoryPath, status: 'approved', ...info }]
  };
  const phase = { id: 'design', generation: 0, requiredArtifact: { path: 'artifacts/design/design.md' }, inputs: [declaration] };
  const workflow = {
    workItem: { id: 'INPUT-1', workType: 'feature' },
    resolution: { inputsMode: mode, phases: [{ id: 'design', inputs: [declaration] }] },
    phases: { requirements: producer, design: phase }
  };
  return { root, itemRelative, itemDirectory, producerPath, workflow, phase };
}

test('record mode captures complete approved content and records a managed block', async () => {
  const value = await fixture();
  const result = await collectInputs(value.root, value.workflow, value.phase, value);
  assert.equal(result.errors.length, 0); assert.equal(result.warnings.length, 0);
  assert.equal(result.records[0].status, 'captured'); assert.equal(result.records[0].truncated, false);
  assert.match(result.records[0].content, /AC-001 complete behavior/);
  const rendered = renderInputsBlock(result); const artifact = applyInputsBlock('# Design\n\n{{inputs}}\n', rendered.text, 'record');
  assert.equal(extractInputsBlock(artifact), rendered.text);
  const recorded = await recordInputs(value.root, value.workflow, value.phase, result, value);
  assert.match(recorded.path, /inputs-design-gen1\.json$/);
  assert.equal(JSON.parse(await readFile(recorded.file, 'utf8')).renderedSha256, rendered.sha256);
});

test('explicit input budgets truncate safely while omitted budgets do not', async () => {
  const value = await fixture('record', { phase: 'requirements', optional: false, maxBytes: 12, path: 'artifacts/requirements/requirements.md' });
  const limited = await collectInputs(value.root, value.workflow, value.phase, value);
  assert.equal(limited.records[0].injectedBytes <= 12, true); assert.equal(limited.records[0].truncated, true);
  value.workflow.resolution.phases[0].inputs[0].maxBytes = null;
  const complete = await collectInputs(value.root, value.workflow, value.phase, value);
  assert.equal(complete.records[0].bytes, complete.records[0].injectedBytes);
});

test('record warns and enforce fails for required unavailable or tampered inputs', async () => {
  const value = await fixture('record'); value.workflow.phases.requirements.status = 'awaiting_approval';
  const warning = await collectInputs(value.root, value.workflow, value.phase, value);
  assert.equal(warning.records[0].status, 'unapproved'); assert.equal(warning.warnings.length, 1); assert.equal(warning.errors.length, 0);
  value.workflow.resolution.inputsMode = 'enforce';
  const enforced = await collectInputs(value.root, value.workflow, value.phase, value);
  assert.equal(enforced.errors.length, 1); assert.match(enforced.errors[0], /requirements is awaiting_approval/);
  value.workflow.phases.requirements.status = 'approved'; await writeFile(value.producerPath, '# tampered\n');
  const tampered = await collectInputs(value.root, value.workflow, value.phase, value);
  assert.equal(tampered.records[0].status, 'hash_mismatch'); assert.match(tampered.errors[0], /approved hash/);
});

test('optional unavailable inputs are omitted and off mode is inert', async () => {
  const optional = await fixture('enforce', { phase: 'requirements', optional: true, maxBytes: null, path: 'artifacts/requirements/requirements.md' });
  optional.workflow.phases.requirements.status = 'not_started';
  const omitted = await collectInputs(optional.root, optional.workflow, optional.phase, optional);
  assert.equal(omitted.errors.length, 0); assert.equal(omitted.records[0].status, 'unapproved');
  optional.workflow.resolution.inputsMode = 'off';
  const off = await collectInputs(optional.root, optional.workflow, optional.phase, optional);
  assert.deepEqual(off.records, []); assert.equal(applyInputsBlock('A {{inputs}} B', 'unused', 'off'), 'A  B');
});

test('integrity verification is mode-aware and detects artifact block changes', async () => {
  const value = await fixture('record'); const result = await collectInputs(value.root, value.workflow, value.phase, value);
  const rendered = renderInputsBlock(result); const artifactPath = path.join(value.itemDirectory, value.phase.requiredArtifact.path);
  await mkdir(path.dirname(artifactPath), { recursive: true }); await writeFile(artifactPath, applyInputsBlock('# Design\n', rendered.text, 'record'));
  await recordInputs(value.root, value.workflow, value.phase, result, value); value.phase.generation = 1;
  let verified = await verifyInputsIntegrity(value.root, value.workflow, value.phase, value);
  assert.equal(verified.errors.length, 0); assert.equal(verified.warnings.length, 0); assert.match(verified.passes[0], /design ← requirements@/);
  await writeFile(artifactPath, '# managed block removed\n');
  verified = await verifyInputsIntegrity(value.root, value.workflow, value.phase, value);
  assert.equal(verified.errors.length, 0); assert.match(verified.warnings[0], /managed input block/);
  value.workflow.resolution.inputsMode = 'enforce';
  verified = await verifyInputsIntegrity(value.root, value.workflow, value.phase, value);
  assert.ok(verified.errors.length > 0);
});
