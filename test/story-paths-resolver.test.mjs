// SSB M1 [SSB:REQ-009]: one resolver joins a Story's paths. Its story-branch arm is today's formulas, byte for byte;
// its state-ref arm is reached from M2, when `story.storage: state-ref` starts a Story (docs/plans/SSB-M1-PLAN.md §7).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  CONFIGURATION_SOURCE_RELATIVE, DEFAULT_WORK_ITEM_ROOT, STATE_CHECKOUT, STATE_REF_PREFIX, STORY_DOCUMENTS, STORY_LAYOUTS,
  forgetStoryLayouts, isStoryRecordPath, rememberStoryLayout, stateRefName, stateTrackingRefName, storiesDirectory, storiesRoot,
  storyIdOfRecord, storyLocation, storyRecordOf, storyRecordWithin, workDir, workDirRelative, workflowPath
} from '../src/story-paths.mjs';
import { DEFAULT_WORK_ITEM_ROOT as LOCATION_DEFAULT, workItemWorkflowRelative } from '../src/work-item-location.mjs';
import { clarificationRecordRelative, groundingRecordRelative } from '../src/phase-generation.mjs';
import { CONFIGURATION_SOURCE_PATH } from '../src/configuration-assets.mjs';

// Every Stories folder the test fixtures use, plus the default (undefined).
const ROOTS = [undefined, 'singularity/work-items', 'team/stories', 'governed/story-state', 'governed/items',
  'team/work-items', 'records', 'other/root', 'different/live-configuration', 'custom/work-items', 'custom/story-records'];
const IDS = ['W-1', 'STORY-001', 'a.b.c', 'under_score', 'X9-1.2_rc'];
const FLAVOURS = [['posix', path.posix, '/r'], ['win32', path.win32, 'C:\\r']];

// Today's formulas, as story-paths.mjs, state.mjs and the inline joins spelled them on 5ac41f37e.
const old = (p) => ({
  posix: (value) => value.split(p.sep).join('/'),
  workDir: (root, config, id) => p.join(root, config.workItemRoot ?? 'singularity/work-items', id),
  workDirRelative: (config, id) => old(p).posix(p.join(config.workItemRoot ?? 'singularity/work-items', id)),
  workflowPath: (root, config, id) => p.join(old(p).workDir(root, config, id), 'workflow.json')
});

test('the kept wrappers equal the old formulas byte for byte', () => {
  for (const workItemRoot of ROOTS) {
    for (const id of IDS) {
      const config = { workItemRoot };
      const formulas = old(path);
      assert.equal(workDir('/r', config, id), formulas.workDir('/r', config, id));
      assert.equal(workDirRelative(config, id), formulas.workDirRelative(config, id));
      assert.equal(workflowPath('/r', config, id), formulas.workflowPath('/r', config, id));
    }
  }
});

