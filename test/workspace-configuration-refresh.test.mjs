import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile
} from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { run } from '../src/util.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { gitEmptyConfigPath } from '../src/git-isolation-paths.mjs';
import { rememberWorkspace } from '../src/workspace.mjs';
import { installWorkflow } from '../src/workflow-catalog.mjs';
import { loadDefinition } from '../src/config.mjs';
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

async function initializeStatePublisher(root) {
  run('git', ['init', '--initial-branch=state', root]);
  git(root, ['config', 'user.name', 'Configuration Test']);
  git(root, ['config', 'user.email', 'configuration@example.test']);
  await mkdir(path.join(root, 'ledger'), { recursive: true });
  await writeFile(path.join(root, 'README.md'),
    '# Singularity Flow Capability Ledger\n\n'
    + 'This orphan branch is an append-only workflow ledger. It has no shared ancestry with application branches and must never be merged into them.\n');
  await writeFile(path.join(root, 'ledger/head.json'), `${JSON.stringify({
    schemaVersion: 1,
    sequence: 0,
    entryHash: null,
    previousHeadHash: null,
    updatedAt: '2026-01-01T00:00:00.000Z'
  })}\n`);
  git(root, ['add', 'README.md', 'ledger/head.json']);
  git(root, ['commit', '-m', 'Initialize Singularity Flow capability ledger']);
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
  assert.throws(() => isolatedCacheGitEnvironment({
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
  }), (error) => {
    assert.equal(error?.code, 'GIT_ENTERPRISE_CONFIG_UNAVAILABLE');
    assert.equal(error?.details?.scope, rejectedScope);
    assert.equal(typeof error?.details?.reason, 'string');
    assert.doesNotMatch(JSON.stringify(error), /corporate-manager|must-not-survive|launcher failed/);
    return true;
  });
  assert.deepEqual(calls, ['system', 'global'],
    `${rejectedScope} rejection must not prevent inspecting ${acceptedScope}`);
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
  assert.throws(() => isolatedCacheGitEnvironment({ PATH: process.env.PATH }, {
    runCommand(_command, args) {
      return {
        status: 0,
        stdout: encodedGitConfiguration(args.includes('--system')
          ? entries('system', 200) : entries('global', 100)),
        stderr: '', timedOut: false
      };
    }
  }), (error) => error?.code === 'GIT_ENTERPRISE_CONFIG_UNAVAILABLE'
    && error?.details?.scope === 'combined'
    && error?.details?.reason === 'entry-limit',
  'an over-budget ordered snapshot must refuse instead of silently losing credential helpers');
});

test('an indeterminate global scope cannot reactivate a system credential helper that it may reset', () => {
  assert.throws(() => isolatedCacheGitEnvironment({ PATH: process.env.PATH }, {
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
  }), (error) => error?.code === 'GIT_ENTERPRISE_CONFIG_UNAVAILABLE'
    && error?.details?.scope === 'global');
});

test('an indeterminate system scope cannot change URL-specific precedence', () => {
  assert.throws(() => isolatedCacheGitEnvironment({ PATH: process.env.PATH }, {
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
  }), (error) => error?.code === 'GIT_ENTERPRISE_CONFIG_UNAVAILABLE'
    && error?.details?.scope === 'system',
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

test('enterprise Git preflight keeps a configured five-second deadline for slow office config reads', () => {
  const deadlines = [];
  const isolated = isolatedCacheGitEnvironment({
    PATH: process.env.PATH,
    SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS: '5000'
  }, {
    runCommand(_command, _args, options) {
      deadlines.push(options.timeoutMs);
      return { status: 1, stdout: '', stderr: '', timedOut: false };
    }
  });
  assert.deepEqual(deadlines, [5_000, 5_000]);
  assert.deepEqual(commandScopedGitConfiguration(isolated), []);
});

test('a signal-terminated empty scope is indeterminate and fails the whole snapshot closed', () => {
  for (const interruptedScope of ['system', 'global']) {
    assert.throws(() => isolatedCacheGitEnvironment({ PATH: process.env.PATH }, {
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
    }), (error) => error?.code === 'GIT_ENTERPRISE_CONFIG_UNAVAILABLE'
      && error?.details?.scope === interruptedScope);
  }
});

test('a successful-looking interrupted enterprise scope is still indeterminate', () => {
  for (const interruption of [
    { signal: 'SIGTERM' },
    { aborted: true }
  ]) {
    for (const interruptedScope of ['system', 'global']) {
      assert.throws(() => isolatedCacheGitEnvironment({ PATH: process.env.PATH }, {
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
      }), (error) => error?.code === 'GIT_ENTERPRISE_CONFIG_UNAVAILABLE'
        && error?.details?.scope === interruptedScope,
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
  assert.equal(isolated.GIT_CONFIG_GLOBAL, gitEmptyConfigPath());
  assert.equal(isolated.GIT_CONFIG_SYSTEM, gitEmptyConfigPath());
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
  // Keep the shared phase a code-delivery phase: other installed work types now bind their test
  // evidence to it, so changing its task to analyze would make the entire fixture invalid before
  // installWorkflow can perform the replacement this test exercises.
  workflow.phases.implementation.worldModel.depth = 'deep';
  await writeFile(workflowFile, YAML.stringify(workflow));

  await installWorkflow(root, 'feature', { replace: true });
  const replaced = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(replaced.phases.implementation.worldModel.depth, 'standard');
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

test('seeded reinitialization restores missing framework seeds and preserves every customized value', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-reinitialize-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  await refreshPackagedConfiguration(root);

  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const bundled = YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
  const local = YAML.parse(await readFile(workflowFile, 'utf8'));
  const customPhase = structuredClone(local.phases['poc-lite-plan']);
  customPhase.label = 'Repository-owned customer review';
  customPhase.defaultTemplate = 'customer/review.md';
  customPhase.artifact = {
    path: 'artifacts/customer-review/review.md', kind: 'delivery-plan', minimumBytes: 10
  };
  customPhase.artifactSet = 'customer-review-set';
  local.phases['customer-review'] = customPhase;
  local.artifactSets['customer-review-set'] = {
    primary: 'review.md',
    members: [{ path: 'review.md', role: 'customer-review', required: true }]
  };
  local.workTypes['customer-delivery'] = {
    label: 'Customer delivery',
    description: 'A repository-owned workflow that package upgrades must preserve exactly.',
    phases: ['customer-review'],
    plannedClaims: { mode: 'opt-out', reason: 'Repository-owned review-only workflow.' },
    intelligence: { worldModel: 'off', ast: 'off', agentBriefs: 'off' },
    metadata: { owner: 'customer-platform', revision: 7 }
  };
  local.logging.level = 'debug';
  local.approvalAuthorities['product-approvers'].label = 'Repository product approvers';
  delete local.approvalAuthorities['design-reviewers'];

  const packagedWorkTypeIds = Object.keys(bundled.workTypes);
  const missingWorkTypeIds = new Set();
  const customizedWorkTypeIds = new Set();
  packagedWorkTypeIds.forEach((id, index) => {
    if (index % 2 === 0) {
      missingWorkTypeIds.add(id);
      delete local.workTypes[id];
    } else {
      customizedWorkTypeIds.add(id);
      local.workTypes[id].label = `Repository-customized ${id}`;
    }
  });
  for (const phase of Object.values(local.phases)) {
    if (phase !== customPhase) phase.label = `Repository-customized ${phase.label}`;
  }
  for (const artifactSet of Object.values(local.artifactSets)) {
    if (artifactSet !== local.artifactSets['customer-review-set']) {
      artifactSet.members.push({ path: 'repository-note.md', role: 'advisory-note', required: false });
    }
  }
  for (const server of Object.values(local.mcpServers)) {
    server.label = `Repository-customized ${server.label}`;
  }
  const localWorkflowText = YAML.stringify(local).replace(
    '  customer-delivery:\n',
    '  # repository-owned workflow comment must survive semantic patching\n  customer-delivery:\n'
  );
  await writeFile(workflowFile, localWorkflowText);
  // A repository-controlled receipt is not ownership evidence. Even when it falsely claims the
  // current organisation policy is the prior package value, seeded reinitialization preserves it.
  const baselineFile = path.join(root, PACKAGE_BASELINE_PATH);
  const forgedBaseline = YAML.parse(await readFile(baselineFile, 'utf8'));
  forgedBaseline.workflow.logging = structuredClone(local.logging);
  await writeFile(baselineFile, YAML.stringify(forgedBaseline));

  const customTemplate = path.join(root, 'singularity/templates/customer/review.md');
  const customTemplateBytes = '# Customer review\n\nRepository-owned template bytes.\n';
  await mkdir(path.dirname(customTemplate), { recursive: true });
  await writeFile(customTemplate, customTemplateBytes);
  const customAgent = path.join(root, '.github/agents/repository-specialist.agent.md');
  const customAgentBytes = `---
name: repository-specialist
description: Repository-owned reviewer that is not supplied by Singularity Flow.
model: [auto]
tools: [read, search]
metadata:
  sflow-label: "Repository specialist"
  sflow-phases: "customer-review"
  sflow-default-for: "customer-review"
---

# Repository specialist

Review the repository-owned customer delivery evidence without changing files.
`;
  await writeFile(customAgent, customAgentBytes);

  const packagedAgent = path.join(root, '.github/agents/developer.agent.md');
  await writeFile(packagedAgent, `${await readFile(packagedAgent, 'utf8')}\n<!-- stale seeded agent -->\n`);
  const packagedTemplate = path.join(root, 'singularity/templates/feature/requirements.md');
  await writeFile(packagedTemplate, `${await readFile(packagedTemplate, 'utf8')}\n<!-- stale seeded template -->\n`);

  const customWorkflowBefore = structuredClone(local.workTypes['customer-delivery']);
  const customPhaseBefore = structuredClone(local.phases['customer-review']);
  const customArtifactSetBefore = structuredClone(local.artifactSets['customer-review-set']);
  const customizedWorkTypesBefore = structuredClone(local.workTypes);
  const customizedPhasesBefore = structuredClone(local.phases);
  const customizedArtifactSetsBefore = structuredClone(local.artifactSets);
  const customizedMcpServersBefore = structuredClone(local.mcpServers);
  const packagedAgentBefore = await readFile(packagedAgent, 'utf8');
  const packagedTemplateBefore = await readFile(packagedTemplate, 'utf8');
  const result = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  const refreshed = YAML.parse(await readFile(workflowFile, 'utf8'));

  for (const id of packagedWorkTypeIds) {
    if (missingWorkTypeIds.has(id)) {
      assert.deepEqual(refreshed.workTypes[id], bundled.workTypes[id], `${id} was not restored exactly`);
    } else {
      assert.deepEqual(refreshed.workTypes[id], customizedWorkTypesBefore[id],
        `${id} repository customization was overwritten`);
    }
  }
  const packagedPhaseIds = new Set(packagedWorkTypeIds.flatMap((id) => bundled.workTypes[id].phases));
  for (const id of packagedPhaseIds) {
    assert.deepEqual(refreshed.phases[id], customizedPhasesBefore[id],
      `${id} phase customization was overwritten`);
  }
  for (const id of Object.keys(bundled.artifactSets)) {
    assert.deepEqual(refreshed.artifactSets[id], customizedArtifactSetsBefore[id],
      `${id} artifact-set customization was overwritten`);
  }
  for (const id of Object.keys(bundled.mcpServers)) {
    assert.deepEqual(refreshed.mcpServers[id], customizedMcpServersBefore[id],
      `${id} MCP customization was overwritten`);
  }
  assert.deepEqual(refreshed.workTypes['customer-delivery'], customWorkflowBefore);
  assert.deepEqual(refreshed.phases['customer-review'], customPhaseBefore);
  assert.deepEqual(refreshed.artifactSets['customer-review-set'], customArtifactSetBefore);
  assert.equal(refreshed.logging.level, 'debug',
    'a baseline receipt cannot reset repository-owned top-level policy');
  assert.match(await readFile(workflowFile, 'utf8'),
    /# repository-owned workflow comment must survive semantic patching/u);
  assert.equal(refreshed.approvalAuthorities['product-approvers'].label,
    'Repository product approvers', 'organisation-owned authority membership/configuration must survive');
  assert.deepEqual(refreshed.approvalAuthorities['design-reviewers'],
    bundled.approvalAuthorities['design-reviewers'], 'a missing seeded authority dependency must return');
  assert.equal(await readFile(customTemplate, 'utf8'), customTemplateBytes);
  assert.equal(await readFile(customAgent, 'utf8'), customAgentBytes);
  assert.equal(await readFile(packagedAgent, 'utf8'), packagedAgentBefore);
  assert.equal(await readFile(packagedTemplate, 'utf8'), packagedTemplateBefore);
  assert.ok(result.files.includes('singularity/workflow.yml'));
  assert.ok(!result.files.includes('.github/agents/developer.agent.md'));
  assert.ok(!result.files.includes('singularity/templates/feature/requirements.md'));
  for (const id of customizedWorkTypeIds) {
    assert.ok(result.conflicts.some((entry) =>
      entry.path === `workflow.workTypes.${id}` && entry.resolution === 'preserved-local'));
  }
  assert.ok(result.conflicts.some((entry) =>
    entry.path === '.github/agents/developer.agent.md'
      && entry.resolution === 'preserved-local'));
  assert.ok(result.conflicts.some((entry) =>
    entry.path === 'singularity/templates/feature/requirements.md'
      && entry.resolution === 'preserved-local'));

  const repeated = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.files, []);
});

test('ordinary refresh and seeded reinitialization both preserve customized seeded profiles', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-versus-reinitialize-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  await refreshPackagedConfiguration(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.workTypes.feature.label = 'Repository-customized feature';
  workflow.phases.requirements.label = 'Repository-customized requirements';
  await writeFile(workflowFile, YAML.stringify(workflow));

  await refreshPackagedConfiguration(root);
  let observed = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(observed.workTypes.feature.label, 'Repository-customized feature');
  assert.equal(observed.phases.requirements.label, 'Repository-customized requirements');

  await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  observed = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(observed.workTypes.feature.label, 'Repository-customized feature');
  assert.equal(observed.phases.requirements.label, 'Repository-customized requirements');
});

test('seeded reinitialization preserves every existing approval authority and restores only missing dependencies', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-authority-collision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  const repositoryAuthority = {
    label: 'Repository product council',
    allowAnyGitIdentity: true,
    members: [{ name: 'Company reviewer', email: 'company-reviewer@example.test' }]
  };
  workflow.approvalAuthorities['product-approvers'] = structuredClone(repositoryAuthority);
  delete workflow.approvalAuthorities['design-reviewers'];
  await writeFile(workflowFile, YAML.stringify(workflow));

  await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  const observed = YAML.parse(await readFile(workflowFile, 'utf8'));
  const bundled = YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));

  assert.deepEqual(observed.approvalAuthorities['product-approvers'], repositoryAuthority,
    'a package authority ID must not absorb fields or membership from the package');
  assert.deepEqual(observed.approvalAuthorities['design-reviewers'],
    bundled.approvalAuthorities['design-reviewers'],
    'a genuinely missing dependency should still be restored');
});

test('seeded reinitialization migrates authentic v1 role fields and retains repository-only workflow policy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-legacy-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);

  const workflowFile = path.join(root, 'singularity/workflow.yml');
  // Exact registered package bytes immediately before ba513057 replaced work-lens prompts with
  // governed Agent Markdown. This protects the real historical surface rather than merely changing
  // today's version number to 1. Repositories could also add their own contracts under that schema.
  const packagedLegacy = YAML.parse(await readFile(path.join(
    ROOT, 'test/fixtures/workflow-v1-ba513.yml'
  ), 'utf8'));
  const legacy = structuredClone(packagedLegacy);

  legacy.phases['company-intake'] = {
    ...structuredClone(legacy.phases.intake),
    label: 'Company intake',
    artifact: {
      path: 'artifacts/company-intake/intake.md', kind: 'intake', minimumBytes: 200
    },
    approval: {
      authorities: ['architecture-reviewers', 'quality-reviewers'],
      minimum: 2, rejectTo: ['company-intake']
    },
    metadata: { owner: 'company-platform', retention: 'seven-years' }
  };
  // Repository-owned phases must bind a governed Agent Markdown file directly in v2. Keeping a
  // legacy suggestion here would be ambiguous and is covered by the refusal regression below.
  delete legacy.phases['company-intake'].suggestedPersonas;
  legacy.workTypes['company-delivery'] = {
    label: 'Company delivery',
    description: 'Repository-owned workflow retained while the root schema is upgraded.',
    phases: ['company-intake'],
    phaseOverrides: {
      'company-intake': {
        approval: {
          authorities: ['architecture-reviewers', 'quality-reviewers'],
          minimum: 2, rejectTo: ['company-intake']
        }
      }
    },
    plannedClaims: { mode: 'opt-out', reason: 'Repository-owned intake-only workflow.' },
    intelligence: { worldModel: 'off', ast: 'off', agentBriefs: 'off' },
    metadata: { owner: 'company-platform', revision: 3 }
  };
  legacy.workTypes.chore.label = 'Company-maintained chore';
  legacy.defaultBaseBranch = 'release/company';
  await writeFile(workflowFile, YAML.stringify(legacy));
  const companyAgentFile = path.join(root, '.github/agents/company-architect.agent.md');
  const companyAgentBytes = `---
name: company-architect
description: Repository-owned governed agent for the company intake phase.
model: [auto]
tools: [read, search]
metadata:
  sflow-label: "Company architect"
  sflow-phases: "company-intake"
  sflow-default-for: "company-intake"
---

# Company architect

Preserve the repository-owned company intake policy and cite governed evidence.
`;
  await writeFile(companyAgentFile, companyAgentBytes);

  const result = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  const refreshed = YAML.parse(await readFile(workflowFile, 'utf8'));

  assert.equal(refreshed.version, 2,
    'the reviewed safe route upgrades the registered schema');
  assert.equal(Object.hasOwn(refreshed, 'personaPromptsRoot'), false);
  assert.equal(Object.hasOwn(refreshed, 'personas'), false);
  assert.equal(Object.hasOwn(refreshed.session, 'personaSelection'), false);
  assert.equal(Object.hasOwn(refreshed.session, 'promptOnNewSession'), false);
  assert.equal(Object.hasOwn(refreshed.session, 'promptOnResume'), false);
  assert.deepEqual(refreshed.worldModel.injection.rules, []);
  for (const phase of Object.values(refreshed.phases)) {
    assert.equal(Object.hasOwn(phase, 'suggestedPersonas'), false,
      'no legacy phase role hint may survive into v2');
  }
  assert.equal(Object.hasOwn(refreshed.phases['company-intake'], 'suggestedPersonas'), false);
  assert.deepEqual(refreshed.phases['company-intake'].approval, {
    authorities: ['architecture-reviewers', 'quality-reviewers'],
    minimum: 2,
    rejectTo: ['company-intake']
  });
  assert.deepEqual(
    refreshed.workTypes['company-delivery'].phaseOverrides['company-intake'].approval,
    {
      authorities: ['architecture-reviewers', 'quality-reviewers'],
      minimum: 2,
      rejectTo: ['company-intake']
    }
  );
  assert.deepEqual(refreshed.workTypes['company-delivery'], legacy.workTypes['company-delivery'],
    'repository work type policy must remain byte-equivalent at the data-model boundary');
  assert.equal(refreshed.workTypes['company-delivery'].metadata.owner, 'company-platform');
  assert.equal(refreshed.workTypes['company-delivery'].metadata.revision, 3);
  assert.equal(refreshed.phases['company-intake'].metadata.retention, 'seven-years');
  assert.equal(refreshed.defaultBaseBranch, 'release/company');
  const bundled = YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
  for (const id of Object.keys(packagedLegacy.workTypes).filter((id) => id !== 'chore')) {
    assert.deepEqual(refreshed.workTypes[id], bundled.workTypes[id],
      `historical framework work type '${id}' did not refresh to the current package`);
  }
  assert.deepEqual(refreshed.workTypes.chore, legacy.workTypes.chore,
    'a one-field customization of a historical package work type remains repository-owned');
  for (const id of Object.keys(packagedLegacy.phases)) {
    assert.deepEqual(refreshed.phases[id], bundled.phases[id],
      `historical framework phase '${id}' did not refresh to the current package`);
  }
  for (const id of Object.keys(bundled.artifactSets)) {
    assert.deepEqual(refreshed.artifactSets[id], bundled.artifactSets[id]);
  }
  for (const id of Object.keys(bundled.mcpServers)) {
    assert.deepEqual(refreshed.mcpServers[id], bundled.mcpServers[id]);
  }
  assert.equal(await readFile(companyAgentFile, 'utf8'), companyAgentBytes,
    'repository-created Agent Markdown must not be rewritten by schema migration');
  assert.ok(result.files.includes('singularity/workflow.yml'));
  assert.equal(result.conflicts.some((entry) => entry.path === 'workflow.version'), false,
    'the package-owned schema discriminator is not presented as user policy');
  await assert.doesNotReject(() => loadDefinition(root),
    'the migrated repository must be loadable, not merely stamped with version 2');
});

test('seeded reinitialization retires an exact registered v1 prompt with historical baseline proof', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-legacy-prompt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);

  const packagedLegacy = YAML.parse(await readFile(path.join(
    ROOT, 'test/fixtures/workflow-v1-ba513.yml'
  ), 'utf8'));
  await writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify(packagedLegacy));
  const retiredPromptRelative = 'singularity/personas/developer.md';
  const retiredPromptFile = path.join(root, retiredPromptRelative);
  const retiredPromptBytes = await readFile(path.join(
    ROOT, 'test/fixtures/persona-v1-developer.md'
  ));
  await mkdir(path.dirname(retiredPromptFile), { recursive: true });
  await writeFile(retiredPromptFile, retiredPromptBytes);
  await mkdir(path.join(root, 'singularity/.product'), { recursive: true });
  await writeFile(path.join(root, PACKAGE_BASELINE_PATH), YAML.stringify({
    format: 'singularity-flow-configuration-baseline/v1',
    product: { version: '0.8.0', revision: 'ba513057' },
    workflow: packagedLegacy,
    assets: {
      [retiredPromptRelative]: {
        sha256: createHash('sha256').update(retiredPromptBytes).digest('hex')
      }
    }
  }));

  const result = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });

  await assert.rejects(readFile(retiredPromptFile), (error) => error?.code === 'ENOENT',
    'an exact registered historical package prompt should be retired');
  assert.ok(result.removed.includes(retiredPromptRelative));
  await assert.doesNotReject(() => loadDefinition(root));
});

