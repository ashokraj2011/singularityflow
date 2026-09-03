import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveGroundingPlan } from '../src/world-model-selection.mjs';
import { inspectConfiguredGrounding } from '../src/worldmodel.mjs';
import { isWorldModelAvailabilityError } from '../src/world-model-availability.mjs';
import { inspectGroundingAvailability } from '../src/world-model-materialization.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function legacyConfig(overrides = {}) {
  const materialization = {
    mode: 'explicit', publish: 'governed', lookahead: 'none', depth: 'phase',
    confirmation: 'prompt'
  };
  return {
    outputDir: 'singularity/world-model',
    stateBranch: 'state',
    remote: 'origin',
    grounding: 'enforce',
    staleness: 'fail',
    materialization,
    context: {},
    definition: {
      ledger: { branch: 'state' },
      worldModel: {
        outputDir: 'singularity/world-model', staleness: 'fail', materialization
      }
    },
    ...overrides
  };
}

test('World-Model availability classification never overrides a typed integrity error', () => {
  assert.equal(isWorldModelAvailabilityError(Object.assign(new Error('missing'), {
    code: 'ENOENT'
  })), true);
  assert.equal(isWorldModelAvailabilityError(Object.assign(new Error('wrapped transport'), {
    cause: Object.assign(new Error('missing'), { code: 'ENOENT' })
  })), true);
  assert.equal(isWorldModelAvailabilityError(Object.assign(new Error('invalid pinned core'), {
    code: 'WMB_PINNED_CORE_INVALID',
    cause: Object.assign(new Error('missing'), { code: 'ENOENT' })
  })), false);
  assert.equal(isWorldModelAvailabilityError(Object.assign(new Error('ambiguous authority'), {
    code: 'WMB_STATE_AUTHORITY_REFRESH_FAILED',
    details: { classification: 'ambiguous-remote' }
  })), false);
  assert.equal(isWorldModelAvailabilityError(Object.assign(new Error('office authentication'), {
    code: 'WMB_STATE_AUTHORITY_REFRESH_FAILED',
    details: { classification: 'authentication-required' }
  })), true);
  for (const classification of [
    'credential-helper-unavailable', 'git-unavailable', 'sso-authorization-required',
    'working-directory-unavailable'
  ]) {
    assert.equal(isWorldModelAvailabilityError(Object.assign(new Error(classification), {
      code: 'WMB_STATE_AUTHORITY_REFRESH_FAILED', details: { classification }
    })), true, `${classification} is optional remote-context unavailability, not integrity failure`);
  }
  assert.equal(isWorldModelAvailabilityError(Object.assign(new Error('tracking ref race'), {
    code: 'WMB_STATE_AUTHORITY_REFRESH_FAILED',
    details: { classification: 'tracking-ref-raced' }
  })), false);
});

