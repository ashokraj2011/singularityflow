import assert from 'node:assert/strict';
import test from 'node:test';
import { EDITOR_MINIMUM_NODE_MAJOR, MINIMUM_NODE_MAJOR, nodeRequirement } from '../src/node-requirement.mjs';

test('a shell or installed engine needs Node 26; VS Code runs its bundled engine on its own Node', () => {
  assert.equal(MINIMUM_NODE_MAJOR, 26);
  assert.deepEqual(nodeRequirement({ node: '26.12.0' }), { version: '26.12.0', major: 26, minimum: 26, editor: false, met: true });
  // Node 22.12 to 22.16 report device 0 for a path stat on Windows 11 24H2; 24 is below the line too.
  for (const node of ['24.22.1', '22.14.0', '20.20.2']) assert.equal(nodeRequirement({ node }).met, false, node);
  assert.deepEqual(nodeRequirement({ node: '24.22.1', electron: '43.8.3' }),
    { version: '24.22.1', major: 24, minimum: EDITOR_MINIMUM_NODE_MAJOR, editor: true, met: true });
  assert.equal(nodeRequirement({ node: '18.20.8', electron: '28.3.3' }).met, false);
  assert.equal(nodeRequirement({}).met, false);
});
