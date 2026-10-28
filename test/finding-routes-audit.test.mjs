/**
 * No finding is a dead end. `[recoverable-findings M4]`
 *
 * Owner rule (2026-10-15): any issue in any phase is recoverable with correct documentation and
 * appeal. Every finding the recovery routes can name carries its documentation entry and at least
 * one route someone other than the step's own author can act on, so an author who cannot fix it
 * (an earlier step owns it, a person must decide, or the check misreads correct work) is never
 * routed only back to itself.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { completionRecoveryActions } from '../src/completion-verdict.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';
import { REMEDIATION_GUIDED_CODES, refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { storyTestRiskAuthorityContext } from '../src/story-test-risk.mjs';

const source = (relative) => readFile(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8');
const workflow = { workItem: { id: 'AUDIT-1' }, currentPhase: 'implementation', status: 'in_progress',
  phaseOrder: ['intake', 'implementation'],
  phases: { intake: { id: 'intake', status: 'approved' },
    implementation: { id: 'implementation', status: 'in_progress', writeScope: 'source-and-artifact', generationIntent: { status: 'open' } } } };
const phase = workflow.phases.implementation;

async function representativeFindings() {
  const resolution = await source('phase-resolution.mjs');
  const policy = await source('phase-finding-policy.mjs');
  const codes = new Set([
    ...[...resolution.matchAll(/code === '([^']+)'/gu)].map((match) => match[1]),
    ...[...resolution.matchAll(/code\.startsWith\('([^']+)'\)/gu)].map((match) => `${match[1]}_example`),
    ...[...`${resolution}\n${policy}`.matchAll(/new Set\(\[([^\]]+)\]\)/gu)]
      .flatMap((match) => [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1])).filter((value) => /[._]/u.test(value))
  ]);
  const categories = new Set([...`${policy}`.matchAll(/'([a-z][a-z-]*)'/gu)].map((match) => match[1])
    .filter((value) => !/^(?:owned-author|owner-review|quality|integrity-or-authority|upstream-defect|raise-upstream-issue|current-phase-preparation|prepare-current-generation|worktree-review|review-and-scoped-commit|scope-or-evidence-review|author-correction|human-input|record-real-answer|operational-prerequisite|configured-owner-action|lifecycle|resume-or-successor|owner-resolution|authenticated-restoration-or-amendment)$/u.test(value)));
  for (const extra of ['integrity', 'configuration', 'worktree', 'clarification', 'lifecycle', 'coverage', 'appeal', 'quality-coverage', 'inputs']) categories.add(extra);
  return [
    ...[...codes].flatMap((code) => [{ code }, { code: code.toUpperCase() }]),
    ...[...categories].map((category) => ({ code: 'A_FINDING', category })),
    { code: 'A_CODE_NOBODY_REGISTERED' }
  ];
}

test('every finding carries its documentation and a route for someone other than its author', async () => {
  const findings = await representativeFindings();
  assert.ok(findings.length >= 60, String(findings.length));
  const deadEnds = [];
  for (const finding of findings) {
    const choices = phaseResolutionChoices(workflow, phase, finding);
    assert.match(choices.documentation?.command ?? '', /^singularity-flow explain findings --section /u, JSON.stringify(finding));
    if (!choices.choices.some((choice) => choice.owner !== phase.id)) deadEnds.push(JSON.stringify(finding));
  }
  assert.deepEqual(deadEnds, []);
});

test('the dispute route names the canonical gate whatever case the finding used, and the maintainer route only fills a gap', () => {
  for (const code of ['CODE_DELIVERY_EVIDENCE_REQUIRED', 'code_delivery_evidence_required']) {
    const dispute = phaseResolutionChoices(workflow, phase, { code }).choices.find((choice) => choice.kind === 'dispute');
    assert.equal(dispute.owner, 'phase-approval-authority');
    assert.equal(dispute.argv[dispute.argv.indexOf('--finding') + 1], 'CODE_DELIVERY_EVIDENCE_REQUIRED', code);
    assert.ok(!phaseResolutionChoices(workflow, phase, { code }).choices.some((choice) => choice.kind === 'maintainer-escalation'),
      'a disputable finding already has its approvers');
  }
  const brief = phaseResolutionChoices(workflow, phase, { code: 'AGENT_BRIEF_SUMMARY_REQUIRED' }).choices;
  assert.deepEqual(brief.map((choice) => choice.kind), ['author-correction', 'inspect', 'maintainer-escalation', 'preserve-checkpoint']);
  assert.match(brief[2].detail, /explain findings --section "Agent brief findings"/u);
  const unclaimed = phaseResolutionChoices(workflow, phase, { code: 'SPEC_COVERAGE_INCOMPLETE',
    details: { coverage: { unclaimedChangedPaths: ['src/extra.mjs'] } } }).choices;
  assert.ok(!unclaimed.some((choice) => choice.kind === 'maintainer-escalation'), 'the plan approvers are already named');
});

/**
 * What a route's own command checks before it does anything. A route the command would refuse for
 * this Story is no way out, whoever owns it. Keyed by the command, not by the route that names it,
 * so every route offering it is held to the command's real gate.
 */
