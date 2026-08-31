import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  normalizeWorldModelManifest,
  resolveWorldModelContext,
  resolveWorldModelSource,
  validateWorldModelDirectory,
  worldModelSourceSnapshot,
  worldModelSelectionEntry
} from '../src/grounding.mjs';
import {
  automaticMaterializationDecision,
  effectiveMaterializationPolicy,
  ensureGrounding,
  inspectGroundingAvailability,
  isMinimalModel,
  materializationPolicy,
  mergeWorldModelSnapshot,
  writeV3Manifest
} from '../src/world-model-materialization.mjs';
import { resolveGroundingPlan } from '../src/world-model-selection.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test('materialization policy defaults safely and honors the immutable Story snapshot', () => {
  assert.deepEqual(materializationPolicy({}), {
    mode: 'explicit', publish: 'governed', lookahead: 'none', depth: 'phase', confirmation: 'prompt'
  });
  const config = {
    worldModel: { materialization: { mode: 'disabled' } }
  };
  const workflow = {
    resolution: {
      worldModelMaterialization: {
        mode: 'on-demand', publish: 'governed', lookahead: 'none', depth: 'light', confirmation: 'automatic'
      }
    }
  };
  assert.equal(effectiveMaterializationPolicy(config, workflow).mode, 'on-demand');
  assert.equal(effectiveMaterializationPolicy(config, workflow).depth, 'light');
  assert.throws(
    () => materializationPolicy({ worldModel: { materialization: { mode: 'on-demand', depth: 'phase', confirmation: 'automatic' } } }),
    /model-driven phase materialization must be confirmed/
  );
});

test('automatic materialization creates once, extends only the exact same source, and never replaces', () => {
  assert.deepEqual(automaticMaterializationDecision(null), {
    allowed: false,
    mode: 'preserve-existing',
    reason: 'world-model authority could not be inspected, so absence is not proven'
  });
  assert.deepEqual(
    automaticMaterializationDecision({ ready: false, candidates: [], conflicts: [], extensionBase: null }),
    { allowed: true, mode: 'initial-create', reason: 'no existing world model is present' }
  );
  assert.equal(automaticMaterializationDecision({
    ready: false,
    candidates: [{ present: true, integrityValid: true }],
    conflicts: [],
    extensionBase: { sourceTreeSha256: `sha256:${'a'.repeat(64)}` }
  }).mode, 'same-source-extension');
  assert.deepEqual(automaticMaterializationDecision({
    ready: false,
    candidates: [{ present: true, integrityValid: false }],
    conflicts: [],
    extensionBase: null
  }), {
    allowed: false,
    mode: 'preserve-existing',
    reason: 'an existing world model is stale, invalid, or belongs to another source snapshot; automatic replacement is prohibited'
  });
  const conflict = automaticMaterializationDecision({
    ready: false,
    candidates: [{ present: true }],
    conflicts: [{ message: 'state branch diverged' }],
    extensionBase: null
  });
  assert.equal(conflict.allowed, false);
  assert.equal(conflict.mode, 'preserve-existing');
  assert.match(conflict.reason, /state branch diverged/);
});

test('automatic materialization treats partial model bytes without a manifest as invalid, not absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-partial-'));
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Materialization Tester');
  git('config', 'user.email', 'materialization@example.com');
  await writeFile(path.join(root, 'README.md'), '# source\n');
  git('add', 'README.md');
  git('commit', '-qm', 'source');
  await mkdir(path.join(root, 'singularity/world-model'), { recursive: true });
  await writeFile(path.join(root, 'singularity/world-model/partial-output.md'), '# interrupted output\n');

  const definition = {
    worldModel: {
      outputDir: 'singularity/world-model',
      materialization: { mode: 'on-demand', publish: 'local', depth: 'light', confirmation: 'automatic' }
    }
  };
  const availability = await inspectGroundingAvailability(root, {
    outputDir: 'singularity/world-model',
    materialization: materializationPolicy(definition),
    definition
  }, {
    phase: null,
    depth: 'light',
    selections: [{ kind: 'core', tier: 'brief' }],
    taskGuide: { required: false, task: null }
  }, { refreshRemote: false });
  assert.equal(availability.candidates[0].present, true);
  assert.equal(availability.candidates[0].integrityValid, false);
  assert.equal(automaticMaterializationDecision(availability).allowed, false);
});

test('the materialization lease binds both the primary builder and fallback to one source hash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-source-lease-'));
  git(root, 'init', '-q', '-b', 'main');
  const source = `sha256:${'7'.repeat(64)}`;
  const availability = {
    ready: false,
    sourceTreeSha256: source,
    selected: null,
    candidates: [],
    conflicts: [],
    missing: [{ id: 'core/brief' }],
    action: { command: 'singularity-flow wm ensure', reason: 'missing core/brief' }
  };
  const primary = [];
  const fallback = [];
  const changed = new Error('source changed before builder capture');
  changed.code = 'world_model.source_changed_before_build';
  await assert.rejects(
    ensureGrounding(root, {
      materialization: { mode: 'on-demand', publish: 'local' }
    }, { selections: [], taskGuide: { required: false } }, {
      authorized: true,
      inspect: async () => availability,
      materialize: async (request) => {
        primary.push(request.expectedSourceTreeSha256);
        throw changed;
      },
      materializeMinimal: async (request) => fallback.push(request.expectedSourceTreeSha256)
    }),
    (error) => error.code === 'world_model.source_changed_before_build'
  );
  assert.deepEqual(primary, [source]);
  assert.deepEqual(fallback, [], 'a source-identity failure must not invoke a fallback builder');
});

