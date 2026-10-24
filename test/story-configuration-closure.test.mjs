import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import {
  configurationAssetPaths, copyVerifiedStoryConfigurationDefinition, expectedStoryConfigurationMaterialization,
  loadStoryConfigurationSnapshot, materializeConfigurationSnapshot, readConfigurationSource,
  resolveApprovedStoryWorkType, resolveApprovedStoryWorkTypeFor, storyConfigurationClosure
} from '../src/configuration-branch.mjs';
import { loadMaterializedConfigurationDefinition } from '../src/commands/start-configuration.mjs';
import {
  gitBlobObject, projectAgentMappingsText, projectSkillAttachmentsText, projectWorkflowText
} from '../src/story-configuration-closure.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** An approved configuration on `sflow/config` of a repository whose `main` is code only. */
async function approvedFixture(t, edit = null) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-closure-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'root');
  await mkdir(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Closure Tester');
  git(root, 'config', 'user.email', 'closure@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Application\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'application');
  git(root, 'switch', '-q', '--orphan', 'sflow/config');
  await initializeDefinition(root);
  if (edit) await edit(root);
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'approved');
  const commit = git(root, 'rev-parse', 'HEAD');
  git(root, 'switch', '-q', 'main');
  const snapshot = await loadStoryConfigurationSnapshot({ remote: root, branch: 'sflow/config', commit });
  const story = (name) => {
    const target = path.join(parent, name);
    git(root, 'worktree', 'add', '-q', '-b', name, target, 'main');
    return target;
  };
  return { parent, root, commit, snapshot, story };
}

const editYaml = async (root, relative, change) => {
  const file = path.join(root, relative);
  const value = YAML.parse(await readFile(file, 'utf8'));
  change(value);
  await writeFile(file, YAML.stringify(value));
};

test('every packaged workflow has a closure that loads on its own and resolves exactly as the whole copy', async t => {
  const f = await approvedFixture(t);
  const full = copyVerifiedStoryConfigurationDefinition(f.snapshot, f.root);
  const workTypes = Object.keys(full.workTypes);
  assert.ok(workTypes.length > 10, 'the packaged configuration carries many workflows');
  for (const workType of workTypes) {
    const closure = await storyConfigurationClosure(f.snapshot, [workType]);
    assert.ok(closure.entries.length < f.snapshot.assets.length / 2, `${workType} carries only its closure`);
    const expected = await expectedStoryConfigurationMaterialization(f.snapshot, {
      closure: { kind: 'work-type', workTypes: [workType], derived: { ...closure.derived } }
    }, f.root);
    const projected = expected.definition();
    assert.deepEqual(Object.keys(projected.workTypes), [workType]);
    assert.ok(isDeepStrictEqual(resolveWorkType(structuredClone(projected), workType),
      resolveWorkType(structuredClone(full), workType)), `${workType} resolves exactly as the whole copy does`);
  }
});

