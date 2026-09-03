import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { run } from '../src/util.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { rememberWorkspace } from '../src/workspace.mjs';
import { installWorkflow } from '../src/workflow-catalog.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import {
  isolatedCacheGitEnvironment,
  mergePackagedConfiguration,
  PACKAGE_BASELINE_PATH,
  refreshPackagedConfiguration,
  refreshWorkspaceConfigurations,
  STATE_CONFIGURATION_MANIFEST
} from '../src/workspace-configuration-refresh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
process.env.GIT_LFS_SKIP_SMUDGE = '1';
if (process.platform === 'darwin') process.env.TMPDIR = '/tmp';
const INITIAL_FILES = [
  ['workflow.yml', 'singularity/workflow.yml'],
  ['portfolio.yml', 'singularity/portfolio.yml'],
  ['capabilities.yml', 'singularity/capabilities.yml'],
  ['agent-mappings.yml', 'singularity/agent-mappings.yml'],
  ['impact.yml', 'singularity/impact.yml'],
  ['modelTiers.yml', 'singularity/modelTiers.yml'],
  ['artifacts', 'singularity/templates'],
  ['agents', '.github/agents'],
  ['worldmodel-builder.md', 'singularity/prompts/worldmodel-builder.md'],
  ['copilot-planning.md', 'singularity/prompts/copilot-planning.md']
];

function git(root, args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

async function copyBytes(source, destination) {
  const info = await lstatForCopy(source);
  if (info.directory) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) await copyBytes(path.join(source, entry), path.join(destination, entry));
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
  }
}

async function lstatForCopy(source) {
  const entries = await readdir(source, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOTDIR') return null;
    throw error;
  });
  return { directory: entries !== null };
}

async function initializeFixture(root) {
  for (const [source, destination] of INITIAL_FILES) {
    await copyBytes(path.join(ROOT, 'templates', source), path.join(root, destination));
  }
}

async function repositoryFixture(root, id = 'application') {
  const remote = path.join(root, `${id}.git`);
  const repository = path.join(root, 'workspace', 'repos', id);
  run('git', ['init', '--bare', '--initial-branch=main', remote]);
  run('git', ['init', '--initial-branch=main', repository]);
  git(repository, ['config', 'user.name', 'Configuration Test']);
  git(repository, ['config', 'user.email', 'configuration@example.test']);
  await writeFile(path.join(repository, 'application.txt'), 'application source\n');
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Initialize application']);
  git(repository, ['remote', 'add', 'origin', remote]);
  git(repository, ['push', '-u', 'origin', 'main']);

  // Seed only the authority file this regression needs. The refresh itself installs the packaged
  // assets; avoiding a second full fixture commit keeps this test about refresh rather than macOS
  // metadata-copy performance.
  const publisher = path.join(root, 'configuration-publisher');
  run('git', ['init', '--initial-branch=sflow/config', publisher]);
  git(publisher, ['config', 'user.name', 'Configuration Test']);
  git(publisher, ['config', 'user.email', 'configuration@example.test']);
  const workflow = YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
  delete workflow.phases.implementation.generation.task;
  workflow.defaultBaseBranch = 'release';
  await mkdir(path.join(publisher, 'singularity'), { recursive: true });
  await writeFile(path.join(publisher, 'singularity/workflow.yml'), YAML.stringify(workflow));
  git(publisher, ['add', 'singularity/workflow.yml']);
  git(publisher, ['commit', '-m', 'Retain older workflow policy']);
  git(publisher, ['remote', 'add', 'origin', remote]);
  git(publisher, ['push', 'origin', 'HEAD:sflow/config']);
  return { remote, repository };
}

async function registeredRepositoryFixture(root, id) {
  const fixture = await repositoryFixture(root, id);
  const workspaceRoot = path.join(root, 'workspace');
  const manifest = {
    version: 1,
    id: `${id}-workspace`,
    name: `${id} workspace`,
    path: workspaceRoot,
    anchor: { provider: 'workspace', key: `${id}-workspace`, title: `${id} workspace` },
    leadRepository: id,
    repositories: {
      [id]: {
        id, url: fixture.remote, defaultBranch: 'main', required: true,
        path: `repos/${id}`, role: 'lead', capabilities: []
      }
    }
  };
  const registry = path.join(root, 'workspaces.json');
  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rememberWorkspace(registry, manifest);
  return { ...fixture, registry };
}

async function cachedConfigurationCheckout(registry, planId) {
  const planRoot = path.join(path.dirname(registry), '.configuration-refresh-cache', planId);
  const record = JSON.parse(await readFile(path.join(planRoot, 'plan.json'), 'utf8'));
  assert.equal(record.planId, planId);
  assert.equal(record.repositories.length, 1);
  const checkout = path.join(planRoot, 'repositories', record.repositories[0].key);
  assert.equal((await readdir(checkout)).includes('.git'), true, 'preview retained its disposable checkout');
  return checkout;
}

async function plantConfigurationCacheLock(registry, {
  pid, token, acquiredAt = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString()
}) {
  const lock = path.join(path.dirname(registry), '.configuration-refresh-cache', '.operation-lock');
  await mkdir(lock, { mode: 0o700 });
  const owner = {
    format: 'singularity-flow-configuration-refresh-cache-lock/v1',
    pid,
    processStartedAt: new Date(Date.now() - (3 * 60 * 60 * 1000)).toISOString(),
    processToken: `process-${token}`,
    token,
    acquiredAt
  };
  await writeFile(path.join(lock, '.owner.json'), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  return { lock, owner };
}

async function withGitUrlRewrite(from, to, callback) {
  const inherited = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  const start = Number.isInteger(inherited) && inherited >= 0 ? inherited : 0;
  const additions = [
    [`url.${to}.insteadOf`, from],
    [`url.${to}.pushInsteadOf`, from]
  ];
  const touched = ['GIT_CONFIG_COUNT', ...additions.flatMap((_, offset) => [
    `GIT_CONFIG_KEY_${start + offset}`, `GIT_CONFIG_VALUE_${start + offset}`
  ])];
  const previous = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  process.env.GIT_CONFIG_COUNT = String(start + additions.length);
  additions.forEach(([key, value], offset) => {
    process.env[`GIT_CONFIG_KEY_${start + offset}`] = key;
    process.env[`GIT_CONFIG_VALUE_${start + offset}`] = value;
  });
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function encodedGitConfiguration(entries) {
  return `${entries.map(([key, value]) => `${key}\n${value}`).join('\0')}\0`;
}

function commandScopedGitConfiguration(env) {
  return Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [
    env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]
  ]);
}

function snapshotWithRejectedEnterpriseScope(rejectedScope, reject) {
  const acceptedScope = rejectedScope === 'system' ? 'global' : 'system';
  const calls = [];
  const isolated = isolatedCacheGitEnvironment({
    PATH: process.env.PATH,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/must-not-survive'
  }, {
    runCommand(_command, args) {
      const scope = args.includes('--system') ? 'system' : 'global';
      calls.push(scope);
      if (scope === rejectedScope) return reject();
      return {
        status: 0,
        stdout: encodedGitConfiguration([
          ['credential.helper', `${acceptedScope}-credential-manager`]
        ]),
        stderr: '', timedOut: false
      };
    }
  });
  assert.deepEqual(calls, ['system', 'global'],
    `${rejectedScope} rejection must not prevent inspecting ${acceptedScope}`);
  assert.deepEqual(commandScopedGitConfiguration(isolated), [],
    `${rejectedScope} rejection must fail the ordered snapshot closed`);
}

test('enterprise Git configuration fails an indeterminate system or global scope closed', () => {
  for (const rejectedScope of ['system', 'global']) {
    snapshotWithRejectedEnterpriseScope(rejectedScope, () => ({
      status: 128, stdout: '', stderr: 'unavailable', timedOut: false
    }));
    snapshotWithRejectedEnterpriseScope(rejectedScope, () => {
      throw new Error('launcher failed before returning a result');
    });
  }
});