async function seedModel(directory, sourceTreeSha256, {
  label,
  views = {},
  domains = [],
  taskGuides = [],
  pathIndex = null,
  evidenceRecords = null,
  materialization = null
} = {}) {
  await mkdir(path.join(directory, 'core'), { recursive: true });
  await mkdir(path.join(directory, 'views'), { recursive: true });
  await mkdir(path.join(directory, 'evidence'), { recursive: true });
  await writeFile(path.join(directory, 'core/summary.brief.md'), `# ${label} core brief\n`);
  await writeFile(path.join(directory, 'core/summary.md'), `# ${label} core full\n`);
  await writeFile(path.join(directory, 'core/model.json'), '{}\n');
  await writeFile(path.join(directory, 'path-index.json'), `${JSON.stringify(pathIndex ?? { label })}\n`);
  await writeFile(path.join(directory, 'evidence/evidence.jsonl'), `${(evidenceRecords ?? [{ id: 'E-1', label }])
    .map((record) => JSON.stringify(record)).join('\n')}\n`);
  const manifestViews = {};
  for (const [view, tiers] of Object.entries(views)) {
    manifestViews[view] = { tiers: {} };
    for (const tier of ['brief', 'full']) {
      const relative = `views/${view}${tier === 'brief' ? '.brief' : ''}.md`;
      if (tiers.includes(tier)) {
        await writeFile(path.join(directory, relative), `# ${label} ${view} ${tier}\n`);
        manifestViews[view].tiers[tier] = { status: 'ready', path: relative };
      } else {
        manifestViews[view].tiers[tier] = { status: 'missing', path: relative };
      }
    }
  }
  for (const domain of domains) {
    await mkdir(path.dirname(path.join(directory, domain.path)), { recursive: true });
    await writeFile(path.join(directory, domain.path), `# ${label} domain ${domain.id}\n`);
  }
  for (const guide of taskGuides) {
    await mkdir(path.dirname(path.join(directory, guide.path)), { recursive: true });
    await writeFile(path.join(directory, guide.path), `# ${label} task guide ${guide.id}\n\n${guide.task}\n`);
  }
  return writeV3Manifest(directory, {
    schema_version: '3.0',
    generated_at: '2026-08-10T00:00:00.000Z',
    generated_date: '10 August 2026',
    builder_version: 'test',
    builder_prompt_sha256: 'a'.repeat(64),
    analysis_depth: 'quick',
    repository_commit: COMMIT,
    repository_branch: 'main',
    working_tree_clean: true,
    source_tree_sha256: sourceTreeSha256,
    core: {
      tiers: {
        brief: { status: 'ready', path: 'core/summary.brief.md' },
        full: { status: 'ready', path: 'core/summary.md' }
      },
      model: { path: 'core/model.json' }
    },
    views: manifestViews,
    domains,
    task_guides: taskGuides,
    path_index: { path: 'path-index.json' },
    evidence: { path: 'evidence/evidence.jsonl' },
    materializations: []
  }, { materialization });
}

test('context freshness honors the exact configured source scope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-scoped-context-'));
  const outputDir = 'singularity/world-model';
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Scoped Context Tester');
  git(root, 'config', 'user.email', 'scoped-context@example.com');
  await mkdir(path.join(root, 'service'), { recursive: true });
  await mkdir(path.join(root, 'unrelated'), { recursive: true });
  await writeFile(path.join(root, 'service/api.js'), 'export const api = 1;\n');
  await writeFile(path.join(root, 'unrelated/note.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'scoped source');

  const definition = {
    worldModel: { outputDir, sourceRoots: ['service'], sharedRoots: [] },
    ledger: { branch: 'state' }
  };
  const source = await worldModelSourceSnapshot(root, definition);
  git(root, 'switch', '-qc', 'state');
  await seedModel(path.join(root, outputDir), source.sha256, {
    label: 'scoped context', views: { architecture: ['full'] }
  });
  git(root, 'add', outputDir);
  git(root, 'commit', '-qm', 'scoped world model');
  git(root, 'switch', '-q', 'main');
  await writeFile(path.join(root, 'unrelated/note.txt'), 'two\n');
  git(root, 'add', 'unrelated/note.txt');
  git(root, 'commit', '-qm', 'change outside scope');

  const plan = resolveGroundingPlan({
    phase: 'design', phaseViews: ['architecture'], depth: 'standard', context: {}
  });
  const config = {
    definition, outputDir, stateBranch: 'state', remote: 'origin',
    context: {}, phases: { design: { views: ['architecture'], depth: 'standard' } }
  };
  const located = await resolveWorldModelSource(root, config, {
    refreshRemote: false, sourceTreeSha256: source.sha256, requiredSelections: plan.selections
  });
  const resolved = await resolveWorldModelContext(root, config, 'design', { located, plan });
  assert.equal(resolved.freshness.fresh, true);
  assert.equal(resolved.freshness.current, source.sha256);
  assert.equal(resolved.located.sourceTreeSha256, source.sha256);
});