test('the spec-driven closure carries its four agents and six templates, and records each rewritten file', async t => {
  const f = await approvedFixture(t);
  const closure = await storyConfigurationClosure(f.snapshot, ['spec-driven-standard']);
  const paths = closure.entries.map(entry => entry.relative);
  assert.deepEqual(paths.filter(relative => relative.startsWith('.github/agents/')), [
    '.github/agents/architect.agent.md', '.github/agents/developer.agent.md',
    '.github/agents/product-owner.agent.md', '.github/agents/qa.agent.md'
  ]);
  assert.equal(paths.filter(relative => relative.startsWith('singularity/templates/')).length, 6);
  assert.equal(paths.some(relative => relative.startsWith('singularity/skill-library/')), false,
    'no skill is attached to this workflow or its agents');
  for (const kept of ['singularity/portfolio.yml', 'singularity/impact.yml', 'singularity/modelTiers.yml',
    'singularity/prompts/copilot-planning.md', 'singularity/agent-mappings.yml']) assert.ok(paths.includes(kept), kept);
  const approved = new Map(f.snapshot.assets.map(entry => [entry.relative, entry]));
  for (const entry of closure.entries) {
    assert.equal(entry.object, gitBlobObject(entry.contents), `${entry.relative} names its own Git blob`);
    if (!entry.derived) {
      assert.ok(entry.contents.equals(approved.get(entry.relative).contents), `${entry.relative} is the approved bytes`);
      continue;
    }
    assert.equal(entry.derived.object, approved.get(entry.relative).object, `${entry.relative} names its approved object`);
  }
  assert.equal(closure.derived['singularity/workflow.yml'].transform, 'work-type-projection');
  const developer = closure.entries.find(entry => entry.relative === '.github/agents/developer.agent.md').contents.toString('utf8');
  assert.match(developer, /sflow-phases: "implementation"/);
  const workflow = YAML.parse(closure.entries.find(entry => entry.relative === 'singularity/workflow.yml').contents.toString('utf8'));
  assert.deepEqual(Object.keys(workflow.workTypes), ['spec-driven-standard']);
  assert.deepEqual(workflow.mcpServers.playwright.phases, ['verification'], 'a shared server is narrowed to the carried steps');
  assert.equal(workflow.mcpServers.figma, undefined, 'a server only other workflows use stays behind');
  assert.deepEqual(Object.keys(workflow.approvalAuthorities), Object.keys(f.snapshot.definition.approvalAuthorities),
    'approval groups are repository identities and stay whole');
  // The same approved bytes always project to the same files.
  const again = await loadStoryConfigurationSnapshot({ remote: f.root, branch: 'sflow/config', commit: f.commit });
  assert.deepEqual((await storyConfigurationClosure(again, ['spec-driven-standard'])).assets, closure.assets);
});

test('a Story branch materializes only its closure, verifies it, and refuses drift or a changed record', async t => {
  const f = await approvedFixture(t);
  const target = f.story('CLOSURE-1');
  const materialized = await materializeConfigurationSnapshot(target, { snapshot: f.snapshot, workTypes: ['feature'] });
  const closure = await storyConfigurationClosure(f.snapshot, ['feature']);
  assert.deepEqual(await configurationAssetPaths(target), Object.keys(closure.assets).sort());
  assert.ok(materialized.paths.length < f.snapshot.assets.length / 4);
  const source = await readConfigurationSource(target, { verify: true, exactBytes: true });
  assert.deepEqual(source.assets, closure.assets);
  assert.deepEqual(source.closure.workTypes, ['feature']);
  assert.equal(source.closure.approvedAssetCount, f.snapshot.assets.length);
  assert.equal(source.commit, f.commit, 'the record stays bound to the approved commit');
  const definition = await loadMaterializedConfigurationDefinition(target, f.snapshot);
  assert.deepEqual(Object.keys(definition.workTypes), ['feature']);
  assert.ok(definition.agentCatalog.filter(agent => agent.scope === 'repository').every(agent =>
    !path.relative(target, agent.file).startsWith('..')), 'the reused definition is rebound to the checkout');
  // A record naming another closure is not this approved revision's projection.
  const recordFile = path.join(target, 'singularity/configuration-source.json');
  const original = await readFile(recordFile, 'utf8');
  const forged = JSON.parse(original); forged.closure.workTypes = ['bugfix'];
  await writeFile(recordFile, `${JSON.stringify(forged, null, 2)}\n`);
  await assert.rejects(loadMaterializedConfigurationDefinition(target, f.snapshot), /does not match its verified owner/);
  await writeFile(recordFile, original);
  // An omitted approved file reappearing is drift, like any other unexpected asset.
  await mkdir(path.join(target, 'singularity/templates/bugfix'), { recursive: true });
  await writeFile(path.join(target, 'singularity/templates/bugfix/reproduction.md'), '# Reproduction\n');
  await assert.rejects(loadMaterializedConfigurationDefinition(target, f.snapshot), /asset set changed/);
});

