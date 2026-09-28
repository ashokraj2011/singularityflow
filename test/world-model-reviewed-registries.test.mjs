/**
 * An upgrade must not strand a World Model published by an earlier build. A model whose Extractor
 * Registry the reviewed chain connects to the installed one stays readable, and current when every
 * transition was mechanical. Anything this build cannot verify exactly is refused as unavailable,
 * never used, and replaced by a rebuild.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { gatewayRegistry } from '../src/gateway/operations.mjs';
import { worldModelNextResult } from '../src/gateway/planners/world-model.mjs';
import { run } from '../src/util.mjs';
import { isWorldModelAvailabilityError } from '../src/world-model-availability.mjs';
import {
  REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS, REVIEWED_TRANSITION_EFFECTS, earlierBuildModelIncompatible,
  reviewedExtractorRegistryPath, reviewedPathPreservesModel, reviewedValidationContract
} from '../src/world-model-reviewed-registries.mjs';
import { sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import { handleWorldModelV4Command } from '../src/world-model/commands.mjs';
import { loadWorldModelIdeSlice } from '../src/world-model/ide/slice.mjs';
import { resolveWorldModelV4ReusableIdentity } from '../src/world-model/plan.mjs';
import { CURRENT_WORLD_MODEL_VALIDATION_CONTRACT } from '../src/world-model/publish/manifest.mjs';
import { BUILTIN_EXTRACTOR_REGISTRY } from '../src/world-model/registry/extractors.mjs';
import { buildAndPublishWorldModelV4 } from '../src/world-model/service.mjs';
import { WMB_V4_KERNEL_SOURCE_SHA256 } from '../src/world-model/source-digest.mjs';
import { resolvePublishedWorldModelV4 } from '../src/world-model/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures', 'world-model-earlier-builds');
const REVIEW_RECORD = path.join(here, '..', 'docs', 'contracts', 'wmb', 'REGISTRY-LOCK-REVIEW-2026-09-19.md');
const EARLIER_REGISTRY = 'sha256:559285187f036990893a6b062df871b70339be4bed7ee94e8896b21c3e163542';
const OUTPUT_DIR = 'singularity/world-model';
const LEDGER = Object.freeze({
  enabled: true, branch: 'state', remote: 'origin', behind: 'block', enforcement: 'shadow',
  signing: 'off', trustTier: 'T0', maxRetries: 3
});
const SCOPE = Object.freeze({
  views: ['dev.impact'], allowedPaths: ['src/**'],
  excludedPaths: ['singularity/**', '.sflow/**', '.singularity-flow/**']
});
const EARLIER_MODELS = Object.freeze([
  { bundle: 'deterministic-55928518', capabilityId: 'probe', policy: 'probe-policy', route: 'deterministic' },
  { bundle: 'model-composed-55928518', capabilityId: 'fixture', policy: 'earlier-build-model-route', route: 'model' }
]);

function git(root, args) {
  return run('git', args, { cwd: root });
}

function buildOptions(model) {
  return {
    ...SCOPE, capabilityId: model.capabilityId,
    policySnapshotSha256: sha256({ fixture: model.policy })
  };
}

async function earlierBuildRepository(t, model) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-wm-earlier-build-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'repo');
  run('git', ['clone', '-q', '--bare', path.join(FIXTURES, `${model.bundle}.bundle`), remote]);
  run('git', ['clone', '-q', '--branch', 'main', remote, root]);
  git(root, ['config', 'user.name', 'Earlier Build']);
  git(root, ['config', 'user.email', 'earlier-build@example.invalid']);
  return { parent, remote, root };
}

function groundingRead(root, model) {
  const expected = resolveWorldModelV4ReusableIdentity(buildOptions(model));
  return resolvePublishedWorldModelV4(root, {
    outputDir: OUTPUT_DIR, expectedReusableIdentity: expected.identity
  });
}

/** Commit one replaced file onto the published state branch, as a writer to that branch could. */
async function replaceOnState(root, parent, relative, transform) {
  const worktree = path.join(parent, `state-edit-${Math.random().toString(16).slice(2)}`);
  git(root, ['worktree', 'add', '-q', '--detach', worktree, 'origin/state']);
  const file = path.join(worktree, ...relative.split('/'));
  await writeFile(file, transform(await readFile(file, 'utf8')));
  git(worktree, ['commit', '-qam', `edit ${relative}`]);
  git(worktree, ['push', '-q', 'origin', 'HEAD:refs/heads/state']);
  git(root, ['fetch', '-q', 'origin', '+refs/heads/state:refs/remotes/origin/state']);
}

