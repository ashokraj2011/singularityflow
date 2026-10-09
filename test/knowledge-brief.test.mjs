/**
 * The repository brief: README and docs statements plus repository knowledge as evidence, every
 * view (rules, contracts, flows, impact, risks, questions) built from it without a model, and model
 * statements kept only when what they name is in what they cite.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  briefEvidence, briefKey, briefOrder, buildBriefPrompt, documentStatements, readDocumentation,
  templateBrief, validateBrief, writeCachedBrief
} from '../src/knowledge/brief.mjs';
import { knowledgeCommand } from '../src/knowledge/command.mjs';
import { buildKnowledge } from '../src/knowledge/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

const README = `# Orders Service

Takes customer orders, checks them and stores them.

## Business rules

- An order needs at least one line.
- Orders under 10.00 are not accepted.
- VIP customers get a discount of 5%.

## Error responses

| Status | When |
| --- | --- |
| 422 | the order fails validation |

\`\`\`
curl -X POST /orders   # an example, not a rule
\`\`\`

The service is written in Java.
`;

/** The Spring orders fixture with a README, committed in its own repository. */
async function ordersRepository(t) {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-brief-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', 'orders-spring'), repository, { recursive: true });
  await writeFile(path.join(repository, 'README.md'), README);
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'add', '-A');
  git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Fixture');
  return repository;
}

async function quiet(fn) {
  const log = console.log;
  const lines = [];
  console.log = (value) => lines.push(String(value));
  try { await fn(); } finally { console.log = log; }
  return lines.join('\n');
}

test('docs statements keep rule-like lines with their heading, and skip code and plain prose', () => {
  const { statements, overview } = documentStatements('README.md', README);
  assert.equal(overview.text, 'Takes customer orders, checks them and stores them.');
  const texts = statements.map((statement) => statement.text);
  assert.ok(texts.includes('An order needs at least one line.'));
  assert.ok(texts.includes('Orders under 10.00 are not accepted.'));
  assert.ok(texts.some((text) => text.startsWith('422 — the order fails validation')), 'a table row under a rules heading');
  assert.ok(!texts.some((text) => text.includes('curl')), 'fenced code is not a statement');
  assert.ok(!texts.includes('The service is written in Java.'), 'plain prose is not a rule');
  assert.equal(statements.find((statement) => statement.text.startsWith('Orders under')).heading, 'Orders Service › Business rules');
});

test('every view is built from the evidence without a model, and a promised status the code never returns becomes a question', async (t) => {
  const repository = await ordersRepository(t);
  const { knowledge } = await buildKnowledge(repository, { history: false });
  const documentation = readDocumentation(repository);
  assert.deepEqual(documentation.files.map((file) => file.path), ['README.md']);
  const evidence = briefEvidence(knowledge, documentation);
  assert.ok(evidence.every((entry) => /^E\d+$/u.test(entry.id)));
  const { views } = templateBrief(evidence);
  for (const view of ['overview', 'rules', 'contracts', 'flows', 'impact', 'questions']) assert.ok(views[view].length, `${view} has statements`);
  assert.ok(views.rules.some((statement) => /refuses "An order needs at least one line"/u.test(statement.text)), 'a code rule with its message');
  assert.ok(views.rules.every((statement) => statement.sources.length), 'every rule names its source');
  assert.ok(views.contracts.some((statement) => statement.text.startsWith('POST /orders')), 'the endpoint');
  assert.ok(views.questions.some((statement) => /docs promise HTTP 422/u.test(statement.text) && /Which is right\?$/u.test(statement.text)));
  assert.deepEqual(briefOrder('intake').slice(0, 3), ['overview', 'rules', 'questions']);
  assert.deepEqual(briefOrder('implementation').slice(0, 2), ['overview', 'impact']);
});