test('without work types, or when the base already carries more, the whole revision is copied as before', async t => {
  const f = await approvedFixture(t);
  const whole = f.story('WHOLE-1');
  const record = await materializeConfigurationSnapshot(whole, { snapshot: f.snapshot });
  assert.equal(record.closure, undefined);
  assert.equal(Object.keys(record.assets).length, f.snapshot.assets.length);
  // A base that already carries the whole configuration keeps it: a closure would delete files.
  git(whole, 'add', '-A'); git(whole, 'commit', '-qm', 'whole copy');
  const stacked = path.join(f.parent, 'STACKED-1');
  git(f.root, 'worktree', 'add', '-q', '-b', 'STACKED-1', stacked, 'WHOLE-1');
  const fallback = await materializeConfigurationSnapshot(stacked, { snapshot: f.snapshot, workTypes: ['chore'] });
  assert.equal(fallback.closure, undefined);
  assert.equal(fallback.closureUnavailable, 'STORY_CONFIGURATION_BASE_CARRIES_MORE');
  assert.deepEqual(fallback.removed, {});
  assert.equal(Object.keys(fallback.assets).length, f.snapshot.assets.length);
});

test('a start agent outside the closure keeps the whole copy, so its audited override still runs', async t => {
  const f = await approvedFixture(t);
  const inside = await materializeConfigurationSnapshot(f.story('AGENT-IN'), {
    snapshot: f.snapshot, workTypes: ['spec-driven-standard'], agents: ['developer']
  });
  assert.deepEqual(inside.closure.workTypes, ['spec-driven-standard']);
  const outside = await materializeConfigurationSnapshot(f.story('AGENT-OUT'), {
    snapshot: f.snapshot, workTypes: ['spec-driven-standard'], agents: ['demo-web-tester']
  });
  assert.equal(outside.closure, undefined);
  assert.equal(outside.closureUnavailable, 'STORY_CONFIGURATION_AGENT_OUTSIDE_CLOSURE');
  assert.equal(Object.keys(outside.assets).length, f.snapshot.assets.length);
});

test('a base carrying another Story closure keeps its workflow, so the new Story deletes nothing', async t => {
  const f = await approvedFixture(t);
  const first = f.story('FIRST-1');
  await materializeConfigurationSnapshot(first, { snapshot: f.snapshot, workTypes: ['chore'] });
  git(first, 'add', '-A'); git(first, 'commit', '-qm', 'merged Story configuration');
  const next = path.join(f.parent, 'NEXT-1');
  git(f.root, 'worktree', 'add', '-q', '-b', 'NEXT-1', next, 'FIRST-1');
  const record = await materializeConfigurationSnapshot(next, { snapshot: f.snapshot, workTypes: ['spec-driven-standard'] });
  assert.deepEqual(record.closure.workTypes, ['chore', 'spec-driven-standard']);
  assert.deepEqual(record.removed, {});
  const carried = await configurationAssetPaths(first);
  const now = await configurationAssetPaths(next);
  assert.ok(carried.every(relative => now.includes(relative)));
});

test('a reviewed amendment compares a newer revision in the Story closure, never another workflow', async t => {
  const f = await approvedFixture(t, root => editYaml(root, 'singularity/workflow.yml', value => {
    value.contextPolicy.phaseOverrides = { intake: 'new', specification: 'new' };
  }));
  const target = f.story('AMEND-1');
  const source = await materializeConfigurationSnapshot(target, { snapshot: f.snapshot, workTypes: ['spec-driven-standard'] });
  const story = { workItem: { workType: 'spec-driven-standard' }, resolution: { configurationSource: source } };
  const definition = await loadMaterializedConfigurationDefinition(target, f.snapshot);
  const pinned = resolveWorkType(definition, 'spec-driven-standard');
  assert.deepEqual(pinned.contextPolicy.phaseOverrides, { specification: 'new' });
  assert.deepEqual(resolveApprovedStoryWorkType(f.snapshot, 'spec-driven-standard').contextPolicy.phaseOverrides,
    { intake: 'new', specification: 'new' }, 'the whole revision also names a step this Story does not have');
  assert.deepEqual((await resolveApprovedStoryWorkTypeFor(f.snapshot, story)).contextPolicy, pinned.contextPolicy);
  const legacy = { workItem: { workType: 'spec-driven-standard' }, resolution: { configurationSource: { commit: f.commit } } };
  assert.deepEqual(await resolveApprovedStoryWorkTypeFor(f.snapshot, legacy),
    resolveApprovedStoryWorkType(f.snapshot, 'spec-driven-standard'), 'a whole-copy Story compares as before');
});

