/**
 * Applicability without a person, and what proves an API [CQF:REQ-035, REQ-036; CVL 006, AC-011, AC-012].
 *
 * A Story whose workflow declares a surface with no screens (app review's own profile: backend, cli, library or
 * artifact, declared whether or not the work type adopts app review) needs no screenshot at its visual step: the step
 * is not applicable by that declaration, with its reason shown where visual coverage is shown, and nobody skips the
 * step or rules out each screen size. A web, auto or undeclared surface keeps today's rule, and a delivered UI file
 * brings the step back. A criterion the plan declares an API one is proved only by tests that assert the response's
 * status, its schema and its body, in the existing assertion check; a screenshot never proves it.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { normalizeApplicationReview } from '../src/application-review-contract.mjs';
import { evaluateCodeDeliveryPreflight } from '../src/delivery-evidence.mjs';
import { beginCodeGeneration } from '../src/generation-boundary.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { mergedVerificationContracts, normalizeVerificationContracts, parseVerificationContracts } from '../src/verification/contracts.mjs';
import { apiAssertionSignals, apiCriterionAssertionCheck } from '../src/verification/corner-case-obligations.mjs';
import { criterionProof } from '../src/verification/criterion-proof.mjs';
import { evaluateVisualCoverage, visualCoverageRefusal } from '../src/visual-coverage.mjs';
import { ensureWorkIntervalBaseline } from '../src/work-intervals.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const PHONE = { id: 'phone-390x844', label: 'Phone 390 × 844', width: 390, height: 844, deviceScaleFactor: 1 };
const TABLET = { id: 'tablet-834x1194', label: 'Tablet 834 × 1194', width: 834, height: 1194, deviceScaleFactor: 1 };

/** A Story at its visual step, under enforced coverage of two screen sizes, with the surface its workflow declares. */
async function visualStory(t, applicationReview) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-declared-surface-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const itemDirectory = path.join(root, 'singularity/work-items/LIB-1');
  await mkdir(itemDirectory, { recursive: true });
  const workflow = {
    workItem: { id: 'LIB-1', workType: 'feature' }, status: 'in_progress', currentPhase: 'visual-verification',
    phaseOrder: ['implementation', 'visual-verification'],
    phases: {
      implementation: { id: 'implementation', status: 'approved', generation: 1, generationPolicy: { task: 'code' },
        deliveryEvidence: { sourcePaths: ['src/parse.mjs'] } },
      'visual-verification': { id: 'visual-verification', status: 'in_progress', generation: 0, requiredArtifact: { kind: 'visual-test-evidence' },
        approvalPolicy: { authorities: ['design-reviewers'] } }
    },
    resolution: { workItemRoot: 'singularity/work-items', verification: { coverage: 'enforce', profiles: [PHONE, TABLET],
      comparison: { mode: 'off', channelTolerance: 0, maxDifferingPixelRatio: null, maxDifferingPixels: null, maxPixels: 40_000_000 } },
    ...(applicationReview ? { applicationReview: normalizeApplicationReview(applicationReview) } : {}) },
    history: []
  };
  return { root, itemDirectory, workflow };
}

test('a declared library or CLI surface marks the visual step not applicable without a person, and says why', async (t) => {
  for (const surface of ['library', 'cli', 'backend']) {
    // Declared, not adopted: app review stays off, and its surface profile still says what the Story is.
    const { root, itemDirectory, workflow } = await visualStory(t, { mode: 'off', surface });
    const coverage = await evaluateVisualCoverage(root, workflow, { itemDirectory });
    assert.equal(coverage.status, 'not-applicable', surface);
    assert.equal(coverage.reason, 'declared-surface');
    assert.deepEqual([coverage.errors, coverage.uncovered, coverage.covered], [[], [], []]);
    assert.equal(Object.hasOwn(coverage, 'notApplicable'), false, 'no person decided any screen size');
    assert.equal(coverage.applicability.surface, surface);
    assert.equal(coverage.applicability.declaredIn, 'applicationReview.surface');
    assert.equal(coverage.applicability.decidedBy, 'workflow configuration');
    assert.match(coverage.applicability.words, new RegExp(`^Visual check not applicable: this Story's workflow declares a ${surface} surface \\(applicationReview\\.surface\\), which has no screens`, 'u'));
    assert.match(coverage.applicability.words, /nobody has to skip the step or rule out a screen size/u);
    assert.doesNotMatch(coverage.applicability.words, /sha256|[0-9a-f]{40}/u, 'plain words, no hashes');
    // Publication and submission check the same thing: nothing refuses, so nobody skips the step.
    const { refusal } = await visualCoverageRefusal(root, workflow, { itemDirectory, generation: 1 });
    assert.equal(refusal, null, surface);
  }
});

