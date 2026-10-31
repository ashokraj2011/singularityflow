import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EDITOR_MINIMUM_NODE_MAJOR, MINIMUM_NODE_MAJOR, SUPPORTED_NODE_LTS_MAJORS, nodeRequirement, nodeVersionProblem
} from '../src/node-requirement.mjs';

test('a shell or installed engine runs on the LTS lines 22 and 26; VS Code runs its bundled engine on its own Node', () => {
  assert.equal(MINIMUM_NODE_MAJOR, 22);
  assert.deepEqual(SUPPORTED_NODE_LTS_MAJORS, [22, 26]);
  assert.deepEqual(nodeRequirement({ node: '26.12.0' }, 'linux'),
    { version: '26.12.0', major: 26, minimum: 22, editor: false, met: true, required: '22 or newer' });
  for (const node of ['22.0.0', '22.14.0', '22.17.0', '24.22.1', '26.12.0']) assert.equal(nodeRequirement({ node }, 'darwin').met, true, node);
  for (const node of ['20.20.2', '21.7.3']) assert.equal(nodeRequirement({ node }, 'linux').met, false, node);
  assert.equal(nodeRequirement({}, 'linux').met, false);
});

test('on Windows a Node 22 must be 22.17 or newer and Node 23 is refused: their path stat reports device 0', () => {
  // Node 22.12 to 22.16 and 23 report device 0 for a path stat on Windows 11 24H2 and Windows Server 2025.
  for (const node of ['22.14.0', '22.16.0', '23.11.1']) {
    assert.equal(nodeRequirement({ node }, 'win32').met, false, node);
    assert.equal(nodeVersionProblem(node, 'win32'), `Node.js 22.17 or newer (not 23) is required; found ${node}.`);
  }
  for (const node of ['22.17.0', '22.23.1', '24.22.1', '26.12.0']) assert.equal(nodeRequirement({ node }, 'win32').met, true, node);
  assert.equal(nodeRequirement({ node: '22.14.0' }, 'win32').required, '22.17 or newer (not 23)');
  assert.match(nodeVersionProblem('unknown', 'linux'), /Could not determine the Node\.js version from 'unknown'/u);
});

test('VS Code keeps the floor of the VS Code releases the extension supports', () => {
  assert.deepEqual(nodeRequirement({ node: '24.22.1', electron: '43.8.3' }, 'win32'),
    { version: '24.22.1', major: 24, minimum: EDITOR_MINIMUM_NODE_MAJOR, editor: true, met: true, required: '20 or newer' });
  assert.equal(nodeRequirement({ node: '22.14.0', electron: '39.2.0' }, 'win32').met, true, 'VS Code\'s own Node is its own');
  assert.equal(nodeRequirement({ node: '18.20.8', electron: '28.3.3' }, 'linux').met, false);
});
