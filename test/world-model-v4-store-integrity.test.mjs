import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdir, mkdtemp, readFile, rm, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from '../src/util.mjs';
import { canonicalJson, sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import { buildAndPublishWorldModelV4 } from '../src/world-model/service.mjs';
import {
  resolvePublishedWorldModelV4, validateWorldModelContextManifest,
  validateWorldModelUsageObservation
} from '../src/world-model/store.mjs';

const LEDGER = Object.freeze({
  enabled: true,
  branch: 'state',
  remote: 'origin',
  behind: 'block',
  enforcement: 'shadow',
  signing: 'off',
  trustTier: 'T0',
  maxRetries: 3
});

function git(root, ...args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

async function repository(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-v4-store-integrity-'));
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'repo');
  t.after(() => rm(parent, { recursive: true, force: true }));
  run('git', ['init', '--bare', remote]);
  await mkdir(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'WMB Store Integrity Tests');
  git(root, 'config', 'user.email', 'wmb-store@example.invalid');
  await writeFile(path.join(root, 'src', 'service.mjs'), [
    "import { rate } from './tax.mjs';",
    'export function total(value) { return value + rate(value); }',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'tax.mjs'), 'export const rate = (value) => value * 0.1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'application source');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main');
  await buildAndPublishWorldModelV4(root, {
    outputDir: 'singularity/world-model',
    ledgerConfig: LEDGER,
    views: ['dev.impact'],
    composer: 'deterministic',
    capabilityId: 'store-integrity-fixture',
    allowedPaths: ['src/**'],
    excludedPaths: ['singularity/**', '.sflow/**', '.singularity-flow/**'],
    policySnapshotSha256: sha256({ fixture: 'wmb-v4-store-integrity-policy' }),
    generatedAt: '2026-09-01T00:00:00.000Z'
  });
  return { parent, root };
}

async function rewriteState(root, parent, mutate) {
  const worktree = path.join(parent, `tampered-state-${randomUUID()}`);
  git(root, 'worktree', 'add', '-q', worktree, 'state');
  await mutate(worktree);
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-m', 'tamper published WMB fixture');
  git(worktree, 'push', 'origin', 'HEAD:state');
  git(root, 'fetch', 'origin', 'state');
}

function resolve(root) {
  return resolvePublishedWorldModelV4(root, {
    outputDir: 'singularity/world-model', stateBranch: 'state', remote: 'origin'
  });
}

test('published store requires every available view provenance record', async (t) => {
  for (const relative of [
    'requests/build-request.json',
    'plans/build-plan.json',
    'profiles/consumer.json',
    'profiles/output-budget.json',
    'catalogs/views/dev.impact.facts.json',
    'contexts/dev.impact.json',
    'candidates/dev.impact.json',
    'usage/dev.impact.json'
  ]) {
    await t.test(relative, async (child) => {
      const { parent, root } = await repository(child);
      await rewriteState(root, parent, async (worktree) => {
        await rm(path.join(worktree, 'singularity', 'world-model', relative));
      });
      assert.throws(
        () => resolve(root),
        (error) => error.code === 'WMB_PUBLICATION_PARTIAL'
          && error.details?.path?.endsWith(relative)
      );
    });
  }
});

test('fresh-export verification rejects every file outside the exact projection allowlist', async (t) => {
  const { parent, root } = await repository(t);
  await rewriteState(root, parent, async (worktree) => {
    const target = path.join(
      worktree, 'singularity', 'world-model', 'views', 'ambient-unregistered.md'
    );
    await writeFile(target, '# Ambient view that is not in the manifest\n');
  });
  assert.throws(
    () => resolve(root),
    (error) => error.code === 'WMB_PUBLICATION_UNEXPECTED_PATH'
      && error.details?.unexpected?.includes('views/ambient-unregistered.md')
  );
});

test('an authoritative state branch without a World Model is an empty first-build base', async (t) => {
  const { parent, root } = await repository(t);
  await rewriteState(root, parent, async (worktree) => {
    await rm(path.join(worktree, 'singularity', 'world-model'), { recursive: true });
  });

  assert.equal(resolvePublishedWorldModelV4(root, {
    outputDir: 'singularity/world-model', stateBranch: 'state', remote: 'origin', required: false
  }), null);
  assert.throws(
    () => resolve(root),
    (error) => error.code === 'WMB_MANIFEST_MISSING'
      && error.details?.remoteModelAtTip === false
  );
});

test('a local-only state authority removal never falls through to an old model on HEAD', async (t) => {
  const { parent, root } = await repository(t);
  // Deliberately retain an old projection on the application branch to prove it cannot revive a
  // model removed at the authoritative local state tip.
  git(root, 'checkout', 'state', '--', 'singularity/world-model');
  git(root, 'add', 'singularity/world-model');
  git(root, 'commit', '-m', 'retain stale application projection for fallback regression');

  const worktree = path.join(parent, `local-state-removal-${randomUUID()}`);
  git(root, 'worktree', 'add', '-q', worktree, 'state');
  await rm(path.join(worktree, 'singularity', 'world-model'), { recursive: true });
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-m', 'intentionally remove local state model');
  git(root, 'remote', 'remove', 'origin');

  assert.equal(resolvePublishedWorldModelV4(root, {
    outputDir: 'singularity/world-model', stateBranch: 'state', remote: 'origin', required: false
  }), null);
  assert.throws(
    () => resolvePublishedWorldModelV4(root, {
      outputDir: 'singularity/world-model', stateBranch: 'state', remote: 'origin'
    }),
    (error) => error.code === 'WMB_MANIFEST_MISSING'
      && error.details?.localBranchPresent === true
      && error.details?.localModelAtTip === false
  );
});

test('published store rejects usage tampering before accepting economic observations', async (t) => {
  const { parent, root } = await repository(t);
  await rewriteState(root, parent, async (worktree) => {
    const target = path.join(
      worktree, 'singularity', 'world-model', 'usage', 'dev.impact.json'
    );
    const observation = JSON.parse(await readFile(target, 'utf8'));
    observation.promptBytes += 4;
    observation.estimatedInputTokens += 1;
    await writeFile(target, canonicalJson(observation));
  });
  assert.throws(
    () => resolve(root),
    (error) => error.code === 'WMB_RECORD_HASH_MISMATCH'
  );
});

test('published store cross-binds a sealed usage observation to its exact view execution', async (t) => {
  const { parent, root } = await repository(t);
  await rewriteState(root, parent, async (worktree) => {
    const target = path.join(
      worktree, 'singularity', 'world-model', 'usage', 'dev.impact.json'
    );
    const observation = JSON.parse(await readFile(target, 'utf8'));
    observation.viewId = 'arch.contracts';
    await writeFile(target, canonicalJson(sealRecord(observation, 'observationSha256')));
  });
  assert.throws(
    () => resolve(root),
    (error) => error.code === 'WMB_VIEW_EXECUTION_MISMATCH'
  );
});

test('published store validates usage byte, token, cost, and assurance semantics', () => {
  const base = {
    schemaVersion: 1,
    kind: 'world-model-usage-observation',
    viewId: 'dev.impact',
    promptBytes: 16,
    estimatedInputTokens: 4,
    providerInputTokens: 12,
    providerCachedTokens: 4,
    outputBytes: 8,
    estimatedOutputTokens: 2,
    providerOutputTokens: 3,
    cost: { currency: 'USD', amount: 0.001, assurance: 'provider-reported' },
    assurance: {
      promptBytes: 'exact', estimatedTokens: 'estimated', providerTokens: 'provider-reported'
    }
  };
  const valid = sealRecord(base, 'observationSha256');
  assert.equal(validateWorldModelUsageObservation(valid).observationSha256, valid.observationSha256);

  const impossible = structuredClone(base);
  impossible.providerCachedTokens = 13;
  assert.throws(
    () => validateWorldModelUsageObservation(sealRecord(impossible, 'observationSha256')),
    (error) => error.code === 'WMB_USAGE_OBSERVATION_INVALID'
  );
});

test('published store validates context identity and region accounting', () => {
  const base = {
    schemaVersion: 1,
    kind: 'world-model-context-manifest',
    viewId: 'dev.impact',
    regions: [{
      id: 'stable-core',
      sha256: sha256('registered core'),
      bytes: 15,
      estimatedTokens: 4,
      cacheClass: 'stable-prefix'
    }],
    promptSha256: sha256('exact composed prompt')
  };
  const valid = sealRecord(base, 'manifestSha256');
  assert.equal(validateWorldModelContextManifest(valid).manifestSha256, valid.manifestSha256);

  const impossible = structuredClone(base);
  impossible.regions[0].estimatedTokens = 5;
  assert.throws(
    () => validateWorldModelContextManifest(sealRecord(impossible, 'manifestSha256')),
    (error) => error.code === 'WMB_CONTEXT_MANIFEST_INVALID'
  );
});
