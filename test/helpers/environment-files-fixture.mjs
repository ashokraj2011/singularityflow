/** A repository with declared environment files and a CLI bound to its own machine state [ENVF]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../../bin/singularity-flow.mjs', import.meta.url));

export const DECLARATION = `schemaVersion: 1
environments:
  dev:
    requires:
      - { name: API_BASE_URL, kind: endpoint, value: "https://dev.example.test" }
    localFiles: [services/api/src/main/resources/application-dev.yml, apps/web/.env.dev, .env, "config/*.local.yml"]
  uat:
    requires:
      - { name: API_BASE_URL, kind: endpoint, value: "https://uat.example.test" }
    localFiles: [services/api/src/main/resources/application-uat.yml, apps/web/.env.uat, .env]
`;

export function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['-c', 'user.name=Env Files Tester', '-c', 'user.email=env-files@example.invalid', ...args], { cwd, encoding: 'utf8' });
  if (!allowFailure) assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

export async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
}

/** Machine state for one test: its own workspace registry folder, never the person's. */
export function machineEnvironment(base, extra = {}) {
  return {
    ...process.env, SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'state', 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'state', 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'state', 'leads.json'),
    ...extra
  };
}

export function cliRunner(env, cwd) {
  const sflow = (args, options = {}) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? cwd, env: options.env ?? env, encoding: 'utf8', timeout: 120_000, input: options.input
  });
  const json = (args, options = {}) => {
    const result = sflow([...args, '--json'], options);
    assert.ok(result.stdout.trim(), `${args.join(' ')} printed nothing\n${result.stderr}`);
    return { status: result.status, value: JSON.parse(result.stdout), stderr: result.stderr };
  };
  return { sflow, json };
}

export async function repository(t, { declaration = DECLARATION, files = {}, name = 'repo' } = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'sflow-envf-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, name);
  git(base, ['init', '-q', '-b', 'main', root]);
  await writeFiles(root, {
    'README.md': '# Environment files fixture\n',
    ...(declaration ? { 'singularity/environments.yml': declaration } : {}),
    ...files
  });
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fixture']);
  const env = machineEnvironment(base);
  return { base, root, env, ...cliRunner(env, root) };
}

/** Run `fn` with this test's machine-state variables set in-process, then restore them. */
export async function withMachineState(env, fn) {
  const names = ['SINGULARITY_FLOW_WORKSPACE_REGISTRY', 'SINGULARITY_FLOW_ACTIVE_WORKSPACE', 'SINGULARITY_FLOW_LEAD_REGISTRY'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = env[name];
  try { return await fn(); } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}
