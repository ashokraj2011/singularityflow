/**
 * Step dependency records and scope revision v2 [SPEC-CIC v1.1 stage 3; CIC:REQ-001, REQ-002, REQ-005, REQ-018,
 * REQ-019, AC-017, AC-018]. With the pinned spec policy's observed dependencies on (switch 1), each published
 * generation commits a record of what it depended on, digest-bound to its generation and the scope revision then
 * current, and new scope revisions are v2, chained after v1. Nothing is decided from them yet: staleness, the
 * amendment's effect and what approving it resets are exactly those of the same Story with the switch off. With
 * it off (the default, and every Story pinned before it), nothing new is written.
 *
 * The fixture adds an approved fix-design step between quick-fix's intake (the scope) and implement; the design
 * cites AC-002 only, and AC-001's statement cites AC-002.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { recordSha256 } from '../src/records.mjs';
import { nextScopeRevision, scopeStaleness, staleClausesOf, staleReasons } from '../src/scope/revisions.mjs';
import { stepDependencies, verifyScopeRevisionChain } from '../src/dependency-records.mjs';
import { normalizeSpecPolicy } from '../src/specifications.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const WORK = 'DEP-1';

async function fixture(t, { observed }) {
  const base = await mkdtemp(path.join(os.tmpdir(), `sflow-cic-records-${observed ? 'on' : 'off'}-`));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Cone Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'w.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'a.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'l.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'c.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Cone Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'cone@example.invalid' };
  const timings = [];
  const must = (command, args, cwd = root) => {
    const started = process.hrtime.bigint();
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000) });
    if (args.includes('publish')) timings.push({ step: args[args.indexOf('publish') + 1], ms: Number(process.hrtime.bigint() - started) / 1e6 });
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
  config.workTypes['quick-design'] = { ...config.workTypes['quick-fix'], phases: ['intake', 'fix-design', 'implement', 'verify'] };
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  if (observed) config.spec = { ...config.spec, observedDependencies: 'on' };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Dependency record fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  const item = (...parts) => path.join(root, 'singularity/work-items', WORK, ...parts);
  const workflow = async () => JSON.parse(await readFile(item('workflow.json'), 'utf8'));
  const walk = async () => {
    sflow('start', WORK, '--from-branch', 'main', '--work-type', 'quick-design', '--title', 'Change the value', '--description', 'Return 2.');
    sflow('prepare', 'intake');
    // As an agent's entry does: the step's prompt is composed and its receipt recorded.
    sflow('phase', 'enter', 'intake', '--compose', '--json');
    await writeFile(item('artifacts/intake/intake.md'), [
      `# ${WORK} — Quick fix scope and plan`, '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
      '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
      `| [${WORK}:AC-001] | The exported value equals 2, in the single export ${WORK}:AC-002 keeps. |`, `| [${WORK}:AC-002] | The value module stays a single export. |`, '',
      '## Planned implementation evidence', '',
      '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
      `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | The test reads 2. |`,
      `| \`${WORK}:AC-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` | existing | One export remains. |`, '',
      '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
    sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
    sflow('submit', 'intake');
    sflow('approve', 'intake', '--yes');
    sflow('prepare', 'fix-design');
    sflow('phase', 'enter', 'fix-design', '--compose', '--json');
    await writeFile(item('artifacts/fix-design/fix-design.md'), [`# ${WORK} — Fix Design`, '', '## Root cause', '',
      'The exported constant holds the old value; nothing computes it.', '', '## Minimal safe change', '',
      `Change the literal in src/value.mjs only. ${WORK}:AC-002 keeps the module to a single export, so no import changes.`, '',
      '## Alternatives and regression risk', '', 'A computed value was rejected as unnecessary; the only regression surface is the one test that reads it.', ''].join('\n'));
    sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
    sflow('submit', 'fix-design');
    sflow('approve', 'fix-design', '--yes');
    sflow('phase', 'begin', 'implement', '--json');
    await writeFile(path.join(root, 'src/value.mjs'), `// @clause:${WORK}:AC-001 the exported value is the number 2\n// @clause:${WORK}:AC-002 the single export stays\nexport const value = 2;\n`);
    await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n"
      + `// @ac:${WORK}:AC-001\ntest('value', () => assert.equal(value, 2));\n// @ac:${WORK}:AC-002\ntest('one export', async () => assert.deepEqual(Object.keys(await import('../src/value.mjs')), ['value']));\n`);
    // Deterministic code composes no prompt, so its record has no receipt.
    sflow('prepare', 'implement');
    sflow('phase', 'publish', 'implement', '--authored', 'deterministic');
    // An amendment of AC-002 after implement published: fix-design cites it, so it reopens; AC-001 depends on it.
    const amended = path.join(base, 'amended.md');
    await writeFile(amended, (await readFile(item('artifacts/intake/intake.md'), 'utf8'))
      .replace('The value module stays a single export.', 'The value module keeps exactly one named export.'));
    const preview = JSON.parse(sflow('story', 'intent-amendment', 'preview', '--file', amended, '--json'));
    const proposed = JSON.parse(sflow('story', 'intent-amendment', 'propose', '--file', amended, '--reason', 'Tighten the export clause.', '--json'));
    sflow('story', 'intent-amendment', 'decide', proposed.proposal.id, '--decision', 'approve', '--confirm', proposed.proposal.id);
    return preview;
  };
  return { root, sflow, must, item, workflow, walk, timings };
}

/** What a run decided, without the times and digests a second run cannot share. */
function outcome(story, preview) {
  const clauses = (story.scopeRevisions ?? []).at(-1)?.clauses ?? [];
  const staleness = scopeStaleness(story, clauses.map((clause) => ({ ...clause, dependsOn: clause.id.endsWith('AC-001') ? [`${WORK}:AC-002`] : [] })));
  // Stage 4 reads the records under switch 1 [CIC:REQ-006]: an unresolved record is an extra reason a step is affected,
  // which here changes no step's outcome. What each step does, and what is stale, is compared whole.
  return {
    effect: { ...preview.effect, steps: preview.effect.steps.map((step) => [step.phase, step.outcome]) },
    revisions: story.scopeRevisions.map((revision) => [revision.revision, revision.changes, revision.dependentGenerations]),
    stale: [...staleClausesOf(story.scopeRevisions.at(-1), clauses.map((clause) => ({ ...clause, dependsOn: clause.id.endsWith('AC-001') ? [`${WORK}:AC-002`] : [] })))].sort(),
    staleBy: ['fix-design', 'implement'].flatMap((phase) => clauses.map((clause) => [phase, clause.id, staleness.staleBy(clause.id, phase, 1)?.revision ?? null])),
    steps: story.phaseOrder.map((phase) => [phase, story.phases[phase].status, story.phases[phase].generation, story.phases[phase].retention?.rule ?? null]),
    current: story.currentPhase,
    history: story.history.map((entry) => [entry.event, entry.phase ?? null])
  };
}

