/**
 * Approve twice (owner, 2026-11-19: "do all the ceremony cuts and think from developer perspective"): people approve the
 * plan and the delivered code; a step marked `approval: { automatic: when-ready }` is approved by SFlow right after it is
 * submitted, when its reviewer said ready, its checks passed and nothing is open for it, and the record says what it
 * checked (`approved_automatically`, never `policy_waived`). Anything open leaves the step with its people. The plan,
 * a step that may change source files, convergence and the design sources are always a person's.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { approvesAutomatically, automaticApprovalHeldBy, automaticApprovalOn, normalizeApprovalPolicy } from '../src/approval-authority.mjs';
import { supportedWaiverPolicy } from '../src/quick-fix-policy.mjs';
import { automaticApprovalWords, needsPersonWords } from '../src/automatic-approval.mjs';
import { automaticApprovalsBefore } from '../src/phase-roles.mjs';
import { verifyAutomaticApproval } from '../src/automatic-approval-replay.mjs';
import { approvalChainSnapshot } from '../src/approval-chain.mjs';
import { isKnownPackagedWorkflowValue } from '../src/packaged-workflow-history.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = async () => YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const AUTHORITIES = { 'git-contributors': { label: 'Contributors', allowAnyGitIdentity: true } };

test('approval.automatic is when-ready on a step people approve, and never the low-risk waiver', () => {
  const policy = normalizeApprovalPolicy({ automatic: 'when-ready' }, AUTHORITIES, 'design');
  assert.equal(policy.mode, 'required');
  assert.equal(policy.automatic, 'when-ready');
  assert.equal(approvesAutomatically(policy), true);
  assert.equal(supportedWaiverPolicy(policy), null, 'no reader of mode: policy sees it');
  assert.equal(Object.hasOwn(normalizeApprovalPolicy({}, AUTHORITIES, 'design'), 'automatic'), false, 'a step without it resolves as before');
  assert.throws(() => normalizeApprovalPolicy({ automatic: 'always' }, AUTHORITIES, 'design'),
    (error) => error.code === 'AUTOMATIC_APPROVAL_NOT_ALLOWED' && /must be when-ready/u.test(error.message));
  // A repository's own policy merged under a shipped workflow's setting is no configuration error: the step stays with
  // its people, as before, and its submission says why. `mode: policy` already decides how a step completes.
  assert.equal(Object.hasOwn(normalizeApprovalPolicy({ mode: 'policy', automatic: 'when-ready' }, AUTHORITIES, 'design'), 'automatic'), false);
  for (const [value, words] of [[{ automatic: 'when-ready', minimum: 2 }, 'it needs more than one approver'],
    [{ automatic: 'when-ready', allowSelfApproval: false }, 'this repository asks someone other than the author to approve it']]) {
    const held = normalizeApprovalPolicy(value, AUTHORITIES, 'design');
    assert.equal(automaticApprovalOn(held), true);
    assert.equal(automaticApprovalHeldBy(held), words);
    assert.equal(approvesAutomatically(held), false);
  }
  assert.equal(automaticApprovalWords({ checked: ['the reviewer said ready', 'its checks passed'] }), 'approved automatically: the reviewer said ready; its checks passed');
});

test('the shipped delivery workflows: people approve the plan and every step that may change source files', async () => {
  const definition = validateDefinition(await packaged());
  const split = (id) => {
    const phases = resolveWorkType(definition, id).phases;
    return { people: phases.filter((phase) => phase.approval.mode === 'required' && !phase.approval.automatic).map((phase) => phase.id),
      automatic: phases.filter((phase) => phase.approval.automatic).map((phase) => phase.id) };
  };
  assert.deepEqual(split('feature'), { people: ['implementation-spec', 'implementation', 'verification'], automatic: ['intake', 'requirements', 'design', 'conformance'] });
  assert.deepEqual(split('bugfix'), { people: ['fix-spec', 'implementation', 'verification'], automatic: ['intake', 'reproduction', 'fix-design', 'conformance'] });
  assert.deepEqual(split('chore'), { people: ['intake', 'implementation', 'verification'], automatic: ['conformance'] });
  assert.deepEqual(split('findings-remediation').automatic, ['findings-intake', 'conformance']);
  assert.deepEqual(split('figma-mobile'), { people: ['design-intake', 'mobile-spec', 'implementation', 'visual-verification'], automatic: ['design-inventory', 'component-mapping', 'conformance'] });
  assert.deepEqual(split('classic-delivery').automatic, ['testing', 'conformance']);
  assert.deepEqual(split('spec-code-test-loop').automatic, ['conformance'], 'its testing step starts a rework loop');
  for (const id of ['spec-driven-standard', 'reference-driven-build']) {
    assert.deepEqual(split(id), { people: ['planning', 'implementation', 'convergence', 'verification'], automatic: ['specification', 'release'] });
  }
  // A fallback to people keeps each step's own approval groups and send-back targets.
  const design = resolveWorkType(definition, 'feature').phases.find((phase) => phase.id === 'design');
  assert.deepEqual(design.approval.authorities, ['architecture-reviewers']);
  assert.deepEqual(design.approval.rejectTo, ['intake', 'requirements', 'design']);
  // The quick fix and the demonstrations keep their own approvals.
  assert.equal(resolveWorkType(definition, 'quick-fix').phases.find((phase) => phase.id === 'verify').approval.mode, 'policy');
  for (const id of ['document-test-repair', 'poc-workflow', 'benchmarking-a']) assert.deepEqual(split(id).automatic, [], id);
  // Only the quick fix keeps `mode: policy`: no other Story gets the low-risk waiver's five-path cap on its code step
  // (work-intervals.mjs reads any `mode: policy` step as that waiver).
  for (const id of Object.keys(definition.workTypes).filter((entry) => entry !== 'quick-fix')) {
    assert.ok(resolveWorkType(definition, id).phases.every((phase) => phase.approval.mode !== 'policy'), id);
  }
});

test('configuration refuses it where a person must approve', async () => {
  const definition = await packaged();
  const refused = (type, phase, words, code = 'AUTOMATIC_APPROVAL_NOT_ALLOWED') => {
    const candidate = structuredClone(definition);
    const overrides = candidate.workTypes[type].phaseOverrides ??= {};
    overrides[phase] = { ...(overrides[phase] ?? {}), approval: { ...(overrides[phase]?.approval ?? {}), automatic: 'when-ready' } };
    assert.throws(() => resolveWorkType(validateDefinition(candidate), type), (error) => error.code === code && words.test(error.message), `${type} ${phase}`);
  };
  refused('feature', 'implementation-spec', /it is the plan/u);
  refused('feature', 'implementation', /may change source files/u);
  refused('feature', 'verification', /may change source files/u);
  refused('chore', 'intake', /it is the plan/u);
  refused('figma-mobile', 'design-intake', /design versions/u);
  refused('figma-mobile', 'visual-verification', /may change source files/u);
  refused('spec-code-test-loop', 'testing', /send the work back to implementation/u);
  refused('spec-driven-standard', 'convergence', /moves the Story on from convergence/u, 'CONVERGENCE_HUMAN_APPROVAL_REQUIRED');
  // A repository whose own Design step takes two approvers keeps a valid configuration after the upgrade marks the
  // shipped feature's Design automatic: that step stays with its two people.
  const strict = structuredClone(definition);
  strict.phases.design.approval = { ...(strict.phases.design.approval ?? {}), minimum: 2 };
  const design = resolveWorkType(validateDefinition(strict), 'feature').phases.find((phase) => phase.id === 'design');
  assert.equal(design.approval.automatic, 'when-ready');
  assert.equal(approvesAutomatically(design.approval), false);
  assert.equal(automaticApprovalHeldBy(design.approval), 'it needs more than one approver');
});

test('an upgrade replaces an untouched shipped workflow, and keeps a customized one as it is', async () => {
  const definition = await packaged();
  const before = (id) => {
    const value = structuredClone(definition.workTypes[id]);
    // As shipped before step intents (Stage 4): no reasons, and no attached-documents list of its own.
    delete value.because;
    if (JSON.stringify(value.documents) === JSON.stringify({ allowedPhases: [] })) delete value.documents;
    for (const [phase, override] of Object.entries(value.phaseOverrides ?? {})) {
      delete override.because;
      if (!override.approval?.automatic) continue;
      delete override.approval.automatic;
      if (!Object.keys(override.approval).length) delete override.approval;
      if (!Object.keys(override).length) delete value.phaseOverrides[phase];
    }
    return value;
  };
  for (const id of ['feature', 'bugfix', 'chore', 'findings-remediation', 'figma-mobile', 'classic-delivery', 'spec-code-test-loop', 'spec-driven-standard', 'reference-driven-build']) {
    assert.equal(isKnownPackagedWorkflowValue('workTypes', id, definition.workTypes[id]), true, `${id}: the new shipped value`);
    assert.equal(isKnownPackagedWorkflowValue('workTypes', id, before(id)), true, `${id}: the value shipped before`);
  }
  assert.equal(isKnownPackagedWorkflowValue('workTypes', 'feature', { ...before('feature'), label: 'Our feature' }), false, 'a repository\'s own edit stays its own');
});

test('the approval chain says a step was approved automatically, or will be when ready', () => {
  const policy = { mode: 'required', automatic: 'when-ready', authorities: ['architecture-reviewers'], minimum: 1 };
  const chain = (design) => approvalChainSnapshot({ workItem: { id: 'AT-1' }, phaseOrder: ['design'], phases: { design },
    resolution: { approvalAuthorities: { 'architecture-reviewers': { label: 'Architecture reviewers', members: [] } } } }).phases[0].approval;
  const phase = (status, extra = {}) => ({ id: 'design', label: 'Design', status, generation: 1, approvals: [], approvalPolicy: policy, ...extra });
  assert.equal(chain(phase('in_progress')).state, 'approved-automatically-when-ready');
  const done = chain(phase('approved', { approvalDisposition: 'approved_automatically', automaticApproval: { checked: [] } }));
  assert.equal(done.state, 'approved-automatically');
  assert.equal(done.minimum, 0);
  // Submitted and left with its people: one of them approves it.
  const waiting = chain(phase('awaiting_approval'));
  assert.equal(waiting.state, 'awaiting-approval');
  assert.equal(waiting.minimum, 1);
});

test('a person\'s approval covers the steps SFlow approved since the last one, by their versions', () => {
  const automatic = (id) => ({ id, status: 'approved', generation: 1, approvalPolicy: { mode: 'required', automatic: 'when-ready' },
    approvalDisposition: 'approved_automatically', automaticApproval: { reviewPacketSha256: `${id}-packet`, checked: [] }, approvals: [] });
  const workflow = { phaseOrder: ['intake', 'requirements', 'design', 'plan'], phases: {
    intake: { id: 'intake', status: 'approved', generation: 1, approvalPolicy: { mode: 'required' }, approvals: [{ decision: 'approved' }] },
    requirements: automatic('requirements'), design: automatic('design'), plan: { id: 'plan', status: 'awaiting_approval', generation: 1, approvalPolicy: { mode: 'required' } } } };
  assert.deepEqual(automaticApprovalsBefore(workflow, 'plan').map((phase) => phase.id), ['requirements', 'design']);
  assert.deepEqual(automaticApprovalsBefore(workflow, 'requirements'), [], 'a step people approved ends the run');
});

test('a forged or altered automatic approval is not accepted by the gate', async () => {
  const policy = { mode: 'required', automatic: 'when-ready', minimum: 1, authorities: ['g'] };
  const workflow = { workItem: { id: 'AT-2' }, resolution: { phases: [{ id: 'design', approval: policy, writeScope: 'artifact-only' }] }, lineage: { submissions: [] }, history: [] };
  const phase = { id: 'design', generation: 1, approvalPolicy: policy, approvalDisposition: 'approved_automatically', checks: [],
    automaticApproval: { rule: 'when-ready-v1', generation: 1, at: 'now', predicates: { reviewReady: true, nothingOpen: false }, reviewPacketSha256: 'a'.repeat(64) } };
  const forged = await verifyAutomaticApproval(process.cwd(), {}, workflow, phase);
  assert.equal(forged.valid, false);
  assert.match(forged.errors[0], /not every fact it checked was true/u);
  const unbound = await verifyAutomaticApproval(process.cwd(), {}, workflow, { ...phase, automaticApproval: { ...phase.automaticApproval, predicates: { reviewReady: true } } });
  assert.match(unbound.errors[0], /does not bind this version's submission/u);
  const unpinned = await verifyAutomaticApproval(process.cwd(), {}, { ...workflow, resolution: { phases: [{ id: 'design', approval: { mode: 'required' } }] } }, phase);
  assert.match(unpinned.errors[0], /pinned workflow does not approve this step automatically/u);
});

test('a step with anything open stays with its people, and they are told why', async () => {
  const { automaticApprovalCheck } = await import('../src/automatic-approval.mjs');
  const phase = { id: 'design', label: 'Design', status: 'awaiting_approval', generation: 2, approvals: [],
    approvalPolicy: { mode: 'required', automatic: 'when-ready', authorities: ['architecture-reviewers'], minimum: 1, allowSelfApproval: true },
    writeScope: 'artifact-only', checks: [{ id: 'lint', status: 'failed' }] };
  const workflow = { workItem: { id: 'AT-3' }, currentPhase: 'design', phaseOrder: ['design'], phases: { design: phase },
    resolution: { sourceReview: { mode: 'off', phases: [] } } };
  const check = await automaticApprovalCheck(process.cwd(), null, workflow, 'design');
  assert.equal(check.applies, true);
  assert.equal(check.eligible, false);
  assert.equal(check.predicates.reviewReady, false);
  assert.equal(check.predicates.checksPassed, false);
  assert.ok(check.open.includes('no reviewer reviews this step'), check.open.join('\n'));
  assert.ok(check.open.includes('a check did not pass (lint)'), check.open.join('\n'));
  assert.match(needsPersonWords(phase, check), /^Design v2 needs your approval: a check did not pass \(lint\); no reviewer reviews this step/u);
  // Self-approval off: the check it would skip stays a person's.
  const strict = await automaticApprovalCheck(process.cwd(), null, { ...workflow, phases: { design: { ...phase, checks: [], approvalPolicy: { ...phase.approvalPolicy, allowSelfApproval: false } } } }, 'design');
  assert.equal(strict.predicates.selfApprovalAllowed, false);
  assert.ok(strict.open.includes('this repository asks someone other than the author to approve it'), strict.open.join('\n'));
  // A step its people approve is not asked about at all.
  assert.deepEqual(await automaticApprovalCheck(process.cwd(), null, { ...workflow, phases: { design: { ...phase, approvalPolicy: { mode: 'required' } } } }, 'design'), { applies: false });
});

test('a step that is ready is approved automatically after it is submitted, recorded with what was checked, and the gate replays it', slowLane({ timeout: 900_000 }), async (t) => {
  const { journeyRepository, startStory, storyRecord } = await import('./helpers/route-follower.mjs');
  const { quickFixIntake } = await import('./helpers/journey-scripts.mjs');
  const { reviewStep } = await import('./helpers/step-review.mjs');
  const W = 'APT-1';
  const story = await journeyRepository(t, { configure: (configuration) => {
    // It asks nothing (in a workflow of intents, absent would mean its intent's "when needed").
    configuration.phases['fix-design'].clarification = { mode: 'off' };
    configuration.workTypes['quick-design'] = { ...configuration.workTypes['quick-fix'], label: 'Quick design', phases: ['intake', 'fix-design', 'implement', 'verify'],
      phaseOverrides: { ...configuration.workTypes['quick-fix'].phaseOverrides, 'fix-design': { inputs: ['intake'], approval: { automatic: 'when-ready' } } } };
  } });
  startStory(story, W, { workType: 'quick-design', title: 'Change the value', description: 'Return 2.' });
  const json = (args) => JSON.parse(story.cli(...args));
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep(json, 'intake');
  story.cli('submit', 'intake');
  // The plan is a person's to approve.
  assert.equal(storyRecord(story).phases.intake.status, 'awaiting_approval');
  story.cli('approve', 'intake', '--yes');
  story.cli('prepare', 'fix-design');
  await story.write(`${story.item}/artifacts/fix-design/fix-design.md`, [`# ${W} — Fix Design`, '', '## Root cause', '',
    'The exported constant holds the old value; nothing computes it.', '', '## Minimal safe change', '',
    `Change the one literal that holds the value, as ${W}:AC-001 asks; no import changes.`, '', '## Alternatives and regression risk', '',
    'A computed value was rejected as unnecessary; the only regression surface is the one test that reads it.', ''].join('\n'));
  story.cli('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep(json, 'fix-design');
  const submitted = story.raw(['submit', 'fix-design']);
  assert.equal(submitted.status, 0, submitted.stdout.slice(-3000) + submitted.stderr.slice(-3000));
  assert.match(submitted.stdout, /Approved .* v1 automatically: the reviewer said ready; its checks passed; nothing was open for it/u, submitted.stdout.slice(0, 1500) + submitted.stderr.slice(-3000));
  const record = storyRecord(story);
  const design = record.phases['fix-design'];
  assert.equal(design.status, 'approved');
  assert.equal(design.approvalDisposition, 'approved_automatically');
  assert.equal(design.automaticApproval.rule, 'when-ready-v1');
  assert.equal(design.approvalWaiver, undefined, 'never the quick fix\'s waiver');
  assert.deepEqual(design.approvals, [], 'no person is named as its approver');
  assert.equal(record.currentPhase, 'implement');
  const event = record.history.find((entry) => entry.event === 'phase-approved-automatically' && entry.phase === 'fix-design');
  assert.match(event.detail, /^approved automatically: the reviewer said ready; its checks passed; nothing was open for it/u);
  // The gate replays it from the Story's committed records.
  const gate = story.raw(['gate', '--json']);
  assert.doesNotMatch(gate.stdout, /automatic-invalid|automatic approval is invalid/u, gate.stdout.slice(-3000));
  assert.match(gate.stdout, /approved automatically, record verified: fix-design/u, gate.stdout.slice(-3000));
});

test('Workflow Studio offers the switch only where the workflow allows it, and an existing workflow never changes by itself', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-approve-studio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Studio Tester' };
  const run = (command, args, { ok = true } = {}) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env });
    if (ok) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const flow = (...args) => run(process.execPath, [path.join(ROOT, 'bin', 'singularity-flow.mjs'), ...args]).stdout;
  run('git', ['init', '-b', 'main']); run('git', ['config', 'user.name', 'Studio Tester']); run('git', ['config', 'user.email', 'studio@example.com']);
  await writeFile(path.join(root, 'README.md'), '# Studio\n');
  flow('init');
  run('git', ['add', '-A']); run('git', ['commit', '-m', 'initialize']);
  const apply = async (changes, { ok = true } = {}) => {
    const file = path.join(root, '..', `${path.basename(root)}-${Math.random().toString(16).slice(2)}.json`);
    await writeFile(file, JSON.stringify({ schema: 'sflow-studio-change-set@1', changes }));
    t.after(() => rm(file, { force: true }));
    return run(process.execPath, [path.join(ROOT, 'bin', 'singularity-flow.mjs'), 'workflow', 'studio', 'apply', '--change-set', file, '--json'], { ok });
  };
  const workflow = async () => YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  const steps = (id) => JSON.parse(flow('workflow', 'studio', '--json')).workflows.find((entry) => entry.id === id).steps;
  const view = (id, step) => steps(id).find((entry) => entry.id === step).automaticApproval;
  assert.deepEqual(view('chore', 'conformance'), { on: true, allowed: true, why: null });
  assert.equal(view('chore', 'intake').allowed, false);
  assert.match(view('chore', 'intake').why, /it is the plan/u);
  assert.match(view('chore', 'verification').why, /may change source files/u);
  // A team's own copy: turning it off gives the step back to its people; a plan step cannot take it.
  await apply([{ op: 'workflow.create', id: 'our-chore', label: 'Our chore', copyOf: 'chore', phases: ['intake', 'implementation', 'verification', 'conformance'] }]);
  assert.equal(view('our-chore', 'conformance').on, true, 'a copy keeps the setting it was copied with');
  await apply([{ op: 'phase.update', id: 'conformance', workflow: 'our-chore', approval: { group: 'quality-reviewers', minimum: 1, automatic: false } }]);
  // A version 4 file: the step's intent would let SFlow approve it, so turning it off writes off, and says why.
  const turnedOff = (await workflow()).workTypes['our-chore'].phaseOverrides.conformance;
  assert.equal(turnedOff.approval.automatic, 'off');
  assert.match(turnedOff.because['approval.automatic'], /turned off for it in Workflow Studio/u);
  assert.equal(view('our-chore', 'conformance').on, false);
  assert.equal(view('chore', 'conformance').on, true, 'the shipped workflow is unchanged');
  const refused = await apply([{ op: 'phase.update', id: 'intake', workflow: 'our-chore', approval: { group: 'product-approvers', minimum: 1, automatic: true } }], { ok: false });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /cannot be approved automatically: it is the plan/u);
});
