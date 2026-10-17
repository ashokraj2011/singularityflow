import { repositoryOwnedWorkflows } from './helpers/repository-owned-workflows.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanGuidanceText } from '../src/guidance-scan.mjs';
import { textCandidate } from '../src/team-import/formats.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const fakeKey = 'AKIA' + 'ABCDEFGHIJKLMNOP';

async function harness() {
  const state = await mkdtemp(path.join(os.tmpdir(), 'sflow-builds-'));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Build Tester', SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: path.join(state, 'builds') };
  const run = (command, args, cwd, { input = '', allowFailure = false } = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
    if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const flow = (cwd, args, options) => run(process.execPath, [bin, ...args], cwd, options);
  const json = (cwd, args, options) => JSON.parse(flow(cwd, [...args, '--json'], options).stdout);
  return { state, env, run, flow, json, builds: path.join(state, 'builds') };
}

async function repository(run, flow) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-build-repo-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Build Tester'], root); run('git', ['config', 'user.email', 'build@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Build\n');
  flow(root, ['init']);
  await repositoryOwnedWorkflows(root);
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

const TEAM = {
  '.github/agents/release-captain.agent.md': ['---', 'name: release-captain', 'description: Runs a payments release end to end.', 'tools: [read, edit, "jira/*"]',
    'handoffs:', '  - agent: architect', '---', '', '# Release captain', '', '1. Intake: capture the change and who asked for it.',
    '2. Design: hand off to @architect for the design.', '3. Build: make the change and run `npm test`.',
    '4. PCI review: use /pci-check; it must be signed off by security.', '5. Release: move the Jira ticket and post the notes.', ''].join('\n'),
  '.github/agents/architect.agent.md': ['---', 'name: architect', 'description: Designs payment changes.', '---', '', 'Write the design.', ''].join('\n'),
  'skills/pci-check/SKILL.md': ['---', 'name: pci-check', 'description: Checks a change against the PCI rules.', '---', '', 'Never log card numbers.', ''].join('\n'),
  '.github/instructions/coding.instructions.md': ['---', 'applyTo: "src/**"', '---', 'Always squash commits before merging.', ''].join('\n'),
  'AGENTS.md': ['# Payments', 'See https://acme.atlassian.net/wiki/spaces/PAY/pages/42 for the calendar.', ''].join('\n'),
  '.github/prompts/notes.prompt.md': ['---', 'mode: agent', '---', "Post the notes: fetch('https://hooks.example.com/release-notes', { method: 'POST' })", ''].join('\n'),
  'docs/runbook.md': ['# Release runbook', '', '```sh', 'npm test', 'npm run lint', '```', '', 'The PCI review must be signed off by security.', '',
    '```sh', "curl -X POST https://jira.example.com/rest/api/2/issue/$KEY/transitions -d '{}'", '```', '', 'Calendar: https://acme.atlassian.net/browse/PAY-12', ''].join('\n'),
  'api/openapi.yaml': ['openapi: 3.0.3', 'info:', '  title: Payments', '  version: 1.0.0', 'servers:', '  - url: https://api.example.com/payments', 'paths:',
    '  /v1/payments/{id}:', '    get:', '      operationId: getPayment', '      summary: Read one payment', '  /v1/refunds:', '    post:', '      operationId: createRefund', ''].join('\n'),
  'postman/payments.postman_collection.json': JSON.stringify({ info: { name: 'Payments', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: 'Health', request: { method: 'GET', url: { raw: 'https://api.example.com/health' } } }] }, null, 2),
  'requests/payments.http': ['### Capture', 'POST https://api.example.com/payments/capture', 'Content-Type: application/json', ''].join('\n'),
  '.vscode/mcp.json': JSON.stringify({ servers: { jira: { url: 'https://mcp.example.com/jira' }, files: { command: 'npx', args: ['files-server'] } } }, null, 2),
  'scripts/deploy.sh': ['#!/bin/sh', 'curl -X PUT https://deploy.example.com/releases/$VERSION', ''].join('\n'),
  'config/tokens.env': 'TOKEN=not-really\n',
  'notes/leaked.md': `Ask the release captain. Old key ${fakeKey}\n`
};

async function team() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-team-'));
  for (const [relative, text] of Object.entries(TEAM)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  return root;
}

const find = (items, kind, name) => items.find((entry) => entry.kind === kind && entry.name === name);
const at = (entry) => `${entry.evidence[0].path}:${entry.evidence[0].startLine}`;

