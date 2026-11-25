import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { boundedToolAnswer, createHostGateway } from '../src/gateway/host.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { revisionDirectory } from '../src/spec-library/ids.mjs';
import { revisionFiles } from '../src/spec-library/library.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';

const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const askDate = 'commits from 2026-11-01 to 2026-11-07 in UTC on main';
const actor = { name: 'Ask Conversation Fixture', email: 'ask-fixture@example.invalid' };
const runFile = promisify(execFile);

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-ask-r3-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  await mkdir(root);
  const env = isolatedTestEnvironment(path.join(base, 'machine'));
  const file = async (relative, data) => {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, data);
  };
  function git(...args) {
    const child = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout.trim();
  }
  const commit = (message, day = '2026-11-05T12:00:00Z') => {
    const child = spawnSync('git', ['commit', '--allow-empty', '-qm', message], {
      cwd: root, env: { ...env, GIT_AUTHOR_DATE: day, GIT_COMMITTER_DATE: day }, encoding: 'utf8'
    });
    assert.equal(child.status, 0, child.stderr);
    return git('rev-parse', 'HEAD');
  };
  const cli = async (args, { runModel = false, person = true, directory = root, json = true } = {}) => {
    const childEnv = { ...env };
    if (runModel) delete childEnv.SINGULARITY_FLOW_NO_MODEL;
    const output = await runFile(process.execPath, [bin, 'ask', ...args, ...(json ? ['--json'] : []),
      ...(person ? ['--for-person'] : []), ...(runModel ? [] : ['--no-model'])], {
      cwd: directory, env: childEnv, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 40_000
    });
    return json ? JSON.parse(output.stdout) : output.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', actor.name);
  git('config', 'user.email', actor.email);
  await file('README.md', '# Local Ask fixture\n');
  git('add', 'README.md');
  const initial = commit('initial', '2026-11-04T12:00:00Z');
  return { base, root, env, git, file, commit, cli, initial };
}

const binding = answer => ['--conversation=' + answer.conversation.id, '--revision=' + answer.conversation.revision];

test('R3 restores the exact displayed order, selects an ordinal after HEAD moves, and protects concurrent updates', async t => {
  const { env, cli, commit, root, base, git } = await fixture(t);
  for (let index = 0; index < 20; index++) commit('PRIVATE_SUBJECT_CANARY ' + index);
  const first = await cli([askDate, '--remember']);
  assert.equal(first.conversation?.private, true, JSON.stringify(first));
  assert.equal(first.conversation.hasMore, true);
  const pins = first.history.rows.map(row => row.commit);
  assert.equal(first.links[1], first.history.rows[1].evidenceId);

  const storage = env.SINGULARITY_FLOW_ASK_CONVERSATIONS;
  const names = await readdir(storage, { recursive: true });
  const records = names.filter(name => name.endsWith('.json'));
  assert.equal(records.length, 1);
  const file = path.join(storage, records[0]);
  assert.equal((await lstat(file)).mode & 0o077, 0);
  const bytes = await readFile(file, 'utf8');
  assert.doesNotMatch(bytes, /PRIVATE_SUBJECT_CANARY|commits from|person-facing/);
  assert.ok(!bytes.includes(root));
  assert.ok(!bytes.includes('askp1.'), 'stores normalized checkpoints instead of expiring tool tokens');

  const later = commit('Unselected new change');
  const resumed = await cli(['--resume']);
  assert.deepEqual(resumed.history.rows.map(row => row.commit), pins);
  assert.deepEqual(resumed.links, first.links);
  assert.equal(resumed.resultSetId, first.resultSetId);
  assert.equal(resumed.conversation.revision, 1);
  assert.ok(!resumed.history.rows.some(row => row.commit === later));

  const responses = await Promise.all([
    cli(['the second result', ...binding(resumed)]),
    cli(['--evidence=' + resumed.links[2], ...binding(resumed)])
  ]);
  const winner = responses.find(value => value.status === 'resolved');
  const loser = responses.find(value => value.status === 'conflict');
  assert.equal(winner.conversation.revision, 2);
  assert.equal(loser.currentConversation.contextRevision, 2);
  assert.equal(winner.evidence.revision, winner.evidence.id === resumed.links[1] ? pins[1] : pins[2]);
  const selected = await cli(['--resume']);
  assert.equal(selected.conversation.selectedId, winner.evidence.id);

  const byPosition = await cli(['the second result', ...binding(selected)]);
  assert.equal(byPosition.evidence.revision, pins[1]);
  const next = await cli(['next page', ...binding(byPosition)]);
  assert.equal(next.history.scope.revision, first.history.scope.revision);
  assert.equal(next.history.coverage, undefined);
  assert.equal(next.coverage.count.total, 21);
  assert.equal(next.conversation.selectedId, byPosition.evidence.id);
  const expanded = await cli(['also include the previous week', ...binding(next)]);
  assert.equal(expanded.history.scope.revision, first.history.scope.revision);
  assert.equal(expanded.history.window.startDate, '2026-10-25');
  assert.equal(expanded.history.window.endDate, first.history.window.endDate);

  const outsider = path.join(base, 'other');
  await mkdir(outsider);
  await runFile('git', ['clone', '-q', root, outsider], { cwd: base, env });
  assert.equal((await cli(['--resume', '--conversation=' + first.conversation.id], { directory: outsider })).status, 'unavailable');
  assert.equal((await cli(['--resume', '--conversation=' + first.conversation.id], { person: false })).status, 'unavailable');
  const refs = git('show-ref');
  await assert.rejects(cli(['--no-forget', ...binding(expanded)]), error => /ASK_REQUEST_INVALID/.test(error.stdout));
  assert.equal((await cli(['--forget', ...binding(expanded)])).kind, 'forgotten');
  assert.equal((await cli(['--resume'])).diagnostics[0].code, 'ASK_CONVERSATION_UNAVAILABLE');
  assert.equal(git('show-ref'), refs);
});