test('a web, auto or undeclared surface still needs a capture or a person, and a delivered UI file brings the step back', async (t) => {
  for (const declared of [undefined, { mode: 'off', surface: 'web' }, { mode: 'off', surface: 'auto' }, { mode: 'optional' }]) {
    const { root, itemDirectory, workflow } = await visualStory(t, declared);
    const coverage = await evaluateVisualCoverage(root, workflow, { itemDirectory });
    assert.equal(coverage.status, 'fail', JSON.stringify(declared));
    assert.deepEqual(coverage.uncovered, [PHONE.id, TABLET.id]);
    assert.equal(coverage.applicability, undefined);
    const { refusal } = await visualCoverageRefusal(root, workflow, { itemDirectory, generation: 1 });
    assert.equal(refusal.code, 'VISUAL_COVERAGE_FAILED');
    assert.ok(refusal.details.nextAction?.command.startsWith('singularity-flow visual record --phase visual-verification '), JSON.stringify(refusal.details.nextAction));
  }
  // The declaration is never weakened by the diff, only strengthened: a code step that delivered a screen is checked.
  const { root, itemDirectory, workflow } = await visualStory(t, { mode: 'off', surface: 'library' });
  workflow.phases.implementation.deliveryEvidence.sourcePaths.push('src/Preview.tsx');
  const coverage = await evaluateVisualCoverage(root, workflow, { itemDirectory });
  assert.equal(coverage.status, 'fail');
  assert.deepEqual(coverage.uncovered, [PHONE.id, TABLET.id]);
});

// ---------------------------------------------------------------------------------------------------------------
// The whole route, on the real binary: a library Story's enforced visual step publishes and submits with no capture.

const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const OMITTED = 'This test workflow checks one step and delivers nothing else.';
function execute(command, args, cwd, { allowFailure = false, selection } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Singularity Flow Test' };
  if (selection) env.SINGULARITY_FLOW_TEST_SELECTION = JSON.stringify(selection);
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: childTimeout(180_000) });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

