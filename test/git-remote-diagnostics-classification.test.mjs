import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  REMOTE_FAILURE_CLASSES, assertCredentialFreeRemote, classifyGitRemoteFailure, failureEvidence,
  probeGitRemote, redactDiagnosticText, sanitizeRemote
} from '../src/git-remote-diagnostics.mjs';
import { runRemoteGit, runRemoteGitAsync } from '../src/git-execution.mjs';

const failed = (stderr, extra = {}) => ({
  status: 128,
  stdout: '',
  stderr,
  timedOut: false,
  blocked: false,
  ...extra
});

const classificationCases = [
  {
    name: 'Git Credential Manager cannot open a non-interactive prompt',
    result: failed('fatal: Cannot prompt because user interactivity has been disabled.'),
    classification: 'authentication-required',
    advice: /Sign in to Git/
  },
  {
    name: 'Git terminal prompts are disabled',
    result: failed("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    classification: 'authentication-required',
    advice: /credential helper/
  },
  {
    name: 'Git cannot read a password without a prompt',
    result: failed("fatal: could not read Password for 'https://example.com': No such device or address"),
    classification: 'authentication-required',
    advice: /Sign in to Git/
  },
  {
    name: 'GitHub rejects an invalid username or token',
    result: failed('remote: Invalid username or token. Password authentication is not supported for Git operations.'),
    classification: 'authentication-required',
    advice: /Sign in to Git/
  },
  {
    name: 'GitHub reports removal of password authentication',
    result: failed('remote: Support for password authentication was removed. Please use a personal access token instead.'),
    classification: 'authentication-required',
    advice: /Do not put a token in the URL/
  },
  {
    name: 'GitLab reports an invalid HTTP Basic credential',
    result: failed('remote: HTTP Basic: Access denied. The provided password or token is incorrect or expired.'),
    classification: 'authentication-required',
    advice: /Sign in to Git/
  },
  {
    name: 'SSH has no accepted authentication method',
    result: failed('git@example.com: Permission denied (publickey,password).'),
    classification: 'authentication-required',
    advice: /Sign in to Git/
  },
  {
    name: 'GitHub SAML SSO requires an authorized credential',
    result: failed("remote: The 'acme' organization has enabled or enforced SAML SSO. Your token must be authorized."),
    classification: 'sso-authorization-required',
    advice: /re-authorize.+SSO/i
  },
  {
    name: 'GitHub SAML enforcement protects the resource',
    result: failed('remote: Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.'),
    classification: 'sso-authorization-required',
    advice: /organisation's SSO/
  },
  {
    name: 'provider requires single sign-on authorization',
    result: failed('Access denied: single sign-on authorization is required for this repository.'),
    classification: 'sso-authorization-required',
    advice: /Authorize or re-authorize/
  },
  {
    name: 'configured credential-manager command is missing',
    result: failed("git: 'credential-manager-core' is not a git command. See 'git --help'.\nfatal: could not read Username: terminal prompts disabled"),
    classification: 'credential-helper-unavailable',
    advice: /Install or repair/
  },
  {
    name: 'configured credential helper cannot be spawned',
    result: failed('error: cannot spawn git-credential-manager.exe: No such file or directory'),
    classification: 'credential-helper-unavailable',
    advice: /credential helper/
  },
  {
    name: 'credential manager runtime is missing',
    result: failed('Git Credential Manager\nYou must install or update .NET to run this application.'),
    classification: 'credential-helper-unavailable',
    advice: /sign in and retry/
  },
  {
    name: 'spawn reports that Git itself is missing',
    result: failed('', { error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }),
    classification: 'git-unavailable',
    advice: /Install Git/
  },
  {
    name: 'Windows cannot resolve Git from PATH',
    result: failed('', { error: new TypeError('Windows could not resolve git from PATH.') }),
    classification: 'git-unavailable',
    advice: /restart the calling application/
  },
  {
    name: 'an authenticated identity lacks repository permission',
    result: failed('remote: Write access to repository not granted. fatal: unable to access: HTTP 403'),
    classification: 'authorization-denied',
    advice: /repository owner/
  },
  {
    name: 'a provider reports an exhausted rate limit with HTTP 403',
    result: failed('remote: API rate limit exceeded. fatal: unable to access: HTTP 403'),
    classification: 'rate-limited',
    advice: /limit to reset/
  },
  {
    name: 'an office CONNECT proxy requires authentication',
    result: failed('fatal: unable to access repository: Received HTTP code 407 from proxy after CONNECT'),
    classification: 'proxy-configuration',
    advice: /proxy configuration/
  },
  {
    name: 'Windows Schannel cannot establish certificate trust',
    result: failed('fatal: unable to access repository: schannel: SEC_E_UNTRUSTED_ROOT'),
    classification: 'tls-trust',
    advice: /trust chain/
  },
  {
    name: 'office DNS cannot resolve the Git host',
    result: failed('fatal: unable to access repository: Could not resolve host: github.com'),
    classification: 'network-transient',
    advice: /DNS/
  },
  {
    name: 'the supervised Git operation reaches its deadline without diagnostic text',
    result: failed('', { timedOut: true }),
    classification: 'network-transient',
    advice: /network reachability/
  },
  {
    name: 'the remote repository does not exist for this identity',
    result: failed("fatal: repository 'https://github.com/acme/missing.git/' not found"),
    classification: 'remote-not-found',
    advice: /repository URL/
  }
];

const retryableOfficeClasses = new Set([
  'authentication-required', 'sso-authorization-required',
  'credential-helper-unavailable', 'git-unavailable', 'network-transient',
  'proxy-configuration', 'rate-limited', 'tls-trust', 'working-directory-unavailable'
]);

test('office Git failures have precise, actionable classifications', async (t) => {
  for (const example of classificationCases) {
    await t.test(example.name, () => {
      const failure = classifyGitRemoteFailure(example.result);
      assert.equal(failure.classification, example.classification);
      assert.equal(failure.code, `REMOTE_${example.classification.replaceAll('-', '_').toUpperCase()}`);
      assert.match(failure.advice, example.advice);
      assert.ok(REMOTE_FAILURE_CLASSES.includes(example.classification));
      assert.equal(failure.retryable, retryableOfficeClasses.has(example.classification));
    });
  }
});

test('office classifications win over less specific trailing Git errors', () => {
  const helperThenPrompt = classifyGitRemoteFailure(failed([
    "git: 'credential-manager' is not a git command. See 'git --help'.",
    'fatal: Cannot prompt because user interactivity has been disabled.'
  ].join('\n')));
  assert.equal(helperThenPrompt.classification, 'credential-helper-unavailable');

  const ssoThen403 = classifyGitRemoteFailure(failed([
    "remote: The 'acme' organization has enabled SAML SSO.",
    'fatal: unable to access repository: The requested URL returned error: 403'
  ].join('\n')));
  assert.equal(ssoThen403.classification, 'sso-authorization-required');
});

test('provider-controlled helper and organisation names do not override structural failures', () => {
  for (const helper of ['credential-rate-limit', 'credential-tls']) {
    const failure = classifyGitRemoteFailure(failed(
      `git: '${helper}' is not a git command. See 'git --help'.`
    ));
    assert.equal(failure.classification, 'credential-helper-unavailable', helper);
  }

  for (const organisation of ['rate-limit', 'tls']) {
    const failure = classifyGitRemoteFailure(failed(
      `remote: The '${organisation}' organization has enabled SAML SSO. Your token must be authorized.`
    ));
    assert.equal(failure.classification, 'sso-authorization-required', organisation);
  }

  for (const repository of ['rate-limit', 'tls']) {
    const failure = classifyGitRemoteFailure(failed([
      `remote: Permission to acme/${repository}.git denied to alice.`,
      `fatal: unable to access 'https://github.com/acme/${repository}.git/': The requested URL returned error: 403`
    ].join('\n')));
    assert.equal(failure.classification, 'authorization-denied', repository);
  }

  for (const hostname of ['rate-limit', 'tls']) {
    const failure = classifyGitRemoteFailure(failed(
      `git@${hostname}: Permission denied (publickey,password).`
    ));
    assert.equal(failure.classification, 'authentication-required', hostname);
  }
});

test('diagnostic words inside repository names do not change a not-found classification', () => {
  for (const repository of [
    'offline', 'saml', 'requires-saml', 'saml-required', 'single-sign-on',
    'single-sign-on-authorization', 'sso-required', 'git-credential-manager',
    'credential-helper-not-found'
  ]) {
    const failure = classifyGitRemoteFailure(failed(
      `fatal: repository 'https://github.com/acme/${repository}.git/' not found`
    ));
    assert.equal(failure.classification, 'remote-not-found', repository);
    assert.equal(failure.retryable, false, repository);
  }
  for (const repository of [
    'spawn git ENOENT', 'credential helper not found', 'enterprise enabled saml',
    'ssl certificate', 'rate limit', "x' spawn git ENOENT", 'x" credential helper not found'
  ]) {
    const failure = classifyGitRemoteFailure(failed(
      `fatal: '/tmp/${repository}.git' does not appear to be a git repository`
    ));
    assert.equal(failure.classification, 'remote-not-found', repository);
    assert.equal(failure.retryable, false, repository);
  }
});

test('diagnostic words inside missing branch names remain branch-not-found', () => {
  for (const branch of ['rate-limit', 'tls', 'ssl-certificate', 'saml-sso']) {
    const failure = classifyGitRemoteFailure(failed(
      `fatal: couldn't find remote ref refs/heads/${branch}`
    ));
    assert.equal(failure.classification, 'branch-not-found', branch);
    assert.equal(failure.retryable, false, branch);
  }
});

test('diagnostic words inside quoted Git URL paths remain data', () => {
  const tlsPath = classifyGitRemoteFailure(failed(
    "fatal: unable to access 'https://github.com/acme/O'Brien/tls-client.git/': Failed to connect to github.com"
  ));
  assert.equal(tlsPath.classification, 'network-transient');

  const ratePath = classifyGitRemoteFailure(failed(
    "fatal: could not read Username for 'https://github.com/acme/O'Brien/rate-limit.git': terminal prompts disabled"
  ));
  assert.equal(ratePath.classification, 'authentication-required');
});

test('canonical HTTP status diagnostics remain classified after remote operands are scrubbed', () => {
  for (const [status, classification] of [
    [401, 'authentication-required'],
    [403, 'authorization-denied'],
    [407, 'proxy-configuration'],
    [429, 'rate-limited']
  ]) {
    const failure = classifyGitRemoteFailure(failed(
      `fatal: unable to access 'https://example.test/repository.git/': The requested URL returned error: ${status}`
    ));
    assert.equal(failure.classification, classification, String(status));
  }
});

test('embedded credential URLs inside path-form remotes are rejected at the trust boundary', () => {
  for (const remote of [
    './https://alice:LEAKMARK@example.test/repo',
    '/tmp/https://alice:LEAKMARK@example.test/repo',
    'safe/ssh://alice:LEAKMARK@example.test/repo',
    './git+ssh://alice%3ALEAKMARK@example.test/repo',
    '/tmp/alice:LEAKMARK@example.test/repo',
    './https://PRIVATEUSER@example.test/repo',
    '/tmp/git://PRIVATEUSER@example.test/repo',
    '/tmp/ftp://PRIVATEUSER@example.test/repo',
    './x//PRIVATEUSER@example.test/repo'
  ]) {
    assert.throws(() => assertCredentialFreeRemote(remote), /credential/i, remote);
    assert.doesNotMatch(sanitizeRemote(remote), /LEAKMARK/, remote);
  }
});

test('clone destinations and protocol operands cannot override structural classifications', () => {
  for (const destination of ['tls-client', 'rate-limit']) {
    const failure = classifyGitRemoteFailure(failed([
      `Cloning into '${destination}'...`,
      "fatal: repository 'https://example.test/missing.git/' not found"
    ].join('\n')));
    assert.equal(failure.classification, 'remote-not-found', destination);
  }

  for (const diagnostic of [
    "fatal: protocol 'tls' is not supported",
    "fatal: transport 'rate-limit' not allowed"
  ]) {
    assert.equal(classifyGitRemoteFailure(failed(diagnostic)).classification,
      'protocol-unsupported');
  }
});

test('diagnostic words inside SSH hostnames do not override structural network failures', () => {
  for (const hostname of ['tls', 'rate-limit']) {
    const failure = classifyGitRemoteFailure(failed(
      `ssh: Could not resolve hostname ${hostname}: Name or service not known`
    ));
    assert.equal(failure.classification, 'network-transient', hostname);
  }

  const timeout = classifyGitRemoteFailure(failed(
    'ssh: connect to host ssl-certificate port 22: Operation timed out'
  ));
  assert.equal(timeout.classification, 'network-transient');

  for (const diagnostic of [
    'fatal: unable to access \'https://example.test/repository.git/\': Could not resolve host: tls.example',
    'fatal: unable to access \'https://example.test/repository.git/\': Failed to connect to rate-limit.example port 443: Connection timed out',
    'fatal: unable to access \'https://proxy.example/repository.git/\': Could not resolve host: proxy.example'
  ]) {
    assert.equal(classifyGitRemoteFailure(failed(diagnostic)).classification, 'network-transient');
  }
});

test('an ENOENT from a missing working directory is not reported as missing Git', async () => {
  const missing = await mkdtemp(path.join(os.tmpdir(), 'sflow-missing-cwd-'));
  await rm(missing, { recursive: true, force: true });
  const spawnError = Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
  const synchronous = runRemoteGit(['ls-remote', 'origin'], {
    cwd: missing,
    runCommand: () => failed('', { error: spawnError })
  });
  assert.equal(synchronous.failure.classification, 'working-directory-unavailable');
  assert.match(synchronous.failure.advice, /reopen the local repository/i);

  const asynchronous = await runRemoteGitAsync(['--version'], {
    cwd: missing, timeoutMs: 1_000
  });
  assert.equal(asynchronous.failure.classification, 'working-directory-unavailable');
  assert.notEqual(asynchronous.failure.classification, 'git-unavailable');
});

test('malformed HTTP remotes cannot bypass credential redaction when URL parsing fails', () => {
  const secret = 'malformed-secret-value';
  const remote = `https://alice:${secret}@[invalid/repo`;
  assert.doesNotMatch(sanitizeRemote(remote), new RegExp(secret));
  assert.equal(sanitizeRemote(`https://alice:${secret}/path@invalid host/repo`),
    'https://[invalid-remote]');
  assert.throws(() => assertCredentialFreeRemote(remote), (error) => {
    assert.equal(error.code, 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL');
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
    return true;
  });
  let invoked = false;
  assert.throws(() => probeGitRemote(remote, {
    runCommand() {
      invoked = true;
      throw new Error('must not run');
    }
  }), (error) => {
    assert.equal(error.code, 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL');
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
    return true;
  });
  assert.equal(invoked, false);

  assert.throws(() => assertCredentialFreeRemote('https://[invalid/repo'),
    (error) => error.code === 'BOOTSTRAP_REMOTE_MALFORMED_URL');

  for (const scheme of ['ssh', 'git+ssh', 'ftp']) {
    const schemeSecret = `${scheme}-malformed-secret`;
    const malformed = `${scheme}://alice:${schemeSecret}@[invalid/repo`;
    assert.doesNotMatch(sanitizeRemote(malformed), new RegExp(schemeSecret));
    assert.throws(() => assertCredentialFreeRemote(malformed), (error) => {
      assert.equal(error.code, 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL');
      assert.doesNotMatch(JSON.stringify(error), new RegExp(schemeSecret));
      return true;
    });
  }
  for (const malformed of [
    'https:/alice:pass-secret@[invalid/repo',
    'https:alice:pass-secret@[invalid/repo',
    'http:\\alice:pass-secret@[invalid/repo',
    'ssh:/alice:pass-secret@[invalid/repo',
    'git+ssh:alice:pass-secret@[invalid/repo'
  ]) {
    assert.doesNotMatch(sanitizeRemote(malformed), /pass-secret/);
    assert.throws(() => assertCredentialFreeRemote(malformed), (error) => {
      assert.ok(['BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL', 'BOOTSTRAP_REMOTE_MALFORMED_URL'].includes(error.code));
      assert.doesNotMatch(JSON.stringify(error), /pass-secret/);
      return true;
    });
  }
  for (const scpLike of [
    'https:repo.git', 'ssh:repo.git', 'git:repo.git',
    'git@example.test:repo@v2.git',
    'https://example.test/team:release@candidate.git',
    '/tmp/team:release@candidate.git'
  ]) assert.equal(assertCredentialFreeRemote(scpLike), scpLike);
  assert.equal(assertCredentialFreeRemote('ssh://git@example.test/repository.git'),
    'ssh://git@example.test/repository.git', 'username-only SSH transport remains valid');
  assert.equal(assertCredentialFreeRemote('git+ssh://git@example.test/repository.git'),
    'git+ssh://git@example.test/repository.git');
  for (const nonSshUserInfo of [
    'git://private-login@example.test/repository.git',
    'ftp://private-login@example.test/repository.git'
  ]) {
    assert.throws(() => assertCredentialFreeRemote(nonSshUserInfo), (error) => {
      assert.equal(error.code, 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL');
      assert.doesNotMatch(JSON.stringify(error), /private-login/);
      return true;
    });
  }
  const scpCredential = 'alice:office-secret@example.test:repository.git';
  assert.equal(sanitizeRemote(scpCredential), '[credential-redacted]');
  assert.throws(() => assertCredentialFreeRemote(scpCredential), (error) => {
    assert.equal(error.code, 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL');
    assert.doesNotMatch(JSON.stringify(error), /office-secret/);
    return true;
  });
  assert.equal(assertCredentialFreeRemote('git@example.test:repository.git'),
    'git@example.test:repository.git');
  assert.equal(sanitizeRemote('Git.Example:team/repository.git'),
    'Git.Example:team/repository.git');
  const protocolRelative = '//alice:office-secret@example.test/repository.git?access_token=secret';
  assert.equal(sanitizeRemote(protocolRelative), '[credential-redacted]');
  assert.throws(() => assertCredentialFreeRemote(protocolRelative), (error) => {
    assert.equal(error.code, 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL');
    assert.doesNotMatch(JSON.stringify(error), /office-secret|access_token/);
    return true;
  });
  assert.equal(assertCredentialFreeRemote('//server/share/repository.git'),
    '//server/share/repository.git');
  assert.throws(() => assertCredentialFreeRemote('foo://example.test/repository.git'), (error) => {
    assert.equal(error.code, 'BOOTSTRAP_REMOTE_PROTOCOL_UNSAFE');
    assert.match(error.message, /external remote helper/);
    return true;
  });
  assert.doesNotMatch(
    sanitizeRemote('foo://example.test/password=external-helper-secret'),
    /external-helper-secret|password=/
  );
  assert.equal(sanitizeRemote('ext::LEAKMARK'), '[invalid-remote]');
  assert.equal(sanitizeRemote('--upload-pack=LEAKMARK'), '[invalid-remote]');
  for (const localSecret of [
    '/tmp/alice:LEAKMARK@host/repo',
    '/tmp/cache/password=LEAKMARK',
    '/tmp/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'
  ]) assert.equal(sanitizeRemote(localSecret), '[credential-redacted]');

  for (const remoteWithSuffix of [
    'ssh://git@example.test/repository.git?access_token=secret',
    'git+ssh://git@example.test/repository.git#secret'
  ]) {
    assert.throws(() => assertCredentialFreeRemote(remoteWithSuffix), (error) => {
      assert.equal(error.code, 'BOOTSTRAP_REMOTE_CONTAINS_EPHEMERAL_CREDENTIAL');
      assert.doesNotMatch(JSON.stringify(error), /access_token|token=secret|#secret/);
      return true;
    });
  }
  assert.equal(assertCredentialFreeRemote('git@example.test:repository.git?release#prod'),
    'git@example.test:repository.git?release#prod',
    'SCP-like repository paths preserve literal question-mark and hash bytes');

  for (const control of ['\u001b]0;spoofed\u0007', '\u007f']) {
    assert.throws(() => assertCredentialFreeRemote(`https://example.test/${control}/repo.git`),
      (error) => error.code === 'BOOTSTRAP_REMOTE_PROTOCOL_UNSAFE');
  }

  for (const diagnostic of [
    'fatal: https://example.test/repo?signature=VERYSECRET#frag',
    'fatal: https://alice:pass-secret@example.test/repo?anything=VERYSECRET#frag',
    'fatal: //alice:pass-secret@example.test/repo?custom=VERYSECRET#frag',
    'fatal: https:/alice:pass-secret@example.test/repo?signature=VERYSECRET#frag'
  ]) {
    const redacted = redactDiagnosticText(diagnostic);
    assert.doesNotMatch(redacted, /VERYSECRET|pass-secret|signature=|anything=|custom=|#frag/);
  }
  for (const diagnostic of [
    'proxy_password=LEAKMARK',
    'jira_token=LEAKMARK',
    'proxyPassword=LEAKMARK',
    'credential=domain\\user:LEAKMARK',
    'authorization=Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
    '{"password":"LEAKMARK"}',
    '{"access_token":"LEAKMARK"}',
    "{'password':'LEAKMARK'}",
    'password="abc\\\"LEAKMARK" tail',
    'Cookie: sid=LEAKMARK; remember=LEAKMARK',
    'password\n=LEAKMARK',
    'password\u0000=LEAKMARK',
    'password\u0085=LEAKMARK',
    'password\u202e=LEAKMARK',
    'pass\u0000word=LEAKMARK',
    'pass\u0085word=LEAKMARK',
    'pass\u202eword=LEAKMARK',
    'pass\u200bword=LEAKMARK',
    'pass\ufeffword=LEAKMARK',
    'fatal remote "ext::sh -c echo LEAKMARK" failed',
    '-----BEGIN PRIVATE KEY-----\nLEAKMARK\n-----END PRIVATE KEY-----'
  ]) assert.doesNotMatch(redactDiagnosticText(diagnostic), /LEAKMARK|QWxhZGRpb/);
  for (const diagnostic of [
    'fatal: ext::LEAKMARK',
    'fatal ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    'fatal github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    'fatal xoxb-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'fatal Bearer abcdefghijklmnop',
    `fatal AIza${'A'.repeat(32)}`
  ]) assert.doesNotMatch(redactDiagnosticText(diagnostic), /LEAKMARK|ghp_|github_pat_|xoxb-|Bearer|AIza/);
  const huge = `${'password=x;'.repeat(20_000)}${'A'.repeat(100_000)}`;
  const bounded = redactDiagnosticText(huge);
  assert.ok(bounded.length < 8_400);
  assert.match(bounded, /\[truncated \d+ chars\]/);
  assert.doesNotMatch(bounded, /password=x/);
  const boundary = redactDiagnosticText(`${'A'.repeat(8170)} ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`);
  assert.doesNotMatch(boundary, /ghp_|ABCDEFGHIJ/);
  const pemBoundary = redactDiagnosticText(
    `${'A'.repeat(8170)}-----BEGIN PRIVATE KEY-----\nLEAKMARK`
  );
  assert.doesNotMatch(pemBoundary, /BEGIN PRIVATE KEY|LEAKMARK/);
  assert.equal(sanitizeRemote('A'.repeat(100_000)), '[invalid-remote]');
  assert.throws(() => assertCredentialFreeRemote('A'.repeat(100_000)),
    (error) => error.code === 'BOOTSTRAP_REMOTE_TOO_LONG');
  for (const remote of [
    'https://git.example/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    'https://git.example/password=LEAKMARK',
    '/tmp/eyJabcdefghijk.abcdefghijk.abcdefghijk'
  ]) {
    assert.equal(sanitizeRemote(remote), '[credential-redacted]');
    assert.throws(() => assertCredentialFreeRemote(remote),
      (error) => error.code === 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL');
  }
  for (const remote of [
    'ssh://user%3Apass@host/repo',
    'ssh://user%2Fname@host/repo',
    'git+ssh://user%40name@host/repo'
  ]) {
    assert.equal(sanitizeRemote(remote), '[credential-redacted]');
    assert.throws(() => assertCredentialFreeRemote(remote),
      (error) => error.code === 'BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL');
  }
});

test('failure evidence is stable and never retains diagnostic text', () => {
  const diagnostic = 'fatal: credential helper failed with office-secret-value';
  const evidence = failureEvidence({
    status: 128, stderr: diagnostic, stdout: '', signal: null, timedOut: false, blocked: false
  });
  assert.deepEqual(evidence, {
    exitCode: 128,
    signal: null,
    timedOut: false,
    blocked: false,
    diagnosticSha256: 'afd8f7bbc0a5c8eb2f0181bb0cb7beb285d833e12a25a682b4639f1a6806e76d',
    diagnosticBytes: Buffer.byteLength(diagnostic, 'utf8')
  });
  assert.equal(Object.isFrozen(evidence), true);
  assert.doesNotMatch(JSON.stringify(evidence), /office-secret|credential helper/);
});

test('synchronous remote execution attaches safe evidence to its classified failure', () => {
  const diagnostic = 'fatal: Cannot prompt because user interactivity has been disabled.';
  const runCommand = () => failed(diagnostic);
  const result = runRemoteGit(['ls-remote', 'origin'], {
    runCommand
  });
  assert.deepEqual(result.failure.evidence, failureEvidence(failed(diagnostic)));
  assert.doesNotMatch(JSON.stringify(result.failure), /Cannot prompt|user interactivity/);
  assert.throws(() => runRemoteGit(['ls-remote', 'origin'], {
    allowFailure: false,
    runCommand
  }), (error) => {
    assert.deepEqual(error.details.evidence, failureEvidence(failed(diagnostic)));
    assert.doesNotMatch(JSON.stringify(error), /Cannot prompt|user interactivity/);
    return true;
  });
});

test('asynchronous remote execution attaches safe evidence to its classified failure', async () => {
  const diagnostic = 'remote: Invalid username or token. Password authentication is not supported for Git operations.';
  const spawnCommand = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stderr.end(diagnostic);
      child.emit('close', 128, null);
    });
    return child;
  };
  const result = await runRemoteGitAsync(['ls-remote', 'origin'], {
    timeoutMs: 1_000,
    spawnCommand
  });
  assert.equal(result.failure.classification, 'authentication-required');
  assert.deepEqual(result.failure.evidence, failureEvidence({
    status: 128,
    stdout: '',
    stderr: diagnostic,
    error: null,
    signal: null,
    timedOut: false,
    blocked: false
  }));
  assert.doesNotMatch(JSON.stringify(result.failure), /Invalid username|Password authentication/);
});