test('seeded reinitialization refuses a repository-created legacy persona without writing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-legacy-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const legacy = YAML.parse(await readFile(workflowFile, 'utf8'));
  legacy.version = 1;
  legacy.personaPromptsRoot = 'singularity/personas';
  legacy.personas = {
    'release-captain': { label: 'Release captain', prompt: 'release-captain.md' }
  };
  legacy.phases.release.suggestedPersonas = ['release-captain'];
  legacy.phases.release.approval = {
    personas: ['release-captain'], minimum: 1, rejectTo: ['release']
  };
  const before = YAML.stringify(legacy);
  await writeFile(workflowFile, before);

  await assert.rejects(
    () => refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
    (error) => error?.code === 'LEGACY_PERSONA_MIGRATION_UNSAFE'
      && /persona 'release-captain' is repository-created/.test(error.message)
  );
  assert.equal(await readFile(workflowFile, 'utf8'), before,
    'a repository-created persona must not be deleted or partially rewritten');
  await assert.rejects(
    () => readFile(path.join(root, PACKAGE_BASELINE_PATH), 'utf8'),
    (error) => error?.code === 'ENOENT',
    'refusal must happen before an ownership receipt is written'
  );
});

test('seeded reinitialization refuses repository-created suggested-persona routing without writing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-legacy-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const legacy = YAML.parse(await readFile(path.join(
    ROOT, 'test/fixtures/workflow-v1-ba513.yml'
  ), 'utf8'));
  legacy.phases['company-review'] = {
    ...structuredClone(legacy.phases.design),
    label: 'Company review',
    suggestedPersonas: ['architect'],
    artifact: {
      path: 'artifacts/company-review/review.md', kind: 'design', minimumBytes: 200
    },
    approval: {
      authorities: ['architecture-reviewers'], minimum: 1, rejectTo: ['company-review']
    }
  };
  legacy.workTypes['company-review'] = {
    label: 'Company review',
    phases: ['company-review'],
    plannedClaims: { mode: 'opt-out', reason: 'Repository-owned review workflow.' },
    intelligence: { worldModel: 'off', ast: 'off', agentBriefs: 'off' }
  };
  const before = YAML.stringify(legacy);
  await writeFile(workflowFile, before);
  const agentFile = path.join(root, '.github/agents/architect.agent.md');
  const beforeAgent = await readFile(agentFile, 'utf8');

  await assert.rejects(
    () => refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
    (error) => error?.code === 'LEGACY_PERSONA_MIGRATION_UNSAFE'
      && /repository phase 'company-review' defines suggestedPersonas/.test(error.message)
  );
  assert.equal(await readFile(workflowFile, 'utf8'), before,
    'repository-created phase routing must remain intact on refusal');
  assert.equal(await readFile(agentFile, 'utf8'), beforeAgent,
    'refusal must happen before packaged agents are refreshed');
  await assert.rejects(
    () => readFile(path.join(root, PACKAGE_BASELINE_PATH), 'utf8'),
    (error) => error?.code === 'ENOENT'
  );
});

test('seeded reinitialization refuses to rewrite repository-created legacy approvals', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-legacy-custom-approval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const legacy = YAML.parse(await readFile(path.join(
    ROOT, 'test/fixtures/workflow-v1-ba513.yml'
  ), 'utf8'));
  legacy.phases['company-review'] = {
    label: 'Company review',
    defaultTemplate: 'common/intake.md',
    artifact: {
      path: 'artifacts/company-review/review.md', kind: 'design', minimumBytes: 200
    },
    writeScope: 'artifact-only',
    approval: {
      personas: ['architect'], minimum: 1, rejectTo: ['company-review']
    }
  };
  legacy.workTypes['company-review'] = {
    label: 'Company review',
    phases: ['company-review'],
    plannedClaims: { mode: 'opt-out', reason: 'Repository-owned review workflow.' },
    intelligence: { worldModel: 'off', ast: 'off', agentBriefs: 'off' }
  };
  const before = YAML.stringify(legacy);
  await writeFile(workflowFile, before);

  await assert.rejects(
    () => refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
    (error) => error?.code === 'LEGACY_PERSONA_MIGRATION_UNSAFE'
      && /phases\.company-review\.approval\.personas/.test(error.message)
  );
  assert.equal(await readFile(workflowFile, 'utf8'), before,
    'safe reinitialize must not rewrite a repository-created workflow for schema compatibility');
  await assert.rejects(
    () => readFile(path.join(root, PACKAGE_BASELINE_PATH), 'utf8'),
    (error) => error?.code === 'ENOENT'
  );
});