test('enterprise Git configuration rejects overflowing scopes without changing Git precedence', () => {
  for (const rejectedScope of ['system', 'global']) {
    snapshotWithRejectedEnterpriseScope(rejectedScope, () => ({
      status: 1,
      stdout: encodedGitConfiguration([['http.proxy', 'http://partial.invalid']]),
      stderr: '', timedOut: false, error: Object.assign(new Error('ENOBUFS'), { code: 'ENOBUFS' })
    }));
    snapshotWithRejectedEnterpriseScope(rejectedScope, () => ({
      status: 0,
      stdout: encodedGitConfiguration([['http.proxy', 'x'.repeat((32 * 1024) + 1)]]),
      stderr: '', timedOut: false
    }));
  }
});

test('enterprise Git configuration fails malformed scopes closed without changing Git precedence', () => {
  for (const rejectedScope of ['system', 'global']) {
    snapshotWithRejectedEnterpriseScope(rejectedScope, () => ({
      status: 0,
      stdout: `${encodedGitConfiguration([['http.proxy', 'http://partial.invalid']])}malformed\0`,
      stderr: '', timedOut: false
    }));
    snapshotWithRejectedEnterpriseScope(rejectedScope, () => ({
      status: 0,
      stdout: encodedGitConfiguration([
        ['http.proxy', 'http://partial.invalid'],
        ['core.hooksPath', '/must-not-enter-enterprise-environment']
      ]),
      stderr: '', timedOut: false
    }));
    snapshotWithRejectedEnterpriseScope(rejectedScope, () => ({
      status: 0, stdout: '', stderr: '', timedOut: false
    }));
    snapshotWithRejectedEnterpriseScope(rejectedScope, () => ({
      status: 1, stdout: 'unexpected wrapper output', stderr: '', timedOut: false
    }));
    snapshotWithRejectedEnterpriseScope(rejectedScope, () => ({
      status: 1, stdout: '', stderr: 'unexpected wrapper diagnostic', timedOut: false
    }));
  }
});

test('enterprise Git configuration preserves the process-wide entry bound across both scopes', () => {
  const entries = (prefix, count) => Array.from({ length: count }, (_, index) => [
    'credential.helper', `${prefix}-${index}`
  ]);
  const isolated = isolatedCacheGitEnvironment({ PATH: process.env.PATH }, {
    runCommand(_command, args) {
      return {
        status: 0,
        stdout: encodedGitConfiguration(args.includes('--system')
          ? entries('system', 200) : entries('global', 100)),
        stderr: '', timedOut: false
      };
    }
  });
  assert.equal(Number(isolated.GIT_CONFIG_COUNT), 0,
    'an over-budget ordered snapshot fails closed instead of retaining a lower-precedence prefix');
});

test('an indeterminate global scope cannot reactivate a system credential helper that it may reset', () => {
  const isolated = isolatedCacheGitEnvironment({ PATH: process.env.PATH }, {
    runCommand(_command, args) {
      if (args.includes('--system')) {
        return {
          status: 0,
          stdout: encodedGitConfiguration([['credential.helper', 'system-corporate-manager']]),
          stderr: '', timedOut: false
        };
      }
      return { status: 128, stdout: '', stderr: 'global configuration unreadable', timedOut: false };
    }
  });
  assert.deepEqual(commandScopedGitConfiguration(isolated), []);
});

test('an indeterminate system scope cannot change URL-specific precedence', () => {
  const isolated = isolatedCacheGitEnvironment({ PATH: process.env.PATH }, {
    runCommand(_command, args) {
      if (args.includes('--system')) {
        return { status: 128, stdout: '', stderr: 'system configuration unreadable', timedOut: false };
      }
      return {
        status: 0,
        stdout: encodedGitConfiguration([['http.proxy', 'http://generic-global.example.test']]),
        stderr: '', timedOut: false
      };
    }
  });
  assert.deepEqual(commandScopedGitConfiguration(isolated), [],
    'a generic global proxy cannot replace an unknown URL-specific system decision');
});

test('a known-empty global scope preserves verified system configuration', () => {
  const isolated = isolatedCacheGitEnvironment({ PATH: process.env.PATH }, {
    runCommand(_command, args) {
      if (args.includes('--system')) {
        return {
          status: 0,
          stdout: encodedGitConfiguration([['credential.helper', 'system-corporate-manager']]),
          stderr: '', timedOut: false
        };
      }
      return { status: 1, stdout: '', stderr: '', timedOut: false };
    }
  });
  assert.deepEqual(commandScopedGitConfiguration(isolated), [
    ['credential.helper', 'system-corporate-manager']
  ]);
});

test('a signal-terminated empty scope is indeterminate and fails the whole snapshot closed', () => {
  for (const interruptedScope of ['system', 'global']) {
    const isolated = isolatedCacheGitEnvironment({ PATH: process.env.PATH }, {
      runCommand(_command, args) {
        const scope = args.includes('--system') ? 'system' : 'global';
        if (scope === interruptedScope) {
          return {
            status: 1, stdout: '', stderr: '', signal: 'SIGTERM', timedOut: false
          };
        }
        return {
          status: 0,
          stdout: encodedGitConfiguration([['credential.helper', `${scope}-manager`]]),
          stderr: '', signal: null, timedOut: false
        };
      }
    });
    assert.deepEqual(commandScopedGitConfiguration(isolated), [], interruptedScope);
  }
});

test('a successful-looking interrupted enterprise scope is still indeterminate', () => {
  for (const interruption of [
    { signal: 'SIGTERM' },
    { aborted: true }
  ]) {
    for (const interruptedScope of ['system', 'global']) {
      const isolated = isolatedCacheGitEnvironment({ PATH: process.env.PATH }, {
        runCommand(_command, args) {
          const scope = args.includes('--system') ? 'system' : 'global';
          return {
            status: 0,
            stdout: encodedGitConfiguration([['credential.helper', `${scope}-manager`]]),
            stderr: '',
            timedOut: false,
            signal: null,
            aborted: false,
            ...(scope === interruptedScope ? interruption : {})
          };
        }
      });
      assert.deepEqual(commandScopedGitConfiguration(isolated), [],
        `${interruptedScope} ${Object.keys(interruption)[0]} must fail the snapshot closed`);
    }
  }
});