test('a library Story passes its enforced visual step with no screenshot, no skip and no screen size ruled out', slowLane({ timeout: 300_000 }), async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-declared-library-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  await mkdir(root);
  execute('git', ['init', '-b', 'main'], root);
  execute('git', ['config', 'user.name', 'Singularity Flow Test'], root);
  execute('git', ['config', 'user.email', 'singularity-flow@example.invalid'], root);
  await writeFile(path.join(root, 'README.md'), '# Test\n');
  execute(process.execPath, [bin, 'init'], root);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.approvalSecurity = { profile: 'poc' };
  config.repositoryReadiness = { ...config.repositoryReadiness, requiredBeforeStory: false };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  const mobile = config.workTypes['figma-mobile'];
  assert.equal(mobile.verification.coverage, 'enforce', 'the packaged mobile workflow enforces its screen sizes');
  config.workTypes['library-check'] = { label: 'Library check', phases: ['visual-verification'], verification: mobile.verification,
    // The library's surface, declared with app review's profile; app review itself is not adopted.
    applicationReview: { mode: 'off', surface: 'library' },
    templateOverrides: { 'visual-verification': mobile.templateOverrides['visual-verification'] },
    documents: { allowedPhases: ['visual-verification'] },
    omits: ['scope', 'plan', 'implement'].map((responsibility) => ({ responsibility, reason: OMITTED, authority: 'quality-reviewers' })),
    phaseOverrides: { 'visual-verification': { writeScope: 'artifact-only' } }, sourceReview: { mode: 'off' } };
  await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', '-A'], root);
  execute('git', ['commit', '-m', 'initial'], root);
  execute('git', ['init', '--bare', '-b', 'main', path.join(base, 'remote.git')], root);
  execute('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')], root);
  execute('git', ['push', '-u', 'origin', 'main'], root);
  const flow = (args, options = {}) => execute(process.execPath, [bin, ...args], root, { selection: { workType: 'library-check', agent: 'qa' }, ...options });
  flow(['start', 'LIB-2', '--from-branch', 'main', '--title', 'Parse dates in the shared library']);
  flow(['prepare', 'visual-verification']);
  flow(['resume', 'LIB-2']);
  const workflowFile = path.join(root, 'singularity/work-items/LIB-2/workflow.json');
  const artifact = path.join(root, 'singularity/work-items/LIB-2',
    JSON.parse(await readFile(workflowFile, 'utf8')).phases['visual-verification'].requiredArtifact.path);
  await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'not applicable: the library has no screens, so nothing was captured.')
    .replace(/\bTODO\b/gu, 'not applicable'));

  const prepublished = JSON.parse(flow(['phase', 'prepublish', 'visual-verification', '--json'], { allowFailure: true }).stdout);
  assert.ok(!prepublished.findings.some((entry) => entry.details?.sourceCode === 'VISUAL_COVERAGE_FAILED'), JSON.stringify(prepublished.findings));
  flow(['phase', 'publish', 'visual-verification', '--authored', 'human']);
  for (const responsibility of ['scope', 'plan', 'implement']) flow(['decision', 'applicability', '--responsibility', responsibility, '--reason', OMITTED]);
  flow(['submit']);
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.phases['visual-verification'].status, 'awaiting_approval');
  assert.deepEqual(workflow.visualProfileDecisions ?? [], [], 'nobody ruled out a screen size');
  assert.notEqual(workflow.phases['visual-verification'].status, 'skipped');

  // The approver reads why, where visual coverage is shown: the visual status and the Flow Gate.
  const status = JSON.parse(flow(['visual', 'status', '--json']).stdout);
  assert.equal(status.coverage.status, 'not-applicable');
  assert.equal(status.coverage.applicability.surface, 'library');
  assert.match(flow(['visual', 'status']).stdout, /^Visual check not applicable: this Story's workflow declares a library surface \(applicationReview\.surface\)/mu);
  const gate = JSON.parse(flow(['gate', '--json'], { allowFailure: true }).stdout);
  assert.ok(gate.passes.some((entry) => entry.startsWith('Visual check not applicable: this Story\'s workflow declares a library surface')), JSON.stringify(gate.passes));
  assert.ok(!gate.errors.some((entry) => /visual/iu.test(entry)), JSON.stringify(gate.errors));
});

// ---------------------------------------------------------------------------------------------------------------
// AC-012: an API criterion's tests assert the response's status, schema and body.

const CONTRACTS = (rows, header = '| Criterion | Slot | Method | Witness | Role | Interface |') => [
  '# Plan', '', '## Verification contracts', '', header, `|${header.split('|').slice(1, -1).map(() => '---').join('|')}|`, ...rows, ''].join('\n');