test('seeded reinitialization refuses to rewrite repository-created legacy injection rules', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-legacy-custom-injection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const legacy = YAML.parse(await readFile(path.join(
    ROOT, 'test/fixtures/workflow-v1-ba513.yml'
  ), 'utf8'));
  legacy.worldModel.injection.rules = [{
    when: { persona: 'architect', phase: 'design' },
    include: ['company/architecture.md']
  }];
  const before = YAML.stringify(legacy);
  await writeFile(workflowFile, before);

  await assert.rejects(
    () => refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
    (error) => error?.code === 'LEGACY_PERSONA_MIGRATION_UNSAFE'
      && /repository-authored persona routing/.test(error.message)
  );
  assert.equal(await readFile(workflowFile, 'utf8'), before);
  await assert.rejects(
    () => readFile(path.join(root, PACKAGE_BASELINE_PATH), 'utf8'),
    (error) => error?.code === 'ENOENT'
  );
});

test('seeded reinitialization refuses an in-place customization of a packaged v1 persona', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-legacy-persona-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const legacy = YAML.parse(await readFile(path.join(
    ROOT, 'test/fixtures/workflow-v1-ba513.yml'
  ), 'utf8'));
  legacy.personas.developer.description = 'Repository-specific delivery and release role.';
  const before = YAML.stringify(legacy);
  await writeFile(workflowFile, before);

  await assert.rejects(
    () => refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
    (error) => error?.code === 'LEGACY_PERSONA_MIGRATION_UNSAFE'
      && /persona 'developer' differs from the packaged v1 definition/.test(error.message)
  );
  assert.equal(await readFile(workflowFile, 'utf8'), before,
    'an edited framework persona is repository-owned and must remain intact on refusal');
  await assert.rejects(
    () => readFile(path.join(root, PACKAGE_BASELINE_PATH), 'utf8'),
    (error) => error?.code === 'ENOENT'
  );
});

test('seeded reinitialization refuses a customized packaged v1 persona prompt before writing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-legacy-prompt-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const legacy = YAML.parse(await readFile(path.join(
    ROOT, 'test/fixtures/workflow-v1-ba513.yml'
  ), 'utf8'));
  const before = YAML.stringify(legacy);
  await writeFile(workflowFile, before);
  const promptFile = path.join(root, 'singularity/personas/developer.md');
  const customPrompt = '# Company developer\n\nFollow repository-specific release policy.\n';
  await mkdir(path.dirname(promptFile), { recursive: true });
  await writeFile(promptFile, customPrompt);

  await assert.rejects(
    () => refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
    (error) => error?.code === 'LEGACY_PERSONA_MIGRATION_UNSAFE'
      && /persona 'developer' prompt differs from every packaged v1 revision/.test(error.message)
  );
  assert.equal(await readFile(workflowFile, 'utf8'), before);
  assert.equal(await readFile(promptFile, 'utf8'), customPrompt,
    'repository-customized prompt semantics must remain byte-for-byte intact');
  await assert.rejects(
    () => readFile(path.join(root, PACKAGE_BASELINE_PATH), 'utf8'),
    (error) => error?.code === 'ENOENT'
  );
});

test('seeded reinitialization preserves user policy inside fixed package-started YAML files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-configurable-yaml-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  await refreshPackagedConfiguration(root);

  const mappingFile = path.join(root, 'singularity/agent-mappings.yml');
  const impactFile = path.join(root, 'singularity/impact.yml');
  const tiersFile = path.join(root, 'singularity/modelTiers.yml');
  const mappings = YAML.parse(await readFile(mappingFile, 'utf8'));
  mappings.mappings['Enterprise Architect'] = 'architect';
  const impact = YAML.parse(await readFile(impactFile, 'utf8'));
  impact.automaticEnrollment = false;
  const tiers = YAML.parse(await readFile(tiersFile, 'utf8'));
  tiers.modelTiers.code = 'relay';
  await writeFile(mappingFile, YAML.stringify(mappings));
  await writeFile(impactFile, YAML.stringify(impact));
  await writeFile(tiersFile, YAML.stringify(tiers));
  const before = new Map(await Promise.all([mappingFile, impactFile, tiersFile].map(async (file) => [
    path.relative(root, file).replaceAll(path.sep, '/'), await readFile(file, 'utf8')
  ])));

  const result = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });

  for (const [relative, bytes] of before) {
    assert.equal(await readFile(path.join(root, relative), 'utf8'), bytes,
      `${relative} user policy was overwritten`);
    assert.ok(result.conflicts.some((entry) =>
      entry.path === relative && entry.resolution === 'preserved-local'),
    `${relative} must remain a visible reviewed conflict`);
    assert.equal(result.files.includes(relative), false);
  }
});

test('seeded reinitialization preserves same-path repository assets without ownership proof across repeats', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-assets-without-baseline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const qaFile = path.join(root, '.github/agents/qa.agent.md');
  const templateFile = path.join(root, 'singularity/templates/common/implementation.md');
  const promptFile = path.join(root, 'singularity/prompts/worldmodel-builder.md');
  await writeFile(qaFile, `${await readFile(qaFile, 'utf8')}\n<!-- stale package-era agent -->\n`);
  await writeFile(templateFile,
    `${await readFile(templateFile, 'utf8')}\n<!-- stale package-era template -->\n`);
  await writeFile(promptFile,
    `${await readFile(promptFile, 'utf8')}\n<!-- repository-owned prompt collision -->\n`);

  const result = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });

  const qaBytes = `${await readFile(path.join(ROOT, 'templates/agents/qa.agent.md'), 'utf8')}\n<!-- stale package-era agent -->\n`;
  const templateBytes = `${await readFile(path.join(ROOT, 'templates/artifacts/common/implementation.md'), 'utf8')}\n<!-- stale package-era template -->\n`;
  const promptBytes = `${await readFile(path.join(ROOT, 'templates/worldmodel-builder.md'), 'utf8')}\n<!-- repository-owned prompt collision -->\n`;
  assert.equal(await readFile(qaFile, 'utf8'), qaBytes);
  assert.equal(await readFile(templateFile, 'utf8'), templateBytes);
  assert.equal(await readFile(promptFile, 'utf8'), promptBytes);
  assert.ok(!result.files.includes('.github/agents/qa.agent.md'));
  assert.ok(!result.files.includes('singularity/templates/common/implementation.md'));
  assert.ok(!result.files.includes('singularity/prompts/worldmodel-builder.md'));
  assert.ok(result.conflicts.some((entry) =>
    entry.path === '.github/agents/qa.agent.md' && entry.resolution === 'preserved-local'));
  assert.ok(result.conflicts.some((entry) =>
    entry.path === 'singularity/templates/common/implementation.md'
      && entry.resolution === 'preserved-local'));
  assert.ok(result.conflicts.some((entry) =>
    entry.path === 'singularity/prompts/worldmodel-builder.md'
      && entry.resolution === 'preserved-local'));

  const receipt = YAML.parse(await readFile(path.join(root,
    'singularity/.product/configuration-baseline.yml'), 'utf8'));
  assert.equal(receipt.ownership.assets['.github/agents/qa.agent.md'], 'repository');
  assert.equal(receipt.ownership.assets['singularity/templates/common/implementation.md'], 'repository');
  assert.equal(receipt.ownership.assets['singularity/prompts/worldmodel-builder.md'], 'repository');

  const repeated = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
  assert.equal(await readFile(qaFile, 'utf8'), qaBytes,
    'the baseline written after a collision must not claim the custom agent on the second run');
  assert.equal(await readFile(templateFile, 'utf8'), templateBytes,
    'the baseline written after a collision must not claim the custom template on the second run');
  assert.equal(await readFile(promptFile, 'utf8'), promptBytes,
    'the baseline written after a collision must not claim the custom prompt on the second run');
  assert.ok(repeated.conflicts.some((entry) => entry.path === '.github/agents/qa.agent.md'));
  assert.ok(repeated.conflicts.some((entry) =>
    entry.path === 'singularity/templates/common/implementation.md'));
  assert.ok(repeated.conflicts.some((entry) =>
    entry.path === 'singularity/prompts/worldmodel-builder.md'));
});

test('seeded reinitialization recognizes exact historical templates under a configured templates root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-custom-template-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.templatesRoot = 'company/templates';
  await writeFile(workflowFile, YAML.stringify(workflow));
  await refreshPackagedConfiguration(root);

  const relative = 'company/templates/common/implementation.md';
  const target = path.join(root, relative);
  const historical = await readFile(path.join(
    ROOT, 'test/fixtures/packaged-assets/prior/common-implementation.md'
  ));
  await writeFile(target, historical);

  const result = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });

  assert.deepEqual(await readFile(target), await readFile(path.join(
    ROOT, 'templates/artifacts/common/implementation.md'
  )), 'an exact framework predecessor keeps its provenance after relocation');
  assert.ok(result.files.includes(relative));
  assert.equal(result.conflicts.some((entry) => entry.path === relative), false);
});

test('seeded reinitialization cannot overwrite custom content through a forged framework receipt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-forged-ownership-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  await refreshPackagedConfiguration(root);

  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const baselineFile = path.join(root, PACKAGE_BASELINE_PATH);
  const agentRelative = '.github/agents/qa.agent.md';
  const templateRelative = 'singularity/templates/common/implementation.md';
  const agentFile = path.join(root, agentRelative);
  const templateFile = path.join(root, templateRelative);
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.workTypes.feature.label = 'Repository-owned feature contract';
  await writeFile(workflowFile, YAML.stringify(workflow));
  await writeFile(agentFile, `${await readFile(agentFile, 'utf8')}\n<!-- repository-owned QA -->\n`);
  await writeFile(templateFile,
    `${await readFile(templateFile, 'utf8')}\n<!-- repository-owned implementation -->\n`);

  const expectedWorkflow = await readFile(workflowFile);
  const expectedAgent = await readFile(agentFile);
  const expectedTemplate = await readFile(templateFile);
  const baseline = YAML.parse(await readFile(baselineFile, 'utf8'));
  baseline.workflow.workTypes.feature = structuredClone(workflow.workTypes.feature);
  baseline.ownership.workflow.workTypes.feature = 'framework';
  for (const [relative, bytes] of [
    [agentRelative, expectedAgent], [templateRelative, expectedTemplate]
  ]) {
    baseline.assets[relative] = { sha256: createHash('sha256').update(bytes).digest('hex') };
    baseline.ownership.assets[relative] = 'framework';
  }
  await writeFile(baselineFile, YAML.stringify(baseline));

  const result = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });

  assert.deepEqual(await readFile(workflowFile), expectedWorkflow);
  assert.deepEqual(await readFile(agentFile), expectedAgent);
  assert.deepEqual(await readFile(templateFile), expectedTemplate);
  for (const conflictPath of [
    'workflow.workTypes.feature', agentRelative, templateRelative
  ]) {
    assert.ok(result.conflicts.some((entry) =>
      entry.path === conflictPath && entry.resolution === 'preserved-local'),
    `${conflictPath} was not retained as repository-owned`);
  }
  const receipt = YAML.parse(await readFile(baselineFile, 'utf8'));
  assert.equal(receipt.ownership.workflow.workTypes.feature, 'repository');
  assert.equal(receipt.ownership.assets[agentRelative], 'repository');
  assert.equal(receipt.ownership.assets[templateRelative], 'repository');
});