test('confirmed refresh preserves allowlisted enterprise Git transport and auth without leaking unsafe configuration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-enterprise-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const systemConfig = path.join(root, 'system.gitconfig');
  const globalConfig = path.join(root, 'global.gitconfig');
  const systemCa = path.join(root, 'system-ca.pem');
  const globalCa = path.join(root, 'global-ca.pem');
  const secretHeader = 'Authorization: Bearer must-not-enter-refresh';
  const secretKey = path.join(root, 'must-not-enter-refresh-client.key');
  const hostileHooks = path.join(root, 'must-not-enter-refresh-hooks');
  const executableMarker = path.join(root, 'must-not-execute-git-transport-override');
  const executableOverride = path.join(root, 'must-not-execute-git-transport-override.mjs');
  await writeFile(executableOverride,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(executableMarker)}, 'executed\\n');\nprocess.exit(1);\n`);
  const executableCommand = `"${process.execPath}" "${executableOverride}"`;

  const configure = (file, args) => run('git', ['config', '--file', file, ...args]);
  configure(systemConfig, ['http.proxy', 'http://system-proxy.example.test:8080']);
  configure(systemConfig, ['http.sslCAInfo', systemCa]);
  configure(systemConfig, ['--add', 'credential.helper', 'system-corporate-manager']);
  configure(systemConfig, ['http.sslBackend', 'openssl']);
  configure(globalConfig, ['http.proxy', 'http://global-proxy.example.test:8443']);
  configure(globalConfig, ['http.sslCAInfo', globalCa]);
  configure(globalConfig, ['--add', 'credential.helper', '']);
  configure(globalConfig, ['--add', 'credential.helper', 'global-corporate-manager']);
  configure(globalConfig, [
    'credential.https://git.example.test.useHttpPath', 'true'
  ]);
  configure(globalConfig, [
    'http.https://git.example.test.sslCAInfo', path.join(root, 'provider-ca.pem')
  ]);
  // These values could execute code, redirect authority, or carry credentials. They must remain
  // unavailable even though they share the same trusted global file as the allowlisted settings.
  configure(globalConfig, ['core.hooksPath', hostileHooks]);
  configure(globalConfig, ['url.file:///decoy.git.insteadOf', 'https://git.example.test/']);
  configure(globalConfig, ['http.extraHeader', secretHeader]);
  configure(globalConfig, ['http.sslKey', secretKey]);
  configure(globalConfig, ['http.sslVerify', 'false']);
  configure(globalConfig, ['credential.interactive', 'always']);
  configure(globalConfig, ['credential.username', 'must-not-enter-refresh@example.test']);

  const sourceEnv = {
    ...process.env,
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_DIR: path.join(root, 'attacker.git'),
    GIT_WORK_TREE: path.join(root, 'attacker-worktree'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hostileHooks,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSH: executableOverride,
    GIT_SSH_COMMAND: executableCommand,
    GIT_SSH_VARIANT: 'ssh',
    GIT_ASKPASS: executableOverride,
    GIT_ASKPASS_REQUIRE: 'force',
    SSH_ASKPASS: executableOverride,
    SSH_ASKPASS_REQUIRE: 'force',
    GIT_PROXY_COMMAND: executableCommand,
    GIT_EDITOR: executableCommand,
    GIT_SEQUENCE_EDITOR: executableCommand,
    GIT_PAGER: executableCommand,
    GIT_EXTERNAL_DIFF: executableCommand,
    GIT_TRACE_CURL: path.join(root, 'must-not-enter-refresh-curl-trace.log'),
    GIT_TRACE2_EVENT: path.join(root, 'must-not-enter-refresh-trace2.jsonl')
  };
  let configurationQueries = 0;
  const isolated = isolatedCacheGitEnvironment(sourceEnv, {
    runCommand(command, args, options) {
      configurationQueries += 1;
      return run(command, args, options);
    }
  });
  const snapshotQueries = configurationQueries;
  assert.equal(isolatedCacheGitEnvironment(isolated, {
    runCommand() {
      throw new Error('an operation-scoped enterprise environment was queried again');
    }
  }), isolated, 'one onboarding operation reuses its enterprise configuration snapshot');
  assert.equal(configurationQueries, snapshotQueries,
    'reusing a sanitized operation environment does not rerun system/global Git config');
  for (const key of [
    'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
    'GIT_ASKPASS', 'GIT_ASKPASS_REQUIRE', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE',
    'GIT_PROXY_COMMAND', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER',
    'GIT_EXTERNAL_DIFF'
  ]) assert.equal(isolated[key], undefined, `${key} crossed the executable Git environment boundary`);

  // Exercise the resulting environment against an SSH transport. If either replacement survived,
  // Git would run the sentinel before it could fail the deliberately unreachable connection.
  run('git', ['ls-remote', '--', 'ssh://127.0.0.1:1/unreachable.git'], {
    cwd: root, env: isolated, allowFailure: true, timeoutMs: 5_000
  });
  await assert.rejects(readFile(executableMarker), (error) => error?.code === 'ENOENT',
    'an inherited Git transport executable ran inside the isolated enterprise boundary');
  const values = (key) => {
    const result = run('git', ['config', '--null', '--get-all', key], {
      cwd: root, env: isolated, allowFailure: true
    });
    return result.status === 0 ? result.stdout.split('\0').slice(0, -1) : [];
  };

  assert.deepEqual(values('http.proxy'), [
    'http://system-proxy.example.test:8080',
    'http://global-proxy.example.test:8443'
  ], 'system and global proxy ordering survives the isolated confirmed operation');
  assert.equal(run('git', ['config', '--get', 'http.proxy'], { cwd: root, env: isolated }).stdout.trim(),
    'http://global-proxy.example.test:8443',
    'Git still resolves the global proxy as the effective higher-precedence value');
  assert.deepEqual(values('http.sslCAInfo'), [systemCa, globalCa]);
  assert.equal(run('git', ['config', '--get', 'http.sslCAInfo'], {
    cwd: root, env: isolated
  }).stdout.trim(), globalCa,
  'Git still resolves the global CA as the effective higher-precedence value');
  assert.deepEqual(values('credential.helper'), [
    'system-corporate-manager', '', 'global-corporate-manager'
  ], 'an empty global helper keeps Git credential-helper reset semantics');
  assert.deepEqual(values('credential.https://git.example.test.useHttpPath'), ['true']);
  assert.deepEqual(values('http.https://git.example.test.sslCAInfo'), [
    path.join(root, 'provider-ca.pem')
  ]);
  assert.deepEqual(values('http.sslBackend'), ['openssl']);

  for (const key of [
    'core.hooksPath', 'url.file:///decoy.git.insteadOf', 'http.extraHeader', 'http.sslKey',
    'http.sslVerify', 'credential.interactive', 'credential.username'
  ]) assert.deepEqual(values(key), [], `${key} must not cross the confirmed-refresh boundary`);
  assert.equal(isolated.GIT_DIR, undefined);
  assert.equal(isolated.GIT_WORK_TREE, undefined);
  assert.equal(isolated.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(isolated.GIT_CONFIG_GLOBAL, os.devNull);
  assert.equal(isolated.GIT_CONFIG_SYSTEM, os.devNull);
  assert.equal(isolated.GIT_TRACE_CURL, undefined);
  assert.equal(isolated.GIT_TRACE2_EVENT, undefined);
  const admittedConfiguration = Object.entries(isolated)
    .filter(([key]) => /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key))
    .map(([, value]) => value).join('\n');
  assert.doesNotMatch(admittedConfiguration,
    /must-not-enter-refresh|Authorization: Bearer|decoy\.git|client\.key/,
    'unsafe or credential-bearing configuration must not leak into child environments');
});

test('confirmed refresh failures never disclose allowlisted proxy or credential-helper secrets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-enterprise-redaction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const globalConfig = path.join(root, 'global.gitconfig');
  const proxySecret = 'sflow-proxy-password-must-not-leak';
  const helperSecret = 'sflow-helper-password-must-not-leak';
  run('git', [
    'config', '--file', globalConfig, 'http.proxy',
    `http://employee:${proxySecret}@127.0.0.1:1`
  ]);
  run('git', [
    'config', '--file', globalConfig, 'credential.helper',
    `!f() { printf 'password=${helperSecret}\\n'; }; f`
  ]);
  const workspaceRoot = path.join(root, 'workspace');
  const manifest = {
    version: 1,
    id: 'enterprise-redaction',
    name: 'Enterprise redaction',
    path: workspaceRoot,
    anchor: { provider: 'workspace', key: 'enterprise-redaction', title: 'Enterprise redaction' },
    leadRepository: 'application',
    repositories: {
      application: {
        id: 'application', url: 'https://git.example.invalid/acme/application.git',
        defaultBranch: 'main', required: true, path: 'repos/application', role: 'lead',
        capabilities: []
      }
    }
  };
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const registry = path.join(root, 'workspaces.json');
  await rememberWorkspace(registry, manifest);
  const changed = {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: os.devNull,
    SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS: '2000'
  };
  const previous = Object.fromEntries(Object.keys(changed).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changed);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const result = await refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: 'cfgp-000000000000000000000000'
  });
  assert.equal(result.status, 'blocked');
  const disclosed = JSON.stringify(result);
  assert.doesNotMatch(disclosed, /employee|sflow-proxy-password|sflow-helper-password/);
  assert.match(result.results[0].error, /Cannot read|network|proxy|offline|retry/i);
});

