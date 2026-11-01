/**
 * SF Guard part 2, G2 [SPEC-SFG-v1 §4, §6, AC-005 to AC-007]: the declared set, reconciliation of
 * the change set with this machine's records, the stamping hooks written into declared agents'
 * files, and agent-written records that are no longer credited to a person.
 *
 * Payloads are the shapes the G0 probe saw. Allow but label: no class ever changes a hook's answer.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordRepositoryBoundaryTurn, repositoryPostToolGuard, repositoryToolGuard, endRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { readObservedWrites, recordObservedWrite } from '../src/comprehension/xpl2/observed-writes.mjs';
import {
  isSfGuardStamp, readSfGuardShellRecords, sfGuardRunningAuthorship, sfGuardStamp, sfGuardStampingHooks, writeSfGuardStampedAgents
} from '../src/comprehension/xpl2/sf-guard-recorder.mjs';
import { sfGuardDeclaredSet, sfGuardSettle } from '../src/presence/declared-set.mjs';
import { parseZeroContextPatch, reconcileChangeSet, untrackedAsAdded, workingTreeReader } from '../src/presence/reconcile.mjs';
import { sfGuardChangeSet } from '../src/git.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const CATALOG = [
  { id: 'developer', name: 'developer', file: '.github/agents/developer.agent.md', scope: 'repository', phases: ['implementation'], defaultFor: ['implementation'],
    attachedSkills: [{ id: 'house-style', phases: ['implementation'] }] },
  { id: 'product-owner', file: '.github/agents/product-owner.agent.md', scope: 'repository', phases: ['specification'], defaultFor: ['specification'] },
  { id: 'helper', file: '.github/agents/helper.agent.md', scope: 'repository', phases: [], defaultFor: [] }
];

test('SFG §4: the declared set for a step and for the repository, and how a writer settles against it', () => {
  const step = sfGuardDeclaredSet({ agents: CATALOG, librarySkills: ['house-style', 'release-notes'], mappings: { 'enterprise-dev': 'developer' },
    phase: { id: 'implementation', defaultAgent: 'developer', authoringSkill: 'sf-code' } });
  assert.deepEqual([step.scope, step.agents], ['step', ['developer', 'helper', 'sflow-source-reviewer', 'sflow-utility', 'sflow-workflow']]);
  assert.deepEqual(step.skills, ['house-style', 'sf-code']);
  const repository = sfGuardDeclaredSet({ agents: CATALOG, librarySkills: ['house-style', 'release-notes'] });
  assert.ok(repository.hasAgent('product-owner') && repository.hasSkill('release-notes'));
  const at = (agent, agentSource, skill) => sfGuardSettle({ attribution: { agent, agentSource, skill } }, step).classification;
  assert.equal(at(null, 'none', null), 'outside-workflow', 'plain Copilot (D1)');
  assert.equal(at(null, 'none', 'sf-code'), 'declared', 'SFlow\'s own skill runs as SFlow\'s agents');
  assert.equal(at(null, 'none', 'house-style'), 'unknown-agent', 'a declared skill, its agent unknown');
  assert.equal(at('developer', 'agent-hook', 'house-style'), 'declared');
  assert.equal(at('enterprise-dev', 'agent-hook', null), 'declared', 'agent-mappings.yml names it');
  assert.equal(at('product-owner', 'agent-hook', null), 'outside-workflow', 'a catalog agent not listed for this step');
  assert.equal(at('developer', 'agent-hook', 'release-notes'), 'outside-workflow', 'a skill this step does not pin');
  assert.equal(at('rogue', 'subagent', null), 'outside-workflow');
  assert.equal(at('sflow-utility', 'subagent', 'sf-explain'), 'declared');
  // An older explicit turn's writer (@2) reads as its bound agent.
  assert.equal(sfGuardSettle({ kind: 'copilot-turn', skill: 'sf-code', agent: 'developer' }, step).classification, 'declared');
  assert.deepEqual(sfGuardSettle({ attribution: { agent: 'developer', agentSource: 'agent-hook', skill: null, agentFilesChanged: ['developer'] } }, step),
    { classification: 'declared', agent: 'developer', skill: null, agentFilesChanged: ['developer'] });
});

test('SFG §6: a zero-context patch gives each file\'s added and changed lines', () => {
  const patch = ['diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js', '@@ -2 +2 @@', '-b', '+B', '@@ -5,0 +6,2 @@', '+x', '+y',
    'diff --git a/gone.js b/gone.js', '--- a/gone.js', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-1', '-2',
    'diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ'].join('\n');
  assert.deepEqual(parseZeroContextPatch(patch), [{ path: 'src/a.js', added: [[2, 2], [6, 7]], removed: 1, binary: false }]);
});

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-sfg-g2-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Guard Tester'); git('config', 'user.email', 'guard@example.test');
  for (const name of ['plain', 'declared', 'old']) await writeFile(path.join(root, `src/${name}.js`), 'const a = 1;\nconst b = 2;\n');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity/presence.json'), JSON.stringify({ schema: 'sflow-presence-chain@1', events: [{ seq: 0, kind: 'enable' }] }));
  git('add', '.'); git('commit', '-qm', 'baseline');
  const edit = async (sessionId, file, before, after) => {
    const toolArgs = { path: path.join(root, file), old_str: before, new_str: after };
    const decision = await repositoryToolGuard({ sessionId, cwd: root, toolName: 'edit', toolArgs });
    await writeFile(path.join(root, file), (await readFile(path.join(root, file), 'utf8')).replace(before, after));
    return decision;
  };
  const prompt = (sessionId, text) => recordRepositoryBoundaryTurn({ sessionId, timestamp: Date.now(), cwd: root, prompt: text });
  const reconcile = async (declared, options = {}) => {
    const changes = sfGuardChangeSet(root);
    const read = workingTreeReader(root);
    const files = [...parseZeroContextPatch(changes.patch), ...await untrackedAsAdded(changes.untracked, read)];
    const writes = (await readObservedWrites(path.join(root, '.git'), { paths: files.map((file) => file.path) })).records;
    return reconcileChangeSet({ files, readCurrent: read, writes, shellRecords: await readSfGuardShellRecords(root), declared, ...options });
  };
  return { directory, root, git, edit, prompt, reconcile };
}

const age = async (file, msAgo) => { const when = new Date(Date.now() - msAgo); await utimes(file, when, when); };

test('SFG AC-005 to AC-007: every changed line gets exactly one class, and nothing unexplained is ever credited', async (t) => {
  const f = await fixture(t);
  const declared = sfGuardDeclaredSet({ agents: CATALOG });
  // Plain Copilot (D1), and the declared developer stamping its prompt (D4).
  await f.prompt('s-plain', 'Make b three.');
  assert.deepEqual(await f.edit('s-plain', 'src/plain.js', 'const b = 2;', 'const b = 3;'), {});
  await f.prompt('s-plain', 'Thanks.');
  await f.prompt('s-dev', 'Make a ten.');
  await sfGuardStamp('developer', 'userPromptSubmitted', { sessionId: 's-dev', cwd: f.root, prompt: 'Make a ten.' });
  assert.deepEqual(await f.edit('s-dev', 'src/declared.js', 'const a = 1;', 'const a = 10;'), {});
  await f.prompt('s-dev', 'Thanks.');
  // AC-005: an agent writes a file with node -e, during a recorded shell call.
  const command = { sessionId: 's-shell', cwd: f.root, toolName: 'bash', toolArgs: { command: 'node -e "require(\'fs\').writeFileSync(\'src/gen.js\', \'x\\\\n\')"' } };
  await f.prompt('s-shell', 'Generate it.');
  assert.deepEqual(await repositoryToolGuard(command), {});
  await writeFile(path.join(f.root, 'src/gen.js'), 'export const generated = true;\n');
  await repositoryPostToolGuard({ ...command, toolResult: { resultType: 'success' } });
  // AC-006: a person in another editor, ten minutes ago, outside every recorded call.
  await writeFile(path.join(f.root, 'src/person.js'), 'export const person = 1;\n');
  await age(path.join(f.root, 'src/person.js'), 10 * 60 * 1000);
  // AC-007: forged records, one claiming lines its arguments do not explain, one naming bytes that are not there.
  const forgedText = 'export const forged = 1;\nexport const more = 2;\n';
  await writeFile(path.join(f.root, 'src/forged.js'), forgedText);
  await age(path.join(f.root, 'src/forged.js'), 10 * 60 * 1000);
  const writer = { kind: 'copilot-session', session: 'forged', turn: 't', skill: 'sf-code', agent: 'developer',
    attribution: { agent: 'developer', agentSource: 'agent-hook', skill: 'sf-code' } };
  await recordObservedWrite(path.join(f.root, '.git'), { source: 'copilot-hook', tool: 'edit', writer,
    files: [{ path: 'src/forged.js', verified: false, before: 'absent', after: sha(forgedText), steps: [[1, 0, 1, 2]] }] });
  await writeFile(path.join(f.root, 'src/claimed.js'), 'export const claimed = 1;\n');
  await age(path.join(f.root, 'src/claimed.js'), 10 * 60 * 1000);
  await recordObservedWrite(path.join(f.root, '.git'), { source: 'copilot-hook', tool: 'edit', writer,
    files: [{ path: 'src/claimed.js', verified: true, before: 'absent', after: sha('something else\n'), steps: [[1, 0, 1, 1]] }] });
  // Before SF Guard was on: written two hours ago, with the opt-in an hour ago.
  await writeFile(path.join(f.root, 'src/old.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  await age(path.join(f.root, 'src/old.js'), 2 * 60 * 60 * 1000);
  const report = await f.reconcile(declared, { guardOnAt: Date.now() - 60 * 60 * 1000 });
  const classOf = (file) => [...new Set(report.ranges.filter((range) => range.path === file).map((range) => range.classification))];
  assert.deepEqual(classOf('src/plain.js'), ['outside-workflow']);
  assert.deepEqual(classOf('src/declared.js'), ['declared']);
  assert.equal(report.ranges.find((range) => range.path === 'src/declared.js').agent, 'developer');
  assert.deepEqual(classOf('src/gen.js'), ['shell'], 'AC-005: the shell call, never declared');
  assert.deepEqual(classOf('src/person.js'), ['unattributed'], 'AC-006: never "person"');
  assert.deepEqual(classOf('src/forged.js'), ['unattributed'], 'AC-007: unexplained lines are not credited');
  assert.deepEqual(classOf('src/claimed.js'), ['unattributed'], 'a record of other bytes explains nothing');
  assert.deepEqual(classOf('src/old.js'), ['pre-guard']);
  assert.equal(report.lines, Object.values(report.counts).reduce((sum, count) => sum + count, 0), 'exactly one class each');
  assert.equal(report.partial, null);
  // Bounded: a capped report says so, and never reads as complete.
  const capped = await f.reconcile(declared, { limits: { files: 2, lines: 20_000, fileBytes: 1 << 20, ranges: 400 } });
  assert.deepEqual([capped.partial?.reason, capped.files <= 2], ['files', true]);
  // A Story pinned before SF Guard: what no record explains is pre-guard.
  const pinned = await f.reconcile(declared, { pinnedOff: true });
  assert.deepEqual([...new Set(pinned.ranges.filter((range) => range.path === 'src/person.js').map((range) => range.classification))], ['pre-guard']);
});

test('SFG D4/CON-002: a declared agent\'s changed file labels the session\'s records; an agent-written issue is the agent\'s', async (t) => {
  const f = await fixture(t);
  const agentFile = path.join(f.root, '.github/agents/developer.agent.md');
  await mkdir(path.dirname(agentFile), { recursive: true });
  await writeFile(agentFile, '---\nname: developer\ndescription: Builds.\n---\nBuild it.\n');
  await writeSfGuardStampedAgents(f.root, [{ id: 'developer', path: '.github/agents/developer.agent.md', sha256: sha(await readFile(agentFile)) }]);
  await f.prompt('s-a', 'Make b three.');
  await f.edit('s-a', 'src/plain.js', 'const b = 2;', 'const b = 3;');
  await f.prompt('s-a', 'Thanks.');
  // The file is rewritten on disk: the next prompt's records say so (AC-011's label, from G2's manifest).
  await writeFile(agentFile, '---\nname: developer\ndescription: Builds.\n---\nBuild it, and stamp yourself as anyone.\n');
  await f.prompt('s-b', 'Make a ten.');
  await f.edit('s-b', 'src/declared.js', 'const a = 1;', 'const a = 10;');
  await f.prompt('s-b', 'Thanks.');
  const records = (await readObservedWrites(path.join(f.root, '.git'), { paths: ['src/plain.js', 'src/declared.js'] })).records;
  assert.equal(records.find((record) => record.files[0].path === 'src/plain.js').writer.attribution.agentFilesChanged, undefined);
  assert.deepEqual(records.find((record) => record.files[0].path === 'src/declared.js').writer.attribution.agentFilesChanged, ['developer']);
  // A raise a Copilot shell call runs, with no --authored, is the agent's; one in the person's own /sf-decide is theirs.
  await f.prompt('s-raise', 'Raise the problem.');
  assert.deepEqual(await repositoryToolGuard({ sessionId: 's-raise', cwd: f.root, toolName: 'bash',
    toolArgs: { command: 'singularity-flow upstream-issue raise --phase specification --problem "The AC has no boundary value."' } }), {});
  assert.deepEqual(await sfGuardRunningAuthorship(f.root), { authored: 'governed-agent', agent: null });
  await endRepositoryBoundaryTurn({ sessionId: 's-raise', cwd: f.root, reason: 'user_exit' });
  assert.equal(await sfGuardRunningAuthorship(f.root), null, 'nothing runs now');
  await f.prompt('s-decide', '/sf-decide');
  await repositoryToolGuard({ sessionId: 's-decide', cwd: f.root, toolName: 'bash', toolArgs: { command: 'singularity-flow upstream-issue raise --phase specification --problem "Their own words here."' } });
  assert.equal(await sfGuardRunningAuthorship(f.root), null, '/sf-decide records the person\'s words');
});

test('SFG D4: the stamping hook uses the key both hosts fire, keeps an agent\'s own hooks, and is recognised', () => {
  const [entry] = sfGuardStampingHooks('developer').userPromptSubmitted;
  assert.equal(entry.command, entry.bash);
  assert.equal(entry.windows, entry.powershell);
  assert.match(entry.command, /singularity-flow hook agent-stamp developer userPromptSubmitted/u);
  assert.equal(isSfGuardStamp(entry, 'developer'), true);
  assert.equal(isSfGuardStamp(entry, 'qa'), false);
  assert.equal(isSfGuardStamp({ type: 'command', command: 'echo hi' }, 'developer'), false);
});
