/**
 * A critical vulnerability in a package the Story added holds the code step for a person [CQF M5
 * acceptance, CQF:REQ-052, decision 9], through the real CLI: publication and submission go ahead with
 * it recorded, the approval waits and says who may accept it, and once a person accepts it with
 * `decision finding-risk` the step is approved. The hold's own rules (fixed, accepted, expired) are
 * read without a Story first.
 *
 * The audit is npm audit's report as test/fixtures/findings/npm-audit.json recorded it, printed by a
 * stand-in program so that nothing here reaches the registry.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { completeAgentResult } from '../src/agent-output.mjs';
import { createFinding } from '../src/findings/model.mjs';
import { assertDependencyVulnerabilitiesDecided, heldDependencyVulnerabilities } from '../src/findings/dependency-hold.mjs';
import { approvalHold, approvalHoldOwner } from '../src/approval-check.mjs';
import { recordFindingRisk } from '../src/finding-risk.mjs';
import { approvedSpecificationStory, CLI } from './helpers/submitted-planning-story.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const fixture = (name) => readFile(new URL(`./fixtures/findings/${name}`, import.meta.url), 'utf8');

const minimist = createFinding({ feed: 'security', tool: 'npm-audit', toolVersion: '11.20.0', kind: 'dependency', package: 'minimist', installedVersion: '1.2.5',
  fixedVersion: '1.2.8', advisory: 'GHSA-xvch-5gv4-984h', rule: 'GHSA-xvch-5gv4-984h', severity: 'critical', message: 'Prototype Pollution in minimist', newCode: true });

function heldStory({ authorities = {} } = {}) {
  const phase = { id: 'implementation', label: 'Implementation', approvalPolicy: { authorities: ['code-approvers'] },
    deliveryEvidence: { submittedFindings: { dependencies: { held: [minimist.fingerprint], warned: [] }, findings: [minimist] } } };
  return { workflow: { workItem: { id: 'HOLD-1' }, phaseOrder: ['implementation'], phases: { implementation: phase }, resolution: { approvalAuthorities: authorities } }, phase };
}

test('the hold reads the latest gate, again at approval: a fixed package or a person\'s acceptance clears it [CQF:REQ-052]', () => {
  const { workflow, phase } = heldStory();
  assert.throws(() => assertDependencyVulnerabilitiesDecided(workflow, phase), (error) => {
    assert.equal(error.code, 'DEPENDENCY_VULNERABILITY_HELD');
    assert.match(error.message, /^Implementation waits for a person: a known vulnerability in packages this Story added or upgraded: minimist@1\.2\.5 GHSA-xvch-5gv4-984h \(critical, fixed in 1\.2\.8\)\. Upgrade it to a fixed version and submit again, or a person who may decide \(code-approvers\) accepts it with decision finding-risk/u);
    const [entry] = error.details.vulnerabilities;
    assert.deepEqual([entry.package, entry.installedVersion, entry.fixedVersion, entry.rule, entry.authorities], ['minimist', '1.2.5', '1.2.8', 'GHSA-xvch-5gv4-984h', ['code-approvers']]);
    assert.match(entry.command, new RegExp(`^singularity-flow decision finding-risk HOLD-1 --phase implementation --finding ${minimist.id} --fingerprint ${minimist.fingerprint} --rule GHSA-xvch-5gv4-984h --tool npm-audit --tool-version 11\\.20\\.0 --kind dependency`, 'u'));
    // Every approval surface reads it the same way: someone decides, the step's approvers, and their command.
    assert.equal(approvalHoldOwner(error), 'someone-decides');
    const hold = approvalHold(error, workflow, phase);
    assert.deepEqual([hold.clearedBy.kind, hold.who, hold.action.command], ['approvers', 'An approver of Implementation decides', entry.command]);
    assert.equal(hold.vulnerabilities[0].package, 'minimist', 'the card reads each package from the hold');
    return true;
  });
  // A person's acceptance clears it, until it expires.
  const at = '2026-11-08T10:00:00.000Z';
  recordFindingRisk(workflow, { phaseId: 'implementation', finding: minimist, reason: 'Only the CLI parser uses it, behind a fixed argument list.', expires: '2026-12-01',
    actor: 'person', authorityGroup: 'code-approvers', at });
  assert.doesNotThrow(() => assertDependencyVulnerabilitiesDecided(workflow, phase, { at }));
  assert.equal(heldDependencyVulnerabilities(workflow, phase, { at: '2026-12-02T00:00:00.000Z' }).length, 1, 'an expired acceptance holds it again');
  // A later submission whose audit no longer reports it is the fix: the latest gate speaks.
  phase.deliveryEvidence.submittedFindings = { dependencies: { held: [], warned: [] }, findings: [] };
  assert.deepEqual(heldDependencyVulnerabilities(workflow, phase, { at: '2026-12-02T00:00:00.000Z' }), []);
  // Decision 10: with security reviewers named, they decide it.
  const named = heldStory({ authorities: { 'security-reviewers': { members: [{ email: 'security@example.test' }] } } });
  assert.throws(() => assertDependencyVulnerabilitiesDecided(named.workflow, named.phase), (error) => {
    const hold = approvalHold(error, named.workflow, named.phase);
    assert.deepEqual([error.details.authorities, hold.who], [['security-reviewers'], 'A security reviewer of this Story decides']);
    return true;
  });
});

/** The recorded npm audit, cut to the one package this Story adds. */
async function minimistReport() {
  const report = JSON.parse(await fixture('npm-audit.json'));
  report.vulnerabilities = { minimist: report.vulnerabilities.minimist };
  report.metadata.vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 };
  return report;
}