test('confirmed refresh carries Windows GCM, proxy case variants, and custom trust through cancellation without disclosure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-enterprise-windows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const systemConfig = path.join(root, 'system.gitconfig');
  const globalConfig = path.join(root, 'global.gitconfig');
  const windowsManager = 'C:/Program Files/Git Credential Manager/git-credential-manager.exe';
  const windowsCa = 'C:/ProgramData/Enterprise PKI/root-ca.pem';
  run('git', ['config', '--file', systemConfig, '--add', 'credential.helper', 'manager']);
  run('git', ['config', '--file', globalConfig, '--add', 'credential.helper', '']);
  run('git', ['config', '--file', globalConfig, '--add', 'credential.helper', windowsManager]);
  run('git', ['config', '--file', globalConfig, 'http.sslBackend', 'schannel']);
  run('git', ['config', '--file', globalConfig, 'http.sslCAInfo', windowsCa]);
  run('git', ['config', '--file', globalConfig, 'http.schannelUseSSLCAInfo', 'true']);
  run('git', [
    'config', '--file', globalConfig,
    'credential.https://dev.azure.com.useHttpPath', 'true'
  ]);
  const upperProxySecret = 'upper-proxy-secret-must-not-leak';
  const lowerProxySecret = 'lower-proxy-secret-must-not-leak';
  const sourceEnv = {
    ...process.env,
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_CONFIG_GLOBAL: globalConfig,
    HTTPS_PROXY: `http://employee:${upperProxySecret}@upper-proxy.example.test:8080`,
    https_proxy: `http://employee:${lowerProxySecret}@lower-proxy.example.test:8080`,
    HTTP_PROXY: 'http://upper-http-proxy.example.test:8080',
    http_proxy: 'http://lower-http-proxy.example.test:8080',
    NO_PROXY: 'upper-no-proxy.example.test',
    no_proxy: 'lower-no-proxy.example.test',
    GIT_SSL_CAINFO: windowsCa,
    GIT_SSL_CAPATH: 'C:/ProgramData/Enterprise PKI/certificates',
    GIT_SSL_NO_VERIFY: '1'
  };
  delete sourceEnv.GIT_CONFIG_NOSYSTEM;
  const isolated = isolatedCacheGitEnvironment(sourceEnv);
  const controller = new AbortController();
  let childEnvironment = null;
  const signals = [];
  const spawnCommand = (_command, _args, options) => {
    childEnvironment = options.env;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => controller.abort(new Error('user cancelled enterprise refresh')));
    return child;
  };
  const terminateTree = (child, signal) => {
    signals.push(signal);
    if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  const result = await runRemoteGitAsync([
    'ls-remote', '--heads', '--', 'https://git.example.test/acme/application.git'
  ], {
    env: isolated,
    signal: controller.signal,
    spawnCommand,
    terminateTree,
    timeoutMs: 5_000,
    terminationGraceMs: 40
  });

  assert.equal(result.aborted, true);
  assert.equal(result.failure.code, 'REMOTE_OPERATION_ABORTED');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  for (const key of [
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
    'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH'
  ]) assert.equal(childEnvironment[key], sourceEnv[key], `${key} must reach the Git supervisor unchanged`);
  assert.equal(childEnvironment.GIT_SSL_NO_VERIFY, undefined,
    'enterprise trust configuration must never disable certificate verification');
  const gitValues = (key) => run('git', ['config', '--null', '--get-all', key], {
    cwd: root, env: childEnvironment
  }).stdout.split('\0').slice(0, -1);
  assert.deepEqual(gitValues('credential.helper'), ['manager', '', windowsManager]);
  assert.deepEqual(gitValues('credential.https://dev.azure.com.useHttpPath'), ['true']);
  assert.deepEqual(gitValues('http.sslBackend'), ['schannel']);
  assert.deepEqual(gitValues('http.sslCAInfo'), [windowsCa]);
  assert.deepEqual(gitValues('http.schannelUseSSLCAInfo'), ['true']);
  assert.doesNotMatch(JSON.stringify(result),
    /upper-proxy-secret|lower-proxy-secret|Credential Manager|ProgramData|root-ca/,
    'cancellation results expose only closed-vocabulary status, never enterprise config values');
});

test('three-way package merging updates untouched values and retains repository customizations', () => {
  const base = {
    phases: { implementation: { generation: { task: 'code', allowed: ['model'] } } },
    defaultBaseBranch: 'main'
  };
  const incoming = {
    phases: { implementation: { generation: { task: 'implement', allowed: ['model', 'human'] } } },
    defaultBaseBranch: 'main'
  };
  const local = {
    phases: { implementation: { generation: { task: 'code', allowed: ['model'] } } },
    defaultBaseBranch: 'release'
  };
  const merged = mergePackagedConfiguration(base, local, incoming);
  assert.equal(merged.value.phases.implementation.generation.task, 'implement');
  assert.deepEqual(merged.value.phases.implementation.generation.allowed, ['model', 'human']);
  assert.equal(merged.value.defaultBaseBranch, 'release');
  assert.equal(merged.conflicts.length, 0, 'the package did not change the customized branch field');

  const conflict = mergePackagedConfiguration(base, {
    ...local,
    phases: { implementation: { generation: { task: 'repository-task', allowed: ['model'] } } }
  }, incoming);
  assert.equal(conflict.value.phases.implementation.generation.task, 'repository-task');
  assert.equal(conflict.conflicts[0].path, 'workflow.phases.implementation.generation.task');
  assert.equal(conflict.conflicts[0].resolution, 'preserved-local');
});

test('first package baseline safely expands allowlists and supports one reviewed conflict choice', () => {
  const local = {
    ledger: { enabled: true },
    phases: { implementation: { allowedAgents: ['developer'], allowedTools: ['git'] } }
  };
  const incoming = {
    ledger: { enabled: false },
    phases: { implementation: { allowedAgents: ['developer', 'qa'], allowedTools: ['git', 'tests'] } }
  };
  const preserved = mergePackagedConfiguration({}, local, incoming);
  assert.deepEqual(preserved.value.phases.implementation.allowedAgents, ['developer', 'qa']);
  assert.deepEqual(preserved.value.phases.implementation.allowedTools, ['git', 'tests']);
  assert.equal(preserved.value.ledger.enabled, true);
  assert.ok(preserved.conflicts.some((entry) => entry.path === 'workflow.ledger.enabled'
    && entry.resolution === 'preserved-local'));

  const selected = mergePackagedConfiguration({}, local, incoming, {
    resolutions: { 'workflow.ledger.enabled': 'bundled' }
  });
  assert.equal(selected.value.ledger.enabled, false);
  assert.ok(selected.conflicts.some((entry) => entry.path === 'workflow.ledger.enabled'
    && entry.resolution === 'accepted-bundled'));
});

test('explicit workflow replacement also replaces its shared phase contract', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-replace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.phases.implementation.generation.task = 'analyze';
  await writeFile(workflowFile, YAML.stringify(workflow));

  await installWorkflow(root, 'feature', { replace: true });
  const replaced = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(replaced.phases.implementation.generation.task, 'code');
});

test('repository refresh restores additive policy and missing assets without overwriting custom files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-package-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  delete workflow.phases.implementation.generation.task;
  workflow.defaultBaseBranch = 'release';
  await writeFile(workflowFile, YAML.stringify(workflow));
  const missing = path.join(root, 'singularity/templates/feature/implementation-spec.md');
  await rm(missing);
  const customAgent = path.join(root, '.github/agents/developer.agent.md');
  const customizedAgent = `${await readFile(path.join(ROOT, 'templates/agents/developer.agent.md'), 'utf8')}\n<!-- repository customization -->\n`;
  await writeFile(customAgent, customizedAgent);

  const result = await refreshPackagedConfiguration(root);
  const refreshed = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(refreshed.phases.implementation.generation.task, 'code');
  assert.equal(refreshed.defaultBaseBranch, 'release');
  assert.match(await readFile(missing, 'utf8'), /implementation/i);
  assert.equal(await readFile(customAgent, 'utf8'), customizedAgent);
  assert.ok(result.conflicts.some((entry) => entry.path === '.github/agents/developer.agent.md'));
  assert.equal(YAML.parse(await readFile(path.join(root, PACKAGE_BASELINE_PATH), 'utf8')).format,
    'singularity-flow-configuration-baseline/v1');
  const repeated = await refreshPackagedConfiguration(root);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.files, []);
});

test('configuration refresh restores the standard spec-driven workflow after a prior baseline', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-standard-workflow-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);

  // Record the current package as the prior reviewed baseline, then reproduce an approved
  // configuration that lacks the standard profile. Generic three-way merging calls this a local
  // deletion; product refresh must still restore the standard workflow contract.
  await refreshPackagedConfiguration(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  delete workflow.workTypes['spec-driven-standard'];
  await writeFile(workflowFile, YAML.stringify(workflow));

  const refreshed = await refreshPackagedConfiguration(root);
  const definition = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.deepEqual(definition.workTypes['spec-driven-standard'],
    YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'))
      .workTypes['spec-driven-standard']);
  assert.ok(refreshed.files.includes('singularity/workflow.yml'));
  assert.ok(!refreshed.conflicts.some((entry) =>
    entry.path === 'workflow.workTypes.spec-driven-standard'));
});