test('exact-source history skips newer corrupt and selection-incomplete snapshots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-history-validity-'));
  const outputDir = 'singularity/world-model';
  const modelDirectory = path.join(root, outputDir);
  const source = `sha256:${'9'.repeat(64)}`;
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'History Tester');
  git(root, 'config', 'user.email', 'history@example.com');
  await writeFile(path.join(root, 'README.md'), '# source\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'source');
  git(root, 'switch', '-qc', 'state');

  await seedModel(modelDirectory, source, {
    label: 'older broad', views: { architecture: ['full'], business: ['full'] }
  });
  git(root, 'add', outputDir);
  git(root, 'commit', '-qm', 'older broad model');
  const broadCommit = git(root, 'rev-parse', 'HEAD');

  await rm(modelDirectory, { recursive: true, force: true });
  await seedModel(modelDirectory, source, {
    label: 'newer narrow', views: { business: ['full'] }
  });
  git(root, 'add', '-A', outputDir);
  git(root, 'commit', '-qm', 'newer narrow model');

  let found = await resolveWorldModelSource(root, {
    outputDir, stateBranch: 'state'
  }, {
    refreshRemote: false,
    sourceTreeSha256: source,
    requiredSelections: [{ kind: 'view', view: 'architecture', tier: 'full' }]
  });
  assert.equal(found.commit, broadCommit);
  assert.equal(found.historical, true);
  assert.equal(found.requestedSourceTreeSha256, source);
  assert.equal(found.sourceTreeSha256, source);
  assert.match(await readFile(path.join(found.directory, 'core/summary.md'), 'utf8'), /older broad/);

  await rm(modelDirectory, { recursive: true, force: true });
  await seedModel(modelDirectory, source, {
    label: 'newest corrupt', views: { architecture: ['full'], business: ['full'] }
  });
  await writeFile(path.join(modelDirectory, 'views/architecture.md'), '# tampered after manifest registration\n');
  git(root, 'add', '-A', outputDir);
  git(root, 'commit', '-qm', 'newest corrupt model');

  found = await resolveWorldModelSource(root, {
    outputDir, stateBranch: 'state'
  }, {
    refreshRemote: false,
    sourceTreeSha256: source,
    requiredSelections: [{ kind: 'view', view: 'architecture', tier: 'full' }]
  });
  assert.equal(found.commit, broadCommit);
  assert.equal(found.sourceTreeSha256, source);
  assert.match(await readFile(path.join(found.directory, 'views/architecture.md'), 'utf8'), /older broad/);
});

test('resolver distinguishes remote absence, unpublished local state, and unverified offline absence', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-authority-'));
  const remote = path.join(base, 'origin.git');
  const root = path.join(base, 'repo');
  const outputDir = 'singularity/world-model';
  const source = `sha256:${'8'.repeat(64)}`;
  git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Authority Tester');
  git(root, 'config', 'user.email', 'authority@example.com');
  await writeFile(path.join(root, 'README.md'), '# source\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'source');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'switch', '-qc', 'state');
  await seedModel(path.join(root, outputDir), source, { label: 'unpublished local state' });
  git(root, 'add', outputDir);
  git(root, 'commit', '-qm', 'local state model');
  git(root, 'switch', '-q', 'main');

  const unpublished = await resolveWorldModelSource(root, {
    outputDir, stateBranch: 'state', remote: 'origin'
  }, { sourceTreeSha256: source });
  assert.equal(unpublished.source, 'state-branch');
  assert.equal(unpublished.authority, 'unpublished-local-state');
  assert.equal(unpublished.refresh, 'remote-absent');
  assert.equal(unpublished.requestedSourceTreeSha256, source);
  assert.equal(unpublished.sourceTreeSha256, source);
  const plan = {
    phase: null,
    depth: 'standard',
    selections: [{ kind: 'core', tier: 'full' }],
    taskGuide: { required: false, task: null },
    includeEvidence: false
  };
  const config = {
    outputDir,
    stateBranch: 'state',
    remote: 'origin',
    materialization: { publish: 'governed' },
    definition: { worldModel: { outputDir }, ledger: { branch: 'state' }, git: { remote: 'origin' } }
  };
  const removedRemote = await inspectGroundingAvailability(root, config, plan);
  assert.equal(removedRemote.ready, false);
  assert.equal(removedRemote.conflicts[0].code, 'world_model.state_removed_remotely');
  assert.equal(automaticMaterializationDecision(removedRemote).allowed, false);

  git(root, 'branch', '-D', 'state');
  git(root, 'remote', 'set-url', 'origin', path.join(base, 'unreachable.git'));
  const offline = await resolveWorldModelSource(root, {
    outputDir, stateBranch: 'state', remote: 'origin'
  }, { sourceTreeSha256: source });
  assert.equal(offline.source, 'worktree');
  assert.equal(offline.authority, 'absent');
  assert.equal(offline.refresh, 'offline-no-state-copy');
  assert.equal(offline.requestedSourceTreeSha256, source);
  assert.equal(offline.sourceTreeSha256, null);
  const unavailable = await inspectGroundingAvailability(root, config, plan);
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.conflicts[0].code, 'world_model.state_authority_unavailable');
  assert.equal(automaticMaterializationDecision(unavailable).allowed, false);
});