test('the plan declares an API criterion; a screenshot or an inspection can never be its primary proof', () => {
  const clauseIds = ['API-1:AC-001', 'API-1:AC-002'];
  const plannedClaims = { 'API-1:AC-001': { tests: ['test/orders.test.mjs'] } };
  const [contract] = parseVerificationContracts(CONTRACTS([
    '| `API-1:AC-001` | http | test | `test/orders.test.mjs` | primary | api |',
    '| `API-1:AC-001` | screen | visual | `Order created page` | supporting | api |'
  ]), { clauseIds, plannedClaims });
  assert.equal(contract.interface, 'api');
  assert.deepEqual(normalizeVerificationContracts([contract]), [contract], 'kept when read back');
  assert.equal(mergedVerificationContracts([{ verificationContracts: [contract] }]).get('API-1:AC-001').interface, 'api');
  // Without the column, nothing changes: no interface, so the record keeps its bytes.
  const [plain] = parseVerificationContracts(CONTRACTS(['| `API-1:AC-001` | http | test | `test/orders.test.mjs` | primary |'],
    '| Criterion | Slot | Method | Witness | Role |'), { clauseIds, plannedClaims });
  assert.equal(Object.hasOwn(plain, 'interface'), false);

  // A screenshot as an API criterion's primary witness is refused when the plan is published, with the correction.
  for (const row of ['| `API-1:AC-002` | screen | visual | `Order created page` | primary | api |',
    '| `API-1:AC-002` | runbook | inspection | `docs/orders.md` | primary | api |']) {
    assert.throws(() => parseVerificationContracts(CONTRACTS([row]), { clauseIds, plannedClaims }), (error) => error.code === 'SPEC_VERIFICATION_CONTRACT_INVALID'
      && /API-1:AC-002 is an API criterion: a screenshot or an inspection never proves an API, so each primary witness must be a test that asserts the response status, schema and body\. Make its visual or inspection slot supporting, or remove it\./u.test(error.message));
  }
  assert.throws(() => parseVerificationContracts(CONTRACTS(['| `API-1:AC-001` | http | test | `test/orders.test.mjs` | primary | rest |']), { clauseIds, plannedClaims }),
    /may name only the api interface, or leave Interface empty/u);
  // A stored record cannot carry one either.
  assert.throws(() => normalizeVerificationContracts([{ clauseId: 'API-1:AC-002', combination: 'all', interface: 'api',
    slots: [{ slot: 'screen', method: 'visual', role: 'primary', witness: { target: 'Order created page' }, requiredAssurance: null }] }]),
  { code: 'SPEC_VERIFICATION_CONTRACT_INVALID' });
  // Its route is the plan's own correction, never recovery.
  const refused = (() => { try { parseVerificationContracts(CONTRACTS(['| `API-1:AC-002` | screen | visual | `Order created page` | primary | api |']), { clauseIds }); }
    catch (error) { return error; } })();
  const plan = refusalRemediationPlan(refused, ['phase', 'publish', 'plan']);
  assert.equal(plan.steps[0].command, 'singularity-flow phase prepublish plan --for-agent --json');
  assert.ok(!plan.steps.some((step) => /\brecover\b/u.test(step.command ?? '')), JSON.stringify(plan.steps));
});

