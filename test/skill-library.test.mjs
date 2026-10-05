/**
 * The skill master: named skills a repository keeps once and attaches to any number of agents.
 *
 * A skill is a SKILL.md in `singularity/skill-library/<id>/`. An agent's `## Attached skills`
 * table says which skills it uses, in which steps, and when; each attached skill's instructions are
 * added to the agent's prompt in those steps. A Story keeps the skill text it started with.
 * Workflow Studio and the command line edit the skill master as reviewed configuration changes, and
 * a workflow bundle carries the skills its agents attach.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { parseAgentDependencies, renderAgentSkills } from '../src/agents.mjs';
import {
  defaultSkillLabel, librarySkillText, loadSkillLibrary, normalizeSkillUse, parseLibrarySkill, withoutAttachedSkills
} from '../src/skill-library.mjs';
import { readStagedImport, stageImport } from '../src/asset-import.mjs';
import { buildStudioModel, planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA } from '../src/workflow-studio.mjs';
import { operationCatalog, resolveOperation } from '../src/command-registry.mjs';
import { captureWorkflowSnapshot } from '../src/workflow-snapshots.mjs';
import { resolveStoryExecutionContext } from '../src/story-execution-context.mjs';
import { applyWorkflowImport, exportWorkflowBundle, planWorkflowImport } from '../src/workflow-transfer.mjs';
import { addReleaseWorkflow, LIBRARY_SKILL_PATH, librarySkillText as releaseSkill } from './helpers/release-workflow-fixture.mjs';

process.env.NODE_ENV = 'test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const SKILL_PATH = 'singularity/skill-library/security-review/SKILL.md';
const SECURITY_REVIEW = {
  id: 'security-review', label: 'Security pass',
  description: 'Checks a change for common security mistakes. Use it before code is published.',
  instructions: '1. List every input the change accepts.\n2. Check each one for validation and encoding.\n3. Report findings as a checklist.'
};
const TABLE = `
## Attached skills

| Skill | Phases | When to use it |
|---|---|---|
| security-review | implementation | After you write the code, before you publish it |
`;
const changeSet = (changes) => ({ schema: STUDIO_CHANGE_SET_SCHEMA, changes });

async function temporary(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function repository(t, prefix = 'sflow-skill-master-') {
  const root = await temporary(t, prefix);
  await initializeDefinition(root);
  return root;
}

async function writeSkill(root, skill = SECURITY_REVIEW) {
  await mkdir(path.join(root, path.dirname(SKILL_PATH)), { recursive: true });
  await writeFile(path.join(root, SKILL_PATH), librarySkillText(skill));
}

async function attach(root, agent = 'developer', table = TABLE) {
  const file = path.join(root, `.github/agents/${agent}.agent.md`);
  await writeFile(file, `${await readFile(file, 'utf8')}${table}`);
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}

test('a skill is a SKILL.md that names itself, says what it does and when, and has instructions', () => {
  const text = librarySkillText(SECURITY_REVIEW);
  const skill = parseLibrarySkill(text, { id: 'security-review' });
  assert.equal(skill.id, 'security-review');
  assert.equal(skill.label, 'Security pass');
  assert.equal(skill.description, SECURITY_REVIEW.description);
  assert.equal(skill.instructions, SECURITY_REVIEW.instructions);
  assert.equal(skill.path, SKILL_PATH);
  assert.equal(skill.sha256, sha256(text));
  assert.deepEqual(YAML.parse(text.split('---')[1]), {
    name: 'security-review', description: SECURITY_REVIEW.description, metadata: { 'sflow-label': 'Security pass' }
  });
  // The label is only written when it is not the one the ID gives.
  assert.equal(defaultSkillLabel('security-review'), 'Security review');
  assert.doesNotMatch(librarySkillText({ ...SECURITY_REVIEW, label: 'Security review' }), /sflow-label/);

  const refused = [
    ['another folder', () => parseLibrarySkill(text, { id: 'style-guide' }), /names skill 'security-review' but sits in the folder of 'style-guide'/],
    ['no front matter', () => parseLibrarySkill('Just instructions.\n', { id: 'security-review' }), /needs front matter/],
    ['no description', () => parseLibrarySkill('---\nname: security-review\n---\nDo it.\n', { id: 'security-review' }), /needs a description/],
    ['no instructions', () => parseLibrarySkill(`---\nname: security-review\ndescription: Checks.\n---\n\n`, { id: 'security-review' }), /has no instructions/],
    ['not kebab-case', () => parseLibrarySkill('---\nname: Security_Review\ndescription: Checks.\n---\nDo it.\n'), /lower-case kebab-case/],
    ['a NUL byte', () => parseLibrarySkill(`${text}\u0000`, { id: 'security-review' }), /NUL byte/],
    ['a long description', () => librarySkillText({ ...SECURITY_REVIEW, description: 'x'.repeat(1025) }), /longer than 1024 characters/]
  ];
  for (const [label, read, message] of refused) {
    assert.throws(read, (error) => error.code === 'SKILL_LIBRARY_INVALID' && message.test(error.message), label);
  }
  assert.throws(() => parseLibrarySkill(`${text}${'x'.repeat(256 * 1024)}`, { id: 'security-review' }),
    (error) => error.code === 'SKILL_LIBRARY_LIMIT');

  assert.equal(normalizeSkillUse('  After   you write\nthe code '), 'After you write the code');
  assert.equal(normalizeSkillUse('-'), '');
  assert.throws(() => normalizeSkillUse('Before | after'), /cannot contain "\|"/);
  assert.throws(() => normalizeSkillUse('x'.repeat(301)), /at most 300 characters/);
});

test('an agent attaches skills in its own table, which leaves a prose Skills heading alone', () => {
  const agent = `---
name: developer
description: Implements accepted Stories.
---
# Developer

## Skills

Good at small, reviewable changes.
${TABLE.replace('| security-review | implementation |', '| security-review | implementation, verification |')}| style-guide | * | - |
`;
  const parsed = parseAgentDependencies(agent, { source: 'developer.agent.md' });
  assert.deepEqual(parsed.librarySkills, [
    { id: 'security-review', phases: ['implementation', 'verification'], use: 'After you write the code, before you publish it' },
    { id: 'style-guide', phases: [], use: '' }
  ]);
  assert.deepEqual(parsed.dependencies, [], 'a skill from the skill master is never a remote resource');
  const instructions = withoutAttachedSkills(agent);
  assert.match(instructions, /## Skills\n\nGood at small, reviewable changes\./);
  assert.doesNotMatch(instructions, /Attached skills|security-review/);

  const refused = [
    ['twice', `${agent}| security-review | - | - |\n`, /attached more than once/],
    ['a bad ID', agent.replace('| style-guide |', '| Style_Guide |'), /must be a lower-case kebab-case skill ID/],
    ['a remote resource of the same ID', `${agent}
## Remote skills

| ID | URL | Phases | Optional | Max bytes |
|---|---|---|---|---|
| style-guide | https://example.com/style.md | implementation | false | 4096 |
`, /is attached to developer\.agent\.md and is also the ID of one of its remote resources/]
  ];
  for (const [label, text, message] of refused) {
    assert.throws(() => parseAgentDependencies(text, { source: 'developer.agent.md' }), message, label);
  }
});

test('configuration refuses an agent that attaches a skill the skill master lacks, or names a step that does not exist', async (t) => {
  const root = await repository(t);
  await writeSkill(root);
  await attach(root);
  const definition = await loadDefinition(root);
  assert.deepEqual(definition.agents.developer.librarySkills,
    [{ id: 'security-review', phases: ['implementation'], use: 'After you write the code, before you publish it' }]);

  await rm(path.join(root, 'singularity/skill-library'), { recursive: true });
  await assert.rejects(() => loadDefinition(root), (error) => error.code === 'SKILL_LIBRARY_MISSING'
    && error.details?.agentId === 'developer' && error.details?.skillId === 'security-review'
    && /not in the skill master \(singularity\/skill-library\/security-review\/SKILL\.md\)/.test(error.message));

  await writeSkill(root);
  const file = path.join(root, '.github/agents/developer.agent.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace('| security-review | implementation |', '| security-review | nowhere |'));
  await assert.rejects(() => loadDefinition(root), (error) => error.code === 'AGENT_PHASE_UNKNOWN'
    && /attaches skill 'security-review' for unknown phase 'nowhere'/.test(error.message));

  // The library says which folders are not usable skills, without failing on them.
  await mkdir(path.join(root, 'singularity/skill-library/empty-folder'), { recursive: true });
  await mkdir(path.join(root, 'singularity/skill-library/broken'), { recursive: true });
  await writeFile(path.join(root, 'singularity/skill-library/broken/SKILL.md'), '---\nname: other\ndescription: x\n---\nDo it.\n');
  const library = await loadSkillLibrary(root);
  assert.deepEqual([...library.skills.keys()], ['security-review']);
  assert.deepEqual(library.problems.map((problem) => problem.id), ['broken', 'empty-folder']);
  assert.match(library.problems[1].message, /has no SKILL\.md/);
});

test('an attached skill is in the agent\'s prompt for the steps it applies in, and the audit keeps its exact text', async (t) => {
  const root = await repository(t);
  await writeSkill(root);
  await attach(root);
  const itemDirectory = path.join(root, 'singularity/work-items/SEC-1');
  await mkdir(itemDirectory, { recursive: true });
  const workflow = { workItem: { id: 'SEC-1', workType: 'feature' } };
  const rendered = await renderAgentSkills(root, workflow, { id: 'implementation', generation: 0 }, { agent: 'developer' }, { record: true, itemDirectory });
  assert.match(rendered.text, /^## Attached skill instructions\n\nThese skills from the skill master are attached to developer\. Read each one before you start this step\./);
  assert.match(rendered.text, /### Skill: Security pass \(`security-review`\)\n\nChecks a change for common security mistakes\. Use it before code is published\.\n\nWhen to use it: After you write the code, before you publish it\n\n1\. List every input/);
  assert.deepEqual(rendered.skills.map((skill) => skill.id), ['security-review']);
  assert.deepEqual(rendered.warnings, []);

  const audit = JSON.parse(await readFile(path.join(itemDirectory, 'context/agents-implementation-gen1.json'), 'utf8'));
  const [file] = audit.files;
  const text = await readFile(path.join(root, SKILL_PATH), 'utf8');
  assert.deepEqual({ id: file.id, type: file.type, url: file.url, sha256: file.sha256, size: file.size },
    { id: 'security-review', type: 'skill', url: 'library:security-review', sha256: sha256(text), size: Buffer.byteLength(text) });
  assert.equal(await readFile(path.join(root, file.path), 'utf8'), text, 'the audit copy is the text the prompt used');

  const elsewhere = await renderAgentSkills(root, workflow, { id: 'verification' }, { agent: 'developer' });
  assert.equal(elsewhere.text, '');
  assert.deepEqual(elsewhere.skills, []);
  const qa = await renderAgentSkills(root, workflow, { id: 'implementation' }, { agent: 'qa' });
  assert.equal(qa.skills.length, 0, 'only the agents that attach a skill use it');
});

/** A Story's saved configuration, as `start` records it, with one agent that attaches a skill. */
async function storyFixture(t) {
  const root = await temporary(t, 'sflow-skill-story-');
  const templatePath = 'singularity/templates/implementation.md';
  const agentPath = '.github/agents/developer.agent.md';
  const template = '# Implementation\n\nWork: {{work.id}}\n';
  const agent = `---
name: developer
description: Implement an accepted Story.
metadata:
  sflow-phases: implementation
  sflow-default-for: implementation
---
# Developer

Implement only the accepted Story.
${TABLE}`;
  await mkdir(path.join(root, path.dirname(templatePath)), { recursive: true });
  await mkdir(path.join(root, path.dirname(agentPath)), { recursive: true });
  await writeFile(path.join(root, templatePath), template);
  await writeFile(path.join(root, agentPath), agent);
  await writeSkill(root);
  const parsed = parseAgentDependencies(agent, { source: agentPath });
  const config = {
    workItemRoot: 'singularity/work-items',
    templatesRoot: 'singularity/templates',
    agentCatalog: [{
      id: 'developer', file: path.join(root, agentPath), source: agentPath, scope: 'repository',
      sha256: sha256(agent), dependencies: parsed.dependencies, librarySkills: parsed.librarySkills
    }]
  };
  const workflow = {
    schemaVersion: 5,
    workItem: { id: 'SEC-1', title: 'Pinned skills', workType: 'feature', createdAt: '2026-10-05T00:00:00.000Z' },
    resolution: {
      configurationSource: { repository: 'https://example.invalid/config.git', commit: 'a'.repeat(40), filesSha256: 'b'.repeat(64) },
      phases: [{ id: 'implementation', template: 'implementation.md', defaultAgent: 'developer' }],
      templates: { implementation: { path: templatePath, sha256: sha256(template) } }
    }
  };
  return { root, config, workflow };
}

