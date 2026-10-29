import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGitHubEvidence, parseGitHubRemote } from '../src/github-evidence.mjs';

test('GitHub remotes normalize SSH and HTTPS without accepting unrelated URLs', () => {
  assert.deepEqual(parseGitHubRemote('git@git.example.invalid:company/mobile.git'), {
    host: 'git.example.invalid',
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
        html_url: 'https://git.example.invalid/company/mobile/pull/17'
      }])
    };
  };
  const evidence = collectGitHubEvidence('/tmp', {
    remote: 'git@git.example.invalid:company/mobile.git',
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

// A remote through an SSH host alias (git@github-work:…) named the alias in `gh auth login
// --hostname github-work`, which gh cannot sign in to (2026-10-29).
test('an SSH host alias is resolved to its real host before gh is asked or suggested', async () => {
  const { githubAuthStatus, resolveGitHubSshHost, parseGitHubRemote } = await import('../src/github-evidence.mjs');
  const calls = [];
  const fake = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'ssh') return { status: 0, stdout: 'user git\nhostname ghe.example.test\nport 22\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'not logged in' };
  };
  const remote = 'git@github-work:acme/app.git';
  assert.deepEqual(resolveGitHubSshHost('.', remote, parseGitHubRemote(remote), { runCommand: fake }),
    { host: 'ghe.example.test', owner: 'acme', repository: 'app', slug: 'acme/app', alias: 'github-work' });
  assert.throws(() => githubAuthStatus('.', remote, { runCommand: fake }),
    /not authenticated for ghe\.example\.test \(the SSH alias github-work\)\. Run gh auth login --hostname ghe\.example\.test\./u);
  assert.deepEqual(calls.find(([command]) => command === 'gh'), ['gh', 'auth', 'status', '--hostname', 'ghe.example.test']);
  // An HTTPS remote never runs ssh.
  calls.length = 0;
  resolveGitHubSshHost('.', 'https://ghe.example.test/acme/app.git', parseGitHubRemote('https://ghe.example.test/acme/app.git'), { runCommand: fake });
  assert.equal(calls.length, 0);
});
