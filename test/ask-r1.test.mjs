import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ASK_DESTINATIONS, askSuggestions } from '../src/ask/navigation.mjs';
import { askIntent } from '../src/ask/query.mjs';
import { validateArguments } from '../src/gateway/argument-schemas.mjs';
import { resolveHelp } from '../src/help-service.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';

test('Ask SFlow ranks exact menu IDs first and keeps typo-tolerant suggestions within eight entries', async () => {
  const corpus = {
    home: ['Where is my work?', 'overviw', 'current work'],
    specs: ['Where do I write a specification?', 'specifcation', 'specc studio'],
    stories: ['storie', 'story list', 'find stories'],
    workflows: ['workflow designer', 'workflow rules', 'worklfows'],
    agents: ['agent catalog', 'agnts', 'configured agents'],
    skills: ['skill catalog', 'skilss', 'copilot skills'],
    instructions: ['instructions library', 'instrctions', 'prompt instructions'],
    code: ['Where is code explainer?', 'explain code', 'code map'],
    run: ['Where can I start the app?', 'run tests', 'run and test'],
    decisions: ['decision list', 'review queue', 'approvlas'],
    help: ['documentation', 'hlep', 'help center'],
    workspaces: ['workspace list', 'worksapces', 'manage workspace'],
    configuration: ['repository settings', 'workspace configuration', 'configurtion'],
    analytics: ['Story Analytics', 'story dashboard', 'story analtyics'],
    activity: ['activity log', 'workspace logs', 'operation history'],
    about: ['build date', 'versoin', 'installation version']
  };
  const search = Object.entries(corpus).flatMap(([id, queries]) => queries.map(query => ({ id, query })));
  const matches = search.filter(({ id, query }) => askSuggestions(query).slice(0, 3).some(item => item.id === id));
  assert.ok(matches.length / search.length >= 0.95, JSON.stringify(search.filter(item => !matches.includes(item))));
  const { topics } = await resolveHelp('');
  for (const { id, topic } of ASK_DESTINATIONS) {
    assert.equal(askSuggestions(id)[0].id, id);
    assert.ok(topics.some(item => item.id === topic), 'A destination must have a shipped help source');
  }
  assert.ok(askSuggestions('Where can I find shortcuts and workspace menus?').length <= 8);
  assert.deepEqual(askSuggestions('agents', new Set(['specs'])), []);
});

test('Ask SFlow uses a closed read contract and distinguishes exact references and future capabilities', () => {
  assert.deepEqual(askIntent('Open the spec spec-price-5@2'), { kind: 'spec', reference: 'SPEC-PRICE-5@2' });
  assert.deepEqual(askIntent('Show the spec used for story CHECKOUT'), { kind: 'story-spec', workId: 'CHECKOUT', workKind: 'story' });
  assert.equal(askIntent('How do I publish?').kind, 'discovery');
  assert.deepEqual(askIntent('What changed last week?'), { kind: 'unsupported', feature: 'history' });
  assert.deepEqual(askIntent('Start a Story for a checkout change'), { kind: 'unsupported', feature: 'task' });
  assert.throws(() => validateArguments('ask-query-v1', { query: 'publish', execute: true }),
    error => error.code === 'UNKNOWN_OPERATION_ARGUMENT');
  assert.throws(() => validateArguments('ask-query-v1', { query: 'x'.repeat(2001) }),
    error => error.code === 'INVALID_OPERATION_ARGUMENT');
});

test('CLI suggestions need no Git process even inside a selected checkout', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-ask-suggest-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const observer = path.join(base, 'no-child.mjs');
  await writeFile(observer, [
    "import cp from 'node:child_process';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) cp[name] = () => { throw new Error('Suggestion launched a process'); };",
    'syncBuiltinESMExports();', ''
  ].join('\n'));
  const { status, stdout, stderr } = spawnSync(process.execPath, ['--import', observer, bin, 'ask', '--suggest', 'specifcation', '--json'], {
    encoding: 'utf8', env: isolatedTestEnvironment(path.join(base, 'machine'))
  });
  assert.equal(status, 0, stderr || stdout);
  const result = JSON.parse(stdout);
  assert.equal(result.resultType, 'sflow-ask');
  assert.equal(result.items[0].label, 'Spec Studio');
});
