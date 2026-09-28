/**
 * The distribution installer probes the installed CLI with the PATH the person launched it with,
 * not the one npm exec gave it, which starts with the candidate package's own executables.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { restoreDistributionOriginPath } from '../src/distribution-origin-path.mjs';

test('a bootstrapped installer restores the launching PATH, in whichever spelling the platform uses', () => {
  const candidateFirst = '/cache/_npx/1a2b/node_modules/.bin:/usr/local/bin:/usr/bin';
  const posix = {
    PATH: candidateFirst, SINGULARITY_FLOW_DISTRIBUTION_BOOTSTRAPPED: '1',
    SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_PATH: '/usr/local/bin:/usr/bin'
  };
  assert.equal(restoreDistributionOriginPath(posix), true);
  assert.equal(posix.PATH, '/usr/local/bin:/usr/bin');

  const windows = {
    Path: 'C:\\cache\\_npx\\1a2b\\node_modules\\.bin;C:\\npm', SINGULARITY_FLOW_DISTRIBUTION_BOOTSTRAPPED: '1',
    SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_PATH: 'C:\\npm'
  };
  assert.equal(restoreDistributionOriginPath(windows), true);
  assert.deepEqual(Object.keys(windows).filter((key) => key.toUpperCase() === 'PATH'), ['Path']);
  assert.equal(windows.Path, 'C:\\npm');

  const direct = { PATH: candidateFirst, SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_PATH: '/usr/bin' };
  assert.equal(restoreDistributionOriginPath(direct), false, 'only the release bootstrap supplies an origin PATH');
  assert.equal(direct.PATH, candidateFirst);
  const empty = { PATH: candidateFirst, SINGULARITY_FLOW_DISTRIBUTION_BOOTSTRAPPED: '1', SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_PATH: '' };
  assert.equal(restoreDistributionOriginPath(empty), false);
  assert.equal(empty.PATH, candidateFirst);
});