test('configuration refresh upgrades an exact retired bundled model map without treating it as customization', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-package-refresh-model-map-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const target = path.join(root, 'singularity/modelTiers.yml');
  const retired = await readFile(path.join(ROOT, 'test/fixtures/legacy-modelTiers-gpt4o.yml'));
  await writeFile(target, retired);

  const result = await refreshPackagedConfiguration(root);
  assert.equal(await readFile(target, 'utf8'), await readFile(path.join(ROOT, 'templates/modelTiers.yml'), 'utf8'));
  assert.ok(result.files.includes('singularity/modelTiers.yml'));
  assert.ok(!result.conflicts.some((entry) => entry.path === 'singularity/modelTiers.yml'));
});

test('configuration refresh refuses a cross-file-invalid preserved agent and accepts an explicit repair', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-package-refresh-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const qaFile = path.join(root, '.github/agents/qa.agent.md');
  const currentQa = await readFile(qaFile, 'utf8');
  const olderQa = currentQa.replaceAll(
    'reproduction,verify,verification,testing,visual-verification,conformance,release',
    'reproduction,verify,verification,visual-verification,conformance,release'
  );
  assert.notEqual(olderQa, currentQa, 'the fixture removes the default for the testing phase');
  await writeFile(qaFile, olderQa);

  await assert.rejects(() => refreshPackagedConfiguration(root), (error) => {
    assert.equal(error.code, 'CONFIGURATION_REFRESH_INVALID');
    assert.match(error.message, /testing.*default governed agent/i);
    assert.match(error.message, /--resolve PATH=bundled/);
    assert.ok(error.details.conflicts.some((entry) => entry.path === '.github/agents/qa.agent.md'));
    return true;
  });

  const repaired = await refreshPackagedConfiguration(root, {
    resolutions: { '.github/agents/qa.agent.md': 'bundled' }
  });
  assert.ok(repaired.conflicts.some((entry) => entry.path === '.github/agents/qa.agent.md'
    && entry.resolution === 'accepted-bundled'));
  assert.equal(await readFile(qaFile, 'utf8'), currentQa);
});

test('workspace refresh preview returns an actionable packaged-agent repair instead of losing conflicts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-agent-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote } = await repositoryFixture(root, 'agent-repair');

  const publisher = path.join(root, 'agent-repair-publisher');
  run('git', ['clone', '--quiet', '--branch', 'sflow/config', remote, publisher]);
  git(publisher, ['config', 'user.name', 'Configuration Test']);
  git(publisher, ['config', 'user.email', 'configuration@example.test']);
  const currentQa = await readFile(path.join(ROOT, 'templates/agents/qa.agent.md'), 'utf8');
  const olderQa = currentQa.replaceAll(
    'reproduction,verify,verification,testing,visual-verification,conformance,release',
    'reproduction,verify,verification,visual-verification,conformance,release'
  );
  await mkdir(path.join(publisher, '.github/agents'), { recursive: true });
  await writeFile(path.join(publisher, '.github/agents/qa.agent.md'), olderQa);
  git(publisher, ['add', '.github/agents/qa.agent.md']);
  git(publisher, ['commit', '-m', 'Preserve an older QA agent']);
  git(publisher, ['push', 'origin', 'HEAD:sflow/config']);

  const workspaceRoot = path.join(root, 'workspace');
  const manifest = {
    version: 1,
    id: 'agent-repair-workspace',
    name: 'Agent repair workspace',
    path: workspaceRoot,
    anchor: { provider: 'workspace', key: 'agent-repair-workspace', title: 'Agent repair workspace' },
    leadRepository: 'agent-repair',
    repositories: {
      'agent-repair': {
        id: 'agent-repair', url: remote, defaultBranch: 'main', required: true,
        path: 'repos/agent-repair', role: 'lead', capabilities: []
      }
    }
  };
  const registry = path.join(root, 'workspaces.json');
  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rememberWorkspace(registry, manifest);

  const blocked = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.planId, undefined, 'an invalid contract cannot produce an applicable plan');
  assert.equal(blocked.results[0].status, 'blocked');
  assert.match(blocked.results[0].error, /testing.*default governed agent/i);
  assert.deepEqual(blocked.results[0].repair, {
    kind: 'packaged-agents',
    label: 'Restore packaged agents',
    paths: ['.github/agents/qa.agent.md']
  });
  assert.ok(blocked.results[0].conflicts.some((entry) =>
    entry.path === '.github/agents/qa.agent.md' && entry.resolution === 'preserved-local'));

  const repaired = await refreshWorkspaceConfigurations({
    registryFile: registry,
    dryRun: true,
    resolutions: { '.github/agents/qa.agent.md': 'bundled' }
  });
  assert.equal(repaired.status, 'preview');
  assert.match(repaired.planId, /^cfgp-[a-f0-9]{24}$/);
  assert.ok(repaired.results[0].conflicts.some((entry) =>
    entry.path === '.github/agents/qa.agent.md' && entry.resolution === 'accepted-bundled'));
});

test('concurrent identical configuration refreshes join the winning commit without a review branch', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-concurrent-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote } = await repositoryFixture(root, 'concurrent');
  const workspaceRoot = path.join(root, 'workspace');
  const manifest = {
    version: 1,
    id: 'concurrent-refresh-workspace',
    name: 'Concurrent refresh workspace',
    path: workspaceRoot,
    anchor: { provider: 'workspace', key: 'concurrent-refresh-workspace', title: 'Concurrent refresh workspace' },
    leadRepository: 'concurrent',
    repositories: {
      concurrent: {
        id: 'concurrent', url: remote, defaultBranch: 'main', required: true,
        path: 'repos/concurrent', role: 'lead', capabilities: []
      }
    }
  };
  const registry = path.join(root, 'workspaces.json');
  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rememberWorkspace(registry, manifest);

  const results = await Promise.all([
    refreshWorkspaceConfigurations({ registryFile: registry }),
    refreshWorkspaceConfigurations({ registryFile: registry })
  ]);
  assert.ok(results.every((result) => result.status === 'complete'), JSON.stringify(results, null, 2));
  assert.ok(results.flatMap((result) => result.results)
    .every((result) => result.status !== 'review-required'));
  const approved = YAML.parse(run('git', [
    '--git-dir', remote, 'show', 'sflow/config:singularity/workflow.yml'
  ]).stdout);
  assert.ok(approved.workTypes['spec-driven-standard']);
  assert.equal(run('git', [
    '--git-dir', remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/sflow/config-refresh/'
  ]).stdout.trim(), '');
});

test('a confirmed refresh plan binds the default conflict-resolution policy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-policy-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'policy-plan');
  const before = run('git', ['--git-dir', remote, 'rev-parse', 'sflow/config']).stdout.trim();

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  assert.ok(preview.results[0].conflicts.some((entry) => entry.resolution === 'preserved-local'));
  const switchedPolicy = await refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: preview.planId,
    acceptBundledConflicts: true
  });

  assert.equal(switchedPolicy.status, 'blocked');
  assert.equal(switchedPolicy.results[0].status, 'stale-plan');
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'sflow/config']).stdout.trim(), before,
    'changing conflict policy after preview must not publish different bytes');
});

test('configuration refresh reconstructs a cached checkout without ignored injected assets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-cache-injection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'cache-injection');

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  const checkout = await cachedConfigurationCheckout(registry, preview.planId);
  const injected = 'singularity/templates/feature/injected-from-preview-cache.md';
  await writeFile(path.join(checkout, '.git/info/exclude'), `${injected}\n`);
  await mkdir(path.dirname(path.join(checkout, injected)), { recursive: true });
  await writeFile(path.join(checkout, injected), 'must never become approved configuration\n');
  assert.equal(git(checkout, ['status', '--porcelain', '--untracked-files=all']), '',
    'the hostile cache file is intentionally hidden from ordinary status');

  const applied = await refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: preview.planId
  });
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  for (const branch of ['sflow/config', 'state']) {
    const observed = run('git', ['--git-dir', remote, 'show', `${branch}:${injected}`], {
      allowFailure: true
    });
    assert.notEqual(observed.status, 0, `${branch} must not receive an ignored cache-only asset`);
  }
});

