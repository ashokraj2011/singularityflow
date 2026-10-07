import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { phaseFindingPolicy } from '../src/phase-finding-policy.mjs';
import { phaseResolutionProjection } from '../src/phase-resolution.mjs';
import { createPhaseCheckpoint, inspectPhaseCheckpoint } from '../src/phase-checkpoint.mjs';
import { artifactQualityBinding, prepareArtifactQualityRisk } from '../src/phase-artifact-risk.mjs';
import { validateQualityRiskPacket } from '../src/phase-quality-risk.mjs';
import { inspectPhaseAuthoredReviewContent } from '../src/publication-preflight.mjs';
import { recordSha256 } from '../src/records.mjs';
import { resolveOperation, operationById } from '../src/command-registry.mjs';

async function fixture(t, id = 'team-defined-delivery') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-preserve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-qb', 'story'); git('config', 'user.name', 'Recovery Tester'); git('config', 'user.email', 'recovery@example.test');
  await writeFile(path.join(root, 'source.txt'), 'Original source\n'); git('add', '.'); git('commit', '-qm', 'Base');
  const phase = { id, status: 'in_progress', generation: 0, artifacts: [],
    generationPolicy: { defaultProducer: 'governed-agent' },
    requiredArtifact: { path: `artifacts/${id}/report.md`, minimumBytes: 10 } };
  const workflow = { status: 'in_progress', currentPhase: id, phaseOrder: ['approved-input', id],
    workItem: { id: 'PRESERVE-1', branch: 'story' }, resolution: { phases: [], qualityGateMode: 'soft' },
    phases: { 'approved-input': { id: 'approved-input', generation: 1, status: 'approved', approvedBy: 'human' }, [id]: phase } };
  const file = `singularity/work-items/PRESERVE-1/${phase.requiredArtifact.path}`;
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), '# Reviewed draft\n\nCompleted analysis. TODO record the remaining limitation.\n');
  return { root, phase, workflow, file, git, config: { workItemRoot: 'singularity/work-items' } };
}