function reviewRecordTransitions(text) {
  const sections = [];
  let section = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) section = line.slice(3).trim();
    const match = /^\| (Packaged WMB kernel|Built-in Extractor Registry) \| `(sha256:[a-f0-9]{64})` \| `(sha256:[a-f0-9]{64})` \|/.exec(line);
    if (!match) continue;
    let entry = sections.find((candidate) => candidate.review === section);
    if (!entry) sections.push(entry = { review: section });
    if (match[1] === 'Packaged WMB kernel') Object.assign(entry, { kernelFrom: match[2], kernelTo: match[3] });
    else Object.assign(entry, { from: match[2], to: match[3] });
  }
  return sections;
}

test('the reviewed registry chain is exactly the lock review record', async () => {
  const recorded = reviewRecordTransitions(await readFile(REVIEW_RECORD, 'utf8'));
  assert.deepEqual(
    REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS.map(({ effect, ...identities }) => identities),
    recorded
  );
  for (const transition of REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS) {
    assert.ok(Object.hasOwn(REVIEWED_TRANSITION_EFFECTS, transition.effect), transition.review);
  }
  REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS.slice(1).forEach((transition, index) => {
    const previous = REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS[index];
    assert.equal(transition.from, previous.to, `${transition.review} continues the chain`);
    assert.equal(transition.kernelFrom, previous.kernelTo, `${transition.review} continues the kernel chain`);
  });
});

test('the reviewed chain ends at the registry, kernel and validator this build installs', () => {
  const head = REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS.at(-1);
  assert.equal(head.to, BUILTIN_EXTRACTOR_REGISTRY.registrySha256,
    'a kernel change needs its reviewed transition appended to the chain');
  assert.equal(head.kernelTo, WMB_V4_KERNEL_SOURCE_SHA256);
  assert.deepEqual(reviewedValidationContract(head.to), CURRENT_WORLD_MODEL_VALIDATION_CONTRACT);
  assert.deepEqual(reviewedExtractorRegistryPath(head.to), []);
});

test('a reviewed path is current only when every transition on it was mechanical', () => {
  const byReview = (review) => REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS.find((entry) => entry.review === review);
  const afterAdmissionChange = byReview('Portable environment-exclusion identity acceptance').to;
  const beforeAdmissionChange = byReview('Portable environment-exclusion identity acceptance').from;
  assert.equal(reviewedPathPreservesModel(reviewedExtractorRegistryPath(afterAdmissionChange)), true);
  assert.equal(reviewedPathPreservesModel(reviewedExtractorRegistryPath(beforeAdmissionChange)), false,
    'a source-admission transition can change facts, so the model is stale');
  assert.equal(reviewedExtractorRegistryPath(`sha256:${'0'.repeat(64)}`), null);
  assert.equal(reviewedPathPreservesModel(null), false);
  // The oldest reviewed builds ran one fewer validation check, so this build cannot reproduce them.
  const oldest = REVIEWED_EXTRACTOR_REGISTRY_TRANSITIONS[0].from;
  assert.notDeepEqual(reviewedValidationContract(oldest).checkIds,
    CURRENT_WORLD_MODEL_VALIDATION_CONTRACT.checkIds);
});

test('a model published by an earlier reviewed build stays readable and current after an upgrade', async (t) => {
  for (const model of EARLIER_MODELS) {
    const { root } = await earlierBuildRepository(t, model);
    const store = groundingRead(root, model);
    const built = store.freshness.reusableIdentity.built.extractorRegistrySha256;
    assert.equal(built, EARLIER_REGISTRY, model.bundle);
    assert.notEqual(built, BUILTIN_EXTRACTOR_REGISTRY.registrySha256, model.bundle);
    assert.equal(store.freshness.fresh,
      reviewedPathPreservesModel(reviewedExtractorRegistryPath(built)), model.bundle);
    assert.deepEqual(store.freshness.changes.map((change) => change.field), [], model.bundle);
    const [view] = store.views.filter((entry) => entry.status === 'available');
    assert.equal(view.viewId, 'dev.impact');
    assert.equal(/execution-unit: governed-model-composer@1:/u.test(view.markdown),
      model.route === 'model', model.bundle);
  }
});

test('a rebuild over an earlier reviewed build replaces its model with this build', async (t) => {
  const [model] = EARLIER_MODELS;
  const { root } = await earlierBuildRepository(t, model);
  const rebuilt = await buildAndPublishWorldModelV4(root, {
    ...buildOptions(model), outputDir: OUTPUT_DIR, ledgerConfig: LEDGER,
    composer: 'deterministic', generatedAt: '2026-09-28T00:00:00.000Z'
  });
  assert.equal(rebuilt.status, 'completed');
  const store = groundingRead(root, model);
  assert.equal(store.freshness.reusableIdentity.built.extractorRegistrySha256,
    BUILTIN_EXTRACTOR_REGISTRY.registrySha256);
  assert.equal(store.freshness.fresh, true);
});

