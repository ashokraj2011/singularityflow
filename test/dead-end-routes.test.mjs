import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { decidableUpstreamStep, raiseUpstreamIssue } from '../src/upstream-issues.mjs';
import { discardPreparedStoryWorktree, preparedStoryWorktreePath, prepareStoryWorktree } from '../src/story-worktree.mjs';
import { phaseExplicitlyReopened } from '../src/sequence.mjs';
import { phaseAuthoringEntry } from '../src/phase-authoring-entry.mjs';
import { classifyStoryGateFailures } from '../src/gate-recovery.mjs';
import { terminalRecoveryActions, terminalRisk } from '../src/evidence/terminal.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { selectStartEntry } from '../src/application-run.mjs';
import { unavailableStoriesError } from '../src/session-story-discovery.mjs';
import { inspectLifecycleWorktree } from '../src/lifecycle-worktree.mjs';
import { isApplicationChangeEntry } from '../src/application-paths.mjs';
import { modelOffCause } from '../src/operation-context.mjs';
import { workflowNextSteps } from '../src/nextsteps.mjs';
import { preparedPhaseNextActions } from '../src/commands/shared/prepared-phase-next-actions.mjs';

// Each refusal here used to leave its reader with prose or a route that refused again (blocker
// audit 2026-10-27, batch 4 and 5). Each now names a command that works from where it stands.

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const AT = '2026-10-27T00:00:00.000Z';

function story() {
  return { workItem: { id: 'DEAD-1' }, status: 'in_progress', currentPhase: 'implementation',
    phaseOrder: ['specification', 'planning', 'implementation'],
    phases: {
      specification: { id: 'specification', status: 'approved', generation: 1, approvalPolicy: { authorities: ['product'] } },
      planning: { id: 'planning', status: 'approved', generation: 1, approvalPolicy: {} },
      implementation: { id: 'implementation', status: 'in_progress', generation: 1 }
    } };
}

test('an issue against a step without approvers is refused with the nearest step that can decide it', () => {
  const workflow = story();
  assert.equal(decidableUpstreamStep(workflow, 'planning'), 'specification');
  assert.equal(decidableUpstreamStep(workflow, 'specification'), 'specification');
  let refusal;
  assert.throws(() => raiseUpstreamIssue(workflow, { phase: 'planning', about: 'AC-001',
    problem: 'The plan has no row for AC-001, so nothing tests it.', raisedBy: 'dev@example.test', at: AT }), (error) => {
    refusal = error;
    return error.code === 'UPSTREAM_ISSUE_AUTHORITY_UNAVAILABLE' && error.details.decidableStep === 'specification';
  });
  assert.equal(workflow.upstreamIssues, undefined, 'nothing was raised');
  const [first] = refusalRemediationPlan(refusal, ['upstream-issue', 'raise', '--phase', 'planning']).steps;
  assert.equal(first.id, 'raise-at-decidable-step');
  assert.match(first.command, /^singularity-flow upstream-issue raise --phase specification /u);

  // An issue already open there is superseded at the decidable step; its approvers dismiss both.
  const supersede = 'singularity-flow upstream-issue raise --work-id DEAD-1 --phase specification --supersedes UPI-001 --about <ID|SECTION> --problem <TEXT>';
  const open = Object.assign(new Error('planning has no approval group'), { code: 'UPSTREAM_ISSUE_AUTHORITY_UNAVAILABLE',
    details: { issue: 'UPI-001', phase: 'planning', decidableStep: 'specification', nextAction: { command: supersede } } });
  const [route] = refusalRemediationPlan(open, ['upstream-issue', 'decide', 'UPI-001']).steps;
  assert.equal(route.id, 'supersede-upstream-issue');
  assert.equal(route.command, supersede);
});

