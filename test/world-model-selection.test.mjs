/**
 * Which world-model content a phase receives, and at which tier.
 *
 * Both decisions were previously invisible and unconfigurable, and together they put 38 KB of
 * grounding into a 67 KB prompt on a thirty-three-file repository.
 *
 * The tier is the sharper of the two. Every view is generated twice — `views/<v>.md` and
 * `views/<v>.brief.md` — and `validateWorldModelDirectory` *rejects* a v2 manifest whose view is
 * missing its `brief_path`. So the brief was mandatory to produce and impossible to consume: the
 * reader took `manifest.views[view].path` unconditionally, and `depth` only flavoured the builder's
 * prompt. Two phases asking for the same view at `quick` and at `deep` received identical bytes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_VIEW_MODES, corePath, resolveViews, tierForCore, tierForView, viewPath
} from '../src/world-model-selection.mjs';

const MANIFEST = {
  core: { summary: 'core/summary.md', brief: 'core/summary.brief.md' },
  views: {
    architecture: { path: 'views/architecture.md', brief_path: 'views/architecture.brief.md' },
    security: { path: 'views/security.md', brief_path: 'views/security.brief.md' },
    legacy: { path: 'views/legacy.md' }
  }
};

test('a phase that declares its own views is not given the agent’s as well', () => {
  // The POC's verification phase declared [testing, development, security]; the developer agent
  // declared development,testing,architecture; the phase received four views and nothing said so.
  const resolved = resolveViews(['testing'], ['development', 'architecture']);
  assert.deepEqual(resolved.views, ['testing']);
  assert.equal(resolved.origin.get('testing'), 'phase');
});

test('a phase that declares nothing falls back to the agent’s views', () => {
  const resolved = resolveViews([], ['development', 'architecture']);
  assert.deepEqual(resolved.views, ['development', 'architecture']);
  assert.equal(resolved.origin.get('development'), 'agent');
});

test('union mode is still available, and records where each view came from', () => {
  const resolved = resolveViews(['testing'], ['testing', 'architecture'], { mode: 'union' });
  assert.deepEqual(resolved.views, ['testing', 'architecture']);
  assert.equal(resolved.origin.get('testing'), 'phase+agent');
  assert.equal(resolved.origin.get('architecture'), 'agent');
});

test('an unknown agent-view mode is refused rather than silently ignored', () => {
  assert.throws(() => resolveViews([], [], { mode: 'everything' }), /must be one of/);
  assert.deepEqual([...AGENT_VIEW_MODES], ['fallback', 'union']);
});

test('depth decides the tier, which is the whole point of declaring it', () => {
  const declared = ['architecture', 'security'];
  // light and quick: the phase has said it does not need the detail.
  for (const depth of ['light', 'quick']) {
    assert.equal(tierForView('architecture', { depth, declared }), 'brief');
    assert.equal(tierForCore(depth), 'brief');
  }
  // deep: it has said it does.
  assert.equal(tierForView('security', { depth: 'deep', declared }), 'full');
  assert.equal(tierForCore('deep'), 'full');
});

test('at standard depth the phase’s subject is full and the rest is orientation', () => {
  const declared = ['architecture', 'security'];
  assert.equal(tierForView('architecture', { depth: 'standard', declared }), 'full');
  assert.equal(tierForView('security', { depth: 'standard', declared }), 'brief');
  assert.equal(tierForCore('standard'), 'brief');
});

test('a view added by an agent is never the subject', () => {
  // `declared` is the phase's own list, so an agent-contributed view cannot claim the full tier.
  assert.equal(tierForView('development', { depth: 'standard', declared: ['testing'] }), 'brief');
});

test('a manifest without a brief falls back to the full text rather than failing', () => {
  // v1 manifests predate the tier, and a view may legitimately be ungenerated. A phase should not
  // fail over a tier that did not exist when its model was built.
  assert.equal(viewPath(MANIFEST, 'legacy', 'brief'), 'views/legacy.md');
  assert.equal(viewPath(MANIFEST, 'architecture', 'brief'), 'views/architecture.brief.md');
  assert.equal(viewPath(MANIFEST, 'architecture', 'full'), 'views/architecture.md');
  assert.equal(viewPath(MANIFEST, 'absent', 'brief'), null);
  assert.equal(corePath({ core: {} }, 'brief'), 'core/summary.md');
  assert.equal(corePath(MANIFEST, 'brief'), 'core/summary.brief.md');
});
