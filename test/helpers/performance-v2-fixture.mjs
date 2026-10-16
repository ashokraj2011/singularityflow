/** Disposable local-only qualification repositories; never select a user's workspace. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export async function performanceFixture(base, cli, { workId = 'PERF-1', native = false } = {}) {
  const root = path.join(base, 'repo');
  await mkdir(base, { recursive: true });
  const env = { ...process.env, SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json') };
  if (!native) Object.assign(env, { NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Performance Fixture' });
  else {
    delete env.SINGULARITY_FLOW_AGENT_OUTPUT;
    delete env.SINGULARITY_FLOW_NO_MODEL;
  }
  const run = (command, args, cwd = root, extraEnv = {}) => {
    const started = performance.now();
    const result = spawnSync(command, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024 });
    return { ...result, elapsedMs: performance.now() - started };
  };
  const must = (command, args, cwd, extraEnv) => {
    const result = run(command, args, cwd, extraEnv);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const sflow = (...args) => must(process.execPath, [cli, ...(native ? [] : ['--no-model']), ...args]);
  must('git', ['init', '-q', '-b', 'main', root], base);
  if (!native) {
    must('git', ['config', 'user.name', 'Performance Fixture']);
    must('git', ['config', 'user.email', 'performance@example.invalid']);
  }
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n");
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  // Only local deterministic unit fixtures use test identities. Native runs retain real authority.
  if (!native) {
    config.approvalSecurity = { profile: 'poc' };
    for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  }
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Performance fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', workId, '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the exported value', '--description',
    'Return 2 from src/value.mjs instead of 1; prove it with test/value.test.mjs. Do not change the interface or other behavior.');
  return { base, root, env, run, must, sflow, workId };
}

export async function authoredFixtureIntake(fixture) {
  const { root, workId, sflow } = fixture;
  sflow('prepare', 'intake');
  await writeFile(path.join(root, `singularity/work-items/${workId}/artifacts/intake/intake.md`), [
    `# ${workId} — Quick fix scope and plan`, '', '## Agent brief', '',
    'Change the exported constant from 1 to 2. Keep its name and numeric type unchanged; prove the result in the existing Node test.', '',
    '## Problem and fix', '', 'The current export is 1. The requested result is 2; no other behavior is in scope.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${workId}:AC-001] | The exported value equals 2. |`, '', '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    `| \`${workId}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | The test reads 2. |`, '',
    '## Out of scope', '', 'No additional behavior, dependencies, files, API or interface changes.', ''
  ].join('\n'));
}
