/**
 * A Story whose later step smoke-checks a browser against its authorized origin.
 *
 * spec-code-test-loop's testing review requires a live Playwright smoke (a workflow phaseOverride),
 * and the smoke binds to the origin the Story pinned. Start used to ask for that origin only for the
 * POC workflow, so a Story started the normal way could never pass testing. Start still takes it
 * without refusing (only the POC workflow requires it) and names the pin; a Story started without
 * one has it pinned once by a person who approves the step: previewed, digest-confirmed and committed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { childTimeout } from './helpers/child-timeout.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const ORIGIN = 'https://staging.example.test';

test('start pins the target a later browser smoke needs when given, and a Story without one has it pinned once by a step approver', { timeout: 300_000 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-target-origin-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Origin Tester',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Origin Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'origin.tester@example.invalid' };
  const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000) });
  const must = (command, args, cwd = root) => {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  const refused = (...args) => {
    const result = run(process.execPath, [cli, '--no-model', ...args, '--json']);
    assert.notEqual(result.status, 0, `${args.join(' ')} should be refused\n${result.stdout}`);
    return JSON.parse(result.stdout).error;
  };
  const story = async (id) => JSON.parse(await readFile(path.join(root, 'singularity/work-items', id, 'workflow.json'), 'utf8'));
  const head = () => must('git', ['rev-parse', 'HEAD']).trim();

  must('git', ['init', '-q', '-b', 'main', root], base);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Target origin fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  const start = (id, ...extra) => ['start', id, '--from-branch', 'main', '--work-type', 'spec-code-test-loop', ...extra,
    '--title', 'Show a value', '--description', 'Show the value in the browser.', '--readiness-baseline', 'defer'];

  // Given at start, the origin is pinned for the step that smoke-checks it.
  sflow(...start('LOOP-0', '--target-url', `${ORIGIN}/checkout`));
  assert.deepEqual((await story('LOOP-0')).mcpAuthorizations.playwright.origins, [ORIGIN]);
  must('git', ['checkout', '-q', 'main']);

  // Without one the Story still starts, as it always did, with no authorized origin to smoke against.
  sflow(...start('LOOP-1'));
  assert.deepEqual((await story('LOOP-1')).mcpAuthorizations, {});

  // The preview changes nothing and names exactly what would be pinned, and by whom.
  const before = head();
  const preview = JSON.parse(sflow('story', 'target-origin', 'LOOP-1', '--url', `${ORIGIN}/checkout`, '--json'));
  assert.deepEqual([preview.data.origin, preview.data.servers, preview.data.steps], [ORIGIN, ['playwright'], ['testing']]);
  assert.ok(preview.data.authorities.includes('quality-reviewers'));
  assert.match(preview.data.planSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(preview.next[0].command, preview.data.confirmCommand);
  assert.equal(head(), before);
  assert.deepEqual((await story('LOOP-1')).mcpAuthorizations, {});

  assert.equal(refused('story', 'target-origin', 'LOOP-1', '--url', ORIGIN, '--reason', 'Approved staging target.',
    '--confirm', `sha256:${'0'.repeat(64)}`).code, 'STORY_TARGET_ORIGIN_CONFIRMATION_STALE');
  assert.equal(refused('story', 'target-origin', 'LOOP-1', '--url', ORIGIN, '--confirm', preview.data.planSha256).code,
    'STORY_TARGET_ORIGIN_USAGE', 'a pin says why');
  assert.equal(head(), before);

  sflow('story', 'target-origin', 'LOOP-1', '--url', ORIGIN, '--reason', 'Approved staging target.', '--confirm', preview.data.planSha256);
  const pinned = await story('LOOP-1');
  const record = pinned.mcpAuthorizations.playwright;
  assert.deepEqual([record.origins, record.source, record.reason, record.planSha256, record.schemaVersion],
    [[ORIGIN], 'story-target-origin', 'Approved staging target.', preview.data.planSha256, 1]);
  assert.ok(record.pinnedBy && record.authorityGroup, JSON.stringify(record));
  assert.equal(pinned.history.at(-1).event, 'mcp_target_origin_pinned');
  assert.match(must('git', ['log', '-1', '--format=%s']).trim(), /^\[LOOP-1\]\[target-origin\] https:\/\/staging\.example\.test$/u);

  // A pinned origin is never replaced or widened, and pinning it again changes nothing.
  assert.equal(refused('story', 'target-origin', 'LOOP-1', '--url', 'https://production.example.test').code, 'STORY_TARGET_ORIGIN_ALREADY_PINNED');
  assert.equal(refused('story', 'target-origin', 'LOOP-1', '--url', ORIGIN).code, 'STORY_TARGET_ORIGIN_ALREADY_PINNED');

  // A workflow with no smoke-checked step has no origin to pin, and still starts without one.
  sflow('start', 'FEAT-1', '--from-branch', 'main', '--work-type', 'feature', '--title', 'Plain change',
    '--description', 'No browser smoke is involved.', '--readiness-baseline', 'defer');
  assert.deepEqual((await story('FEAT-1')).mcpAuthorizations, {});
  assert.equal(refused('story', 'target-origin', 'FEAT-1', '--url', ORIGIN).code, 'STORY_TARGET_ORIGIN_NOT_NEEDED');
});
