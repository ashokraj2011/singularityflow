/**
 * One approval check every surface reads [docs/SPEC-OAP-ONE-APPROVAL-PATH-v1.md, M1].
 *
 * evaluateApproval is the approval gate, run as stages over shared facts: recording throws its first
 * refusal (approvePhase), previewing keeps every refusal as a hold with who clears it. These tests
 * pin that the two are the same code, that every hold has an owner, and that a real Story's preview
 * and its recorded refusal agree.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { APPROVAL_HOLD_OWNERS, HOLD_PARTY_KINDS, approvalHold, approvalHoldOwner, partyWords } from '../src/approval-check.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { CLI, specification, submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

const OWNERS = ['you-decide', 'someone-decides', 'author-repairs', 'machine', 'this-checkout'];
const stateSource = await readFile(new URL('../src/state.mjs', import.meta.url), 'utf8');
const evaluateSource = stateSource.slice(stateSource.indexOf('export async function evaluateApproval('),
  stateSource.indexOf('export async function approvePhase('));
const recordSource = stateSource.slice(stateSource.indexOf('export async function approvePhase('));
const recordBody = recordSource.slice(0, recordSource.indexOf('\n}\n') + 2);

test('the gate guard: every refusal comes from the one check, and every one names who clears it', () => {
  assert.ok(evaluateSource.length > 10_000, 'evaluateApproval holds the gate');
  const codes = [...new Set([...evaluateSource.matchAll(/code: '([A-Z][A-Z0-9_]+)'/gu)].map((match) => match[1]))];
  assert.ok(codes.length >= 15, String(codes.length));
  assert.deepEqual(codes.filter((code) => !APPROVAL_HOLD_OWNERS[code]), [],
    'a refusal the approval gate throws has no owner class in APPROVAL_HOLD_OWNERS (src/approval-check.mjs)');
  for (const [code, owner] of Object.entries(APPROVAL_HOLD_OWNERS)) assert.ok(OWNERS.includes(owner), `${code}: ${owner}`);
  // Recording adds no refusal of its own: everything that can refuse is a stage the preview runs.
  assert.doesNotMatch(recordBody, /new SingularityFlowError|\bthrow\b/u, 'approvePhase refuses only through evaluateApproval');
  assert.match(recordBody, /await evaluateApproval\(root, config, workflow, \{ \.\.\.options, preview: false \}\)/u);
  // Nothing in the check runs outside a stage, so the preview sees every refusal the gate can raise.
  const body = evaluateSource.slice(evaluateSource.indexOf('\n  try {\n') + 9, evaluateSource.indexOf('\n  } catch (error) {\n    if (error !== APPROVAL_PREVIEW_STOP)'));
  const outside = body.split('\n').filter((line) => /^ {4}\S/u.test(line) && !/^ {4}(await stage\(|\}(\)|, \{))/u.test(line));
  assert.deepEqual(outside, [], 'a check outside a stage would refuse without the preview seeing it');
});

/** The refusal codes the modules evaluateApproval's stages call can raise, read from their source. */
async function stageModuleCodes() {
  const modules = new Set();
  for (const match of stateSource.matchAll(/import \{([^}]+)\} from '(\.\/[^']+)'/gu)) {
    if (match[1].split(',').some((name) => evaluateSource.includes(`${name.trim().split(' as ')[0].trim()}(`))) modules.add(match[2]);
  }
  for (const match of evaluateSource.matchAll(/import\('(\.\/[^']+)'\)/gu)) modules.add(match[1]);
  for (const match of evaluateSource.matchAll(/path\.join\(PACKAGE_ROOT, 'src', '([^']+)'\)/gu)) modules.add(`./${match[1]}`);
  const codes = new Set();
  for (const module of modules) {
    const source = await readFile(new URL(`../src/${module.slice(2)}`, import.meta.url), 'utf8').catch(() => '');
    for (const match of source.matchAll(/\bcode: '([A-Z][A-Z0-9_]+)'|\b(?:araFail|fail)\(\s*'([A-Z][A-Z0-9_]+)'/gu)) codes.add(match[1] ?? match[2]);
  }
  return { modules, codes };
}

// What a stage's module can raise that names no owner yet. An upper bound read from source: most are
// other commands' refusals in the same module. Each reads "Singularity Flow cannot say who clears
// this" and goes to recover, never to reject, so none lies. Name who clears a new one in
// APPROVAL_HOLD_OWNERS rather than adding it here; a ratchet, so this list only shrinks.
const UNCLASSIFIED_STAGE_CODES = Object.freeze([
  'AGENT_BRIEF_HEADING_AMBIGUOUS', 'AGENT_BRIEF_MAXIMUM_BYTES_EXCEEDED', 'AGENT_BRIEF_PRESERVED_SECTION_REQUIRED',
  'AGENT_BRIEF_SOURCE_REQUIRED', 'AGENT_BRIEF_SUMMARY_REQUIRED', 'AMENDMENT_ACKNOWLEDGEMENT_INVALID',
  'AMENDMENT_ACKNOWLEDGEMENT_UNNEEDED', 'APPROVAL_POLICY_UNATTAINABLE', 'ARA_AUTHORITY_CHANGED',
  'ARA_FEEDBACK_INVALID', 'ARA_FINDING_LIMIT', 'ARA_HUMAN_ACTION_REQUIRED', 'ARA_IDEMPOTENCY_CONFLICT',
  'ARA_MAPPING_REQUIRED', 'ARA_NOT_ADOPTED', 'ARA_REPAIR_AUTHORITY_REQUIRED', 'ARA_REPAIR_DIRECTION_REQUIRED',
  'ARA_REPAIR_LIMIT_REACHED', 'ARA_REPAIR_NOT_AUTHORIZED', 'ARA_REPAIR_NOT_READY', 'ARA_REVISION_CONFLICT',
  'ARA_SESSION_LIMIT', 'ARA_SNAPSHOT_INVALID', 'ARA_SUCCESSOR_REQUIRED', 'ARTIFACT_COMMENT_UNCLOSED',
  'ARTIFACT_PATH_UNREPRESENTABLE', 'AUTO_CANDIDATE_SUBMISSION_MISMATCH', 'CAPABILITY_PROPOSAL_REBASE_PLAN_STALE',
  'CHANGE_SET_POLICY_VIOLATION', 'CODE_DELIVERY_EVIDENCE_TOO_LARGE', 'CODE_DELIVERY_REUSE_INVALID',
  'CODE_DELIVERY_SCOPE_INVALID', 'CODE_DELIVERY_SOURCE_BINDING_TOO_LARGE', 'CODE_DELIVERY_SOURCE_CLAUSE_ID_INVALID',
  'CONFIGURATION_PROPOSAL_EXACT_TREE_UNAVAILABLE', 'DECISIONS_PHASE_UNKNOWN', 'DECISION_CHOICE_REQUIRED',
  'DECISION_CONDITION_REQUIRED', 'DECISION_INPUTS_MISSING', 'DECISION_INPUT_INVALID', 'DECISION_INPUT_UNKNOWN',
  'DECISION_NOT_PENDING', 'DECISION_OPTION_UNKNOWN', 'DECISION_STEP_NOT_ALLOWED', 'DOCUMENT_REUPLOAD_REQUIRED',
  'ENVIRONMENT_AUDIT_HEAD_UNREADABLE', 'ENVIRONMENT_AUDIT_INDEX_UNREADABLE', 'ENVIRONMENT_DECLARATION_INVALID',
  'ENVIRONMENT_LOCAL_CONTENT_REFUSED', 'ENVIRONMENT_POLICY_UNAVAILABLE', 'EVIDENCE_CLAUSE_UNAPPROVED',
  'EVIDENCE_CRITERION_UNKNOWN', 'GENERATION_EXCLUDED_CHANGES_UNRESOLVED', 'GENERATION_EXCLUSIONS_UNSAFE',
  'GIT_COMMITTED_FILE_LIMIT', 'GIT_COMMIT_IDENTITY_INVALID', 'GIT_COMMIT_SIGNING_INVALID',
  'GIT_DEVELOPER_TOOLS_UNAVAILABLE', 'GIT_OBJECT_FORMAT_UNAVAILABLE', 'GIT_OBJECT_READ_UNAVAILABLE',
  'GIT_OBJECT_REPOSITORY_INVALID', 'GIT_OBJECT_REPOSITORY_LIMIT', 'GIT_OBJECT_REPOSITORY_UNAVAILABLE',
  'GIT_OBJECT_WRITE_UNAVAILABLE', 'GIT_PARTIAL_CLONE_FETCH_FAILED', 'GIT_PARTIAL_CLONE_TOO_MANY_MISSING',
  'GIT_READ_UNAVAILABLE', 'GIT_REF_SELECTION_INVALID', 'GIT_REMOTE_AUTHORITY_CHANGED', 'GIT_REMOTE_BRANCH_INVALID',
  'GIT_REMOTE_CONFIG_INVALID', 'GOVERNANCE_BACKUP_EXISTS', 'LOCAL_FAST_FORWARD_FAILED', 'LOCAL_READ_TIMEOUT_INVALID',
  'MISSING_ARGUMENT', 'NETWORK_DISABLED', 'PENDING_PUBLICATION_CANDIDATE_INVALID',
  'PENDING_PUBLICATION_IDENTITY_INVALID', 'PENDING_PUBLICATION_PROGRESS_INTEGRITY_INVALID',
  'PENDING_PUBLICATION_ROOT_UNPROVEN', 'PHASE_REPAIR_ADMISSION_REFUSED', 'PHASE_REPAIR_LOCK_REQUIRED',
  'PHASE_REPAIR_QUARANTINE_STALE', 'PROSPECTIVE_TREE_INVALID', 'PSS_RECORD_UNSIGNED', 'PUBLICATION_BRANCH_CHANGED',
  'PUBLICATION_CANDIDATE_DRIFT', 'PUBLICATION_MARKER_UNREADABLE', 'PUBLICATION_RECOVERY_DIVERGED',
  'PUBLICATION_RECOVERY_REQUIRED', 'PUBLICATION_REF_OUTCOME_UNKNOWN', 'PUBLICATION_REF_REQUEST_INVALID',
  'PUBLICATION_REF_REQUEST_UNVERIFIED', 'PUBLICATION_SNAPSHOT_UNVERIFIED', 'PUBLICATION_SYMBOLIC_REF_UNSUPPORTED',
  'PUSH_EXPECTED_REVISION_REQUIRED', 'RECOVERY_COMMIT_CHANGED', 'RECOVERY_COMMIT_FAILED', 'RECOVERY_PLAN_STALE',
  'REPOSITORY_PATH_UNSAFE', 'REV_ATTESTATION_RECOVERY_MISMATCH', 'REV_ATTESTATION_RECOVERY_UNPROVEN',
  'SCHEMA_FAMILY_UNKNOWN', 'SCHEMA_MIGRATION_INVALID', 'SCHEMA_MIGRATION_NONDETERMINISTIC',
  'SCHEMA_MIGRATION_SOURCE_CORRUPT', 'SCHEMA_RECORD_INVALID', 'SCHEMA_VERSION_ARCHIVED', 'SCHEMA_VERSION_FUTURE',
  'SCHEMA_VERSION_MISSING', 'SECRET_DETECTED', 'SECRET_SCAN_UNREADABLE', 'SELECTION_REQUIRED',
  'SEQUENCE_CONFIRMATION_REQUIRED', 'SFG_REPORT_SINCE_INVALID', 'SKP_ARTIFACT_SET_INVALID', 'SKP_AUTHORITY_UNKNOWN',
  'SKP_CAPTURE_UNSTABLE', 'SKP_CHECK_UNKNOWN', 'SKP_CODE_TASK_REQUIRED', 'SKP_CONTRACT_EMPTY',
  'SKP_CONTRACT_INVALID', 'SKP_CONTRACT_UNCONFIRMED', 'SKP_INPUT_RECEIPT_MISSING', 'SKP_INPUT_RECEIPT_STALE',
  'SKP_OUTPUT_DUPLICATE', 'SKP_OUTPUT_INVALID', 'SKP_OUTPUT_MISSING', 'SKP_OUTPUT_PATH_INVALID',
  'SKP_OUTPUT_UNDECLARED', 'SKP_OUTPUT_UNREGISTERED', 'SKP_PACKAGE_CORRUPT', 'SKP_SCOPE_REQUIRES_CHECKS',
  'SOURCE_REVIEW_AGENT_NOT_PINNED', 'SOURCE_REVIEW_AGENT_UNAVAILABLE', 'SOURCE_REVIEW_BINDING_STALE',
  'SOURCE_REVIEW_CLARIFICATION_INVALID', 'SOURCE_REVIEW_DECISION_UNAUTHORIZED',
  'SOURCE_REVIEW_DISPOSITION_AUTHORITY_REQUIRED', 'SOURCE_REVIEW_DISPOSITION_NOT_PENDING',
  'SOURCE_REVIEW_DISPOSITION_REASON_REQUIRED', 'SOURCE_REVIEW_EVENT_MISSING', 'SOURCE_REVIEW_EVENT_REQUIRED',
  'SOURCE_REVIEW_GENERATION_REQUIRED', 'SOURCE_REVIEW_INDEPENDENT_AGENT_REQUIRED', 'SOURCE_REVIEW_INPUT_TOO_LARGE',
  'SOURCE_REVIEW_INPUT_UNAVAILABLE', 'SOURCE_REVIEW_INPUT_UNPUBLISHED', 'SOURCE_REVIEW_INPUT_UNREADABLE',
  'SOURCE_REVIEW_RECORD_INVALID', 'SOURCE_REVIEW_RECORD_UNPUBLISHED', 'SOURCE_REVIEW_REPORT_INVALID',
  'SOURCE_REVIEW_SESSION_SCOPE_INVALID', 'SOURCE_REVIEW_SOURCE_CHANGED', 'SOURCE_REVIEW_SOURCE_UNPINNED',
  'SOURCE_REVIEW_SPEC_NOT_APPROVED', 'SOURCE_REVIEW_SUCCESSOR_UNPUBLISHED', 'SPECIFICATION_ACCEPTANCE_UNTRUSTED',
  'SPECIFICATION_CLAIM_MAP_BINDING_REQUIRED', 'SPECIFICATION_CLAIM_MAP_BINDING_STALE',
  'SPECIFICATION_CLAIM_MAP_IDENTITY_INVALID', 'SPECIFICATION_GITLINK_DIRTY', 'SPECIFICATION_INDEX_BINDING_REQUIRED',
  'SPECIFICATION_INDEX_BINDING_STALE', 'SPECIFICATION_INDEX_NOT_SUBMITTED', 'SPECIFICATION_INDEX_UNTRUSTED',
  'SPECIFICATION_INPUT_NOT_COMMITTED', 'SPEC_CLAIM_MAP_UNKNOWN_CLAUSE', 'SPEC_CLAUSE_DEPENDENCY_CYCLE',
  'SPEC_CLAUSE_DEPENDENCY_MISSING', 'SPEC_CLAUSE_REDEFINED', 'SPEC_EXCLUDES_RETIRED',
  'SPEC_OBSERVED_TEST_ONLY_EVIDENCE_INVALID', 'SPEC_PLANNED_ALLOCATION_INVALID',
  'SPEC_PLANNED_EVIDENCE_TYPE_INVALID', 'SPEC_PLANNED_FULFILLMENT_INVALID', 'SPEC_PLANNED_OBSERVABLE_INVALID',
  'SPEC_PLANNED_PATH_ROLE_INVALID', 'SPEC_PLANNED_PATH_SENTINEL_INVALID', 'SPEC_PLANNED_ROW_REQUIRED',
  'SPEC_PLANNED_TABLE_INVALID', 'SPEC_SUPPORTING_FILE_INVALID', 'SPEC_VERIFICATION_INTENT_INVALID',
  'STORY_PROMOTION_CANDIDATE_INVALID', 'STORY_PROMOTION_NOT_FAST_FORWARD', 'STORY_PROMOTION_PUSH_FAILED',
  'STORY_PROMOTION_RECOVERY_INVALID', 'STORY_PROMOTION_REMOTE_UNAVAILABLE', 'STORY_PUBLICATION_IN_PROGRESS',
  'SUBPROCESS_OUTPUT_TOO_LARGE', 'SUBPROCESS_TIMEOUT', 'SUBPROCESS_UNAVAILABLE', 'SYMLINK_DELIVERY_FORBIDDEN',
  'TRP_RISK_ADAPTER_UNAVAILABLE', 'WORKFLOW_CONVERGENCE_MULTIPLE_UNSUPPORTED', 'WORKFLOW_DECISION_INVALID',
  'WORKFLOW_TEMPLATE_NOT_INSTALLED', 'WORKING_DIRECTORY_MISSING', 'WORK_INTERVAL_AMENDMENT_INVALID',
  'WORK_PENDING_SUBJECT_KEY_REQUIRED', 'WORK_RECONCILIATION_BINDING_MISMATCH', 'WORK_RECONCILIATION_HASH_MISMATCH',
  'WORK_RECONCILIATION_INVALID', 'WORK_RECONCILIATION_TARGET_DRIFT'
]);

test('the transitive guard: a code a stage\'s module can raise has an owner, or is pinned as unknown', async () => {
  const { modules, codes } = await stageModuleCodes();
  assert.ok(modules.size >= 30, String(modules.size));
  const unclassified = [...codes].filter((code) => approvalHoldOwner(new SingularityFlowError('refused', { code })) === 'unknown').sort();
  assert.deepEqual(unclassified.filter((code) => !UNCLASSIFIED_STAGE_CODES.includes(code)), [],
    'a stage can now raise a code nothing says who clears: add it to APPROVAL_HOLD_OWNERS (src/approval-check.mjs)');
  assert.deepEqual(UNCLASSIFIED_STAGE_CODES.filter((code) => !unclassified.includes(code)), [], 'no module raises these any more: drop them from the pin');
});

test('every hold says who clears it: a kind, always, and words only from that kind', () => {
  const workflow = { workItem: { id: 'W-1' }, currentPhase: 'implementation', phases: { implementation: { id: 'implementation', label: 'Implementation' } }, resolution: {} };
  const phase = workflow.phases.implementation;
  for (const code of [...Object.keys(APPROVAL_HOLD_OWNERS), 'A_CODE_NOBODY_LISTED', 'IMPLEMENTATION_BINDING_DECISION_INVALID', 'CONVERGENCE_STALE']) {
    const hold = approvalHold(new SingularityFlowError('refused', { code }), workflow, phase);
    assert.ok(HOLD_PARTY_KINDS.includes(hold.clearedBy?.kind), `${code}: ${JSON.stringify(hold.clearedBy)}`);
    assert.equal(hold.who, partyWords(hold.clearedBy, workflow), code);
    assert.ok(hold.who, code);
    if (hold.clearedBy.kind === 'nobody') {
      assert.equal(hold.who, 'Singularity Flow cannot say who clears this', code);
      assert.doesNotMatch(hold.action?.command ?? '', /^singularity-flow reject /u, `${code}: nobody knows, so nothing offers a return`);
    }
  }
});

test('only what the approval\'s own form asks counts as an answer in the approval: nothing else says ready', () => {
  const answered = Object.entries(APPROVAL_HOLD_OWNERS).filter(([, owner]) => owner === 'you-decide').map(([code]) => code).sort();
  assert.deepEqual(answered, ['APPROVAL_CHECKLIST_INCOMPLETE', 'WEL_WITNESS_MAPPING_UNREVIEWED']);
  // Each of these is a step of its own, whatever the check once said: the gate refused after "ready".
  for (const code of ['ARA_REVIEW_REQUIRED', 'ARA_EVIDENCE_UNAVAILABLE', 'ARA_REVIEW_STALE', 'READ_ONLY_AGENT_CANNOT_MUTATE', 'SOURCE_REVIEW_REVIEWER_CANNOT_APPROVE', 'INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED']) {
    assert.notEqual(approvalHoldOwner(new SingularityFlowError('refused', { code })), 'you-decide', code);
  }
});

test('who clears a hold follows what it says', () => {
  const error = (code, details = {}) => new SingularityFlowError('refused', { code, details });
  assert.equal(approvalHoldOwner(error('STORY_REVIEW_INTERVENING_COMMIT')), 'author-repairs');
  assert.equal(approvalHoldOwner(error('STORY_REVIEW_INTERVENING_COMMIT', { pendingIntentAmendments: [{ id: 'AMD-001' }] })), 'someone-decides');
  assert.equal(approvalHoldOwner(error('PHASE_VALIDATION_FAILED')), 'author-repairs');
  assert.equal(approvalHoldOwner(error('PHASE_VALIDATION_FAILED', { testRunRisk: { lapsed: 'expired' } })), 'someone-decides');
  assert.equal(approvalHoldOwner(error('APPROVAL_CHECKLIST_INCOMPLETE')), 'you-decide');
  assert.equal(approvalHoldOwner(error('IMPLEMENTATION_BINDING_DECISION_INVALID')), 'you-decide');
  assert.equal(approvalHoldOwner(error('STORY_PUBLICATION_PENDING')), 'machine');
  assert.equal(approvalHoldOwner(error('A_CODE_NOBODY_LISTED')), 'unknown', 'nothing about it says the author clears it');
});

test('a real Story: the preview lists every hold in gate order, and recording refuses with the first', async (t) => {
  const WORK = 'OAP-M1';
  const { run, git, cli, submitted } = await submittedPlanningStory(t, WORK);
  const readiness = () => JSON.parse(cli('status', WORK, '--submission-readiness', '--json').stdout);
  const clean = readiness().approvalCheck;
  assert.deepEqual({ ready: clean.ready, holds: clean.holds }, { ready: true, holds: [] });
  assert.equal(clean.statement, 'Approving planning would pass every check.');

  // Application source committed during review: two holds, the source binding and the commit itself.
  const root = git('rev-parse', '--show-toplevel');
  await writeFile(path.join(root, 'value.mjs'), 'export const value = 1;\n');
  git('add', 'value.mjs');
  git('commit', '-qm', 'Implement the value during the planning review');
  const heldReadiness = readiness(); const held = heldReadiness.approvalCheck;
  assert.equal(heldReadiness.classification, 'already-submitted');
  assert.equal(heldReadiness.reasonCode, 'APPROVAL_HOLDS_REQUIRED');
  // The author revises it: the way through is a return for changes, which /sf-decide never does.
  assert.equal(heldReadiness.nextCommand, `singularity-flow reject planning --work-id ${WORK} --fetch --reason <REASON>`);
  assert.equal(heldReadiness.command, heldReadiness.nextCommand);
  assert.equal(heldReadiness.nextSkill, '/sf-reject');
  assert.equal(held.ready, false);
  assert.deepEqual(held.holds.map((hold) => [hold.code, hold.owner]),
    [['STORY_REVIEW_SOURCE_CHANGED', 'author-repairs'], ['STORY_REVIEW_INTERVENING_COMMIT', 'author-repairs']]);
  assert.ok(held.holds.every((hold) => hold.who && hold.summary));
  const shown = JSON.parse(cli('phase', 'show', 'planning', '--json').stdout).approvalCheck;
  assert.deepEqual(shown.holds.map((hold) => hold.code), held.holds.map((hold) => hold.code), 'phase show reads the same check');
  const refused = run(process.execPath, [CLI, '--no-model', 'approve', 'planning', '--work-id', WORK, '--yes', '--json'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.equal(JSON.parse(refused.stdout).error.code, held.holds[0].code, 'the gate refuses with the preview\'s first hold');
  assert.equal(git('rev-list', '--count', `${submitted}..HEAD`), '1', 'the preview and the refusal recorded nothing');
});

/**
 * A Story whose planning awaits approval, with intent amendment AMD-001 to propose and reject. A
 * crafted commit is published as a person would push it, so only the history rule can tell it apart.
 */
async function amendmentStory(t, WORK) {
  const fixture = await submittedPlanningStory(t, WORK);
  const { run, git, cli, candidate } = fixture;
  await writeFile(candidate, specification(WORK, 2));
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  return {
    ...fixture,
    root: git('rev-parse', '--show-toplevel'),
    head: () => git('rev-parse', '--short=12', 'HEAD'),
    propose: () => cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed that value 2 is required.'),
    reject: () => cli('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'reject', '--confirm', 'AMD-001'),
    publish: () => git('push', '-q', '-f', 'origin', `HEAD:refs/heads/${branch}`),
    refused: () => {
      const result = run(process.execPath, [CLI, '--no-model', 'approve', 'planning', '--work-id', WORK, '--yes', '--json'], { allowFailure: true });
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout).error;
    }
  };
}

const PROPOSE = (WORK) => `[${WORK}][intent-amendment:propose] AMD-001`;
const REJECT = (WORK) => `[${WORK}][intent-amendment:reject] AMD-001`;

/**
 * SPEC-OAP decision 1 lets a rejected amendment's proposal and rejection precede approval only when
 * each is exactly what those commands record (rejectedIntentAmendments in src/state.mjs). The real
 * journey passes (test/approval-intervening-commits.test.mjs); a pending amendment still holds (the
 * same file). These do not count as one.
 */
test('a rejection commit that also changes application source is no rejected amendment, in the preview or the gate', async (t) => {
  const WORK = 'OAP-RJ1';
  const { git, cli, root, head, propose, reject, publish, refused } = await amendmentStory(t, WORK);
  propose();
  const proposal = head();
  reject();
  await writeFile(path.join(root, 'value.mjs'), 'export const value = 2;\n');
  git('add', 'value.mjs');
  git('commit', '-q', '--amend', '--no-edit');
  publish();
  const readiness = JSON.parse(cli('status', WORK, '--submission-readiness', '--json').stdout);
  assert.deepEqual(readiness.approvalCheck.holds.map((hold) => hold.code), ['STORY_REVIEW_SOURCE_CHANGED', 'STORY_REVIEW_INTERVENING_COMMIT']);
  assert.equal(readiness.approvalCheck.notes, undefined, 'nothing is noted as a rejected amendment');
  assert.deepEqual(readiness.blockingCommits.commits.map((entry) => [entry.commit, entry.subject]),
    [[proposal, PROPOSE(WORK)], [head(), REJECT(WORK)]]);
  assert.match(readiness.blockingCommits.lines.join('\n'),
    /Decided after the submission: intent amendment AMD-001 \(rejected\)\. Only a rejected amendment whose proposal and rejection change nothing else may precede approval/u);
  assert.equal(refused().code, 'STORY_REVIEW_SOURCE_CHANGED', 'the gate refuses with the preview\'s first hold');
});

test('a merge commit carrying the rejection is no rejected amendment', async (t) => {
  const WORK = 'OAP-RJ2';
  const { git, head, propose, reject, publish, refused } = await amendmentStory(t, WORK);
  propose();
  const proposal = head();
  reject();
  const rejection = git('rev-parse', 'HEAD');
  // The same rejection, subject and trailers merged in: a commit with two parents is never one.
  git('reset', '-q', '--hard', proposal);
  git('merge', '-q', '--no-ff', '-m', git('log', '-1', '--format=%B', rejection), rejection);
  publish();
  const error = refused();
  assert.equal(error.code, 'STORY_REVIEW_INTERVENING_COMMIT');
  assert.deepEqual(error.details.blockingCommits.map((entry) => [entry.commit, entry.subject]),
    [[proposal, PROPOSE(WORK)], [head(), REJECT(WORK)]]);
});

test('a proposal commit that adds a file of its own is no rejected amendment', async (t) => {
  const WORK = 'OAP-RJ3';
  const { git, item, head, propose, reject, publish, refused } = await amendmentStory(t, WORK);
  propose();
  const notes = path.join(item, 'context/intent-amendments/AMD-001-notes.md');
  await writeFile(notes, 'Why the value changes.\n');
  git('add', notes);
  git('commit', '-q', '--amend', '--no-edit');
  publish();
  const proposal = head();
  reject();
  const error = refused();
  assert.equal(error.code, 'STORY_REVIEW_INTERVENING_COMMIT');
  assert.deepEqual(error.details.blockingCommits.map((entry) => [entry.commit, entry.subject]),
    [[proposal, PROPOSE(WORK)], [head(), REJECT(WORK)]]);
});

test('VS Code Reviews shows the holds the preview found and offers no approval into them', async () => {
  const vm = (await import('node:vm')).default;
  const ts = (await import('typescript')).default;
  const messages = await import('../apps/vscode/src/views/messages.ts');
  const webview = await import('../apps/vscode/src/views/webview.ts');
  const approvalsModel = await import('../apps/vscode/src/views/approvals-model.ts');
  const inboxModel = await import('../apps/vscode/src/views/inbox-model.ts');
  const source = await readFile(new URL('../apps/vscode/src/views/inbox.ts', import.meta.url), 'utf8');
  const exports = {};
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    vm.createContext({ exports, Date, require(name) {
      const modules = { vscode: {}, './approvals-model.ts': approvalsModel, './inbox-model.ts': inboxModel, './webview.ts': webview,
        './messages.ts': messages, './navigate.ts': { navigateTo() {} }, '../decisions.ts': { decisionTargetText: () => '' },
        './workspace-stories-page.ts': { workspaceStoriesHtml: () => '', storyCreatedDateHtml: () => '', STORY_FILTER_SCRIPT: '', STORY_CATALOG_STYLE: '' },
        './setup-review-repositories.ts': { capabilityProposalCheck: () => null } };
      if (name in modules) return modules[name];
      throw new Error(`Unexpected dependency: ${name}`);
    } }));
  const snapshot = (holds) => ({
    initiative: null, initiatives: [], selectedInitiativeId: null, selectedWorkId: 'OAP-9', workItems: [{ id: 'OAP-9', title: 'Held' }],
    identities: { git: { email: 'reviewer@example.com' } },
    workflow: { workItem: { id: 'OAP-9', title: 'Held', branch: 'OAP-9', workType: 'demo' }, currentPhase: 'planning', phaseOrder: ['planning'],
      status: 'in_progress', resolution: { approvalAuthorities: { reviewers: { label: 'Reviewers', allowAnyGitIdentity: true, members: [] } } },
      phases: { planning: { id: 'planning', label: 'Planning', status: 'awaiting_approval', generation: 1, artifacts: [], approvals: [],
        approvalPolicy: { authorities: ['reviewers'], minimum: 1, rejectTo: ['planning'] } } } },
    decisions: { schemaVersion: 1, workId: 'OAP-9', decisions: [], ahead: null, pending: null, skipped: [], log: [] },
    submissionReadiness: { phaseId: 'planning', phaseStatus: 'awaiting_approval', classification: 'already-submitted', lifecycleReady: false,
      currentGeneration: 1, publishedGeneration: 1, draftExists: true, draftModified: false, publicationRecorded: true, nextSkill: null, nextCommand: null,
      approvalCheck: { advisory: true, ready: !holds.some((hold) => hold.owner !== 'you-decide'), statement: 'x', holds } }
  });
  const source_changed = { code: 'STORY_REVIEW_SOURCE_CHANGED', owner: 'author-repairs', who: 'The author revises it',
    summary: "Phase 'planning' application source or tests changed after generation 1 was submitted.",
    action: { label: 'Return planning for changes.', command: 'singularity-flow reject planning --work-id OAP-9 --fetch --reason <REASON>' } };
  const [held] = approvalsModel.buildApprovals(snapshot([source_changed])).pending;
  assert.deepEqual(held.approvalHolds.map((hold) => [hold.code, hold.who]), [['STORY_REVIEW_SOURCE_CHANGED', 'The author revises it']]);
  const html = exports.inboxHtml(inboxModel.buildInbox(snapshot([source_changed])));
  assert.match(html, /<h2>Approval would be refused<\/h2>/u);
  assert.match(html, /The author revises it:<\/strong> Phase &#39;planning&#39; application source/u);
  assert.doesNotMatch(html, /data-approve=/u);
  assert.match(html, /data-reject=/u, 'requesting changes stays offered');
  // The approver's own answers are the form's business: Approve stays.
  const own = { code: 'APPROVAL_CHECKLIST_INCOMPLETE', owner: 'you-decide', who: 'You decide', summary: 'Answer the checklist.' };
  assert.deepEqual(approvalsModel.buildApprovals(snapshot([own])).pending[0].approvalHolds, []);
  assert.match(exports.inboxHtml(inboxModel.buildInbox(snapshot([own]))), /data-approve=/u);
});