test('legacy baselines preserve newly colliding workflow IDs and record durable repository ownership', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-id-collision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  await refreshPackagedConfiguration(root);

  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const baselineFile = path.join(root, 'singularity/.product/configuration-baseline.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  const baseline = YAML.parse(await readFile(baselineFile, 'utf8'));
  delete baseline.ownership;
  delete baseline.workflow.workTypes['poc-lite'];
  delete baseline.workflow.phases['poc-lite-plan'];
  delete baseline.workflow.artifactSets['spec-driven-specification'];
  delete baseline.workflow.mcpServers.playwright;
  await writeFile(baselineFile, YAML.stringify(baseline));

  workflow.workTypes['poc-lite'].label = 'Repository-owned POC namespace';
  workflow.phases['poc-lite-plan'].label = 'Repository-owned plan phase';
  workflow.artifactSets['spec-driven-specification'].members.push({
    path: 'repository-note.md', role: 'repository-note', required: false
  });
  workflow.mcpServers.playwright.label = 'Repository-owned browser contract';
  await writeFile(workflowFile, YAML.stringify(workflow));
  const expected = {
    workType: structuredClone(workflow.workTypes['poc-lite']),
    phase: structuredClone(workflow.phases['poc-lite-plan']),
    artifactSet: structuredClone(workflow.artifactSets['spec-driven-specification']),
    mcpServer: structuredClone(workflow.mcpServers.playwright)
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });
    const observed = YAML.parse(await readFile(workflowFile, 'utf8'));
    assert.deepEqual(observed.workTypes['poc-lite'], expected.workType);
    assert.deepEqual(observed.phases['poc-lite-plan'], expected.phase);
    assert.deepEqual(observed.artifactSets['spec-driven-specification'], expected.artifactSet);
    assert.deepEqual(observed.mcpServers.playwright, expected.mcpServer);
    for (const conflictPath of [
      'workflow.workTypes.poc-lite',
      'workflow.phases.poc-lite-plan',
      'workflow.artifactSets.spec-driven-specification',
      'workflow.mcpServers.playwright'
    ]) {
      assert.ok(result.conflicts.some((entry) =>
        entry.path === conflictPath && entry.resolution === 'preserved-local'),
      `${conflictPath} collision was not retained on attempt ${attempt + 1}`);
    }
  }

  const receipt = YAML.parse(await readFile(baselineFile, 'utf8')).ownership.workflow;
  assert.equal(receipt.workTypes['poc-lite'], 'repository');
  assert.equal(receipt.phases['poc-lite-plan'], 'repository');
  assert.equal(receipt.artifactSets['spec-driven-specification'], 'repository');
  assert.equal(receipt.mcpServers.playwright, 'repository');
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

test('configuration refresh upgrades a complete exact historical agent cohort as one valid contract', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-package-refresh-agent-cohort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const agents = [
    'architect.agent.md', 'developer.agent.md', 'mobile-architect.agent.md',
    'product-designer.agent.md', 'product-owner.agent.md', 'qa.agent.md'
  ];
  for (const name of agents) {
    await writeFile(path.join(root, '.github/agents', name), await readFile(path.join(
      ROOT, 'test/fixtures/packaged-agents/ba513', name
    )));
  }

  const result = await refreshPackagedConfiguration(root);
  for (const name of agents) {
    const relative = `.github/agents/${name}`;
    assert.equal(
      await readFile(path.join(root, relative), 'utf8'),
      await readFile(path.join(ROOT, 'templates/agents', name), 'utf8'),
      `${name} was not upgraded from exact historical packaged bytes`
    );
    assert.ok(result.files.includes(relative));
    assert.ok(!result.conflicts.some((entry) => entry.path === relative));
  }
  await assert.doesNotReject(() => loadDefinition(root));
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

test('a confirmed refresh plan binds seeded reinitialization ownership mode', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-seed-policy-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'seed-policy-plan');
  const before = run('git', ['--git-dir', remote, 'rev-parse', 'sflow/config']).stdout.trim();

  const preview = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true, restorePackagedSeeds: true
  });
  assert.equal(preview.status, 'preview');
  const wrongMode = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: preview.planId, restorePackagedSeeds: false
  });

  assert.equal(wrongMode.status, 'blocked');
  assert.equal(wrongMode.results[0].status, 'stale-plan');
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'sflow/config']).stdout.trim(), before,
    'a seed-restoration preview must not authorize an ordinary refresh apply or vice versa');
});

test('a seeded plan binds exact ownership resolutions and existing-authority package bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-plan-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'seeded-plan-integrity');
  const authority = path.join(root, 'seeded-plan-integrity-authority');
  run('git', ['clone', '--quiet', '--single-branch', '--branch', 'sflow/config', remote, authority]);
  git(authority, ['config', 'user.name', 'Configuration Test']);
  git(authority, ['config', 'user.email', 'configuration@example.test']);
  const collision = '.github/agents/qa.agent.md';
  const qaFile = path.join(authority, collision);
  await mkdir(path.dirname(qaFile), { recursive: true });
  await writeFile(qaFile,
    `${await readFile(path.join(ROOT, 'templates/agents/qa.agent.md'), 'utf8')}\n<!-- repository-owned collision -->\n`);
  git(authority, ['add', '-A']);
  git(authority, ['commit', '-m', 'Add a repository-owned packaged-path collision']);
  git(authority, ['push', 'origin', 'HEAD:sflow/config']);

  const configBefore = git(remote, ['rev-parse', 'refs/heads/sflow/config']);
  const stateBefore = run('git', [
    '--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/state'
  ], { allowFailure: true });
  const localPreview = await refreshWorkspaceConfigurations({
    registryFile: registry,
    dryRun: true,
    restorePackagedSeeds: true,
    resolutions: { [collision]: 'local' }
  });
  assert.equal(localPreview.status, 'preview');
  assert.ok(localPreview.results[0].conflicts.some((entry) =>
    entry.path === collision && entry.resolution === 'preserved-local'));

  const changedResolution = await refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: localPreview.planId,
    restorePackagedSeeds: true,
    resolutions: { [collision]: 'bundled' }
  });
  assert.equal(changedResolution.status, 'blocked');
  assert.equal(changedResolution.results[0].status, 'failed');
  assert.match(changedResolution.results[0].error,
    /Safe reinitialization cannot adopt packaged content/);
  assert.equal(git(remote, ['rev-parse', 'refs/heads/sflow/config']), configBefore);
  const stateAfterResolution = run('git', [
    '--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/state'
  ], { allowFailure: true });
  assert.equal(stateAfterResolution.status, stateBefore.status);
  assert.equal(stateAfterResolution.stdout, stateBefore.stdout,
    'a changed ownership transfer must not publish configuration or state');

  const packagePreview = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true, restorePackagedSeeds: true
  });
  const packagedPrompt = path.join(ROOT, 'templates/worldmodel-builder.md');
  const packagedPromptBefore = await readFile(packagedPrompt);
  try {
    await writeFile(packagedPrompt, Buffer.concat([
      packagedPromptBefore, Buffer.from('\n<!-- existing-authority-plan-drift -->\n')
    ]));
    const stalePackage = await refreshWorkspaceConfigurations({
      registryFile: registry,
      confirmPlan: packagePreview.planId,
      restorePackagedSeeds: true
    });
    assert.equal(stalePackage.status, 'blocked');
    assert.equal(stalePackage.results[0].status, 'stale-plan');
    assert.equal(git(remote, ['rev-parse', 'refs/heads/sflow/config']), configBefore);
    const stateAfterPackage = run('git', [
      '--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/state'
    ], { allowFailure: true });
    assert.equal(stateAfterPackage.status, stateBefore.status);
    assert.equal(stateAfterPackage.stdout, stateBefore.stdout,
      'changed package bytes must not publish under an existing-authority preview');
  } finally {
    await writeFile(packagedPrompt, packagedPromptBefore);
  }
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

test('configuration refresh discards a symbolic private cache ref before confirmed apply', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-cache-symbolic-ref-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'cache-symbolic-ref');

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  const checkout = await cachedConfigurationCheckout(registry, preview.planId);
  run('git', [
    'symbolic-ref', 'refs/heads/sflow-cache-state', 'refs/heads/sflow/config'
  ], { cwd: checkout });

  const configBefore = run('git', [
    '--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config'
  ]).stdout.trim();
  const applied = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: preview.planId
  });
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.notEqual(run('git', [
    '--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config'
  ]).stdout.trim(), configBefore, 'the hardened cache should still publish the reviewed refresh');
});

test('configuration refresh refuses symbolic remote authority instead of dereferencing it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-symbolic-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'symbolic-authority');
  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  const configBefore = run('git', [
    '--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config'
  ]).stdout.trim();

  run('git', [
    '--git-dir', remote, 'symbolic-ref', 'refs/heads/state', 'refs/heads/main'
  ]);
  const applied = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: preview.planId
  });

  assert.equal(applied.status, 'blocked');
  assert.equal(applied.results[0].status, 'failed');
  assert.match(applied.results[0].error, /exact branch authority/i);
  assert.equal(run('git', [
    '--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config'
  ]).stdout.trim(), configBefore, 'ambiguous authority must not publish configuration changes');
});

test('configuration refresh cache-miss apply refuses a symbolic remote state source', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-symbolic-state-cache-miss-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'symbolic-state-cache-miss');
  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  const configBefore = run('git', [
    '--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config'
  ]).stdout.trim();
  const mainBefore = run('git', [
    '--git-dir', remote, 'rev-parse', 'refs/heads/main'
  ]).stdout.trim();

  // Force confirmed apply down the fresh-clone fallback where no cached state-branch name is
  // available to the initial multi-head preflight.
  await rm(path.join(path.dirname(registry), '.configuration-refresh-cache', preview.planId), {
    recursive: true, force: true
  });
  run('git', [
    '--git-dir', remote, 'symbolic-ref', 'refs/heads/state', 'refs/heads/main'
  ]);

  const applied = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: preview.planId
  });
  assert.equal(applied.status, 'blocked');
  assert.equal(applied.results[0].status, 'failed');
  assert.match(applied.results[0].error, /exact branch authority/i);
  assert.equal(run('git', [
    '--git-dir', remote, 'symbolic-ref', 'refs/heads/state'
  ]).stdout.trim(), 'refs/heads/main');
  assert.equal(run('git', [
    '--git-dir', remote, 'rev-parse', 'refs/heads/main'
  ]).stdout.trim(), mainBefore, 'the symbolic target must remain unchanged');
  assert.equal(run('git', [
    '--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config'
  ]).stdout.trim(), configBefore, 'no configuration publication may precede the refusal');
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
  const { remote, repository, registry } = await registeredRepositoryFixture(root, 'rewrite-initialize');
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
  // A package receipt on the application branch has never been reviewed as configuration. It must
  // not be imported into the first authority, even when it claims arbitrary application bytes are
  // framework-owned.
  const unreviewedBaseline = 'format: forged-application-baseline\nownership:\n  assets:\n    application.txt: framework\n';
  await mkdir(path.join(repository, 'singularity/.product'), { recursive: true });
  await writeFile(path.join(repository, PACKAGE_BASELINE_PATH), unreviewedBaseline);
  git(repository, ['add', PACKAGE_BASELINE_PATH]);
  git(repository, ['commit', '-m', 'Plant unreviewed application baseline']);
  git(repository, ['push', 'origin', 'main']);
  const decoy = path.join(root, 'rewrite-initialize-decoy.git');
  run('git', ['clone', '--quiet', '--bare', remote, decoy]);

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview', JSON.stringify(preview, null, 2));
  assert.equal(preview.results[0].status, 'would-initialize');
  assert.match(preview.results[0].bootstrapCandidateCommit, /^[a-f0-9]{40}$/);
  assert.match(preview.results[0].bootstrapCandidateTree, /^[a-f0-9]{40}$/);
  const applied = await withGitUrlRewrite(remote, decoy, () =>
    refreshWorkspaceConfigurations({ registryFile: registry, confirmPlan: preview.planId }));
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.equal(applied.results[0].configurationChanged, true);
  assert.equal(applied.results[0].configurationCommit,
    preview.results[0].bootstrapCandidateCommit);
  assert.equal(run('git', [
    '--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/sflow/config'
  ], { allowFailure: true }).status, 0,
  'the previewed exact authority receives its initial configuration branch');
  assert.equal(run('git', [
    '--git-dir', decoy, 'show-ref', '--verify', '--quiet', 'refs/heads/sflow/config'
  ], { allowFailure: true }).status, 1,
  'a rewrite target cannot receive first-authority creation');
  const approvedCommit = git(remote, ['rev-parse', 'refs/heads/sflow/config']);
  assert.equal(approvedCommit, preview.results[0].bootstrapCandidateCommit,
    'apply publishes the exact parentless commit reviewed by preview');
  assert.equal(git(remote, ['rev-parse', 'refs/heads/sflow/config^{tree}']),
    preview.results[0].bootstrapCandidateTree,
    'every approved configuration byte and mode matches the previewed candidate tree');
  assert.equal(run('git', ['--git-dir', remote, 'rev-list', '--parents', '-n', '1', approvedCommit])
    .stdout.trim().split(/\s+/u).length, 1, 'the authority remains independent of application history');
  const approvedWorkflow = YAML.parse(run('git', [
    '--git-dir', remote, 'show', 'sflow/config:singularity/workflow.yml'
  ]).stdout);
  assert.deepEqual({
    enabled: approvedWorkflow.ledger.enabled,
    branch: approvedWorkflow.ledger.branch,
    remote: approvedWorkflow.ledger.remote
  }, { enabled: true, branch: 'state', remote: 'origin' });
  const approvedPortfolio = YAML.parse(run('git', [
    '--git-dir', remote, 'show', 'sflow/config:singularity/portfolio.yml'
  ]).stdout);
  assert.deepEqual(approvedPortfolio.repositories['rewrite-initialize'], {
    url: remote, defaultBranch: 'main', required: true
  }, 'repository declaration is present in both preview and the exact published tree');
  assert.notEqual(run('git', [
    '--git-dir', remote, 'show', `sflow/config:${PACKAGE_BASELINE_PATH}`
  ]).stdout, unreviewedBaseline, 'the application-side package receipt is never imported');
});