test('every story-branch member equals today\'s spelling, on POSIX and Windows paths', () => {
  for (const [, p, root] of FLAVOURS) {
    const formulas = old(p);
    for (const workItemRoot of ROOTS) {
      for (const id of IDS) {
        const config = { workItemRoot };
        const base = workItemRoot ?? 'singularity/work-items';
        const at = storyLocation(root, config, id, { pathModule: p });
        assert.equal(at.layout, 'story-branch');
        assert.equal(at.id, id);
        assert.equal(at.directory, formulas.workDir(root, config, id));
        assert.equal(at.file('evidence', 'a.json'), p.join(formulas.workDir(root, config, id), 'evidence', 'a.json'));
        assert.equal(at.file(), formulas.workDir(root, config, id));
        assert.equal(at.workflowFile, formulas.workflowPath(root, config, id));
        assert.equal(at.prefix, formulas.workDirRelative(config, id));
        assert.equal(at.prefix, `${base}/${id}`);
        // Record paths: posix(path.join(...)), path.posix.join(...) and the template strings all agree on a
        // normalized Stories folder.
        assert.equal(at.record('evidence', 'a.json'), formulas.posix(p.join(base, id, 'evidence', 'a.json')));
        assert.equal(at.record('evidence', 'a.json'), path.posix.join(formulas.workDirRelative(config, id), 'evidence/a.json'));
        assert.equal(at.record('evidence/a.json'), `${base}/${id}/evidence/a.json`);
        assert.equal(at.fromRecord(`${base}/${id}/gdp/x.json`), p.join(root, `${base}/${id}/gdp/x.json`));
        assert.equal(at.inside(`${base}/${id}/gdp/x.json`), 'gdp/x.json');
        assert.equal(at.inside(`${base}/${id}`), '');
        assert.equal(at.inside(`${base}/${id}x/gdp/x.json`), null);
        assert.equal(at.inside('src/app.mjs'), null);
        assert.equal(at.owns(`${base}/${id}/gdp/x.json`), true);
        assert.equal(at.owns(`${base}/${id}`), false);
        assert.equal(at.owns(`${base}/${id}-2/workflow.json`), false);
        assert.deepEqual(at.document('artifacts/design/design.md'), {
          relative: `${base}/${id}/artifacts/design/design.md`,
          absolute: p.join(root, `${base}/${id}/artifacts/design/design.md`)
        });
        assert.equal(at.isDocument(`${base}/${id}/artifacts/design/design.md`), true);
        assert.equal(at.isDocument(`${base}/${id}/evidence/a.json`), false);
        assert.deepEqual(at.configurationSource, {
          relative: 'singularity/configuration-source.json', absolute: p.join(root, 'singularity/configuration-source.json')
        });
        assert.equal(at.configurationRoot, root);
        assert.equal(at.codeTreeExclusion, `${String(base).split('/')[0]}/`);
        assert.deepEqual(at.object('workflow.json'), { revision: null, path: `${base}/${id}/workflow.json` });
        assert.deepEqual(at.commitScope, { cwd: root, pathspecs: [`${base}/${id}`] });
      }
    }
  }
});

test('the plan\'s table: Story W-1 in /r with the default Stories folder, on both layouts', () => {
  const branch = storyLocation('/r', {}, 'W-1');
  const state = storyLocation('/r', {}, 'W-1', { layout: 'state-ref' });
  assert.equal(branch.directory, '/r/singularity/work-items/W-1');
  assert.equal(state.directory, '/r/.sflow-state');
  assert.equal(branch.record('evidence', 'a.json'), 'singularity/work-items/W-1/evidence/a.json');
  assert.equal(state.record('evidence', 'a.json'), 'evidence/a.json');
  assert.equal(branch.fromRecord('x/y.json'), '/r/x/y.json');
  assert.equal(state.fromRecord('x/y.json'), '/r/.sflow-state/x/y.json');
  assert.equal(branch.inside('singularity/work-items/W-1/gdp/x.json'), 'gdp/x.json');
  assert.equal(branch.prefix, 'singularity/work-items/W-1');
  // A state-ref Story has no prefix: a join on it refuses, loudly, instead of writing into the code checkout (M2).
  assert.throws(() => state.prefix, (error) => error.code === 'STORY_STATE_REF_PATH_UNAVAILABLE'
    && error.details.nextAction.argv.join(' ') === 'update');
  assert.equal(branch.branchPrefix, 'singularity/work-items/W-1');
  assert.equal(state.branchPrefix, null);
  assert.equal(branch.recordsRoot, '/r');
  assert.equal(state.recordsRoot, '/r/.sflow-state');
  assert.equal(path.join(state.recordsRoot, state.record('evidence', 'a.json')), state.file('evidence', 'a.json'));
  assert.equal(state.owns('singularity/work-items/W-1/gdp/x.json'), false);
  // M3 keeps a state-ref Story's documents in its state checkout, named from the checkout; M4 moves them to docs/stories.
  assert.deepEqual(state.document('artifacts/design/design.md'),
    { relative: '.sflow-state/artifacts/design/design.md', absolute: '/r/.sflow-state/artifacts/design/design.md' });
  assert.equal(state.isDocument('.sflow-state/artifacts/design/design.md'), true);
  assert.equal(state.isDocument('.sflow-state/context/a.json'), false);
  // The pin stays inside the pinned copy, at its usual path, so every reader of a pinned copy finds it (M2).
  assert.deepEqual(state.configurationSource, { relative: 'configuration/singularity/configuration-source.json',
    absolute: '/r/.sflow-state/configuration/singularity/configuration-source.json' });
  assert.equal(state.configurationRoot, '/r/.sflow-state/configuration');
  assert.equal(state.codeTreeExclusion, null);
  assert.deepEqual(state.object('workflow.json'), { revision: 'refs/singularity/state/W-1', path: 'workflow.json' });
  assert.deepEqual(branch.commitScope, { cwd: '/r', pathspecs: ['singularity/work-items/W-1'] });
  assert.deepEqual(state.commitScope, { cwd: '/r/.sflow-state', pathspecs: ['.'] });
  assert.equal(state.workflowFile, '/r/.sflow-state/workflow.json');
});

