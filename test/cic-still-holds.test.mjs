/**
 * Amendments stop letting stale work through, under SPEC-CIC switch 1 [SPEC-CIC v1.1 stage 4; CIC:REQ-005, REQ-006,
 * REQ-021, owner decisions 2026-11-14]. With the pinned spec policy's observed dependencies on:
 * - nothing unknown narrows staleness: a clause depending on a removed one is stale, a revision that recorded no changes
 *   makes every clause it holds stale, and neither a step the revision does not list nor generation 0 is exempt;
 * - a published step whose dependency record does not resolve counts as affected, never as unaffected;
 * - a step rule E8 keeps whose prompt held a changed clause it does not cite is asked "still holds" by its own approvers
 *   on the Decide card, with a recommendation and one line of why, never settled for them; until they answer, only the
 *   approval of a step that reads it and the Story's end wait.
 * With the switch off nothing changes (cic-dependency-records.test.mjs and the rest of the suite).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { decisionPacket } from '../src/decision-list.mjs';
import { packetText } from '../src/commands/decisions.mjs';
import { scopeStaleness, staleClausesOf } from '../src/scope/revisions.mjs';
import { decideHtml } from '../apps/vscode/src/views/decide-card-page.ts';
import { decisionsTable } from '../plugin/extensions/decisions/card.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const AT = '2026-11-14T12:00:00.000Z';

test('under switch 1 nothing unknown narrows staleness; with it off staleness is as it was [CIC:REQ-006]', () => {
  const clauses = [{ id: 'W-1:AC-001', dependsOn: [] }, { id: 'W-1:AC-002', dependsOn: ['W-1:AC-009'] }, { id: 'W-1:AC-003', dependsOn: [] }];
  const held = clauses.map((clause) => ({ id: clause.id, bodySha256: 'a'.repeat(64), definedIn: 'scope', generation: 1 }));
  const story = (observed, revisions) => ({ resolution: { spec: observed ? { observedDependencies: 'on' } : {} }, phaseOrder: ['before', 'scope', 'design', 'code'],
    phases: { before: { generationPublications: [{ generation: 1, publishedAt: '2026-11-14T09:00:00.000Z' }, { generation: 2, publishedAt: '2026-11-14T11:00:00.000Z' }] },
      scope: {}, design: {}, code: {} }, scopeRevisions: revisions });
  // (a) a clause depending on a removed one.
  const removal = { revision: 2, changes: { added: [], revised: [], removed: ['W-1:AC-009'] }, clauses: held, origin: { kind: 'intent-amendment', id: 'AMD-001', phase: 'scope', generation: 2 },
    dependentGenerations: { design: 1, code: 1 }, at: '2026-11-14T10:00:00.000Z' };
  assert.deepEqual([...staleClausesOf(removal, clauses)], []);
  assert.deepEqual([...staleClausesOf(removal, clauses, { observed: true })], ['W-1:AC-002']);
  assert.equal(scopeStaleness(story(false, [removal]), clauses).staleBy('W-1:AC-002', 'design', 1), null);
  assert.equal(scopeStaleness(story(true, [removal]), clauses).staleBy('W-1:AC-002', 'design', 1)?.revision, 2);
  // (b) a revision that recorded no changes makes every clause it holds stale for the steps it reaches.
  const unrecorded = { ...removal, revision: 1, changes: null, dependentGenerations: { design: 1, code: 0 } };
  assert.equal(scopeStaleness(story(false, [unrecorded]), clauses).staleBy('W-1:AC-003', 'design', 1), null);
  assert.equal(scopeStaleness(story(true, [unrecorded]), clauses).staleBy('W-1:AC-003', 'design', 1)?.revision, 1);
  assert.equal(scopeStaleness(story(true, [unrecorded]), clauses).staleBy('W-1:AC-003', 'design', 2), null, 'a generation published after it is current');
  // (c) generation 0, a step the revision does not list, and the step that made the revision.
  const revised = { ...removal, changes: { added: [], revised: ['W-1:AC-001'], removed: [] }, dependentGenerations: { design: 0, code: 0 } };
  assert.equal(scopeStaleness(story(false, [revised]), clauses).staleBy('W-1:AC-001', 'code', 0), null);
  assert.equal(scopeStaleness(story(true, [revised]), clauses).staleBy('W-1:AC-001', 'code', 0)?.revision, 2, 'evidence at generation 0 is read like any other');
  assert.equal(scopeStaleness(story(false, [revised]), clauses).staleBy('W-1:AC-001', 'before', 1), null);
  assert.equal(scopeStaleness(story(true, [revised]), clauses).staleBy('W-1:AC-001', 'before', 1)?.revision, 2, 'an unlisted step published before the revision');
  assert.equal(scopeStaleness(story(true, [revised]), clauses).staleBy('W-1:AC-001', 'before', 2), null, 'an unlisted step published after it');
  assert.equal(scopeStaleness(story(true, [revised]), clauses).staleBy('W-1:AC-001', 'scope', 1)?.revision, 2, 'the scope\'s own earlier generation');
  assert.equal(scopeStaleness(story(true, [revised]), clauses).staleBy('W-1:AC-001', 'scope', 2), null, 'the generation that made the revision');
});

/** A Story's decision list with one "still holds" row, as decision-list-reads.mjs reads it, and an approval hold or not. */
function stillHoldsPacket({ recommend = 'unchanged', namedPaths = [], consumers = ['implement'], awaiting = null, hold = false } = {}) {
  const workflow = { workItem: { id: 'D-1', title: 'Still holds', workType: 'demo', branch: 'D-1' }, currentPhase: awaiting ?? 'implement',
    phaseOrder: ['intake', 'fix-design', 'implement'], status: 'in_progress',
    resolution: { approvalAuthorities: { engineering: { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] } } },
    phases: {
      intake: { id: 'intake', label: 'Scope and plan', status: 'approved', generation: 2, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } },
      'fix-design': { id: 'fix-design', label: 'Fix design', status: 'approved', generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } },
      implement: { id: 'implement', label: 'Implement', status: awaiting ? 'awaiting_approval' : 'in_progress', generation: 2, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } }
    } };
  const row = { code: 'AMENDMENT_REVALIDATION_REQUIRED', amendment: 'AMD-001', phase: 'fix-design', producer: 'intake',
    message: 'fix-design read intake before AMD-001 amended it.', command: 'singularity-flow upstream-issue revalidate fix-design --work-id D-1 --amendment AMD-001 --outcome <unchanged|return> --reason "<why>"',
    reason: 'prompt-held', clauses: ['D-1:AC-001'], recommend, namedPaths, consumers };
  const holds = hold ? [{ code: 'AMENDMENT_STILL_HOLDS_REQUIRED', owner: 'someone-decides', summary: 'implement waits for fix-design.',
    clearedBy: { kind: 'approvers', steps: ['fix-design'] }, stillHolds: [{ amendment: 'AMD-001', phase: 'fix-design', generation: 1, clauses: ['D-1:AC-001'] }] }] : [];
  return decisionPacket(workflow, { phaseId: workflow.currentPhase, endsStory: false, gaps: [], issues: [], evidence: [], visual: [], testRisks: [], testCommands: [],
    scopePhase: 'intake', approvalCheck: awaiting ? { advisory: true, ready: !hold, holds } : null, pending: { forwardAmendments: [row] }, state: null },
  { authorities: workflow.resolution.approvalAuthorities, actor: { name: 'Tester', email: 'tester@example.invalid' }, at: AT });
}