test('remote model history is reusable read-only but never an automatic extension authority', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-remote-history-'));
  const remote = path.join(base, 'origin.git');
  const root = path.join(base, 'repo');
  const outputDir = 'singularity/world-model';
  git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Remote History Tester');
  git(root, 'config', 'user.email', 'remote-history@example.com');
  await writeFile(path.join(root, 'README.md'), '# source\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'source');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  const definition = {
    worldModel: { outputDir }, ledger: { branch: 'state' }, git: { remote: 'origin' }
  };
  const config = {
    outputDir, stateBranch: 'state', remote: 'origin',
    materialization: { publish: 'governed' }, definition
  };
  const source = (await worldModelSourceSnapshot(root, definition)).sha256;
  const corePlan = {
    phase: null, depth: 'standard', selections: [{ kind: 'core', tier: 'full' }],
    taskGuide: { required: false, task: null }, includeEvidence: false
  };
  const architecturePlan = {
    ...corePlan,
    selections: [{ kind: 'core', tier: 'full' }, { kind: 'view', view: 'architecture', tier: 'full' }]
  };

  git(root, 'switch', '-qc', 'state');
  await seedModel(path.join(root, outputDir), source, { label: 'remote exact core' });
  git(root, 'add', outputDir);
  git(root, 'commit', '-qm', 'publish exact core model');
  const modelCommit = git(root, 'rev-parse', 'HEAD');
  git(root, 'push', '-q', '-u', 'origin', 'state');
  git(root, 'switch', '-q', 'main');
  git(root, 'fetch', '-q', 'origin', '+refs/heads/state:refs/remotes/origin/state');

  // An unpublished local state descendant may already contain the missing selection. The remote
  // snapshot must not be extended automatically and duplicate that local work.
  git(root, 'switch', '-q', 'state');
  await rm(path.join(root, outputDir), { recursive: true, force: true });
  await seedModel(path.join(root, outputDir), source, {
    label: 'unpublished local architecture', views: { architecture: ['full'] }
  });
  git(root, 'add', '-A', outputDir);
  git(root, 'commit', '-qm', 'extend model locally without publication');
  git(root, 'switch', '-q', 'main');
  const unpublishedAhead = await inspectGroundingAvailability(root, config, architecturePlan);
  assert.equal(unpublishedAhead.ready, false);
  assert.equal(unpublishedAhead.authority, 'unpublished-local-state');
  assert.equal(unpublishedAhead.extensionBase, null);
  assert.equal(unpublishedAhead.conflicts[0].code, 'world_model.state_publication_pending');
  assert.equal(automaticMaterializationDecision(unpublishedAhead).allowed, false);
  git(root, 'branch', '-f', 'state', 'refs/remotes/origin/state');

  // A complete exact cached snapshot is sufficient for read-only use while offline. Its missing
  // view cannot be filled automatically until the remote authority is available again.
  git(root, 'remote', 'set-url', 'origin', path.join(base, 'unreachable.git'));
  const offlineReady = await inspectGroundingAvailability(root, config, corePlan);
  assert.equal(offlineReady.ready, true);
  assert.equal(offlineReady.authority, 'offline-unverified');
  assert.equal(automaticMaterializationDecision(offlineReady).mode, 'reuse');
  const offlineIncomplete = await inspectGroundingAvailability(root, config, architecturePlan);
  assert.equal(offlineIncomplete.ready, false);
  assert.equal(offlineIncomplete.extensionBase, null);
  assert.equal(offlineIncomplete.conflicts[0].code, 'world_model.state_authority_unavailable');
  assert.equal(automaticMaterializationDecision(offlineIncomplete).allowed, false);

  git(root, 'remote', 'set-url', 'origin', remote);
  git(root, 'switch', '-q', 'state');
  await rm(path.join(root, outputDir), { recursive: true, force: true });
  await writeFile(path.join(root, 'state-marker.txt'), 'model deliberately removed\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'remove model projection');
  git(root, 'push', '-q', 'origin', 'state');
  git(root, 'switch', '-q', 'main');

  const historical = await resolveWorldModelSource(root, config, {
    sourceTreeSha256: source,
    requiredSelections: corePlan.selections,
    requireEvidence: false
  });
  assert.equal(historical.commit, modelCommit);
  assert.equal(historical.historical, true);
  assert.equal(historical.remoteBranchPresent, true);
  assert.equal(historical.remoteModelAtTip, false);
  assert.equal(historical.remoteModelInHistory, true);
  const historicalReady = await inspectGroundingAvailability(root, config, corePlan);
  assert.equal(historicalReady.ready, true, 'an exact complete historical snapshot remains readable');
  assert.equal(historicalReady.remoteModelInHistory, true);
  assert.equal(automaticMaterializationDecision(historicalReady).mode, 'reuse');

  const historicalIncomplete = await inspectGroundingAvailability(root, config, architecturePlan);
  assert.equal(historicalIncomplete.ready, false);
  assert.equal(historicalIncomplete.extensionBase, null);
  assert.equal(historicalIncomplete.conflicts[0].code, 'world_model.state_removed_remotely');
  assert.equal(automaticMaterializationDecision(historicalIncomplete).allowed, false);
});