test('a start checkout left at an older base names its own commit, and discarding it with that commit works', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-dead-end-start-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repository'); await mkdir(root);
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Dead End Tester'); git(root, 'config', 'user.email', 'dead-end@example.invalid');
  await writeFile(path.join(root, 'README.md'), 'first base\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'First base');
  const oldBase = git(root, 'rev-parse', 'HEAD');
  const prepared = await prepareStoryWorktree(root, 'STALE-1', { base: oldBase });
  git(root, 'commit', '--allow-empty', '-qm', 'The base branch moved on');
  const newBase = git(root, 'rev-parse', 'HEAD');

  let refusal;
  await assert.rejects(() => preparedStoryWorktreePath(root, 'STALE-1', { baseCommit: newBase }), (error) => {
    refusal = error;
    return error.code === 'STORY_WORKTREE_RECOVERY_REQUIRED';
  });
  assert.equal(refusal.details.preparedBase, oldBase);
  assert.equal(refusal.details.requestedBase, newBase);
  assert.equal(await realpath(refusal.details.checkoutPath), await realpath(prepared.repositoryPath));
  const command = `singularity-flow story discard-worktree --work-id STALE-1 --prepared-base ${oldBase}`;
  assert.equal(refusal.details.nextAction.command, command);
  assert.equal(refusalRemediationPlan(refusal, ['story', 'prepare-worktree', '--work-id', 'STALE-1']).steps[0].command, command);

  // The named command's own operation removes the unchanged checkout.
  assert.equal((await discardPreparedStoryWorktree(root, 'STALE-1', { baseCommit: oldBase })).status, 'removed');
  assert.equal(await preparedStoryWorktreePath(root, 'STALE-1', { baseCommit: newBase }), null);

  // A commit made inside the prepared checkout is not in the base: no discard is offered for it.
  const own = await prepareStoryWorktree(root, 'STALE-2', { base: newBase });
  git(own.repositoryPath, 'commit', '--allow-empty', '-qm', 'Work inside the prepared checkout');
  await assert.rejects(() => preparedStoryWorktreePath(root, 'STALE-2', { baseCommit: newBase }), (error) => {
    assert.equal(error.code, 'STORY_WORKTREE_RECOVERY_REQUIRED');
    assert.equal(error.details.nextAction, undefined);
    assert.match(error.message, /holds a commit the base does not have/u);
    return true;
  });
});

test('a code step a skill amendment reopened is prepared again, not rolled over', () => {
  const code = { id: 'implementation', status: 'in_progress', generation: 2, generationPolicy: { task: 'code' },
    generationIntent: { id: 'GI-2', status: 'consumed', generation: 2 },
    skillAmendmentRevalidation: { id: 'SAM-001', state: 'affected', generationAtAdoption: 2 } };
  const workflow = { workItem: { id: 'DEAD-1' }, status: 'in_progress', currentPhase: 'implementation',
    phaseOrder: ['implementation'], phases: { implementation: code } };
  assert.equal(phaseExplicitlyReopened(workflow, code), true);
  const entry = phaseAuthoringEntry(workflow, code);
  assert.equal(entry.reason, 'code-rework-preparation-required');
  assert.equal(entry.actions[0].command, 'singularity-flow prepare implementation');
  assert.match(entry.actions[0].reason, /reopened by a skill amendment/u);
  // Once the next generation is published the amendment no longer reopens it.
  assert.equal(phaseExplicitlyReopened(workflow, { ...code, generation: 3 }), false);
});

test('a document whose original is gone offers the detach preview beside choosing the file again', () => {
  const error = Object.assign(new Error('The selected file is not the original for DOC-003.'), {
    code: 'DOCUMENT_RESTORE_HASH_MISMATCH', details: { documentId: 'DOC-003', expectedSha256: 'a'.repeat(64), actualSha256: 'b'.repeat(64) } });
  const steps = refusalRemediationPlan(error, ['documents', 'restore', 'DOC-003', '--work-id', 'DEAD-1', '--file', 'x.pdf']).steps;
  assert.deepEqual(steps.slice(0, 2).map((entry) => [entry.id, entry.command]), [
    ['choose-original-again', 'singularity-flow documents restore DOC-003 --work-id DEAD-1 --file <LOCAL-FILE> --json'],
    ['preview-detach', 'singularity-flow documents detach DOC-003 --work-id DEAD-1 --dry-run --json']
  ]);
});

