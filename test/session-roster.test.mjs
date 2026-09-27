import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { readRecord } from '../src/schema-migrations.mjs';
import { renderStoryRoster, storyLifecycleProgress } from '../src/session-roster.mjs';
import { discoverRemoteStoryCandidates, validatedRemoteStoryDefinition } from '../src/session-story-discovery.mjs';
import { removeTemporaryTree } from '../src/util.mjs';

function workflow(statuses = ['approved', 'in_progress', 'not_started'], extra = {}) {
  const phaseOrder = statuses.map((_, index) => `phase-${index}`);
  return {
    phaseOrder,
    phases: Object.fromEntries(phaseOrder.map((id, index) => [id, {
      id, status: statuses[index], generation: index
    }])),
    currentPhase: phaseOrder[1] ?? phaseOrder[0],
    resolution: { phases: phaseOrder.map((id) => ({ id })) },
    ...extra
  };
}

function item(id = 'ROST-1', extra = {}) {
  const state = workflow();
  return {
    id, title: `Story ${id}`, status: 'in_progress', phase: state.currentPhase,
    branch: `story/${id}`, progress: storyLifecycleProgress(state), ...extra
  };
}

function result(items = [item()], extra = {}) {
  return {
    repositoryPath: '/observed/repository', remote: 'origin', count: items.length,
    items, unavailableCount: 0, unavailable: [], ...extra
  };
}

test('lifecycle progress counts retained configured phases and exact phase statuses, not approval events or code completion', () => {
  const state = workflow(['approved', 'approved', 'awaiting_approval', 'in_progress', 'not_started', 'cancelled']);
  state.currentPhase = state.phaseOrder[2];
  state.phases[state.currentPhase].generation = 0;
  state.phases[state.phaseOrder[3]].approvals = [{ decision: 'approved' }];
  state.phases.unselected = { id: 'unselected', status: 'approved', generation: 999 };
  state.resolution.phases[4].optional = true;
  state.resolution.phases[5].disabled = true;
  const before = structuredClone(state);
  const progress = storyLifecycleProgress(state);
  assert.deepEqual(progress, {
    schemaVersion: 1, available: true, approved: 2, total: 6,
    statusCounts: { not_started: 1, in_progress: 1, awaiting_approval: 1, approved: 2, cancelled: 1 },
    current: { id: 'phase-2', status: 'awaiting_approval', generation: 0 }, reason: null
  });
  assert.deepEqual(state, before);
  assert.ok(Object.isFrozen(progress) && Object.isFrozen(progress.current) && Object.isFrozen(progress.statusCounts));
});

test('mixed retained phase sets have independent denominators and overall Story status never implies approvals', () => {
  const short = storyLifecycleProgress(workflow(['approved', 'not_started'], { status: 'completed' }));
  const long = storyLifecycleProgress(workflow(['approved', 'approved', 'approved', 'in_progress', 'not_started']));
  assert.deepEqual([short.approved, short.total, long.approved, long.total], [1, 2, 3, 5]);
  assert.equal(storyLifecycleProgress(workflow(['not_started'], { status: 'approved' })).approved, 0);
});

test('missing or contradictory denominator and phase state evidence stays unavailable', () => {
  const valid = workflow();
  const cases = [
    [null, 'phase-order-unavailable'],
    [{ phases: valid.phases }, 'phase-order-unavailable'],
    [{ ...valid, phaseOrder: [] }, 'phase-order-unavailable'],
    [{ ...valid, phaseOrder: ['phase-0', 'phase-0'] }, 'phase-order-invalid'],
    [{ ...valid, phaseOrder: ['phase-0', null] }, 'phase-order-invalid'],
    [{ ...valid, resolution: { phases: [{ id: 'unrelated' }] } }, 'retained-phase-order-mismatch'],
    [{ ...valid, currentPhase: 'outside' }, 'current-phase-not-in-order'],
    [{ ...valid, phases: {} }, 'phase-state-unavailable'],
    [{ ...valid, phases: { ...valid.phases, 'phase-0': null } }, 'phase-state-unavailable'],
    [{ ...valid, phases: { ...valid.phases, 'phase-0': { id: 'other', status: 'approved' } } }, 'phase-state-invalid'],
    [{ ...valid, phases: { ...valid.phases, 'phase-0': { status: 'complete' } } }, 'phase-state-invalid'],
    [{ ...valid, phases: { ...valid.phases, 'phase-0': {} } }, 'phase-state-invalid']
  ];
  for (const [state, reason] of cases) {
    const progress = storyLifecycleProgress(state);
    assert.equal(progress.available, false, reason);
    assert.equal(progress.reason, reason);
    assert.deepEqual([progress.approved, progress.total, progress.statusCounts], [null, null, null]);
  }
});