test('configuration refresh reclaims an old cache lock only after its owner is dead', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-cache-stale-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { registry } = await registeredRepositoryFixture(root, 'cache-stale-lock');

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  const { lock } = await plantConfigurationCacheLock(registry, {
    // Outside the portable process-ID range used by the supported hosts, and therefore not live.
    pid: 2_147_483_647,
    token: '00000000-0000-4000-8000-000000000001'
  });

  const timer = commandTimer('configuration-refresh-stale-cache-lock');
  const applied = await withCommandTiming(timer, () => refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: preview.planId
  }));
  const counters = timer.finish().counters;
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.equal(counters['git.remote.command.clone'] ?? 0, 0,
    'a dead stale lease should be reclaimed so the retained preview remains reusable');
  assert.equal(await readFile(path.join(lock, '.owner.json'), 'utf8').catch(() => null), null,
    'the stale acquisition pathname must be released');
  assert.ok((await readdir(path.dirname(lock))).some((entry) =>
    entry === '.operation-lock-reclaimed-00000000-0000-4000-8000-000000000001'),
  'the deterministic tombstone prevents a paused stale reclaimer from stealing a successor lock');
});

test('configuration refresh never steals an old cache lock from a live owner', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-cache-live-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { registry } = await registeredRepositoryFixture(root, 'cache-live-lock');

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  const { lock, owner } = await plantConfigurationCacheLock(registry, {
    pid: process.pid,
    token: '00000000-0000-4000-8000-000000000002'
  });

  const timer = commandTimer('configuration-refresh-live-cache-lock');
  const applied = await withCommandTiming(timer, () => refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: preview.planId
  }));
  const counters = timer.finish().counters;
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.equal(counters['git.remote.command.clone'], 1,
    'a live lease must make the optional cache fall back to a fresh clone instead of being stolen');
  assert.deepEqual(JSON.parse(await readFile(path.join(lock, '.owner.json'), 'utf8')), owner,
    'the live owner receipt must remain byte-for-byte authoritative');
});

test('confirmed cache apply preserves literal query and fragment characters in local remote paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-cache-literal-remote-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await registeredRepositoryFixture(root, 'authority-blue');
  const remote = path.join(root, 'authority?blue.git');
  await rename(fixture.remote, remote);
  const manifestPath = path.join(root, 'workspace', 'workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.repositories['authority-blue'].url = remote;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const registry = fixture.registry;
  const decoy = remote.replace(/\?.*$/, '');
  const before = run('git', ['--git-dir', remote, 'rev-parse', 'sflow/config']).stdout.trim();

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  run('git', ['clone', '--quiet', '--bare', remote, decoy]);

  const applied = await refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: preview.planId
  });
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.notEqual(run('git', ['--git-dir', remote, 'rev-parse', 'sflow/config']).stdout.trim(), before,
    'the exact registered remote must receive the approved configuration');
  assert.equal(run('git', ['--git-dir', decoy, 'rev-parse', 'sflow/config']).stdout.trim(), before,
    'a diagnostic-redaction collision must never become transport authority');
});

test('direct refresh ignores ambient URL rewrites for observation and both publications', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-url-rewrite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'rewrite-authority');
  const decoy = path.join(root, 'rewrite-decoy.git');
  run('git', ['clone', '--quiet', '--bare', remote, decoy]);
  const authorityBefore = git(remote, ['rev-parse', 'refs/heads/sflow/config']);
  const decoyBefore = git(decoy, ['rev-parse', 'refs/heads/sflow/config']);

  const applied = await withGitUrlRewrite(remote, decoy, () =>
    refreshWorkspaceConfigurations({ registryFile: registry }));
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.notEqual(git(remote, ['rev-parse', 'refs/heads/sflow/config']), authorityBefore,
    'the exact registered authority receives the refreshed configuration');
  assert.equal(git(decoy, ['rev-parse', 'refs/heads/sflow/config']), decoyBefore,
    'an ambient insteadOf target receives no configuration update');
  assert.equal(run('git', [
    '--git-dir', decoy, 'show-ref', '--verify', '--quiet', 'refs/heads/state'
  ], { allowFailure: true }).status, 1,
  'an ambient pushInsteadOf target receives no state projection');
});

test('confirmed first-authority refresh keeps initialization on its previewed exact URL', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-init-rewrite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'rewrite-initialize');
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
  const decoy = path.join(root, 'rewrite-initialize-decoy.git');
  run('git', ['clone', '--quiet', '--bare', remote, decoy]);

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview', JSON.stringify(preview, null, 2));
  assert.equal(preview.results[0].status, 'would-initialize');
  const applied = await withGitUrlRewrite(remote, decoy, () =>
    refreshWorkspaceConfigurations({ registryFile: registry, confirmPlan: preview.planId }));
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.equal(run('git', [
    '--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/sflow/config'
  ], { allowFailure: true }).status, 0,
  'the previewed exact authority receives its initial configuration branch');
  assert.equal(run('git', [
    '--git-dir', decoy, 'show-ref', '--verify', '--quiet', 'refs/heads/sflow/config'
  ], { allowFailure: true }).status, 1,
  'a rewrite target cannot receive first-authority creation');
});

test('refresh preview, cache-miss clone, and confirmed apply share one sanitized enterprise Git environment', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-cache-hostile-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { registry } = await registeredRepositoryFixture(root, 'cache-hostile-env');

  const hooks = path.join(root, 'inherited-hooks');
  const hookEvidence = path.join(root, 'inherited-hook-ran');
  await mkdir(hooks);
  const hook = `#!/bin/sh\nprintf 'unsafe\\n' > ${JSON.stringify(hookEvidence)}\n`;
  for (const name of ['pre-commit', 'pre-push']) {
    await writeFile(path.join(hooks, name), hook);
    await chmod(path.join(hooks, name), 0o700);
  }
  const attackerGitDir = path.join(root, 'attacker.git');
  const attackerWorkTree = path.join(root, 'attacker-worktree');
  run('git', ['init', '--bare', '--quiet', attackerGitDir]);
  await mkdir(attackerWorkTree);
  const hostile = {
    GIT_DIR: attackerGitDir,
    GIT_WORK_TREE: attackerWorkTree,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooks
  };
  const previous = Object.fromEntries(Object.keys(hostile).map((key) => [key, process.env[key]]));
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  t.after(restore);

  const timer = commandTimer('configuration-refresh-hostile-process-env');
  let preview;
  let applied;
  try {
    Object.assign(process.env, hostile);
    preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
    assert.equal(preview.status, 'preview', JSON.stringify(preview, null, 2));
    applied = await withCommandTiming(timer, () => refreshWorkspaceConfigurations({
      registryFile: registry,
      confirmPlan: preview.planId
    }));
  } finally {
    restore();
  }
  const counters = timer.finish().counters;
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.equal(counters['git.remote.command.clone'] ?? 0, 0,
    'the hardened cached checkout should remain reusable under a hostile caller environment');
  assert.equal(await readFile(hookEvidence, 'utf8').catch(() => null), null,
    'inherited command-scoped hooks must not run during cached commit or push');
});

test('configuration refresh discards hostile cached Git replacement and graft metadata', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-cache-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'cache-metadata');

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  const checkout = await cachedConfigurationCheckout(registry, preview.planId);
  const approved = git(checkout, ['rev-parse', 'HEAD']);
  const injected = 'singularity/templates/feature/injected-by-replacement.md';
  await mkdir(path.dirname(path.join(checkout, injected)), { recursive: true });
  await writeFile(path.join(checkout, injected), 'must never become approved configuration\n');
  git(checkout, ['add', injected]);
  run('git', [
    '-c', 'user.name=Hostile Cache', '-c', 'user.email=cache@example.invalid',
    'commit', '-m', 'Untrusted replacement tree'
  ], { cwd: checkout });
  const replacement = git(checkout, ['rev-parse', 'HEAD']);
  git(checkout, ['update-ref', `refs/replace/${approved}`, replacement]);
  await writeFile(path.join(checkout, '.git/info/grafts'), `${approved}\n`);

  const applied = await refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: preview.planId
  });
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  for (const branch of ['sflow/config', 'state']) {
    const observed = run('git', ['--git-dir', remote, 'show', `${branch}:${injected}`], {
      allowFailure: true
    });
    assert.notEqual(observed.status, 0,
      `${branch} must be derived from the observed authority, not cached replacement metadata`);
  }
});

