import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { completeEpicIntake, completeEpicPublication } from '../src/epic-lifecycle.mjs';
import { registerEpicTextSource } from '../src/epic-sources.mjs';
import { approveInitiative, evaluateInitiativePhase, publishInitiativePhase,
  readInitiativeRecords, registerInitiativeEvidence } from '../src/initiative-evidence.mjs';
import { loadPortfolio, resolveInitiativeProfile } from '../src/initiative-config.mjs';
import { createInitiative, loadInitiative, prepareInitiativePhase, saveInitiative } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

const ID = 'EPIC-BOUNDARY';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-epic-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Epic Boundary Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'boundary@example.invalid'], { cwd: root });
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/portfolio.yml');
  const raw = YAML.parse(await readFile(file, 'utf8'));
  for (const authority of Object.values(raw.approvalAuthorities)) {
    authority.members = [{ name: 'Epic Boundary Owner', email: 'boundary@example.invalid' }];
  }
  raw.git.publish = 'off';
  await writeFile(file, YAML.stringify(raw));
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'Initialize Epic boundary fixture'], { cwd: root });
  run('git', ['switch', '-q', '-c', ID], { cwd: root });
  return { root, portfolio: await loadPortfolio(root), file, raw };
}

test('Requirements refuses invalid citations without publication; valid pinned citations record the blocking receipt', async (t) => {
  const { root } = await fixture(t);
  await createInitiative(root, { id: ID, title: 'Trace every requirement', profile: 'epic-planning' });
  const source = await registerEpicTextSource(root, { initiativeId: ID, text: '# Scope\nSupport the agreed outcome.' });
  await completeEpicIntake(root, ID);
  await prepareInitiativePhase(root, ID, 'epic-requirements');
  const loaded = await loadInitiative(root, ID);
  const item = path.join(root, 'singularity/initiatives', ID);
  const trace = (sourceId) => YAML.stringify({ version: 1,
    requirements: [{ id: 'REQ-001', statement: 'Support the agreed outcome.', sources: [{ sourceId, section: 'Scope' }] }],
    acceptanceCriteria: [{ id: 'AC-001', statement: 'The outcome is available.', requirements: ['REQ-001'], sources: [{ sourceId, section: 'Scope' }] }] });
  for (const output of Object.values(loaded.initiative.phases['epic-requirements'].outputs)) {
    await writeFile(path.join(item, output.path), output.id === 'requirements-traceability'
      ? trace('SRC-000000000000') : output.id === 'impact-analysis'
        ? YAML.stringify({ version: 1, repositories: {} }) : '# Requirements\n\nSupport the agreed outcome.\n');
  }
  const stateFile = path.join(item, 'state.json');
  const before = await readFile(stateFile, 'utf8');
  const status = run('git', ['status', '--porcelain'], { cwd: root }).stdout;
  await assert.rejects(publishInitiativePhase(root, ID, 'epic-requirements'), /cites unknown source SRC-000000000000/);
  assert.equal(await readFile(stateFile, 'utf8'), before);
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout, status);
  assert.deepEqual(await readInitiativeRecords(root, loaded.portfolio, ID, 'evidence'), []);

  const traceOutput = loaded.initiative.phases['epic-requirements'].outputs['requirements-traceability'];
  await writeFile(path.join(item, traceOutput.path), trace(source.record.sourceId));
  const published = await publishInitiativePhase(root, ID, 'epic-requirements');
  assert.equal(published.phase.status, 'awaiting_approval');
  assert.ok(published.evidence.includes('requirements-traceable'));
  const evidence = await readInitiativeRecords(root, published.portfolio, ID, 'evidence');
  const receipt = evidence.find((entry) => entry.record.check === 'requirements-traceable');
  assert.ok(receipt);
  assert.equal(receipt.record.assurance, 'machine-verified');
  assert.equal(receipt.record.verificationMethod, 'singularity-epic-traceability');
  await registerInitiativeEvidence(root, { initiativeId: ID, phaseId: 'epic-requirements',
    checkId: 'material-questions-resolved', assurance: 'human-approved', source: { path: path.relative(root, path.join(item, traceOutput.path)) } });
  const gate = await evaluateInitiativePhase(root, published.portfolio, (await loadInitiative(root, ID)).initiative, 'epic-requirements');
  assert.equal(gate.ready, true, gate.errors.join('\n'));
  const approved = await approveInitiative(root, { initiativeId: ID, phaseId: 'epic-requirements', subject: 'phase' });
  assert.equal(approved.next, 'epic-planning');
});