const ROUTE_GATES = [{
  // Observed-risk review needs the Story's pinned test-recovery delegation (story-test-risk.mjs).
  matches: (argv) => argv[0] === 'story' && argv[1] === 'test-policy'
    && ['risks', 'accept-risk', 'revoke-risk', 'attest-risk'].includes(argv[2]),
  admits: (story) => { try { storyTestRiskAuthorityContext(story, {}); return true; } catch { return false; } }
}];
const refusedFor = (story, choice) => ROUTE_GATES.some((gate) => gate.matches(choice.argv ?? []) && !gate.admits(story));
const authorities = { 'validation-approvers': { label: 'Validation', members: [{ email: 'validation@example.test' }] } };
const undelegated = { ...workflow, resolution: { approvalAuthorities: authorities } };
const delegated = { ...workflow, resolution: { approvalAuthorities: authorities,
  testRecovery: { enabled: true, riskAuthorities: ['validation-approvers'], enabledRiskCategories: ['validation-unavailable'] } } };

test('no finding is routed to a command that refuses its Story, and none relies on one as its only way out', async () => {
  const findings = await representativeFindings();
  for (const [label, story] of [['without test-recovery delegation', undelegated], ['with test-recovery delegation', delegated]]) {
    const refused = [];
    const deadEnds = [];
    for (const finding of findings) {
      const { choices } = phaseResolutionChoices(story, story.phases.implementation, finding);
      refused.push(...choices.filter((choice) => refusedFor(story, choice)).map((choice) => `${JSON.stringify(finding)} -> ${choice.command}`));
      if (!choices.some((choice) => choice.owner !== 'implementation' && !refusedFor(story, choice))) deadEnds.push(JSON.stringify(finding));
    }
    assert.deepEqual(refused, [], label);
    assert.deepEqual(deadEnds, [], label);
  }
  // The gate is real: with the delegation pinned, observed-risk review is still offered.
  assert.ok(findings.some((finding) => phaseResolutionChoices(delegated, delegated.phases.implementation, finding).choices
    .some((choice) => ROUTE_GATES[0].matches(choice.argv))), 'a delegated Story keeps its risk-review route');
});

/** A step that only points at help, doctor, the planner, recovery inspection or the phase view. */
const GENERIC_COMMAND = /^singularity-flow (?:(?:[a-z-]+ )?--help|doctor(?: --[a-z-]+)* --json|(?:recommend|nextsteps) --json|recover(?: [A-Za-z0-9._-]+)?(?: --phase [a-z0-9-]+)? --json|phase show [a-z0-9-]+ --json)$/u;
const finalVerdict = { verified: false, errors: ['an acceptance criterion has no passing test'], findings: [{ code: 'gate.acceptance.untested',
  recovery: { command: 'singularity-flow evidence matrix AUDIT-1 --json', detail: 'See which criterion lacks a passing test.' } }] };
const testRunRisk = { eligible: true, phase: 'implementation', commandId: 'module-tests',
  command: 'singularity-flow decision test-risk AUDIT-1 --phase implementation --command module-tests --cause <cause> --reason <reason> --expires <YYYY-MM-DD>' };
const identity = { phase: 'implementation', workId: 'AUDIT-1', identity: 'developer@example.test',
  authorities: ['validation-approvers'], eligibleApprovers: ['validation@example.test'] };
const approve = ['approve', 'implementation', '--work-id', 'AUDIT-1'];

/**
 * Refusals on a Story's path whose way forward is known, as their producers raise them. Each plan
 * must carry its route; one made only of generic steps buries it. `decidesWho` refusals are about
 * the person deciding, so their plans never offer to reject the work.
 */