test('the constants name the state-ref layout the owner chose (2026-11-26)', () => {
  assert.deepEqual(STORY_LAYOUTS, ['story-branch', 'state-ref']);
  assert.equal(Object.isFrozen(STORY_LAYOUTS), true);
  assert.equal(STATE_CHECKOUT, '.sflow-state');
  assert.equal(STORY_DOCUMENTS, 'docs/stories');
  assert.equal(STATE_REF_PREFIX, 'refs/singularity/state/');
  assert.equal(DEFAULT_WORK_ITEM_ROOT, 'singularity/work-items');
  assert.equal(LOCATION_DEFAULT, DEFAULT_WORK_ITEM_ROOT);
  assert.equal(CONFIGURATION_SOURCE_RELATIVE, 'singularity/configuration-source.json');
  assert.equal(CONFIGURATION_SOURCE_RELATIVE, CONFIGURATION_SOURCE_PATH);
  assert.equal(stateRefName('W-1'), 'refs/singularity/state/W-1');
  assert.equal(stateRefName('W-1', { pinTransport: 'refs' }), 'refs/singularity/state/W-1');
  assert.equal(stateRefName('W-1', { pinTransport: 'branches' }), 'refs/heads/sflow/state/W-1');
});

test('storiesRoot keeps each of the four precedence orders the inline joins used', () => {
  const definition = { workItemRoot: 'defined/root' };
  const workflow = { workItem: { id: 'W-1' }, resolution: { workItemRoot: 'pinned/root' } };
  const unpinned = { workItem: { id: 'W-1' }, resolution: {} };
  const bare = { workItem: { id: 'W-1' } };
  const D = 'singularity/work-items';
  // 1. the definition's, else the default.
  assert.equal(storiesRoot(definition), definition.workItemRoot ?? D);
  assert.equal(storiesRoot({}), D);
  assert.equal(storiesRoot(undefined), D);
  assert.equal(storiesRoot(null), D);
  // 2. the Story's pinned value, else the default.
  assert.equal(storiesRoot(workflow), workflow.resolution?.workItemRoot ?? D);
  assert.equal(storiesRoot(unpinned), D);
  assert.equal(storiesRoot(bare), D);
  // 3. the pinned value, then the definition's, then the default; the sources disagree here.
  for (const [w, d] of [[workflow, definition], [unpinned, definition], [bare, {}], [workflow, {}]]) {
    assert.equal(storiesRoot(w, d), w.resolution?.workItemRoot ?? d.workItemRoot ?? D);
    assert.equal(storiesRoot([w, d]), w.resolution?.workItemRoot ?? d.workItemRoot ?? D);
    // 4. the definition's, then the pinned value, then the default.
    assert.equal(storiesRoot(d, w), d.workItemRoot ?? w.resolution?.workItemRoot ?? D);
  }
  // A null or undefined source is skipped, as `config?.workItemRoot ?? ...` skips it.
  assert.equal(storiesRoot(undefined, workflow), 'pinned/root');
  // storyLocation reads the sources in the caller's order.
  assert.equal(storyLocation('/r', [workflow, definition], 'W-1').prefix, 'pinned/root/W-1');
  assert.equal(storyLocation('/r', [definition, workflow], 'W-1').prefix, 'defined/root/W-1');
  assert.equal(storyLocation('/r', workflow, 'W-1').prefix, 'pinned/root/W-1');
  assert.equal(storiesDirectory('/r', definition), path.join('/r', 'defined/root'));
  assert.equal(storiesDirectory('/r', unpinned, definition), path.join('/r', 'defined/root'));
  assert.equal(storiesDirectory('/r'), path.join('/r', D));
});

