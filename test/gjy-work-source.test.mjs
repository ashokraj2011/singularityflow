import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getGitHubIssue, normalizeWorkSource, parseGitHubIssueReference
} from '../src/work-source.mjs';

test('GitHub Issue references normalize to one immutable source identity', async () => {
  assert.deepEqual(parseGitHubIssueReference('acme/payments#42'), {
    raw: 'acme/payments#42', host: 'github.com', owner: 'acme', repository: 'payments', number: 42
  });
  const calls = [];
  const issue = await getGitHubIssue('https://github.com/Acme/Payments/issues/42?ignored=yes', {
    fetchedAt: '2026-08-21T00:00:00.000Z',
    runCommand(command, args) {
      calls.push([command, args]);
      return {
        status: 0, stderr: '', stdout: JSON.stringify({
          id: 10042, number: 42, title: 'Retry failed checkout',
          body: '## Acceptance\n- [ ] retries once\n- [x] records the final failure',
          html_url: 'https://github.com/Acme/Payments/issues/42?notification=1',
          labels: [{ name: 'bug' }, { name: 'checkout' }]
        })
      };
    }
  });
  assert.deepEqual(calls[0], ['gh', ['api', '--hostname', 'github.com', 'repos/Acme/Payments/issues/42']]);
  assert.equal(issue.stableId, 'github-issue:github.com/acme/payments#42');
  assert.equal(issue.url, 'https://github.com/Acme/Payments/issues/42');
  assert.deepEqual(issue.acceptanceCriteria, ['retries once', 'records the final failure']);
  assert.match(issue.contentSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(issue), /notification=1/);
});

test('Jira source generations keep stable identity while content hashes change', () => {
  const first = normalizeWorkSource({
    type: 'jira', id: '10042', key: 'PAY-42', url: 'https://jira.example.com/browse/PAY-42',
    title: 'Retry checkout', description: 'First wording'
  });
  const second = normalizeWorkSource({
    type: 'jira', id: '10042', key: 'PAY-99', url: 'https://jira.example.com/browse/PAY-99',
    title: 'Retry checkout', description: 'Updated wording'
  });
  assert.equal(first.stableId, second.stableId);
  assert.notEqual(first.contentSha256, second.contentSha256);
});

test('normalization never copies credentials or opaque provider payloads', () => {
  const source = normalizeWorkSource({
    type: 'manual', id: 'WRK-1', title: 'Safe source', description: 'Visible',
    token: 'secret-token', access_token: 'oauth-secret', headers: { authorization: 'Bearer secret' },
    customProviderPayload: { secret: 'not-governed' },
    scope: { in: ['checkout'], out: ['billing'] },
    risk: 'low', repositoryCount: 2, publicInterfaceChange: false, crossRepositoryChange: true
  });
  const serialized = JSON.stringify(source);
  assert.doesNotMatch(serialized, /secret-token|oauth-secret|Bearer secret|not-governed/);
  assert.deepEqual(source.scope, { in: ['checkout'], out: ['billing'] });
  assert.equal(source.risk, 'low');
  assert.equal(source.repositoryCount, 2);
  assert.equal(source.publicInterfaceChange, false);
  assert.equal(source.crossRepositoryChange, true);
  assert.deepEqual(normalizeWorkSource({
    type: 'manual', title: 'Array contract', acceptanceCriteria: '- first\n- second'
  }).acceptanceCriteria, ['first', 'second']);
});

test('GitHub source failures are bounded and happen before lifecycle mutation', async () => {
  await assert.rejects(
    () => getGitHubIssue('acme/payments#42', {
      runCommand: () => ({ status: 1, stdout: '', stderr: 'authentication required' })
    }),
    (error) => error.code === 'GITHUB_ISSUE_UNAVAILABLE' && /authentication required/.test(error.message)
  );
});
