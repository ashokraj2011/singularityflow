import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { environmentFilesToolGuard, plainChatEnvironmentFilesGuard } from '../src/copilot-environment-files-guard.mjs';
import { hookAnswerForEveryHost } from '../src/copilot-repository-boundary.mjs';
import { searchesInCommand, searchOfTool } from '../src/copilot-search-exposure.mjs';

const VALUE = 'Xq7mA2pLz9vB4xT';

async function repository(t, { sflow = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-search-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  if (sflow) { await mkdir(path.join(root, 'singularity')); await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'version: 1\n'); }
  await writeFile(path.join(root, 'application.yml'), `server:\n  port: 8080\npassword: ${VALUE}\n`);
  await writeFile(path.join(root, 'clean.yml'), 'password: ${DB_PASSWORD}\n');
  await writeFile(path.join(root, '.env'), `API_KEY=${VALUE}\n`);
  await writeFile(path.join(root, 'src', 'app.js'), 'const passwordField = "password";\n');
  return root;
}

const shell = (root, command) => ({ cwd: root, toolName: 'bash', toolArgs: { command } });
const tool = (root, toolName, toolArgs) => ({ cwd: root, toolName, toolArgs });
const denied = async (payload, guard = environmentFilesToolGuard) => (await guard(payload))?.permissionDecisionReason ?? null;

test('a search whose pattern would print a line holding a real value is refused, and says how to search without that file', async (t) => {
  const root = await repository(t);
  for (const command of ['grep -rn password .', 'grep -Rin PASSWORD .', 'rg password', 'rg -n "pass(word|wd)" .', 'git grep password', 'ag password .', 'grep -r -e password .']) {
    const reason = await denied(shell(root, command));
    assert.match(reason ?? '', /^CONFIG_VALUE_PRIVATE: this search would show a real value in .*application\.yml \(.*line 3\)/u, command);
    assert.match(reason, /--exclude=application\.yml/u);
    assert.doesNotMatch(reason, new RegExp(VALUE, 'u'), 'a refusal never prints the value');
  }
  for (const args of [{ pattern: 'password', paths: '.', output_mode: 'content' }, { pattern: 'password' }]) {
    assert.match(await denied(tool(root, 'grep', args)) ?? '', /^CONFIG_VALUE_PRIVATE/u, JSON.stringify(args));
  }
  assert.match(await denied(tool(root, 'grep_search', { query: 'password' })) ?? '', /^CONFIG_VALUE_PRIVATE/u);
});

test('other searches keep working: other words, no matching line, excluded files, narrower folders, names only', async (t) => {
  const root = await repository(t);
  for (const command of ['grep -rn timeout .', 'grep -rn token .', 'grep -rn password . --exclude=application.yml', "grep -rn password --exclude '*.yml' .",
    "rg -g '!application.yml' password", 'rg password src', 'grep -rn password src', "git grep password -- ':!application.yml'", 'grep -rln password .',
    'rg --files-with-matches password', 'rg -l password', 'cat notes.txt | grep password', 'grep password src/app.js', 'echo password', 'ls -R']) {
    assert.equal(await denied(shell(root, command)), null, command);
  }
  for (const [name, args] of [['grep', { pattern: 'password', output_mode: 'files_with_matches' }], ['grep', { pattern: 'password', output_mode: 'count' }],
    ['grep', { pattern: 'password', glob: '*.js' }], ['grep', { pattern: 'password', paths: 'src' }], ['grep_search', { query: 'password', includePattern: 'src/**' }],
    ['grep_search', { query: 'timeout' }], ['glob', { pattern: '**/*.key' }]]) {
    assert.equal(await denied(tool(root, name, args)), null, JSON.stringify(args));
  }
});