test('configuration refresh rejects cached Git common-directory indirection', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-cache-commondir-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { registry } = await registeredRepositoryFixture(root, 'cache-commondir');

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  const checkout = await cachedConfigurationCheckout(registry, preview.planId);
  const externalCommon = path.join(root, 'attacker-controlled-common.git');
  run('git', ['init', '--bare', '-q', externalCommon]);
  await writeFile(path.join(checkout, '.git/commondir'), `${externalCommon}\n`);

  const timer = commandTimer('configuration-refresh-hostile-commondir');
  const applied = await withCommandTiming(timer, () => refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: preview.planId
  }));
  const counters = timer.finish().counters;
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.equal(counters['git.remote.command.clone'], 1,
    'a cached checkout that redirects its Git common directory must be discarded and cloned fresh');
});

test('configuration refresh ignores a preplanted cache root without its ownership record', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-cache-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { registry } = await registeredRepositoryFixture(root, 'cache-owner');
  const cacheRoot = path.join(root, '.configuration-refresh-cache');
  await mkdir(cacheRoot, { mode: 0o700 });
  const sentinel = path.join(cacheRoot, 'unowned-data.txt');
  await writeFile(sentinel, 'not owned by Singularity Flow\n');

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  assert.equal(await readFile(sentinel, 'utf8'), 'not owned by Singularity Flow\n',
    'refresh must not prune or adopt an unowned cache directory');

  const timer = commandTimer('configuration-refresh-unowned-cache');
  const applied = await withCommandTiming(timer, () => refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: preview.planId
  }));
  const counters = timer.finish().counters;
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.equal(counters['git.remote.command.clone'], 1,
    'an unowned optional cache root is ignored rather than trusted or made fatal');
  assert.equal(await readFile(sentinel, 'utf8'), 'not owned by Singularity Flow\n');
});

test('configuration refresh disables its optional cache beneath an unsafe shared parent', {
  skip: process.platform === 'win32'
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-cache-shared-parent-'));
  t.after(async () => {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const { registry } = await registeredRepositoryFixture(root, 'cache-shared-parent');
  await chmod(root, 0o777);

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  assert.equal(await readdir(root).then((entries) => entries.includes('.configuration-refresh-cache')), false,
    'an optional cache must not create a replaceable pathname in a non-sticky shared parent');

  const timer = commandTimer('configuration-refresh-unsafe-cache-parent');
  const applied = await withCommandTiming(timer, () => refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: preview.planId
  }));
  const counters = timer.finish().counters;
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.equal(counters['git.remote.command.clone'], 1,
    'cache refusal is a safe performance fallback and must not block configuration refresh');
});

test('configuration refresh disables cache when a private parent has an unsafe writable ancestor', {
  skip: process.platform === 'win32'
}, async (t) => {
  const outer = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-cache-unsafe-ancestor-'));
  const root = path.join(outer, 'private-registry-parent');
  await mkdir(root, { mode: 0o700 });
  t.after(async () => {
    await chmod(outer, 0o700).catch(() => {});
    await rm(outer, { recursive: true, force: true });
  });
  const { registry } = await registeredRepositoryFixture(root, 'cache-unsafe-ancestor');
  await chmod(outer, 0o777);

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  assert.equal(await readdir(root).then((entries) => entries.includes('.configuration-refresh-cache')), false,
    'a private direct parent does not make its own replaceable pathname safe');

  const timer = commandTimer('configuration-refresh-unsafe-cache-ancestor');
  const applied = await withCommandTiming(timer, () => refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: preview.planId
  }));
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.equal(timer.finish().counters['git.remote.command.clone'], 1);
});

test('configuration refresh refuses a cache pathname carrying an inherited write ACL', {
  skip: process.platform !== 'darwin'
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-cache-acl-'));
  t.after(async () => {
    run('chmod', ['-N', root], { allowFailure: true });
    await rm(root, { recursive: true, force: true });
  });
  const { registry } = await registeredRepositoryFixture(root, 'cache-acl');
  run('chmod', [
    '+a',
    'everyone allow list,search,add_file,add_subdirectory,delete_child,file_inherit,directory_inherit',
    root
  ]);

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  assert.equal(await readdir(root).then((entries) => entries.includes('.configuration-refresh-cache')), false,
    'classic 0700/0600 mode bits must not hide an inherited ACL write authority');

  const timer = commandTimer('configuration-refresh-cache-acl');
  const applied = await withCommandTiming(timer, () => refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: preview.planId
  }));
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.equal(timer.finish().counters['git.remote.command.clone'], 1);
});