test('the assertion check reads which of status, schema and body a criterion\'s tests assert', () => {
  const source = [
    "import test from 'node:test';", "import assert from 'node:assert/strict';",
    '// @ac:API-1:AC-001',
    "test('creates an order', async () => {",
    '  const response = await fetch(url);',
    '  assert.equal(response.status, 201);',
    '  assert.ok(validate(orderSchema, await response.json()));',
    "  assert.equal((await response.json()).id, 'o-1');",
    '});',
    '// @ac:API-1:AC-002',
    "test('status only', async () => { const res = await fetch(url); expect(res.statusCode).toBe(200); });",
    '// @ac:API-1:AC-003',
    "test('no response', () => {", '  const body = build();', '  assert.equal(add(1, 2), 3);', '});', ''].join('\n');
  const read = (clauseId) => apiAssertionSignals(source, { sourcePath: 'test/orders.test.mjs', clauseId });
  assert.deepEqual(read('API-1:AC-001'), ['status', 'schema', 'body']);
  assert.deepEqual(read('API-1:AC-002'), ['status']);
  assert.deepEqual(read('API-1:AC-003'), [], 'a name outside an assertion is not an assertion');
  // Supertest names the status by its code; a promise's then is no assertion; a skipped test asserts nothing.
  const supertest = [...source.split('\n').slice(0, 2), '// @ac:API-1:AC-004',
    "test('lists orders', async () => {", "  const listed = await request(app).get('/orders').expect(200);", '  const shown = await fetch(url).then((response) => response.json());',
    '  expect(listed.body).toMatchSchema(ordersSchema);', '});', '// @ac:API-1:AC-004',
    "test.skip('later', () => { assert.deepEqual(response.body, []); });", ''].join('\n');
  assert.deepEqual(apiAssertionSignals(supertest, { sourcePath: 'test/list.test.mjs', clauseId: 'API-1:AC-004' }), ['status', 'schema', 'body']);
  assert.deepEqual(apiAssertionSignals(supertest.replace('  expect(listed.body).toMatchSchema(ordersSchema);\n', ''), { sourcePath: 'test/list.test.mjs', clauseId: 'API-1:AC-004' }),
    ['status'], 'the then line and the skipped test add nothing');
  // Elsewhere, the file's assertion lines with strings and comments masked: a word in a string proves nothing.
  const java = ['class OrderApiTest {', '  @Test void creates() {', '    assertEquals(201, response.getStatusCode());',
    '    assertTrue(validator.matchesSchema(response.getBody()));', '    assertEquals("status schema body", label);', '  }', '}', ''].join('\n');
  assert.deepEqual(apiAssertionSignals(java, { sourcePath: 'src/test/java/OrderApiTest.java' }), ['status', 'schema', 'body']);
  assert.deepEqual(apiAssertionSignals('class T {\n  @Test void t() { assertEquals("status schema body", label); }\n}\n', { sourcePath: 'T.java' }), []);
});

test('an API criterion needs status, schema and body together, from all its tests', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-api-assertions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (relative, lines) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), [...lines, ''].join('\n'));
  };
  const head = ["import test from 'node:test';", "import assert from 'node:assert/strict';"];
  await put('test/a.test.mjs', [...head, '// @ac:API-1:AC-001', "test('status', async () => { assert.equal((await call()).status, 201); });",
    '// @ac:API-1:AC-002', "test('sum', () => { assert.equal(add(1, 2), 3); });"]);
  await put('test/b.test.mjs', [...head, '// @ac:API-1:AC-001', "test('body', async () => { assert.deepEqual((await call()).body, { id: 'o-1' }); });"]);
  await put('test/skipped.test.mjs', [...head, '// @ac:API-1:AC-002', "test.skip('all', async () => {", '  const response = await call();',
    '  assert.equal(response.status, 201); assert.ok(matchesSchema(schema, response.body)); assert.equal(response.body.id, 1);', '});']);
  await put('src/test/java/OrderApiTest.java', ['class OrderApiTest {', '  // @ac:API-1:AC-003', '  @Test void creates() {',
    '    assertEquals(201, response.getStatusCode());', '    assertTrue(validator.matchesSchema(response.getBody()));', '  }', '}']);
  const api = (clauseId) => [clauseId, { clauseId, combination: 'all', interface: 'api', slots: [] }];
  const contracts = new Map([api('API-1:AC-001'), api('API-1:AC-002'), api('API-1:AC-003'), api('API-1:AC-004'),
    ['API-1:AC-005', { clauseId: 'API-1:AC-005', combination: 'all', slots: [] }]]);
  const witnesses = [
    { clauseId: 'API-1:AC-001', testSource: 'test/a.test.mjs' }, { clauseId: 'API-1:AC-001', testSource: 'test/b.test.mjs' },
    { clauseId: 'API-1:AC-002', testSource: 'test/a.test.mjs' }, { clauseId: 'API-1:AC-002', testSource: 'test/skipped.test.mjs', skipped: true },
    { clauseId: 'API-1:AC-003', testSource: 'src/test/java/OrderApiTest.java', identity: null, gaps: ['ADAPTER_COUNTS_ONLY'] },
    { clauseId: 'API-1:AC-005', testSource: 'test/a.test.mjs' }
  ];
  const check = await apiCriterionAssertionCheck(root, { contracts, witnesses, phaseId: 'implementation' });
  assert.deepEqual(check.criteria.map(({ clauseId, asserts, missing }) => [clauseId, asserts, missing]), [
    ['API-1:AC-001', ['status', 'body'], ['schema']],
    ['API-1:AC-002', [], ['status', 'schema', 'body']],
    ['API-1:AC-003', ['status', 'schema', 'body'], []]
  ], 'a criterion with no test is the tag check\'s to refuse, and one the plan does not declare an API one is not checked');
  assert.deepEqual(check.problems, [
    'API-1:AC-001 is an API criterion, so its tests must assert the response\'s status, its schema and its body: test/a.test.mjs, test/b.test.mjs assert only its status and its body. Add a check of the body against its schema. A screenshot never proves an API',
    'API-1:AC-002 is an API criterion, so its tests must assert the response\'s status, its schema and its body: test/a.test.mjs asserts none of them. Add an assertion on the status code, a check of the body against its schema and an assertion on what the body holds. A screenshot never proves an API'
  ]);
  assert.deepEqual(check.problemFindings, [
    { code: 'code.delivery.api-assertions-missing', path: null, value: ['API-1:AC-001'] },
    { code: 'code.delivery.api-assertions-missing', path: null, value: ['API-1:AC-002'] }
  ]);
  assert.equal(check.nextAction.command, 'singularity-flow phase prepublish implementation --for-agent --json --publish-if-ready');
  // Nothing missing: no problem and no route.
  const met = await apiCriterionAssertionCheck(root, { contracts, witnesses: witnesses.filter((entry) => entry.clauseId === 'API-1:AC-003'), phaseId: 'implementation' });
  assert.deepEqual([met.problems, met.nextAction], [[], undefined]);
});