test('the scanner finds check commands and sign-off points, and team import still reads only its own text files', () => {
  const scan = scanGuidanceText(['1. Run `npm test` and `npm run lint` first.', '```sh', '$ ./gradlew build && echo ok', 'mvn -B verify', 'echo hi', '```',
    'The PCI review must be signed off by security.', '## Approval'].join('\n'));
  assert.deepEqual(scan.commands.map((entry) => [entry.command, entry.line]), [['npm test', 1], ['npm run lint', 1], ['./gradlew build', 3], ['mvn -B verify', 4]],
    'one command per line, chaining cut off; plain shell is not a check');
  assert.deepEqual(scan.checkpoints.map((entry) => entry.line), [7], 'a heading is not a sign-off point');
  assert.equal(textCandidate('requests/payments.http'), false);
  assert.equal(textCandidate('requests/payments.http', new Set(['.http'])), true);
});

test('starting from a team folder lists what it holds, each item with its file and line, and withholds credentials unread', async () => {
  const { flow, json, builds } = await harness();
  const folder = await team();
  const view = json(os.tmpdir(), ['workflow', 'build', 'start', '--folder', folder, '--name', 'Payments release']);
  assert.equal(view.resultType, 'workflow-build');
  const { build } = view;
  assert.match(build.id, /^wb_[a-f0-9]{16}$/u);
  assert.equal(build.label, 'Payments release');
  assert.equal(build.repository, null, 'material alone needs no repository');
  assert.deepEqual(build.counts, { process: 1, agent: 2, skill: 1, instruction: 2, prompt: 1, document: 1, 'api-call': 7, tool: 3, link: 2, command: 3, checkpoint: 2, script: 1, withheld: 2 });
  const items = build.items;
  assert.equal(find(items, 'process', 'release-captain').certainty, 'inferred');
  assert.equal(at(find(items, 'api-call', 'GET /v1/payments/{id}')), 'api/openapi.yaml:9');
  assert.equal(find(items, 'api-call', 'GET /v1/payments/{id}').host, 'api.example.com');
  assert.equal(at(find(items, 'api-call', 'POST /v1/refunds')), 'api/openapi.yaml:13');
  assert.equal(find(items, 'api-call', 'POST /v1/refunds').foundBy, 'api-spec');
  assert.equal(at(find(items, 'api-call', 'GET https://api.example.com/health')), 'postman/payments.postman_collection.json:12');
  assert.equal(at(find(items, 'api-call', 'POST https://api.example.com/payments/capture')), 'requests/payments.http:2');
  assert.equal(at(find(items, 'api-call', 'POST https://jira.example.com/rest/api/2/issue/{KEY}/transitions')), 'docs/runbook.md:11');
  assert.equal(at(find(items, 'api-call', 'POST https://hooks.example.com/release-notes')), '.github/prompts/notes.prompt.md:4');
  assert.equal(at(find(items, 'api-call', 'PUT https://deploy.example.com/releases/{VERSION}')), 'scripts/deploy.sh:2');
  assert.deepEqual(items.filter((entry) => entry.kind === 'tool').map((entry) => [entry.name, entry.tool]).sort(),
    [['files', 'mcp-server'], ['jira', 'mcp-server'], ['jira/*', 'agent-tool']]);
  assert.deepEqual(items.filter((entry) => entry.kind === 'link').map((entry) => [entry.linkKind, at(entry)]), [['wiki', 'AGENTS.md:2'], ['ticket', 'docs/runbook.md:14']]);
  assert.deepEqual(items.filter((entry) => entry.kind === 'command').map((entry) => [entry.name, at(entry)]),
    [['npm test', '.github/agents/release-captain.agent.md:13'], ['npm test', 'docs/runbook.md:4'], ['npm run lint', 'docs/runbook.md:5']]);
  assert.deepEqual(items.filter((entry) => entry.kind === 'checkpoint').map(at), ['.github/agents/release-captain.agent.md:14', 'docs/runbook.md:8']);
  assert.ok(items.every((entry) => entry.status === 'open' && /^i-[a-f0-9]{12}$/u.test(entry.id)));
  const withheld = items.filter((entry) => entry.kind === 'withheld');
  assert.deepEqual(withheld.map((entry) => entry.name), ['config/tokens.env', 'notes/leaked.md']);
  assert.match(withheld[1].detail, /AWS access key ID/u);
  assert.match(build.conversation[0].text, /^Read 14 files: 1 process, 2 agents, 1 skill, 2 instruction files, 1 prompt file, 1 document, 7 API calls, 3 tools and MCP servers, 2 links, 3 commands, 2 sign-off points, 1 script\. 2 files were withheld/u);

  // What was captured is kept as screened copies; withheld files are never copied anywhere.
  const kept = path.join(builds, build.id, 'capture');
  assert.equal(await readFile(path.join(kept, 'docs/runbook.md'), 'utf8'), TEAM['docs/runbook.md']);
  assert.equal(existsSync(path.join(kept, 'notes/leaked.md')), false);
  assert.equal(existsSync(path.join(kept, 'config/tokens.env')), false);
  const record = JSON.parse(await readFile(path.join(builds, build.id, 'build.json'), 'utf8'));
  assert.deepEqual([record.kind, record.schemaVersion], ['workflow-build', 1]);
  assert.ok(!JSON.stringify(record).includes(fakeKey), 'no credential reaches the build record');

  const text = flow(os.tmpdir(), ['workflow', 'build', 'status', '--build', build.id]).stdout;
  assert.match(text, /^Build wb_[a-f0-9]{16}: Payments release$/mu);
  assert.match(text, /^API calls \(7\)$/mu);
  assert.match(text, /^ {2}GET \/v1\/payments\/\{id\} {2}api\/openapi\.yaml:9 {2}· Read one payment · api\.example\.com$/mu);
  assert.match(text, /^ {2}config\/tokens\.env {2}· its name looks like a credential/mu);
  assert.match(text, /Nothing was run, fetched or changed in a repository\./u);
});