test('R3 reopens the selected specification revision and withholds it when the state owner removes it', async t => {
  const { file, git, commit, cli, env } = await fixture(t);
  const specId = 'SPEC-ASK-REVISION';
  async function publish(revision, title, body) {
    const built = revisionFiles({
      specId, revision, parent: null, reviewState: 'reviewed', operationId: 'ask-spec-' + revision, actor,
      recordedAt: '2026-11-04T01:00:00.000Z',
      head: { sequence: revision, snapshotSha256: 'sha256:' + 'a'.repeat(64), draft: { title, kind: 'business', spec: body, gaps: [], research: [] } },
      report: { counts: { d: 0, a: 0, h: 0 }, blocking: [] }
    });
    for (const [name, bytes] of Object.entries(built.files)) await file(revisionDirectory(specId, revision) + '/' + name, bytes);
    git('add', '.');
    return commit('published specification revision ' + revision);
  }
  git('switch', '-qc', 'state');
  const body = '# ORIGINAL_PRIVATE_SPEC_BYTES\n\nExact old language.\n';
  const pinned = await publish(1, 'Exact original title', body);
  git('switch', '-q', 'main');
  const first = await cli([specId, '--remember']);
  assert.equal(first.specifications[0].reference, specId + '@1');
  git('switch', '-q', 'state');
  await publish(2, 'New title', '# New version\n');
  git('switch', '-q', 'main');
  const resume = await cli(['--resume']);
  assert.equal(resume.specifications[0].stateCommit, pinned);
  assert.equal(resume.specifications[0].reference, specId + '@1');
  const display = await cli(['--resume'], { json: false });
  assert.ok(display.includes('--evidence=' + resume.links[0]));
  assert.doesNotMatch(display, /--open-spec/u);
  const selected = await cli(['show that spec', ...binding(resume)]);
  assert.equal(selected.evidence.content, body);
  assert.equal(selected.evidence.revision, pinned);
  const folder = env.SINGULARITY_FLOW_ASK_CONVERSATIONS;
  const files = (await readdir(folder, { recursive: true })).filter(name => name.endsWith('.json'));
  assert.doesNotMatch(await readFile(path.join(folder, files[0]), 'utf8'), /ORIGINAL_PRIVATE_SPEC_BYTES|Exact original title/);

  await file('singularity/work-items/ASK-LINKED/workflow.json', JSON.stringify({
    schemaVersion: 1, status: 'in_progress', currentPhase: 'planning', phaseOrder: ['planning'],
    phases: { planning: { id: 'planning', status: 'in_progress', generation: 0 } },
    workItem: { id: 'ASK-LINKED', title: 'Linked Story', source: { specification: [{
      revision: specId + '@1', stateCommit: pinned, manifestSha256: first.specifications[0].manifestSha256
    }] } }
  }));
  const story = await cli(['story ASK-LINKED', '--remember']);
  const related = await cli(['show the specification behind the first result', ...binding(story)]);
  assert.equal(related.evidence.content, body);
  assert.equal(related.evidence.revision, pinned);
  assert.equal(related.resultSetId, story.resultSetId);

  git('switch', '-q', 'state');
  git('rm', '-rq', revisionDirectory(specId, 1));
  commit('remove old fixture version from the library');
  git('switch', '-q', 'main');
  const revoked = await cli(['--resume', '--conversation=' + first.conversation.id]);
  assert.equal(revoked.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(revoked), /Exact original title|ORIGINAL_PRIVATE_SPEC_BYTES/);
  const staleLink = await cli(['--evidence=' + first.links[0], ...binding(revoked)]);
  assert.equal(staleLink.status, 'unavailable');
  assert.equal(staleLink.evidence, undefined);
  const newest = await cli(['use newest spec', ...binding(revoked)]);
  assert.equal(newest.specifications[0].reference, specId + '@2');
});