test('commits only the person can send are named with the exact Git commands, never sync', () => {
  const workflow = { workItem: { id: 'DEAD-1' }, currentPhase: null, phaseOrder: ['implementation'], phases: {} };
  for (const [state, pattern] of [['ahead', /git log --oneline origin\/DEAD-1\.\.HEAD`.*git push origin HEAD:DEAD-1`/u],
    ['diverged', /git log --oneline --left-right HEAD\.\.\.origin\/DEAD-1`/u]]) {
    const [finding] = classifyStoryGateFailures(workflow, [{ code: 'gate.publication.remote-missing', message: `not published (${state})`,
      publication: { state, remote: 'origin', branch: 'DEAD-1' } }], { publicationPending: false });
    assert.equal(finding.recovery.command, null);
    assert.match(finding.recovery.detail, pattern);
    assert.doesNotMatch(finding.recovery.detail, /git push --force|singularity-flow sync/u);
  }
});

test('the final gate is a read, and an open Story\'s ending names the decision list rather than gate --terminal', () => {
  assert.equal(resolveOperation({ requestedCommand: 'gate', positionals: ['gate'], options: { terminal: true } }).classification, 'read');
  const actions = terminalRecoveryActions('DEAD-1', { decision: { gate: 'pass' }, rows: [] },
    { errors: ['terminal: phase planning is not approved'], findings: [] });
  assert.deepEqual(actions, ['singularity-flow decisions DEAD-1']);
});

test('an application with no start entry names app suggest', () => {
  let refusal;
  assert.throws(() => selectStartEntry({ capabilityId: 'web-app', application: { start: [] } }), (error) => {
    refusal = error;
    return error.code === 'APP_START_NOT_DECLARED';
  });
  assert.equal(refusalRemediationPlan(refusal, ['app', 'start']).steps[0].command,
    'singularity-flow app suggest --capability web-app --json');
});

test('unreadable state records name the ledger doctor, and a newer build\'s records keep their upgrade code', () => {
  const generic = unavailableStoriesError([{ code: 'SUBJECT_STATE_UNAVAILABLE', claimedId: 'OLD-1', sourceCode: 'SESSION_STORY_INVALID', reason: 'no summary' }]);
  assert.equal(generic.code, 'SESSION_STATE_INDEX_UNAVAILABLE');
  assert.equal(generic.details.nextAction.command, 'singularity-flow ledger doctor --json');
  const newer = unavailableStoriesError([{ code: 'SUBJECT_STATE_UNAVAILABLE', claimedId: 'NEW-1', sourceCode: 'SCHEMA_VERSION_FUTURE', reason: 'Written by a newer build.' }]);
  assert.equal(newer.code, 'SCHEMA_VERSION_FUTURE');
  assert.deepEqual(newer.details.workIds, ['NEW-1']);
});

test('an interrupted SFlow write inside the Story\'s folder never holds a lifecycle decision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-dead-end-temp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  const temp = 'workflow.json.tmp-4242-0f8fad5b-d9cb-469f-a165-70867728950e';
  await mkdir(path.join(root, 'singularity/work-items/DEAD-1'), { recursive: true });
  await writeFile(path.join(root, 'singularity/work-items/DEAD-1', temp), '{}');
  await writeFile(path.join(root, temp), '{}');
  const inspection = inspectLifecycleWorktree(root, { workItemRoot: 'singularity/work-items' }, { workItem: { id: 'DEAD-1' } });
  assert.deepEqual(inspection.disposableUntrackedPaths, [`singularity/work-items/DEAD-1/${temp}`]);
  // Outside the Story's folder the same name could be anyone's, so it stays for review.
  assert.deepEqual(inspection.entries.map((entry) => entry.path.value), [temp]);
});

// Playwright writes test-results/.last-run.json after every run; a repository that never ignored it
// had every approval refused for "a change that is not part of this decision" (ws-graph, 2026-10-27).
test('an untracked test runner output never holds a decision, and is never counted as changed code', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-dead-end-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Runner Tester'); git(root, 'config', 'user.email', 'runner@example.invalid');
  await mkdir(path.join(root, 'reports/test-results'), { recursive: true });
  await writeFile(path.join(root, 'reports/test-results/kept.json'), '{}\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'A team that commits one report');
  const put = async (relative, text = '{}\n') => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  };
  await put('test-results/.last-run.json', '{"status":"passed","failedTests":[]}\n');
  await put('apps/web/playwright-report/index.html', '<html></html>\n');
  await put('coverage/lcov.info');
  await put('test-results-notes.md', '# Not a runner folder\n');
  await writeFile(path.join(root, 'reports/test-results/kept.json'), '{"changed":true}\n');
  const inspection = inspectLifecycleWorktree(root, { workItemRoot: 'singularity/work-items' }, { workItem: { id: 'DEAD-1' } });
  assert.deepEqual(inspection.disposableUntrackedPaths, ['apps/web/playwright-report/index.html', 'test-results/.last-run.json']);
  assert.deepEqual(inspection.entries.map((entry) => entry.path.value).sort(), ['coverage/lcov.info', 'reports/test-results/kept.json', 'test-results-notes.md'],
    'a coverage folder, a tracked report and a look-alike name stay for review');
  // Publication and the coverage preview select changes the same way: never an untracked runner output.
  assert.equal(isApplicationChangeEntry({ newPath: 'test-results/.last-run.json', untracked: true }), false);
  assert.equal(isApplicationChangeEntry({ newPath: 'reports/test-results/kept.json', untracked: false }), true);
  assert.equal(isApplicationChangeEntry({ newPath: 'src/components/FunctionGrapher.jsx', untracked: true }), true, 'new source still counts');
});

// ws-graph (2026-10-27): "Review and disposition CF-21034d278357; 4 item(s) remain" named one item, and
// its Copilot route was /sf-converge, the skill that had just stopped. The step names every item.
test('convergence adjudication names every item by ID and path for the person to decide', () => {
  const facts = ['package.json', 'package-lock.json', 'playwright.config.js', 'test-results/.last-run.json']
    .map((file, index) => ({ id: `CF-${index}${'a'.repeat(11)}`, kind: 'unclaimed-changed-path', paths: [file] }));
  const workflow = { workItem: { id: 'DEAD-1' } };
  const phase = { id: 'convergence', generation: { producer: 'deterministic', task: 'convergence' } };
  const [decide] = preparedPhaseNextActions(workflow, phase, {
    publicationProducer: 'deterministic', convergence: { facts, findings: [{ itemId: facts[0].id }], allowedNext: ['adjudicate'] } });
  assert.equal(decide.id, 'convergence.adjudicate');
  assert.match(decide.label, /^A person decides each of 3 convergence item\(s\): /u);
  for (const fact of facts.slice(1)) assert.ok(decide.label.includes(`${fact.id} unclaimed-changed-path: ${fact.paths[0]}`), fact.id);
  assert.ok(!decide.label.includes(facts[0].id), 'a decided item is not asked again');
  assert.match(decide.command, new RegExp(`story adjudicate ${facts[1].id} --disposition <rework\\|update-intent`, 'u'));
});

// A command with a placeholder the route filter refuses is dropped from every plan without a word: the
// include route for a source statement (`--clause <CLAUSE-ID,...>`) vanished, so refusals offered only
// exclude or defer (ws-graph, 2026-10-27). Help pages document usage and are not routes.
test('every placeholder in a command line SFlow emits is one the route filter accepts', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const accepted = /^<[A-Za-z][A-Za-z0-9 ._/|-]*>$/u;
  const files = [];
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file); else if (file.endsWith('.mjs') && !file.endsWith('help-text.mjs')) files.push(file);
  });
  walk(path.resolve('src'));
  const refused = [];
  for (const file of files) readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    if (!/singularity-flow [a-z]|'--[a-z]/u.test(line)) return;
    for (const [token] of line.matchAll(/<[A-Za-z][^<>\s'"`]{0,60}>/gu)) {
      if (!accepted.test(token) && !/^<\/?[a-z]+$/u.test(token.slice(0, -1))) refused.push(`${path.relative(path.resolve('.'), file)}:${index + 1} ${token}`);
    }
  });
  assert.deepEqual(refused, []);
  const { scopeDecisionArgv, scopeDecisionCommandLine } = await import('../src/scope/extract.mjs');
  const { safeCommandGuidance } = await import('../src/safe-command-guidance.mjs');
  const { linked, unlinked } = scopeDecisionArgv('DEAD-1', 'DOC-001');
  for (const argv of [linked, unlinked]) assert.ok(safeCommandGuidance({ command: scopeDecisionCommandLine(argv) }), argv.join(' '));
});