test('projection keeps layout, narrows shared lists and never widens one to "any"', () => {
  const text = [
    'version: 2',
    '# kept comment',
    'workTypes:',
    '  one: { label: One, phases: [a] }',
    '  two: { label: Two, phases: [b] }',
    'phases:',
    '  a: { label: A }',
    '  b: { label: B }',
    'mcpServers:',
    '  shared:',
    '    agents: [x, y]',
    '    phases: [a, b]',
    'documents:',
    '  allowedPhases: [b]',
    'contextPolicy:',
    '  phaseOverrides: { a: new, b: keep }',
    ''
  ].join('\n');
  const objects = { mcpServers: { shared: {} } };
  const projected = projectWorkflowText(text, { workTypes: ['one'], objects, phases: new Set(['a']), agents: new Set(['x']) });
  assert.match(projected, /# kept comment/);
  assert.match(projected, /agents: \[ x \]|agents: \[x\]/);
  assert.match(projected, /phases: \[ a \]|phases: \[a\]/);
  const value = YAML.parse(projected);
  assert.deepEqual(Object.keys(value.workTypes), ['one']);
  assert.deepEqual(Object.keys(value.phases), ['a']);
  assert.deepEqual(value.documents.allowedPhases, [], 'an allow-list may become empty: it allows none');
  assert.deepEqual(value.contextPolicy.phaseOverrides, { a: 'new' });
  assert.throws(() => projectWorkflowText(text, { workTypes: ['one'], objects, phases: new Set(['a']), agents: new Set(['z']) }),
    error => error.code === 'STORY_CONFIGURATION_CLOSURE_INVALID');
  const attachments = projectSkillAttachmentsText([
    'attachments:',
    '  - skill: kept', '    agent: x', '    steps: [a, b]',
    '  - skill: other-agent', '    agent: z',
    '  - skill: other-steps', '    agent: x', '    steps: [b]',
    '  - skill: workflow-wide', '    workflow: one',
    ''
  ].join('\n'), { workTypes: ['one'], agents: new Set(['x']), phases: new Set(['a']) });
  assert.deepEqual(YAML.parse(attachments.text).attachments, [
    { skill: 'kept', agent: 'x', steps: ['a'] }, { skill: 'workflow-wide', workflow: 'one' }
  ]);
  assert.deepEqual([...attachments.skills].sort(), ['kept', 'workflow-wide']);
  assert.deepEqual(YAML.parse(projectAgentMappingsText('version: 1\nmappings:\n  a: x\n  b: z\n', new Set(['x']))).mappings, { a: 'x' });
});

test('a whole Story on a closure-only branch starts, publishes, submits, approves and amends', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-closure-cli-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const remote = path.join(parent, 'origin.git');
  const app = path.join(parent, 'app');
  const config = path.join(parent, 'config');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Closure Tester', NO_COLOR: '1' };
  const spawnCli = (...args) => spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: app, encoding: 'utf8', env });
  const cli = (...args) => {
    const result = spawnCli(...args);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  git(parent, 'init', '-q', '--bare', '-b', 'main', remote);
  await mkdir(app);
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'config', 'user.name', 'Closure Tester'); git(app, 'config', 'user.email', 'closure@example.invalid');
  await writeFile(path.join(app, 'package.json'), `${JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } })}\n`);
  git(app, 'add', '.'); git(app, 'commit', '-qm', 'application');
  git(app, 'remote', 'add', 'origin', remote); git(app, 'push', '-q', '-u', 'origin', 'main');
  await mkdir(config);
  git(config, 'init', '-q', '-b', 'sflow/config');
  git(config, 'config', 'user.name', 'Closure Tester'); git(config, 'config', 'user.email', 'closure@example.invalid');
  await initializeDefinition(config);
  await editYaml(config, 'singularity/workflow.yml', value => {
    value.worldModel.grounding = 'off';
    value.approvalSecurity = { profile: 'poc' };
    value.repositoryReadiness = { ...(value.repositoryReadiness ?? {}), requiredBeforeStory: false };
    for (const authority of Object.values(value.approvalAuthorities)) authority.allowAnyGitIdentity = true;
    value.workTypes['spec-driven-standard'].sourceReview = { mode: 'off' };
  });
  git(config, 'add', '-A'); git(config, 'commit', '-qm', 'approved configuration');
  const approvedFiles = git(config, 'ls-files').split('\n').length;
  git(config, 'remote', 'add', 'origin', remote); git(config, 'push', '-q', 'origin', 'sflow/config');

  const WORK = 'CLOSURE-CLI-1';
  cli('start', WORK, '--from-branch', 'main', '--work-type', 'spec-driven-standard', '--target-url', 'https://staging.example.test',
    '--title', 'Validate a value', '--description', 'Return an approved value with browser-visible proof.');
  const initFiles = git(app, 'show', '--name-only', '--format=', 'HEAD').split('\n')
    .filter(relative => !relative.startsWith('singularity/work-items/'));
  assert.ok(initFiles.length < approvedFiles / 5, `the init commit carries ${initFiles.length} of ${approvedFiles} configuration files`);
  assert.equal(initFiles.filter(relative => relative.startsWith('.github/agents/')).length, 4);
  assert.match(cli('validate'), /workflow is valid/);
  // Doctor exits non-zero for this fixture's unrelated warnings (no model provider, unassigned step).
  const doctor = spawnCli('doctor');
  assert.match(doctor.stdout, /initialization-assets: All \d+ configuration assets this Story pins are present and valid/);
  assert.doesNotMatch(doctor.stdout, /packaged initialization asset\(s\) are missing/);

  const item = path.join(app, 'singularity/work-items', WORK);
  const spec = value => [
    `# ${WORK} — Specification`, '', '## Agent brief', '', `The exported value must be ${value}.`, '',
    '## Actors', '', 'A user reads the value.', '', '## User scenarios', '', '### S1 — Read the value', '',
    `Given a ready application, when a user reads the value, then ${value} is displayed.`, '',
    '## Failure and empty states', '', 'A missing value is rejected without inventing data.', '',
    '## Permissions', '', 'A user may read the value without special privileges.', '',
    '## Boundary conditions', '', 'Only the approved integer value is exposed.', '',
    '## Requirements', '', `- The application returns the value ${value}. [${WORK}:REQ-001]`,
    `- The user sees the value ${value}. [${WORK}:AC-001]`, '',
    '## Scenario coverage', '', '| Clause | Scenario | Outcome |', '|---|---|---|',
    `| \`${WORK}:REQ-001\` | S1 | success |`, `| \`${WORK}:AC-001\` | S1 | success |`, '',
    '## Boundary and non-functional requirements', '', 'Invalid input is rejected deterministically.', '',
    '## Non-functional requirements', '', 'A local read returns without a network call.', '',
    '## Assumptions', '', 'The value is available in the local application.', '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${WORK}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`,
    `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Evidence and assumptions', '', 'The pinned repository is the implementation source.', '',
    '## Out of scope', '', 'No unrelated application changes.', ''
  ].join('\n');
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), spec(1));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  cli('approve', 'specification', '--yes');
  const candidate = path.join(parent, 'amended-spec.md');
  await writeFile(candidate, spec(2));
  cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed value 2 is required.',
    '--source-phase', 'planning', '--clause', `${WORK}:REQ-001`, '--clause', `${WORK}:AC-001`, '--json');
  cli('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001', '--json');
  cli('story', 'intent-amendment', 'acknowledge', 'AMD-001');
  assert.match(cli('prepare', 'planning'), /planning is ready to author/);
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(workflow.phases.specification.status, 'approved');
  assert.equal(workflow.phases.specification.generation, 2);
  assert.deepEqual(workflow.resolution.configurationSource.closure.workTypes, ['spec-driven-standard']);
  assert.deepEqual(Object.keys(workflow.resolution.agents).sort(), ['architect', 'developer', 'product-owner', 'qa',
    ...Object.keys(workflow.resolution.agents).filter(id => id.startsWith('sflow-'))].sort());
  assert.match(cli('validate'), /workflow is valid/);
});