test('R3 continues a saved work clarification and checks the exact working record before opening evidence', async t => {
  const { file, cli } = await fixture(t);
  const id = 'SAME-ID';
  const shape = { schemaVersion: 1, currentPhase: 'planning', phaseOrder: ['planning'], status: 'in_progress',
    phases: { planning: { id: 'planning', status: 'in_progress', generation: 0 } } };
  const initiativePath = 'singularity/initiatives/' + id + '/state.json';
  const initiative = { ...shape, initiative: { id, title: 'First initiative evidence' } };
  await file('singularity/work-items/' + id + '/workflow.json', JSON.stringify({ ...shape, workItem: { id, title: 'Story owner' } }));
  await file(initiativePath, JSON.stringify(initiative));
  const ambiguous = await cli(['current work', '--work-id=' + id, '--remember']);
  assert.equal(ambiguous.status, 'clarification', JSON.stringify(ambiguous));
  assert.equal(ambiguous.choices.length, 2);
  const resumed = await cli(['--resume']);
  assert.deepEqual(resumed.choices, ambiguous.choices);
  assert.match(await cli(['--resume'], { json: false }), /--select=choice-2/u);
  const chosen = await cli(['the second result', ...binding(resumed)]);
  assert.equal(chosen.work.kind, ambiguous.choices[1].kind);
  assert.equal(chosen.work.id, id);
  const link = chosen.work.evidenceId;
  const exact = await cli(['--evidence=' + link, ...binding(chosen)]);
  assert.equal(exact.evidence.locator, initiativePath);
  assert.ok(exact.evidence.details.recordSha256);
  await file(initiativePath, JSON.stringify({ ...initiative, status: 'complete', currentPhase: null }));
  const stale = await cli(['--evidence=' + link, ...binding(exact)]);
  assert.equal(stale.diagnostics[0].code, 'ASK_EVIDENCE_STALE');
  assert.equal(stale.evidence, undefined);
  const live = await cli(['--resume']);
  assert.equal(live.work.workStatus, 'complete');
});