test('both layouts agree with themselves: records, files, membership, documents and objects', () => {
  for (const layout of STORY_LAYOUTS) {
    for (const workItemRoot of ROOTS) {
      for (const id of IDS) {
        const at = storyLocation('/r', { workItemRoot }, id, { layout });
        for (const parts of [['workflow.json'], ['evidence', 'a.json'], ['gdp/implementation/x.json'], ['context', 'clarifications-a-gen1.json']]) {
          assert.equal(at.fromRecord(at.record(...parts)), at.file(...parts));
          assert.equal(at.owns(at.record(...parts)), layout === 'story-branch');
          assert.equal(at.inside(at.record(...parts)), path.posix.join(...parts));
          const object = at.object(...parts);
          assert.equal(object.path, at.record(...parts));
          assert.equal(object.revision, layout === 'state-ref' ? `refs/singularity/state/${id}` : null);
        }
        const document = at.document('artifacts/design/design.md');
        assert.equal(at.isDocument(document.relative), true);
        assert.equal(document.absolute, path.join('/r', document.relative));
        if (layout === 'state-ref') assert.equal(document.relative, at.checkoutPath('artifacts/design/design.md'));
      }
    }
  }
});

test('a Story keeps its layout: an explicit layout that contradicts the workflow\'s throws', () => {
  // The layout is recorded in resolution.story.storage; resolution.storage is the Story's document storage providers.
  const recorded = { workItem: { id: 'W-1' }, resolution: { workItemRoot: 'singularity/work-items', story: { storage: 'state-ref' } } };
  assert.equal(storyLocation('/r', { workItem: { id: 'W-1' }, resolution: { storage: { layout: 'state-ref' } } }, 'W-1').layout, 'story-branch');
  assert.equal(storyLocation('/r', recorded, 'W-1').layout, 'state-ref');
  assert.equal(storyLocation('/r', recorded, 'W-1', { layout: 'state-ref' }).layout, 'state-ref');
  assert.throws(() => storyLocation('/r', recorded, 'W-1', { layout: 'story-branch' }),
    (error) => error.name === 'SingularityFlowError' && error.code === 'STORY_LAYOUT_CHANGED');
  assert.throws(() => storyLocation('/r', {}, 'W-1', { layout: 'elsewhere' }),
    (error) => error.name === 'SingularityFlowError' && error.code === 'STORY_LAYOUT_UNKNOWN');
  // A resolution without storage is a story-branch Story: every Story in flight keeps today's layout.
  assert.equal(storyLocation('/r', { workItem: { id: 'W-1' }, resolution: {} }, 'W-1').layout, 'story-branch');
  assert.equal(storyLocation('/r', { workItem: { id: 'W-1' }, resolution: {} }, 'W-1', { layout: 'state-ref' }).layout, 'state-ref');
});

test('a layout seen on disk is remembered by checkout and Story; a workflow\'s own record wins', () => {
  forgetStoryLayouts();
  try {
    assert.equal(storyLocation('/r', {}, 'W-1').layout, 'story-branch');
    rememberStoryLayout('/r', 'W-1', 'state-ref');
    assert.equal(storyLocation('/r', {}, 'W-1').layout, 'state-ref');
    assert.equal(storyLocation('/r/', { workItemRoot: 'team/stories' }, 'W-1').workflowFile, '/r/.sflow-state/workflow.json');
    // Another checkout, or another Story, is not this one.
    assert.equal(storyLocation('/other', {}, 'W-1').layout, 'story-branch');
    assert.equal(storyLocation('/r', {}, 'W-2').layout, 'story-branch');
    // A record's spelling (no checkout) follows the Story while every checkout agrees.
    assert.equal(storyLocation(null, {}, 'W-1').record('workflow.json'), 'workflow.json');
    rememberStoryLayout('/other', 'W-1', 'story-branch');
    assert.equal(storyLocation(null, {}, 'W-1').layout, 'story-branch');
    // A workflow's resolution is the Story's own record: without a layout it is story-branch.
    assert.equal(storyLocation('/r', { workItem: { id: 'W-1' }, resolution: {} }, 'W-1').layout, 'story-branch');
    assert.equal(storyLocation('/r', { workItem: { id: 'W-1' } }, 'W-1').layout, 'state-ref');
    rememberStoryLayout('/r', 'W-1', null);
    assert.equal(storyLocation('/r', {}, 'W-1').layout, 'story-branch');
    assert.throws(() => rememberStoryLayout('/r', 'W-1', 'elsewhere'), (error) => error.code === 'STORY_LAYOUT_UNKNOWN');
  } finally { forgetStoryLayouts(); }
  assert.equal(stateTrackingRefName('origin', 'W-1'), 'refs/singularity/remotes/origin/state/W-1');
});