test('historical retained order supports counts without inventing missing generations or inferred order', () => {
  const retained = {
    schemaVersion: 1, workItem: { id: 'HIST-1', branch: 'HIST-1' },
    currentPhase: 'legacy', phaseOrder: ['legacy'],
    phases: { legacy: { status: 'approved', artifacts: [{ path: 'old.md' }] } }
  };
  const migrated = readRecord('story-workflow', retained).record;
  assert.equal(migrated.phases.legacy.generation, 1, 'the existing reader may reconstruct generation');
  assert.deepEqual(storyLifecycleProgress(retained).current, { id: 'legacy', status: 'approved', generation: null });
  assert.equal(storyLifecycleProgress(retained).total, 1);
  const absent = structuredClone(retained);
  delete absent.phaseOrder;
  assert.equal(readRecord('story-workflow', absent).record.phaseOrder, undefined);
  assert.equal(storyLifecycleProgress(absent).available, false, 'missing historical order is not inferred from phase map keys');
});

test('missing current-phase metadata is unavailable while an exact retained denominator remains countable', () => {
  const state = workflow(['approved', 'not_started'], { currentPhase: null });
  assert.deepEqual(storyLifecycleProgress(state).current, { id: null, status: null, generation: null });
  assert.equal(storyLifecycleProgress(state).total, 2);
  state.currentPhase = 'phase-1';
  for (const generation of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '4']) {
    state.phases['phase-1'].generation = generation;
    assert.equal(storyLifecycleProgress(state).current.generation, null);
  }
});

test('inherited phase names and statuses do not establish retained state evidence', () => {
  const state = { currentPhase: 'constructor', phaseOrder: ['constructor'], phases: {} };
  assert.equal(storyLifecycleProgress(state).available, false);
  state.phases = { constructor: Object.create({ status: 'approved', generation: 99 }) };
  const missing = storyLifecycleProgress(state);
  assert.equal(missing.available, false);
  assert.deepEqual(missing.current, { id: 'constructor', status: null, generation: null });
  state.phases = JSON.parse('{"constructor":{"id":"constructor","status":"approved","generation":0}}');
  assert.equal(storyLifecycleProgress(state).approved, 1, 'valid own constructor declarations remain allowed');
});

test('the roster retains all verified rows in input order, actual source scope and approval fractions', () => {
  const observed = result([item('SECOND'), item('FIRST', { progress: storyLifecycleProgress(workflow(['approved'])) })], {
    source: 'remote-url', repositoryPath: null, count: 2
  });
  const before = structuredClone(observed);
  const output = renderStoryRoster(observed, { scope: { workspaceReference: 'selected-workspace', repositoryId: 'delivery' } });
  assert.ok(output.indexOf('| 1 | SECOND |') < output.indexOf('| 2 | FIRST |'));
  assert.match(output, /Workspace selector: selected-workspace\nRepository selector: delivery/u);
  assert.match(output, /Discovery source: remote-url\nScanned repository: unavailable/u);
  assert.match(output, /Progress \(approved\/total\)/u);
  assert.match(output, /\| 1\/3 \|/u);
  assert.match(output, /\| 1\/1 \|/u);
  assert.match(output, /not estimated code completion/u);
  assert.match(output, /does not activate or mutate/u);
  assert.match(output, /Copilot: `\/sf-session`/u);
  assert.match(output, /Shell: `singularity-flow session attach <EXACT-STORY-ID> --workspace <EXACT-WORKSPACE-ID-OR-PATH> --repository <EXACT-REPOSITORY-ID>`/u);
  assert.doesNotMatch(output, /\| Selection \|/u, 'unknown selection is not a repeated unavailable column');
  assert.doesNotMatch(output, /\d+%/u);
  assert.deepEqual(observed, before);
});