const STORY_PATH_REFUSALS = [
  { code: 'ACTIVE_SUBJECT_MISMATCH', argv: ['session', 'status', '--json'], routes: ['singularity-flow session attach AUDIT-1 --json'],
    details: { expectedWorkId: 'AUDIT-1', actualWorkId: null, nextCommand: 'singularity-flow session attach AUDIT-1 --json' } },
  { code: 'ACTIVE_SUBJECT_UNAVAILABLE', argv: ['status'], routes: ['singularity-flow session attach AUDIT-1 --json'],
    details: { expectedWorkId: 'AUDIT-1', nextCommand: 'singularity-flow session attach AUDIT-1 --json' } },
  { code: 'STORY_CAPABILITY_PUBLICATION_PENDING', argv: ['start', 'AUDIT-1', '--from-branch', 'main', '--title', 'Audit'], routes: ['singularity-flow sync'],
    details: { workId: 'AUDIT-1', recoveryCommand: { command: 'singularity-flow sync', label: 'Publish the retained capability branches.' } } },
  { code: 'STORY_FINAL_CHECK_FAILED', argv: ['finalize'], routes: ['singularity-flow evidence matrix AUDIT-1 --json', 'singularity-flow gate --terminal'],
    details: { findings: finalVerdict.findings, recoveryCommands: completionRecoveryActions(finalVerdict) } },
  { code: 'GOVERNANCE_GATE_FAILED', argv: ['gate'], routes: ['singularity-flow evidence matrix AUDIT-1 --json'], details: { findings: finalVerdict.findings } },
  { code: 'CODE_TEST_ZERO_DISCOVERED', argv: ['submit', 'implementation', '--work-id', 'AUDIT-1'], routes: ['accept-test-run-risk'],
    details: { workId: 'AUDIT-1', phase: 'implementation', testRunRisk } },
  { code: 'CODE_TEST_ZERO_DISCOVERED', argv: approve, routes: ['accept-test-run-risk'], details: { workId: 'AUDIT-1', phase: 'implementation', testRunRisk } },
  { code: 'PHASE_INPUTS_NOT_READY', argv: ['inputs', 'implementation'], routes: ['singularity-flow inputs restore implementation', 'raise-upstream-issue'],
    details: { workId: 'AUDIT-1', currentPhase: 'implementation', upstreamPhases: ['intake'], restorable: true, routes: [
      { kind: 'return', label: 'An approver returns implementation to intake.', command: 'singularity-flow reject implementation --work-id AUDIT-1 --to intake --reason <reason>' },
      { kind: 'upstream-issue', label: 'Record the defect for intake\'s approvers.', command: 'singularity-flow upstream-issue raise --work-id AUDIT-1 --phase intake --about <clause-or-section> --problem <what-is-wrong>' }
    ] } },
  { code: 'APPROVAL_IDENTITY_NOT_AUTHORIZED', argv: approve, routes: ['check-approval-identity', 'ask-eligible-member'], details: identity, decidesWho: true },
  { code: 'APPROVAL_IDENTITY_MISSING', argv: approve, routes: ['set-approval-identity', 'ask-eligible-member'], details: { ...identity, identity: null }, decidesWho: true },
  { code: 'APPROVAL_SELF_APPROVAL_PROHIBITED', argv: approve, routes: ['ask-other-approver'], details: identity, decidesWho: true },
  { code: 'APPROVAL_IDENTITY_ALREADY_RECORDED', argv: approve, routes: ['ask-next-approver'], details: identity, decidesWho: true },
  { code: 'APPROVAL_IDENTITY_NOT_AUTHORIZED', argv: ['decision', 'plan', 'AUDIT-1', '--reason', 'r'], routes: ['check-approval-identity'], details: identity, decidesWho: true },
  { code: 'CLARIFICATION_AUTHORITY_REQUIRED', argv: ['clarification', 'record', 'implementation', '--response-file', 'answers.json'],
    routes: ['answer-in-own-clone', 'import-answers', 'singularity-flow clarification status implementation --json'], details: identity, decidesWho: true },
  { code: 'CLARIFICATION_MODE_OFF', argv: ['clarification', 'record', 'implementation'], routes: ['singularity-flow prepare implementation'],
    details: { phase: 'implementation' } },
  { code: 'SCHEMA_VERSION_FUTURE', argv: ['resume', 'AUDIT-1'], routes: ['singularity-flow product status'],
    details: { workIds: ['AUDIT-1'], unavailable: [{ code: 'SESSION_STORY_INVALID', claimedId: 'AUDIT-1', sourceCode: 'SCHEMA_VERSION_FUTURE' }] } }
];

