/**
 * Skills for each step of a task (docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md REQ-010, A6, A7, A9): chosen from the step's intent
 * and what the task touches, the library first and then the marketplaces the repository trusts; a proposed or beta
 * skill and a marketplace skill new here need the person's yes; the Story's snapshot keeps the exact text it uses.
 * The marketplace is a local Git repository made from test/fixtures/sdlc-marketplace: nothing here uses a network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { composeTask, planLine } from '../src/task-composition.mjs';
import { taskPlan } from '../src/commands/work.mjs';
import { chooseTaskSkills, librarySkillCandidate, marketplaceSkillCandidate, planSkillWords, TASK_SKILL_LIMIT } from '../src/task-skills.mjs';
import { journeyRepository, storyRecord } from './helpers/route-follower.mjs';
import { seeded } from './helpers/story-fuzzer.mjs';
import { TASK_KINDS } from '../src/task-composition.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const FIXTURE = path.join(ROOT, 'test/fixtures/sdlc-marketplace');
const base = () => structuredClone(BASE);

const library = (id, tags, extra = {}) => librarySkillCandidate({ id, label: id, tags, sha256: `${id}-bytes` }, extra.imported ?? null);
const market = (name, tags, pdlcTasks, lifecycleState = 'approved') => marketplaceSkillCandidate({ name, tags, pdlcTasks, lifecycleState, version: '1.0.0' }, 'acme');
const plan = (kind, sources, options = {}) => taskPlan(base(), { kind, ...options, chooseSkills: async (composition) => chooseTaskSkills(composition, sources) });

test('ITW REQ-010: a step gets the library skill whose task is its intent and that the task touches, the same way every time', async () => {
  const e2e = library('web-smoke-checks', ['task:e2e-testing', 'web', 'playwright']);
  const backend = library('api-contract-checks', ['task:contract-testing', 'backend']);
  const words = library('xray-cases', ['task:test-case-creation', 'xray']);
  const free = library('house-style', ['task:api-implementation']);
  const candidates = [e2e, backend, words, free];
  const web = await plan('fix', { candidates, kinds: ['web'], words: 'fix the login button' });
  assert.equal(web.plan, 'Plan: code (with web-smoke-checks) → tests. You approve the plan in the intake and the code. Say "add a design step" to change it.');
  assert.deepEqual(web.skills, [{ id: 'web-smoke-checks', steps: ['implementation'], sha256: 'web-smoke-checks-bytes',
    why: 'its task e2e-testing is a code step\'s work; this repository is a web app' }]);
  assert.deepEqual(web.composition.skills, web.skills, 'the skills a Story uses are part of its composition');
  assert.deepEqual(web.steps.find((step) => step.id === 'implementation').skills, ['web-smoke-checks']);
  assert.deepEqual(await plan('fix', { candidates, kinds: ['web'], words: 'fix the login button' }), web, 'the same words and repository, the same plan');
  // A skill for another kind of software is never chosen; one for no kind needs the words to name one of its tags.
  const api = await plan('fix', { candidates, kinds: ['backend'], words: 'fix the login button' });
  assert.deepEqual(api.skills.map((skill) => skill.id), ['api-contract-checks']);
  assert.deepEqual((await plan('feature', { candidates, kinds: [], words: 'add xray cases for checkout' })).skills.map((skill) => [skill.id, skill.steps]),
    [['xray-cases', ['requirements']]]);
  assert.deepEqual((await plan('feature', { candidates, kinds: [], words: 'add a gift card' })).skills, []);
  // A task with no code step gets no code skill; a skill only fits a step its task is for.
  assert.deepEqual((await plan('investigate', { candidates, kinds: ['web'], words: 'why does login fail' })).skills, []);
  // Without skills the plan line is as before.
  const none = await plan('fix', { candidates: [], kinds: ['web'], words: 'x' });
  assert.equal(none.plan, 'Plan: code → tests. You approve the plan in the intake and the code. Say "add a design step" to change it.');
  assert.equal(none.composition.skills, undefined);
  // At most two per step, by what the task touches and then by ID.
  const many = ['a', 'b', 'c'].map((id) => library(`web-${id}`, ['task:ui-implementation', 'web']));
  const ranked = chooseTaskSkills(composeTask(base(), { kind: 'fix' }), { candidates: [...many.reverse(), library('web-z', ['task:ui-implementation', 'web', 'checkout'])], kinds: ['web'], words: 'fix checkout' });
  assert.equal(TASK_SKILL_LIMIT, 2);
  assert.deepEqual(ranked.skills.map((skill) => skill.id), ['web-z', 'web-a']);
  // A team's own step intent tag works as a task does.
  assert.deepEqual(chooseTaskSkills(composeTask(base(), { kind: 'fix' }), { candidates: [library('release-notes-style', ['intent:test', 'web'])], kinds: ['web'] }).skills
    .map((skill) => [skill.id, skill.steps]), [['release-notes-style', ['verification']]]);
});

test('ITW REQ-010, A7: a proposed or beta skill, and a marketplace skill new here, need the person\'s yes; no is a no', async () => {
  const beta = library('web-visual-diff', ['task:e2e-testing', 'web', 'beta']);
  const offered = await plan('fix', { candidates: [beta], kinds: ['web'] });
  assert.deepEqual(offered.skills, []);
  assert.deepEqual(offered.offers.map(({ id, new: isNew, state, steps }) => [id, isNew, state, steps]), [['web-visual-diff', false, 'beta', ['implementation']]]);
  assert.match(offered.plan, /^Plan: code \(with web-visual-diff, beta: use it\?\) → tests\./u);
  const yes = await plan('fix', { candidates: [beta], kinds: ['web'], use: ['web-visual-diff'] });
  assert.deepEqual(yes.skills.map((skill) => skill.id), ['web-visual-diff']);
  assert.deepEqual(yes.offers, []);
  const no = await plan('fix', { candidates: [beta], kinds: ['web'], without: ['web-visual-diff'] });
  assert.deepEqual([no.skills, no.offers], [[], []]);
  // A skill imported from a marketplace keeps what its apm.yml said, so a proposed one still needs a yes.
  const imported = library('web-xray-creation', [], { imported: { source: { kind: 'marketplace-skill', marketplace: 'acme', tasks: ['test-case-creation'], tags: ['web', 'xray', 'beta'], lifecycleState: 'proposed' } } });
  assert.deepEqual([imported.intents, imported.kinds, imported.lifecycle], [['requirements'], ['web'], 'unreviewed']);
  // A marketplace skill is offered only for a step the library has nothing for, and only once it is not in the library.
  const e2e = market('web-e2e-test-generation', ['web', 'playwright', 'test-automation', 'ga'], ['e2e-testing', 'ui-test-automation']);
  const fromMarket = await plan('fix', { candidates: [e2e], kinds: ['web'] });
  assert.equal(fromMarket.plan, 'Plan: code (with web-e2e-test-generation from acme, new here: add it?) → tests. You approve the plan in the intake and the code. Say "add a design step" to change it.');
  assert.deepEqual(fromMarket.offers.map(({ id, new: isNew, marketplace, state }) => [id, isNew, marketplace, state]), [['web-e2e-test-generation', true, 'acme', null]]);
  const libraryFirst = await plan('fix', { candidates: [library('web-smoke-checks', ['task:e2e-testing', 'web']), e2e], kinds: ['web'] });
  assert.deepEqual([libraryFirst.skills.map((skill) => skill.id), libraryFirst.offers], [['web-smoke-checks'], []]);
  const inLibrary = await plan('fix', { candidates: [library('web-e2e-test-generation', ['task:e2e-testing', 'web']), e2e], kinds: ['web'] });
  assert.deepEqual([inLibrary.skills.map((skill) => skill.id), inLibrary.offers], [['web-e2e-test-generation'], []]);
  // A marketplace skill with no lifecycle mark, or a proposed one, is new and not yet approved; a retired one is never offered.
  const proposed = market('web-xray-creation', ['web', 'xray', 'beta'], ['test-case-creation'], 'proposed');
  const feature = await plan('feature', { candidates: [proposed, market('web-legacy', ['web'], ['e2e-testing'], 'deprecated')], kinds: ['web'] });
  assert.match(feature.plan, /requirements \(with web-xray-creation from acme, proposed and new here: add it\?\) → plan → code → tests/u);
  assert.equal(planSkillWords([{ id: 'a', status: 'used' }, { id: 'b', status: 'used' }, { id: 'c', status: 'yes', state: 'beta' }]), ' (with a and b; with c, beta: use it?)');
  assert.equal(planLine(composeTask(base(), { kind: 'fix' }), { skills: { intake: [{ id: 'framing', status: 'used' }] }, skillWords: planSkillWords }),
    'Plan: intake (with framing) → code → tests. Say "add a design step" to change it.');
});

test('ITW REQ-010: a skill the person names is used where it fits, and one that fits no step or does not exist is refused with its way on', () => {
  const composition = composeTask(base(), { kind: 'fix' });
  const backend = library('api-contract-checks', ['task:contract-testing', 'backend']);
  assert.deepEqual(chooseTaskSkills(composition, { candidates: [backend], kinds: ['web'], use: ['api-contract-checks'] }).skills.map((skill) => skill.id), ['api-contract-checks'],
    'named by the person, it is used even for another kind');
  assert.throws(() => chooseTaskSkills(composition, { candidates: [backend], use: ['nowhere'] }),
    (error) => error.code === 'TASK_SKILL_UNKNOWN' && error.details.nextAction.command === 'singularity-flow skill list');
  assert.throws(() => chooseTaskSkills(composeTask(base(), { kind: 'investigate' }), { candidates: [backend], use: ['api-contract-checks'] }),
    (error) => error.code === 'TASK_SKILL_NO_STEP' && /is for code step/u.test(error.message) && Boolean(error.details.nextAction.command));
  // A team rule's configured workflow is used as it is: its own attachments apply, a task chooses none.
  const used = Object.assign(base(), { tasks: { use: { fix: 'chore' } } });
  assert.deepEqual(chooseTaskSkills(composeTask(used, { kind: 'fix' }), { candidates: [backend], kinds: ['backend'] }), { skills: [], offers: [], byStep: {} });
});

test('ITW REQ-010: seeded libraries, marketplaces, kinds and words choose the same skills twice, each one fitting its step', () => {
  const TASKS = ['e2e-testing', 'unit-testing', 'api-implementation', 'test-case-creation', 'requirements-analysis', 'security-review', 'static-analysis', 'architecture-design'];
  const TAGS = ['web', 'backend', 'mobile', 'android', 'playwright', 'xray', 'checkout', 'beta', 'ga', 'deprecated'];
  const WORDS = ['fix', 'the', 'checkout', 'playwright', 'login', 'xray', 'export'];
  for (let seed = 1; seed <= 80; seed += 1) {
    const random = seeded(20261125 + seed);
    const some = (list, p) => list.filter(() => random.chance(p));
    const candidates = Array.from({ length: random.int(0, 6) }, (_, index) => {
      const tags = some(TAGS, 0.25);
      return random.chance(0.6) ? library(`lib-${index}`, [...some(TASKS, 0.2).map((task) => `task:${task}`), ...tags])
        : market(`mk-${index % 3}`, tags, some(TASKS, 0.25), random.pick(['approved', 'proposed', null, 'deprecated']));
    });
    const kinds = some(['web', 'backend', 'mobile'], 0.4);
    const words = some(WORDS, 0.4).join(' ');
    const kind = random.pick(TASK_KINDS);
    const use = random.chance(0.15) && candidates.length ? [random.pick(candidates).id] : [];
    const where = `seed ${20261125 + seed}: ${JSON.stringify({ kind, kinds, words, use, candidates: candidates.map(({ id, source, intents, kinds: k, lifecycle }) => ({ id, source, intents, kinds: k, lifecycle })) })}`;
    const composition = composeTask(base(), { kind });
    let chosen;
    try { chosen = chooseTaskSkills(composition, { candidates, kinds, words, use }); } catch (error) {
      assert.match(error.code, /^TASK_SKILL_/u, where);
      assert.ok(error.details?.nextAction?.command, `${where}: a refusal names its way on`);
      continue;
    }
    assert.deepEqual(chooseTaskSkills(composition, { candidates, kinds, words, use }), chosen, `${where}: the same skills twice`);
    const byId = new Map(candidates.map((candidate) => [`${candidate.source}:${candidate.id}`, candidate]));
    for (const [stepId, entries] of Object.entries(chosen.byStep)) {
      const step = composition.steps.find((item) => item.id === stepId);
      assert.ok(entries.length <= TASK_SKILL_LIMIT + use.length, where);
      assert.ok(new Set(entries.map((entry) => entry.marketplace ? 'marketplace' : 'library')).size === 1, `${where}: the library first, never mixed with a marketplace on a step`);
      for (const entry of entries) {
        const candidate = byId.get(`${entry.marketplace ? 'marketplace' : 'library'}:${entry.id}`);
        assert.ok(candidate.intents.includes(step.intent), `${where}: ${entry.id} fits ${stepId}`);
        assert.notEqual(candidate.lifecycle, 'retired', where);
        if (!use.includes(entry.id) && candidate.kinds.length) assert.ok(candidate.kinds.some((value) => kinds.includes(value)), `${where}: ${entry.id} is for this kind of software`);
        if (entry.status === 'used') assert.ok(candidate.source === 'library' && (candidate.lifecycle === 'ready' || use.includes(entry.id)), where);
      }
    }
    for (const skill of chosen.skills) assert.ok(!chosen.offers.some((offer) => offer.id === skill.id), `${where}: a skill is used or offered, not both`);
  }
});

/** The fixture marketplace as a Git repository of its own, read at the commit it is trusted at. */
async function marketplaceRepository(t) {
  const directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-task-market-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'acme');
  await cp(FIXTURE, repository, { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Market Maintainer', '-c', 'user.email=maintainers@example.com', ...args], { cwd: repository, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'The marketplace');
  return { repository, commit: git('rev-parse', 'HEAD') };
}

const WEB_PACKAGE = JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' }, dependencies: { react: '^18.3.1' } });
const SMOKE_SKILL = [
  '---', 'name: web-smoke-checks', 'description: Check each changed web page in a browser before the code step is handed in.', 'metadata:',
  '  sflow-tags: [task:e2e-testing, web, playwright]', '---', '', '1. Open each page the change touches and check it renders.', '2. Name what you checked.', ''
].join('\n');

const json = (text) => { const value = JSON.parse(text); return value.data ?? value; };
function refused(story, args) {
  const result = story.raw([...args, '--json']);
  assert.notEqual(result.status, 0, `${args.join(' ')} should be refused:\n${result.stdout}`);
  const text = `${result.stdout}`;
  const body = JSON.parse(text.slice(text.search(/^\s*\{/mu)));
  return body.error ?? body;
}

test('ITW REQ-010, A9: a library skill chosen for a step is frozen into the Story\'s snapshot with its exact text', async (t) => {
  const story = await journeyRepository(t, { files: { 'package.json': WEB_PACKAGE, 'singularity/skill-library/web-smoke-checks/SKILL.md': SMOKE_SKILL } });
  const shown = json(story.cli('work', 'fix the login button', '--json'));
  assert.match(shown.plan, /^Plan: code \(with web-smoke-checks\) → tests\./u);
  assert.deepEqual(shown.skills.map(({ id, steps }) => [id, steps]), [['web-smoke-checks', ['implementation']]]);
  assert.equal(shown.offers, undefined);
  assert.equal(story.git('status', '--porcelain'), '', 'showing the plan writes nothing');
  const started = json(story.cli('work', 'fix the login button', '--start', '--json'));
  assert.deepEqual(started.task.skills, [{ id: 'web-smoke-checks', steps: ['implementation'] }]);
  story.item = 'singularity/work-items/TASK-1';
  const record = storyRecord(story);
  assert.deepEqual(record.resolution.composition.skills.map(({ id, steps }) => [id, steps]), [['web-smoke-checks', ['implementation']]]);
  const [frozen] = record.resolution.workflowSkills;
  assert.deepEqual([frozen.id, frozen.phases, frozen.logicalId], ['web-smoke-checks', ['implementation'], 'workflow:task-fix:skill:web-smoke-checks']);
  const manifest = JSON.parse(await readFile(path.join(story.root, record.workflowSnapshot.manifestPath), 'utf8'));
  const asset = manifest.assets.find((entry) => entry.logicalId === 'workflow:task-fix:skill:web-smoke-checks');
  assert.equal(asset?.purpose, 'workflow-skill');
  assert.equal(await readFile(path.join(story.root, asset.blob.path), 'utf8'), SMOKE_SKILL, 'the exact text the Story uses');
  assert.equal(manifest.semantics.promptComposer, 'story-snapshot-agent-v2');
  // The code step's prompt carries that text, even after the library's copy changes.
  assert.equal(story.git('rev-parse', '--abbrev-ref', 'HEAD'), 'TASK-1');
  await story.write('singularity/skill-library/web-smoke-checks/SKILL.md', SMOKE_SKILL.replace('Open each page', 'LIVE TEXT: open each page'));
  const [{ loadConfig }, { resolveStoryExecutionContext }, { renderAgentSkills }] = await Promise.all([
    import('../src/state.mjs'), import('../src/story-execution-context.mjs'), import('../src/agents.mjs')]);
  const config = await loadConfig(story.root);
  const context = await resolveStoryExecutionContext(story.root, config, record, { agentId: record.phases.implementation.defaultAgent, phaseId: 'implementation' });
  const rendered = await renderAgentSkills(story.root, record, record.phases.implementation, { agent: record.phases.implementation.defaultAgent }, { executionContext: context });
  assert.match(rendered.text, /1\. Open each page the change touches and check it renders\./u);
  assert.doesNotMatch(rendered.text, /LIVE TEXT/u);
  const intake = await renderAgentSkills(story.root, record, record.phases.intake, { agent: record.phases.intake.defaultAgent },
    { executionContext: await resolveStoryExecutionContext(story.root, config, record, { agentId: record.phases.intake.defaultAgent, phaseId: 'intake' }) });
  assert.doesNotMatch(intake.text, /web-smoke-checks/u, 'only the step it was chosen for');
  // A later command reads the Story with its skills as it reads any Story.
  assert.equal(json(story.cli('work', 'status', 'TASK-1', '--json')).kind, 'fix');
});

test('ITW REQ-010: a skill the plan read but the Story\'s base does not have is refused before anything is written, with a start without it', async (t) => {
  const story = await journeyRepository(t, { files: { 'package.json': WEB_PACKAGE } });
  await story.write('singularity/skill-library/web-smoke-checks/SKILL.md', SMOKE_SKILL);
  story.git('add', '-A');
  story.git('commit', '-qm', 'A skill committed here and not pushed');
  const changed = refused(story, ['work', 'fix the login button', '--start']);
  assert.equal(changed.code, 'TASK_SKILL_CHANGED');
  assert.match(changed.message, /not in the skill library the Story starts from/u);
  assert.equal(changed.details.nextAction, 'singularity-flow work "fix the login button" --kind fix --start --without-skill web-smoke-checks');
  assert.equal(story.git('branch', '--list', 'TASK-1'), '', 'no Story branch is left behind');
  const started = json(story.cli('work', 'fix the login button', '--kind', 'fix', '--start', '--without-skill', 'web-smoke-checks', '--json'));
  assert.equal(started.task.skills, undefined);
});

test('ITW A6, A7: a trusted marketplace\'s skill is offered new here; one yes with its text imports it, and the next task uses it without asking', async (t) => {
  const acme = await marketplaceRepository(t);
  const story = await journeyRepository(t, {
    files: { 'package.json': WEB_PACKAGE },
    configure: (configuration) => { configuration.marketplaces = { acme: { label: 'Acme', repository: acme.repository, commit: acme.commit } }; }
  });
  const shown = json(story.cli('work', 'fix the checkout button', '--kind', 'fix', '--json'));
  assert.equal(shown.plan, 'Plan: code (with web-e2e-test-generation from acme, new here: add it?) → tests. You approve the plan in the intake and the code. Say "add a design step" to change it.');
  const [offer] = shown.offers;
  assert.deepEqual([offer.id, offer.new, offer.marketplace, offer.steps], ['web-e2e-test-generation', true, 'acme', ['implementation']]);
  assert.equal(offer.show, 'singularity-flow import preview "market:acme/web-e2e-test-generation" --as skill --json');
  assert.deepEqual(json(story.cli('work', 'fix the checkout button', '--kind', 'fix', '--json')), shown, 'the same words and repository, the same plan');
  // Starting asks first: the Story's snapshot freezes what the person chose.
  const asked = refused(story, ['work', 'fix the checkout button', '--kind', 'fix', '--start']);
  assert.equal(asked.code, 'TASK_SKILL_YES_NEEDED');
  assert.equal(asked.details.nextAction, offer.show);
  assert.equal(asked.details.start, 'singularity-flow work "fix the checkout button" --kind fix --start');
  assert.match(asked.details.offers[0].ask, /^Add web-e2e-test-generation from acme to this repository's skills and use it for the code step\?$/u);
  // The yes: its exact text, read at the commit the repository trusts, then the import as any import is added.
  const preview = JSON.parse(story.cli('import', 'preview', 'market:acme/web-e2e-test-generation', '--as', 'skill', '--json'));
  assert.equal(preview.text, await readFile(path.join(FIXTURE, 'skills/web-e2e-test-generation/SKILL.md'), 'utf8'));
  assert.equal(preview.source.kind, 'marketplace-skill');
  assert.equal(preview.source.commit, acme.commit);
  assert.doesNotMatch(preview.addCommand, /--agent/u, 'a skill with no agent goes to the skill library');
  story.must('sh', ['-c', preview.addCommand.replace(/^singularity-flow /u, `"${process.execPath}" "${path.join(ROOT, 'bin/singularity-flow.mjs')}" `)]);
  const lock = YAML.parse(await story.read('singularity/imports.lock.yml'));
  assert.deepEqual(lock.imports['library-skill:web-e2e-test-generation'].source.tasks, ['e2e-testing', 'ui-test-automation']);
  story.git('add', 'singularity');
  story.git('commit', '-qm', 'Add the web end-to-end test skill');
  story.git('push', '-q', 'origin', 'main');
  const started = json(story.cli('work', 'fix the checkout button', '--kind', 'fix', '--start', '--use-skill', 'web-e2e-test-generation', '--json'));
  assert.deepEqual(started.task.skills, [{ id: 'web-e2e-test-generation', steps: ['implementation'] }]);
  story.item = 'singularity/work-items/TASK-1';
  assert.deepEqual(storyRecord(story).resolution.workflowSkills.map((entry) => entry.id), ['web-e2e-test-generation']);
  // The next task finds it in the library and asks nothing.
  story.git('checkout', '-q', 'main');
  const next = json(story.cli('work', 'fix the cart total', '--kind', 'fix', '--json'));
  assert.match(next.plan, /^Plan: code \(with web-e2e-test-generation\) → tests\./u);
  assert.equal(next.offers, undefined);
  // A proposed or beta marketplace skill is marked so in the plan: a feature's requirements step offers web-xray-creation.
  const feature = json(story.cli('work', 'add a gift card option to checkout', '--kind', 'feature', '--json'));
  assert.deepEqual(feature.offers.map(({ id, state, steps }) => [id, state, steps]), [['web-xray-creation', 'proposed', ['requirements']]]);
  assert.match(feature.plan, /requirements \(with web-xray-creation from acme, proposed and new here: add it\?\)/u);
  // No: the task starts without it.
  const declined = json(story.cli('work', 'add a gift card option to checkout', '--kind', 'feature', '--start', '--new', '--without-skill', 'web-xray-creation', '--json'));
  assert.equal(declined.id, 'TASK-2');
  assert.deepEqual(declined.task.skills, [{ id: 'web-e2e-test-generation', steps: ['implementation'] }]);
  // A marketplace the repository does not trust is never read.
  const untrusted = refused(story, ['import', 'preview', 'market:elsewhere/web-e2e-test-generation', '--as', 'skill']);
  assert.match(untrusted.code ?? '', /MARKETPLACE_UNKNOWN/u);
});

test('ITW REQ-010: imports check re-checks a skill imported from a Git-repository marketplace: still the same, newer, its trust moved, gone', async (t) => {
  const acme = await marketplaceRepository(t);
  const story = await journeyRepository(t, {
    files: { 'package.json': WEB_PACKAGE },
    configure: (configuration) => { configuration.marketplaces = { acme: { label: 'Acme', repository: acme.repository, commit: acme.commit } }; }
  });
  const marketGit = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Market Maintainer', '-c', 'user.email=maintainers@example.com', ...args], { cwd: acme.repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const KEY = 'library-skill:web-e2e-test-generation';
  const checked = () => JSON.parse(story.cli('imports', 'check', '--json')).imports.find((row) => row.key === KEY);
  const run = (command) => story.must('sh', ['-c', command.replace(/^singularity-flow /u, `"${process.execPath}" "${path.join(ROOT, 'bin/singularity-flow.mjs')}" `)]);
  const preview = JSON.parse(story.cli('import', 'preview', 'market:acme/web-e2e-test-generation', '--as', 'skill', '--json'));
  run(preview.addCommand);
  story.git('add', 'singularity');
  story.git('commit', '-qm', 'Add the web end-to-end test skill');

  // Before: the commit the repository trusts is the marketplace's newest, and it still gives the same text.
  let row = checked();
  assert.deepEqual([row.status, row.words, row.updateCommand], ['up to date', 'nothing newer in the marketplace', undefined]);

  // The marketplace moves on: version 1.1.0 at its newest commit. Trusting that commit is the update's first step.
  const skillFile = path.join(acme.repository, 'skills/web-e2e-test-generation/SKILL.md');
  const manifestFile = path.join(acme.repository, 'skills/web-e2e-test-generation/apm.yml');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(skillFile, `${await readFile(skillFile, 'utf8')}\nRun every new test twice before handing it in.\n`);
  await writeFile(manifestFile, (await readFile(manifestFile, 'utf8')).replace('version: 1.0.0-pdlc', 'version: 1.1.0'));
  marketGit('commit', '-qam', 'web e2e: run new tests twice');
  const newer = marketGit('rev-parse', 'HEAD');
  row = checked();
  assert.equal(row.status, 'newer version available');
  assert.equal(row.updateCommand, `singularity-flow marketplace add acme --repo ${JSON.stringify(acme.repository)}`);
  assert.match(row.words, /^version 1\.1\.0 \(imported 1\.0\.0-pdlc\) at the marketplace's newest commit: trust that commit first/u);
  assert.doesNotMatch(row.words, /[0-9a-f]{12}/u, 'no commit for a person to read');
  assert.match(row.detail, new RegExp(newer.slice(0, 12), 'u'), 'the terminal names the commit');

  // Once the repository trusts the newer commit, its text is staged and imported again with one reviewed import.
  const configuration = YAML.parse(await story.read('singularity/workflow.yml'));
  configuration.marketplaces.acme.commit = newer;
  await story.write('singularity/workflow.yml', YAML.stringify(configuration));
  story.git('commit', '-qam', 'Trust the newest commit of acme');
  row = checked();
  assert.equal(row.status, 'newer version available');
  assert.equal(row.words, 'version 1.1.0 (imported 1.0.0-pdlc) at the commit this repository trusts');
  assert.match(row.updateCommand, /^singularity-flow import add "market:acme\/web-e2e-test-generation" --as skill --id web-e2e-test-generation --sha256 [0-9a-f]{64} --replace$/u);
  run(row.updateCommand);
  assert.match(await story.read('singularity/skill-library/web-e2e-test-generation/SKILL.md'), /Run every new test twice before handing it in\./u);
  const lock = YAML.parse(await story.read('singularity/imports.lock.yml'));
  assert.deepEqual([lock.imports[KEY].source.version, lock.imports[KEY].source.commit], ['1.1.0', newer]);
  story.git('commit', '-qam', 'Update the web end-to-end test skill');
  assert.equal(checked().status, 'up to date');

  // The marketplace drops the skill: the copy here stays until a person removes it.
  const rootManifest = path.join(acme.repository, 'apm.yml');
  const listed = YAML.parseDocument(await readFile(rootManifest, 'utf8'));
  listed.setIn(['marketplace', 'packages'], listed.getIn(['marketplace', 'packages']).items.filter((item) => item.get('name') !== 'web-e2e-test-generation'));
  await writeFile(rootManifest, listed.toString());
  marketGit('commit', '-qam', 'Retire web e2e generation');
  row = checked();
  assert.equal(row.status, 'removed at its source');
  assert.match(row.words, /newest commit no longer has web-e2e-test-generation; the commit this repository trusts still does, and the copy here stays until a person removes it/u);
  assert.equal(row.updateCommand, undefined);

  // A marketplace the repository no longer trusts is never read.
  delete configuration.marketplaces;
  await story.write('singularity/workflow.yml', YAML.stringify(configuration));
  row = checked();
  assert.deepEqual([row.status, row.words], ['unavailable', 'marketplace acme is no longer trusted here as a Git repository']);
});

/** An HTTPS index marketplace served from files: `https://<host>/<path>` is read from `<directory>/<host>/<path>`. */
async function indexMarketplace(t, entries) {
  const { createHash } = await import('node:crypto');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-task-index-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = {};
  const index = { format: 'sflow-marketplace@1', name: 'Team catalog', entries: entries.map(({ text, ...entry }) => {
    const file = `/skills/${entry.id}.md`;
    files[`cdn.example.org${file}`] = text;
    return { kind: 'skill', version: '1.0.0', url: `https://cdn.example.org${file}`, sha256: createHash('sha256').update(text).digest('hex'), ...entry };
  }) };
  files['catalog.example.org/sflow-marketplace.json'] = JSON.stringify(index);
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
    await writeFile(path.join(directory, relative), text);
  }
  return { directory, index: 'https://catalog.example.org/sflow-marketplace.json', indexFile: path.join(directory, 'catalog.example.org/sflow-marketplace.json') };
}

const WEB_CHECKS = ['---', 'name: web-checks', 'description: Check each changed page in a browser.', '---', '', 'Open each page the change touches.', ''].join('\n');
const VISUAL_DIFF = ['---', 'name: visual-diff', 'description: Compare screenshots before and after.', '---', '', 'Take a screenshot of each page.', ''].join('\n');

test('ITW REQ-010, A6, A7: a trusted HTTPS index marketplace\'s skills are offered like a repository\'s, read once an hour, and an import is found the next time', async (t) => {
  const catalog = await indexMarketplace(t, [
    { id: 'web-checks', label: 'Web checks', tags: ['web', 'playwright', 'ga'], phases: ['implementation'], text: WEB_CHECKS },
    { id: 'visual-diff', label: 'Visual diff', tags: ['web', 'beta'], phases: ['requirements'], text: VISUAL_DIFF }]);
  const story = await journeyRepository(t, {
    files: { 'package.json': WEB_PACKAGE },
    env: { SINGULARITY_FLOW_TEST_REMOTE_FIXTURES: catalog.directory },
    configure: (configuration) => { configuration.marketplaces = { team: { label: 'Team catalog', index: catalog.index, allowedOrigins: ['https://cdn.example.org'] } }; }
  });
  const shown = json(story.cli('work', 'fix the checkout button', '--kind', 'fix', '--json'));
  assert.equal(shown.plan, 'Plan: code (with web-checks from team, new here: add it?) → tests. You approve the plan in the intake and the code. Say "add a design step" to change it.');
  const [offer] = shown.offers;
  assert.deepEqual([offer.id, offer.new, offer.marketplace, offer.state, offer.steps], ['web-checks', true, 'team', null, ['implementation']]);
  assert.equal(offer.show, 'singularity-flow import preview "market:team/web-checks" --as skill --json');
  assert.equal(story.git('status', '--porcelain'), '', 'showing the plan writes nothing in the checkout');
  // The listing is kept in the clone's Git folder: the next plan within the hour does not fetch the index again.
  const { rename } = await import('node:fs/promises');
  await rename(catalog.indexFile, `${catalog.indexFile}.away`);
  assert.deepEqual(json(story.cli('work', 'fix the checkout button', '--kind', 'fix', '--json')), shown, 'the same plan, from the kept listing');
  await rename(`${catalog.indexFile}.away`, catalog.indexFile);
  // A7: a beta skill is marked so; starting asks first.
  const feature = json(story.cli('work', 'add a gift card option to checkout', '--kind', 'feature', '--json'));
  assert.deepEqual(feature.offers.map(({ id, state, steps }) => [id, state, steps]), [['visual-diff', 'beta', ['requirements']], ['web-checks', null, ['implementation']]]);
  assert.equal(refused(story, ['work', 'fix the checkout button', '--kind', 'fix', '--start']).code, 'TASK_SKILL_YES_NEEDED');
  // The yes: its exact text, then the import; what the index said it is for is kept with it, so the next task uses it.
  const preview = JSON.parse(story.cli('import', 'preview', 'market:team/web-checks', '--as', 'skill', '--json'));
  assert.equal(preview.text, WEB_CHECKS);
  story.must('sh', ['-c', preview.addCommand.replace(/^singularity-flow /u, `"${process.execPath}" "${path.join(ROOT, 'bin/singularity-flow.mjs')}" `)]);
  const lock = YAML.parse(await story.read('singularity/imports.lock.yml'));
  assert.deepEqual([lock.imports['library-skill:web-checks'].source.tags, lock.imports['library-skill:web-checks'].source.phases], [['web', 'playwright', 'ga'], ['implementation']]);
  story.git('add', 'singularity');
  story.git('commit', '-qm', 'Add the web checks skill');
  const next = json(story.cli('work', 'fix the cart total', '--kind', 'fix', '--json'));
  assert.match(next.plan, /^Plan: code \(with web-checks\) → tests\./u);
  assert.equal(next.offers, undefined);
});

test('ITW REQ-010: an index marketplace\'s listing is read again after an hour, or when the catalog asks for it now', async (t) => {
  const { trustedIndexMarketplaceSkills, INDEX_LISTING_FRESH_MS, taskSkillChooser } = await import('../src/task-skills.mjs');
  const { normalizeMarketplaces } = await import('../src/marketplace.mjs');
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-task-index-cache-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const INDEX = 'https://catalog.example.org/sflow-marketplace.json';
  const team = normalizeMarketplaces({ team: { index: INDEX, allowedOrigins: ['https://cdn.example.org'] } }).team;
  let reads = 0;
  let entries = [{ id: 'web-checks', kind: 'skill', version: '1.0.0', label: 'Web checks', url: 'https://cdn.example.org/a.md', sha256: 'a'.repeat(64), tags: ['web'], phases: ['implementation'] }];
  const fetchImpl = async (url) => {
    reads += 1;
    assert.equal(url, INDEX, 'only the trusted index is read');
    const bytes = Buffer.from(JSON.stringify({ format: 'sflow-marketplace@1', entries }));
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => bytes };
  };
  const now = Date.parse('2026-11-25T10:00:00Z');
  const first = await trustedIndexMarketplaceSkills(root, team, { fetchImpl, now });
  assert.deepEqual(first.map(({ name, version, phases }) => [name, version, phases]), [['web-checks', '1.0.0', ['implementation']]]);
  entries = [...entries, { ...entries[0], version: '1.2.0', sha256: 'b'.repeat(64) }];
  assert.deepEqual(await trustedIndexMarketplaceSkills(root, team, { fetchImpl, now: now + INDEX_LISTING_FRESH_MS - 1 }), first, 'kept for an hour');
  assert.equal(reads, 1);
  assert.equal((await trustedIndexMarketplaceSkills(root, team, { fetchImpl, now: now + INDEX_LISTING_FRESH_MS }))[0].version, '1.2.0', 'the newest version, read again');
  assert.equal(reads, 2);
  await trustedIndexMarketplaceSkills(root, team, { fetchImpl, now: now + INDEX_LISTING_FRESH_MS + 1, fresh: true });
  assert.equal(reads, 3, 'the catalog reads it now');
  // Another index, or the same index with other allowed origins, is another listing.
  const wider = normalizeMarketplaces({ team: { index: INDEX, allowedOrigins: ['https://cdn.example.org', 'https://files.example.org'] } }).team;
  await trustedIndexMarketplaceSkills(root, wider, { fetchImpl, now: now + INDEX_LISTING_FRESH_MS + 2 });
  assert.equal(reads, 4);
  // The chooser reads an index the definition trusts, through the listing kept now, and no other.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(root, 'package.json'), WEB_PACKAGE);
  for (const args of [['add', 'package.json'], ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', 'commit', '-qm', 'web']]) {
    assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  }
  await trustedIndexMarketplaceSkills(root, team, { fetchImpl, fresh: true });
  const definition = { ...base(), marketplaces: { team } };
  const chosen = await taskSkillChooser(root, definition, { fetchImpl: async () => { throw new Error('an index is read only past its hour'); } })(composeTask(definition, { kind: 'fix' }));
  assert.deepEqual(chosen.offers.map(({ id, marketplace, steps }) => [id, marketplace, steps]), [['web-checks', 'team', ['implementation']]]);
  assert.deepEqual(chosen.notes, []);
});

test('ITW A7: a marketplace only a working-copy edit of workflow.yml trusts is not trusted yet: no task offers its skills and no preview reads it', async (t) => {
  const catalog = await indexMarketplace(t, [{ id: 'web-checks', label: 'Web checks', tags: ['web', 'ga'], phases: ['implementation'], text: WEB_CHECKS }]);
  const story = await journeyRepository(t, { files: { 'package.json': WEB_PACKAGE }, env: { SINGULARITY_FLOW_TEST_REMOTE_FIXTURES: catalog.directory } });
  // The approved configuration, sflow/config on the remote (and its tracking ref here), trusts no marketplace.
  story.git('push', '-q', 'origin', 'main:sflow/config');
  story.git('fetch', '-q', 'origin');
  const configuration = YAML.parse(await story.read('singularity/workflow.yml'));
  configuration.marketplaces = { team: { label: 'Team catalog', index: catalog.index, allowedOrigins: ['https://cdn.example.org'] } };
  await story.write('singularity/workflow.yml', YAML.stringify(configuration));
  const shown = json(story.cli('work', 'fix the checkout button', '--kind', 'fix', '--json'));
  assert.equal(shown.offers, undefined);
  assert.deepEqual(shown.notes, ['Marketplace team is trusted only in your working copy of workflow.yml, and that is not approved yet, so its skills are not offered.']);
  const preview = refused(story, ['import', 'preview', 'market:team/web-checks', '--as', 'skill']);
  assert.equal(preview.code, 'MARKETPLACE_UNKNOWN');
  assert.equal(preview.details.nextAction, 'singularity-flow marketplace list');
  // Once approved, the same marketplace is offered.
  story.git('commit', '-qam', 'Trust the team catalog');
  story.git('push', '-q', 'origin', 'main:sflow/config');
  assert.deepEqual(json(story.cli('work', 'fix the checkout button', '--kind', 'fix', '--json')).offers.map((offer) => offer.id), ['web-checks']);
});