test('selection labels require an exact ready repository, Story and branch binding', () => {
  const observed = result([item('ONE'), item('TWO')], { workspaceId: 'workspace', repositoryId: 'delivery' });
  const active = { ready: true, repositoryPath: observed.repositoryPath, workspaceId: 'workspace', repositoryId: 'delivery', storyId: 'ONE', branch: 'story/ONE' };
  const output = renderStoryRoster(observed, { activeSelection: active });
  assert.match(output, /\| story\/ONE \| selected \|/u);
  assert.match(output, /\| story\/TWO \| — \|/u);
  for (const invalid of [null, { ...active, ready: false }, { ...active, repositoryPath: '/another/repository' },
    { ...active, branch: 'story/other' }, { ...active, workspaceId: 'another' }, { ...active, repositoryId: 'another' }]) {
    assert.doesNotMatch(renderStoryRoster(observed, { activeSelection: invalid }), /\| selected \|/u);
  }
  assert.doesNotMatch(renderStoryRoster(result([item()])), /\| selected \|/u, 'a singleton roster is not automatic selection');
});

test('URL-only roster scope remains a read-only source, not an attach destination or guessed materialized checkout', () => {
  const output = renderStoryRoster(result([item()], { repositoryPath: null }), {
    scope: { repositoryUrl: 'https://git.example/team/observed.git' }
  });
  assert.match(output, /Repository URL selector: https:\/\/git.example\/team\/observed.git/u);
  assert.match(output, /Discovery source: remote URL metadata\nScanned repository: unavailable/u);
  assert.match(output, /choose a matching registered workspace\/repository before attaching/u);
  assert.match(output, /session attach does not accept --repository-url/u);
});

test('repository cells and diagnostics cannot inject table rows, links, HTML or terminal controls', () => {
  const dangerous = '[click](javascript:alert(1))|`tick` <img> &\r\nrow\t\u001b\u0007\u202e\u200b';
  const observed = result([item('SAFE', { title: dangerous, branch: 'story/one\\two|three' })], {
    remote: dangerous,
    unavailableCount: 1,
    unavailable: [{ claimedId: 'BROKEN|ID', ref: 'origin/branch\nnext', path: 'a|b.json', code: 'BAD', reason: dangerous }]
  });
  const output = renderStoryRoster(observed);
  assert.equal(output.split('\n').filter((line) => /^\| \d+ \|/u.test(line)).length, 2);
  assert.ok(output.includes('\\[click\\]\\(javascript:alert\\(1\\)\\)\\|\\`tick\\` &lt;img&gt; &amp;\\r\\nrow\\t\\u001b\\u0007\\u202e\\u200b'));
  assert.ok(output.includes('story/one\\\\two\\|three'));
  assert.ok(output.includes('BROKEN\\|ID'));
  assert.doesNotMatch(output, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e\u200b]|<img>/u);
});

test('unavailable diagnostics and incomplete counts remain visible, including an empty verified roster', () => {
  const output = renderStoryRoster(result([], {
    count: 3, unavailableCount: 2,
    unavailable: [{ claimedId: 'LOST', branch: 'story/LOST', path: 'workflow.json', code: 'UNREADABLE', reason: 'read failed' }]
  }));
  assert.match(output, /No verified governed Stories/u);
  assert.match(output, /discovery count 3 differs/u);
  assert.match(output, /2 reported; 1 retained diagnostics/u);
  assert.match(output, /not every unavailable claim is described/u);
  assert.match(output, /LOST[\s\S]*UNREADABLE[\s\S]*read failed/u);
  assert.doesNotMatch(output, /\| selected \|/u);
});

