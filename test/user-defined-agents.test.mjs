import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  captureUserDefinedFolder, chooseMainAgent, renderUserDefinedFolder, userDefinedAgentChangeSet, userDefinedAgentFiles,
  userDefinedAgentPlan, userDefinedManifestText
} from '../src/user-defined-agents.mjs';
import { userDefinedAgentWorkType } from '../src/user-defined-agent-identity.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** A person's agent folder: a main agent, a skill, a note, and files that must never be copied. */
async function teamFolder(base) {
  const folder = path.join(base, 'team-agents');
  await mkdir(path.join(folder, 'skills', 'review'), { recursive: true });
  await mkdir(path.join(folder, 'notes'));
  await mkdir(path.join(folder, 'node_modules', 'x'), { recursive: true });
  await writeFile(path.join(folder, 'orchestrator.agent.md'), [
    '---', 'name: orchestrator', 'description: Plans a change, reviews it with the review skill, then implements it.',
    'tools: [Read, Edit]', 'model: some-model', '---', '# Orchestrator', '',
    '1. Plan the change in three bullets.', '2. Apply skills/review/SKILL.md to the plan.', '3. Implement it with its tests, following notes/style.md.', ''
  ].join('\n'));
  await writeFile(path.join(folder, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a plan for risks.\n---\nList each risk with a mitigation.\n');
  await writeFile(path.join(folder, 'notes', 'style.md'), '# Style\nUse small functions.\n');
  await writeFile(path.join(folder, '.env'), 'API_TOKEN=abc\n');
  await writeFile(path.join(folder, 'logo.png'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(folder, 'node_modules', 'x', 'i.js'), 'x');
  await writeFile(path.join(folder, 'leaked.md'), `key: ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}\n`);
  await symlink(path.join(folder, 'notes', 'style.md'), path.join(folder, 'linked.md'));
  return folder;
}

test('a folder is copied as exact text, and links, binaries, secrets and dependencies are left out with why', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-user-agent-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const folder = await teamFolder(base);
  const captured = await captureUserDefinedFolder(folder);
  assert.deepEqual(captured.files.map((file) => file.path), ['notes/style.md', 'orchestrator.agent.md', 'skills/review/SKILL.md']);
  assert.deepEqual(captured.leftOut.map((entry) => entry.path), ['.env', 'leaked.md', 'linked.md', 'logo.png', 'node_modules/']);
  assert.match(captured.leftOut.find((entry) => entry.path === 'leaked.md').reason, /looks like a secret/u);
  assert.match(captured.leftOut.find((entry) => entry.path === 'linked.md').reason, /links are never followed/u);

  const { plan } = await userDefinedAgentPlan(folder);
  assert.deepEqual([plan.name, plan.label, plan.main, plan.output, plan.step, plan.workflow], ['orchestrator', 'Orchestrator', 'orchestrator.agent.md', 'code', 'orchestrator', 'orchestrator']);
  assert.deepEqual(plan.notUsed, ['model', 'tools'], 'front matter SFlow does not use is reported, never silently dropped');
  assert.equal(plan.planSha256, (await userDefinedAgentPlan(folder)).plan.planSha256, 'the same folder plans the same digest');
  await writeFile(path.join(folder, 'notes', 'style.md'), '# Style\nUse tiny functions.\n');
  assert.notEqual((await userDefinedAgentPlan(folder)).plan.planSha256, plan.planSha256, 'any byte change changes the plan');
});

test('the main agent is the only agent file, the one --main names, and never a guess between several', async (t) => {
  const files = (paths) => paths.map((entry) => ({ path: entry, text: '# x' }));
  assert.equal(chooseMainAgent(files(['a.md', '.github/agents/lead.md'])).path, '.github/agents/lead.md');
  assert.equal(chooseMainAgent(files(['AGENTS.md', 'notes.md'])).path, 'AGENTS.md');
  assert.throws(() => chooseMainAgent(files(['a.agent.md', 'b.agent.md'])), (error) => error.code === 'USER_AGENT_MAIN_AMBIGUOUS' && /--main/u.test(error.message));
  assert.throws(() => chooseMainAgent(files(['notes.md'])), (error) => error.code === 'USER_AGENT_MAIN_REQUIRED');
  assert.equal(chooseMainAgent(files(['a.agent.md', 'b.agent.md']), './b.agent.md').path, 'b.agent.md');
  assert.throws(() => chooseMainAgent(files(['a.agent.md']), 'missing.md'), (error) => error.code === 'USER_AGENT_MAIN_UNKNOWN');
});

test('Workflow Studio writes only files that match their digests, inside the folder, with the main file as instructions', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-user-agent-change-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const planned = await userDefinedAgentPlan(await teamFolder(base));
  const [change, step, workflow] = userDefinedAgentChangeSet(planned, { approvalGroup: 'engineering-reviewers' }).changes;
  const written = userDefinedAgentFiles(change);
  assert.deepEqual(written.files.map((file) => file.path), ['singularity/user-defined/orchestrator/notes/style.md',
    'singularity/user-defined/orchestrator/orchestrator.agent.md', 'singularity/user-defined/orchestrator/skills/review/SKILL.md']);
  assert.equal(written.manifest.path, 'singularity/user-defined/orchestrator.json');
  assert.deepEqual([step.op, step.agent, step.output, workflow.op, workflow.phases], ['phase.create', 'orchestrator', 'code', 'workflow.create', ['orchestrator']]);
  assert.deepEqual(workflow.omits.map((entry) => [entry.responsibility, entry.authority]), [['scope', 'engineering-reviewers'], ['plan', 'engineering-reviewers']],
    'one code step defines no clauses and plans itself, so its approvers record why those do not apply');
  const refused = (edit, code) => assert.throws(() => userDefinedAgentFiles(edit(structuredClone(change))), (error) => error.code === code);
  refused((value) => { value.files[0].path = '../escape.md'; return value; }, 'USER_AGENT_PATH_INVALID');
  refused((value) => { value.files[0].base64 = Buffer.from('changed').toString('base64'); return value; }, 'USER_AGENT_FILE_MISMATCH');
  refused((value) => { value.manifest += ' '; return value; }, 'USER_AGENT_MANIFEST_MISMATCH');
  refused((value) => { value.instructions = 'Do something else.'; return value; }, 'USER_AGENT_MANIFEST_MISMATCH');
  refused((value) => { value.files.pop(); return value; }, 'USER_AGENT_MANIFEST_MISMATCH');
  const document = userDefinedAgentChangeSet(await userDefinedAgentPlan(path.join(base, 'team-agents'), { output: 'document' }), { approvalGroup: 'engineering-reviewers' });
  assert.equal(document.changes[2].omits, undefined, 'a document step owes no planned code, so it omits nothing');
});

test('the step prompt gives the agent its folder, verified, and refuses a folder changed since the agent was pinned', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-user-agent-render-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const planned = await userDefinedAgentPlan(await teamFolder(base));
  const config = path.join(base, 'config');
  for (const file of planned.captured.files) {
    await mkdir(path.dirname(path.join(config, 'singularity/user-defined/orchestrator', file.path)), { recursive: true });
    await writeFile(path.join(config, 'singularity/user-defined/orchestrator', file.path), file.bytes);
  }
  await writeFile(path.join(config, 'singularity/user-defined/orchestrator.json'), userDefinedManifestText(planned.plan));
  const agent = { id: 'orchestrator', label: 'Orchestrator', metadata: { 'sflow-user-defined': 'orchestrator', 'sflow-user-defined-manifest': planned.plan.manifestSha256 } };
  const text = await renderUserDefinedFolder(config, agent);
  assert.match(text, /^# The Orchestrator folder/u);
  assert.match(text, /The 2 other files of its folder follow, exact\..*never search for them there/su);
  assert.match(text, /### skills\/review\/SKILL\.md\n\n~~~~\n---\nname: review/u);
  assert.match(text, /`\.env` \(named like a secret/u, 'what was left out stays visible to the agent');
  assert.doesNotMatch(text, /### orchestrator\.agent\.md/u, 'the main file is already the agent\'s instructions');
  assert.equal(await renderUserDefinedFolder(config, { id: 'developer', metadata: {} }), null);

  await writeFile(path.join(config, 'singularity/user-defined/orchestrator/notes/style.md'), '# Style\nAnything goes.\n');
  await assert.rejects(renderUserDefinedFolder(config, agent), (error) => error.code === 'USER_AGENT_FOLDER_CHANGED' && /notes\/style\.md/u.test(error.message));
  await assert.rejects(renderUserDefinedFolder(config, { ...agent, metadata: { ...agent.metadata, 'sflow-user-defined-manifest': sha('other') } }),
    (error) => error.code === 'USER_AGENT_FOLDER_CHANGED');
});

test('the packaged sample agent is a consistent folder, and init seeds it ready to run', async (t) => {
  const templates = fileURLToPath(new URL('../templates/', import.meta.url));
  const folder = path.join(templates, 'user-defined', 'careful-change');
  // The shipped files are what call add makes from the sample folder: same manifest, same pin, same instructions.
  const { plan, instructions } = await userDefinedAgentPlan(folder, { label: 'Careful change', approvalGroup: 'engineering-reviewers' });
  assert.equal(await readFile(path.join(templates, 'user-defined', 'careful-change.json'), 'utf8'), userDefinedManifestText(plan));
  const agent = await readFile(path.join(templates, 'agents', 'careful-change.agent.md'), 'utf8');
  assert.match(agent, new RegExp(`sflow-user-defined: careful-change\\n {2}sflow-user-defined-manifest: "${plan.manifestSha256}"`, 'u'));
  assert.ok(agent.includes(`\n\n${instructions}\n\n`), 'the agent\'s instructions are the main file\'s own');
  assert.match(agent, /---\n\nResolve the active Story checkout from this invocation's verified entry packet/u, 'after the repository boundary every agent carries');
  const workflow = YAML.parse(await readFile(path.join(templates, 'workflow.yml'), 'utf8'));
  assert.deepEqual(workflow.workTypes['careful-change'].phases, ['careful-change']);
  assert.deepEqual(workflow.workTypes['careful-change'].omits.map((entry) => entry.responsibility), ['scope', 'plan']);

  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-user-agent-seed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  const { initializeDefinition, loadDefinition } = await import('../src/config.mjs');
  await initializeDefinition(root);
  const definition = await loadDefinition(root);
  assert.equal(userDefinedAgentWorkType(definition, 'careful-change'), 'careful-change', 'start --agent careful-change starts its workflow');
  const text = await renderUserDefinedFolder(root, definition.agents['careful-change']);
  assert.match(text, /^# The Careful change folder/u);
  assert.match(text, /### skills\/plan-change\/SKILL\.md[\s\S]*### skills\/self-review\/SKILL\.md[\s\S]*### skills\/write-tests\/SKILL\.md/u);
});

test('--agent names a user-defined agent\'s workflow only for that agent; any other agent keeps its meaning', () => {
  const definition = {
    agents: { orchestrator: { metadata: { 'sflow-user-defined': 'orchestrator' }, defaultFor: ['orchestrator'] }, developer: { metadata: {}, defaultFor: ['implementation'] } },
    workTypes: { orchestrator: { phases: ['orchestrator'] }, developer: { phases: ['implementation'] } }
  };
  assert.equal(userDefinedAgentWorkType(definition, 'orchestrator'), 'orchestrator');
  assert.equal(userDefinedAgentWorkType(definition, 'developer'), null);
  assert.equal(userDefinedAgentWorkType(definition, null), null);
  assert.equal(userDefinedAgentWorkType({ ...definition, workTypes: {} }, 'orchestrator'), null);
});

test('a real folder is proposed, activated, started with --agent and finished as one governed step', { timeout: 600_000 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-user-agent-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const folder = await teamFolder(base);
  const root = path.join(base, 'repo'); const remote = path.join(base, 'remote.git');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Call Tester',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Call Tester', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'call.tester@example.invalid' };
  delete env.NODE_TEST_CONTEXT;
  const run = (command, args, { cwd = root, allowFailure = false } = {}) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 300_000 });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const sflow = (...args) => run(process.execPath, [cli, '--no-model', ...args]).stdout;
  const json = (...args) => JSON.parse(sflow(...args, '--json'));
  const refused = (...args) => {
    const result = run(process.execPath, [cli, '--no-model', ...args, '--json'], { allowFailure: true });
    assert.notEqual(result.status, 0, `${args.join(' ')} should be refused`);
    return JSON.parse(result.stdout).error;
  };
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '-A']); run('git', ['commit', '-q', '-m', 'fixture']);
  run('git', ['init', '-q', '--bare', '-b', 'main', remote], { cwd: base });
  run('git', ['remote', 'add', 'origin', remote]); run('git', ['push', '-q', '-u', 'origin', 'main']);
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config']);

  const preview = json('call', 'add', folder);
  assert.deepEqual([preview.data.name, preview.data.problems, preview.data.files.length], ['orchestrator', [], 3]);
  assert.equal(preview.next[0].command, preview.data.confirmCommand);
  assert.equal(refused('call', 'add', folder, '--confirm', sha('stale')).code, 'USER_AGENT_PLAN_CHANGED');
  const proposed = json('call', 'add', folder, '--confirm', preview.data.planSha256);
  const branch = proposed.data.proposal.branch ?? proposed.data.proposal.proposal?.branch
    ?? run('git', ['--git-dir', remote, 'branch', '--list', 'sflow/config-change/*', '--format=%(refname:short)']).stdout.trim();
  assert.match(branch, /^sflow\/config-change\/workflow\/studio-orchestrator-/u);
  // The folder lands byte for byte; the agent's instructions are the main file's own.
  for (const file of ['notes/style.md', 'skills/review/SKILL.md', 'orchestrator.agent.md']) {
    assert.equal(run('git', ['--git-dir', remote, 'show', `${branch}:singularity/user-defined/orchestrator/${file}`]).stdout,
      await readFile(path.join(folder, file), 'utf8'), file);
  }
  const agentFile = run('git', ['--git-dir', remote, 'show', `${branch}:.github/agents/orchestrator.agent.md`]).stdout;
  assert.match(agentFile, /sflow-user-defined: orchestrator\n {2}sflow-user-defined-manifest: "sha256:[a-f0-9]{64}"/u);
  // The repository boundary every agent carries, then the main file's own instructions unchanged.
  assert.match(agentFile, /---\n\nResolve the active Story checkout[^\n]*\n\n# Orchestrator\n\n1\. Plan the change in three bullets\./u);
  assert.equal(run('git', ['--git-dir', remote, 'cat-file', '-e', `${branch}:singularity/user-defined/orchestrator/.env`], { allowFailure: true }).status === 0, false);
  sflow('workflow', 'activate', branch, '--confirm', run('git', ['--git-dir', remote, 'rev-parse', branch]).stdout.trim(), '--acknowledge-unprotected');

  // The packaged sample (careful-change) is listed beside it.
  const listed = json('call', 'list').data.agents.find((agent) => agent.name === 'orchestrator');
  assert.deepEqual(json('call', 'list').data.agents.map((agent) => agent.name).sort(), ['careful-change', 'orchestrator']);
  assert.deepEqual([listed.name, listed.workflow, listed.step, listed.main, listed.files, listed.manifest], ['orchestrator', 'orchestrator', 'orchestrator', 'orchestrator.agent.md', 3, 'matches']);
  assert.equal(json('call', 'show', 'orchestrator').next[0].command, 'singularity-flow start <WORK-ID> --agent orchestrator');

  sflow('start', 'CALL-1', '--agent', 'orchestrator', '--from-branch', 'main', '--title', 'Add a greeting',
    '--description', 'Add a greet() function with a test.', '--readiness-baseline', 'defer');
  const story = JSON.parse(await readFile(path.join(root, 'singularity/work-items/CALL-1/workflow.json'), 'utf8'));
  assert.deepEqual([story.workItem.workType, story.currentPhase, story.phases.orchestrator.defaultAgent], ['orchestrator', 'orchestrator', 'orchestrator']);
  const prompt = sflow('wm', 'compose', '--phase', 'orchestrator', '--render-only');
  assert.match(prompt, /# Orchestrator\n\n1\. Plan the change in three bullets\./u);
  assert.match(prompt, /# The Orchestrator folder[\s\S]*### notes\/style\.md[\s\S]*### skills\/review\/SKILL\.md/u);

  sflow('prepare', 'orchestrator');
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'src/greet.mjs'), '/** Greets a person by name. */\nexport function greet(name) { return `Hello, ${name}!`; }\n');
  await writeFile(path.join(root, 'test/greet.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greet.mjs';\ntest('greets by name', () => assert.equal(greet('Ada'), 'Hello, Ada!'));\n");
  await writeFile(path.join(root, 'singularity/work-items/CALL-1/artifacts/orchestrator/orchestrator.md'),
    '# Orchestrator\n\n## Plan\n- Add greet(name) to src/greet.mjs.\n- Add one test in test/greet.test.mjs.\n\n## Review\n- Risk: none beyond the new file; one focused test covers it.\n\n## Changes\nsrc/greet.mjs adds greet(); test/greet.test.mjs checks it. The test passes locally.\n');
  sflow('phase', 'publish', 'orchestrator');
  assert.match(refused('submit', 'orchestrator').message, /scope|plan/u, 'the omitted responsibilities wait for a person to record why');
  sflow('decision', 'applicability', '--responsibility', 'scope', '--reason', 'One small greet function was asked for; no requirement clauses were needed.');
  sflow('decision', 'applicability', '--responsibility', 'plan', '--reason', 'The orchestrator planned the change itself in its one step, recorded in its deliverable.');
  sflow('submit', 'orchestrator');
  assert.match(sflow('approve', 'orchestrator', '--yes'), /Final Flow Gate passed/u);

  // A copied file edited by hand on sflow/config, not through call add: listed as changed, and a
  // Story started on it is refused rather than given different instructions.
  const edited = path.join(base, 'edited');
  run('git', ['clone', '-q', '-b', 'sflow/config', remote, edited], { cwd: base });
  await writeFile(path.join(edited, 'singularity/user-defined/orchestrator/notes/style.md'), '# Style\nAnything goes.\n');
  run('git', ['commit', '-qam', 'edit the copied note by hand'], { cwd: edited }); run('git', ['push', '-q', 'origin', 'sflow/config'], { cwd: edited });
  run('git', ['checkout', '-q', 'main']);
  assert.equal(json('call', 'list').data.agents.find((agent) => agent.name === 'orchestrator').manifest, 'changed');
  sflow('start', 'CALL-2', '--agent', 'orchestrator', '--from-branch', 'main', '--title', 'After a hand edit',
    '--description', 'Started after the folder was edited by hand.', '--readiness-baseline', 'defer');
  const changed = run(process.execPath, [cli, '--no-model', 'wm', 'compose', '--phase', 'orchestrator', '--render-only'], { allowFailure: true });
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /no longer matches its manifest \(notes\/style\.md changed\).*add the folder again with call add/su);
});