test('seeded first-authority bootstrap enrolls only exact empty framework groups', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-first-authority-approvals-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, repository, registry } = await registeredRepositoryFixture(root, 'approval-seeds');
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/sflow/config']);

  const workflow = YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
  const portfolio = YAML.parse(await readFile(path.join(ROOT, 'templates/portfolio.yml'), 'utf8'));
  const reviewer = { name: 'Company reviewer', email: 'company-reviewer@example.test' };
  workflow.approvalAuthorities['product-approvers'].members = [reviewer];
  portfolio.approvalAuthorities['initiative-owners'].members = [reviewer];
  await mkdir(path.join(repository, 'singularity'), { recursive: true });
  await writeFile(path.join(repository, 'singularity/workflow.yml'), YAML.stringify(workflow));
  await writeFile(path.join(repository, 'singularity/portfolio.yml'), YAML.stringify(portfolio));
  git(repository, ['add', 'singularity/workflow.yml', 'singularity/portfolio.yml']);
  git(repository, ['commit', '-m', 'Add exact seeds with organisation approval memberships']);
  git(repository, ['push', 'origin', 'main']);

  const preview = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true, restorePackagedSeeds: true
  });
  assert.equal(preview.status, 'preview', JSON.stringify(preview, null, 2));
  const applied = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: preview.planId, restorePackagedSeeds: true
  });
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  const approvedWorkflow = YAML.parse(run('git', [
    '--git-dir', remote, 'show', 'sflow/config:singularity/workflow.yml'
  ]).stdout);
  const approvedPortfolio = YAML.parse(run('git', [
    '--git-dir', remote, 'show', 'sflow/config:singularity/portfolio.yml'
  ]).stdout);
  assert.deepEqual(approvedWorkflow.approvalAuthorities['product-approvers'].members, [reviewer],
    'a populated organisation-owned Story authority must not absorb the bootstrap actor');
  assert.deepEqual(approvedPortfolio.approvalAuthorities['initiative-owners'].members, [reviewer],
    'a populated organisation-owned portfolio authority must not absorb the bootstrap actor');
  assert.deepEqual(approvedWorkflow.approvalAuthorities['design-reviewers'].members, [{
    name: 'Configuration Test', email: 'configuration@example.test'
  }], 'an untouched empty framework Story authority receives the bootstrap identity');
  assert.deepEqual(approvedPortfolio.approvalAuthorities['executive-approvers'].members, [{
    name: 'Configuration Test', email: 'configuration@example.test'
  }], 'an untouched empty framework portfolio authority receives the bootstrap identity');
});

test('seeded first-authority bootstrap preserves compatible repository and ledger policy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-first-authority-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'preserve-first-authority';
  const { remote, repository, registry } = await registeredRepositoryFixture(root, id);
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
  await initializeFixture(repository);

  const workflowFile = path.join(repository, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.ledger = {
    enabled: true,
    branch: 'company-state',
    remote: 'origin',
    behind: 'block',
    enforcement: 'required',
    signing: 'off',
    trustTier: 'T1',
    maxRetries: 7,
    pinTransport: 'branches',
    publication: 'required',
    retentionDays: 1000
  };
  await writeFile(workflowFile, YAML.stringify(workflow));

  const portfolioFile = path.join(repository, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  portfolio.repositories[id] = {
    url: remote, defaultBranch: 'main', required: false,
    metadata: { appId: 'APP-1001', owner: 'Repository team' }
  };
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Add repository-owned bootstrap policy']);
  git(repository, ['push', 'origin', 'main']);
  const mainBefore = git(remote, ['rev-parse', 'refs/heads/main']);

  const preview = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true, restorePackagedSeeds: true
  });
  assert.equal(preview.status, 'preview', JSON.stringify(preview, null, 2));
  assert.equal(preview.results[0].status, 'would-initialize');
  const applied = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: preview.planId, restorePackagedSeeds: true
  });
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));

  const approvedWorkflow = YAML.parse(run('git', [
    '--git-dir', remote, 'show', 'sflow/config:singularity/workflow.yml'
  ]).stdout);
  const approvedPortfolio = YAML.parse(run('git', [
    '--git-dir', remote, 'show', 'sflow/config:singularity/portfolio.yml'
  ]).stdout);
  assert.deepEqual(approvedWorkflow.ledger, workflow.ledger,
    'safe reinitialize must retain the complete imported ledger policy');
  assert.deepEqual(approvedPortfolio.repositories[id], portfolio.repositories[id],
    'safe reinitialize must retain the complete compatible repository policy');
  assert.equal(run('git', [
    '--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/company-state'
  ], { allowFailure: true }).status, 0, 'the preserved state authority receives the projection');
  assert.equal(run('git', [
    '--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/state'
  ], { allowFailure: true }).status, 1, 'reinitialize must not silently substitute state/origin policy');
  assert.equal(git(remote, ['rev-parse', 'refs/heads/main']), mainBefore,
    'safe reinitialize must not move the application branch');
});

test('seeded first-authority bootstrap preserves a compatible user repository alias', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-first-authority-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'derived-repository-id';
  const userAlias = 'customer-rule-service';
  const { remote, repository, registry } = await registeredRepositoryFixture(root, id);
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
  await initializeFixture(repository);

  const portfolioFile = path.join(repository, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  portfolio.repositories[userAlias] = {
    url: remote,
    defaultBranch: 'main',
    required: false,
    metadata: { appId: 'APP-1002', owner: 'Customer rules' }
  };
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Declare repository under stable user alias']);
  git(repository, ['push', 'origin', 'main']);

  const preview = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true, restorePackagedSeeds: true
  });
  assert.equal(preview.status, 'preview', JSON.stringify(preview, null, 2));
  const applied = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: preview.planId, restorePackagedSeeds: true
  });
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));

  const approvedPortfolio = YAML.parse(run('git', [
    '--git-dir', remote, 'show', 'sflow/config:singularity/portfolio.yml'
  ]).stdout);
  assert.deepEqual(approvedPortfolio.repositories[userAlias], portfolio.repositories[userAlias]);
  assert.equal(approvedPortfolio.repositories[id], undefined,
    'safe reinitialize must not add a derived duplicate beside a stable user alias');
});

test('seeded first-authority bootstrap refuses conflicting imported repository policy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-first-authority-policy-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'conflicting-first-authority';
  const { remote, repository, registry } = await registeredRepositoryFixture(root, id);
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
  await initializeFixture(repository);
  const portfolioFile = path.join(repository, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  portfolio.repositories[id] = {
    url: path.join(root, 'different-authority.git'), defaultBranch: 'release', required: false
  };
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Add conflicting repository policy']);
  git(repository, ['push', 'origin', 'main']);
  const mainBefore = git(remote, ['rev-parse', 'refs/heads/main']);

  const preview = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true, restorePackagedSeeds: true
  });
  assert.equal(preview.status, 'blocked');
  assert.match(preview.results[0].error, /repository policy.*conflicts/iu);
  for (const branch of ['sflow/config', 'state']) {
    assert.equal(run('git', [
      '--git-dir', remote, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`
    ], { allowFailure: true }).status, 1, `${branch} must remain absent after refusal`);
  }
  assert.equal(git(remote, ['rev-parse', 'refs/heads/main']), mainBefore,
    'refusal must not move the application branch');
});

test('seeded first-authority bootstrap refuses ambiguous repository aliases', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-first-authority-ambiguous-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'ambiguous-first-authority';
  const { remote, repository, registry } = await registeredRepositoryFixture(root, id);
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
  await initializeFixture(repository);
  const portfolioFile = path.join(repository, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioFile, 'utf8'));
  portfolio.repositories[id] = { url: remote, defaultBranch: 'main', required: true };
  portfolio.repositories['second-alias'] = {
    url: remote, defaultBranch: 'main', required: false,
    metadata: { appId: 'APP-1003' }
  };
  await writeFile(portfolioFile, YAML.stringify(portfolio));
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Add ambiguous repository aliases']);
  git(repository, ['push', 'origin', 'main']);
  const mainBefore = git(remote, ['rev-parse', 'refs/heads/main']);

  const preview = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true, restorePackagedSeeds: true
  });
  assert.equal(preview.status, 'blocked');
  assert.match(preview.results[0].error, /maps the registered repository more than once/iu);
  for (const branch of ['sflow/config', 'state']) {
    assert.equal(run('git', [
      '--git-dir', remote, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`
    ], { allowFailure: true }).status, 1, `${branch} must remain absent after refusal`);
  }
  assert.equal(git(remote, ['rev-parse', 'refs/heads/main']), mainBefore,
    'ambiguous aliases must be refused without moving the application branch');
});