test('absent progress and mismatched current phase metadata are shown as unavailable, never inferred', () => {
  const output = renderStoryRoster(result([
    item('ABSENT', { title: undefined, status: undefined, phase: null, progress: undefined }),
    item('MISMATCH', { phase: 'another-phase' }),
    item('INVALID', { progress: { schemaVersion: 1, available: true, approved: 99, total: 1, current: {} } })
  ]));
  assert.match(output, /\| ABSENT \| unavailable \| unavailable \| — \| unavailable \| unavailable \| unavailable \|/u);
  assert.match(output, /\| another-phase \| unavailable \| unavailable \| 1\/3 \|/u);
  assert.doesNotMatch(output, /99\/1/u);
  assert.match(output, /Lifecycle counts are unavailable for 2 verified Story rows/u);
});

test('large rosters either render all rows within the explicit bound or refuse without silent truncation', () => {
  const observed = result(Array.from({ length: 400 }, (_, index) => item(`ROW-${index}`)));
  const output = renderStoryRoster(observed);
  assert.equal(output.split('\n').filter((line) => /^\| \d+ \|/u.test(line)).length, 400);
  for (const options of [{ maxOutputBytes: 1000 }, { maxOutputBytes: 0 }, { maxOutputBytes: 2 * 1024 * 1024 + 1 }]) {
    assert.throws(() => renderStoryRoster(observed, options), { code: 'SESSION_ROSTER_OUTPUT_LIMIT' });
  }
  assert.throws(() => renderStoryRoster(result([item('BIG', { title: 'x'.repeat(2000) })]), { maxOutputBytes: 1000 }), { code: 'SESSION_ROSTER_OUTPUT_LIMIT' });
  for (const invalid of [null, {}, { items: [null] }, { items: [{ title: 'No identity' }] }, { items: [], unavailable: [{} , null] }]) {
    assert.throws(() => renderStoryRoster(invalid), { code: 'SESSION_ROSTER_INVALID' });
  }
});

function git(root, args) {
  const child = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 0, `${args.join(' ')}\n${child.stderr || child.error}`);
  return child.stdout.trim();
}