test('an always-local file: any line a search would print counts, for a search that reads hidden files', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'application.yml'), 'server:\n  port: 8080\n');
  assert.match(await denied(shell(root, 'grep -rn API_KEY .')) ?? '', /^ENVIRONMENT_FILE_PRIVATE: this search would show lines of \.env/u);
  assert.match(await denied(tool(root, 'grep_search', { query: 'API_KEY' })) ?? '', /^ENVIRONMENT_FILE_PRIVATE/u);
  assert.match(await denied(shell(root, 'rg --hidden API_KEY')) ?? '', /^ENVIRONMENT_FILE_PRIVATE/u);
  // ripgrep and Copilot CLI's search tool skip hidden files.
  assert.equal(await denied(shell(root, 'rg API_KEY')), null);
  assert.equal(await denied(tool(root, 'grep', { pattern: 'API_KEY', output_mode: 'content' })), null);
  // A waived value is no finding.
  await writeFile(path.join(root, 'application.yml'), `# sflow-allow-secret: a test fixture\npassword: ${VALUE}\n`);
  assert.equal(await denied(shell(root, 'grep -rn password --exclude=.env .')), null);
});

test('a file in a folder the walk skips, or a repository without SFlow in a plain chat, is left alone', async (t) => {
  const root = await repository(t);
  await rm(path.join(root, 'application.yml'));
  await writeFile(path.join(root, 'node_modules', 'dep', 'app.yml'), `password: ${VALUE}\n`);
  assert.equal(await denied(shell(root, 'grep -rn password --exclude=.env .')), null);
  const other = await repository(t, { sflow: false });
  assert.equal(await denied(shell(other, 'grep -rn password .'), plainChatEnvironmentFilesGuard), null);
  const used = await repository(t);
  assert.match(await denied(shell(used, 'grep -rn password .'), plainChatEnvironmentFilesGuard) ?? '', /^CONFIG_VALUE_PRIVATE/u);
  const allowed = await plainChatEnvironmentFilesGuard(shell(used, 'grep -rn password .'), { policyFor: async () => 'allow' });
  assert.equal(allowed, null, 'a capability that allows plain chats allows their searches');
});

test('reading a search from a shell line', () => {
  const [first] = searchesInCommand('grep -rnI --include=*.js --exclude-dir=gen -A3 -e secret src lib', '.');
  assert.deepEqual([first.pattern, first.roots, first.includes, first.excludes], ['secret', ['src', 'lib'], ['*.js'], ['**/gen/**']]);
  assert.deepEqual(searchesInCommand('grep secret file.txt', '.'), [], 'not recursive: a named file is the named-file check\'s');
  assert.deepEqual(searchesInCommand('grep -d skip secret .', '.'), []);
  assert.equal(searchesInCommand('grep -d recurse secret .', '.').length, 1);
  assert.equal(searchesInCommand('rg -F -- -secret', '.')[0].literal, true);
  assert.equal(searchesInCommand('grep -rf patterns.txt .', '.')[0]?.anything ?? true, true);
  assert.equal(searchOfTool('view', { pattern: 'x' }), null);
});

test('a hook answer is readable by every host: VS Code reads a decision only under hookSpecificOutput, Copilot CLI at the top level', () => {
  const refusal = { permissionDecision: 'deny', permissionDecisionReason: 'WHY', next: [] };
  assert.deepEqual(hookAnswerForEveryHost('boundary-guard', refusal), { ...refusal,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'WHY' } });
  assert.deepEqual(hookAnswerForEveryHost('boundary-after', { additionalContext: 'NOTE' }).hookSpecificOutput, { hookEventName: 'PostToolUse', additionalContext: 'NOTE' });
  assert.deepEqual(hookAnswerForEveryHost('agent-start', { additionalContext: 'NOTE' }).hookSpecificOutput, { hookEventName: 'SubagentStart', additionalContext: 'NOTE' });
  assert.deepEqual(hookAnswerForEveryHost('boundary-stop', { decision: 'block', reason: 'NOT DONE' }).hookSpecificOutput, { hookEventName: 'Stop', decision: 'block', reason: 'NOT DONE' });
  assert.deepEqual(hookAnswerForEveryHost('boundary-guard', {}), {}, 'nothing to say stays nothing');
  assert.deepEqual(hookAnswerForEveryHost('boundary-turn', { additionalContext: 'NOTE' }), { additionalContext: 'NOTE' }, 'VS Code reads a turn\'s context at the top level');
});