test('R3 Copilot-tool follow-ups use the independent model audience and stay inside the tool budget', async t => {
  const { env, root, commit, cli } = await fixture(t);
  for (let index = 0; index < 20; index++) commit('Retained message ' + 'context '.repeat(30));
  const names = ['SINGULARITY_FLOW_ASK_CONVERSATIONS', 'SINGULARITY_FLOW_REPOSITORY_CATALOG'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = env[name];
  t.after(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  const host = createHostGateway({ root, hostSessionId: 'ask-r3-test', planners: gatewayPlanners() });
  const ask = async (query, { sessionAction = 'query', ...args } = {}) => {
    const resolution = await host.kernel.resolve({ utterance: 'ask sflow', arguments: { query, sessionAction, ...args } });
    const answer = await host.kernel.read({ resolutionId: resolution.next[0]?.handle });
    const wire = boundedToolAnswer('sflow_read', answer);
    assert.equal(wire.operation.id, 'ask.lookup', JSON.stringify(wire));
    assert.ok(wire.data.conversation, JSON.stringify(wire.data));
    return wire.data;
  };
  const first = await ask(askDate);
  const context = { conversationId: first.conversation.id, contextRevision: first.conversation.revision };
  const selected = await ask('the second result', context);
  assert.equal(selected.evidence.revision, first.history.rows[1].commit);
  const reported = await ask('explain', { sessionAction: 'explain', conversationId: selected.conversation.id, contextRevision: selected.conversation.revision });
  assert.equal(reported.explanation.providerCalls, 0);
  assert.ok(reported.explanation.statements.every(item => first.links.includes(item.evidenceId)));
  assert.equal((await cli(['--resume', '--conversation=' + first.conversation.id])).status, 'unavailable');
});

test('R3 explicit explanation uses one tool-free Copilot provider invocation and falls back on unsafe output', { timeout: 45_000 }, async t => {
  const { root, base, file, cli, git, commit, env } = await fixture(t);
  await initializeDefinition(root);
  const definitionFile = 'singularity/workflow.yml';
  const doc = YAML.parse(await readFile(path.join(root, definitionFile), 'utf8'));
  const runner = path.join(base, 'copilot-standin.mjs');
  const calls = path.join(base, 'calls.jsonl');
  const unsafe = path.join(base, 'invalid-output');
  const slow = path.join(base, 'slow-provider');
  await writeFile(runner, [
    'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
    'const args = process.argv.slice(2); const material = args[args.indexOf("--attachment") + 1];',
    'const prompt = readFileSync(material, "utf8");',
    'const facts = JSON.parse(prompt.split("\\n").at(-1));',
    'appendFileSync(' + JSON.stringify(calls) + ', JSON.stringify({bytes: Buffer.byteLength(prompt), canary: prompt.includes("PRIVATE_PROMPT_CANARY"), count: facts.length, pid: process.pid}) + "\\n");',
    'const order = facts.map(fact => fact.id).reverse();',
    'const result = () => process.stdout.write(JSON.stringify(existsSync(' + JSON.stringify(unsafe) + ') ? { order, claim: "Invented approval" } : { order }));',
    'if (existsSync(' + JSON.stringify(slow) + ')) setTimeout(result, 30000); else result();'
  ].join('\n'));
  doc.models = { defaultProvider: 'ask-standin', providers: {
    'ask-standin': { type: 'copilot-cli', executable: process.execPath, arguments: [runner], promptTransport: 'attachment' }
  } };
  await file(definitionFile, YAML.stringify(doc));
  git('add', '.');
  commit('PRIVATE_PROMPT_CANARY');
  const question = await cli([askDate, '--remember']);
  await assert.rejects(access(calls));
  const noModel = await cli(['--explain', ...binding(question)]);
  assert.equal(noModel.explanation.providerCalls, 0);
  assert.deepEqual(noModel.history.rows, question.history.rows);
  await assert.rejects(access(calls));

  const explained = await cli(['--explain', ...binding(question)], { runModel: true });
  assert.equal(explained.explanation.status, 'copilot-assisted', JSON.stringify(explained));
  assert.equal(explained.explanation.providerCalls, 1);
  assert.equal(explained.answeredBy, 'model-assisted');
  assert.ok(explained.explanation.promptBytes < 4200);
  assert.equal(explained.explanation.statements[0].id, 'F2');
  assert.deepEqual(explained.history.rows, question.history.rows);
  const repeated = await cli(['--explain', ...binding(explained)], { runModel: true });
  assert.equal(repeated.explanation.providerCalls, 0);
  assert.equal(repeated.explanation.reason, 'already-attempted');

  await writeFile(unsafe, '');
  const second = await cli([askDate, '--remember']);
  const declined = await cli(['--explain', ...binding(second)], { runModel: true });
  assert.equal(declined.explanation.reason, 'invalid-explanation');
  assert.doesNotMatch(JSON.stringify(declined), /Invented approval/);
  const trace = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(trace.length, 2);
  assert.ok(trace.every(call => !call.canary && call.bytes < 4200));
  await writeFile(slow, '');
  const third = await cli([askDate, '--remember']);
  const providerEnvironment = { ...env };
  delete providerEnvironment.SINGULARITY_FLOW_NO_MODEL;
  const command = spawn(process.execPath, [bin, 'ask', '--explain', ...binding(third), '--for-person', '--json'], {
    cwd: root, env: providerEnvironment, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  command.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  command.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const ended = new Promise((resolve, reject) => { command.once('error', reject); command.once('close', resolve); });
  let running;
  for (let attempt = 0; attempt < 100; attempt++) {
    const recorded = (await readFile(calls, 'utf8')).trim().split('\n');
    if (recorded.length === 3) { running = JSON.parse(recorded[2]); break; }
    await wait(30);
  }
  if (!running) command.kill();
  assert.ok(running, 'the local provider started');
  command.kill('SIGTERM');
  assert.equal(await ended, 0, stderr);
  const cancelled = JSON.parse(stdout);
  assert.equal(cancelled.explanation.reason, 'cancelled');
  assert.equal(cancelled.explanation.providerAttempts, 1);
  assert.throws(() => process.kill(running.pid, 0), { code: 'ESRCH' });
  const audits = path.join(root, '.git', 'singularity-flow', 'model-invocations');
  const files = await readdir(audits);
  assert.equal(files.length, 3);
  const audit = JSON.parse(await readFile(path.join(audits, files[0]), 'utf8'));
  assert.equal(audit.toolPolicy.mode, 'none');
  assert.equal(audit.operationId, 'ask.explain');
});