test('all-workspace refresh leaves a dirty clone untouched and mirrors approved configuration to state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, repository } = await repositoryFixture(root);

  const workspaceRoot = path.join(root, 'workspace');
  const manifest = {
    version: 1,
    id: 'refresh-workspace',
    name: 'Refresh workspace',
    path: workspaceRoot,
    anchor: { provider: 'workspace', key: 'refresh-workspace', title: 'Refresh workspace' },
    leadRepository: 'application',
    repositories: {
      application: {
        id: 'application', url: remote, defaultBranch: 'main', required: true,
        path: 'repos/application', role: 'lead', capabilities: []
      }
    }
  };
  const registry = path.join(root, 'workspaces.json');
  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rememberWorkspace(registry, manifest);

  await writeFile(path.join(repository, 'application.txt'), 'dirty application work\n');
  const dirtyBefore = git(repository, ['status', '--porcelain']);
  const headBefore = git(repository, ['rev-parse', 'HEAD']);

  // An older install mirrored configuration below configuration/files and also left one retired
  // canonical policy file. Runtime world-model bytes share the state branch but are not part of the
  // configuration projection and must survive the migration exactly.
  const statePublisher = path.join(root, 'state-publisher');
  run('git', ['init', '--initial-branch=state', statePublisher]);
  git(statePublisher, ['config', 'user.name', 'Configuration Test']);
  git(statePublisher, ['config', 'user.email', 'configuration@example.test']);
  await mkdir(path.join(statePublisher, 'configuration/files/singularity'), { recursive: true });
  await mkdir(path.join(statePublisher, 'singularity/world-model'), { recursive: true });
  await writeFile(path.join(statePublisher, 'configuration/manifest.json'),
    '{"format":"singularity-flow-configuration-mirror/v1"}\n');
  await writeFile(path.join(statePublisher, 'configuration/files/singularity/workflow.yml'), 'legacy: true\n');
  await writeFile(path.join(statePublisher, 'singularity/obsolete-policy.yml'), 'retired: true\n');
  const worldModelBytes = Buffer.from('expensive world model: preserve exactly\n');
  await writeFile(path.join(statePublisher, 'singularity/world-model/model.md'), worldModelBytes);
  git(statePublisher, ['add', '-A']);
  git(statePublisher, ['commit', '-m', 'Seed legacy state projection']);
  git(statePublisher, ['remote', 'add', 'origin', remote]);
  git(statePublisher, ['push', 'origin', 'HEAD:state']);

  const previewTimer = commandTimer('configuration-refresh-preview');
  const preview = await withCommandTiming(previewTimer, () =>
    refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true }));
  const previewCounters = previewTimer.finish().counters;
  assert.equal(preview.status, 'preview');
  assert.match(preview.planId, /^cfgp-[a-f0-9]{24}$/);
  assert.equal(preview.results[0].stateStatus, 'would-follow-configuration');
  assert.equal(previewCounters['git.remote.command.clone'], 1);
  assert.equal(previewCounters['git.remote.command.fetch'], 1);

  const applyTimer = commandTimer('configuration-refresh-apply');
  const result = await withCommandTiming(applyTimer, () => refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: preview.planId
  }));
  const applyCounters = applyTimer.finish().counters;
  assert.equal(result.status, 'complete');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].configurationChanged, true);
  assert.equal(result.results[0].stateChanged, true);
  assert.equal(applyCounters['git.remote.command.ls-remote'], 2,
    'apply re-observes the source authority after the exact state publication CAS');
  assert.equal(applyCounters['git.remote.command.clone'] ?? 0, 0,
    'apply reuses the SHA-bound preview clone instead of cloning the authority again');
  assert.equal(applyCounters['git.remote.command.fetch'] ?? 0, 0,
    'apply inspects the preview-bound state object without a duplicate fetch');
  assert.equal(git(repository, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(repository, ['status', '--porcelain']), dirtyBefore);

  const approved = YAML.parse(run('git', [
    '--git-dir', remote, 'show', 'sflow/config:singularity/workflow.yml'
  ]).stdout);
  assert.equal(approved.phases.implementation.generation.task, 'code');
  assert.equal(approved.defaultBaseBranch, 'release');
  const manifestText = run('git', [
    '--git-dir', remote, 'show', `state:${STATE_CONFIGURATION_MANIFEST}`
  ]).stdout;
  const mirror = JSON.parse(manifestText);
  assert.equal(mirror.format, 'singularity-flow-configuration-mirror/v2');
  assert.equal(mirror.layout, 'canonical-paths');
  assert.equal(mirror.source.commit, run('git', ['--git-dir', remote, 'rev-parse', 'sflow/config']).stdout.trim());
  assert.equal(mirror.assets['singularity/workflow.yml'].sha256,
    mirror.files['singularity/workflow.yml']);
  assert.match(mirror.assets['singularity/workflow.yml'].object, /^[0-9a-f]{40,64}$/);
  assert.match(mirror.assets['singularity/workflow.yml'].mode, /^100(?:644|755)$/);
  const mirroredWorkflow = run('git', [
    '--git-dir', remote, 'show', 'state:singularity/workflow.yml'
  ]).stdout;
  assert.equal(YAML.parse(mirroredWorkflow).phases.implementation.generation.task, 'code');
  assert.equal(run('git', [
    '--git-dir', remote, 'show', 'state:configuration/files/singularity/workflow.yml'
  ], { allowFailure: true }).status, 128);
  assert.equal(run('git', [
    '--git-dir', remote, 'show', 'state:singularity/obsolete-policy.yml'
  ], { allowFailure: true }).status, 128);
  assert.deepEqual(run('git', [
    '--git-dir', remote, 'show', 'state:singularity/world-model/model.md'
  ], { encoding: 'buffer' }).stdout, worldModelBytes);

  const current = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(current.results[0].status, 'current');
  assert.equal(current.results[0].configurationChanged, false);
  assert.equal(current.results[0].stateChanged, false);

  // A cached preview is acceleration, not authority. If state moves before apply, exact ref
  // revalidation must discard the cache and refuse the now-stale plan before changing config.
  const staleStatePreview = current;
  const stateMover = path.join(root, 'state-mover');
  run('git', ['clone', '--quiet', '--single-branch', '--branch', 'state', remote, stateMover]);
  git(stateMover, ['config', 'user.name', 'Configuration Test']);
  git(stateMover, ['config', 'user.email', 'configuration@example.test']);
  await writeFile(path.join(stateMover, 'runtime-marker.txt'), 'concurrent state movement\n');
  git(stateMover, ['add', 'runtime-marker.txt']);
  git(stateMover, ['commit', '-m', 'Advance runtime state after preview']);
  git(stateMover, ['push', 'origin', 'state']);
  const configBeforeStaleApply = run('git', [
    '--git-dir', remote, 'rev-parse', 'sflow/config'
  ]).stdout.trim();
  const staleStateApply = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: staleStatePreview.planId
  });
  assert.equal(staleStateApply.status, 'blocked');
  assert.equal(staleStateApply.results[0].status, 'stale-plan');
  assert.equal(run('git', [
    '--git-dir', remote, 'rev-parse', 'sflow/config'
  ]).stdout.trim(), configBeforeStaleApply);

  // A preview-bound UI apply may also be the first operation to establish sflow/config. Its plan
  // must be checked before initialization, then remain valid across that intentional branch create.
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
  let initializePreview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(initializePreview.results[0].status, 'would-initialize');

  // The application branch is the source of a first authority. Moving it after preview must make
  // that preview stale; otherwise apply would approve configuration bytes that were never shown.
  const mover = path.join(root, 'application-mover');
  run('git', ['clone', '--quiet', remote, mover]);
  git(mover, ['config', 'user.name', 'Configuration Test']);
  git(mover, ['config', 'user.email', 'configuration@example.test']);
  await writeFile(path.join(mover, 'post-preview.txt'), 'move bootstrap source\n');
  git(mover, ['add', 'post-preview.txt']);
  git(mover, ['commit', '-m', 'Move application after refresh preview']);
  git(mover, ['push', 'origin', 'main']);
  const staleInitialization = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: initializePreview.planId
  });
  assert.equal(staleInitialization.status, 'blocked');
  assert.equal(staleInitialization.results[0].status, 'stale-plan');
  assert.equal(run('git', [
    '--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/sflow/config'
  ], { allowFailure: true }).status, 128, 'a stale preview cannot create configuration authority');

  initializePreview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  const initialized = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: initializePreview.planId
  });
  assert.equal(initialized.status, 'complete');
  assert.match(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config']).stdout.trim(),
    /^[a-f0-9]{40}$/);
});

test('workspace refresh mirrors and verifies configured asset roots outside conventional directories', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-refresh-custom-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote } = await repositoryFixture(root, 'custom-roots');

  const publisher = path.join(root, 'custom-configuration-publisher');
  run('git', ['clone', '--quiet', '--single-branch', '--branch', 'sflow/config', remote, publisher]);
  git(publisher, ['config', 'user.name', 'Configuration Test']);
  git(publisher, ['config', 'user.email', 'configuration@example.test']);
  const workflowFile = path.join(publisher, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.templatesRoot = 'governed/templates';
  workflow.agentPromptsRoot = 'governed/agents';
  workflow.worldModel.outputDir = 'governed/world-model';
  await writeFile(workflowFile, YAML.stringify(workflow));
  await mkdir(path.join(publisher, 'governed/templates/common'), { recursive: true });
  await mkdir(path.join(publisher, 'governed/agents'), { recursive: true });
  await writeFile(path.join(publisher, 'governed/templates/common/custom.md'), 'custom template\n');
  await writeFile(path.join(publisher, 'governed/agents/custom.agent.md'), 'custom agent\n');
  git(publisher, ['add', '-A']);
  git(publisher, ['commit', '-m', 'Configure external governed roots']);
  git(publisher, ['push', 'origin', 'HEAD:sflow/config']);

  const statePublisher = path.join(root, 'custom-state-publisher');
  run('git', ['init', '--initial-branch=state', statePublisher]);
  git(statePublisher, ['config', 'user.name', 'Configuration Test']);
  git(statePublisher, ['config', 'user.email', 'configuration@example.test']);
  await mkdir(path.join(statePublisher, 'governed/world-model'), { recursive: true });
  const worldModelBytes = Buffer.from('expensive custom world model: preserve exactly\n');
  await writeFile(path.join(statePublisher, 'governed/world-model/manifest.json'), worldModelBytes);
  git(statePublisher, ['add', '-A']);
  git(statePublisher, ['commit', '-m', 'Seed custom world-model state']);
  git(statePublisher, ['remote', 'add', 'origin', remote]);
  git(statePublisher, ['push', 'origin', 'HEAD:state']);

  const workspaceRoot = path.join(root, 'workspace');
  const manifest = {
    version: 1,
    id: 'custom-root-workspace',
    name: 'Custom root workspace',
    path: workspaceRoot,
    anchor: { provider: 'workspace', key: 'custom-root-workspace', title: 'Custom root workspace' },
    leadRepository: 'custom-roots',
    repositories: {
      'custom-roots': {
        id: 'custom-roots', url: remote, defaultBranch: 'main', required: true,
        path: 'repos/custom-roots', role: 'lead', capabilities: []
      }
    }
  };
  const registry = path.join(root, 'workspaces.json');
  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rememberWorkspace(registry, manifest);

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  const applied = await refreshWorkspaceConfigurations({ registryFile: registry, confirmPlan: preview.planId });
  assert.equal(applied.status, 'complete');
  assert.equal(applied.results[0].stateChanged, true);
  assert.equal(run('git', [
    '--git-dir', remote, 'show', 'state:governed/templates/common/custom.md'
  ]).stdout, 'custom template\n');
  assert.equal(run('git', [
    '--git-dir', remote, 'show', 'state:governed/agents/custom.agent.md'
  ]).stdout, 'custom agent\n');
  assert.deepEqual(run('git', [
    '--git-dir', remote, 'show', 'state:governed/world-model/manifest.json'
  ], { encoding: 'buffer' }).stdout, worldModelBytes);

  const current = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(current.results[0].status, 'current');
  assert.equal(current.results[0].configurationChanged, false);
  assert.equal(current.results[0].stateChanged, false);
});