/** A code generation whose plan declares API-1:AC-001 an API criterion, and a test tagged with it. */
async function apiGeneration(t, testBody) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-api-criterion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Check Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'check.tester@example.invalid' };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  const put = async (relative, text) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  };
  git('init', '-q', '-b', 'main');
  await put('src/orders.mjs', 'export const orders = [];\n');
  git('add', '.');
  git('commit', '-q', '-m', 'baseline');
  const item = 'singularity/work-items/API-1';
  await put(`${item}/context/spec-indexes/specification-gen1.json`, JSON.stringify({ schemaVersion: 1, kind: 'specification-index', workId: 'API-1',
    phase: 'specification', generation: 1, clauses: [{ id: 'API-1:AC-001', type: 'AC', body: 'Creating an order answers 201 with the order.',
      bodySha256: 'a'.repeat(64), source: { path: 'spec.md', line: 1 } }] }));
  const contract = { clauseId: 'API-1:AC-001', combination: 'all', interface: 'api',
    slots: [{ slot: 'http', method: 'test', role: 'primary', witness: { path: 'test/orders.test.mjs' }, requiredAssurance: null },
      { slot: 'screen', method: 'visual', role: 'supporting', witness: { target: 'Order created page' }, requiredAssurance: null }] };
  await put(`${item}/context/claims/plan-gen1-planned.json`, JSON.stringify({ schemaVersion: 2, kind: 'planned', workId: 'API-1', phase: 'plan', generation: 1,
    claims: { 'API-1:AC-001': { expectedPaths: ['src/orders.mjs'], tests: ['test/orders.test.mjs'] } }, verificationContracts: [contract] }));
  git('add', '.');
  git('commit', '-q', '-m', 'plan');
  const base = git('rev-parse', 'HEAD');
  const phase = { id: 'implementation', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact', sourceBoundary: 'unrestricted',
    generationPolicy: { task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
    requiredArtifact: { path: 'artifacts/implementation/implementation-summary.md', kind: 'implementation-summary', minimumBytes: 20,
      validation: { requiredHeadings: ['Implementation'], forbiddenPlaceholders: [] } } };
  const workflow = { workItem: { id: 'API-1' }, currentPhase: 'implementation', phaseOrder: ['specification', 'plan', 'implementation'],
    phases: { specification: { id: 'specification', status: 'approved', generation: 1, requiredArtifact: { path: 'artifacts/specification/spec.md', kind: 'requirements' } },
      plan: { id: 'plan', status: 'approved', generation: 1, requiredArtifact: { path: 'artifacts/plan/plan.md', kind: 'plan' } }, implementation: phase },
    workIntervals: { current: null, history: [] }, history: [], resolution: { codeDelivery: {} } };
  const config = { workItemRoot: 'singularity/work-items' };
  await ensureWorkIntervalBaseline(root, config, workflow, { phaseId: phase.id, itemDirectory: path.join(root, item), itemRelative: item, sourceBaseCommit: base });
  await beginCodeGeneration(root, config, workflow, phase, { agent: 'developer' });
  await put(`${item}/artifacts/implementation/implementation-summary.md`, '# Implementation\n\nCreating an order answers 201 with the order.\n');
  await put('src/orders.mjs', 'export function createOrder(id) {\n  return { status: 201, body: { id } };\n}\n');
  const write = (body) => put('test/orders.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { createOrder } from '../src/orders.mjs';", '', '// @ac:API-1:AC-001', `test('creates an order', () => {`,
    "  const response = createOrder('o-1');", ...body, '});', ''].join('\n'));
  await write(testBody);
  return { root, config, workflow, phase, write };
}