test('fresh-clone discovery projects exact mixed-profile and historical progress without checkout, index or remote writes', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-roster-'));
  t.after(() => removeTemporaryTree(base));
  const remote = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  const client = path.join(base, 'client');
  git(base, ['init', '--bare', remote]);
  git(base, ['init', '-b', 'main', seed]);
  git(seed, ['config', 'user.name', 'Roster Fixture']);
  git(seed, ['config', 'user.email', 'roster@example.invalid']);
  await initializeDefinition(seed);
  const definition = await loadDefinition(seed);
  const feature = resolveWorkType(definition, 'feature').phases;
  const short = resolveWorkType(definition, 'quick-fix').phases;
  assert.notEqual(feature.length, short.length, 'fixture must exercise genuinely different configured phase sets');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-m', 'retain configured workflow']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const modern = (id, phases, approved, currentIndex) => ({
    schemaVersion: 11, workItem: { id, title: `Retained ${id}`, branch: id },
    lineage: { canonicalBranch: id }, status: 'in_progress',
    currentPhase: phases[currentIndex].id, phaseOrder: phases.map((phase) => phase.id),
    phases: Object.fromEntries(phases.map((phase, index) => [phase.id, {
      id: phase.id, label: phase.label,
      status: index < approved ? 'approved' : index === currentIndex ? 'awaiting_approval' : 'not_started',
      generation: index === currentIndex ? 0 : 1, artifacts: [], checks: []
    }])), resolution: { phases }, history: []
  });
  const historical = (id) => ({
    schemaVersion: 1, workItem: { id, title: `Retained ${id}`, branch: id },
    status: 'in_progress', currentPhase: 'requirements', phaseOrder: ['intake', 'requirements'],
    phases: {
      intake: { label: 'Intake', status: 'approved', artifacts: [] },
      requirements: { label: 'Requirements', status: 'in_progress', artifacts: [{ path: 'evidence.md' }] }
    }
  });
  const emptyOrder = historical('ROST-104');
  emptyOrder.phaseOrder = [];
  const invalidStatus = modern('ROST-105', short, 1, 1);
  delete invalidStatus.phases[short[0].id].status;
  const states = [modern('ROST-101', feature, 2, 2), modern('ROST-102', short, 1, 1), historical('ROST-103'), emptyOrder, invalidStatus];
  for (const state of states) {
    git(seed, ['switch', '-c', state.workItem.id, 'main']);
    const file = path.join(seed, definition.workItemRoot, state.workItem.id, 'workflow.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(state)}\n`);
    git(seed, ['add', definition.workItemRoot]);
    git(seed, ['commit', '-m', `retain ${state.workItem.id}`]);
    git(seed, ['push', 'origin', state.workItem.id]);
  }
  git(seed, ['switch', '-c', 'ROST-BROKEN', 'main']);
  const broken = path.join(seed, definition.workItemRoot, 'ROST-BROKEN', 'workflow.json');
  await mkdir(path.dirname(broken), { recursive: true });
  await writeFile(broken, '{broken json\n');
  git(seed, ['add', definition.workItemRoot]);
  git(seed, ['commit', '-m', 'retain unreadable claim']);
  git(seed, ['push', 'origin', 'ROST-BROKEN']);
  git(base, ['clone', '--no-hardlinks', remote, client]);
  await writeFile(path.join(client, 'staged-local.txt'), 'keep staged bytes\n');
  git(client, ['add', 'staged-local.txt']);
  await writeFile(path.join(client, 'untracked-local.txt'), 'keep local buffer\n');
  const before = {
    head: git(client, ['rev-parse', 'HEAD']), branch: git(client, ['branch', '--show-current']),
    index: git(client, ['ls-files', '--stage']), status: git(client, ['status', '--porcelain=v1']),
    remoteRefs: git(remote, ['show-ref'])
  };
  const discovered = await discoverRemoteStoryCandidates(client, definition, { fetch: false });
  assert.equal(discovered.count, 5);
  assert.equal(discovered.fetched, false);
  const byId = new Map(discovered.items.map((entry) => [entry.id, entry]));
  assert.deepEqual([byId.get('ROST-101').progress.approved, byId.get('ROST-101').progress.total], [2, feature.length]);
  assert.deepEqual([byId.get('ROST-102').progress.approved, byId.get('ROST-102').progress.total], [1, short.length]);
  assert.equal(byId.get('ROST-101').progress.current.generation, 0);
  assert.deepEqual([byId.get('ROST-103').progress.approved, byId.get('ROST-103').progress.total], [1, 2]);
  assert.equal(byId.get('ROST-103').progress.current.generation, null);
  assert.equal(byId.get('ROST-104').progress.available, false, 'empty historical order remains unavailable');
  assert.equal(byId.get('ROST-105').progress.available, false, 'invalid phase status does not become a count');
  assert.ok(discovered.unavailable.some((entry) => entry.claimedId === 'ROST-BROKEN'));
  const output = renderStoryRoster(discovered);
  assert.equal(output.split('\n').filter((line) => /^\| \d+ \| ROST-10\d \|/u.test(line)).length, 5);
  assert.ok(output.includes('ROST-BROKEN') && output.includes('SUBJECT\\_STATE\\_UNREADABLE'));
  assert.deepEqual({
    head: git(client, ['rev-parse', 'HEAD']), branch: git(client, ['branch', '--show-current']),
    index: git(client, ['ls-files', '--stage']), status: git(client, ['status', '--porcelain=v1']),
    remoteRefs: git(remote, ['show-ref'])
  }, before);
  assert.equal(await readFile(path.join(client, 'staged-local.txt'), 'utf8'), 'keep staged bytes\n');
  const selected = validatedRemoteStoryDefinition(client, 'origin/ROST-103', {
    id: 'ROST-103', location: { path: `${definition.workItemRoot}/ROST-103/workflow.json` }
  });
  assert.equal(selected.workflow.phases.requirements.generation, 1);
  assert.equal(selected.retainedWorkflow.phases.requirements.generation, undefined);
});