// A custom workflow's final step (2026-10-27): three clauses had no delivered implementation, owned by its
// code step `fmly-implementation`. The refusal offered only risk commands and said risk was not eligible.
test('a final check names an upstream issue for what an earlier step owns, and says truly whether risk is open', () => {
  const workflow = { workItem: { id: 'APP-1' }, status: 'in_progress', currentPhase: 'fmly-release',
    phaseOrder: ['fmly-spec', 'fmly-implementation', 'fmly-release'],
    phases: { 'fmly-spec': { generation: 1, status: 'approved', approvalPolicy: { authorities: ['product'] } },
      'fmly-implementation': { generation: 1, status: 'approved', approvalPolicy: { authorities: ['developers'] } },
      'fmly-release': { generation: 1, status: 'in_progress', approvalPolicy: { authorities: ['release'] } } } };
  const obligation = (responsibility, status, owner, subject) => ({ id: `OBL:APP-1:${responsibility}:${subject}`, responsibility, subject, status, owningSteps: [owner],
    facets: { freshness: 'current' } });
  const row = (id, obligations) => ({ id, result: 'missing', obligations, actions: [] });
  const rows = [row('APP:REQ-001', [obligation('implement', 'missing', 'fmly-implementation', 'APP:REQ-001')]),
    row('APP:AC-009', [obligation('verify', 'missing', 'fmly-implementation', 'APP:AC-009'), obligation('review', 'pending', 'fmly-release', 'APP:AC-009')])];
  const actions = terminalRecoveryActions('APP-1', { decision: { gate: 'block' }, rows }, null, workflow);
  assert.deepEqual(actions.slice(0, 2), [
    'singularity-flow upstream-issue raise --work-id APP-1 --phase fmly-implementation --about APP:REQ-001 --problem <what-is-wrong>',
    'singularity-flow upstream-issue raise --work-id APP-1 --phase fmly-implementation --about APP:AC-009 --problem <what-is-wrong>'
  ]);
  assert.equal(terminalRecoveryActions('APP-1', { decision: { gate: 'block' }, rows }).some((command) => command.includes('upstream-issue')), false,
    'without the Story, no route is guessed');
  const open = rows.flatMap((entry) => entry.obligations);
  assert.deepEqual(terminalRisk(workflow, open), { eligible: true, authorities: ['developers'], maximumDays: null });
  assert.equal(terminalRisk(workflow, [open[2]]).eligible, false, 'a pending review is approved, never accepted as a risk');
});

