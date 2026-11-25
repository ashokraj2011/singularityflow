/**
 * A skill SFlow ships that is there but does not parse [owner, 2026-11-26]: a configuration refresh keeps it, because it
 * may be an edit, so its way out was to write it again. `skill restore <ID>` writes the packaged text back through the
 * reviewed configuration path (a Studio change set, a proposal with an approved configuration), and asks first when the
 * text there is an edit: one SFlow never shipped is replaced only with --discard-edits, the person's yes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { librarySkillPath } from '../src/skill-library.mjs';
import { assertStoryLibrarySkills, configurationSkillProblems, librarySkillRepairs, packagedSkillState } from '../src/skill-library-problems.mjs';
import { planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA } from '../src/workflow-studio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin/singularity-flow.mjs');
// demo-code-checker's skill in the seeded demo-check-repair-close workflow: protected, so restoring it must not be a customization.
const SKILL = 'demo-code-acceptance-check';
const WORKFLOW = 'demo-check-repair-close';
const BROKEN = 'This is not a skill: its front matter was lost.\n';
const shipped = () => readFile(path.join(ROOT, 'templates/skill-library', SKILL, 'SKILL.md'), 'utf8');
const restore = (root, change = {}, options = {}) => planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [{ op: 'skill.restore', id: SKILL, ...change }] }, options);

async function initialized(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skill-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  return root;
}

test('a packaged skill that does not parse is offered restore; an edit is replaced only with the person\'s yes, through the reviewed change', async (t) => {
  const root = await initialized(t);
  const file = path.join(root, librarySkillPath(SKILL));
  await writeFile(file, BROKEN);
  // Listed where it is used, with restore as its way out (a proposal with an approved configuration).
  const definition = await loadDefinition(root);
  const problem = (await configurationSkillProblems(root, definition)).find((entry) => entry.skillId === SKILL);
  assert.equal(problem.reason, 'unreadable');
  assert.deepEqual(librarySkillRepairs(problem).map((entry) => entry.command), [`singularity-flow skill restore ${SKILL}`, `singularity-flow skill detach ${SKILL} --agent demo-code-checker`]);
  assert.equal(librarySkillRepairs(problem, { approved: true })[0].command, `singularity-flow skill restore ${SKILL} --propose`);
  await assert.rejects(() => assertStoryLibrarySkills(definition, WORKFLOW, resolveWorkType(definition, WORKFLOW), { root }),
    (error) => error.code === 'SKILL_LIBRARY_MISSING' && error.details.nextAction.command === `singularity-flow skill restore ${SKILL}`);
  // The text there is none SFlow shipped: an edit, refused with the command that says yes.
  assert.deepEqual((({ same, edited }) => ({ same, edited }))(await packagedSkillState(root, SKILL)), { same: false, edited: true });
  const refused = await restore(root);
  assert.equal(refused.valid, false);
  assert.equal(refused.problems[0].code, 'STUDIO_SKILL_RESTORE_EDITED');
  assert.match(refused.problems[0].message, new RegExp(`To replace it, run singularity-flow skill restore ${SKILL} --discard-edits\\.$`, 'u'));
  assert.equal(await readFile(file, 'utf8'), BROKEN, 'nothing changed');
  // Yes: the packaged bytes, exactly, and the seeded workflow's protection accepts them; a Story of it starts again.
  const previewed = await restore(root, { discardEdits: true });
  assert.equal(previewed.valid, true, JSON.stringify(previewed.problems));
  assert.deepEqual(previewed.files.map((entry) => entry.path), [librarySkillPath(SKILL)]);
  assert.match(previewed.summary.join('\n'), /restored as SFlow ships it, replacing the text edited here\./u);
  assert.equal(await readFile(file, 'utf8'), BROKEN, 'a plan alone writes nothing');
  assert.equal((await restore(root, { discardEdits: true }, { write: true })).valid, true);
  assert.equal(await readFile(file, 'utf8'), await shipped());
  const repaired = await loadDefinition(root);
  assert.deepEqual((await configurationSkillProblems(root, repaired)).filter((entry) => entry.skillId === SKILL), []);
  await assertStoryLibrarySkills(repaired, WORKFLOW, resolveWorkType(repaired, WORKFLOW), { root });
  // Already as shipped: nothing to restore. A skill SFlow does not ship: nothing to restore either.
  assert.equal((await restore(root)).problems[0].code, 'STUDIO_SKILL_ALREADY_PACKAGED');
  const unknown = await planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [{ op: 'skill.restore', id: 'team-house-style' }] });
  assert.deepEqual([unknown.valid, unknown.problems[0].code], [false, 'STUDIO_SKILL_NOT_PACKAGED']);
  assert.match(unknown.problems[0].message, /singularity-flow skill list\.$/u);
  // Not an edit: the shipped text with Windows line endings, or no file at all, is restored with no yes asked.
  await writeFile(file, (await shipped()).replace(/\n/gu, '\r\n'));
  assert.equal((await packagedSkillState(root, SKILL)).edited, false);
  assert.match((await restore(root)).summary.join('\n'), /restored as SFlow ships it, replacing an earlier packaged text\./u);
  await rm(file);
  const missing = await restore(root);
  assert.deepEqual([missing.valid, missing.files.map((entry) => [entry.path, entry.before ?? null, entry.action ?? null])], [true, [[librarySkillPath(SKILL), null, 'create']]]);
});

test('real CLI: skill restore refuses an edit with the person\'s own command and --discard-edits, and with it writes the packaged skill', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skill-restore-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Skill Restore Test' };
  const run = (command, args, { allowFailure = false } = {}) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const cli = (args, options) => run(process.execPath, [BIN, ...args], options);
  run('git', ['init', '-q', '-b', 'main']);
  run('git', ['config', 'user.name', 'Skill Restore Test']);
  run('git', ['config', 'user.email', 'restore@example.invalid']);
  await writeFile(path.join(root, 'README.md'), '# Restore\n');
  cli(['init']);
  const file = path.join(root, librarySkillPath(SKILL));
  await writeFile(file, BROKEN);
  run('git', ['add', '-A']);
  run('git', ['commit', '-q', '-m', 'Initialize, with one packaged skill broken']);

  const refused = cli(['skill', 'restore', SKILL, '--dry-run', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0, refused.stdout);
  const said = `${refused.stdout}${refused.stderr}`;
  assert.match(said, /SKILL_RESTORE_EDITED/u);
  assert.match(said, /it was edited in this repository \(2 lines\), and restoring replaces that edit with SFlow's packaged text\. Nothing was changed\./u);
  assert.ok(said.includes(`singularity-flow skill restore ${SKILL} --discard-edits --dry-run --json`), said);
  const preview = JSON.parse(cli(['skill', 'restore', SKILL, '--discard-edits', '--dry-run', '--json']).stdout);
  assert.deepEqual([preview.valid, preview.files.map((entry) => entry.path)], [true, [librarySkillPath(SKILL)]]);
  assert.equal(await readFile(file, 'utf8'), BROKEN, 'a dry run writes nothing');
  cli(['skill', 'restore', SKILL, '--discard-edits']);
  assert.equal(await readFile(file, 'utf8'), await shipped());
  assert.match(cli(['skill', 'restore', SKILL], { allowFailure: true }).stdout + cli(['skill', 'restore', SKILL], { allowFailure: true }).stderr, /already as SFlow ships it/u);
  for (const args of [['skill', 'restore'], ['skill', 'restore', SKILL, '--discard-edits=yes'], ['skill', 'restore', SKILL, '--agent', 'qa']]) {
    assert.notEqual(cli(args, { allowFailure: true }).status, 0, args.join(' '));
  }
});