const PLAN = (WORK) => [
  `# ${WORK} — Implementation plan`, '',
  '## Agent brief', '', 'Return the approved value, parsed with minimist, and prove both clauses with one focused test.', '',
  '## Approach', '', 'Export a constant from the value module and assert it in a unit test.', '',
  '## Affected surfaces', '', '| Surface | Change | Serves |', '|---|---|---|', `| \`src/value.mjs\` | exported value | ${WORK}:REQ-002 |`, '',
  '## Test strategy', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
  `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, `| \`${WORK}:REQ-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
  '## Supporting files', '', '- `package.json` — adds the minimist dependency the value module parses with.', '- `package-lock.json` — locks minimist.', '',
  '## Risks and rollback', '', 'Risk is a wrong constant; rollback restores the previous module.', ''
].join('\n');

/**
 * A Story at its implementation step that adds minimist 1.2.5, which has a known critical advisory,
 * with npm audit as its security command. `securityReviewers` names that group's one member.
 */
async function storyAddingMinimist(t, WORK, { securityReviewers = null } = {}) {
  const audit = { id: 'npm-audit', kind: 'security', modelPolicy: 'never', argv: [process.execPath, 'tools/print-audit.mjs'],
    result: { adapter: 'npm-audit', path: '.sflow/results/npm-audit.json' } };
  const lock = (packages) => `${JSON.stringify({ name: 'value-app', lockfileVersion: 3, requires: true, packages: { '': { name: 'value-app' }, ...packages } }, null, 2)}\n`;
  const story = await approvedSpecificationStory(t, WORK, { configure: (configuration) => {
    configuration.phases.implementation.qualityCommands = [audit];
    if (securityReviewers) {
      configuration.approvalAuthorities['security-reviewers'] = { label: 'Security reviewers', members: [{ email: securityReviewers }] };
      // Not enrolled into every group, as the proof-of-concept profile would enrol the Story's creator.
      configuration.approvalSecurity = { profile: 'team', autoEnrollNewIdentities: false };
    }
  }, beforeStart: async ({ root, git }) => {
    // The stand-in prints what npm audit printed for this lockfile; nothing here reaches the registry.
    await mkdir(path.join(root, 'tools'), { recursive: true });
    await writeFile(path.join(root, 'tools/audit.json'), JSON.stringify(await minimistReport()));
    await writeFile(path.join(root, 'tools/print-audit.mjs'), "import { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(new URL('./audit.json', import.meta.url)));\nprocess.exitCode = 1;\n");
    await writeFile(path.join(root, 'package-lock.json'), lock({}));
    await writeFile(path.join(root, '.gitignore'), '.sflow/\n');
    git('add', '.');
    git('commit', '-qm', 'Audit dependencies');
    git('push', '-q', 'origin', 'main');
  } });
  const { root, cli, item } = story;
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), PLAN(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks'); cli('approve', 'planning', '--yes');
  cli('prepare', 'implementation');
  const clauses = [`${WORK}:AC-001`, `${WORK}:REQ-002`];
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'src/value.mjs'), `${clauses.map((clause) => `// @clause:${clause} returns the approved value to its callers\n`).join('')}export const value = 1;\n`);
  await writeFile(path.join(root, 'test/value.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n${clauses.map((clause) => `// @ac:${clause}\n`).join('')}test('value', () => { assert.equal(value, 1); });\n`);
  // The Story adds minimist 1.2.5, which has a known critical advisory.
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ ...manifest, name: 'value-app', dependencies: { minimist: '1.2.5' } }));
  await writeFile(path.join(root, 'package-lock.json'), lock({ 'node_modules/minimist': { version: '1.2.5', license: 'MIT' } }));
  await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), ['# Implementation summary', '', '## Agent brief', '',
    'Added the value module and the minimist dependency; both clauses have one focused test that reads the approved value.', '',
    '## Changed components and decisions', '', '- `src/value.mjs` exports the approved value.', '',
    '## Tests and operational notes', '', '`test/value.test.mjs` verifies the value, and nothing else changes for anyone who reads it.', ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/implementation/operator-notes.md'), ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  const workflow = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  return { ...story, workflow };
}