// No dead-ends: every refusal SFlow has its own recovery for builds a plan whose every command the route
// filter accepts. A refused command used to drop its whole step without a word (the include route,
// 2026-10-27); now it stays, marked, and this test fails on any mark.
test('every known refusal builds a recovery plan whose every command is one the route filter accepts', async () => {
  const { KNOWN_REFUSAL_CODES } = await import('../src/refusal-remediation.mjs');
  assert.ok(KNOWN_REFUSAL_CODES.length > 100, `${KNOWN_REFUSAL_CODES.length} codes`);
  const details = { workId: 'W-1', phase: 'build', phaseId: 'build', currentPhase: 'build', documentId: 'DOC-001', decidableStep: 'plan',
    issue: 'UPI-001', workType: 'feature', upstreamPhases: ['plan'], producerPhase: 'plan', restorable: true, paths: ['a.txt'],
    recoveryCommand: 'singularity-flow recover W-1 --json', errors: ['x'], authorities: ['product'], capabilityId: 'web-app',
    checkoutPath: '/tmp/checkout', storyId: 'W-1', expectedWorkId: 'W-1' };
  const rejected = [];
  for (const code of KNOWN_REFUSAL_CODES) {
    for (const argv of [['phase', 'prepublish', 'build', '--work-id', 'W-1'], ['approve', 'build', '--work-id', 'W-1'], ['start', 'W-1']]) {
      const plan = refusalRemediationPlan(Object.assign(new Error('refused'), { code, details }), argv);
      for (const entry of plan.steps) if (entry.commandRejected) rejected.push(`${code} (${argv[0]}): ${entry.id}`);
    }
  }
  assert.deepEqual(rejected, []);
  // The mark itself: a command the filter refuses keeps its step and label, with no command shown.
  const marked = refusalRemediationPlan(Object.assign(new Error('refused'), { code: 'APP_START_NOT_DECLARED',
    details: { capabilityId: 'web-app', nextAction: { command: 'singularity-flow app suggest --capability <ID,...> --json', label: 'Draft it.' } } }), ['app', 'start']);
  assert.ok(marked.steps.every((entry) => !entry.command || !entry.command.includes('<ID,...>')), 'an unsafe command is never shown');
});