test('an absent remote state branch cannot be mistaken for proven first creation', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-absent-state-'));
  const remote = path.join(base, 'origin.git');
  const root = path.join(base, 'repo');
  const outputDir = 'singularity/world-model';
  git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Absent State Tester');
  git(root, 'config', 'user.email', 'absent-state@example.com');
  await writeFile(path.join(root, 'README.md'), '# source\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'source');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  const definition = {
    worldModel: { outputDir }, ledger: { branch: 'state' }, git: { remote: 'origin' }
  };
  const availability = await inspectGroundingAvailability(root, {
    outputDir, stateBranch: 'state', remote: 'origin',
    materialization: { publish: 'governed' }, definition
  }, {
    phase: null, depth: 'standard', selections: [{ kind: 'core', tier: 'full' }],
    taskGuide: { required: false, task: null }, includeEvidence: false
  });
  assert.equal(availability.refreshStatus, 'remote-absent');
  assert.equal(availability.remoteBranchPresent, false);
  assert.equal(availability.conflicts[0].code, 'world_model.state_branch_absent');
  assert.equal(automaticMaterializationDecision(availability).allowed, false);
});

test('a reachable state branch that never contained a model permits initial creation', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-never-published-'));
  const remote = path.join(base, 'origin.git');
  const root = path.join(base, 'repo');
  const outputDir = 'singularity/world-model';
  git(base, 'init', '--bare', '-q', '-b', 'main', remote);
  git(base, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Never Published Tester');
  git(root, 'config', 'user.email', 'never-published@example.com');
  await writeFile(path.join(root, 'README.md'), '# source\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'source');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'switch', '-qc', 'state');
  await writeFile(path.join(root, 'state-marker.txt'), 'state exists without a model\n');
  git(root, 'add', 'state-marker.txt');
  git(root, 'commit', '-qm', 'initialize state only');
  git(root, 'push', '-q', '-u', 'origin', 'state');
  git(root, 'switch', '-q', 'main');
  const definition = {
    worldModel: { outputDir }, ledger: { branch: 'state' }, git: { remote: 'origin' }
  };
  const availability = await inspectGroundingAvailability(root, {
    outputDir, stateBranch: 'state', remote: 'origin',
    materialization: { publish: 'governed' }, definition
  }, {
    phase: null, depth: 'standard', selections: [{ kind: 'core', tier: 'full' }],
    taskGuide: { required: false, task: null }, includeEvidence: false
  });
  assert.equal(availability.remoteBranchPresent, true);
  assert.equal(availability.remoteModelAtTip, false);
  assert.equal(availability.remoteModelInHistory, false);
  assert.deepEqual(availability.conflicts, []);
  assert.equal(automaticMaterializationDecision(availability).mode, 'initial-create');
});

test('v3 validation requires the exact requested tier without silently falling back', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-tier-'));
  const source = `sha256:${'1'.repeat(64)}`;
  await seedModel(root, source, { label: 'exact', views: { business: ['brief'] } });
  await validateWorldModelDirectory(root, {
    requiredSelections: [
      { kind: 'core', tier: 'brief' },
      { kind: 'view', view: 'business', tier: 'brief' }
    ],
    requireEvidence: false,
    integrity: 'selected'
  });
  await assert.rejects(
    validateWorldModelDirectory(root, {
      requiredSelections: [{ kind: 'view', view: 'business', tier: 'full' }],
      requireEvidence: false,
      integrity: 'selected'
    }),
    /business\/full.*missing/
  );
});

test('legacy manifests remain readable while v3 keeps exact tier identity', () => {
  for (const schema of ['1.0', '2.0']) {
    const normalized = normalizeWorldModelManifest({
      schema_version: schema,
      core: { summary: 'core/summary.md', model: 'core/model.json' },
      views: { architecture: { path: 'views/architecture.md', generated: true } }
    });
    assert.equal(normalized.source_schema_version, schema);
    assert.equal(
      worldModelSelectionEntry(normalized, { kind: 'view', view: 'architecture', tier: 'brief' }, { allowLegacyFallback: true }).path,
      'views/architecture.md'
    );
  }
  const normalized = normalizeWorldModelManifest({
    schema_version: '3.0',
    core: { tiers: { brief: { status: 'missing' }, full: { status: 'ready', path: 'core/summary.md' } } },
    views: {}
  });
  assert.equal(worldModelSelectionEntry(normalized, { kind: 'core', tier: 'brief' }).status, 'missing');
});

