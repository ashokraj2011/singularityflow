import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addPortfolioRepository,
  repositoryMetadataFromForm
} from '../apps/desktop/src/portfolio-designer.mjs';

test('portfolio designer adds application identity and arbitrary repository metadata', () => {
  const portfolio = { version: 1, repositories: {} };
  const next = addPortfolioRepository(portfolio, {
    id: 'mobile',
    url: 'git@github.com:company/mobile.git',
    defaultBranch: 'develop',
    required: true,
    appId: 'APP-1001',
    name: 'Mobile application',
    metadata: [
      { key: 'owner', value: 'Digital Channels' },
      { key: 'costCenter', value: 'CC-42' }
    ]
  });
  assert.deepEqual(next.repositories.mobile, {
    url: 'git@github.com:company/mobile.git',
    defaultBranch: 'develop',
    required: true,
    metadata: {
      appId: 'APP-1001',
      name: 'Mobile application',
      owner: 'Digital Channels',
      costCenter: 'CC-42'
    }
  });
  assert.deepEqual(portfolio.repositories, {});
});

test('portfolio designer rejects duplicate, empty, and unsafe metadata fields', () => {
  assert.throws(
    () => repositoryMetadataFromForm({ appId: 'APP-1', metadata: [{ key: 'appId', value: 'APP-2' }] }),
    /duplicated/
  );
  assert.throws(
    () => repositoryMetadataFromForm({ metadata: [{ key: 'owner', value: '' }] }),
    /requires a value/
  );
  assert.throws(
    () => repositoryMetadataFromForm({ metadata: [{ key: '../owner', value: 'team' }] }),
    /Metadata keys/
  );
});