test('a v2 revision chains after v1 and states each stale clause\'s reason; a tampered revision or a broken link is reported', () => {
  const workflow = { phaseOrder: ['scope', 'plan'], phases: { scope: { generation: 1 }, plan: { generation: 1 } }, scopeRevisions: [] };
  const clauses = (statement) => [{ id: 'W-1:AC-001', bodySha256: 'a'.repeat(64), definedIn: 'scope', generation: 1 },
    { id: 'W-1:AC-002', bodySha256: statement, definedIn: 'scope', generation: 1 }];
  const first = nextScopeRevision(workflow, { clauses: clauses('b'.repeat(64)), origin: { kind: 'approval', phase: 'scope', generation: 1 }, at: '2026-11-14T00:00:00.000Z' });
  workflow.scopeRevisions.push(first);
  assert.equal(first.schema, 'scope-revision/v1');
  const indexed = [{ id: 'W-1:AC-001', dependsOn: ['W-1:AC-002'] }, { id: 'W-1:AC-002', dependsOn: [] }];
  const second = nextScopeRevision(workflow, { clauses: clauses('c'.repeat(64)), origin: { kind: 'intent-amendment', id: 'AMD-001', phase: 'scope', generation: 2 },
    at: '2026-11-14T00:01:00.000Z', dependencies: indexed });
  workflow.scopeRevisions.push(second);
  assert.equal(second.schema, 'scope-revision/v2');
  assert.deepEqual(second.stale, [{ clause: 'W-1:AC-001', reason: 'depends', via: ['W-1:AC-002'] }, { clause: 'W-1:AC-002', reason: 'revised' }]);
  assert.deepEqual(second.edges, [{ kind: 'declared', clause: 'W-1:AC-001', dependsOn: 'W-1:AC-002' }]);
  assert.deepEqual(second.stale.map((entry) => entry.clause), [...staleClausesOf(second, indexed)].sort(), 'the stated reasons cover exactly the stale set');
  assert.equal(second.previousRevisionSha256, first.revisionSha256);
  const { revisionSha256, ...core } = second;
  assert.equal(revisionSha256, `sha256:${recordSha256(core)}`, 'the v2 fields are inside its digest');
  assert.deepEqual(verifyScopeRevisionChain(workflow), { verified: true, revisions: 2, problems: [] });
  const tampered = structuredClone(workflow);
  tampered.scopeRevisions[1].stale = [];
  assert.deepEqual(verifyScopeRevisionChain(tampered).problems, [{ revision: 2, problem: 'digest' }]);
  const unlinked = structuredClone(workflow);
  unlinked.scopeRevisions[1].previousRevisionSha256 = null;
  assert.deepEqual(verifyScopeRevisionChain(unlinked).problems.map((entry) => entry.problem), ['digest', 'link']);
  assert.deepEqual(staleReasons(null, indexed), { stale: [], edges: [] });
});