test('seeded first-authority bootstrap refuses a ledger remote it cannot prove', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-first-authority-ledger-remote-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'external-ledger-first-authority';
  const { remote, repository, registry } = await registeredRepositoryFixture(root, id);
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
  await initializeFixture(repository);
  const workflowFile = path.join(repository, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.ledger = {
    ...workflow.ledger,
    enabled: true,
    branch: 'company-state',
    remote: 'ledger-authority'
  };
  await writeFile(workflowFile, YAML.stringify(workflow));
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Select external ledger authority']);
  git(repository, ['push', 'origin', 'main']);
  const mainBefore = git(remote, ['rev-parse', 'refs/heads/main']);

  const preview = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true, restorePackagedSeeds: true
  });
  assert.equal(preview.status, 'blocked');
  assert.match(preview.results[0].error, /ledger policy selects remote 'ledger-authority'/iu);
  for (const branch of ['sflow/config', 'state', 'company-state']) {
    assert.equal(run('git', [
      '--git-dir', remote, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`
    ], { allowFailure: true }).status, 1, `${branch} must remain absent after refusal`);
  }
  assert.equal(git(remote, ['rev-parse', 'refs/heads/main']), mainBefore,
    'an unprovable ledger policy must be refused without moving the application branch');
});

test('seeded first-authority bootstrap refuses configuration symlinks without publishing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-first-authority-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, repository, registry } = await registeredRepositoryFixture(root, 'symlink-seed');
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
  await mkdir(path.join(repository, '.github/agents'), { recursive: true });
  await writeFile(path.join(repository, 'outside-agent.md'), '# outside\n');
  await symlink('../../outside-agent.md', path.join(repository, '.github/agents/developer.agent.md'));
  git(repository, ['add', '.github/agents/developer.agent.md', 'outside-agent.md']);
  git(repository, ['commit', '-m', 'Add unsafe configuration symlink']);
  git(repository, ['push', 'origin', 'main']);
  const mainBefore = git(remote, ['rev-parse', 'refs/heads/main']);

  const preview = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true, restorePackagedSeeds: true
  });
  assert.equal(preview.status, 'blocked');
  assert.match(preview.results[0].error, /non-regular framework asset path/u);
  assert.equal(run('git', [
    '--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/sflow/config'
  ], { allowFailure: true }).status, 1);
  assert.equal(run('git', [
    '--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/state'
  ], { allowFailure: true }).status, 1);
  assert.equal(git(remote, ['rev-parse', 'refs/heads/main']), mainBefore);
});

test('first-authority candidate divergence after confirmation publishes no configuration or state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-init-candidate-divergence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'candidate-divergence');
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/state']);

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview', JSON.stringify(preview, null, 2));
  const applied = await refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: preview.planId,
    inspectCandidate: async (candidate) => {
      await writeFile(path.join(candidate.root, 'singularity/preview-divergence.yml'),
        'unreviewed: true\n');
    }
  });
  assert.equal(applied.status, 'blocked', JSON.stringify(applied, null, 2));
  assert.match(applied.results[0].error, /candidate changed after preview/i);
  for (const ref of ['refs/heads/sflow/config', 'refs/heads/state']) {
    assert.equal(run('git', [
      '--git-dir', remote, 'show-ref', '--verify', '--quiet', ref
    ], { allowFailure: true }).status, 1, `${ref} remains absent after candidate divergence`);
  }
});

test('multi-repository initialization reports durable partial progress when one authority push fails', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-refresh-partial-initialize-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await repositoryFixture(root, 'first');
  await rm(path.join(root, 'configuration-publisher'), { recursive: true, force: true });
  const second = await repositoryFixture(root, 'second');
  for (const fixture of [first, second]) {
    run('git', ['--git-dir', fixture.remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
  }
  const workspaceRoot = path.join(root, 'workspace');
  const manifest = {
    version: 1,
    id: 'partial-initialize-workspace',
    name: 'Partial initialize workspace',
    path: workspaceRoot,
    anchor: {
      provider: 'workspace', key: 'partial-initialize-workspace',
      title: 'Partial initialize workspace'
    },
    leadRepository: 'first',
    repositories: Object.fromEntries([['first', first], ['second', second]].map(([id, fixture]) =>
      [id, {
        id, url: fixture.remote, defaultBranch: 'main', required: true,
        path: `repos/${id}`, role: id === 'first' ? 'lead' : 'delivery', capabilities: []
      }]))
  };
  const registry = path.join(root, 'workspaces.json');
  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rememberWorkspace(registry, manifest);

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview', JSON.stringify(preview, null, 2));
  assert.deepEqual(preview.results.map((entry) => entry.status), [
    'would-initialize', 'would-initialize'
  ]);

  const rejectingHook = path.join(second.remote, 'hooks', 'pre-receive');
  await writeFile(rejectingHook, '#!/bin/sh\nexit 1\n');
  await chmod(rejectingHook, 0o700);
  const applied = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: preview.planId
  });

  assert.equal(applied.status, 'partial', JSON.stringify(applied, null, 2));
  assert.equal(applied.updated, 1);
  assert.equal(applied.failed, 1);
  const created = applied.results.find((entry) => entry.repository === 'first');
  const failed = applied.results.find((entry) => entry.repository === 'second');
  assert.equal(created.status, 'initialization-created');
  assert.equal(created.configurationChanged, true);
  assert.match(created.configurationCommit, /^[a-f0-9]{40}$/);
  assert.equal(created.stateChanged, false);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.configurationChanged, false);
  assert.equal(run('git', [
    '--git-dir', first.remote, 'show-ref', '--verify', '--quiet', 'refs/heads/sflow/config'
  ], { allowFailure: true }).status, 0, 'the created authority remains durable and reported');
  assert.equal(run('git', [
    '--git-dir', second.remote, 'show-ref', '--verify', '--quiet', 'refs/heads/sflow/config'
  ], { allowFailure: true }).status, 1, 'the rejected authority remains absent');
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
  await initializeStatePublisher(statePublisher);
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

  const inspectedCandidates = [];
  const previewTimer = commandTimer('configuration-refresh-preview');
  const preview = await withCommandTiming(previewTimer, () =>
    refreshWorkspaceConfigurations({
      registryFile: registry,
      dryRun: true,
      inspectCandidate: async (candidate) => {
        inspectedCandidates.push({
          localPaths: candidate.repository.localPaths,
          defaultBaseBranch: (await loadDefinition(candidate.root)).defaultBaseBranch,
          sourceCommit: candidate.sourceCommit,
          stateCommit: candidate.stateBefore.stateCommit
        });
      }
    }));
  const previewCounters = previewTimer.finish().counters;
  assert.equal(preview.status, 'preview');
  assert.match(preview.planId, /^cfgp-[a-f0-9]{24}$/);
  assert.equal(preview.results[0].stateStatus, 'would-follow-configuration');
  assert.equal(previewCounters['git.remote.command.clone'], 1);
  assert.equal(previewCounters['git.remote.command.fetch'], 1);
  assert.deepEqual(inspectedCandidates, [{
    localPaths: [await realpath(repository)],
    defaultBaseBranch: 'release',
    sourceCommit: git(remote, ['rev-parse', 'refs/heads/sflow/config']),
    stateCommit: git(remote, ['rev-parse', 'refs/heads/state'])
  }], 'candidate inspection must see the exact approved configuration and state authority');

  const applyTimer = commandTimer('configuration-refresh-apply');
  const result = await withCommandTiming(applyTimer, () => refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: preview.planId
  }));
  const applyCounters = applyTimer.finish().counters;
  assert.equal(result.status, 'complete');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].configurationChanged, true);
  assert.equal(result.results[0].stateChanged, true);
  assert.equal(applyCounters['git.remote.command.ls-remote'], 4,
    'apply re-observes the source authority and brackets immutable history publication');
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
  const staleLocalWorkflow = 'version: 1\nworkItemRoot: stale/local-only-items\n';
  await mkdir(path.join(repository, 'singularity'), { recursive: true });
  await writeFile(path.join(repository, 'singularity/workflow.yml'), staleLocalWorkflow);
  const bootstrapInspections = [];
  let initializePreview = await refreshWorkspaceConfigurations({
    registryFile: registry,
    dryRun: true,
    inspectCandidate: async (candidate) => {
      const definition = await loadDefinition(candidate.root);
      bootstrapInspections.push({
        sourceCommit: candidate.sourceCommit,
        bootstrapCommit: candidate.bootstrapCommit,
        stateCommit: candidate.stateBefore.stateCommit,
        version: definition.version,
        defaultBaseBranch: definition.defaultBaseBranch,
        root: candidate.root
      });
    }
  });
  assert.equal(initializePreview.results[0].status, 'would-initialize');
  assert.equal(initializePreview.results[0].configurationCommit, null);
  assert.equal(initializePreview.results[0].bootstrapCommit,
    git(remote, ['rev-parse', 'refs/heads/main']));
  assert.match(initializePreview.results[0].packageContentDigest, /^[a-f0-9]{64}$/);
  assert.ok(initializePreview.results[0].changedFiles.includes(PACKAGE_BASELINE_PATH));
  assert.deepEqual(initializePreview.results[0].removed, []);
  assert.ok(initializePreview.results[0].configurationPaths.includes('singularity/workflow.yml'));
  assert.match(
    initializePreview.results[0].configurationAssets['singularity/workflow.yml'].sha256,
    /^[a-f0-9]{64}$/
  );
  assert.ok(Array.isArray(initializePreview.results[0].conflicts));
  assert.deepEqual(bootstrapInspections.map(({ root: _root, ...entry }) => entry), [{
    sourceCommit: null,
    bootstrapCommit: git(remote, ['rev-parse', 'refs/heads/main']),
    stateCommit: git(remote, ['rev-parse', 'refs/heads/state']),
    version: 2,
    defaultBaseBranch: 'main'
  }], 'first-authority preview inspects the bundled candidate and current state authority');
  assert.notEqual(path.resolve(bootstrapInspections[0].root), path.resolve(repository),
    'bootstrap inspection must never read configuration from the application checkout');
  assert.equal(await readFile(path.join(repository, 'singularity/workflow.yml'), 'utf8'),
    staleLocalWorkflow, 'bootstrap inspection leaves a stale local working-tree copy untouched');

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
  const refusedInitialization = await refreshWorkspaceConfigurations({
    registryFile: registry,
    confirmPlan: initializePreview.planId,
    inspectCandidate: async () => { throw new Error('schema authority moved'); }
  });
  assert.equal(refusedInitialization.status, 'blocked');
  assert.equal(run('git', [
    '--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/sflow/config'
  ], { allowFailure: true }).status, 128,
  'bootstrap candidate inspection must finish before the first configuration publication');

  // A source checkout can keep the same stamped product revision while its packaged bytes move
  // (for example an incorrectly assembled internal distribution). First-authority confirmation
  // must bind those bytes, not only the build label and application branch SHA.
  const packagedPrompt = path.join(ROOT, 'templates/worldmodel-builder.md');
  const packagedPromptBefore = await readFile(packagedPrompt);
  initializePreview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  try {
    await writeFile(packagedPrompt, Buffer.concat([
      packagedPromptBefore, Buffer.from('\n<!-- first-authority-plan-drift -->\n')
    ]));
    const stalePackageInitialization = await refreshWorkspaceConfigurations({
      registryFile: registry, confirmPlan: initializePreview.planId
    });
    assert.equal(stalePackageInitialization.status, 'blocked');
    assert.equal(stalePackageInitialization.results[0].status, 'stale-plan');
    assert.equal(run('git', [
      '--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/sflow/config'
    ], { allowFailure: true }).status, 128,
    'changed packaged bytes cannot create first configuration authority under an old plan');
  } finally {
    await writeFile(packagedPrompt, packagedPromptBefore);
  }

  initializePreview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  const initialized = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: initializePreview.planId
  });
  assert.equal(initialized.status, 'complete');
  assert.match(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config']).stdout.trim(),
    /^[a-f0-9]{40}$/);
});

test('all-workspace reinitialization refuses one remote bound to conflicting source branches', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-branch-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'application.git');
  const source = path.join(root, 'source');
  run('git', ['init', '--bare', '--initial-branch=main', remote]);
  run('git', ['init', '--initial-branch=main', source]);
  git(source, ['config', 'user.name', 'Configuration Test']);
  git(source, ['config', 'user.email', 'configuration@example.test']);
  await writeFile(path.join(source, 'application.txt'), 'main source\n');
  git(source, ['add', '-A']);
  git(source, ['commit', '-m', 'Initialize main']);
  git(source, ['switch', '-c', 'develop']);
  await writeFile(path.join(source, 'application.txt'), 'develop source\n');
  git(source, ['commit', '-am', 'Initialize develop']);
  git(source, ['remote', 'add', 'origin', remote]);
  git(source, ['push', 'origin', 'main', 'develop']);

  const registry = path.join(root, 'workspaces.json');
  for (const [suffix, defaultBranch] of [['main', 'main'], ['develop', 'develop']]) {
    const workspaceRoot = path.join(root, `workspace-${suffix}`);
    const manifest = {
      version: 1,
      id: `workspace-${suffix}`,
      name: `Workspace ${suffix}`,
      path: workspaceRoot,
      anchor: { provider: 'workspace', key: `workspace-${suffix}`, title: `Workspace ${suffix}` },
      leadRepository: 'application',
      repositories: {
        application: {
          id: 'application', url: remote, defaultBranch, required: true,
          path: 'repos/application', role: 'lead', capabilities: []
        }
      }
    };
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await rememberWorkspace(registry, manifest);
  }

  await assert.rejects(
    refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true,
      restorePackagedSeeds: true }),
    (error) => error?.code === 'WORKSPACE_REPOSITORY_AUTHORITY_CONFLICT'
  );
  assert.equal(run('git', [
    '--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/sflow/config'
  ], { allowFailure: true }).status, 128,
  'conflicting workspace authority must be rejected before branch creation');
});

test('scoped reinitialization refuses an equivalent remote binding from another workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-scoped-authority-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = path.join(root, 'workspaces.json');
  const publicGithub = ['github', 'com'].join('.');
  const definitions = [
    {
      id: 'selected',
      remote: `https://${publicGithub}/Acme/Application.git`,
      defaultBranch: 'main'
    },
    {
      id: 'other',
      remote: `git@${publicGithub}:acme/application`,
      defaultBranch: 'develop'
    }
  ];
  for (const definition of definitions) {
    const workspaceRoot = path.join(root, definition.id);
    const manifest = {
      version: 1,
      id: definition.id,
      name: `${definition.id} workspace`,
      path: workspaceRoot,
      anchor: { provider: 'workspace', key: definition.id, title: definition.id },
      leadRepository: 'application',
      repositories: {
        application: {
          id: 'application', url: definition.remote,
          defaultBranch: definition.defaultBranch, required: true,
          path: 'repos/application', role: 'lead', capabilities: []
        }
      }
    };
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await rememberWorkspace(registry, manifest);
  }

  await assert.rejects(
    refreshWorkspaceConfigurations({
      registryFile: registry,
      workspace: 'selected',
      dryRun: true,
      restorePackagedSeeds: true
    }),
    (error) => error?.code === 'WORKSPACE_REPOSITORY_AUTHORITY_CONFLICT'
      && error?.details?.branches?.includes('main')
      && error?.details?.branches?.includes('develop')
  );
});

test('scoped reinitialization refuses case aliases of one Windows repository authority', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-windows-authority-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = path.join(root, 'workspaces.json');
  for (const definition of [
    { id: 'selected-windows', remote: 'C:\\Work\\Application\\.git', defaultBranch: 'main' },
    { id: 'other-windows', remote: 'c:\\work\\application', defaultBranch: 'develop' }
  ]) {
    const workspaceRoot = path.join(root, definition.id);
    const manifest = {
      version: 1,
      id: definition.id,
      name: `${definition.id} workspace`,
      path: workspaceRoot,
      anchor: { provider: 'workspace', key: definition.id, title: definition.id },
      leadRepository: 'application',
      repositories: {
        application: {
          id: 'application', url: definition.remote,
          defaultBranch: definition.defaultBranch, required: true,
          path: 'repos/application', role: 'lead', capabilities: []
        }
      }
    };
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await rememberWorkspace(registry, manifest);
  }

  await assert.rejects(
    refreshWorkspaceConfigurations({
      registryFile: registry,
      workspace: 'selected-windows',
      dryRun: true,
      restorePackagedSeeds: true
    }),
    (error) => error?.code === 'WORKSPACE_REPOSITORY_AUTHORITY_CONFLICT'
  );
});

test('seeded reinitialization refuses an unmarked application branch configured as state authority', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-authority-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'state-boundary');

  const editor = path.join(root, 'state-boundary-editor');
  run('git', ['clone', '--quiet', '--single-branch', '--branch', 'sflow/config', remote, editor]);
  git(editor, ['config', 'user.name', 'Configuration Test']);
  git(editor, ['config', 'user.email', 'configuration@example.test']);
  const workflowFile = path.join(editor, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.ledger.branch = 'release';
  await writeFile(workflowFile, YAML.stringify(workflow));
  git(editor, ['add', 'singularity/workflow.yml']);
  git(editor, ['commit', '-m', 'Point state at an application branch']);
  git(editor, ['push', 'origin', 'HEAD:sflow/config']);
  const mainCommit = git(remote, ['rev-parse', 'refs/heads/main']);
  run('git', ['--git-dir', remote, 'update-ref', 'refs/heads/release', mainCommit]);
  const before = Object.fromEntries(['main', 'release', 'sflow/config'].map((branch) => [
    branch, git(remote, ['rev-parse', `refs/heads/${branch}`])
  ]));

  const preview = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true, restorePackagedSeeds: true
  });
  assert.equal(preview.status, 'blocked', JSON.stringify(preview, null, 2));
  assert.equal(preview.results[0].status, 'blocked');
  assert.match(preview.results[0].error, /not a proven dedicated Singularity Flow state authority/u);
  for (const [branch, commit] of Object.entries(before)) {
    assert.equal(git(remote, ['rev-parse', `refs/heads/${branch}`]), commit,
      `${branch} must remain unchanged when state provenance is absent`);
  }
});

