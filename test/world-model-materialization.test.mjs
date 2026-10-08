import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticMaterializationDecision, effectiveMaterializationPolicy, materializationPolicy } from '../src/world-model-materialization.mjs';

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