test('a model statement is kept only when everything it names is in what it cites', async (t) => {
  const repository = await ordersRepository(t);
  const { knowledge } = await buildKnowledge(repository, { history: false });
  const evidence = briefEvidence(knowledge, readDocumentation(repository));
  const rule = evidence.find((entry) => entry.view === 'rules' && entry.text.includes('An order needs at least one line'));
  const documented = evidence.find((entry) => entry.view === 'docs' && entry.text === 'An order needs at least one line.');
  const endpoint = evidence.find((entry) => entry.view === 'contracts' && entry.text.startsWith('POST /orders'));
  const prompt = buildBriefPrompt(knowledge, evidence);
  assert.match(prompt.text, /Return JSON only/u);
  assert.ok(prompt.text.includes(`${rule.id} [rule]`));
  const output = JSON.stringify({
    summary: { text: 'Customers place orders through POST /orders.', cites: [endpoint.id] },
    views: {
      rules: [
        { text: 'An order is refused with "An order needs at least one line" when it has no lines; the README says the same.', cites: [rule.id, documented.id] },
        { text: 'Orders over 99999 are refused.', cites: [rule.id] },
        { text: 'This validation is correct and secure.', cites: [rule.id] },
        { text: 'Orders need lines.', cites: [] },
        { text: 'Orders need lines.', cites: ['E9999'] }
      ],
      contracts: [{ text: `Orders arrive at POST /orders [${endpoint.id}]` }]
    }
  });
  const checked = validateBrief(`Here is the brief:\n\`\`\`json\n${output}\n\`\`\``, evidence);
  assert.equal(checked.views.rules.length, 1);
  assert.deepEqual(checked.views.rules[0].cites, [rule.id, documented.id]);
  assert.ok(checked.views.rules[0].sources.some((source) => source.path === 'README.md'));
  assert.equal(checked.views.contracts.length, 1, 'a citation written inline in the text counts');
  assert.equal(checked.views.overview.length, 1);
  assert.deepEqual(checked.rejected.map((entry) => entry.reason).sort(), [
    'cites nothing', 'cites unknown evidence: E9999', 'judges instead of describing', 'names what its evidence does not contain: 99999'
  ]);
  assert.throws(() => validateBrief('not json at all', evidence), { code: 'KNOWLEDGE_BRIEF_INVALID' });
});

// A Copilot CLI stand-in over ACP stdio: it answers with one grounded contracts statement and one
// the checks must drop. It never calls a model.
const FAKE_COPILOT = `#!/usr/bin/env node
import readline from 'node:readline';
if (process.argv.includes('--help')) { console.log('Usage: copilot --acp'); process.exit(0); }
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const strings = (value) => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'brief', configOptions: [] } });
  else if (message.method === 'session/prompt') {
    const id = strings(message.params).join('\\n').match(/^(E\\d+) \\[entry-point\\] POST \\/orders/mu)[1];
    const text = JSON.stringify({ views: { contracts: [{ text: 'Orders arrive at POST /orders.', cites: [id] }, { text: 'Orders over 99999 are refused.', cites: [id] }] } });
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'brief', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text } } } });
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  }
}
`;