// A screenshot's witness was its own step after the last submission (ws-graph AC-001, 2026-10-27). The
// approver now confirms it with the approval; the separate witness command stays as the other route.
test('an ending waiting on a witness offers to confirm the evidence with the approval itself, first', () => {
  const workflow = { workItem: { id: 'DEAD-1' }, status: 'in_progress', currentPhase: 'release', phaseOrder: ['release'], phases: { release: {} } };
  const row = { id: 'DEAD-1:AC-001', result: 'missing', actions: [],
    obligations: [{ responsibility: 'verify', status: 'missing', owningSteps: ['implementation'],
      plannedObligations: [{ fulfillment: 'evidence', expectedPaths: ['evidence/graph-tool.png'] }] }],
    verification: { contract: { slots: [{ slot: 'graph-reference-screenshot', method: 'visual', status: 'missing' }] } } };
  const actions = terminalRecoveryActions('DEAD-1', { decision: { gate: 'block' }, rows: [row] }, null, workflow);
  assert.equal(actions[0], 'singularity-flow approve release --work-id DEAD-1 --confirm-evidence');
  assert.match(actions[1], /^singularity-flow decision witness DEAD-1 --criterion DEAD-1:AC-001 --slot graph-reference-screenshot --file evidence\/graph-tool\.png /u);
});

test('a model-only step with the model off says how to turn the model back on', () => {
  assert.match(modelOffCause({ source: 'environment' }), /SINGULARITY_FLOW_NO_MODEL is set/u);
  assert.match(modelOffCause({ source: 'cli' }), /passed --no-model/u);
  const workflow = { workItem: { id: 'DEAD-1' }, status: 'in_progress', currentPhase: 'design', phaseOrder: ['design'],
    phases: { design: { id: 'design', label: 'Design', status: 'in_progress', generation: 0,
      generationPolicy: { allowedProducers: ['governed-agent'], defaultProducer: 'governed-agent' } } } };
  const [blocked] = workflowNextSteps(workflow, { modelMode: { enabled: false, source: 'environment' } });
  assert.equal(blocked.availability, 'blocked');
  assert.equal(blocked.command, 'singularity-flow nextsteps DEAD-1', 'asking again with --no-model only returns this block');
  assert.match(blocked.reason, /no configured model-free producer\. The model is off because SINGULARITY_FLOW_NO_MODEL/u);
});