/** Commit the Story as `start` does, so its snapshot is the accepted one. */
async function accept({ root, config, workflow }) {
  if (!existsSync(path.join(root, '.git'))) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Skill Master Test');
    git(root, 'config', 'user.email', 'skills@example.invalid');
  }
  const file = path.join(root, config.workItemRoot, workflow.workItem.id, 'workflow.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(workflow, null, 2)}\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'start the Story');
}

test('a Story keeps the skill text it started with, offline, whatever the skill master says later', async (t) => {
  const story = await storyFixture(t);
  const original = await readFile(path.join(story.root, SKILL_PATH), 'utf8');
  story.workflow.workflowSnapshot = await captureWorkflowSnapshot(story.root, story.config, story.workflow);
  const manifest = JSON.parse(await readFile(path.join(story.root, story.workflow.workflowSnapshot.manifestPath), 'utf8'));
  const asset = manifest.assets.find((entry) => entry.logicalId === 'agent:developer:skill:security-review');
  assert.equal(asset.purpose, 'agent-skill');
  assert.equal(asset.source.kind, 'reviewed-agent-dependency');
  assert.equal(await readFile(path.join(story.root, asset.blob.path), 'utf8'), original);
  const record = manifest.executionDependencies.find((entry) => entry.id === 'agent:developer:skill:security-review');
  assert.equal(record.inclusion, 'included');
  await accept(story);

  // The skill master changes, then loses the skill altogether: the Story still uses its own text.
  await writeSkill(story.root, { ...SECURITY_REVIEW, instructions: 'Skip the review.' });
  const changed = await resolveStoryExecutionContext(story.root, story.config, story.workflow, { agentId: 'developer', phaseId: 'implementation' });
  const saved = changed.dependencies.find((entry) => entry.source === 'library');
  assert.deepEqual({ id: saved.id, inclusion: saved.inclusion, phases: saved.phases, use: saved.use, text: saved.text },
    { id: 'security-review', inclusion: 'included', phases: ['implementation'], use: 'After you write the code, before you publish it', text: original });
  await rm(path.join(story.root, 'singularity/skill-library'), { recursive: true });
  const rendered = await renderAgentSkills(story.root, story.workflow, story.workflow.resolution.phases[0], { agent: 'developer' }, {
    executionContext: changed, fetchImpl: async () => { throw new Error('a saved skill is never fetched'); }
  });
  assert.match(rendered.text, /1\. List every input the change accepts\./);
  assert.doesNotMatch(rendered.text, /Skip the review/);
  assert.match(rendered.text, /When to use it: After you write the code, before you publish it/);
  assert.deepEqual(rendered.warnings, []);
});