test('a model from a build the chain has not reviewed is unavailable and a rebuild replaces it', async (t) => {
  const [model] = EARLIER_MODELS;
  const { root, parent } = await earlierBuildRepository(t, model);
  // A structurally valid, self-sealed registry that no reviewed build installed.
  await replaceOnState(root, parent, `${OUTPUT_DIR}/registries/extractors.json`, (text) => {
    const registry = JSON.parse(text);
    const [first, ...rest] = registry.manifests;
    const { manifestSha256, ...manifest } = first;
    manifest.producer = { ...manifest.producer, parser: { ...manifest.producer.parser, version: '9.9.9' } };
    const { registrySha256, ...body } = { ...registry, manifests: [sealRecord(manifest, 'manifestSha256'), ...rest] };
    return `${JSON.stringify(sealRecord(body, 'registrySha256'), null, 2)}\n`;
  });
  assert.throws(() => groundingRead(root, model), (error) => {
    assert.equal(error.code, 'WMB_EARLIER_BUILD_MODEL_INCOMPATIBLE');
    assert.equal(error.details.reason, 'registry-unreviewed');
    assert.equal(isWorldModelAvailabilityError(error), true,
      'grounding continues without the model instead of failing the phase');
    return true;
  });
  const slice = loadWorldModelIdeSlice(root, {
    outputDir: OUTPUT_DIR,
    expectedReusableIdentity: resolveWorldModelV4ReusableIdentity(buildOptions(model)).identity
  });
  assert.equal(slice.reason, 'WMB_EARLIER_BUILD_MODEL_INCOMPATIBLE');
  assert.deepEqual(slice.readiness, {
    status: 'stale', ready: false, source: 'state-branch', command: 'singularity-flow world-model build'
  }, 'the IDE offers a rebuild instead of a diagnosis');
  t.mock.method(console, 'log', () => {});
  const doctor = await handleWorldModelV4Command(root, {
    outputDir: OUTPUT_DIR, definition: { worldModel: { format: 'registered-v4' } }
  }, 'doctor', [], { json: true, format: 'registered-v4', views: 'dev.impact' });
  t.mock.restoreAll();
  assert.equal(doctor.status, 'warn', 'an upgrade-stranded model is not reported as corrupt');
  assert.equal(doctor.state, 'earlier-build');
  assert.deepEqual(doctor.next, { command: 'singularity-flow world-model build' });
  const rebuilt = await buildAndPublishWorldModelV4(root, {
    ...buildOptions(model), outputDir: OUTPUT_DIR, ledgerConfig: LEDGER,
    composer: 'deterministic', generatedAt: '2026-09-28T00:00:00.000Z'
  });
  assert.equal(rebuilt.status, 'completed');
  assert.equal(groundingRead(root, model).freshness.fresh, true);
});

test('an earlier model this build cannot reproduce is refused, while a current model still fails closed', async (t) => {
  const [model] = EARLIER_MODELS;
  const earlier = await earlierBuildRepository(t, model);
  const tamper = (text) => text.replace('## ', '## Edited ');
  await replaceOnState(earlier.root, earlier.parent, `${OUTPUT_DIR}/views/dev.impact.md`, tamper);
  assert.throws(() => groundingRead(earlier.root, model), (error) => {
    assert.equal(error.code, 'WMB_EARLIER_BUILD_MODEL_INCOMPATIBLE');
    assert.equal(error.details.reason, 'not-reproducible');
    assert.match(String(error.details.causeCode), /^WMB_/u);
    return true;
  });

  const current = await earlierBuildRepository(t, model);
  await buildAndPublishWorldModelV4(current.root, {
    ...buildOptions(model), outputDir: OUTPUT_DIR, ledgerConfig: LEDGER,
    composer: 'deterministic', generatedAt: '2026-09-28T00:00:00.000Z'
  });
  await replaceOnState(current.root, current.parent, `${OUTPUT_DIR}/views/dev.impact.md`, tamper);
  assert.throws(() => groundingRead(current.root, model), (error) => {
    assert.notEqual(error.code, 'WMB_EARLIER_BUILD_MODEL_INCOMPATIBLE');
    assert.equal(isWorldModelAvailabilityError(error), false,
      'a tampered model of the installed build remains an integrity failure');
    return true;
  });
});

test('the gateway recommends a rebuild, not a diagnosis, for a model an earlier build wrote', () => {
  const operation = gatewayRegistry().operations.find((entry) => entry.id === 'world-model.next');
  const error = earlierBuildModelIncompatible(`sha256:${'1'.repeat(64)}`, 'registry-unreviewed');
  const { recommendation } = worldModelNextResult({ operation, error }).data.worldModel;
  assert.equal(recommendation.status, 'build-required');
  assert.equal(recommendation.reason, 'WMB_EARLIER_BUILD_MODEL_INCOMPATIBLE');
  assert.equal(recommendation.requiresReview, false);
});