test('all findings retain a preservation route and installed policy cannot be widened by error hints', () => {
  const workflow = { workItem: { id: 'P-1' } }; const phase = { id: 'any-phase' };
  for (const finding of [
    { code: 'artifact.placeholder.unresolved', category: 'authoring', path: 'report.md', value: 'TODO' },
    { code: 'phase.grounding.required', category: 'grounding' },
    { code: 'UNKNOWN_PLUGIN_FAILURE' }, { code: 'WORKTREE_DIRTY', category: 'worktree' },
    { code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE', details: { riskEligible: true } }
  ]) {
    const result = phaseResolutionProjection(workflow, phase, [finding]);
    assert.equal(result.contract.automaticDiscard, false);
    assert.equal(result.contract.exhaustedAutomationBlocksManualRepair, false);
    assert.ok(result.issues[0].choices.some(choice => choice.kind === 'preserve-checkpoint'));
    assert.ok(result.issues[0].choices.every(choice => choice.automatic === false));
  }
  for (const code of ['PROTECTED_PATH', 'SECRET_FOUND', 'PATH_UNSAFE', 'PHASE_APPEAL_INTEGRITY']) {
    const result = phaseFindingPolicy({ code, category: 'authoring', details: { riskEligible: true } });
    assert.equal(result.riskEligible, false); assert.equal(result.repairableByProducer, false);
  }
  assert.equal(phaseFindingPolicy({ code: 'specification.verification-contract-invalid', category: 'verification-contracts' }).repairableByProducer, true);
});

test('wrapped quality findings retain exact risk selectors and cosmetic changes cannot reset the loop', () => {
  const workflow = { workItem: { id: 'P-1' } }; const phase = { id: 'custom-phase', status: 'in_progress' };
  const finding = { code: 'phase.artifact.invalid', category: 'authoring', path: 'report.md',
    value: 'TODO', line: 2, message: 'Original presentation', details: { sourceCode: 'artifact.placeholder.unresolved' } };
  const before = phaseResolutionProjection(workflow, phase, [finding]);
  const after = phaseResolutionProjection(workflow, phase, [{ ...finding, line: 99, message: 'Different wording' }]);
  assert.equal(before.retry.fingerprint, after.retry.fingerprint);
  const risk = before.issues[0].choices.find(choice => choice.kind === 'pilot-risk-review');
  assert.equal(risk.argv[risk.argv.indexOf('--finding') + 1], 'artifact.placeholder.unresolved');
  assert.equal(before.issues[0].policy.riskEligible, true);
});

test('missing generation preparation has an executable route, while a consumed intent retains recovery', () => {
  const workflow = { workItem: { id: 'P-1' } }; const phase = { id: 'team-code', status: 'in_progress' };
  const finding = { code: 'phase.generation-intent.required', category: 'code-delivery',
    details: { sourceCode: 'GENERATION_INTENT_REQUIRED' } };
  const route = phaseResolutionProjection(workflow, phase, [finding]).issues[0].choices[0];
  assert.deepEqual(route.argv, ['phase', 'begin', 'team-code', '--work-id', 'P-1', '--json']);
  assert.equal(route.automatic, false); assert.match(route.detail, /adoption preview/);
  const published = { ...phase, generationIntent: { status: 'consumed', generation: 1 } };
  assert.equal(phaseResolutionProjection(workflow, published, [finding]).issues[0].choices[0].kind, 'inspect');
});

test('recovery copies preserve dirty files, staged bytes and deletions without a commit or index change', async t => {
  const f = await fixture(t); const originalHead = f.git('rev-parse', 'HEAD');
  await writeFile(path.join(f.root, 'notes.txt'), 'Staged original\n'); f.git('add', 'notes.txt');
  await writeFile(path.join(f.root, 'notes.txt'), 'Unstaged newer content\n');
  await rm(path.join(f.root, 'source.txt'));
  const beforeIndex = await readFile(path.join(f.root, '.git/index'));
  const beforeStatus = f.git('status', '--porcelain=v1');
  const saved = await createPhaseCheckpoint(f.root, f.config, f.workflow, f.phase);
  const same = await createPhaseCheckpoint(f.root, f.config, f.workflow, f.phase);
  assert.equal(saved.id, same.id); assert.equal(saved.indexChanged, false);
  const receipt = await inspectPhaseCheckpoint(f.root, f.workflow, f.phase, saved.id);
  assert.equal(receipt.files.find(file => file.path === 'source.txt').kind, 'missing');
  const note = receipt.files.find(file => file.path === 'notes.txt');
  assert.equal(await readFile(note.recoveryCopy, 'utf8'), 'Unstaged newer content\n');
  assert.deepEqual(await readFile(receipt.index.recoveryCopy), beforeIndex);
  assert.deepEqual(await readFile(path.join(f.root, '.git/index')), beforeIndex);
  assert.equal(f.git('rev-parse', 'HEAD'), originalHead); assert.equal(f.git('status', '--porcelain=v1'), beforeStatus);
  assert.equal(receipt.automaticRestore, false);
  await writeFile(note.recoveryCopy, 'tampered copy');
  await assert.rejects(inspectPhaseCheckpoint(f.root, f.workflow, f.phase, saved.id), { code: 'PHASE_CHECKPOINT_INTEGRITY' });
});

test('linked source never escapes preservation and unsafe IDs cannot select another recovery store', async t => {
  const f = await fixture(t);
  await symlink('/etc/hosts', path.join(f.root, 'linked.txt'));
  await assert.rejects(createPhaseCheckpoint(f.root, f.config, f.workflow, f.phase));
  assert.equal(f.git('status', '--porcelain=v1').includes('linked.txt'), true);
  await assert.rejects(inspectPhaseCheckpoint(f.root, f.workflow, f.phase, '../elsewhere'));
});

test('preservation does not refresh the index when a clean tracked file has new filesystem metadata', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'source.txt'), 'Original source\n');
  const before = await readFile(path.join(f.root, '.git/index'));
  await createPhaseCheckpoint(f.root, f.config, f.workflow, f.phase);
  assert.deepEqual(await readFile(path.join(f.root, '.git/index')), before);
});

