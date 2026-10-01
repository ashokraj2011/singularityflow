import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getGitHubIssue, normalizeWorkSource, parseGitHubIssueReference
} from '../src/work-source.mjs';

const GITHUB_HOST = ['github', 'com'].join('.');
const githubUrl = (pathname) => `https://${GITHUB_HOST}${pathname}`;

test('GitHub Issue references normalize to one immutable source identity', async () => {
  assert.deepEqual(parseGitHubIssueReference('acme/payments#42'), {
    raw: 'acme/payments#42', host: GITHUB_HOST, owner: 'acme', repository: 'payments', number: 42
  });
  const calls = [];
  const issue = await getGitHubIssue(githubUrl('/Acme/Payments/issues/42?ignored=yes'), {
    fetchedAt: '2026-08-21T00:00:00.000Z',
    runCommand(command, args) {
      calls.push([command, args]);
      return {
        status: 0, stderr: '', stdout: JSON.stringify({
          id: 10042, number: 42, title: 'Retry failed checkout',
          body: '## Acceptance\n- [ ] retries once\n- [x] records the final failure',
          html_url: githubUrl('/Acme/Payments/issues/42?notification=1'),
          labels: [{ name: 'bug' }, { name: 'checkout' }]
        })
      };
    }
  });
  assert.deepEqual(calls[0], ['gh', ['api', '--hostname', GITHUB_HOST, 'repos/Acme/Payments/issues/42']]);
  assert.equal(issue.stableId, `github-issue:${GITHUB_HOST}/acme/payments#42`);
  assert.equal(issue.url, githubUrl('/Acme/Payments/issues/42'));
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

test('a Jira source keeps what fetches its attachments, and nothing else gains a field or a new digest', () => {
  const issue = { type: 'jira', id: '7', key: 'PAY-7', title: 'Pay', url: 'https://jira.example.com/browse/PAY-7' };
  const source = normalizeWorkSource({ ...issue, attachments: [
    { id: '1', filename: 'brief.pdf', mimeType: 'application/pdf', size: 10, createdAt: '2026-09-30T10:00:00.000+0000', author: 'Someone', url: 'https://jira.example.com/rest/api/3/attachment/content/1?token=x' },
    { id: '2', filename: 'leak.txt', url: 'https://user:pass@jira.example.com/rest/api/3/attachment/content/2' },
    { id: null, filename: 'no-id.txt', url: 'https://jira.example.com/rest/api/3/attachment/content/3' }
  ] });
  assert.deepEqual(source.attachments, [{
    id: '1', filename: 'brief.pdf', mimeType: 'application/pdf', size: 10,
    createdAt: '2026-09-30T10:00:00.000+0000', url: 'https://jira.example.com/rest/api/3/attachment/content/1'
  }]);
  assert.doesNotMatch(JSON.stringify(source), /Someone|token=x|user:pass/);
  assert.equal(normalizeWorkSource({ ...issue, attachments: [] }).contentSha256, normalizeWorkSource(issue).contentSha256);
  assert.equal('attachments' in normalizeWorkSource(issue), false);
  assert.equal('attachments' in normalizeWorkSource({ type: 'manual', title: 'x', attachments: source.attachments }), false);
});