test('the model writes the brief in a repository with no Singularity Flow configuration', async (t) => {
  const repository = await ordersRepository(t);
  // Only the stand-in, node and git are reachable, so no real Copilot can run.
  const bin = await mkdtemp(path.join(os.tmpdir(), 'sflow-brief-bin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(bin, 'copilot'), FAKE_COPILOT, { mode: 0o755 });
  await symlink(process.execPath, path.join(bin, 'node'));
  await symlink(await realpath(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()), path.join(bin, 'git'));
  const PATH = `${bin}:/usr/bin:/bin`;
  assert.equal(spawnSync('sh', ['-c', 'command -v copilot'], { encoding: 'utf8', env: { PATH } }).stdout.trim(), path.join(bin, 'copilot'));
  const env = { ...process.env, PATH };
  delete env.SINGULARITY_FLOW_NO_MODEL;
  const run = spawnSync(process.execPath, [path.join(root, 'bin', 'singularity-flow.mjs'), 'wm', 'knowledge', 'brief', '--json', '--refresh'], { cwd: repository, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const brief = JSON.parse(run.stdout);
  assert.equal(brief.mode, 'model', brief.reason);
  assert.equal(brief.model, 'copilot-cli');
  assert.deepEqual(brief.views.contracts.map((statement) => [statement.text, statement.origin]), [['Orders arrive at POST /orders.', 'model']]);
  assert.deepEqual(brief.rejections.map((entry) => entry.reason), ['names what its evidence does not contain: 99999']);
  assert.equal(git(repository, 'status', '--porcelain'), '', 'nothing is written to the working tree');
});

test('a checked-out branch with no code is briefed from the newest branch with code, read from Git without a checkout', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-brief-ref-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const commit = (message) => git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', message);
  git(repository, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repository, 'README.md'), '# Orders\n\nNothing here yet.\n');
  git(repository, 'add', '-A');
  commit('Start');
  git(repository, 'checkout', '-q', '-b', 'feature');
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', 'orders-spring'), repository, { recursive: true });
  await writeFile(path.join(repository, 'README.md'), README);
  git(repository, 'add', '-A');
  commit('Orders service');
  git(repository, 'checkout', '-q', 'main');

  const brief = JSON.parse(await quiet(() => knowledgeCommand(repository, ['brief'], { json: true, cached: true })));
  assert.deepEqual(brief.source, { ref: 'feature', commit: git(repository, 'rev-parse', 'feature'), checkedOut: 'main', chosen: 'has-code', fetched: 0, remote: null });
  assert.equal(brief.branch, 'feature');
  assert.ok(brief.evidence.codeFiles > 0);
  assert.ok(brief.views.contracts.some((statement) => statement.text.startsWith('POST /orders')), 'the feature branch code');
  assert.ok(brief.documented.some((entry) => entry.text === 'An order needs at least one line.'), "the feature branch's README");
  assert.deepEqual(brief.branches.sort(), ['feature', 'main']);
  assert.equal(git(repository, 'branch', '--show-current'), 'main', 'nothing was checked out');
  assert.equal(git(repository, 'status', '--porcelain'), '', 'nothing was written to the working tree');

  const named = JSON.parse(await quiet(() => knowledgeCommand(repository, ['brief'], { json: true, ref: 'main' })));
  assert.equal(named.source.chosen, 'requested');
  assert.equal(named.evidence.codeFiles, 0);
  assert.equal(named.mode, 'template');
  assert.match(named.reason, /^There is nothing to brief at branch main \([0-9a-f]{12}\): .*Name a branch that has code\.$/u);
  await assert.rejects(() => knowledgeCommand(repository, ['brief'], { json: true, ref: 'missing' }), { code: 'KNOWLEDGE_REF_UNKNOWN' });
});

test('in a blobless clone, the files of a branch never checked out are fetched into .git before the brief reads them', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-brief-partial-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const commit = (cwd, message) => git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', message);
  git(base, 'init', '-q', '-b', 'main', source);
  await writeFile(path.join(source, 'README.md'), '# Orders\n\nNothing here yet.\n');
  git(source, 'add', '-A');
  commit(source, 'Start');
  git(source, 'checkout', '-q', '-b', 'feature');
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', 'orders-spring'), source, { recursive: true });
  await writeFile(path.join(source, 'README.md'), README);
  git(source, 'add', '-A');
  commit(source, 'Orders service');
  git(source, 'checkout', '-q', 'main');
  git(source, 'config', 'uploadpack.allowFilter', 'true');
  git(source, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const clone = path.join(base, 'clone');
  git(base, 'clone', '-q', '--filter=blob:none', `file://${source}`, clone);
  const feature = git(clone, 'rev-parse', 'origin/feature');
  const missing = () => spawnSync('git', ['rev-list', '--objects', '--missing=print', '--no-walk', feature], { cwd: clone, encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } })
    .stdout.split('\n').filter((line) => line.startsWith('?')).length;
  assert.ok(missing() > 0, 'the feature files start out missing');

  const brief = JSON.parse(await quiet(() => knowledgeCommand(clone, ['brief'], { json: true, cached: true })));
  assert.equal(brief.source.ref, 'origin/feature');
  assert.equal(brief.source.remote, 'origin');
  assert.ok(brief.source.fetched > 0, 'the missing files were fetched');
  assert.ok(brief.views.contracts.some((statement) => statement.text.startsWith('POST /orders')));
  assert.equal(git(clone, 'branch', '--show-current'), 'main', 'nothing was checked out');
  assert.equal(git(clone, 'status', '--porcelain'), '');
});

test('wm knowledge brief shows the model brief written earlier, and the template brief otherwise', async (t) => {
  const repository = await ordersRepository(t);
  const template = JSON.parse(await quiet(() => knowledgeCommand(repository, ['brief'], { json: true, cached: true })));
  assert.equal(template.mode, 'template');
  assert.ok(template.reason);
  assert.deepEqual(template.order, ['overview', 'rules', 'contracts', 'flows', 'impact', 'risks', 'questions']);

  // The same evidence the command builds, then a recorded model answer cached under its key.
  const result = await buildKnowledge(repository, { history: true });
  const documentation = readDocumentation(repository);
  const evidence = briefEvidence(result.knowledge, documentation);
  const prompt = buildBriefPrompt(result.knowledge, evidence);
  const endpoint = evidence.find((entry) => entry.view === 'contracts' && entry.text.startsWith('POST /orders'));
  const checked = validateBrief({ views: { contracts: [{ text: 'Orders arrive at POST /orders.', cites: [endpoint.id] }] } }, evidence);
  await writeCachedBrief(repository, briefKey(result.key, documentation, prompt, null), {
    model: 'recorded-model', createdAt: '2026-10-09T12:00:00.000Z', views: checked.views, rejected: [{ view: 'rules', text: 'x', reason: 'cites nothing' }]
  });
  const written = JSON.parse(await quiet(() => knowledgeCommand(repository, ['brief'], { json: true, cached: true, phase: 'design' })));
  assert.equal(written.mode, 'model');
  assert.equal(written.model, 'recorded-model');
  assert.equal(written.cached, true);
  assert.equal(written.rejected, 1);
  assert.deepEqual(written.views.contracts.map((statement) => [statement.text, statement.origin]), [['Orders arrive at POST /orders.', 'model']]);
  assert.ok(written.views.rules.length && written.views.rules.every((statement) => statement.origin === 'template'), 'a view the model left empty shows its evidence');
  assert.deepEqual(written.order.slice(0, 2), ['overview', 'contracts']);
  const markdown = await quiet(() => knowledgeCommand(repository, ['brief'], { cached: true }));
  assert.match(markdown, /Written by recorded-model/u);
  assert.match(markdown, /## Contracts \(arch\.contracts\)/u);
});
