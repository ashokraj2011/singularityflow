/**
 * How big an intent amendment is, under SPEC-CIC switch 3 [SPEC-CIC v1.1 stage 6; CIC:REQ-013, REQ-014, REQ-018,
 * REQ-019; owner decisions 2026-11-14]. `spec.changeImpact: on` pins switches 1 and 3 together. Registered, model-free
 * rules set the lowest class a change can have (editorial, refinement or material) with its reasons; a proposer may
 * only suggest a stricter class (a lower one is raised to the floor, never refused), an approver may raise it when
 * deciding, and nobody goes below the floor. An editorial change carries the evidence of the clauses it rewords and
 * the record says so; a refinement takes the route as it was; a material change is approved by the scope-change
 * authority. With the switch off, and on a Story pinned before it, nothing new is written.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { classedApproval, classFloor, classWords, deciders, effectiveClass, requestedClass } from '../src/amendment-class.mjs';
import { amendmentRepeatWords } from '../src/decision-list.mjs';
import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import { deriveReport, renderHtml, renderMarkdown, requirementChanges } from '../src/report.mjs';
import { carriedEvidence, editorialCarriers } from '../src/scope/carried-evidence.mjs';
import { acceptedClauses, recordScopeRevision } from '../src/scope/revisions.mjs';
import { normalizeSpecPolicy } from '../src/specifications.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('the rules set the floor from the diff and the bindings, each with its rule ID [CIC:REQ-013]', () => {
  const rules = (input) => classFloor(input).reasons.map((reason) => `${reason.rule}:${reason.class}`);
  const planned = { 'W-1:REQ-001': { expectedPaths: ['src/a.mjs'], tests: [] }, 'W-1:AC-001': { expectedPaths: ['src/a.mjs'], tests: ['test/a.test.mjs'] } };
  // Wording only: an untested requirement, no binding change.
  assert.deepEqual(classFloor({ diff: { revised: ['W-1:REQ-001'] }, planned }), { floor: 'editorial', reasons: [{ rule: 'wording-only', class: 'editorial', clauses: ['W-1:REQ-001'] }] });
  // A tested acceptance clause: a refinement, for two reasons [CIC:AC-013].
  assert.deepEqual(rules({ diff: { revised: ['W-1:AC-001'] }, planned }), ['tested-clause:refinement', 'acceptance-clause:refinement']);
  assert.deepEqual(classFloor({ diff: { revised: ['W-1:AC-001'] }, planned }).reasons[0].tests, ['test/a.test.mjs']);
  // A test the code step bound counts as much as a planned one.
  assert.deepEqual(rules({ diff: { revised: ['W-1:REQ-001'] }, planned, observed: { 'W-1:REQ-001': { tests: ['test/b.test.mjs'] } } }), ['tested-clause:refinement']);
  assert.deepEqual(rules({ diff: { removed: ['W-1:REQ-002'] }, planned }), ['removes-clause:refinement']);
  assert.deepEqual(rules({ diff: { added: ['W-1:REQ-003'] }, planned }), ['adds-clause:material']);
  // A carried row that moves a path or a test changes bindings; one inside the plan is a refinement, one outside widens it.
  const replace = (to) => [{ op: 'replace-location', clauseId: 'W-1:REQ-001', from: 'src/a.mjs', to }];
  assert.deepEqual(rules({ diff: { revised: ['W-1:REQ-001'] }, planned, operations: replace('src/a.mjs'), admitted: ['src/a.mjs'] }), ['changes-bindings:refinement']);
  assert.deepEqual(rules({ diff: { revised: ['W-1:REQ-001'] }, planned, operations: replace('src/b.mjs'), admitted: ['src/a.mjs'] }), ['changes-bindings:refinement', 'widens-paths:material']);
  assert.deepEqual(rules({ diff: { revised: ['W-1:REQ-001'] }, planned, operations: [{ op: 'keep-row', clauseId: 'W-1:REQ-001' }] }), ['wording-only:editorial'], 'a kept row binds nothing new');
  // A path under a protected path changes who must approve.
  assert.deepEqual(rules({ diff: { revised: ['W-1:REQ-001'] }, planned, operations: replace('infra/prod/a.tf'), admitted: ['infra'], protectedPaths: ['infra/prod'] }),
    ['changes-bindings:refinement', 'changes-authority:material']);
  // A scope that plans its own clauses: its amended rows are compared with the ones it had.
  assert.deepEqual(rules({ diff: { revised: ['W-1:REQ-001'] }, planned, admitted: ['src/a.mjs'],
    scopePlanned: { before: { 'W-1:REQ-001': { expectedPaths: ['src/a.mjs'], tests: [] } }, after: { 'W-1:REQ-001': { expectedPaths: ['src/a.mjs'], tests: ['test/n.test.mjs'] } } } }),
  ['changes-bindings:refinement']);
  // What cannot be read takes the stricter class.
  assert.deepEqual(rules({ diff: { revised: ['W-1:REQ-001'] }, planned, unreadable: ['the amended scope\'s plan'] }), ['bindings-unreadable:material']);
  assert.equal(classFloor({ diff: { added: ['W-1:REQ-9'], revised: ['W-1:AC-001'] }, planned }).floor, 'material', 'the strictest reason sets the floor');
});

test('a suggestion can only make it stricter, a person may only raise it, and nobody goes below the floor', () => {
  const floor = { floor: 'refinement', reasons: [{ rule: 'tested-clause', class: 'refinement', clauses: ['W-1:AC-001'], tests: ['test/a.test.mjs'] }] };
  // An editorial suggestion of a tested clause is raised to the floor, and the words say why [CIC:AC-013].
  const suggested = effectiveClass(floor, { stored: { floor: 'refinement', suggested: { class: 'editorial', by: 'agent' } } });
  assert.equal(suggested.effective, 'refinement');
  assert.deepEqual(classWords(suggested, { name: (id) => id.slice(4), scopeName: 'Scope', groups: ['product'] }), [
    'How big: a refinement. AC-001 has a bound test (test/a.test.mjs) [tested-clause].',
    'It was suggested as an editorial change; the rules raise it to a refinement, as the reasons above say.',
    'Who decides: Scope\'s approvers (product).']);
  assert.equal(effectiveClass(floor, { stored: { floor: 'refinement', suggested: { class: 'material' } } }).effective, 'material', 'a stricter suggestion stands');
  // A floor computed later never drops below the one recorded at proposal.
  assert.equal(effectiveClass({ floor: 'editorial', reasons: [] }, { stored: floor }).floor, 'refinement');
  // An approver's raise is kept with who, from what and to what.
  const raised = effectiveClass(floor, { decisions: [{ decision: 'approved', actor: { name: 'Pat Lee' }, raise: { from: 'refinement', to: 'material' }, at: 'T' }] });
  assert.deepEqual([raised.effective, raised.raises], ['material', [{ by: 'Pat Lee', from: 'refinement', to: 'material', at: 'T' }]]);
  // Raise only, on an approval only.
  const workflow = { resolution: { spec: { changeImpact: 'on' } } };
  const scopePolicy = { authorities: ['product'], requiredAuthorities: [], minimum: 1 };
  const ids = { amendment: 'AMD-001', workId: 'W-1' };
  assert.throws(() => classedApproval(workflow, scopePolicy, suggested, { decision: 'approve', raise: 'editorial', ...ids }),
    (error) => error.code === 'INTENT_AMENDMENT_CLASS_LOWERED' && /never lower it/u.test(error.message)
      && error.details.actions.map((entry) => entry.command).join('\n').includes('--decision approve --confirm AMD-001 --work-id W-1 --class material'));
  assert.throws(() => classedApproval(workflow, scopePolicy, null, { decision: 'reject', raise: 'material', ...ids }), { code: 'INTENT_AMENDMENT_CLASS_INVALID' });
  const raise = classedApproval(workflow, scopePolicy, suggested, { decision: 'approve', raise: 'material', ...ids });
  assert.deepEqual([raise.approves, raise.raise], ['material', { from: 'refinement', to: 'material' }]);
  assert.equal(raise.counts({ class: 'refinement' }), false, 'an approval of a lower class no longer counts');
  assert.equal(raise.counts({ class: 'material' }), true);
  assert.equal(raise.counts({}), true, 'a decision recorded before the switch counts as it did');
  assert.equal(classedApproval(workflow, scopePolicy, suggested, { decision: 'approve', raise: 'refinement', ...ids }).raise, null, 'the same class is no raise');
  assert.throws(() => requestedClass('huge'), { code: 'INTENT_AMENDMENT_CLASS_INVALID' });
});

test('a material change is decided by the scope-change authority, by default the scope step\'s own groups [CIC:REQ-014]', () => {
  const scopePolicy = { authorities: ['product'], requiredAuthorities: ['product'], minimum: 2, allowSelfApproval: false };
  assert.deepEqual(deciders({ resolution: { spec: { changeImpact: 'on' } } }, scopePolicy, 'material'), { groups: ['product'], authority: null, policy: scopePolicy });
  const named = deciders({ resolution: { spec: { changeImpact: 'on', scopeChangeAuthority: 'architecture' } } }, scopePolicy, 'material');
  assert.deepEqual([named.groups, named.authority, named.policy.minimum, named.policy.allowSelfApproval, named.policy.requiredAuthorities], [['architecture'], 'architecture', 2, false, []]);
  assert.deepEqual(deciders({ resolution: { spec: { changeImpact: 'on', scopeChangeAuthority: 'architecture' } } }, scopePolicy, 'refinement').groups, ['product'],
    'the authority decides material changes only');
});

test('change impact is one setting that pins switches 1 and 3 together, on by default; off pins off [CIC:REQ-018, AC-017; owner, 2026-11-15]', () => {
  const byDefault = normalizeSpecPolicy({ mode: 'record' });
  assert.deepEqual([byDefault.changeImpact, byDefault.observedDependencies, Object.hasOwn(byDefault, 'scopeChangeAuthority')], ['on', 'on', false]);
  const off = normalizeSpecPolicy({ mode: 'record', changeImpact: 'off' });
  assert.deepEqual([off.changeImpact, Object.hasOwn(off, 'observedDependencies')], ['off', false]);
  assert.deepEqual(normalizeSpecPolicy(off), off, 'normalizing an opted-out policy again keeps it off');
  // A workflow that turned switch 1 off and named no change impact opted out before the default, and still has.
  assert.deepEqual(normalizeSpecPolicy({ mode: 'record', observedDependencies: 'off' }), off);
  const on = normalizeSpecPolicy({ mode: 'record', changeImpact: 'on', scopeChangeAuthority: 'architecture' });
  assert.deepEqual([on.changeImpact, on.observedDependencies, on.scopeChangeAuthority], ['on', 'on', 'architecture']);
  assert.deepEqual(normalizeSpecPolicy(on), on, 'normalizing a pinned policy again changes nothing');
  // Switch 1 alone stays valid: change impact off, observed dependencies on.
  const alone = normalizeSpecPolicy({ changeImpact: 'off', observedDependencies: 'on' });
  assert.deepEqual([alone.observedDependencies, alone.changeImpact], ['on', 'off']);
  assert.throws(() => normalizeSpecPolicy({ changeImpact: 'on', observedDependencies: 'off' }), /records observed dependencies too/u);
  assert.throws(() => normalizeSpecPolicy({ changeImpact: 'off', scopeChangeAuthority: 'architecture' }), /under spec\.changeImpact: on/u);
  assert.throws(() => normalizeSpecPolicy({ changeImpact: 'yes' }), /must be off or on/u);
});

// The evidence of an editorial change is carried, and says so [CIC:REQ-014, CON-003, AC-014].
const W = 'ED-1';
const REQ = `${W}:REQ-001`;
const hash = (letter) => letter.repeat(64);
function editorialEvaluation({ changeImpact = 'on', carried = 'editorial' } = {}) {
  const policy = { mode: 'required', minimum: 1, authorities: ['reviewers'], requiredAuthorities: [] };
  const approval = { decision: 'approved', actor: { name: 'Pat Lee', login: 'patlee' }, authorityGroup: 'reviewers', at: '2026-11-14T00:00:00Z' };
  const workflow = { workItem: { id: W, title: 'Editorial' }, status: 'in_progress', currentPhase: 'testing', phaseOrder: ['intake', 'implementation', 'testing'],
    resolution: { plannedClaims: { mode: 'required', clausePhases: ['intake'], owners: { implementation: 'intake' } }, spec: changeImpact === 'on' ? { changeImpact, observedDependencies: 'on' } : {} },
    phases: {
      intake: { id: 'intake', status: 'approved', generation: 1, approvalPolicy: policy, approvals: [approval], requiredArtifact: { kind: 'requirements' } },
      implementation: { id: 'implementation', status: 'approved', generation: 1, approvalPolicy: policy, approvals: [approval], generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' } },
      testing: { id: 'testing', status: 'in_progress', generation: 1, approvalPolicy: policy, approvals: [], requiredArtifact: { kind: 'test-evidence' } }
    },
    intentAmendments: [{ id: 'AMD-001', status: 'approved', changedClauses: [REQ], staleClauses: [REQ], decidedAt: '2026-11-14T01:00:00Z',
      decision: { decision: 'approved', actor: { name: 'Pat Lee', login: 'patlee' }, authorityGroup: 'reviewers', at: '2026-11-14T01:00:00Z', class: 'editorial' },
      ...(carried ? { carried, class: 'editorial' } : {}) }] };
  const index = (generation, body) => ({ workId: W, phase: 'intake', generation, clauses: [{ id: REQ, type: 'REQ', source: { path: 'intake.md', line: 3 }, bodySha256: body, dependsOn: [] }] });
  // The scope is approved before any later step runs; they publish after it, and then it is amended.
  for (const id of ['implementation', 'testing']) workflow.phases[id].generation = 0;
  recordScopeRevision(workflow, { clauses: acceptedClauses([index(1, hash('a'))]), origin: { kind: 'approval', phase: 'intake', generation: 1 }, at: '2026-11-14T00:00:00.000Z' });
  for (const id of ['implementation', 'testing']) workflow.phases[id].generation = 1;
  workflow.phases.intake.generation = 2;
  recordScopeRevision(workflow, { clauses: acceptedClauses([index(2, hash('b'))]), origin: { kind: 'intent-amendment', id: 'AMD-001', phase: 'intake', generation: 2 }, at: '2026-11-14T01:00:00.000Z' });
  const claim = { expectedPaths: ['src/value.mjs'], tests: [], testDisposition: 'unspecified', testReason: null };
  const evaluation = evaluateEvidence(evidenceGraph({ workflow, deliveries: [{ phaseId: 'implementation', generation: 1, status: 'ready', testRecovery: null,
    receipt: { status: 'ready', traceability: { bindings: [] } }, executions: [] }],
  records: { indexes: [index(2, hash('b'))], planned: [{ workId: W, phase: 'intake', generation: 2, kind: 'planned', claims: { [REQ]: claim } }],
    observed: [{ workId: W, phase: 'implementation', generation: 1, kind: 'observed', claims: { [REQ]: { observedPaths: ['src/value.mjs'], testResults: [], commits: [], verdict: 'matched' } } }], acceptance: [] } }));
  return { workflow, row: evaluation.rows.find((entry) => entry.id === REQ) };
}

test('an amendment approved as editorial carries every step\'s evidence of the reworded clause, labelled; nothing else does [CIC:AC-014]', () => {
  const { workflow, row } = editorialEvaluation();
  assert.ok(row.obligations.every((entry) => entry.facets.freshness === 'current'), 'nothing is stale');
  assert.ok(row.obligations.some((entry) => entry.carriedBy?.some((carrier) => carrier.editorial && carrier.amendment === 'AMD-001')));
  const label = row.findings.find((entry) => entry.code === 'EVIDENCE_CARRIED_BY_REVALIDATION');
  assert.match(label.message, /evidence predates AMD-001's wording; Pat Lee, for the scope approvers \(reviewers\), approved it as editorial, so it is carried\./u);
  assert.equal(label.blocking, false);
  assert.deepEqual(carriedEvidence(workflow).map((entry) => [entry.amendment, entry.editorial, entry.words]), [['AMD-001', true,
    `${REQ}: evidence predates AMD-001's wording; Pat Lee, for the scope approvers (reviewers), approved it as editorial, so every step's evidence of it is carried.`]]);
  // Not editorial, or a Story without the switch: stale as before.
  for (const options of [{ carried: null }, { changeImpact: 'off' }]) {
    const stale = editorialEvaluation(options);
    assert.ok(stale.row.findings.some((entry) => entry.code === 'EVIDENCE_STALE_AFTER_SCOPE_REVISION'), JSON.stringify(options));
    assert.equal(editorialCarriers(stale.workflow).size, 0);
  }
});

test('a clause reversed twice shows in the preview and the Story report, with the churn; nothing limits it [CIC:AC-016, REQ-016]', () => {
  const body = (letter) => letter.repeat(64);
  const revision = (number, letter) => ({ revision: number, clauses: [{ id: 'R-1:AC-001', bodySha256: body(letter) }, { id: 'R-1:REQ-001', bodySha256: body('z') }] });
  const workflow = { workItem: { id: 'R-1', title: 'Report' }, status: 'in_progress', phaseOrder: ['scope'], history: [],
    phases: { scope: { id: 'scope', label: 'Scope', status: 'approved', generation: 4, approvals: [], usage: [] } }, resolution: { spec: { changeImpact: 'on' } },
    intentAmendments: ['refinement', 'refinement', 'editorial'].map((name, index) => ({ id: `AMD-00${index + 1}`, status: 'approved', class: name, changedClauses: ['R-1:AC-001'] })),
    scopeRevisions: [revision(1, 'a'), revision(2, 'b'), revision(3, 'a'), revision(4, 'b')] };
  assert.deepEqual(requirementChanges(workflow), { amendments: 3, byClass: { refinement: 2, editorial: 1 },
    churn: [{ clause: 'R-1:AC-001', times: 3 }], reversed: [{ clause: 'R-1:AC-001', times: 2 }] });
  const markdown = renderMarkdown(deriveReport(workflow, { now: '2026-11-14T00:00:00Z' }));
  for (const line of ['## Requirement changes', '- 3 intent amendments approved: 2 refinement, 1 editorial.', '- `R-1:AC-001` changed 3 times.',
    '- `R-1:AC-001` went back to an earlier statement 2 times.']) assert.ok(markdown.includes(line), line);
  assert.match(renderHtml(deriveReport(workflow, { now: '2026-11-14T00:00:00Z' })), /<h2>Requirement changes<\/h2>/u);
  // The preview says it in the same terms (stage 2's words, from the effect's repeats).
  assert.deepEqual(amendmentRepeatWords(workflow, { repeated: [{ clause: 'R-1:AC-001', times: 3 }], reversed: ['R-1:AC-001'] }),
    ['AC-001 has now been changed 3 times on this Story.', 'AC-001 goes back to a statement an earlier scope revision held.']);
  // Without change impact the report is as it was.
  const off = { ...workflow, resolution: {} };
  assert.equal(requirementChanges(off), null);
  assert.equal(renderMarkdown(deriveReport(off, { now: '2026-11-14T00:00:00Z' })).includes('Requirement changes'), false);
});

async function fixture(t, { changeImpact = 'on', authority = null } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-cic-classes-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Cone Tester', SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'w.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'a.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'l.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'c.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Cone Tester', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'cone@example.invalid' };
  const run = (command, args, cwd = root, extra = {}) => spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: childTimeout(180_000) });
  const must = (command, args, cwd = root, extra = {}) => {
    const result = run(command, args, cwd, extra);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  const refused = (args, extra = {}) => {
    const result = run(process.execPath, [cli, '--no-model', ...args, '--json'], root, extra);
    assert.notEqual(result.status, 0, `${args.join(' ')} should be refused\n${result.stdout}`);
    const parsed = JSON.parse(result.stdout || result.stderr);
    return { ...(parsed.error ?? parsed), plan: parsed.remediationPlan ?? null };
  };
  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'src/value.mjs'), '// The single export of this module.\nexport const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n");
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const group of Object.values(config.approvalAuthorities)) group.allowAnyGitIdentity = true;
  if (authority) config.approvalAuthorities[authority] = { label: 'Scope-change authority', allowAnyGitIdentity: false, members: [{ email: 'scope.owner@example.com', name: 'Scope Owner' }] };
  config.spec = { ...(config.spec ?? {}), changeImpact, ...(authority ? { scopeChangeAuthority: authority } : {}) };
  delete config.phases['fix-design'].clarification;
  config.workTypes['quick-design'] = { ...config.workTypes['quick-fix'], phases: ['intake', 'fix-design', 'implement', 'verify'] };
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Change class fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  const itemPath = (id, ...parts) => path.join(root, 'singularity/work-items', id, ...parts);
  const intake = (id) => [
    `# ${id} — Quick fix scope and plan`, '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    `- [${id}:REQ-001] The value module opens with one comment that names its export.`, '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${id}:AC-001] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    `| \`${id}:REQ-001\` | \`src/value.mjs\` | not-applicable: A reviewer reads the module's opening comment. | existing | The comment names the export. |`,
    `| \`${id}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | The test reads 2. |`, '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');
  const designed = async (id, { approveDesign = true } = {}) => {
    sflow('start', id, '--from-branch', 'main', '--work-type', 'quick-design', '--title', 'Change the value', '--description', 'Return 2.');
    sflow('prepare', 'intake');
    await writeFile(itemPath(id, 'artifacts/intake/intake.md'), intake(id));
    sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
    sflow('submit', 'intake');
    sflow('approve', 'intake', '--yes');
    sflow('prepare', 'fix-design');
    await writeFile(itemPath(id, 'artifacts/fix-design/fix-design.md'), [`# ${id} — Fix Design`, '', '## Root cause', '',
      'The exported constant holds the old value; nothing computes it.', '', '## Minimal safe change', '',
      'Change the literal in src/value.mjs only, so no import changes.', '',
      '## Alternatives and regression risk', '', 'A computed value was rejected as unnecessary; the only regression surface is the one test that reads it.', ''].join('\n'));
    sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
    sflow('submit', 'fix-design');
    if (approveDesign) sflow('approve', 'fix-design', '--yes');
  };
  const workflow = async (id) => JSON.parse(await readFile(itemPath(id, 'workflow.json'), 'utf8'));
  const draft = async (id, name, edit) => {
    const file = path.join(base, `${id}-${name}.md`);
    await writeFile(file, edit(await readFile(itemPath(id, 'artifacts/intake/intake.md'), 'utf8')));
    return file;
  };
  const preview = (...args) => JSON.parse(sflow('story', 'intent-amendment', 'preview', ...args, '--json'));
  return { base, root, sflow, run, refused, workflow, designed, itemPath, draft, preview, configPath };
}

const rewordRequirement = (text) => text.replace('opens with one comment that names its export', 'begins with a single comment naming its export');
const reviseCriterion = (text) => text.replace('The exported value equals 2. |', 'The exported value equals 2, a number. |');

test('a tested criterion proposed as editorial is a refinement, said why, and takes the route as it was [CIC:AC-013]', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await fixture(t);
  await f.designed('CL-1');
  const file = await f.draft('CL-1', 'criterion', reviseCriterion);
  const previewed = f.preview('--file', file, '--class', 'editorial');
  assert.deepEqual([previewed.effect.classification.floor, previewed.effect.classification.effective, previewed.effect.classification.suggested?.class],
    ['refinement', 'refinement', 'editorial']);
  assert.deepEqual(previewed.effect.classification.reasons.map((reason) => reason.rule), ['tested-clause', 'acceptance-clause']);
  assert.ok(previewed.summary.includes('How big: a refinement. AC-001 has a bound test (test/value.test.mjs) [tested-clause]; AC-001 is an acceptance criterion [acceptance-clause].'), previewed.summary.join('\n'));
  assert.ok(previewed.summary.includes('It was suggested as an editorial change; the rules raise it to a refinement, as the reasons above say.'));
  assert.ok(previewed.summary.some((line) => /^Who decides: Scope and plan's approvers \(/u.test(line) || /^Who decides: .+'s approvers \(/u.test(line)), previewed.summary.join('\n'));
  assert.equal(previewed.effect.carried, undefined);
  // The agent view says the same within its 4,000 bytes; the whole result is kept for it to read.
  const agent = f.run(process.execPath, [cli, '--no-model', 'story', 'intent-amendment', 'preview', '--file', file, '--class', 'editorial', '--for-agent', '--json'], f.root,
    { SINGULARITY_FLOW_AGENT_OUTPUT: '' });
  assert.equal(agent.status, 0, agent.stderr);
  assert.ok(Buffer.byteLength(agent.stdout) <= 4_000 + 200, `the agent view stays within its 4,000 bytes (${Buffer.byteLength(agent.stdout)})`);
  assert.match(agent.stdout, /How big: a refinement/u);
  const proposed = JSON.parse(f.sflow('story', 'intent-amendment', 'propose', '--file', file, '--reason', 'Say the value is numeric.', '--class', 'editorial', '--json'));
  const { classification } = proposed.proposal;
  assert.deepEqual([classification.floor, classification.effective, classification.suggested.class, classification.suggested.by], ['refinement', 'refinement', 'editorial', 'cone.tester@example.com']);
  assert.equal((await f.workflow('CL-1')).intentAmendments.at(-1).class, 'refinement');
  // The card says the same, and offers raising it to material; never lowering it.
  const list = JSON.parse(f.sflow('decisions', 'CL-1', '--json'));
  const item = (list.data ?? list).items.find((entry) => entry.kind === 'intent-amendment');
  assert.match(item.details.reach, /^How big: a refinement\. AC-001 has a bound test/u);
  assert.deepEqual(item.options.map((entry) => entry.id), ['reject', 'approve', 'approve-material']);
  assert.match(item.options.find((entry) => entry.id === 'approve-material').terminal, /--class material$/u);
  // A person cannot lower it in their terminal either.
  const lowered = f.refused(['story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001', '--class', 'editorial']);
  assert.equal(lowered.code, 'INTENT_AMENDMENT_CLASS_LOWERED');
  f.sflow('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001');
  const story = await f.workflow('CL-1');
  const summary = story.intentAmendments.at(-1);
  assert.equal(summary.status, 'approved');
  assert.equal(summary.acknowledgementRequired, true, 'a refinement is acknowledged as before');
  assert.equal(summary.carried, undefined);
  assert.equal(story.currentPhase, 'fix-design', 'the route as it was: the first step that cites nothing changed is kept, the rest run again');
  const record = JSON.parse(await readFile(path.join(f.root, summary.recordPath), 'utf8'));
  assert.deepEqual(record.application.class, { floor: 'refinement', rules: ['tested-clause', 'acceptance-clause'], suggested: classification.suggested, effective: 'refinement' });
  assert.equal(record.decisions.at(-1).class, 'refinement');
});

test('a reworded untested requirement approved as editorial resets nothing, carries its evidence and says so [CIC:AC-014]', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await fixture(t);
  await f.designed('CL-2');
  const file = await f.draft('CL-2', 'wording', rewordRequirement);
  const previewed = f.preview('--file', file);
  assert.deepEqual([previewed.effect.classification.floor, previewed.effect.classification.effective, previewed.effect.carried], ['editorial', 'editorial', 'editorial']);
  assert.deepEqual(previewed.effect.steps.map((step) => [step.phase, step.outcome]), [['fix-design', 'carried'], ['implement', 'unchanged'], ['verify', 'unchanged']]);
  assert.ok(previewed.summary.includes('Fix design keeps its approval, and its evidence of the reworded clauses is carried: the change is editorial.'), previewed.summary.join('\n'));
  assert.ok(previewed.summary.some((line) => line.startsWith('How big: an editorial change. It only rewords REQ-001')), previewed.summary.join('\n'));
  const before = await f.workflow('CL-2');
  f.sflow('story', 'intent-amendment', 'propose', '--file', file, '--reason', 'Clearer wording, same meaning.');
  const list = JSON.parse(f.sflow('decisions', 'CL-2', '--json'));
  const item = (list.data ?? list).items.find((entry) => entry.kind === 'intent-amendment');
  assert.deepEqual(item.options.map((entry) => entry.id), ['reject', 'approve', 'approve-refinement', 'approve-material'], 'an approver may raise it');
  assert.match(item.options.find((entry) => entry.id === 'approve').words, /approved as editorial/u);
  f.sflow('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001');
  const story = await f.workflow('CL-2');
  const summary = story.intentAmendments.at(-1);
  assert.deepEqual([summary.status, summary.class, summary.carried, summary.acknowledgementRequired], ['approved', 'editorial', 'editorial', false]);
  assert.equal(story.currentPhase, before.currentPhase, 'the Story stays where it was');
  assert.deepEqual(['fix-design', 'implement', 'verify'].map((id) => [story.phases[id].status, story.phases[id].generation]),
    ['fix-design', 'implement', 'verify'].map((id) => [before.phases[id].status, before.phases[id].generation]), 'no step reset');
  assert.equal(story.phases['fix-design'].retention, undefined, 'kept by the editorial carry, not by rule E8');
  assert.equal(story.scopeRevisions.at(-1).origin.id, 'AMD-001', 'the amended wording is a scope revision as before');
  const record = JSON.parse(await readFile(path.join(f.root, summary.recordPath), 'utf8'));
  assert.deepEqual([record.application.carried, record.application.carriedPhases, record.application.class.effective, record.decisions.at(-1).class],
    ['editorial', ['fix-design'], 'editorial', 'editorial']);
  assert.match(story.history.findLast((entry) => entry.event === 'intent_amendment_approved').detail, /approved as editorial, so the evidence of CL-2:REQ-001 is carried and no step runs again/u);
  // Nothing waits for an acknowledgement.
  assert.equal(JSON.parse(f.sflow('decisions', 'CL-2', '--json')).items?.some?.((entry) => entry.kind === 'intent-amendment') ?? false, false);

  // Proposed while a step waits for its approval: the editorial approval changes nothing it was reviewed on, so its
  // approvers approve it as submitted; nothing stalls and nothing loops back.
  await f.designed('CL-5', { approveDesign: false });
  const waiting = await f.draft('CL-5', 'wording', rewordRequirement);
  f.sflow('story', 'intent-amendment', 'propose', '--file', waiting, '--reason', 'Clearer wording, same meaning.');
  f.sflow('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001');
  assert.equal((await f.workflow('CL-5')).phases['fix-design'].status, 'awaiting_approval');
  f.sflow('approve', 'fix-design', '--yes');
  assert.equal((await f.workflow('CL-5')).phases['fix-design'].status, 'approved');
});

test('a material change is approved by the scope-change authority: anyone else is refused, told who decides and how [CIC:REQ-014]', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await fixture(t, { authority: 'scope-change' });
  await f.designed('CL-3');
  // A scope approver outside the authority (the Story's starter is enrolled in every group) raises a refinement to
  // material and is refused: nothing is recorded, and they are told who decides it and how.
  const file = await f.draft('CL-3', 'criterion', reviseCriterion);
  f.sflow('story', 'intent-amendment', 'propose', '--file', file, '--reason', 'Say the value is numeric.');
  const outsider = { SINGULARITY_FLOW_TEST_IDENTITY: 'Other Approver', GIT_CONFIG_VALUE_0: 'Other Approver', GIT_CONFIG_VALUE_1: 'other.approver@example.com' };
  const refusal = f.refused(['story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001', '--class', 'material'], outsider);
  assert.equal(refusal.code, 'INTENT_AMENDMENT_MATERIAL_AUTHORITY');
  assert.match(refusal.message, /only a person in the scope-change authority, scope-change: scope\.owner@example\.com/u);
  // As a refinement it is still theirs to approve: the authority decides material changes only.
  assert.equal(f.run(process.execPath, [cli, '--no-model', 'story', 'intent-amendment', 'preview', 'AMD-001', '--json'], f.root, outsider).status, 0);
  // Its routes: the Decide card, then the person's own terminal; it stays in this step [PHR:REQ-006].
  const routes = refusal.plan.steps.filter((entry) => entry.command);
  assert.match(routes[0].command, /^singularity-flow decisions CL-3\b/u);
  assert.match(routes[1].command, /^singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001 --work-id CL-3$/u);
  assert.ok(!routes.some((entry) => /^singularity-flow (?:recover|reject) /u.test(entry.command)), 'nothing sends the person out of the step');
  assert.equal((await f.workflow('CL-3')).intentAmendments.at(-1).status, 'proposed', 'nothing was recorded');
  // A refinement is still the scope's approvers' to approve; the owner raises and approves it as material.
  const owner = { GIT_CONFIG_VALUE_0: 'Scope Owner', GIT_CONFIG_VALUE_1: 'scope.owner@example.com', SINGULARITY_FLOW_TEST_IDENTITY: 'Scope Owner' };
  const raised = f.run(process.execPath, [cli, '--no-model', 'story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001', '--class', 'material'], f.root, owner);
  assert.equal(raised.status, 0, raised.stderr);
  const story = await f.workflow('CL-3');
  const summary = story.intentAmendments.at(-1);
  assert.deepEqual([summary.status, summary.class], ['approved', 'material']);
  const record = JSON.parse(await readFile(path.join(f.root, summary.recordPath), 'utf8'));
  assert.deepEqual([record.decisions.at(-1).class, record.decisions.at(-1).raise, record.decisions.at(-1).authorityGroup], ['material', { from: 'refinement', to: 'material' }, 'scope-change']);
  assert.deepEqual(record.application.class.raises.map((entry) => [entry.from, entry.to]), [['refinement', 'material']]);
  // An added clause is material by the rules alone, and the preview says who decides it.
  const added = await f.draft('CL-3', 'added', (text) => text.replace('## Acceptance criteria', '- [CL-3:REQ-002] The module keeps no other state.\n\n## Acceptance criteria')
    .replace('| `CL-3:AC-001` |', '| `CL-3:REQ-002` | `src/value.mjs` | not-applicable: A reviewer reads the module. | existing | No state remains. |\n| `CL-3:AC-001` |'));
  const materialPreview = f.preview('--file', added);
  assert.equal(materialPreview.effect.classification.effective, 'material');
  assert.ok(materialPreview.summary.includes('Who decides: the scope-change authority, scope-change: only a person in it approves a material change.'), materialPreview.summary.join('\n'));
});

test('--class on a Story without change impact is refused and the command runs without it; nothing new is written [CIC:AC-017, AC-018]', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await fixture(t, { changeImpact: 'off' });
  await f.designed('CL-4');
  const file = await f.draft('CL-4', 'criterion', reviseCriterion);
  const unavailable = f.refused(['story', 'intent-amendment', 'preview', '--file', file, '--class', 'editorial']);
  assert.equal(unavailable.code, 'INTENT_AMENDMENT_CLASS_UNAVAILABLE');
  const previewed = f.preview('--file', file);
  assert.equal(previewed.effect.classification, undefined);
  assert.ok(!previewed.summary.some((line) => line.startsWith('How big')));
  f.sflow('story', 'intent-amendment', 'propose', '--file', file, '--reason', 'Say the value is numeric.');
  f.sflow('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001');
  const story = await f.workflow('CL-4');
  const record = JSON.parse(await readFile(path.join(f.root, story.intentAmendments.at(-1).recordPath), 'utf8'));
  // No field of this stage is written anywhere with the switch off; the pinned policy says it is off, nothing more.
  assert.equal(story.resolution.spec.changeImpact, 'off');
  const keys = (value, found = new Set()) => {
    if (Array.isArray(value)) value.forEach((entry) => keys(entry, found));
    else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { if (value !== story.resolution?.spec) found.add(key); keys(entry, found); }
    return found;
  };
  for (const key of ['classification', 'class', 'carried', 'carriedPhases', 'raise', 'changeImpact', 'scopeChangeAuthority', 'observedDependencies']) {
    assert.ok(!keys(story).has(key), `workflow.json holds ${key}`);
    assert.ok(!keys(record).has(key), `the amendment record holds ${key}`);
  }

  // A Story pinned before change impact was turned on keeps its behaviour, and no earlier record is rewritten [CIC:AC-018].
  const config = YAML.parse(await readFile(f.configPath, 'utf8'));
  config.spec = { ...(config.spec ?? {}), changeImpact: 'on' };
  await writeFile(f.configPath, YAML.stringify(config));
  const pinned = await f.workflow('CL-4');
  const second = await f.draft('CL-4', 'wording', rewordRequirement);
  const later = f.preview('--file', second);
  assert.equal(later.effect.classification, undefined, 'the pinned policy decides, not the configuration now');
  assert.equal((await f.workflow('CL-4')).resolution.spec.changeImpact, 'off');
  assert.deepEqual(await f.workflow('CL-4'), pinned, 'a preview rewrites nothing');
});