test('quality exceptions bind any authored phase, remain stable across publication bookkeeping, and invalidate on upstream/content drift', async t => {
  for (const id of ['specification', 'planning', 'implementation', 'verification', 'release', 'customer-custom-phase']) {
    await t.test(id, async child => {
      const f = await fixture(child, id);
      const options = { findings: ['artifact.placeholder.unresolved'],
        expires: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        reason: 'The exact unfinished explanatory paragraph is deferred during this reviewed pilot.' };
      const packet = await prepareArtifactQualityRisk(f.root, f.config, f.workflow, f.phase, options);
      assert.deepEqual(validateQualityRiskPacket(packet), packet);
      assert.equal(packet.schemaVersion, 2); assert.equal(packet.binding.generation, 1);
      assert.deepEqual(packet.transitions, ['approve', 'consume', 'publish', 'submit', 'terminal']);
      const before = packet.binding;
      f.phase.generation = 1; f.phase.status = 'awaiting_approval';
      f.phase.generationPublications = [{ generation: 1, record: { path: 'publication.json' } }];
      f.phase.generationCommit = f.git('rev-parse', 'HEAD');
      assert.deepEqual(await artifactQualityBinding(f.root, f.config, f.workflow, f.phase), before);
      f.workflow.phases['approved-input'].approvedBy = 'different human';
      assert.notEqual((await artifactQualityBinding(f.root, f.config, f.workflow, f.phase)).upstreamSha256, before.upstreamSha256);
      const invalid = structuredClone(packet); invalid.findings[0].code = 'artifact.metadata.invalid';
      const { packetSha256: _ignored, ...core } = invalid;
      invalid.packetSha256 = `sha256:${recordSha256(core)}`;
      assert.throws(() => validateQualityRiskPacket(invalid), { code: 'PHASE_QUALITY_RISK_INTEGRITY' });
      await writeFile(path.join(f.root, f.file), '# Reviewed draft\n\nNew authored content.\n');
      assert.notEqual((await artifactQualityBinding(f.root, f.config, f.workflow, f.phase)).contentSha256, before.contentSha256);
    });
  }
});

test('absence, unsafe records, missing required sections and deterministic artifacts are repair-only', async t => {
  const f = await fixture(t);
  await rm(path.join(f.root, f.file));
  const findings = await inspectPhaseAuthoredReviewContent(f.root, f.config, f.workflow, f.phase);
  assert.ok(findings.some(finding => finding.code === 'artifact.required.missing'));
  await assert.rejects(prepareArtifactQualityRisk(f.root, f.config, f.workflow, f.phase), { code: 'PHASE_QUALITY_RISK_NOT_ELIGIBLE' });
  await writeFile(path.join(f.root, f.file), '# Projection\n\nTODO revise.\n');
  f.phase.generationPolicy.defaultProducer = 'deterministic';
  await assert.rejects(prepareArtifactQualityRisk(f.root, f.config, f.workflow, f.phase), { code: 'PHASE_QUALITY_RISK_NOT_ELIGIBLE' });
});

test('checkpoint operations are registered and model-free; preview never gains mutation authority', () => {
  for (const [action, classification] of [['checkpoint', 'mutation'], ['checkpoint-show', 'read']]) {
    const operation = resolveOperation({ requestedCommand: 'appeal', positionals: ['appeal', action] });
    assert.equal(operation.classification, classification); assert.equal(operation.modelPolicy, 'never');
    assert.deepEqual(operationById(operation.id), operation);
  }
});