test('a Story whose snapshot did not keep an attached skill says so and goes on without it', async (t) => {
  // An older version took this snapshot: it saved the agent's text but not the skills it attaches.
  const story = await storyFixture(t);
  story.config.agentCatalog[0].librarySkills = [];
  story.workflow.workflowSnapshot = await captureWorkflowSnapshot(story.root, story.config, story.workflow);
  await accept(story);
  const context = await resolveStoryExecutionContext(story.root, story.config, story.workflow, { agentId: 'developer', phaseId: 'implementation' });
  assert.equal(context.dependencies.find((entry) => entry.source === 'library').inclusion, 'omitted');
  const rendered = await renderAgentSkills(story.root, story.workflow, story.workflow.resolution.phases[0], { agent: 'developer' }, { executionContext: context });
  assert.equal(rendered.text, '');
  assert.deepEqual(rendered.warnings, [
    "Skill 'security-review' is attached to developer, but this Story's snapshot did not keep it when the Story started, so this Story does not use it."
  ]);
});

test('Workflow Studio keeps the skill master: one skill, attached to several agents, changed, detached and removed', async (t) => {
  const root = await repository(t);
  const qaBefore = await readFile(path.join(root, '.github/agents/qa.agent.md'), 'utf8');
  // A skill attached in the same change set that creates it.
  const created = await planStudioChangeSet(root, changeSet([
    { op: 'skill.attach', skill: 'security-review', agent: 'developer', phases: ['implementation'], use: 'After you write the code, before you publish it' },
    { op: 'skill.create', ...SECURITY_REVIEW },
    { op: 'skill.attach', skill: 'security-review', agent: 'qa' }
  ]), { write: true });
  assert.equal(created.valid, true, JSON.stringify(created.problems));
  assert.deepEqual(created.files.map((file) => [file.path, file.action]).sort(), [
    ['.github/agents/developer.agent.md', 'update'], ['.github/agents/qa.agent.md', 'update'], [SKILL_PATH, 'create']
  ]);
  assert.equal(await readFile(path.join(root, SKILL_PATH), 'utf8'), librarySkillText(SECURITY_REVIEW));
  assert.match(await readFile(path.join(root, '.github/agents/developer.agent.md'), 'utf8'),
    /\n## Attached skills\n\n\| Skill \| Phases \| When to use it \|\n\|[-| ]+\|\n\| security-review \| implementation \| After you write the code, before you publish it \|\n$/);
  assert.match(await readFile(path.join(root, '.github/agents/qa.agent.md'), 'utf8'), /\| security-review \| \* \| - \|\n$/);
  assert.ok(created.summary.includes('New skill Security pass in the skill master.'), created.summary.join('\n'));

  const model = await buildStudioModel(root);
  const [skill] = model.skills;
  assert.deepEqual({ id: skill.id, label: skill.label, description: skill.description, path: skill.path }, {
    id: 'security-review', label: 'Security pass', description: SECURITY_REVIEW.description, path: SKILL_PATH
  });
  assert.deepEqual(skill.usedBy, [
    { agent: 'developer', phases: ['implementation'], use: 'After you write the code, before you publish it' },
    { agent: 'qa', phases: [], use: '' }
  ]);
  const developer = model.agents.find((agent) => agent.id === 'developer');
  assert.deepEqual(developer.skills, [{ id: 'security-review', phases: ['implementation'], use: 'After you write the code, before you publish it' }]);
  assert.doesNotMatch(developer.instructions, /Attached skills/, 'the Studio edits the table, not the instructions');
  await loadDefinition(root);

  // Instructions edited in the Studio keep the skills the agent attaches.
  const edited = await planStudioChangeSet(root, changeSet([
    { op: 'agent.update', id: 'developer', instructions: `${developer.instructions}\n\nKeep every change small.` },
    { op: 'skill.update', id: 'security-review', instructions: 'Check every input.' }
  ]), { write: true });
  assert.equal(edited.valid, true, JSON.stringify(edited.problems));
  const developerText = await readFile(path.join(root, '.github/agents/developer.agent.md'), 'utf8');
  assert.match(developerText, /Keep every change small\.\n\n## Attached skills\n/);
  assert.deepEqual(parseAgentDependencies(developerText).librarySkills.map((entry) => entry.id), ['security-review']);
  assert.ok(edited.summary.some((line) => /^Skill Security pass updated; .+ use the new text in Stories started from now on\.$/.test(line)), edited.summary.join('\n'));
  assert.match(await readFile(path.join(root, SKILL_PATH), 'utf8'), /\n\nCheck every input\.\n$/);

  const refused = await planStudioChangeSet(root, changeSet([
    { op: 'skill.create', ...SECURITY_REVIEW },
    { op: 'skill.attach', skill: 'style-guide', agent: 'developer' },
    { op: 'skill.attach', skill: 'security-review', agent: 'developer', phases: ['nowhere'] },
    { op: 'skill.attach', skill: 'security-review', agent: 'developer', use: 'Before | after' },
    { op: 'skill.detach', skill: 'security-review', agent: 'architect' }
  ]));
  assert.equal(refused.valid, false);
  assert.deepEqual(refused.problems.map((problem) => problem.code ?? null).filter(Boolean).slice(0, 2), ['STUDIO_SKILL_EXISTS', 'STUDIO_SKILL_UNKNOWN']);
  assert.ok(refused.problems.some((problem) => /does not use skill 'security-review'/.test(problem.message)), JSON.stringify(refused.problems));

  // An update names the agents that use the skill once the whole change set is applied.
  const both = await planStudioChangeSet(root, changeSet([
    { op: 'skill.update', id: 'security-review', description: 'Checks a change for security mistakes.' },
    { op: 'skill.detach', skill: 'security-review', agent: 'qa' }
  ]));
  assert.equal(both.valid, true, JSON.stringify(both.problems));
  assert.ok(both.summary.includes('Skill Security pass updated; Developer uses the new text in Stories started from now on.'), both.summary.join('\n'));

  const detached = await planStudioChangeSet(root, changeSet([{ op: 'skill.detach', skill: 'security-review', agent: 'qa' }]), { write: true });
  assert.equal(detached.valid, true, JSON.stringify(detached.problems));
  assert.equal(await readFile(path.join(root, '.github/agents/qa.agent.md'), 'utf8'), qaBefore,
    'an agent that no longer attaches any skill goes back to its text without the section');

  // Removing a skill detaches it from every agent that still uses it.
  const removed = await planStudioChangeSet(root, changeSet([{ op: 'skill.remove', id: 'security-review' }]), { write: true });
  assert.equal(removed.valid, true, JSON.stringify(removed.problems));
  assert.deepEqual(removed.files.map((file) => [file.path, file.action]).sort(), [
    ['.github/agents/developer.agent.md', 'update'], [SKILL_PATH, 'delete']
  ]);
  assert.equal(existsSync(path.join(root, SKILL_PATH)), false);
  assert.doesNotMatch(await readFile(path.join(root, '.github/agents/developer.agent.md'), 'utf8'), /security-review/);
  await loadDefinition(root);
});

test('attaching a skill to an agent with locked remote resources keeps its lock current', async (t) => {
  const root = await repository(t);
  await addReleaseWorkflow(root, 'source');
  const applied = await planStudioChangeSet(root, changeSet([
    { op: 'skill.create', ...SECURITY_REVIEW },
    { op: 'skill.attach', skill: 'security-review', agent: 'release-manager', phases: ['store-submission'] }
  ]), { write: true });
  assert.equal(applied.valid, true, JSON.stringify(applied.problems));
  const text = await readFile(path.join(root, '.github/agents/release-manager.agent.md'), 'utf8');
  const lock = YAML.parse(await readFile(path.join(root, 'singularity/agents.lock.yml'), 'utf8'));
  assert.equal(lock.agents['release-manager'].sourceSha256, sha256(text));
  assert.deepEqual(lock.agents['release-manager'].dependencies.map((entry) => entry.id), ['store-checklist', 'release-notes'],
    'the skill master never enters the lock of remote resources');
});

async function staged(root, content, url = 'https://skills.example.org/skill.md') {
  const bytes = Buffer.from(content);
  await stageImport(root, { bytes, source: { kind: 'url', url, resolvedUrl: url } });
  return { sha: sha256(bytes), imports: new Map([[sha256(bytes), await readStagedImport(root, sha256(bytes))]]) };
}

test('a skill from a link comes into the skill master: a SKILL.md as it is, plain Markdown with the description given', async (t) => {
  const root = await repository(t);
  const exact = librarySkillText({ ...SECURITY_REVIEW, id: 'store-review', label: null });
  const skillFile = await staged(root, exact, 'https://skills.example.org/store-review/SKILL.md');
  const added = await planStudioChangeSet(root, changeSet([{ op: 'import.librarySkill', id: 'store-review', sha256: skillFile.sha }]),
    { write: true, imports: skillFile.imports });
  assert.equal(added.valid, true, JSON.stringify(added.problems));
  assert.equal(await readFile(path.join(root, 'singularity/skill-library/store-review/SKILL.md'), 'utf8'), exact);
  const ledger = YAML.parse(await readFile(path.join(root, 'singularity/imports.lock.yml'), 'utf8'));
  assert.equal(ledger.imports['library-skill:store-review'].sha256, sha256(exact));
  assert.deepEqual(ledger.imports['library-skill:store-review'].target, { id: 'store-review', path: 'singularity/skill-library/store-review/SKILL.md' });

  const markdown = await staged(root, '# Release notes\n\nWrite them for people, not for machines.\n', 'https://skills.example.org/notes.md');
  const plain = (description, write) => planStudioChangeSet(root, changeSet([{ op: 'import.librarySkill', id: 'release-notes', sha256: markdown.sha, description }]),
    { write, imports: markdown.imports });
  const missing = await plain(null, false);
  assert.equal(missing.valid, false);
  assert.match(missing.problems[0].message, /plain Markdown, so the skill needs a description/);
  const wrapped = await plain('Writes release notes. Use it when a release is planned.', true);
  assert.equal(wrapped.valid, true, JSON.stringify(wrapped.problems));
  const written = await readFile(path.join(root, 'singularity/skill-library/release-notes/SKILL.md'), 'utf8');
  assert.equal(written, librarySkillText({ id: 'release-notes', description: 'Writes release notes. Use it when a release is planned.',
    instructions: '# Release notes\n\nWrite them for people, not for machines.' }));
  const record = YAML.parse(await readFile(path.join(root, 'singularity/imports.lock.yml'), 'utf8')).imports['library-skill:release-notes'];
  assert.deepEqual(record.transforms, ['wrapped-as-skill']);
  assert.equal(record.fileSha256, sha256(written));

  // An update of plain Markdown keeps the skill's name and description unless new ones are given.
  await planStudioChangeSet(root, changeSet([{ op: 'skill.update', id: 'release-notes', label: 'Release notes for people' }]), { write: true });
  const newer = await staged(root, '# Release notes\n\nWrite them for people. Keep them short.\n', 'https://skills.example.org/notes.md');
  const updated = await planStudioChangeSet(root, changeSet([{ op: 'import.librarySkill', id: 'release-notes', sha256: newer.sha, replace: true }]),
    { write: true, imports: newer.imports });
  assert.equal(updated.valid, true, JSON.stringify(updated.problems));
  assert.deepEqual(updated.summary, ['Skill Release notes for people updated from https://skills.example.org/notes.md.']);
  assert.equal(await readFile(path.join(root, 'singularity/skill-library/release-notes/SKILL.md'), 'utf8'), librarySkillText({
    id: 'release-notes', label: 'Release notes for people', description: 'Writes release notes. Use it when a release is planned.',
    instructions: '# Release notes\n\nWrite them for people. Keep them short.'
  }));

  // A skill written here is never replaced by an import.
  await planStudioChangeSet(root, changeSet([{ op: 'skill.create', ...SECURITY_REVIEW }]), { write: true });
  const again = await staged(root, librarySkillText({ ...SECURITY_REVIEW, instructions: 'Imported text.' }));
  const replaced = await planStudioChangeSet(root, changeSet([{ op: 'import.librarySkill', id: 'security-review', sha256: again.sha, replace: true }]),
    { imports: again.imports });
  assert.equal(replaced.valid, false);
  assert.match(replaced.problems[0].message, /was written in this repository, not imported/);
});

/** A committed repository the command line can edit in place. */
async function cliRepository(t) {
  const root = await temporary(t, 'sflow-skill-cli-');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Skill Master Test');
  git(root, 'config', 'user.email', 'skills@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Skills\n');
  flow(root, ['init']);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initialize');
  return root;
}

function flow(root, args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Skill Master Test' }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`sflow ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('the command line lists, shows, creates, attaches, detaches and removes skills, and a dry run writes nothing', async (t) => {
  const root = await cliRepository(t);
  const instructions = path.join(root, '..', `${path.basename(root)}-instructions.md`);
  t.after(() => rm(instructions, { force: true }));
  await writeFile(instructions, `${SECURITY_REVIEW.instructions}\n`);

  flow(root, ['skill', 'create', 'security-review', '--description', SECURITY_REVIEW.description, '--from', instructions, '--dry-run']);
  assert.equal(existsSync(path.join(root, SKILL_PATH)), false, 'a dry run writes nothing');
  flow(root, ['skill', 'create', 'security-review', '--label', 'Security pass', '--description', SECURITY_REVIEW.description, '--from', instructions]);
  assert.equal(await readFile(path.join(root, SKILL_PATH), 'utf8'), librarySkillText(SECURITY_REVIEW));
  flow(root, ['skill', 'attach', 'security-review', '--agent', 'developer', '--phases', 'implementation', '--use', 'After you write the code, before you publish it']);
  flow(root, ['skill', 'attach', 'security-review', '--agent', 'qa']);

  const listed = JSON.parse(flow(root, ['skill', 'list', '--json']).stdout);
  assert.equal(listed.resultType, 'skill-master');
  assert.deepEqual(listed.skills.map((skill) => [skill.id, skill.usedBy.map((use) => use.agent)]), [['security-review', ['developer', 'qa']]]);
  const shown = flow(root, ['skill', 'show', 'security-review']).stdout;
  assert.match(shown, /^Security pass \(security-review\) · singularity\/skill-library\/security-review\/SKILL\.md\n/);
  assert.match(shown, /in implementation: After you write the code, before you publish it\n/);
  assert.match(shown, /in every step it drafts\n/);
  flow(root, ['workflow', 'validate']);

  flow(root, ['skill', 'edit', 'security-review', '--instructions', 'Check every input.']);
  assert.match(await readFile(path.join(root, SKILL_PATH), 'utf8'), /\n\nCheck every input\.\n$/);
  flow(root, ['skill', 'detach', 'security-review', '--agent', 'qa']);
  flow(root, ['skill', 'remove', 'security-review']);
  assert.equal(existsSync(path.join(root, SKILL_PATH)), false);
  assert.doesNotMatch(await readFile(path.join(root, '.github/agents/developer.agent.md'), 'utf8'), /security-review/);
  assert.match(flow(root, ['skill', 'list']).stdout, /^The skill master has no skills yet\./);

  const refusals = [
    [['skill', 'create', 'Security_Review', '--description', 'x', '--instructions', 'y'], /one skill ID in lower-case kebab-case/],
    [['skill', 'attach', 'security-review'], /needs --agent <AGENT>/],
    [['skill', 'show', 'security-review'], /There is no skill 'security-review' in the skill master/],
    [['skill', 'create', 'security-review', '--description', 'x'], /needs its instructions/],
    [['skill', 'list', '--agent', 'qa'], /does not support '--agent'/]
  ];
  for (const [args, message] of refusals) {
    const result = flow(root, args, { allowFailure: true });
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(`${result.stdout}${result.stderr}`, message, args.join(' '));
  }
});

test('skill master reads are reads, its changes are mutations, and a dry run only previews', () => {
  const resolve = (args, options = {}) => resolveOperation({ requestedCommand: 'skill', positionals: ['skill', ...args], options });
  const catalog = new Map(operationCatalog().map((entry) => [entry.id, entry]));
  for (const [args, options, id, classification] of [
    [['list'], {}, 'skill.list', 'read'],
    [['show', 'security-review'], { json: true }, 'skill.show', 'read'],
    [['inspect', '.'], {}, 'skill.inspect', 'read'],
    [['create', 'security-review'], {}, 'skill.create', 'mutation'],
    [['attach', 'security-review'], { agent: 'qa' }, 'skill.attach', 'mutation'],
    [['remove', 'security-review'], { 'dry-run': true }, 'skill.remove.preview', 'read']
  ]) {
    const operation = resolve(args, options);
    assert.deepEqual([operation.id, operation.classification, operation.modelPolicy], [id, classification, 'never'], args.join(' '));
    assert.equal(catalog.get(id)?.classification, classification, id);
  }
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** A hand-edited bundle with every digest recomputed, so only the edit itself is under test. */
function resealed(bundle) {
  for (const asset of bundle.assets) {
    asset.size = Buffer.byteLength(asset.content, 'utf8');
    asset.sha256 = `sha256:${sha256(asset.content)}`;
  }
  const copy = structuredClone(bundle);
  delete copy.bundleSha256;
  bundle.bundleSha256 = `sha256:${sha256(JSON.stringify(canonical(copy)))}`;
  return bundle;
}

test('a workflow bundle carries the skills its agents attach, and nothing else from the skill master', async (t) => {
  const source = await repository(t, 'sflow-skill-transfer-source-');
  await addReleaseWorkflow(source, 'source', { librarySkill: true });
  await writeSkill(source);
  const bundle = await exportWorkflowBundle(source, ['mobile-release']);
  assert.equal(bundle.schemaVersion, 5);
  const skills = bundle.assets.filter((asset) => asset.kind === 'skill');
  assert.deepEqual(skills.map((asset) => [asset.id, asset.path]), [['store-review', LIBRARY_SKILL_PATH]],
    'security-review is in the skill master but no carried agent attaches it');
  assert.equal(skills[0].content, releaseSkill('source'));

  const target = await repository(t, 'sflow-skill-transfer-fresh-');
  const variant = (edit) => resealed(edit(structuredClone(bundle)));
  for (const [label, edit, code] of [
    ['an attached skill is missing', (copy) => { copy.assets = copy.assets.filter((asset) => asset.kind !== 'skill'); return copy; },
      'WORKFLOW_BUNDLE_DEPENDENCY_MISSING'],
    ['a skill no carried agent attaches', (copy) => {
      copy.assets.push({ ...structuredClone(skills[0]), id: 'security-review', path: SKILL_PATH,
        content: librarySkillText(SECURITY_REVIEW) });
      return copy;
    }, 'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA'],
    ['a skill under another name', (copy) => {
      copy.assets.find((asset) => asset.kind === 'skill').content = releaseSkill('source').replace('name: store-review', 'name: other');
      return copy;
    }, 'WORKFLOW_BUNDLE_INVALID'],
    ['a version-4 bundle that carries a skill', (copy) => { copy.schemaVersion = 4; return copy; }, 'WORKFLOW_BUNDLE_INVALID']
  ]) {
    await assert.rejects(() => planWorkflowImport(target, variant(edit)), (error) => error.code === code, label);
  }

  const plan = await planWorkflowImport(target, bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved));
  assert.ok(plan.changedPaths.includes(LIBRARY_SKILL_PATH));
  await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256 });
  assert.equal(await readFile(path.join(target, LIBRARY_SKILL_PATH), 'utf8'), releaseSkill('source'));
  const definition = await loadDefinition(target);
  assert.deepEqual(definition.agents['release-manager'].librarySkills.map((entry) => entry.id), ['store-review']);
});