test('legacy lifecycle readiness treats state-tree extraction failure as unavailable and preserves other failures', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-readiness-extraction-'));
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), 'sflow-readiness-bin-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(fakeBin, { recursive: true, force: true })
  ]));

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Readiness Tester');
  git(root, 'config', 'user.email', 'readiness@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# source\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'source');

  git(root, 'switch', '-q', '-c', 'state');
  await mkdir(path.join(root, 'singularity', 'world-model'), { recursive: true });
  await writeFile(
    path.join(root, 'singularity', 'world-model', 'manifest.json'),
    `${JSON.stringify({ unique: path.basename(root) })}\n`
  );
  git(root, 'add', 'singularity/world-model/manifest.json');
  git(root, 'commit', '-qm', 'publish state projection');
  const treeSha = git(root, 'rev-parse', 'state:singularity/world-model');
  git(root, 'switch', '-q', 'main');
  await rm(path.join(os.tmpdir(), `singularity-flow-world-model-${treeSha}`), {
    recursive: true, force: true
  });

  const fakeTar = path.join(fakeBin, 'tar');
  await writeFile(fakeTar, '#!/bin/sh\nexit 97\n');
  await chmod(fakeTar, 0o755);
  const originalPath = process.env.PATH;
  let readiness;
  try {
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`;
    readiness = await inspectConfiguredGrounding(root, legacyConfig(), 'intake', {
      plan: resolveGroundingPlan({ phase: 'intake' }), refreshRemote: false
    });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }

  assert.equal(readiness.format, 'legacy-v3');
  assert.equal(readiness.availability.ready, false);
  assert.equal(readiness.availability.status, 'unavailable');
  assert.equal(readiness.availability.error.code, 'WORLD_MODEL_STATE_EXTRACTION_FAILED');
  assert.match(readiness.command, /^singularity-flow wm ensure --phase intake$/);
  assert.match(readiness.reason, /Could not materialize governed world model/);

  await assert.rejects(
    () => inspectConfiguredGrounding(root, legacyConfig({
      definition: {
        ledger: { branch: 'state' },
        worldModel: {
          outputDir: 'singularity/world-model',
          sourceRoots: ['/outside-repository'],
          materialization: legacyConfig().materialization
        }
      }
    }), 'intake', {
      plan: resolveGroundingPlan({ phase: 'intake' }), refreshRemote: false
    }),
    (error) => error?.code === undefined && /repository-relative directory/.test(error.message)
  );
});

test('a disappearing local model file is unavailable while malformed present bytes remain integrity failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-readiness-local-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Readiness Tester');
  git(root, 'config', 'user.email', 'readiness@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# source\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'source');

  const model = path.join(root, 'singularity/world-model');
  await mkdir(path.join(model, 'core'), { recursive: true });
  await mkdir(path.join(model, 'evidence'), { recursive: true });
  await writeFile(path.join(model, 'core/summary.md'), '# summary\n');
  await writeFile(path.join(model, 'core/model.json'), '{}\n');
  await writeFile(path.join(model, 'evidence/evidence.jsonl'), '{"id":"E-1"}\n');
  await writeFile(path.join(model, 'manifest.json'), `${JSON.stringify({
    schema_version: '1.0',
    repository_commit: git(root, 'rev-parse', 'HEAD'),
    core: { summary: 'core/summary.md', model: 'core/model.json' },
    views: {}, domains: [], task_guides: [],
    evidence: { path: 'evidence/evidence.jsonl' }
  })}\n`);
  const config = legacyConfig({
    materialization: { ...legacyConfig().materialization, publish: 'local' },
    definition: { worldModel: { outputDir: 'singularity/world-model' } }
  });
  const plan = resolveGroundingPlan({ phase: 'intake' });

  const manifest = await readFile(path.join(model, 'manifest.json'));
  await rm(path.join(model, 'manifest.json'));
  const partial = await inspectGroundingAvailability(root, config, plan, {
    refreshRemote: false
  });
  assert.equal(partial.ready, false);
  assert.equal(partial.failureClass, 'integrity');
  await writeFile(path.join(model, 'manifest.json'), manifest);

  await rm(path.join(model, 'core/summary.md'));
  const unavailable = await inspectGroundingAvailability(root, config, plan, {
    refreshRemote: false
  });
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.failureClass, 'availability');

  await writeFile(path.join(model, 'core/summary.md'), '# summary\n');
  await writeFile(path.join(model, 'core/model.json'), '{not-json}\n');
  const invalid = await inspectGroundingAvailability(root, config, plan, {
    refreshRemote: false
  });
  assert.equal(invalid.ready, false);
  assert.equal(invalid.failureClass, 'integrity');

  await writeFile(path.join(model, 'core/model.json'), '{}\n');
  await rm(path.join(model, 'manifest.json'));
  await mkdir(path.join(model, 'manifest.json'));
  const wrongManifestType = await inspectGroundingAvailability(root, config, plan, {
    refreshRemote: false
  });
  assert.equal(wrongManifestType.ready, false);
  assert.equal(wrongManifestType.failureClass, 'integrity');
});

test('malformed governed state cannot fall through to a legacy worktree model', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-readiness-authority-'));
  const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-readiness-authority-remote-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(remote, { recursive: true, force: true })
  ]));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Readiness Tester');
  git(root, 'config', 'user.email', 'readiness@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# source\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'source');
  const sourceCommit = git(root, 'rev-parse', 'HEAD');
  git(remote, 'init', '--bare', '-q', '-b', 'main');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');

  const writeLegacyModel = async () => {
    const model = path.join(root, 'singularity/world-model');
    await mkdir(path.join(model, 'core'), { recursive: true });
    await mkdir(path.join(model, 'evidence'), { recursive: true });
    await writeFile(path.join(model, 'core/summary.md'), '# exact worktree summary\n');
    await writeFile(path.join(model, 'core/model.json'), '{}\n');
    await writeFile(path.join(model, 'evidence/evidence.jsonl'), '{"id":"E-1"}\n');
    await writeFile(path.join(model, 'manifest.json'), `${JSON.stringify({
      schema_version: '1.0', repository_commit: sourceCommit,
      core: { summary: 'core/summary.md', model: 'core/model.json' },
      views: {}, domains: [], task_guides: [],
      evidence: { path: 'evidence/evidence.jsonl' }
    })}\n`);
  };
  await writeLegacyModel();
  git(root, 'switch', '-qc', 'state');
  git(root, 'add', 'singularity/world-model');
  git(root, 'commit', '-qm', 'world-model projection');
  await rm(path.join(root, 'singularity/world-model/manifest.json'));
  git(root, 'add', '-u', 'singularity/world-model/manifest.json');
  git(root, 'commit', '-qm', 'simulate interrupted state projection');
  git(root, 'push', '-q', '-u', 'origin', 'state');
  git(root, 'switch', '-q', 'main');
  await writeLegacyModel();

  const plan = resolveGroundingPlan({ phase: 'intake' });
  const governed = await inspectGroundingAvailability(root, legacyConfig(), plan, {
    refreshRemote: false
  });
  assert.equal(governed.ready, false);
  assert.equal(governed.failureClass, 'integrity');
  assert.equal(governed.selected, null);
  assert.equal(
    governed.candidates.find((candidate) => candidate.source === 'state-branch')?.failureClass,
    'integrity'
  );

  const local = await inspectGroundingAvailability(root, legacyConfig({
    materialization: { ...legacyConfig().materialization, publish: 'local' }
  }), plan, { refreshRemote: false });
  assert.equal(local.ready, true);
  assert.equal(local.failureClass, null);
  assert.equal(local.selected.source, 'worktree');
});
