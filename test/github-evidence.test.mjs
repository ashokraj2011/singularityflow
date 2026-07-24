import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGitHubEvidence, parseGitHubRemote } from '../src/github-evidence.mjs';

test('GitHub remotes normalize SSH and HTTPS without accepting unrelated URLs', () => {
  assert.deepEqual(parseGitHubRemote('git@github.com:company/mobile.git'), {
    host: 'github.com',
    owner: 'company',
    repository: 'mobile',
    slug: 'company/mobile'
  });
  assert.equal(parseGitHubRemote('https://github.example.com/company/api.git').slug, 'company/api');
  assert.throws(() => parseGitHubRemote('https://github.example.com/company/group/repo.git'), /not a supported GitHub repository URL/);
});

test('GitHub review evidence binds required Actions and PR observations to the exact submitted SHA', () => {
  const submitted = 'a'.repeat(40);
  const calls = [];
  const runCommand = (_command, args) => {
    calls.push(args);
    if (args[0] === 'auth') return { status: 0, stdout: '', stderr: '' };
    if (args.join(' ').includes('check-runs')) {
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          check_runs: [
            { id: 1, name: 'build', status: 'completed', conclusion: 'success', head_sha: submitted },
            { id: 2, name: 'security', status: 'completed', conclusion: 'failure', head_sha: submitted }
          ]
        })
      };
    }
    return {
      status: 0,
      stderr: '',
      stdout: JSON.stringify([{
        number: 17,
        state: 'open',
        merged_at: null,
        head: { sha: submitted },
        base: { ref: 'MOB-123' },
        html_url: 'https://github.com/company/mobile/pull/17'
      }])
    };
  };
  const evidence = collectGitHubEvidence('/tmp', {
    remote: 'git@github.com:company/mobile.git',
    commit: submitted,
    submittedBranch: 'feature/login-ui',
    canonicalBranch: 'MOB-123',
    requiredChecks: ['build', 'security', 'conformance'],
    runCommand
  });
  assert.equal(evidence.commit, submitted);
  assert.equal(evidence.ready, false);
  assert.deepEqual(evidence.required.map(({ name, status }) => [name, status]), [
    ['build', 'passed'],
    ['security', 'failed'],
    ['conformance', 'missing']
  ]);
  assert.equal(evidence.pullRequests[0].headSha, submitted);
  assert.ok(calls.some((args) => args.join(' ').includes(`/commits/${submitted}/check-runs`)));
});