test('same-source extension preserves retained records and unions new aggregate records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-merge-'));
  const existing = path.join(root, 'existing');
  const fragment = path.join(root, 'fragment');
  const target = path.join(root, 'target');
  const source = `sha256:${'2'.repeat(64)}`;
  await seedModel(existing, source, {
    label: 'original',
    views: { business: ['brief'] },
    domains: [{ id: 'payments', path: 'domains/payments.md' }],
    taskGuides: [{ id: 'old-task', path: 'task-guides/old-task.md', task: 'Explain the old flow' }],
    pathIndex: {
      schema_version: '1.0',
      entries: [{ glob: 'src/payments/**', domains: ['payments'], views: ['business'], notes: 'original mapping' }],
      fallback: { views: ['business'], anchors: [] }
    },
    evidenceRecords: [{ id: 'E-1', claim: 'original evidence', label: 'original' }],
    materialization: { id: 'first', selections: ['core/brief', 'business/brief'] }
  });
  await seedModel(fragment, source, {
    label: 'extension',
    views: { architecture: ['full'] },
    domains: [
      { id: 'payments', path: 'domains/payments.md' },
      { id: 'orders', path: 'domains/orders.md' }
    ],
    taskGuides: [
      { id: 'old-task', path: 'task-guides/old-task.md', task: 'Attempt to replace the old flow' },
      { id: 'new-task', path: 'task-guides/new-task.md', task: 'Explain the new flow' }
    ],
    pathIndex: {
      schema_version: '1.0',
      entries: [
        { glob: 'src/payments/**', domains: ['payments'], views: ['architecture'], notes: 'attempted replacement' },
        { glob: 'src/orders/**', domains: ['orders'], views: ['architecture'], notes: 'new mapping' }
      ],
      fallback: { views: ['architecture'], anchors: [] }
    },
    evidenceRecords: [
      { id: 'E-1', claim: 'attempted replacement', label: 'extension' },
      { id: 'E-2', claim: 'new architecture evidence', label: 'extension' }
    ],
    materialization: { id: 'second', selections: ['core/brief', 'architecture/full'] }
  });
  const originalCore = await readFile(path.join(existing, 'core/summary.brief.md'), 'utf8');
  const originalBusiness = await readFile(path.join(existing, 'views/business.brief.md'), 'utf8');
  const originalDomain = await readFile(path.join(existing, 'domains/payments.md'));
  const originalTaskGuide = await readFile(path.join(existing, 'task-guides/old-task.md'));
  const manifest = await mergeWorldModelSnapshot({
    existingDirectory: existing,
    fragmentDirectory: fragment,
    targetDirectory: target,
    sourceTreeSha256: source,
    plan: { selections: [{ kind: 'core', tier: 'brief' }, { kind: 'view', view: 'architecture', tier: 'full' }] },
    materialization: null
  });
  assert.equal(await readFile(path.join(target, 'core/summary.brief.md'), 'utf8'), originalCore);
  assert.equal(await readFile(path.join(target, 'views/business.brief.md'), 'utf8'), originalBusiness);
  const pathIndexBytes = await readFile(path.join(target, 'path-index.json'));
  const pathIndex = JSON.parse(pathIndexBytes);
  assert.deepEqual(pathIndex.entries, [
    { domains: ['payments'], glob: 'src/payments/**', notes: 'original mapping', views: ['business'] },
    { domains: ['orders'], glob: 'src/orders/**', notes: 'new mapping', views: ['architecture'] }
  ]);
  assert.deepEqual(pathIndex.fallback.views, ['business', 'architecture']);
  const evidenceBytes = await readFile(path.join(target, 'evidence/evidence.jsonl'));
  const evidence = evidenceBytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(evidence, [
    { claim: 'original evidence', id: 'E-1', label: 'original' },
    { claim: 'new architecture evidence', id: 'E-2', label: 'extension' }
  ]);
  assert.equal(manifest.path_index.bytes, pathIndexBytes.length);
  assert.equal(manifest.path_index.sha256, createHash('sha256').update(pathIndexBytes).digest('hex'));
  assert.equal(manifest.evidence.bytes, evidenceBytes.length);
  assert.equal(manifest.evidence.sha256, createHash('sha256').update(evidenceBytes).digest('hex'));
  assert.deepEqual(await readFile(path.join(target, 'domains/payments.md')), originalDomain);
  assert.deepEqual(await readFile(path.join(target, 'task-guides/old-task.md')), originalTaskGuide);
  assert.match(await readFile(path.join(target, 'views/architecture.md'), 'utf8'), /extension architecture full/);
  assert.match(await readFile(path.join(target, 'domains/payments.md'), 'utf8'), /original domain payments/);
  assert.match(await readFile(path.join(target, 'domains/orders.md'), 'utf8'), /extension domain orders/);
  assert.match(await readFile(path.join(target, 'task-guides/old-task.md'), 'utf8'), /Explain the old flow/);
  assert.match(await readFile(path.join(target, 'task-guides/new-task.md'), 'utf8'), /Explain the new flow/);
  await validateWorldModelDirectory(target, { integrity: 'full' });
  assert.deepEqual(manifest.materializations.at(-1).reused, ['core/brief']);
});

