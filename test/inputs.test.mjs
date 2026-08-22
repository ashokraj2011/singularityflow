import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyInputsBlock, collectInputs, extractInputsBlock, recordInputs, renderInputsBlock, verifyInputsIntegrity
} from '../src/inputs.mjs';
import { createAgentBriefs, verifyAgentBriefsForReview } from '../src/agent-briefs.mjs';
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

async function publishBrief(value, source, handle = 'sfref_test_approved_source') {
  await writeFile(value.producerPath, source);
  const info = await snapshot(value.producerPath);
  value.workflow.phases.requirements.artifacts[0] = {
    ...value.workflow.phases.requirements.artifacts[0], ...info
  };
  const briefs = await createAgentBriefs(value.root, value.workflow, value.workflow.phases.requirements, value);
  value.workflow.phases.requirements.agentBriefs = briefs;
  value.workflow.lineage = { submissions: [{
    phase: 'requirements', generation: 1, projection: {
      artifacts: [{
        path: value.workflow.phases.requirements.artifacts[0].path,
        sha256: info.sha256,
        size: info.size,
        reference: { handle }
      }],
      agentBriefs: briefs
    }
  }] };
  return briefs;
}

test('record mode captures complete approved content and records a managed block', async () => {
  const value = await fixture();
  const result = await collectInputs(value.root, value.workflow, value.phase, value);
  assert.equal(result.errors.length, 0); assert.equal(result.warnings.length, 0);
  assert.equal(result.records[0].status, 'captured'); assert.equal(result.records[0].truncated, false);
  assert.equal(result.records[0].repositoryPath, 'singularity/work-items/INPUT-1/artifacts/requirements/requirements.md');
  assert.match(result.records[0].content, /AC-001 complete behavior/);
  const rendered = renderInputsBlock(result);
  assert.match(rendered.text, /source=singularity\/work-items\/INPUT-1\/artifacts\/requirements\/requirements\.md/);
  const artifact = applyInputsBlock('# Design\n\n{{inputs}}\n', rendered.text, 'record');
  assert.equal(extractInputsBlock(artifact), rendered.text);
  const recorded = await recordInputs(value.root, value.workflow, value.phase, result, value);
  assert.match(recorded.path, /inputs-design-gen1\.json$/);
  assert.equal(JSON.parse(await readFile(recorded.file, 'utf8')).renderedSha256, rendered.sha256);
});