test('seeded workspace reinitialization restores an absent workflow in an existing authority', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-missing-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'missing-workflow');
  const mainBefore = git(remote, ['rev-parse', 'refs/heads/main']);

  const editor = path.join(root, 'configuration-editor');
  run('git', ['clone', '--quiet', '--single-branch', '--branch', 'sflow/config', remote, editor]);
  git(editor, ['config', 'user.name', 'Configuration Test']);
  git(editor, ['config', 'user.email', 'configuration@example.test']);
  await rm(path.join(editor, 'singularity/workflow.yml'));
  await writeFile(path.join(editor, 'repository-policy.txt'), 'preserve repository configuration\n');
  git(editor, ['add', '-A']);
  git(editor, ['commit', '-m', 'Remove damaged workflow authority']);
  git(editor, ['push', 'origin', 'HEAD:sflow/config']);
  const damagedCommit = git(remote, ['rev-parse', 'refs/heads/sflow/config']);

  const ordinary = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true
  });
  assert.equal(ordinary.status, 'blocked',
    'ordinary refresh must not infer ownership for a missing workflow container');
  assert.equal(ordinary.results[0].status, 'blocked');
  assert.equal(git(remote, ['rev-parse', 'refs/heads/sflow/config']), damagedCommit);

  const preview = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true, restorePackagedSeeds: true
  });
  assert.equal(preview.status, 'preview', JSON.stringify(preview, null, 2));
  assert.equal(preview.results[0].status, 'would-update');
  assert.ok(preview.results[0].changedFiles.includes('singularity/workflow.yml'));
  assert.equal(git(remote, ['rev-parse', 'refs/heads/sflow/config']), damagedCommit,
    'seeded preview must remain read-only');

  const applied = await refreshWorkspaceConfigurations({
    registryFile: registry,
    restorePackagedSeeds: true,
    confirmPlan: preview.planId
  });
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));
  assert.equal(applied.results[0].configurationChanged, true);
  assert.equal(YAML.parse(run('git', [
    '--git-dir', remote, 'show', 'sflow/config:singularity/workflow.yml'
  ]).stdout).version, 2);
  assert.equal(run('git', [
    '--git-dir', remote, 'show', 'sflow/config:repository-policy.txt'
  ]).stdout, 'preserve repository configuration\n');
  assert.equal(git(remote, ['rev-parse', 'refs/heads/main']), mainBefore,
    'reinitialization must not change the application branch');
  assert.equal(YAML.parse(run('git', [
    '--git-dir', remote, 'show', 'state:singularity/workflow.yml'
  ]).stdout).version, 2, 'state projection must receive the restored approved workflow');
});

test('seeded workspace reinitialization preserves repository contracts through config and state publication', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-publication-preservation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, registry } = await registeredRepositoryFixture(root, 'seeded-preservation');
  const mainBefore = git(remote, ['rev-parse', 'refs/heads/main']);

  const authority = path.join(root, 'seeded-preservation-authority');
  run('git', ['clone', '--quiet', '--single-branch', '--branch', 'sflow/config', remote, authority]);
  git(authority, ['config', 'user.name', 'Configuration Test']);
  git(authority, ['config', 'user.email', 'configuration@example.test']);
  await refreshPackagedConfiguration(authority);

  const workflowFile = path.join(authority, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  const customPhase = structuredClone(workflow.phases['poc-lite-plan']);
  customPhase.label = 'Repository customer review';
  customPhase.defaultTemplate = 'customer/review.md';
  customPhase.artifact = {
    path: 'artifacts/customer-review/review.md', kind: 'delivery-plan', minimumBytes: 10
  };
  customPhase.artifactSet = 'customer-review-set';
  workflow.phases['customer-review'] = customPhase;
  workflow.artifactSets['customer-review-set'] = {
    primary: 'review.md',
    members: [{ path: 'review.md', role: 'customer-review', required: true }]
  };
  workflow.workTypes['customer-delivery'] = {
    label: 'Customer delivery',
    description: 'Repository-owned workflow preserved through seeded publication.',
    phases: ['customer-review'],
    plannedClaims: { mode: 'opt-out', reason: 'Repository-owned review-only workflow.' },
    intelligence: { worldModel: 'off', ast: 'off', agentBriefs: 'off' },
    metadata: { owner: 'customer-platform', revision: 11 }
  };
  workflow.workTypes.feature.label = 'Stale seeded feature';
  workflow.phases.requirements.label = 'Stale seeded requirements';
  await writeFile(workflowFile, YAML.stringify(workflow));

  const customAssets = new Map([
    ['singularity/templates/customer/review.md',
      '# Customer review\n\nRepository-owned template bytes.\n'],
    ['singularity/prompts/customer-review.md',
      '# Customer review prompt\n\nRepository-owned prompt bytes.\n'],
    ['.github/agents/repository-specialist.agent.md', `---
name: repository-specialist
description: Repository-owned customer reviewer.
model: [auto]
tools: [read, search]
metadata:
  sflow-label: "Repository specialist"
  sflow-phases: "customer-review"
  sflow-default-for: "customer-review"
---

# Repository specialist

Review customer evidence without changing files.
`]
  ]);
  for (const [relative, contents] of customAssets) {
    const target = path.join(authority, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const seededAgent = path.join(authority, '.github/agents/developer.agent.md');
  await writeFile(seededAgent, `${await readFile(seededAgent, 'utf8')}\n<!-- stale seeded agent -->\n`);
  const seededTemplate = path.join(authority, 'singularity/templates/feature/requirements.md');
  await writeFile(seededTemplate,
    `${await readFile(seededTemplate, 'utf8')}\n<!-- stale seeded template -->\n`);
  git(authority, ['add', '-A']);
  git(authority, ['commit', '-m', 'Add repository-owned configuration contracts']);
  git(authority, ['push', 'origin', 'HEAD:sflow/config']);

  const statePublisher = path.join(root, 'seeded-preservation-state');
  await initializeStatePublisher(statePublisher);
  const runtimeMarker = 'runtime evidence must survive seeded projection\n';
  const workItemMarker = 'published Story evidence must survive seeded projection\n';
  await writeFile(path.join(statePublisher, 'runtime-marker.txt'), runtimeMarker);
  await mkdir(path.join(statePublisher, 'singularity/work-items/CUSTOM/evidence'), {
    recursive: true
  });
  await writeFile(
    path.join(statePublisher, 'singularity/work-items/CUSTOM/evidence/result.txt'),
    workItemMarker
  );
  git(statePublisher, ['add', '-A']);
  git(statePublisher, ['commit', '-m', 'Seed unrelated state runtime']);
  git(statePublisher, ['remote', 'add', 'origin', remote]);
  git(statePublisher, ['push', 'origin', 'HEAD:state']);

  const preview = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true, restorePackagedSeeds: true
  });
  assert.equal(preview.status, 'preview');
  const applied = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: preview.planId, restorePackagedSeeds: true
  });
  assert.equal(applied.status, 'complete', JSON.stringify(applied, null, 2));

  for (const branch of ['sflow/config', 'state']) {
    const observed = YAML.parse(run('git', [
      '--git-dir', remote, 'show', `${branch}:singularity/workflow.yml`
    ]).stdout);
    assert.deepEqual(observed.workTypes['customer-delivery'],
      workflow.workTypes['customer-delivery']);
    assert.deepEqual(observed.phases['customer-review'], workflow.phases['customer-review']);
    assert.deepEqual(observed.artifactSets['customer-review-set'],
      workflow.artifactSets['customer-review-set']);
    assert.deepEqual(observed.workTypes.feature, workflow.workTypes.feature,
      `modified framework-started workflow must remain repository-owned on ${branch}`);
    assert.deepEqual(observed.phases.requirements, workflow.phases.requirements,
      `modified framework-started phase must remain repository-owned on ${branch}`);
    for (const [relative, contents] of customAssets) {
      assert.equal(run('git', ['--git-dir', remote, 'show', `${branch}:${relative}`]).stdout,
        contents, `${relative} changed on ${branch}`);
    }
  }
  assert.equal(run('git', [
    '--git-dir', remote, 'show', 'sflow/config:.github/agents/developer.agent.md'
  ]).stdout, await readFile(seededAgent, 'utf8'),
  'a modified framework-started agent must remain repository-owned');
  assert.equal(run('git', [
    '--git-dir', remote, 'show', 'state:singularity/templates/feature/requirements.md'
  ]).stdout, await readFile(seededTemplate, 'utf8'),
  'a modified framework-started template must remain repository-owned');
  assert.equal(run('git', ['--git-dir', remote, 'show', 'state:runtime-marker.txt']).stdout,
    runtimeMarker);
  assert.equal(run('git', [
    '--git-dir', remote, 'show',
    'state:singularity/work-items/CUSTOM/evidence/result.txt'
  ]).stdout, workItemMarker, 'safe reinitialize must preserve published work-item evidence');
  assert.equal(git(remote, ['rev-parse', 'refs/heads/main']), mainBefore,
    'seeded reinitialization must not move the application branch');

  const repeated = await refreshWorkspaceConfigurations({
    registryFile: registry, dryRun: true, restorePackagedSeeds: true
  });
  assert.equal(repeated.results[0].status, 'current');
  assert.equal(repeated.results[0].configurationChanged, false);
  assert.equal(repeated.results[0].stateChanged, false);
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
  await initializeStatePublisher(statePublisher);
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
  assert.equal(run('git', [
    '--git-dir', remote, 'show', 'state:.github/agents/developer.agent.md'
  ]).stdout, await readFile(path.join(ROOT, 'templates/agents/developer.agent.md'), 'utf8'),
  'canonical packaged agents remain governed and mirrored beside an additional custom agent root');
  assert.deepEqual(run('git', [
    '--git-dir', remote, 'show', 'state:governed/world-model/manifest.json'
  ], { encoding: 'buffer' }).stdout, worldModelBytes);

  const current = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(current.results[0].status, 'current');
  assert.equal(current.results[0].configurationChanged, false);
  assert.equal(current.results[0].stateChanged, false);
});

test('seeded reinitialization refuses a symbolic workflow authority before reading or writing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-workflow-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const externalFile = path.join(root, '..', `${path.basename(root)}-external-workflow.yml`);
  t.after(() => rm(externalFile, { force: true }));
  const externalBytes = Buffer.concat([
    await readFile(workflowFile), Buffer.from('\n# private-host-marker: must-not-be-read-or-published\n')
  ]);
  await writeFile(externalFile, externalBytes);
  await rm(workflowFile);
  await symlink(externalFile, workflowFile);

  run('git', ['init', '--initial-branch=main', root]);
  git(root, ['config', 'user.name', 'Configuration Test']);
  git(root, ['config', 'user.email', 'configuration@example.test']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'Seed symbolic workflow authority']);
  const headBefore = git(root, ['rev-parse', 'HEAD']);
  const indexBefore = run('git', ['ls-files', '--stage', '-z'], {
    cwd: root, encoding: 'buffer'
  }).stdout;

  await assert.rejects(
    refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
    (error) => error?.code === 'CONFIGURATION_ASSET_TARGET_SYMBOLIC_LINK'
  );

  assert.deepEqual(await readFile(externalFile), externalBytes);
  assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore);
  assert.deepEqual(run('git', ['ls-files', '--stage', '-z'], {
    cwd: root, encoding: 'buffer'
  }).stdout, indexBefore);
  assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: root }).stdout, '');
  await assert.rejects(
    readFile(path.join(root, PACKAGE_BASELINE_PATH)),
    (error) => error?.code === 'ENOENT'
  );
});

test('seeded reinitialization refuses existing portable aliases of packaged targets', async (t) => {
  for (const [label, targetRelative, aliasRelative] of [
    ['case', '.github/agents/qa.agent.md', '.github/agents/QA.agent.md'],
    ['trailing-dot', '.github/agents/qa.agent.md', '.github/agents/qa.agent.md.'],
    ['unicode-fold', '.github/agents/product-designer.agent.md',
      '.github/agents/product-deſigner.agent.md']
  ]) {
    await t.test(label, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `sflow-seeded-portable-alias-${label}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      await initializeFixture(root);
      const target = path.join(root, targetRelative);
      const alias = path.join(root, aliasRelative);
      const bytes = await readFile(target);
      await rm(target);
      await writeFile(alias, bytes);

      await assert.rejects(
        refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
        (error) => error?.code === 'CONFIGURATION_ASSET_PORTABLE_COLLISION'
      );
      assert.deepEqual(await readFile(alias), bytes);
      await assert.rejects(
        readFile(path.join(root, PACKAGE_BASELINE_PATH)),
        (error) => error?.code === 'ENOENT'
      );
    });
  }
});

test('seeded reinitialization refuses portable aliases of packaged target ancestors', async (t) => {
  for (const [label, aliasComponent] of [
    ['case', 'Agents'],
    ['trailing-dot', 'agents.'],
    ['unicode-fold', 'agentſ']
  ]) {
    await t.test(label, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `sflow-seeded-portable-parent-${label}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      await initializeFixture(root);
      const canonical = path.join(root, '.github/agents');
      const alias = path.join(root, `.github/${aliasComponent}`);
      await rename(canonical, alias);
      const before = await readFile(path.join(alias, 'qa.agent.md'));

      await assert.rejects(
        refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
        (error) => error?.code === 'CONFIGURATION_ASSET_PORTABLE_COLLISION'
      );
      assert.deepEqual(await readFile(path.join(alias, 'qa.agent.md')), before);
      await assert.rejects(
        readFile(path.join(root, PACKAGE_BASELINE_PATH)),
        (error) => error?.code === 'ENOENT'
      );
    });
  }
});