test('record-path classifiers find the Story and the path inside it', () => {
  assert.deepEqual(storyRecordOf('singularity/work-items/W-1/gdp/x.json'), { id: 'W-1', inside: 'gdp/x.json' });
  assert.deepEqual(storyRecordOf('singularity/work-items/W-1'), { id: 'W-1', inside: '' });
  assert.equal(storyRecordOf('singularity/work-items/'), null);
  assert.equal(storyRecordOf('singularity/work-itemsX/W-1/a'), null);
  assert.equal(storyRecordOf('src/a.mjs'), null);
  assert.equal(storyRecordOf(undefined), null);
  assert.equal(storyIdOfRecord('team/stories/S.1/workflow.json', { workItemRoot: 'team/stories' }), 'S.1');
  assert.equal(storyIdOfRecord('singularity/work-items/S.1/workflow.json', { workItemRoot: 'team/stories' }), null);
  assert.equal(isStoryRecordPath('singularity/work-items/W-1/workflow.json'), true);
  assert.equal(isStoryRecordPath('singularity/workflow.yml'), false);
  // Below another folder, as the old `(^|\/)singularity\/work-items\/` patterns matched.
  for (const [recorded, expected] of [
    ['singularity/work-items/W-1/workflow.json', { id: 'W-1', inside: 'workflow.json' }],
    ['member/singularity/work-items/W-1/context/claims/a.json', { id: 'W-1', inside: 'context/claims/a.json' }],
    ['member/xsingularity/work-items/W-1/workflow.json', null], ['src/a.mjs', null], [null, null]]) {
    assert.deepEqual(storyRecordWithin(recorded), expected, String(recorded));
    if (typeof recorded === 'string') {
      assert.equal(/(^|\/)singularity\/work-items\/[^/]+\/workflow\.json$/u.test(recorded), expected?.inside === 'workflow.json');
    }
  }
});

test('the location helpers delegate and keep their answers', () => {
  for (const workItemRoot of ROOTS) {
    for (const id of IDS) {
      const base = workItemRoot ?? 'singularity/work-items';
      assert.equal(workItemWorkflowRelative(id, workItemRoot), path.posix.join(base, id, 'workflow.json'));
      const workflow = { workItem: { id } };
      for (const phase of [{ id: 'intake', generation: 0 }, { id: 'repair', generation: 1, generationHighWatermark: 4 }]) {
        const next = phase.generationHighWatermark ? 5 : 1;
        assert.equal(groundingRecordRelative({ workItemRoot }, workflow, phase),
          `${base}/${id}/context/${phase.id}-gen${next}.json`);
        assert.equal(clarificationRecordRelative({ workItemRoot }, workflow, phase, 3),
          `${base}/${id}/context/clarifications-${phase.id}-gen3.json`);
      }
    }
  }
});

test('story-paths.mjs stays a leaf: it imports node:path and util.mjs only', async () => {
  const source = await readFile(new URL('../src/story-paths.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+'([^']+)'/gmu), ...source.matchAll(/import\(\s*'([^']+)'\s*\)/gu)]
    .map((match) => match[1]).sort();
  assert.deepEqual(imports, ['./util.mjs', 'node:path']);
});