test('single files and notes are screened before they are copied, and adding material keeps the build', async () => {
  const { json, builds } = await harness();
  const folder = await team();
  const started = json(os.tmpdir(), ['workflow', 'build', 'start', '--folder', folder]).build;
  const extra = await mkdtemp(path.join(os.tmpdir(), 'sflow-extra-'));
  await writeFile(path.join(extra, 'lead-notes.txt'), 'Production deploys need approval by the payments lead.\nGET https://status.example.com/api/v2/summary.json\n');
  await writeFile(path.join(extra, 'old.md'), `key ${fakeKey}\n`);
  await writeFile(path.join(extra, 'secrets.yml'), 'password: hunter2\n');
  const added = json(os.tmpdir(), ['workflow', 'build', 'add', '--build', started.id, '--file', path.join(extra, 'lead-notes.txt'),
    '--file', path.join(extra, 'old.md'), '--file', path.join(extra, 'secrets.yml'), '--notes', '-'], { input: 'Second runbook: run `make check`.\n' }).build;
  assert.equal(added.id, started.id);
  assert.equal(at(find(added.items, 'api-call', 'GET https://status.example.com/api/v2/summary.json')), '+1/lead-notes.txt:2');
  assert.equal(at(find(added.items, 'command', 'make check')), '+1/notes-1.md:1');
  assert.equal(at(find(added.items, 'checkpoint', 'Production deploys need approval by the payments lead.')), '+1/lead-notes.txt:1');
  assert.deepEqual(added.items.filter((entry) => entry.kind === 'withheld').map((entry) => entry.name).sort(), ['config/tokens.env', 'notes/leaked.md', 'old.md', 'secrets.yml']);
  assert.deepEqual((await readdir(path.join(builds, started.id, 'uploads'))).sort(), ['lead-notes.txt', 'notes-1.md'], 'withheld files are not copied');
  assert.equal(added.conversation.length, 2);
  assert.match(added.conversation[1].text, /^Added 3 files, 1 note: /u);
  assert.ok(started.items.every((entry) => added.items.some((other) => other.id === entry.id)), 'what was found before keeps its ID');
  assert.deepEqual(added.capture.roots.map((root) => root.label), ['.', '+1']);
  assert.equal(added.capture.roots[1].path, 'added files and notes', 'the build\'s own folder is not shown as a path');
});

