import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { phasePrepublish } from '../src/phase-prepublish.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-prepublish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const relative = 'singularity/work-items/PRE-1/artifacts/planning/plan.md';
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, '# Plan\n\nTODO describe the plan.\n');
  const phase = {
    id: 'planning', label: 'Planning', status: 'in_progress', generation: 0,
    generationPolicy: { defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
    requiredArtifact: { path: 'artifacts/planning/plan.md', minimumBytes: 20,
      validation: { requiredHeadings: ['Plan'], forbiddenPlaceholders: [] } },
    artifacts: []
  };
  const workflow = { workItem: { id: 'PRE-1' }, currentPhase: 'planning',
    resolution: { phases: [], artifactSets: {} }, phases: { planning: phase } };
  const session = { workId: 'PRE-1', phaseId: 'planning', agent: 'architect' };
  return { root, absolute, config: { workItemRoot: 'singularity/work-items' }, workflow, phase, session };
}

test('prepublish routes authored findings to same-phase correction, then enables publication only when ready', async (t) => {
  const item = await fixture(t);
  const original = await readFile(item.absolute, 'utf8');
  const red = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(red.resultType, 'sflow-phase-prepublish');
  assert.equal(red.status, 'correction-required');
  assert.equal(red.workId, 'PRE-1');
  assert.equal(red.phase, 'planning');
  assert.equal(red.readiness.authoring, false);
  assert.equal(red.correction.sameTurn, true);
  assert.equal(red.commands.publish, null);
  assert.equal(red.commands.recheck, 'singularity-flow phase prepublish planning --json');
  assert.equal(red.mutates, false);
  assert.equal(await readFile(item.absolute, 'utf8'), original);

  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  const ready = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.findings, []);
  assert.equal(ready.readiness.lifecycle, true);
  assert.equal(ready.readiness.knownRecoveryBlockers, true);
  assert.match(ready.commands.publish, /phase publish planning --authored governed-agent/u);
  assert.notEqual(ready.draftFingerprint, red.draftFingerprint);
});

test('prepublish never presents a publish command for a non-current or non-in-progress phase', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  item.workflow.currentPhase = 'verification';
  const red = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(red.status, 'correction-required');
  assert.equal(red.readiness.lifecycle, false);
  assert.equal(red.commands.publish, null);
  assert.ok(red.findings.some((finding) => finding.code === 'phase.lifecycle.not-publishable'));
});

test('prepublish refuses a code phase before its governed generation begins', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  item.phase.id = 'implementation';
  item.phase.label = 'Implementation';
  item.phase.generationPolicy.task = 'code';
  item.workflow.currentPhase = 'implementation';
  item.workflow.phases = { implementation: item.phase };
  const result = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: { ...item.session, phaseId: 'implementation' } });
  assert.equal(result.status, 'correction-required');
  assert.equal(result.readiness.knownRecoveryBlockers, false);
  assert.equal(result.commands.publish, null);
  assert.equal(result.commands.next, 'singularity-flow phase begin implementation');
  assert.ok(result.findings.some((finding) => finding.code === 'phase.generation-intent.required'));
});

test('prepublish never promises publication for an unqualified skill phase or missing assignment', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  item.phase.kind = 'skill';
  item.workflow.resolution.collaboration = { assignmentMode: 'required' };
  const result = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(result.status, 'correction-required');
  assert.equal(result.commands.publish, null);
  assert.equal(result.correction.sameTurn, false);
  assert.ok(result.findings.some((finding) => finding.code === 'phase.skill-host.unavailable'));
  assert.ok(result.findings.some((finding) => finding.code === 'phase.assignment.required'));
});

test('prepublish refuses an unreadable retained publication marker without rewriting it', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  execFileSync('git', ['init', '-q', item.root]);
  const marker = path.join(item.root, '.git', 'singularity-flow', 'pending-publication',
    'story--PRE-1.json');
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, '{not-json');
  const original = await readFile(marker, 'utf8');
  const result = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(result.status, 'correction-required');
  assert.equal(result.commands.publish, null);
  assert.equal(result.correction.sameTurn, false);
  assert.ok(result.findings.some((finding) => finding.code === 'phase.publication.unreadable'));
  assert.equal(await readFile(marker, 'utf8'), original);
});
