import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import {
  commitInitiativeChange, createInitiative, initiativePendingPublicationPath, loadInitiative, saveInitiative
} from '../src/initiative-state.mjs';
import { changes } from '../src/git.mjs';
import { run, writeJson } from '../src/util.mjs';

function configureIdentity(root, name, email) {
  run('git', ['config', 'user.name', name], { cwd: root });
  run('git', ['config', 'user.email', email], { cwd: root });
}

test('concurrent append-only Initiative commits fail closed with an exact recovery receipt', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-initiative-concurrency-'));
  const seed = path.join(base, 'seed');
  const remote = path.join(base, 'origin.git');
  run('git', ['init', '-b', 'main', seed], { cwd: base });
  configureIdentity(seed, 'Seed Owner', 'seed@example.com');
  await writeFile(path.join(seed, 'README.md'), '# Concurrent initiative\n');
  await initializeDefinition(seed);
  const portfolioFile = path.join(seed, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [
      { name: 'First Owner', email: 'first@example.com' },
      { name: 'Second Owner', email: 'second@example.com' }
    ];
  }
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: seed });
  run('git', ['commit', '-m', 'Initialize'], { cwd: seed });
  run('git', ['init', '--bare', remote], { cwd: base });
  run('git', ['remote', 'add', 'origin', remote], { cwd: seed });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: seed });
  run('git', ['switch', '-c', 'INIT-CONCURRENT'], { cwd: seed });
  await createInitiative(seed, {
    id: 'INIT-CONCURRENT',
    title: 'Concurrent appends',
    profile: 'initiative-lite',
    agent: 'product-owner'
  });
  let loaded = await loadInitiative(seed, 'INIT-CONCURRENT');
  await commitInitiativeChange(
    seed,
    loaded.portfolio,
    loaded.initiative,
    { type: 'binding' },
    '[INIT-CONCURRENT][initiative:init] start'
  );

  const first = path.join(base, 'first');
  const second = path.join(base, 'second');
  run('git', ['clone', '--branch', 'INIT-CONCURRENT', remote, first], { cwd: base });
  run('git', ['clone', '--branch', 'INIT-CONCURRENT', remote, second], { cwd: base });
  configureIdentity(first, 'First Owner', 'first@example.com');
  configureIdentity(second, 'Second Owner', 'second@example.com');

  const append = async (root, suffix) => {
    const current = await loadInitiative(root, 'INIT-CONCURRENT');
    const at = `2026-07-28T00:00:0${suffix}.000Z`;
    current.initiative.history.push({
      at,
      actor: suffix === '1' ? 'first@example.com' : 'second@example.com',
      event: 'initiative_evidence_registered',
      phase: 'define',
      detail: `concurrent-${suffix}`
    });
    const record = path.join(
      root,
      'singularity/initiatives/INIT-CONCURRENT/evidence/records',
      `${suffix.repeat(64)}.json`
    );
    await writeJson(record, { schemaVersion: 1, at, value: suffix });
    await saveInitiative(root, current.portfolio, current.initiative);
    return commitInitiativeChange(
      root,
      current.portfolio,
      current.initiative,
      { type: 'evidence-recorded', phaseId: 'define', payload: { suffix } },
      `[INIT-CONCURRENT][evidence] concurrent-${suffix}`,
      { appendOnly: true }
    );
  };

  const firstPublication = await append(first, '1');
  assert.equal(firstPublication.pushed, true);
  const secondExpectedRemoteSha = run('git', ['rev-parse', 'HEAD'], { cwd: second }).stdout.trim();
  await assert.rejects(() => append(second, '2'), /retained locally but push failed/);
  assert.equal(changes(second).trim(), '');
  assert.equal(run('git', ['status', '--porcelain=v2', '--branch'], { cwd: second }).status, 0);
  const secondPendingPath = initiativePendingPublicationPath(second, (await loadInitiative(
    second, 'INIT-CONCURRENT'
  )).portfolio, 'INIT-CONCURRENT');
  const secondPending = JSON.parse(await readFile(secondPendingPath, 'utf8'));
  assert.equal(secondPending.expectedRemoteSha, secondExpectedRemoteSha);
  assert.equal(secondPending.commit, run('git', ['rev-parse', 'HEAD'], { cwd: second }).stdout.trim());
  assert.equal(secondPending.pushOutcome, 'rejected');
});