test('explicit same-source refresh replaces colliding aggregate records and retains unrelated records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-aggregate-refresh-'));
  const existing = path.join(root, 'existing');
  const fragment = path.join(root, 'fragment');
  const target = path.join(root, 'target');
  const source = `sha256:${'6'.repeat(64)}`;
  await seedModel(existing, source, {
    label: 'original', views: { business: ['full'] },
    pathIndex: { entries: [
      { glob: 'src/shared/**', views: ['business'], notes: 'old' },
      { glob: 'src/unrelated/**', views: ['business'], notes: 'retain' }
    ] },
    evidenceRecords: [
      { id: 'E-1', claim: 'old' },
      { id: 'E-KEEP', claim: 'retain' }
    ]
  });
  await seedModel(fragment, source, {
    label: 'refresh', views: { business: ['full'] },
    pathIndex: { entries: [{ glob: 'src/shared/**', views: ['business'], notes: 'refreshed' }] },
    evidenceRecords: [{ id: 'E-1', claim: 'refreshed' }]
  });
  await mergeWorldModelSnapshot({
    existingDirectory: existing,
    fragmentDirectory: fragment,
    targetDirectory: target,
    sourceTreeSha256: source,
    plan: { selections: [{ kind: 'view', view: 'business', tier: 'full' }] },
    materialization: null,
    replaceRequested: true
  });
  const index = JSON.parse(await readFile(path.join(target, 'path-index.json'), 'utf8'));
  assert.deepEqual(index.entries, [
    { glob: 'src/shared/**', notes: 'refreshed', views: ['business'] },
    { glob: 'src/unrelated/**', notes: 'retain', views: ['business'] }
  ]);
  const evidence = (await readFile(path.join(target, 'evidence/evidence.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(evidence, [
    { claim: 'refreshed', id: 'E-1' },
    { claim: 'retain', id: 'E-KEEP' }
  ]);
  await validateWorldModelDirectory(target, { integrity: 'full' });
});

test('manifest stamping rejects path-index references to an unavailable view', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-index-reference-'));
  const fragment = path.join(root, 'fragment');
  const source = `sha256:${'7'.repeat(64)}`;
  await assert.rejects(() => seedModel(fragment, source, {
    label: 'fragment', views: { architecture: ['full'] },
    pathIndex: { entries: [{ glob: 'src/ghost/**', views: ['security'] }] }
  }), (error) => error.code === 'world_model.path_index_reference_invalid');
});

test('first materialization cannot retain aggregate references to a filtered view', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-first-index-reference-'));
  const fragment = path.join(root, 'fragment');
  const target = path.join(root, 'target');
  const source = `sha256:${'1'.repeat(64)}`;
  await seedModel(fragment, source, {
    label: 'broad provider fragment', views: { architecture: ['full'], security: ['full'] },
    pathIndex: { entries: [{ glob: 'src/security/**', views: ['security'] }] }
  });
  await assert.rejects(() => mergeWorldModelSnapshot({
    fragmentDirectory: fragment,
    targetDirectory: target,
    sourceTreeSha256: source,
    plan: { selections: [{ kind: 'view', view: 'architecture', tier: 'full' }] },
    materialization: null
  }), (error) => error.code === 'world_model.path_index_reference_invalid');
});

test('v3 validation binds aggregate path-index and evidence receipts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-aggregate-receipts-'));
  const pathIndexModel = path.join(root, 'path-index-model');
  const evidenceModel = path.join(root, 'evidence-model');
  const source = `sha256:${'2'.repeat(64)}`;
  const options = {
    label: 'receipt bound', views: { architecture: ['full'] },
    pathIndex: { entries: [{ glob: 'src/**', views: ['architecture'] }] },
    evidenceRecords: [{ id: 'E-BOUND', claim: 'original' }]
  };
  await seedModel(pathIndexModel, source, options);
  await writeFile(path.join(pathIndexModel, 'path-index.json'), '{"entries":[{"glob":"changed/**","views":["architecture"]}]}\n');
  await assert.rejects(
    () => validateWorldModelDirectory(pathIndexModel, { integrity: 'full' }),
    /path index (?:byte count|hash) differs/
  );

  await seedModel(evidenceModel, source, options);
  await writeFile(path.join(evidenceModel, 'evidence/evidence.jsonl'), '{"id":"E-BOUND","claim":"changed"}\n');
  await assert.rejects(
    () => validateWorldModelDirectory(evidenceModel, { integrity: 'full' }),
    /evidence ledger (?:byte count|hash) differs/
  );
});