test('the switch is a pinned spec field: on is pinned, off and absent pin nothing, and any other value is refused', () => {
  assert.equal(normalizeSpecPolicy({ observedDependencies: 'on' }).observedDependencies, 'on');
  assert.equal(Object.hasOwn(normalizeSpecPolicy({}), 'observedDependencies'), false);
  assert.equal(Object.hasOwn(normalizeSpecPolicy({ observedDependencies: 'off' }), 'observedDependencies'), false);
  assert.throws(() => normalizeSpecPolicy({ observedDependencies: 'yes' }), /spec\.observedDependencies must be off or on/u);
});

test('with observed dependencies on, every published generation commits a verified record, and nothing is decided differently than with it off [CIC:AC-017]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const on = await fixture(t, { observed: true });
    const off = await fixture(t, { observed: false });
    const previewOn = await on.walk();
    const previewOff = await off.walk();
    const storyOn = await on.workflow();
    const storyOff = await off.workflow();

    // Identical outcomes: what the amendment does to each step, the revisions' changes, staleness, the reset and kept steps, and the history.
    const { observed: _observed, unclaimedClauses: _unclaimed, ...onEffect } = outcome(storyOn, previewOn).effect;
    assert.deepEqual({ ...outcome(storyOn, previewOn), effect: onEffect }, outcome(storyOff, previewOff));
    // Under switch 1 the code step's unresolved record is named as a reason it is affected; with it off it is not read.
    assert.deepEqual(previewOn.effect.steps.find((step) => step.phase === 'implement').reasons.filter((reason) => reason.kind === 'unresolved-record'),
      [{ kind: 'unresolved-record', reasons: ['receipt-missing'] }]);
    assert.equal(previewOff.effect.steps.some((step) => step.reasons.some((reason) => reason.kind === 'unresolved-record')), false);
    assert.deepEqual(previewOn.effect.steps.map((step) => [step.phase, step.outcome]), [['fix-design', 'reopened'], ['implement', 'reset'], ['verify', 'reset']]);

    // Off: nothing new anywhere [CIC:AC-018].
    assert.equal(existsSync(off.item('context/dependencies')), false);
    assert.equal(storyOff.phaseOrder.some((phase) => storyOff.phases[phase].dependencyRecords), false);
    assert.equal(Object.hasOwn(storyOff.resolution.spec, 'observedDependencies'), false);
    assert.ok(storyOff.scopeRevisions.every((revision) => revision.schema === 'scope-revision/v1' && !('stale' in revision) && !('edges' in revision)));
    const receiptOff = JSON.parse(await readFile(off.item('context/fix-design-gen1.json'), 'utf8'));
    assert.equal(Object.hasOwn(receiptOff.promptBudget.activeClauseCapsule, 'clauseRevisions'), false);
    const readOff = JSON.parse(off.sflow('spec', 'dependencies', '--json'));
    assert.deepEqual(readOff.steps.flatMap((step) => step.generations.map((row) => row.coverage.reasons)), [['no-record'], ['no-record'], ['no-record'], ['no-record']]);

    // On: v2 revisions that chain and verify, and one committed record per published generation whose digests verify.
    assert.equal(storyOn.resolution.spec.observedDependencies, 'on');
    assert.deepEqual(storyOn.scopeRevisions.map((revision) => revision.schema), ['scope-revision/v2', 'scope-revision/v2']);
    assert.deepEqual(storyOn.scopeRevisions[1].stale, [{ clause: `${WORK}:AC-001`, reason: 'depends', via: [`${WORK}:AC-002`] }, { clause: `${WORK}:AC-002`, reason: 'revised' }]);
    assert.deepEqual(verifyScopeRevisionChain(storyOn), { verified: true, revisions: 2, problems: [] });
    const records = {};
    for (const phase of ['intake', 'fix-design', 'implement']) {
      const [entry] = storyOn.phases[phase].dependencyRecords;
      assert.equal(entry.path, `singularity/work-items/${WORK}/context/dependencies/${phase}-gen1.json`);
      const record = JSON.parse(await readFile(path.join(on.root, entry.path), 'utf8'));
      const { recordSha256: stored, ...body } = record;
      assert.equal(stored, `sha256:${recordSha256(body)}`);
      assert.equal(stored, entry.recordSha256);
      assert.equal(on.must('git', ['ls-files', entry.path]).trim(), entry.path, `${phase}'s record is committed with its publication`);
      assert.deepEqual([record.phase, record.generation], [phase, 1]);
      records[phase] = record;
    }
    const revision1 = storyOn.scopeRevisions[0];
    const kinds = (record, kind) => record.edges.filter((edge) => edge.kind === kind);
    // The scope's own generation: no clause before it, its own planned claims; bound to no revision yet.
    assert.equal(records.intake.scopeRevision, null);
    assert.deepEqual(kinds(records.intake, 'input'), []);
    assert.deepEqual(kinds(records.intake, 'claim').map((edge) => edge.clause), [`${WORK}:AC-001`, `${WORK}:AC-002`]);
    assert.deepEqual(records.intake.coverage, { state: 'resolved', reasons: [] });
    assert.deepEqual(records.intake.claimMaps.map((map) => [map.phase, map.generation]), [['intake', 1]], 'its own planned claim map, digest-checked');
    // The design held both clauses in its prompt, with their approved statement hashes, and cites AC-002.
    assert.deepEqual(records['fix-design'].scopeRevision, { revision: 1, revisionSha256: revision1.revisionSha256 });
    assert.deepEqual(kinds(records['fix-design'], 'input'), revision1.clauses.map((clause) => ({ kind: 'input', clause: clause.id, statementSha256: clause.bodySha256 })));
    assert.deepEqual(kinds(records['fix-design'], 'citation').map((edge) => edge.clause), [`${WORK}:AC-002`]);
    assert.deepEqual(records['fix-design'].coverage, { state: 'resolved', reasons: [] });
    // The code step: planned claims, the changed paths they expect, its bound tests and the tests its tags sit on.
    const code = records.implement;
    assert.deepEqual(kinds(code, 'claim').map((edge) => edge.clause), [`${WORK}:AC-001`, `${WORK}:AC-002`]);
    assert.deepEqual(kinds(code, 'path').map((edge) => [edge.clause, edge.path]), [[`${WORK}:AC-001`, 'src/value.mjs'], [`${WORK}:AC-001`, 'test/value.test.mjs'],
      [`${WORK}:AC-002`, 'src/value.mjs'], [`${WORK}:AC-002`, 'test/value.test.mjs']]);
    assert.deepEqual(kinds(code, 'test').map((edge) => [edge.clause, edge.test]), [[`${WORK}:AC-001`, 'test/value.test.mjs'], [`${WORK}:AC-002`, 'test/value.test.mjs']]);
    assert.ok(kinds(code, 'witness').length >= 2, JSON.stringify(code.edges));
    assert.deepEqual(code.unclaimedPaths, []);
    assert.deepEqual(kinds(code, 'binding').map((edge) => [edge.clause, edge.path]), [[`${WORK}:AC-001`, 'src/value.mjs']]);
    // Deterministic code composed no prompt: what it held is not known, so its record is unresolved [CIC:REQ-005].
    assert.equal(code.receipt, null);
    assert.deepEqual(code.coverage, { state: 'unresolved', reasons: ['receipt-missing'] });
    assert.deepEqual(code.changeSet.path, `singularity/work-items/${WORK}/context/code-delivery/implement-gen1-changes.json`);
    t.diagnostic(`record bytes: ${Object.entries(records).map(([phase, record]) => `${phase} ${Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`)}`).join(', ')}`);
    t.diagnostic(`publish ms on: ${on.timings.map((entry) => `${entry.step} ${entry.ms.toFixed(0)}`).join(', ')}; off: ${off.timings.map((entry) => `${entry.step} ${entry.ms.toFixed(0)}`).join(', ')}`);

    // The read: edges by kind and coverage per generation; the amendment's scope generation has no record.
    const read = JSON.parse(on.sflow('spec', 'dependencies', '--json'));
    assert.equal(read.chain.verified, true);
    assert.deepEqual(read.steps.map((step) => [step.phase, step.generations.map((row) => [row.generation, row.coverage.state])]),
      [['intake', [[1, 'resolved'], [2, 'unresolved']]], ['fix-design', [[1, 'resolved']]], ['implement', [[1, 'unresolved']]]]);
    // The amendment published the scope's second generation from its approved bytes, with no prompt behind it.
    assert.deepEqual(read.steps[0].generations[1].coverage.reasons, ['receipt-missing']);
    assert.deepEqual(read.steps[0].generations[1].scopeRevision, 2);
    const words = on.sflow('spec', 'dependencies', 'fix-design');
    assert.match(words, /fix-design generation 1: resolved; 2 input, 1 citation\./u);
    assert.match(words, /\n {2}input: DEP-1:AC-001, DEP-1:AC-002\n/u);

    // A record changed after it was committed, or a revision whose digest no longer matches, reads unresolved.
    const designRecord = path.join(on.root, storyOn.phases['fix-design'].dependencyRecords[0].path);
    await writeFile(designRecord, (await readFile(designRecord, 'utf8')).replace(`"clause": "${WORK}:AC-002",\n      "path"`, `"clause": "${WORK}:AC-001",\n      "path"`));
    const tampered = await stepDependencies(on.root, storyOn, { step: 'fix-design' });
    assert.deepEqual(tampered.steps[0].generations[0].coverage, { state: 'unresolved', reasons: ['record-digest'] });
    const broken = structuredClone(storyOn);
    broken.scopeRevisions[0].at = '2026-01-01T00:00:00.000Z';
    const unchained = await stepDependencies(on.root, broken, { step: 'implement' });
    assert.equal(unchained.chain.verified, false);
    assert.ok(unchained.steps[0].generations[0].coverage.reasons.includes('scope-chain'));
  });