test('approved artifacts with managed inputs remain safe when injected downstream', async () => {
  const value = await fixture('enforce');
  await writeFile(value.producerPath, `# Requirements\n\n<!-- singularity-flow:inputs:start -->\n\n# Approved phase inputs\n\nUpstream evidence.\n\n<!-- singularity-flow:inputs:end -->\n\nAC-001 complete behavior.\n`);
  const info = await snapshot(value.producerPath);
  value.workflow.phases.requirements.artifacts[0] = {
    ...value.workflow.phases.requirements.artifacts[0],
    ...info
  };
  const result = await collectInputs(value.root, value.workflow, value.phase, value);
  const rendered = renderInputsBlock(result);
  const artifact = applyInputsBlock('# Design\n\n{{inputs}}\n', rendered.text, 'enforce');
  assert.equal((artifact.match(/singularity-flow:inputs:start/g) ?? []).length, 1);
  assert.equal((artifact.match(/singularity-flow:inputs:end/g) ?? []).length, 1);
  assert.match(artifact, /approved source inputs:start/);
  assert.equal(extractInputsBlock(artifact), rendered.text);
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

test('approved summaries inject bounded reviewed briefs and preserve exact critical sections', async () => {
  const declaration = {
    phase: 'requirements', optional: false, maxBytes: null, projection: 'approved-summary',
    preserve: ['Requirements'], maximumSummaryBytes: 4096,
    expansion: 'hash-bound-reference', fallback: 'block'
  };
  const value = await fixture('enforce', declaration);
  const [brief] = await publishBrief(value, [
    '# Requirements artifact', '',
    '## Agent brief', '', 'Build a bounded, approval-aware context handoff.', '',
    '## Requirements', '', '- REQ-001 — Preserve the exact critical requirement.', '',
    '## Detailed appendix', '', 'This long-form detail must not enter the ordinary agent prompt.'
  ].join('\n'));
  assert.equal(brief.status, 'ready');

  const result = await collectInputs(value.root, value.workflow, value.phase, value);
  assert.deepEqual(result.errors, []);
  assert.equal(result.records[0].status, 'captured');
  assert.equal(result.records[0].projection.kind, 'approved-summary');
  assert.match(result.records[0].content, /bounded, approval-aware context handoff/);
  assert.match(result.records[0].content, /REQ-001/);
  assert.doesNotMatch(result.records[0].content, /long-form detail/);
  assert.equal(result.records[0].projection.expansionHandle, 'sfref_test_approved_source');
  const rendered = renderInputsBlock(result).text;
  assert.match(rendered, /Exact source expansion/);
  assert.match(rendered, /singularity-flow show sfref_test_approved_source/);
});

test('brief tampering fails closed and whole-artifact fallback does not require summary-only preserved sections', async () => {
  const declaration = {
    phase: 'requirements', optional: false, maxBytes: null, projection: 'approved-summary',
    preserve: ['Requirements', 'Non-functional requirements'], maximumSummaryBytes: 4096,
    expansion: 'hash-bound-reference', fallback: 'whole'
  };
  const value = await fixture('enforce', declaration);
  const [brief] = await publishBrief(value, '# Requirements\n\nExact full artifact without a summary section.\n');
  assert.equal(brief.status, 'fallback-whole');
  let result = await collectInputs(value.root, value.workflow, value.phase, value);
  assert.deepEqual(result.errors, []);
  assert.equal(result.records[0].projection.kind, 'fallback-whole');
  assert.match(result.records[0].content, /Exact full artifact/);

  await writeFile(value.producerPath, [
    '# Requirements', '',
    '## Agent brief', '', 'Compact approved text.', '',
    '## Non-functional requirements', '', 'Brief integrity is verified before use.', ''
  ].join('\n'));
  const info = await snapshot(value.producerPath);
  value.workflow.phases.requirements.artifacts[0] = { ...value.workflow.phases.requirements.artifacts[0], ...info };
  const next = await createAgentBriefs(value.root, value.workflow, value.workflow.phases.requirements, value);
  value.workflow.phases.requirements.agentBriefs = next;
  value.workflow.lineage.submissions[0].projection.artifacts[0] = {
    ...value.workflow.lineage.submissions[0].projection.artifacts[0], sha256: info.sha256, size: info.size
  };
  value.workflow.lineage.submissions[0].projection.agentBriefs = next;
  await writeFile(path.join(value.root, next[0].renderedPath), '# altered brief\n');
  result = await collectInputs(value.root, value.workflow, value.phase, value);
  assert.equal(result.records[0].status, 'brief_invalid');
  assert.match(result.errors[0], /brief bytes changed/);
  const review = await verifyAgentBriefsForReview(
    value.root, value.workflow, value.workflow.phases.requirements, value
  );
  assert.equal(review.valid, false);
  assert.match(review.errors[0], /brief bytes changed/);
});

test('a block fallback refuses publication when no authored summary exists', async () => {
  const declaration = {
    phase: 'requirements', optional: false, maxBytes: null, projection: 'approved-summary',
    preserve: [], maximumSummaryBytes: 4096,
    expansion: 'hash-bound-reference', fallback: 'block'
  };
  const value = await fixture('enforce', declaration);
  await assert.rejects(
    () => publishBrief(value, [
      '# Requirements', '', 'No summary heading is authored.', '',
      '```markdown', '## Agent brief', 'This code example is not an authored section.', '```', '',
      '<!--', '## Summary', 'This template instruction is not authored evidence.', '-->'
    ].join('\n')),
    /requires an Agent brief/
  );
});