test('adding a package with a known critical advisory holds the step until a person accepts it [CQF M5 acceptance]', slowLane({ timeout: 900_000 }), async (t) => {
  const WORK = 'CQF-501';
  const story = await storyAddingMinimist(t, WORK);
  const { cli, workflow } = story;

  // Publication goes ahead: a vulnerable package is no finding to repair in the turn.
  const result = story.run(process.execPath, [CLI, '--no-model', 'phase', 'prepublish', 'implementation', '--for-agent', '--json', '--publish-if-ready'], { allowFailure: true });
  const text = result.stdout.trim() || result.stderr.trim();
  const published = completeAgentResult(text.slice(text.indexOf('{')));
  assert.equal(result.status, 0, JSON.stringify(published).slice(0, 3000));
  assert.equal(published.publishIfReady.published, true);
  const told = published.publishIfReady.qualityFindings;
  assert.deepEqual(told.held.map((finding) => [finding.package, finding.installedVersion, finding.fixedVersion, finding.rule]), [['minimist', '1.2.5', '1.2.8', 'GHSA-xvch-5gv4-984h']]);
  assert.match(told.words, /^1 known vulnerability in packages this Story added or upgraded holds the step's approval until upgraded or accepted by a person \(minimist@1\.2\.5 GHSA-xvch-5gv4-984h\)/u);

  // Submission goes ahead too, and reads the same run on the same code.
  const submitted = story.run(process.execPath, [CLI, '--no-model', 'submit', 'implementation'], { allowFailure: true });
  assert.equal(submitted.status, 0, `${submitted.stdout}\n${submitted.stderr}`);
  assert.match(submitted.stderr, /Not run again: npm-audit read this exact code with the same tool and rules/u);
  const after = (await workflow()).phases.implementation;
  assert.equal(after.status, 'awaiting_approval');
  const [held] = after.deliveryEvidence.submittedFindings.dependencies.held;
  const finding = after.deliveryEvidence.submittedFindings.findings.find((entry) => entry.fingerprint === held);
  assert.deepEqual([finding.package, finding.severity, finding.newCode], ['minimist', 'critical', true]);

  // The approval waits, and every approval surface says who may accept it and how.
  const shown = JSON.parse(cli('phase', 'show', 'implementation', '--json').stdout);
  const hold = shown.approvalCheck.holds.find((entry) => entry.code === 'DEPENDENCY_VULNERABILITY_HELD');
  assert.ok(hold, JSON.stringify(shown.approvalCheck.holds.map((entry) => entry.code)));
  assert.deepEqual([hold.owner, hold.who, hold.vulnerabilities[0].package], ['someone-decides', 'An approver of Implementation decides', 'minimist']);
  assert.match(hold.action.command, new RegExp(`^singularity-flow decision finding-risk ${WORK} --phase implementation --finding ${finding.id} `, 'u'));
  const refused = story.run(process.execPath, [CLI, '--no-model', 'approve', 'implementation', '--yes'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Implementation waits for a person: a known vulnerability in packages this Story added or upgraded: minimist@1\.2\.5/u);

  // A person accepts it, with a reason and an expiry of at most 90 days, after the submission: the step is approved.
  const expires = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const accepted = story.run(process.execPath, [CLI, '--no-model', 'decision', 'finding-risk', WORK, '--phase', 'implementation', '--finding', finding.id,
    '--reason', 'Only the CLI parser uses it, behind a fixed argument list.', '--expires', expires], { allowFailure: true });
  assert.equal(accepted.status, 0, accepted.stderr);
  const [decision] = (await workflow()).findingRisks;
  assert.deepEqual([decision.id, decision.kind, decision.security, decision.tool, decision.rule], ['FRK-001', 'dependency', true, 'npm-audit', 'GHSA-xvch-5gv4-984h']);
  const approved = story.run(process.execPath, [CLI, '--no-model', 'approve', 'implementation', '--yes'], { allowFailure: true });
  assert.equal(approved.status, 0, `${approved.stdout}\n${approved.stderr}`);
  assert.equal((await workflow()).phases.implementation.status, 'approved');
});

test('with security reviewers named, only they accept a vulnerable package, however the command names its kind [CQF:REQ-053, decision 10]', slowLane({ timeout: 900_000 }), async (t) => {
  const WORK = 'CQF-502';
  const story = await storyAddingMinimist(t, WORK, { securityReviewers: 'security.reviewer@example.com' });
  const { root, workflow } = story;
  const published = story.run(process.execPath, [CLI, '--no-model', 'phase', 'prepublish', 'implementation', '--for-agent', '--json', '--publish-if-ready'], { allowFailure: true });
  assert.equal(published.status, 0, published.stdout.slice(0, 3000));
  const submitted = story.run(process.execPath, [CLI, '--no-model', 'submit', 'implementation'], { allowFailure: true });
  assert.equal(submitted.status, 0, `${submitted.stdout}\n${submitted.stderr}`);
  const evidence = (await workflow()).phases.implementation.deliveryEvidence.submittedFindings;
  const finding = evidence.findings.find((entry) => entry.fingerprint === evidence.dependencies.held[0]);
  const shown = JSON.parse(story.cli('phase', 'show', 'implementation', '--json').stdout);
  const hold = shown.approvalCheck.holds.find((entry) => entry.code === 'DEPENDENCY_VULNERABILITY_HELD');
  assert.deepEqual([hold.who, hold.vulnerabilities[0].authorities], ['A security reviewer of this Story decides', ['security-reviewers']]);

  const expires = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const decide = (identity, ...extra) => spawnSync(process.execPath, [CLI, '--no-model', 'decision', 'finding-risk', WORK, '--phase', 'implementation', '--finding', finding.id,
    ...extra, '--reason', 'Only the CLI parser uses it, behind a fixed argument list.', '--expires', expires],
  { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: identity } });
  // The step's approver is no security reviewer: refused, and naming the finding as another kind changes nothing.
  for (const extra of [[], ['--fingerprint', finding.fingerprint, '--rule', finding.rule, '--tool', finding.tool, '--kind', 'code-smell'],
    ['--fingerprint', finding.fingerprint, '--rule', finding.rule, '--tool', finding.tool]]) {
    const refused = decide('History Tester', ...extra);
    assert.notEqual(refused.status, 0, JSON.stringify(extra));
    assert.match(refused.stderr, /security-reviewers/u, refused.stderr);
  }
  assert.equal((await workflow()).findingRisks?.length ?? 0, 0, 'nothing was recorded');
  const accepted = decide('Security Reviewer');
  assert.equal(accepted.status, 0, accepted.stderr);
  const [decision] = (await workflow()).findingRisks;
  assert.deepEqual([decision.authorityGroup, decision.kind, decision.security], ['security-reviewers', 'dependency', true]);
  const approved = story.run(process.execPath, [CLI, '--no-model', 'approve', 'implementation', '--yes'], { allowFailure: true });
  assert.equal(approved.status, 0, `${approved.stdout}\n${approved.stderr}`);
});