test('every renamed Epic stage is refused before an Initiative record is created', async (t) => {
  const { root, portfolio, file, raw } = await fixture(t);
  for (const id of ['epic-intake', 'epic-requirements', 'epic-planning', 'epic-publish']) {
    const copy = structuredClone(portfolio);
    copy.initiativePhases['renamed-step'] = structuredClone(copy.initiativePhases[id]);
    copy.initiativePhases['renamed-step'].id = 'renamed-step';
    copy.initiativeProfiles.copy = { phases: ['epic-intake', 'epic-requirements', 'epic-planning', 'epic-publish'].map((phase) => phase === id ? 'renamed-step' : phase) };
    assert.throws(() => resolveInitiativeProfile(copy, 'copy'), (error) => error.code === 'INITIATIVE_EPIC_PRODUCER_ID_UNSUPPORTED');
  }
  const renamed = structuredClone(raw);
  renamed.initiativePhases['custom-requirements'] = structuredClone(renamed.initiativePhases['epic-requirements']);
  renamed.initiativeProfiles = { copy: { phases: ['epic-intake', 'custom-requirements', 'epic-planning', 'epic-publish'] } };
  for (const phase of Object.values(renamed.initiativePhases)) for (const output of phase.outputs ?? []) {
    output.consumes = (output.consumes ?? []).map((ref) => ref.replace(/^epic-requirements\//u, 'custom-requirements/'));
  }
  await writeFile(file, YAML.stringify(renamed));
  const before = run('git', ['status', '--porcelain'], { cwd: root }).stdout;
  await assert.rejects(createInitiative(root, { id: ID, profile: 'copy' }), (error) => error.code === 'INITIATIVE_EPIC_PRODUCER_ID_UNSUPPORTED');
  await assert.rejects(readFile(path.join(root, 'singularity/initiatives', ID, 'state.json')), { code: 'ENOENT' });
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout, before);
});

test('missing, reordered, duplicate and overridden Epic contracts fail topology validation', async (t) => {
  const { portfolio } = await fixture(t);
  const ids = ['epic-intake', 'epic-requirements', 'epic-planning', 'epic-publish'];
  for (const phases of [ids.slice(1), ids.slice(0, -1), [ids[0], ids[2], ids[1], ids[3]], [...ids, ids[3]]]) {
    const copy = structuredClone(portfolio);
    copy.initiativeProfiles.copy = { phases };
    assert.throws(() => resolveInitiativeProfile(copy, 'copy'), (error) => error.code === 'INITIATIVE_EPIC_TOPOLOGY_UNSUPPORTED');
  }
  const copy = structuredClone(portfolio);
  copy.initiativeProfiles.copy = { phases: ids, phaseOverrides: { 'epic-requirements': {
    outputs: { 'requirements-traceability': { id: 'different-trace' } }
  } } };
  assert.throws(() => resolveInitiativeProfile(copy, 'copy'), (error) => error.code === 'INITIATIVE_EPIC_TOPOLOGY_UNSUPPORTED');
});

test('older incomplete Epic pins receive a typed recovery error instead of a status TypeError', async (t) => {
  const { root } = await fixture(t);
  const { portfolio, initiative } = await createInitiative(root, { id: ID, profile: 'epic-planning' });
  initiative.resolution.phases = initiative.resolution.phases.filter((phase) => phase.id !== 'epic-publish');
  initiative.phaseOrder = initiative.phaseOrder.filter((id) => id !== 'epic-publish');
  delete initiative.phases['epic-publish'];
  await saveInitiative(root, portfolio, initiative);
  const file = path.join(root, 'singularity/initiatives', ID, 'state.json');
  const before = await readFile(file, 'utf8');
  for (const complete of [completeEpicIntake, completeEpicPublication]) {
    await assert.rejects(complete(root, ID), (error) => error.code === 'INITIATIVE_EPIC_TOPOLOGY_UNSUPPORTED' && !(error instanceof TypeError));
    assert.equal(await readFile(file, 'utf8'), before);
  }
});