test('a still-holds question is the same item on every host: it recommends, says why in one line, and is never settled [CIC:REQ-021]', () => {
  const packet = stillHoldsPacket();
  const item = packet.items.find((entry) => entry.kind === 'revalidation');
  assert.equal(item.title, 'Say whether Fix design still holds after AMD-001');
  assert.match(item.why, /^AMD-001 kept Fix design's approval: its document cites none of the changed clauses, but its prompt held AC-001\. /u);
  assert.match(item.why, /until then the approval of Implement and the Story's end wait for it\.$/u);
  assert.deepEqual(item.options.map((option) => option.id), ['still-holds', 'return-step']);
  assert.equal(item.recommended.option, 'still-holds');
  assert.equal(item.recommended.words, 'Recommended: Fix design still holds. Fix design\'s document names neither AC-001 nor any path it expects.');
  assert.equal(item.settled ?? false, false);
  assert.equal((packet.settled ?? []).some((entry) => entry.details?.phase === 'fix-design'), false, 'never settled for the person');
  assert.equal(item.holds, 'approval-later', 'the step that reads it waits at its approval');
  assert.equal(stillHoldsPacket({ consumers: [] }).items.find((entry) => entry.kind === 'revalidation').holds, 'story-end', 'one that reads nothing of it holds only the Story\'s end');
  // The same words on the terminal, the VS Code Decide card and the Copilot CLI card.
  for (const [host, text] of [['terminal', packetText(packet)], ['VS Code', decideHtml({ ...packet, packetSha256: 'sha256:x', repositoryPath: '/repo' }).replaceAll('&#39;', '\'')],
    ['Copilot CLI', decisionsTable(packet)]]) {
    assert.ok(text.includes('Say whether Fix design still holds after AMD-001'), `${host}: the question`);
    assert.ok(text.includes('Fix design\'s document names neither AC-001 nor any path it expects.'), `${host}: why it is recommended`);
  }
  // Its document names a path the changed clause expects: redo it.
  const redo = stillHoldsPacket({ recommend: 'return', namedPaths: ['src/value.mjs'] }).items.find((entry) => entry.kind === 'revalidation');
  assert.equal(redo.recommended.option, 'return-step');
  assert.equal(redo.recommended.words, 'Recommended: Redo Fix design: return the Story to it. Fix design\'s document names src/value.mjs, which AC-001 expects.');
  // It holds the approval of a step that reads it, when the engine says so, and no other.
  assert.equal(stillHoldsPacket({ awaiting: 'implement', hold: true }).items.find((entry) => entry.kind === 'revalidation').holdsApproval, true);
  assert.equal(stillHoldsPacket({ awaiting: 'implement', hold: false, consumers: [] }).items.find((entry) => entry.kind === 'revalidation').holdsApproval, false);
});

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-cic-still-holds-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Cone Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'w.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'a.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'l.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'c.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Cone Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'cone@example.invalid' };
  const run = (args) => spawnSync(process.execPath, [cli, '--no-model', ...args], { cwd: root, env, encoding: 'utf8', timeout: childTimeout(180_000), maxBuffer: 1 << 26 });
  const must = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000), maxBuffer: 1 << 26 });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n");
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  delete config.phases['fix-design'].clarification;
  config.spec = { ...config.spec, observedDependencies: 'on' };
  const quick = config.workTypes['quick-fix'];
  config.workTypes['quick-design'] = { ...quick, phases: ['intake', 'fix-design', 'implement', 'verify'] };
  // The same steps, but the code step reads the design: its approval waits for the design's "still holds".
  config.workTypes['quick-design-reads'] = { ...quick, phases: ['intake', 'fix-design', 'implement', 'verify'],
    phaseOverrides: { ...quick.phaseOverrides, implement: { inputs: ['intake', 'fix-design'] } } };
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Still holds fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  const item = (id, ...parts) => path.join(root, 'singularity/work-items', id, ...parts);
  const workflow = async (id) => JSON.parse(await readFile(item(id, 'workflow.json'), 'utf8'));
  const code = async (id, generation) => {
    await writeFile(path.join(root, 'src/value.mjs'), `// @clause:${id}:AC-001 the exported value is the number 2\n// @clause:${id}:AC-002 the single export stays${generation > 1 ? ' as one named export' : ''}\nexport const value = 2;\n`);
    await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n"
      + `// @ac:${id}:AC-001\ntest('value', () => assert.equal(value, 2));\n// @ac:${id}:AC-002\ntest('one export', async () => assert.deepEqual(Object.keys(await import('../src/value.mjs')), ['value']));\n`);
  };
  // Through an approved fix-design (which cites AC-002 only and names no path) and a published code step, then AC-001 is amended.
  const amended = async (id, workType, { supporting = false } = {}) => {
    sflow('start', id, '--from-branch', 'main', '--work-type', workType, '--title', 'Change the value', '--description', 'Return 2.');
    sflow('prepare', 'intake');
    sflow('phase', 'enter', 'intake', '--compose', '--json');
    await writeFile(item(id, 'artifacts/intake/intake.md'), [
      `# ${id} — Quick fix scope and plan`, '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
      '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
      `| [${id}:AC-001] | The exported value equals 2. |`, `| [${id}:AC-002] | The value module stays a single export. |`, '',
      '## Planned implementation evidence', '',
      '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
      `| \`${id}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | The test reads 2. |`,
      `| \`${id}:AC-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` | existing | One export remains. |`, '',
      '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
    sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
    sflow('submit', 'intake');
    sflow('approve', 'intake', '--yes');
    sflow('prepare', 'fix-design');
    sflow('phase', 'enter', 'fix-design', '--compose', '--json');
    await writeFile(item(id, 'artifacts/fix-design/fix-design.md'), [`# ${id} — Fix Design`, '', '## Root cause', '',
      'The exported constant holds the old value; nothing computes it.', '', '## Minimal safe change', '',
      `Change the one literal that holds the value. ${id}:AC-002 keeps the module to a single export, so no import changes.`, '',
      '## Alternatives and regression risk', '', 'A computed value was rejected as unnecessary; the only regression surface is the one test that reads it.', ''].join('\n'));
    sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
    sflow('submit', 'fix-design');
    sflow('approve', 'fix-design', '--yes');
    sflow('phase', 'begin', 'implement', '--json');
    await code(id, 1);
    if (supporting) {
      // A supporting change the plan lists through an approved plan amendment: covered, and depending on no clause [CIC:REQ-005].
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, description: 'Returns the approved value.', scripts: { test: 'node --test' } }));
      const why = 'The package says what the module is for.';
      sflow('decision', 'plan', id, '--add-supporting', 'package.json=build-configuration', '--supporting-reason', why, '--reason', why);
    }
    sflow('prepare', 'implement');
    sflow('phase', 'publish', 'implement', '--authored', 'deterministic');
    const file = path.join(base, `${id}-amended.md`);
    await writeFile(file, (await readFile(item(id, 'artifacts/intake/intake.md'), 'utf8')).replace('The exported value equals 2.', 'The exported value equals 2 and is a number.'));
    const preview = JSON.parse(sflow('story', 'intent-amendment', 'preview', '--file', file, '--json'));
    const { proposal } = JSON.parse(sflow('story', 'intent-amendment', 'propose', '--file', file, '--reason', 'Say the value is numeric.', '--json'));
    const decided = sflow('story', 'intent-amendment', 'decide', proposal.id, '--decision', 'approve', '--confirm', proposal.id);
    return { preview, decided, proposal };
  };
  // The code step runs again on the amended scope and is submitted.
  const resubmitted = async (id) => {
    sflow('story', 'intent-amendment', 'acknowledge', 'AMD-001');
    sflow('resume', id);
    sflow('phase', 'begin', 'implement', '--json');
    await code(id, 2);
    sflow('prepare', 'implement');
    sflow('phase', 'publish', 'implement', '--authored', 'deterministic');
    sflow('submit', 'implement');
  };
  const decisions = (id) => { const parsed = JSON.parse(sflow('decisions', id, '--json')); return parsed.data ?? parsed; };
  const stillHolds = (id) => sflow('upstream-issue', 'revalidate', 'fix-design', '--work-id', id, '--amendment', 'AMD-001', '--outcome', 'unchanged',
    '--reason', 'The design does not rely on the numeric wording of the value criterion.');
  return { root, run, sflow, workflow, amended, resubmitted, decisions, stillHolds };
}