test('a changed source snapshot never reuses artifacts from the older snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-stale-'));
  const existing = path.join(root, 'existing');
  const fragment = path.join(root, 'fragment');
  const target = path.join(root, 'target');
  await seedModel(existing, `sha256:${'3'.repeat(64)}`, { label: 'old', views: { business: ['brief'] } });
  await seedModel(fragment, `sha256:${'4'.repeat(64)}`, { label: 'new', views: { architecture: ['full'] } });
  const manifest = await mergeWorldModelSnapshot({
    existingDirectory: existing,
    fragmentDirectory: fragment,
    targetDirectory: target,
    sourceTreeSha256: `sha256:${'4'.repeat(64)}`,
    plan: { selections: [{ kind: 'core', tier: 'brief' }, { kind: 'view', view: 'architecture', tier: 'full' }] },
    materialization: null
  });
  assert.equal(manifest.views.business, undefined);
  assert.match(await readFile(path.join(target, 'core/summary.brief.md'), 'utf8'), /new core brief/);
});

test('same-source semantic generation upgrades light tiers without downgrading semantic winners', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-upgrade-'));
  const source = `sha256:${'5'.repeat(64)}`;
  const light = path.join(root, 'light');
  const semantic = path.join(root, 'semantic');
  const upgraded = path.join(root, 'upgraded');
  const preserved = path.join(root, 'preserved');
  const refreshed = path.join(root, 'refreshed');
  const semanticRefresh = path.join(root, 'semantic-refresh');
  const mixed = path.join(root, 'mixed');
  const plan = {
    selections: [{ kind: 'core', tier: 'brief' }, { kind: 'view', view: 'testing', tier: 'full' }]
  };
  await seedModel(light, source, {
    label: 'light', views: { testing: ['full'] },
    materialization: { id: 'light', provider: null, selections: ['core/brief', 'testing/full'] }
  });
  await seedModel(semantic, source, {
    label: 'semantic', views: { testing: ['full'] },
    materialization: { id: 'semantic', provider: 'copilot-cli', selections: ['core/brief', 'testing/full'] }
  });

  await mergeWorldModelSnapshot({
    existingDirectory: light, fragmentDirectory: semantic, targetDirectory: upgraded,
    sourceTreeSha256: source, plan, materialization: null
  });
  assert.match(await readFile(path.join(upgraded, 'core/summary.brief.md'), 'utf8'), /semantic core brief/);
  assert.match(await readFile(path.join(upgraded, 'views/testing.md'), 'utf8'), /semantic testing full/);

  await mergeWorldModelSnapshot({
    existingDirectory: semantic, fragmentDirectory: light, targetDirectory: preserved,
    sourceTreeSha256: source, plan, materialization: null
  });
  assert.match(await readFile(path.join(preserved, 'core/summary.brief.md'), 'utf8'), /semantic core brief/);
  assert.match(await readFile(path.join(preserved, 'views/testing.md'), 'utf8'), /semantic testing full/);

  await seedModel(semanticRefresh, source, {
    label: 'semantic-refresh', views: { testing: ['full'] },
    materialization: { id: 'semantic-refresh', provider: 'copilot-cli', selections: ['core/brief', 'testing/full'] }
  });
  await mergeWorldModelSnapshot({
    existingDirectory: semantic,
    fragmentDirectory: semanticRefresh,
    targetDirectory: refreshed,
    sourceTreeSha256: source,
    plan,
    materialization: null,
    replaceRequested: true
  });
  assert.match(await readFile(path.join(refreshed, 'core/summary.brief.md'), 'utf8'), /semantic-refresh core brief/);
  assert.match(await readFile(path.join(refreshed, 'views/testing.md'), 'utf8'), /semantic-refresh testing full/);

  const semanticBase = path.join(root, 'semantic-base');
  const lightExtension = path.join(root, 'light-extension');
  await seedModel(semanticBase, source, {
    label: 'semantic-base', views: { business: ['full'] },
    materialization: { id: 'semantic-base', provider: 'copilot-cli', selections: ['core/brief', 'business/full'] }
  });
  await seedModel(lightExtension, source, {
    label: 'light-extension', views: { architecture: ['full'] },
    materialization: { id: 'light-extension', provider: null, selections: ['core/brief', 'architecture/full'] }
  });
  const mixedManifest = await mergeWorldModelSnapshot({
    existingDirectory: semanticBase,
    fragmentDirectory: lightExtension,
    targetDirectory: mixed,
    sourceTreeSha256: source,
    plan: {
      selections: [
        { kind: 'core', tier: 'brief' },
        { kind: 'view', view: 'business', tier: 'full' },
        { kind: 'view', view: 'architecture', tier: 'full' }
      ]
    },
    materialization: null
  });
  assert.equal(mixedManifest.builder_version, 'mixed');
  assert.equal(mixedManifest.analysis_depth, 'mixed');
  assert.equal(isMinimalModel(mixedManifest, [{ kind: 'view', view: 'business', tier: 'full' }]), false);
  assert.equal(isMinimalModel(mixedManifest, [{ kind: 'view', view: 'architecture', tier: 'full' }]), true);
  assert.equal(isMinimalModel(mixedManifest, [
    { kind: 'view', view: 'business', tier: 'full' },
    { kind: 'view', view: 'architecture', tier: 'full' }
  ]), true);
});
