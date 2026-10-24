/**
 * The approval defects SPEC-OAP M0 fixes, each reproduced here first. `[docs/SPEC-OAP-ONE-APPROVAL-PATH-v1.md, M0]`
 *
 * A code reading on 2026-10-24 found them while counting what a person goes through to approve one
 * step. Each test names its defect number from the plan.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import * as messages from '../apps/vscode/src/views/messages.ts';
import * as webview from '../apps/vscode/src/views/webview.ts';
import { witnessMappingDecisions } from '../src/commands/approve.mjs';
import { ADEQUACY_FACETS } from '../src/wel-review.mjs';
import { parseArgs } from '../src/util.mjs';

const MAPPING = `sha256:${'a'.repeat(64)}`;
const TOMORROW = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/** The VS Code approval page, loaded with a stub `vscode`: its validation and arguments are pure. */
async function approvalPage() {
  const source = await readFile(new URL('../apps/vscode/src/views/approval-review.ts', import.meta.url), 'utf8');
  const exports = {};
  const context = vm.createContext({ exports, Date, require(name) {
    if (name === 'vscode') return {};
    if (name === './messages.ts') return messages;
    if (name === './webview.ts') return webview;
    if (name === './navigate.ts') return { navigateTo() {} };
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText, context);
  return exports;
}

const request = (extra = {}) => ({
  title: 'Approve Verification', expected: 'verification', workId: 'OAP-1', phaseId: 'verification',
  phaseLabel: 'Verification', generation: 1, artifact: null, articles: [], findings: [], witnessedClauses: null,
  witnessMappings: [{ mappingSha256: MAPPING, clauseId: 'OAP-1:AC-001', clauseText: 'The value is shown.',
    clauseFields: { behavior: 'shows the value', observable: 'the value' }, clauseStatus: 'current',
    sourcePath: 'test/value.test.mjs', logicalTestId: 'value shows', sourceDeclarationSha256: `sha256:${'b'.repeat(64)}` }],
  priorExceptions: [], selfApproval: false, ...extra
});

test('D1: a witness exception chosen in VS Code names its facets and is accepted by the CLI', async () => {
  const page = await approvalPage();
  const exception = { mappingSha256: MAPPING, decision: 'exception', reason: 'Boundary cases are covered by review.',
    expiresAt: TOMORROW, inadequate: ['assertions', 'boundaries'] };
  const checked = page.validateApprovalReviewSubmission(request(), { confirmation: 'verification', decisions: [], witnessDecisions: [exception] });
  assert.deepEqual([...checked.errors], []);
  assert.deepEqual([...(checked.value.witnessDecisions[0].inadequate ?? [])], ['assertions', 'boundaries']);
  const missingFacets = page.validateApprovalReviewSubmission(request(), { confirmation: 'verification', decisions: [],
    witnessDecisions: [{ ...exception, inadequate: [] }] });
  assert.equal(missingFacets.value, null);
  assert.match(missingFacets.errors.join('\n'), /which part of the test falls short/u);
  const unknownFacet = page.validateApprovalReviewSubmission(request(), { confirmation: 'verification', decisions: [],
    witnessDecisions: [{ ...exception, inadequate: ['vibes'] }] });
  assert.equal(unknownFacet.value, null, 'only the CLI\'s adequacy facets are offered');

  const argv = [...page.storyApprovalArguments({ workId: 'OAP-1', phaseId: 'verification', receiptToken: 'token',
    checklist: [], witnessDecisions: checked.value.witnessDecisions })];
  assert.deepEqual(argv.slice(argv.indexOf('--witness-mapping'), argv.indexOf('--witness-mapping') + 2),
    ['--witness-mapping', `${MAPPING}=exception:assertions,boundaries`]);
  // The same arguments, read by the CLI's own parser, are the decision the page recorded.
  const [cliDecision] = witnessMappingDecisions(parseArgs(argv).options);
  assert.deepEqual({ ...cliDecision }, { mappingSha256: MAPPING, decision: 'exception', inadequate: ['assertions', 'boundaries'],
    reason: exception.reason, expiresAt: TOMORROW });

  const html = page.approvalReviewBody(request());
  for (const facet of ADEQUACY_FACETS) assert.match(html, new RegExp(`data-facet="${facet}"`, 'u'), facet);
});

test('D2: a Story self-approval is shown as a warning, never a second confirmation the engine ignores', async () => {
  const page = await approvalPage();
  const selfApproved = request({ selfApproval: true, witnessMappings: [] });
  const checked = page.validateApprovalReviewSubmission(selfApproved, { confirmation: 'verification', decisions: [], witnessDecisions: [] });
  assert.deepEqual([...checked.errors], [], 'the typed phase is the one deliberate act');
  const html = page.approvalReviewBody(selfApproved);
  assert.match(html, /Self-approval — not independent review/u);
  assert.doesNotMatch(html, /data-self-approval/u);
  const argv = [...page.storyApprovalArguments({ workId: 'OAP-1', phaseId: 'verification', receiptToken: 'token',
    checklist: [], witnessDecisions: [] })];
  assert.deepEqual(argv, ['approve', 'OAP-1', '--fetch', '--phase', 'verification', '--selection-receipt', 'token']);
});

const AT = '2026-10-24T09:00:00.000Z';
const REQUEST = { id: 'TCD-001', phase: 'release', reason: 'The team runs run-checks.mjs for this module.', requestedBy: 'dev@example.invalid', at: AT,
  command: { id: 'repository-checks', kind: 'test', argv: ['node', 'run-checks.mjs'], workingDirectory: '.', affectedRoots: ['.'],
    result: { adapter: 'sflow-test-result-v1', path: '.sflow/results/checks.json' } } };
function releaseStory(status = 'awaiting_approval') {
  return {
    workItem: { id: 'OAP-2' }, status: 'in_progress', currentPhase: 'release',
    phaseOrder: ['implementation', 'release'],
    phases: {
      implementation: { id: 'implementation', label: 'Implementation', status: 'approved', generation: 1, writeScope: 'source-and-artifact',
        approvalPolicy: { authorities: ['engineering-reviewers'] } },
      release: { id: 'release', label: 'Release', status, generation: 1, requiredArtifact: { kind: 'conformance-report', path: 'artifacts/release/conformance.md' },
        approvalPolicy: { authorities: ['release-approvers'] } }
    },
    resolution: { approvalAuthorities: {
      'engineering-reviewers': { label: 'Engineering reviewers', allowAnyGitIdentity: true, members: [] },
      'release-approvers': { label: 'Release approvers', allowAnyGitIdentity: true, members: [] }
    } },
    testCommandDecisions: [structuredClone(REQUEST)], upstreamIssues: [], upstreamIssueDecisions: []
  };
}
const releaseGap = { report: 'release', clauseId: 'OAP-2:REQ-001', verdict: 'partial', line: 3, owner: 'implementation',
  status: 'unraised', issue: null, choices: [] };
const releaseFacts = (extra = {}) => ({ phaseId: 'release', at: AT, endsStory: true, gaps: [releaseGap], issues: [], activeReuse: [],
  candidates: [], reuseProblems: [], testRisks: [], testCommands: [structuredClone(REQUEST)], unavailable: [], state: {}, ...extra });
const releaseActor = { name: 'Release Person', email: 'release@example.invalid', login: null };

test('D3: a test-command decision is refused while its step awaits approval, instead of silently spoiling the approval', async () => {
  const { recordStoryTestCommandDecision, recordStoryTestCommandRequest } = await import('../src/story-test-commands.mjs');
  const during = releaseStory();
  assert.throws(() => recordStoryTestCommandDecision(during, { id: 'TCD-001', outcome: 'accept', actor: 'release@example.invalid',
    authorityGroup: 'release-approvers', at: AT }), (error) => {
    assert.equal(error.code, 'TEST_COMMAND_DECISION_DURING_REVIEW');
    assert.match(error.message, /Release is awaiting approval/u);
    assert.equal(error.details.nextAction.command, 'singularity-flow reject release --work-id OAP-2 --fetch --reason <REASON>');
    return true;
  });
  assert.throws(() => recordStoryTestCommandRequest(during, { phaseId: 'release', command: REQUEST.command, reason: REQUEST.reason,
    actor: 'dev@example.invalid', at: AT }), { code: 'TEST_COMMAND_DECISION_DURING_REVIEW' });
  assert.equal(during.testCommandDecisions.length, 1, 'nothing was recorded');
  // While the step is open it is decided as before.
  const open = releaseStory('in_progress');
  recordStoryTestCommandDecision(open, { id: 'TCD-001', outcome: 'accept', actor: 'release@example.invalid', authorityGroup: 'release-approvers', at: AT });
  assert.equal(open.phases.release.storyTestCommands.length, 1);

  const { decisionPacket } = await import('../src/decision-list.mjs');
  const workflow = releaseStory();
  const packet = decisionPacket(workflow, releaseFacts(), { authorities: workflow.resolution.approvalAuthorities, actor: releaseActor, at: AT });
  const item = packet.items.find((entry) => entry.kind === 'test-command');
  assert.ok(item.options.every((entry) => entry.recordable === false), 'the list offers no record that would spoil the approval');
  assert.match(item.options[0].words, /Release is awaiting approval/u);
});

test('D5: the decision list and readiness count the same decisions as holding an approval', async () => {
  const { decisionPacket } = await import('../src/decision-list.mjs');
  const { decisionGroups } = await import('../src/decision-list-facts.mjs');
  const workflow = releaseStory();
  const facts = releaseFacts();
  const packet = decisionPacket(workflow, facts, { authorities: workflow.resolution.approvalAuthorities, actor: releaseActor, at: AT });
  assert.equal(packet.items.length, 2);
  // pendingDecisionSummary (readiness, nextsteps, the refusal) counts decisionGroups plus evidence decisions.
  const holding = decisionGroups(workflow, { gaps: facts.gaps, issues: facts.issues, includeAllIssues: true }).length;
  assert.equal(packet.holding, holding);
  assert.deepEqual(packet.items.map((entry) => entry.holdsApproval), [true, false]);
  assert.match(packet.headline, /^Release can't be approved yet: 1 decision needed\./u);
});

/** The VS Code Reviews page with a stub `vscode`; the story catalog and proposal reads it also draws are stubbed. */
async function reviewsPage() {
  const source = await readFile(new URL('../apps/vscode/src/views/inbox.ts', import.meta.url), 'utf8');
  const approvalsModel = await import('../apps/vscode/src/views/approvals-model.ts');
  const inboxModel = await import('../apps/vscode/src/views/inbox-model.ts');
  const exports = {};
  const context = vm.createContext({ exports, Date, require(name) {
    if (name === 'vscode') return {};
    if (name === './approvals-model.ts') return approvalsModel;
    if (name === './inbox-model.ts') return inboxModel;
    if (name === './webview.ts') return webview;
    if (name === './messages.ts') return messages;
    if (name === './navigate.ts') return { navigateTo() {} };
    if (name === '../decisions.ts') return { decisionTargetText: () => '' };
    if (name === './workspace-stories-page.ts') return { workspaceStoriesHtml: () => '', storyCreatedDateHtml: () => '', STORY_FILTER_SCRIPT: '', STORY_CATALOG_STYLE: '' };
    if (name === './setup-review-repositories.ts') return { capabilityProposalCheck: () => null };
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return exports;
}

/** A checked-out Story whose Release awaits approval while the decision list holds it. */
function heldSnapshot(classification = 'decisions-required') {
  const phase = (id, label, status, extra = {}) => ({ id, label, status, generation: 1, artifacts: [], approvals: [], ...extra });
  return {
    initiative: null, initiatives: [], selectedInitiativeId: null,
    selectedWorkId: 'OAP-3', workItems: [{ id: 'OAP-3', title: 'Held release' }],
    identities: { git: { email: 'reviewer@example.com' } },
    workflow: {
      workItem: { id: 'OAP-3', title: 'Held release', branch: 'OAP-3', workType: 'demo' },
      currentPhase: 'release', phaseOrder: ['implementation', 'release'], status: 'in_progress',
      resolution: { approvalAuthorities: { 'release-approvers': { label: 'Release approvers', allowAnyGitIdentity: true, members: [] } } },
      phases: {
        implementation: phase('implementation', 'Implementation', 'approved'),
        release: phase('release', 'Release', 'awaiting_approval', { approvalPolicy: { authorities: ['release-approvers'], minimum: 1, rejectTo: ['release'] } })
      }
    },
    decisions: { schemaVersion: 1, workId: 'OAP-3', decisions: [], ahead: null, pending: null, skipped: [], log: [] },
    submissionReadiness: {
      phaseId: 'release', phaseStatus: 'awaiting_approval', classification, lifecycleReady: false,
      currentGeneration: 1, publishedGeneration: 1, draftExists: true, draftModified: false, publicationRecorded: true,
      nextSkill: '/sf-decide', nextCommand: 'singularity-flow decisions OAP-3', reasonCode: 'DECISIONS_REQUIRED',
      ...(classification === 'decisions-required' ? { decisions: { count: 2, headline: "Release can't be approved yet: 2 decisions needed." } } : {})
    }
  };
}

test('D6: Reviews and Approvals lead with the decisions that hold a step, not with Approve', async () => {
  const { buildApprovals } = await import('../apps/vscode/src/views/approvals-model.ts');
  const { buildInbox } = await import('../apps/vscode/src/views/inbox-model.ts');
  const { inboxHtml } = await reviewsPage();
  const [held] = buildApprovals(heldSnapshot()).pending;
  assert.equal(held.standing, 'yours', 'it is still the reviewer\'s work');
  assert.deepEqual(held.heldBy, { count: 2, headline: "Release can't be approved yet: 2 decisions needed." });
  const html = inboxHtml(buildInbox(heldSnapshot()));
  assert.match(html, /Release can&#39;t be approved yet: 2 decisions needed\./u);
  assert.match(html, /<button data-decide-list="[^"]+">Decide what blocks this step<\/button>/u);
  assert.doesNotMatch(html, /data-approve=/u, 'no Approve button while decisions hold the step');
  // Nothing held: Approve as before.
  const [ready] = buildApprovals(heldSnapshot('already-submitted')).pending;
  assert.equal(ready.heldBy, null);
  assert.match(inboxHtml(buildInbox(heldSnapshot('already-submitted'))), /data-approve=/u);
  const approvalsPanel = await readFile(new URL('../apps/vscode/src/views/approvals.ts', import.meta.url), 'utf8');
  assert.match(approvalsPanel, /approval\.heldBy\s*\?/u, 'the Approvals panel makes the same choice');
});

test('D8: a phase with an approval checklist shows its articles and is approved with them from any surface', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const YAML = (await import('yaml')).default;
  const { childTimeout } = await import('./helpers/child-timeout.mjs');
  const CLI = new URL('../bin/singularity-flow.mjs', import.meta.url).pathname;
  const WORK = 'OAP-8';
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-oap-checklist-'));
  t.after(() => rm(`${root}.git`, { recursive: true, force: true }).then(() => rm(root, { recursive: true, force: true })));
  const run = (command, args, allowFailure = false) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: childTimeout(60_000),
      env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Checklist Tester' } });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const git = (...args) => run('git', args).stdout.trim();
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Checklist Tester');
  git('config', 'user.email', 'checklist@example.test');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  cli('init');
  const configurationPath = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(configurationPath, 'utf8'));
  configuration.worldModel.grounding = 'off';
  configuration.approvalSecurity = { profile: 'poc' };
  configuration.repositoryReadiness = { ...(configuration.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  configuration.workTypes['spec-driven-standard'].sourceReview = { mode: 'off' };
  configuration.phases.specification.specificationQuality = { mode: 'enforce' };
  await writeFile(configurationPath, YAML.stringify(configuration));
  git('add', '.');
  git('commit', '-qm', 'Initialize checklist fixture');
  run('git', ['init', '--bare', '-q', '-b', 'main', `${root}.git`]);
  git('remote', 'add', 'origin', `${root}.git`);
  git('push', '-q', '-u', 'origin', 'main');
  cli('start', WORK, '--from-branch', 'main', '--work-type', 'spec-driven-standard', '--title', 'Validate a value', '--description', 'Return an approved value.');
  await writeFile(path.join(root, 'singularity/work-items', WORK, 'artifacts/specification/spec.md'), [
    `# ${WORK} — Specification`, '', '## Agent brief', '', 'The exported value must be 1, with a matching executable test.', '',
    '## Actors', '', 'A user reads the value.', '', '## User scenarios', '', '### S1 — Read the value', '',
    '- **Given** a ready application', '  **When** a user reads the value', '  **Then** 1 is displayed.', '',
    '## Failure and empty states', '', 'A missing value is rejected without inventing data.', '',
    '## Permissions', '', 'A user may read the value without special privileges.', '',
    '## Boundary conditions', '', 'Only the approved integer value is exposed.', '',
    '## Requirements', '', `- The application returns the value 1. [${WORK}:REQ-001]`, `- The user sees the value 1. [${WORK}:AC-001]`, '',
    '## Scenario coverage', '', '| Clause | Scenario | Outcome |', '|---|---|---|', `| \`${WORK}:REQ-001\` | S1 | success |`, `| \`${WORK}:AC-001\` | S1 | success |`, '',
    '## Boundary and non-functional requirements', '', 'Do not expose private data; invalid input is rejected deterministically.', '',
    '## Non-functional requirements', '', 'A local read returns deterministically within 50 ms without a network call.', '',
    '## Assumptions', '', 'The value is available in the local application.', '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${WORK}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Evidence and assumptions', '', 'The pinned repository is the implementation source.', '', '## Out of scope', '', 'No unrelated application changes.'
  ].join('\n'));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');

  // What /sf-approve and every other surface reads before the person confirms: the articles to answer.
  const shown = JSON.parse(cli('phase', 'show', 'specification', '--for-agent', '--json').stdout);
  const articles = ['completeness', 'ambiguity', 'consistency', 'verifiability', 'boundary-conditions', 'non-functional'];
  assert.deepEqual(shown.approvalChecklist?.articles?.map((article) => article.id), articles);
  assert.ok(shown.approvalChecklist.articles.every((article) => article.question));
  assert.deepEqual(shown.approvalChecklist.decisions, ['satisfied', 'exception', 'not-applicable']);

  // Unanswered: nothing about the work needs repairing, so no route recovers or rejects it.
  const refused = run(process.execPath, [CLI, '--no-model', 'approve', 'specification', '--yes', '--json'], true);
  const envelope = JSON.parse(refused.stdout);
  assert.equal(envelope.error.code, 'APPROVAL_CHECKLIST_INCOMPLETE');
  assert.deepEqual(envelope.error.details.articles, articles);
  assert.doesNotMatch(JSON.stringify(envelope.remediationPlan.steps), /\/sf-reject|singularity-flow reject|singularity-flow recover|leave-approval-turn/u);
  assert.match(envelope.remediationPlan.steps[0].label, /Answer each checklist article/u);

  cli('approve', 'specification', '--yes', ...articles.flatMap((id) => ['--article', `${id}=satisfied`]));
  const skill = await readFile(new URL('../plugin/skills/sflow-approve/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /`approvalChecklist`[^.]*--article <ID>=<DECISION>/u, 'Copilot passes the person\'s answers');
});

test('D7: VS Code shows what an approval did and the next step, instead of discarding the CLI\'s result', async () => {
  const page = await approvalPage();
  const output = [
    'Approval decision committed 1a2b3c4d and pushed to origin/OAP-1.',
    'Approved specification by tester@example.test through product-approvers; agent analyst.',
    'Context boundary: new. The approved phase is committed and pushed; start a clean Copilot conversation and rebuild the next phase from Git context.',
    'Approved specification. The Story is now at planning.', '',
    'Explore, here are your next steps:',
    '  NOW   Generate the required Planning artifact, then publish it.',
    '        Copilot: /sf-phase',
    '        Shell: singularity-flow prepare planning',
    '  SOON  Publish the Planning you authored in place, without invoking a model.'
  ].join('\n');
  assert.deepEqual({ ...page.approvalOutcome(output) }, { headline: 'Approved specification. The Story is now at planning.',
    next: 'Generate the required Planning artifact, then publish it.' });
  const partial = 'Approval decision committed 1a2b3c4d and pushed to origin/OAP-1.\nApproved specification by a@example.test through product-approvers; agent analyst.\nRecorded an approval for specification; it still needs more approvals before the Story moves on.';
  assert.equal(page.approvalOutcome(partial).headline, 'Recorded an approval for specification; it still needs more approvals before the Story moves on.');
  assert.equal(page.approvalOutcome('').headline, 'Approval recorded.');
  const actions = await readFile(new URL('../apps/vscode/src/actions.ts', import.meta.url), 'utf8');
  assert.match(actions, /approvalOutcome\(result\.output\)/u, 'the approval surface reads the CLI\'s own result');
  assert.match(actions, /output\.appendLine\(result\.output\)/u, 'the full result stays in the output channel');
});