test('a same-name skill is kept, replaced or imported under a new name that the agents follow', async (t) => {
  const source = await repository(t, 'sflow-skill-conflict-source-');
  await addReleaseWorkflow(source, 'source', { librarySkill: true });
  const bundle = await exportWorkflowBundle(source, ['mobile-release']);
  const local = async () => {
    const root = await repository(t, 'sflow-skill-conflict-local-');
    await addReleaseWorkflow(root, 'source', { librarySkill: true });
    await writeFile(path.join(root, LIBRARY_SKILL_PATH), releaseSkill('local'));
    return root;
  };

  const blocked = await planWorkflowImport(await local(), bundle);
  const conflict = blocked.unresolved.find((entry) => entry.subject === 'skill:store-review');
  assert.ok(conflict, JSON.stringify(blocked.unresolved));
  assert.deepEqual(conflict.choices, ['keep', 'replace', 'rename']);
  assert.deepEqual(blocked.unresolved.map((entry) => entry.subject), ['skill:store-review'],
    'the rest of the workflow is the same, so only the skill differs');

  const kept = await local();
  const keep = await planWorkflowImport(kept, bundle, { resolutions: { 'skill:store-review': { action: 'keep' } } });
  assert.equal(keep.status, 'ready', JSON.stringify(keep.unresolved));
  await applyWorkflowImport(kept, bundle, { expectedPlanSha256: keep.planSha256, resolutions: keep.resolutions });
  assert.equal(await readFile(path.join(kept, LIBRARY_SKILL_PATH), 'utf8'), releaseSkill('local'));

  const replaced = await local();
  const replace = await planWorkflowImport(replaced, bundle, { resolutions: { 'skill:store-review': { action: 'replace' } } });
  await applyWorkflowImport(replaced, bundle, { expectedPlanSha256: replace.planSha256, resolutions: replace.resolutions });
  assert.equal(await readFile(path.join(replaced, LIBRARY_SKILL_PATH), 'utf8'), releaseSkill('source'));

  const renamed = await local();
  const rename = await planWorkflowImport(renamed, bundle, { resolveAll: 'suggested' });
  assert.equal(rename.status, 'ready', JSON.stringify(rename.unresolved));
  await applyWorkflowImport(renamed, bundle, { expectedPlanSha256: rename.planSha256, resolutions: rename.resolutions });
  const to = conflict.renameTo;
  assert.equal(await readFile(path.join(renamed, LIBRARY_SKILL_PATH), 'utf8'), releaseSkill('local'), 'the repository keeps its own');
  const imported = parseLibrarySkill(await readFile(path.join(renamed, `singularity/skill-library/${to}/SKILL.md`), 'utf8'), { id: to });
  assert.match(imported.instructions, /\(source\)/);
  assert.match(imported.label, /\(imported\)$/);
  // The bundle's agent now attaches another skill than the repository's agent of the same name,
  // so it comes in under a new name too; each agent keeps its own skill.
  const definition = await loadDefinition(renamed);
  const users = Object.values(definition.agents).filter((agent) => agent.librarySkills?.some((entry) => entry.id === to));
  assert.deepEqual(users.map((agent) => agent.id), [rename.renamed.find((entry) => entry.subject === 'agent:release-manager').to]);
  assert.deepEqual(users[0].librarySkills, [{ id: to, phases: ['store-submission'], use: 'Before you submit the build' }]);
  assert.deepEqual(definition.agents['release-manager'].librarySkills.map((entry) => entry.id), ['store-review']);
});

test('the VS Code import names a skill conflict as a skill', async () => {
  const { workflowImportConflictTitle } = await import(new URL('../apps/vscode/src/views/workflow-transfer-presentation.ts', import.meta.url));
  assert.equal(workflowImportConflictTitle({ subject: 'skill:store-review', kind: 'skill', id: 'store-review', reasons: [], choices: ['keep', 'replace', 'rename'] }, 0, 1),
    'Import conflict 1 of 1: skill store-review');
});