test('an API criterion whose tests miss status, schema or body is refused with its route; with all three it passes', async (t) => {
  // A screenshot is planned as supporting evidence; it never counts, so a status-only test is refused.
  const { root, config, workflow, phase, write } = await apiGeneration(t, ['  assert.equal(response.status, 201);']);
  const refused = await evaluateCodeDeliveryPreflight(root, config, workflow, phase).then(() => null, (error) => error);
  assert.equal(refused?.code, 'CODE_DELIVERY_EVIDENCE_REQUIRED', refused?.stack);
  assert.match(refused.message, /- API-1:AC-001 is an API criterion, so its tests must assert the response's status, its schema and its body: test\/orders\.test\.mjs asserts only its status\. Add a check of the body against its schema and an assertion on what the body holds\. A screenshot never proves an API/u);
  assert.deepEqual(refused.details.nextAction, { command: 'singularity-flow phase prepublish implementation --for-agent --json --publish-if-ready', skill: '/sf-code',
    label: 'Add the missing status, schema or body assertions, then check again.' });
  // The route stays in the code step: its own repair first, never recovery.
  const plan = refusalRemediationPlan(refused, ['phase', 'publish', 'implementation']);
  assert.equal(plan.steps[0].command, refused.details.nextAction.command);
  assert.equal(plan.steps[0].kind, 'remediation');
  assert.ok(!plan.steps.some((step) => /\brecover\b/u.test(step.command ?? '')), JSON.stringify(plan.steps));
  assert.ok(refused.details.findings.some((finding) => finding.code === 'code.delivery.api-assertions-missing'));

  // Following the route: the test asserts the status, checks the schema and asserts the body.
  await write(['  assert.equal(response.status, 201);', "  assert.ok(matchesSchema(orderSchema, response.body));", "  assert.deepEqual(response.body, { id: 'o-1' });"]);
  const delivery = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  assert.deepEqual(delivery.acceptanceCriteria.api, [{ clauseId: 'API-1:AC-001', tests: ['test/orders.test.mjs'],
    asserts: ['status', 'schema', 'body'], missing: [] }]);
  // The approver reads it in each criterion's proof line.
  const [proof] = criterionProof(delivery);
  assert.match(proof.words, /^API-1:AC-001: 1 test proves it; .*the response's status, schema and body are asserted, as an API criterion needs$/u);
});