test('a kept step whose prompt held the changed clause is asked whether it still holds; only what reads it waits, and the Story ends once it is answered [CIC:REQ-021]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const f = await fixture(t);

    // A: the code step reads only the scope, so the design's question never stops it; the Story's end waits for it.
    const a = await f.amended('SH-1', 'quick-design', { supporting: true });
    const codeRecord = JSON.parse(await readFile(path.join(f.root, 'singularity/work-items/SH-1/context/dependencies/implement-gen1.json'), 'utf8'));
    assert.deepEqual(codeRecord.supportingPaths, ['package.json']);
    assert.deepEqual(codeRecord.unclaimedPaths, []);
    assert.equal(codeRecord.edges.some((edge) => edge.path === 'package.json'), false, 'a supporting change depends on no clause');
    const kept = a.preview.effect.steps.find((step) => step.phase === 'fix-design');
    assert.equal(kept.outcome, 'kept');
    assert.deepEqual(kept.stillHolds, { clauses: ['SH-1:AC-001'], recommend: 'unchanged' }, 'its prompt held AC-001, and its document names neither it nor src/value.mjs');
    assert.ok(a.preview.summary.some((line) => /Fix design keeps its approval \(rule E8\): it cites none of the changed clauses; its prompt held AC-001, so its approvers say whether it still holds \(recommended: it still holds\)\./u.test(line)), a.preview.summary.join('\n'));
    assert.match(a.decided, /fix-design keeps its approval, and its approvers say on the decisions list whether it still holds: its prompt held SH-1:AC-001\./u);
    const story = await f.workflow('SH-1');
    const summary = story.intentAmendments.at(-1);
    assert.deepEqual(summary.revalidate, [{ phase: 'fix-design', generation: 1, reason: 'prompt-held', clauses: ['SH-1:AC-001'], recommend: 'unchanged' }],
      'the approval asks exactly what the preview said it would');
    assert.equal(summary.producer, 'intake');
    assert.deepEqual(story.phases['fix-design'].retention.rule, 'E8');
    const listed = f.decisions('SH-1').items.find((entry) => entry.kind === 'revalidation');
    assert.equal(listed.recommended.option, 'still-holds');
    assert.equal(listed.settled ?? false, false);
    await f.resubmitted('SH-1');
    // The code step's approval comes with its submission here when nothing holds it.
    if ((await f.workflow('SH-1')).phases.implement.status !== 'approved') f.sflow('approve', 'implement', '--yes');
    assert.equal((await f.workflow('SH-1')).phases.implement.status, 'approved', 'an unanswered question on a step it does not read never stalls it');
    f.sflow('prepare', 'verify');
    f.sflow('phase', 'publish', 'verify', '--authored', 'deterministic');
    const ending = f.run(['submit', 'verify']);
    if ((await f.workflow('SH-1')).status !== 'closed') {
      const approval = f.run(['approve', 'verify', '--yes']);
      assert.notEqual(approval.status, 0, 'the Story cannot end before the question is answered');
      assert.match(`${approval.stdout}${approval.stderr}`, /fix-design/u);
    } else assert.fail(`the Story closed with the question unanswered\n${ending.stdout}\n${ending.stderr}`);
    f.stillHolds('SH-1');
    if ((await f.workflow('SH-1')).phases.verify.status !== 'approved') f.sflow('approve', 'verify', '--yes');
    assert.equal((await f.workflow('SH-1')).status, 'closed');

    // B: the code step reads the design, so its approval waits for the answer, refused with its way out.
    // B: the code step reads the design, and completes at its submission (approval: none): its submission waits for the answer,
    // refused with its way out, and nothing else of the step is touched.
    await f.amended('SH-2', 'quick-design-reads');
    let refused = null;
    try { await f.resubmitted('SH-2'); } catch (error) { refused = error; }
    assert.ok(refused, 'the code step that reads the design cannot complete before the question is answered');
    assert.match(refused.message, /submit/u);
    const submitted = f.run(['submit', 'implement', '--json']);
    assert.notEqual(submitted.status, 0);
    const error = JSON.parse(submitted.stdout || submitted.stderr);
    assert.equal((error.error ?? error).code, 'AMENDMENT_STILL_HOLDS_REQUIRED', submitted.stdout);
    assert.match(submitted.stdout, /\/sf-decide SH-2/u);
    assert.equal((await f.workflow('SH-2')).phases.implement.status, 'in_progress', 'nothing loops back: the step waits where it is');
    f.stillHolds('SH-2');
    f.sflow('submit', 'implement');
    assert.equal((await f.workflow('SH-2')).phases.implement.status, 'approved');
  });