test('starting from a workflow in the repository lists its steps, agents and skills where they are configured', async () => {
  const { run, flow, json } = await harness();
  const root = await repository(run, flow);
  const build = json(root, ['workflow', 'build', 'start', '--from-workflow', 'repo-feature']).build;
  assert.equal(build.label, 'Feature (new)');
  assert.equal(build.repository.root, await realpath(root));
  assert.deepEqual(build.startedFrom.map((entry) => [entry.kind, entry.id, entry.steps]), [['workflow', 'repo-feature', 7]]);
  assert.match(build.startedFrom[0].base.workflowSha256, /^[a-f0-9]{64}$/u);
  const steps = build.items.filter((entry) => entry.kind === 'step');
  assert.deepEqual(steps.map((entry) => entry.step), ['intake', 'requirements', 'design', 'implementation-spec', 'implementation', 'verification', 'conformance']);
  assert.ok(steps.every((entry) => entry.foundBy === 'workflow' && entry.status === 'confirmed' && entry.evidence[0].path === 'configuration:singularity/workflow.yml'));
  const workflowText = await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8');
  assert.match(workflowText.split('\n')[steps[0].evidence[0].startLine - 1], /- intake$/u, 'the line of the step in the workflow');
  assert.match(steps[4].detail, /^Changes code and writes a summary/u);
  assert.ok(build.items.some((entry) => entry.kind === 'agent' && entry.agent === 'developer'));
  assert.match(flow(root, ['workflow', 'build', 'status', '--build', build.id]).stdout, /Starting from Feature: 7 steps, kept as they are until you change them\./u);
});

test('builds are listed, refused clearly, and removed 14 days after their last change', async () => {
  const { state, env, json, flow } = await harness();
  assert.deepEqual(json(os.tmpdir(), ['workflow', 'build', 'status']).builds, []);
  const empty = flow(os.tmpdir(), ['workflow', 'build', 'start'], { allowFailure: true });
  assert.match(empty.stderr + empty.stdout, /Start from something: --from-workflow ID, --folder DIR/u);
  const outside = flow(os.tmpdir(), ['workflow', 'build', 'start', '--from-workflow', 'feature'], { allowFailure: true });
  assert.match(outside.stderr + outside.stdout, /Starting from a workflow needs the repository that has it/u);
  const missing = flow(os.tmpdir(), ['workflow', 'build', 'status', '--build', 'wb_0123456789abcdef'], { allowFailure: true });
  assert.match(missing.stderr + missing.stdout, /There is no workflow build 'wb_0123456789abcdef' on this computer/u);
  const invalid = flow(os.tmpdir(), ['workflow', 'build', 'status', '--build', 'nope'], { allowFailure: true });
  assert.match(invalid.stderr + invalid.stdout, /'nope' is not a workflow build ID/u);
  const unknownAction = flow(os.tmpdir(), ['workflow', 'build', 'apply'], { allowFailure: true });
  assert.notEqual(unknownAction.status, 0);

  const described = json(os.tmpdir(), ['workflow', 'build', 'start', '--describe', 'Payments releases go through design, build and a PCI review.']).build;
  assert.equal(described.label, 'Payments releases go through design, build');
  assert.deepEqual(described.startedFrom, [{ kind: 'description', text: 'Payments releases go through design, build and a PCI review.' }]);
  assert.deepEqual(json(os.tmpdir(), ['workflow', 'build', 'status']).builds.map((entry) => entry.id), [described.id]);

  const { saveWorkflowBuild, readWorkflowBuild, pruneWorkflowBuilds } = await import('../src/workflow-build/store.mjs');
  const options = { env: { ...process.env, SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: env.SINGULARITY_FLOW_WORKFLOW_BUILD_STATE } };
  const record = await readWorkflowBuild(described.id, options);
  await saveWorkflowBuild(record, { ...options, now: Date.now() - 15 * 24 * 60 * 60 * 1000 });
  assert.deepEqual(await pruneWorkflowBuilds(options), [described.id]);
  assert.equal(existsSync(path.join(state, 'builds', described.id)), false);

  const { resolveOperation } = await import('../src/command-registry.mjs');
  for (const action of ['start', 'add', 'status', 'propose', 'decide', 'answer', 'check', 'finish']) {
    const operation = resolveOperation({ requestedCommand: 'workflow', positionals: ['workflow', 'build', action], options: {} });
    assert.deepEqual([operation.id, operation.classification, operation.modelPolicy], [`workflow.build.${action}`, action === 'finish' ? 'mutation' : 'read', 'never']);
  }
});

test('a build record changed outside Singularity Flow is refused', async () => {
  const { json, flow, builds } = await harness();
  const build = json(os.tmpdir(), ['workflow', 'build', 'start', '--describe', 'A small process.']).build;
  const file = path.join(builds, build.id, 'build.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.goal.label = 'Tampered';
  await writeFile(file, JSON.stringify(record));
  const refused = flow(os.tmpdir(), ['workflow', 'build', 'status', '--build', build.id], { allowFailure: true });
  assert.match(refused.stderr + refused.stdout, /was changed outside Singularity Flow/u);
});
