import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import {
  commitInitiativeChange, createInitiative, initiativePendingPublicationPath, loadInitiative, saveInitiative
} from '../src/initiative-state.mjs';
import { registerEpicTextSource } from '../src/epic-sources.mjs';
import { changes } from '../src/git.mjs';
import { run, writeJson } from '../src/util.mjs';

function configureIdentity(root, name, email) {
  run('git', ['config', 'user.name', name], { cwd: root });
  run('git', ['config', 'user.email', email], { cwd: root });
}

test('concurrent append-only initiative commits replay without leaving a conflicted checkout', async () => {
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
      `[INIT-CONCURRENT][evidence] concurrent-${suffix}`,
      { appendOnly: true }
    );
  };

  const firstPublication = await append(first, '1');
  assert.equal(firstPublication.pushed, true);
  const secondPublication = await append(second, '2');
  assert.equal(secondPublication.pushed, true);
  assert.equal(secondPublication.replayed, true);
  assert.equal(changes(second).trim(), '');
  assert.equal(run('git', ['status', '--porcelain=v2', '--branch'], { cwd: second }).status, 0);

  const verification = path.join(base, 'verification');
  run('git', ['clone', '--branch', 'INIT-CONCURRENT', remote, verification], { cwd: base });
  const finalState = JSON.parse(await readFile(
    path.join(verification, 'singularity/initiatives/INIT-CONCURRENT/state.json'),
    'utf8'
  ));
  assert.ok(finalState.history.some((event) => event.detail === 'concurrent-1'));
  assert.ok(finalState.history.some((event) => event.detail === 'concurrent-2'));
  for (const suffix of ['1', '2']) {
    assert.equal(
      JSON.parse(await readFile(path.join(
        verification,
        'singularity/initiatives/INIT-CONCURRENT/evidence/records',
        `${suffix.repeat(64)}.json`
      ), 'utf8')).value,
      suffix
    );
  }

  run('git', ['pull', '--ff-only'], { cwd: first });
  const third = path.join(base, 'third');
  run('git', ['clone', '--branch', 'INIT-CONCURRENT', remote, third], { cwd: base });
  configureIdentity(third, 'Third Owner', 'third@example.com');
  const firstSource = await registerEpicTextSource(first, {
    initiativeId: 'INIT-CONCURRENT',
    text: 'First concurrent source',
    label: 'First source'
  });
  const thirdSource = await registerEpicTextSource(third, {
    initiativeId: 'INIT-CONCURRENT',
    text: 'Second concurrent source',
    label: 'Second source'
  });
  const firstSourcePublication = await commitInitiativeChange(
    first,
    firstSource.portfolio,
    firstSource.initiative,
    '[INIT-CONCURRENT][source] first',
    { appendOnly: true }
  );
  assert.equal(firstSourcePublication.pushed, true);
  const thirdSourcePublication = await commitInitiativeChange(
    third,
    thirdSource.portfolio,
    thirdSource.initiative,
    '[INIT-CONCURRENT][source] second',
    { appendOnly: true }
  );
  assert.equal(thirdSourcePublication.pushed, true);
  assert.equal(thirdSourcePublication.replayed, true);
  assert.equal(changes(third).trim(), '');

  run('git', ['pull', '--ff-only'], { cwd: verification });
  const sourceManifest = YAML.parse(await readFile(
    path.join(verification, 'singularity/initiatives/INIT-CONCURRENT/sources/manifest.yml'),
    'utf8'
  ));
  assert.equal(sourceManifest.sources.length, 2);
  const sourceState = JSON.parse(await readFile(
    path.join(verification, 'singularity/initiatives/INIT-CONCURRENT/state.json'),
    'utf8'
  ));
  assert.equal(sourceState.sources.records, 2);
  assert.ok(sourceState.history.some((event) => event.detail?.includes(firstSource.record.sourceId)));
  assert.ok(sourceState.history.some((event) => event.detail?.includes(thirdSource.record.sourceId)));

  run('git', ['pull', '--ff-only'], { cwd: first });
  const fourth = path.join(base, 'fourth');
  run('git', ['clone', '--branch', 'INIT-CONCURRENT', remote, fourth], { cwd: base });
  configureIdentity(fourth, 'Fourth Owner', 'fourth@example.com');
  loaded = await loadInitiative(first, 'INIT-CONCURRENT');
  loaded.initiative.initiative.title = 'Concurrent lifecycle update';
  await saveInitiative(first, loaded.portfolio, loaded.initiative);
  const lifecyclePublication = await commitInitiativeChange(
    first,
    loaded.portfolio,
    loaded.initiative,
    '[INIT-CONCURRENT][lifecycle] update title'
  );
  assert.equal(lifecyclePublication.pushed, true);

  const unsafe = await loadInitiative(fourth, 'INIT-CONCURRENT');
  unsafe.initiative.initiative.title = 'Conflicting local lifecycle update';
  unsafe.initiative.history.push({
    at: '2026-07-28T00:00:03.000Z',
    actor: 'fourth@example.com',
    event: 'initiative_evidence_registered',
    phase: 'define',
    detail: 'concurrent-3'
  });
  await writeJson(path.join(
    fourth,
    'singularity/initiatives/INIT-CONCURRENT/evidence/records',
    `${'3'.repeat(64)}.json`
  ), { schemaVersion: 1, at: '2026-07-28T00:00:03.000Z', value: '3' });
  await saveInitiative(fourth, unsafe.portfolio, unsafe.initiative);
  await assert.rejects(() => commitInitiativeChange(
    fourth,
    unsafe.portfolio,
    unsafe.initiative,
    '[INIT-CONCURRENT][evidence] unsafe concurrent-3',
    { appendOnly: true }
  ), /lifecycle-state change.*automatic replay was refused/i);
  const rebaseDirectory = run('git', ['rev-parse', '--git-path', 'rebase-merge'], {
    cwd: fourth
  }).stdout.trim();
  assert.equal(existsSync(path.resolve(fourth, rebaseDirectory)), false);
  const dirty = changes(fourth).trim().split(/\r?\n/).filter(Boolean);
  assert.equal(dirty.length, 0);
  assert.equal(existsSync(initiativePendingPublicationPath(fourth, unsafe.portfolio, 'INIT-CONCURRENT')), true);
});