test('a Story-path refusal with a known route shows that route, never only help, doctor or recover', () => {
  const buried = [];
  for (const entry of STORY_PATH_REFUSALS) {
    if (!(REMEDIATION_GUIDED_CODES.includes(entry.code) || entry.details.nextCommand || entry.details.recoveryCommand
      || entry.details.recoveryCommands || entry.details.findings)) buried.push(`${entry.code}: no registered or producer route`);
    const plan = refusalRemediationPlan(Object.assign(new Error(entry.code), { code: entry.code, details: entry.details }), entry.argv);
    const shown = plan.steps.map((step) => step.command ?? step.id);
    const missing = entry.routes.filter((route) => !plan.steps.some((step) => step.command === route || step.id === route));
    if (missing.length || plan.steps.every((step) => step.command && GENERIC_COMMAND.test(step.command))) {
      buried.push(`${entry.code} (${entry.argv[0]}): missing ${missing.join(', ') || 'a specific step'} in ${shown.join(' | ')}`);
    }
    if (entry.decidesWho) {
      assert.doesNotMatch(JSON.stringify(plan.steps), /\/sf-reject|singularity-flow reject|leave-approval-turn/u, entry.code);
      assert.equal(plan.retry.command ?? null, null, entry.code);
    }
  }
  assert.deepEqual(buried, []);
});

/** Throw sites whose message tells the reader to run a command that no structured field carries. */
async function proseOnlyRefusals() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = (await readdir(path.join(root, 'src'), { recursive: true })).filter((name) => name.endsWith('.mjs'));
  const guided = new Set(REMEDIATION_GUIDED_CODES);
  const counts = {};
  for (const name of files) {
    const text = await readFile(path.join(root, 'src', name), 'utf8');
    for (let at = text.indexOf('new SingularityFlowError('); at >= 0; at = text.indexOf('new SingularityFlowError(', at + 1)) {
      let depth = 0; let quote = null; let end = at + 'new SingularityFlowError'.length;
      for (; end < text.length; end += 1) {
        const char = text[end];
        if (quote) { if (char === '\\') end += 1; else if (char === quote) quote = null; continue; }
        if (char === '"' || char === "'" || char === '`') quote = char;
        else if (char === '(') depth += 1;
        else if (char === ')' && --depth === 0) break;
      }
      const call = text.slice(at, end + 1);
      const code = call.match(/code:\s*'([A-Z0-9_]+)'/u)?.[1] ?? null;
      if (!/\b[Rr]un `?singularity-flow [a-z]/u.test(call) || guided.has(code)) continue;
      if (/\b(?:nextAction|nextCommand|recoveryCommand|recoveryCommands|repairCommand|diagnosticAction|retry|actions)\b\s*[:,}]|\bcommand\s*:/u.test(call)) continue;
      const relative = `src/${name.split(path.sep).join('/')}`;
      counts[relative] = (counts[relative] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * The prose-only refusals that predate this audit. A refusal names its next command in
 * details (nextAction, recoveryCommand, recoveryCommands) or through a registered route, so this
 * list may only shrink: lower a count when you give one of them a structured route.
 */
const PROSE_ONLY_REFUSALS = Object.freeze({
  'src/action-plans.mjs': 1, 'src/agents.mjs': 4, 'src/cli.mjs': 4,
  'src/commands/phase-lifecycle.mjs': 3, 'src/commands/start.mjs': 1, 'src/commands/story.mjs': 1, 'src/commands/submit.mjs': 2,
  'src/config.mjs': 2, 'src/configuration-proposal.mjs': 1, 'src/convergence-context.mjs': 1, 'src/design-sources.mjs': 1,
  'src/direct-skills.mjs': 1, 'src/epic-review.mjs': 1, 'src/generation-boundary.mjs': 1, 'src/initialization/recovery.mjs': 1,
  'src/initiative-config.mjs': 1, 'src/initiative-state.mjs': 8, 'src/ledger.mjs': 1, 'src/mcp-readiness.mjs': 3,
  'src/plugin.mjs': 3, 'src/prompt-audit.mjs': 3, 'src/session-remote-url-discovery.mjs': 1, 'src/session.mjs': 2,
  'src/state.mjs': 14, 'src/story-state-normalization.mjs': 1, 'src/story-workflow-read.mjs': 1, 'src/story-worktree.mjs': 2,
  'src/workflow-authoring.mjs': 1, 'src/workspace.mjs': 1
});

test('no new refusal names its next command only in prose', async () => {
  const counts = await proseOnlyRefusals();
  const grown = Object.entries(counts).filter(([file, count]) => count > (PROSE_ONLY_REFUSALS[file] ?? 0))
    .map(([file, count]) => `${file}: ${count} (allowed ${PROSE_ONLY_REFUSALS[file] ?? 0})`);
  assert.deepEqual(grown, [], 'Put the command in details.nextAction, recoveryCommand or recoveryCommands; the refusal plan reads only those.');
});