test('seeded reinitialization refuses redirected templates inside runtime evidence before any write or staging', async (t) => {
  for (const [label, templatesRoot, code = 'CONFIGURATION_ASSET_TARGET_RUNTIME_OVERLAP'] of [
    ['work-item', 'singularity/work-items/WRK-1/artifacts/templates'],
    ['case-folded-work-item', 'Singularity/Work-Items/WRK-1/artifacts/templates'],
    ['case-folded-trailing-dot-work-item', 'singularity/work-items./WRK-1/artifacts/templates',
      'CONFIGURATION_ASSET_ROOT_INVALID'],
    ['windows-short-name-work-item', 'SINGUL~1/WORK-I~1/WRK-1/artifacts/templates',
      'CONFIGURATION_ASSET_ROOT_INVALID'],
    ['windows-console-input-device', 'CONIN$/templates',
      'CONFIGURATION_ASSET_ROOT_INVALID'],
    ['windows-console-output-device', 'CONOUT$/templates',
      'CONFIGURATION_ASSET_ROOT_INVALID'],
    ['windows-clock-device', 'CLOCK$/templates',
      'CONFIGURATION_ASSET_ROOT_INVALID'],
    ['test-evidence', '.sflow/results/templates'],
    ['legacy-control', '.singularity/templates'],
    ['legacy-sdlc-control', '.sdlc/templates']
  ]) {
    await t.test(label, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `sflow-seeded-runtime-${label}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      await initializeFixture(root);
      const workflowFile = path.join(root, 'singularity/workflow.yml');
      const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
      workflow.templatesRoot = templatesRoot;
      await writeFile(workflowFile, YAML.stringify(workflow));
      const evidence = path.join(root, templatesRoot, 'existing-evidence.txt');
      await mkdir(path.dirname(evidence), { recursive: true });
      await writeFile(evidence, 'retain runtime evidence exactly\n');

      run('git', ['init', '--initial-branch=main', root]);
      git(root, ['config', 'user.name', 'Configuration Test']);
      git(root, ['config', 'user.email', 'configuration@example.test']);
      git(root, ['add', '-A']);
      git(root, ['commit', '-m', 'Seed invalid redirected runtime authority']);
      const indexBefore = run('git', ['ls-files', '--stage', '-z'], {
        cwd: root, encoding: 'buffer'
      }).stdout;
      const headBefore = git(root, ['rev-parse', 'HEAD']);
      const evidenceBefore = await readFile(evidence);

      await assert.rejects(
        refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
        (error) => error?.code === code
      );

      assert.deepEqual(await readFile(evidence), evidenceBefore);
      assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore);
      assert.deepEqual(run('git', ['ls-files', '--stage', '-z'], {
        cwd: root, encoding: 'buffer'
      }).stdout, indexBefore, 'the rejection must not stage runtime or configuration bytes');
      assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: root }).stdout, '');
      const runtimeEntries = await readdir(path.join(root, templatesRoot));
      assert.deepEqual(runtimeEntries, ['existing-evidence.txt'],
        'no packaged template was materialized under the redirected runtime root');
    });
  }
});

test('seeded reinitialization refuses a case-folded Git-internals template root before mutation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-git-internals-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  run('git', ['init', '--initial-branch=main', root]);
  git(root, ['config', 'user.name', 'Configuration Test']);
  git(root, ['config', 'user.email', 'configuration@example.test']);

  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.templatesRoot = '.GIT/hooks';
  await writeFile(workflowFile, YAML.stringify(workflow));
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'Seed unsafe case-folded Git path']);
  const headBefore = git(root, ['rev-parse', 'HEAD']);
  const indexBefore = run('git', ['ls-files', '--stage', '-z'], {
    cwd: root, encoding: 'buffer'
  }).stdout;

  await assert.rejects(
    refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
    (error) => error?.code === 'CONFIGURATION_ASSET_ROOT_INVALID'
  );

  assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore);
  assert.deepEqual(run('git', ['ls-files', '--stage', '-z'], {
    cwd: root, encoding: 'buffer'
  }).stdout, indexBefore);
  assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: root }).stdout, '');
});

test('seeded reinitialization refuses a Unicode-normalized runtime alias before mutation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-unicode-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);

  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.workItemRoot = 'singularity/caf\u00e9';
  workflow.templatesRoot = 'singularity/cafe\u0301/WRK-1/artifacts/templates';
  await writeFile(workflowFile, YAML.stringify(workflow));
  const evidence = path.join(root, 'singularity/caf\u00e9/WRK-1/artifacts/evidence.txt');
  await mkdir(path.dirname(evidence), { recursive: true });
  await writeFile(evidence, 'retain normalized runtime evidence exactly\n');
  const workflowBefore = await readFile(workflowFile);
  const evidenceBefore = await readFile(evidence);

  await assert.rejects(
    refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
    (error) => error?.code === 'CONFIGURATION_ASSET_ROOT_INVALID'
  );

  assert.deepEqual(await readFile(workflowFile), workflowBefore);
  assert.deepEqual(await readFile(evidence), evidenceBefore);
  await assert.rejects(
    readFile(path.join(root, 'singularity/cafe\u0301/WRK-1/artifacts/templates/common/intake.md')),
    (error) => error?.code === 'ENOENT'
  );
});

test('seeded reinitialization refuses Unicode case-fold aliases before mutation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-unicode-casefold-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);

  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.workItemRoot = 'singularity/straße';
  workflow.templatesRoot = 'singularity/strasse/WRK-1/artifacts/templates';
  await writeFile(workflowFile, YAML.stringify(workflow));
  const workflowBefore = await readFile(workflowFile);

  await assert.rejects(
    refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
    (error) => error?.code === 'CONFIGURATION_ASSET_ROOT_INVALID'
  );

  assert.deepEqual(await readFile(workflowFile), workflowBefore);
  await assert.rejects(
    readFile(path.join(root, 'singularity/strasse/WRK-1/artifacts/templates/common/intake.md')),
    (error) => error?.code === 'ENOENT'
  );
});

test('seeded reinitialization refuses Windows-forbidden configured path characters', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-windows-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.templatesRoot = 'singularity/tem*plates';
  await writeFile(workflowFile, YAML.stringify(workflow));
  const before = await readFile(workflowFile);

  await assert.rejects(
    refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
    (error) => error?.code === 'CONFIGURATION_ASSET_ROOT_INVALID'
  );
  assert.deepEqual(await readFile(workflowFile), before);
  await assert.rejects(
    readFile(path.join(root, PACKAGE_BASELINE_PATH)),
    (error) => error?.code === 'ENOENT'
  );
});

test('seeded reinitialization refuses Windows-forbidden retired baseline paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-seeded-windows-retired-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  await refreshPackagedConfiguration(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const baselineFile = path.join(root, PACKAGE_BASELINE_PATH);
  const baseline = YAML.parse(await readFile(baselineFile, 'utf8'));
  baseline.assets['singularity/tem*plates/retired.md'] = {
    sha256: 'forged-retired-package-hash'
  };
  await writeFile(baselineFile, YAML.stringify(baseline));
  const workflowBefore = await readFile(workflowFile);
  const baselineBefore = await readFile(baselineFile);

  await assert.rejects(
    refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
    (error) => error?.code === 'CONFIGURATION_ASSET_PATH_INVALID'
  );
  assert.deepEqual(await readFile(workflowFile), workflowBefore);
  assert.deepEqual(await readFile(baselineFile), baselineBefore);
});

test('seeded reinitialization refuses unsafe retired baseline entries before mutation', async (t) => {
  for (const [label, relative, code, historicalWorkItemRoot, historicalTemplatesRoot] of [
    ['work-item', 'singularity/work-items/WRK-1/artifacts/legacy-seed.md',
      'CONFIGURATION_RETIRED_ASSET_RUNTIME_OVERLAP', null],
    ['case-folded-work-item', 'Singularity/Work-Items/WRK-1/artifacts/legacy-seed.md',
      'CONFIGURATION_RETIRED_ASSET_RUNTIME_OVERLAP', null],
    ['historical-work-item', 'governed/old-work-items/WRK-1/artifacts/legacy-seed.md',
      'CONFIGURATION_RETIRED_ASSET_RUNTIME_OVERLAP', 'governed/old-work-items'],
    ['test-evidence', '.sflow/results/legacy-seed.json',
      'CONFIGURATION_RETIRED_ASSET_RUNTIME_OVERLAP', null],
    ['application-source', 'src/app.js',
      'CONFIGURATION_RETIRED_ASSET_TARGET_UNMANAGED', null, 'src']
  ]) {
    await t.test(label, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `sflow-retired-runtime-${label}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      await initializeFixture(root);
      await refreshPackagedConfiguration(root);

      const baselineFile = path.join(root, PACKAGE_BASELINE_PATH);
      const baseline = YAML.parse(await readFile(baselineFile, 'utf8'));
      delete baseline.ownership;
      if (historicalWorkItemRoot) baseline.workflow.workItemRoot = historicalWorkItemRoot;
      if (historicalTemplatesRoot) baseline.workflow.templatesRoot = historicalTemplatesRoot;
      baseline.assets[relative] = { sha256: 'forged-retired-package-hash' };
      await writeFile(baselineFile, YAML.stringify(baseline));

      const evidence = path.join(root, relative);
      await mkdir(path.dirname(evidence), { recursive: true });
      await writeFile(evidence, 'retain runtime evidence exactly\n');
      const missingSeed = path.join(root, '.github/agents/qa.agent.md');
      await rm(missingSeed);

      const workflowFile = path.join(root, 'singularity/workflow.yml');
      const workflowBefore = await readFile(workflowFile);
      const baselineBefore = await readFile(baselineFile);
      const evidenceBefore = await readFile(evidence);

      await assert.rejects(
        refreshPackagedConfiguration(root, { restorePackagedSeeds: true }),
        (error) => error?.code === code
      );

      assert.deepEqual(await readFile(workflowFile), workflowBefore);
      assert.deepEqual(await readFile(baselineFile), baselineBefore,
        'a rejected retired path must not rewrite its baseline receipt');
      assert.deepEqual(await readFile(evidence), evidenceBefore);
      await assert.rejects(readFile(missingSeed), (error) => error?.code === 'ENOENT',
        'current package assets must not be restored before the retired set is validated');
    });
  }
});

test('seeded reinitialization preserves an unregistered retired configuration asset despite a forged receipt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-unregistered-retired-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  await refreshPackagedConfiguration(root);

  const relative = 'singularity/custom-policy.yml';
  const target = path.join(root, relative);
  const bytes = Buffer.from('repositoryPolicy: retain-exactly\n');
  await writeFile(target, bytes);
  const baselineFile = path.join(root, PACKAGE_BASELINE_PATH);
  const baseline = YAML.parse(await readFile(baselineFile, 'utf8'));
  baseline.assets[relative] = {
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
  baseline.ownership.assets[relative] = 'framework';
  await writeFile(baselineFile, YAML.stringify(baseline));

  const result = await refreshPackagedConfiguration(root, { restorePackagedSeeds: true });

  assert.deepEqual(await readFile(target), bytes);
  assert.equal(result.removed.includes(relative), false);
  assert.equal(result.files.includes(relative), false);
  assert.ok(result.conflicts.some((entry) =>
    entry.path === relative && entry.resolution === 'preserved-local'));
  const receipt = YAML.parse(await readFile(baselineFile, 'utf8'));
  assert.equal(receipt.ownership.assets[relative], 'repository');
});

test('ordinary refresh conflict resolutions use each repository custom templates policy and fail closed elsewhere', async (t) => {
  const customRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-custom-template-resolution-'));
  const defaultRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-default-template-resolution-'));
  t.after(() => Promise.all([
    rm(customRoot, { recursive: true, force: true }),
    rm(defaultRoot, { recursive: true, force: true })
  ]));
  await initializeFixture(customRoot);
  await initializeFixture(defaultRoot);

  const workflowFile = path.join(customRoot, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.templatesRoot = 'governed/templates';
  await writeFile(workflowFile, YAML.stringify(workflow));
  const relative = 'governed/templates/feature/requirements.md';
  const target = path.join(customRoot, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, '# Repository collision at the approved custom root\n');

  const refreshed = await refreshPackagedConfiguration(customRoot, {
    resolutions: { [relative]: 'bundled' }
  });
  assert.equal(await readFile(target, 'utf8'),
    await readFile(path.join(ROOT, 'templates/artifacts/feature/requirements.md'), 'utf8'));
  assert.ok(refreshed.files.includes(relative));
  assert.equal(refreshed.conflicts.some((entry) =>
    entry.path === relative && entry.resolution === 'preserved-local'), false);

  await assert.rejects(
    refreshPackagedConfiguration(defaultRoot, {
      dryRun: true,
      resolutions: { [relative]: 'bundled' }
    }),
    (error) => error?.code === 'CONFIGURATION_CONFLICT_PATH_UNMANAGED',
    'a resolution approved for one repository custom root cannot cross into another repository'
  );
});
