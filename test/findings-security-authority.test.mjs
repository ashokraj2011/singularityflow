/**
 * Decision 10 for every security finding [CQF:REQ-053]: a vulnerability, a security hotspot, a
 * dependency advisory, anything on the security feed, and a finding whose kind the command did not
 * say, are accepted by the workflow's security reviewers when it names them, otherwise by the step's
 * approvers; the model never accepts one. A code smell stays the step approvers'.
 * test/findings-dependency-hold.test.mjs walks the same rule through the real CLI.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createFinding, FINDING_KINDS } from '../src/findings/model.mjs';
import { findingRiskAuthorities, findingRiskDecisionCommand, recordFindingRisk } from '../src/finding-risk.mjs';
import { findingRiskDecisionPart } from '../src/commands/decision-finding-risk.mjs';
import { argvAllowed } from '../src/copilot-mutation-guard.mjs';
import { OWN_TERMINAL_STEPS } from '../src/person-step-catalog.mjs';
import { parseArgs } from '../src/util.mjs';

const stepApprovers = { 'code-approvers': { label: 'Code approvers', members: [{ email: 'approver@example.test' }] } };
const securityReviewers = { 'security-reviewers': { label: 'Security reviewers', members: [{ email: 'security@example.test' }] } };
const story = (authorities) => ({ workItem: { id: 'SEC-1' }, status: 'in_progress', phaseOrder: ['implementation'],
  phases: { implementation: { id: 'implementation', approvalPolicy: { mode: 'required', authorities: ['code-approvers'], minimum: 1 } } },
  resolution: { approvalAuthorities: authorities }, findingRisks: [], history: [] });
const finding = (kind, extra = {}) => createFinding({ tool: 'scanner', rule: `${kind}-rule`, kind, severity: 'high', file: 'src/a.js', line: 1, ...extra });

test('every security finding goes to the security reviewers when the workflow names them, else the step approvers [CQF:REQ-053]', () => {
  const named = story({ ...stepApprovers, ...securityReviewers });
  const unnamed = story(stepApprovers);
  for (const kind of FINDING_KINDS) {
    const security = ['vulnerability', 'hotspot', 'dependency'].includes(kind);
    assert.deepEqual(findingRiskAuthorities(named, 'implementation', finding(kind)), security ? ['security-reviewers'] : ['code-approvers'], kind);
    assert.deepEqual(findingRiskAuthorities(unnamed, 'implementation', finding(kind)), ['code-approvers'], `${kind} with no security reviewers`);
  }
  // Anything on the security feed (M6's sources), and a dependency advisory from any audit.
  assert.deepEqual(findingRiskAuthorities(named, 'implementation', finding('code-smell', { feed: 'security' })), ['security-reviewers']);
  for (const tool of ['npm-audit', 'pnpm-audit', 'pip-audit', 'osv-scanner', 'dependency-check']) {
    const advisory = createFinding({ feed: 'security', tool, kind: 'dependency', package: 'minimist', installedVersion: '1.2.5', advisory: 'GHSA-xvch-5gv4-984h', severity: 'critical' });
    assert.deepEqual(findingRiskAuthorities(named, 'implementation', advisory), ['security-reviewers'], tool);
  }
  // A finding named without its kind could be any: it is the security reviewers', never the other way round.
  assert.deepEqual(findingRiskAuthorities(named, 'implementation', { id: 'F-0', fingerprint: 'x', tool: 'scanner', kind: null }), ['security-reviewers']);
  assert.deepEqual(findingRiskAuthorities(unnamed, 'implementation', { id: 'F-0', fingerprint: 'x', tool: 'scanner', kind: null }), ['code-approvers']);
  const recorded = recordFindingRisk(structuredClone(named), { phaseId: 'implementation', finding: { ...finding('code-smell'), kind: undefined },
    reason: 'Named on another checkout without its kind.', expires: '2026-12-01', actor: 'security', authorityGroup: 'security-reviewers', at: '2026-11-08T10:00:00.000Z' });
  assert.equal(recorded.security, true, 'and its record says so, so its revocation is theirs too');
});

test('a step approver who is no security reviewer cannot accept a security finding; a security reviewer can', async () => {
  const workflow = story({ ...stepApprovers, ...securityReviewers });
  const advisory = createFinding({ feed: 'security', tool: 'npm-audit', kind: 'dependency', package: 'minimist', installedVersion: '1.2.5', advisory: 'GHSA-xvch-5gv4-984h', severity: 'critical' });
  const decide = (email, entry) => findingRiskDecisionPart('/nonexistent', {}, workflow, { phaseId: 'implementation', finding: entry,
    reason: 'Only the CLI parser uses it, behind a fixed argument list.', expires: '2026-12-01' }, { actor: { name: 'A person', email } });
  await assert.rejects(decide('approver@example.test', advisory), { code: 'APPROVAL_IDENTITY_NOT_AUTHORIZED' });
  const part = await decide('security@example.test', advisory);
  assert.equal(part.authority.authorityGroup, 'security-reviewers');
  // The step approver still accepts a code smell.
  assert.equal((await decide('approver@example.test', finding('code-smell'))).authority.authorityGroup, 'code-approvers');
});

test('the model can never accept one: the guard refuses decision finding-risk in every turn, and it is a person\'s own terminal step', () => {
  const workflow = story({ ...stepApprovers, ...securityReviewers });
  for (const entry of [finding('vulnerability'), finding('hotspot'),
    createFinding({ feed: 'security', tool: 'npm-audit', kind: 'dependency', package: 'minimist', installedVersion: '1.2.5', advisory: 'GHSA-xvch-5gv4-984h', severity: 'critical' })]) {
    const command = findingRiskDecisionCommand(workflow, { phaseId: 'implementation', finding: entry })
      .replace('"<why the step may keep it>"', 'because').replace('<YYYY-MM-DD>', '2026-12-01');
    const argv = command.split(/\s+/u).slice(1);
    for (const mode of ['read', 'write', 'approval', 'decide']) assert.equal(argvAllowed(argv, mode, {}), false, `${mode}: ${command}`);
    const { positionals, options } = parseArgs(argv);
    assert.equal(OWN_TERMINAL_STEPS.find((step) => step.matches(positionals, options))?.id, 'test-run-risk', 'a person takes it in their own terminal');
  }
});
