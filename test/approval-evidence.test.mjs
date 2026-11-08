/**
 * The evidence `decisions --json` carries beside a code step's decisions, for the VS Code card and the
 * Copilot CLI table [CQF:REQ-031, REQ-033, REQ-034, REQ-052, REQ-055]: the changed lines its tests ran,
 * each criterion's tests, what the findings loop let through, the vulnerable new package that holds the
 * approval with who may accept it and their command, and the required checks. It records and refuses
 * nothing, and the list's digest does not cover it.
 *
 * The CLI walk adds minimist 1.2.5 (a known critical advisory) under stand-ins that print what npm audit
 * and ESLint printed, and reads the required checks from gh answers recorded in the check-runs API's shape;
 * nothing here reaches a registry or a server.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { approvalEvidence } from '../src/approval-evidence.mjs';
import { recordFindingRisk } from '../src/finding-risk.mjs';
import { createFinding } from '../src/findings/model.mjs';
import { requiredCheckEvidence } from '../src/findings/required-checks.mjs';
import { approvedSpecificationStory, CLI } from './helpers/submitted-planning-story.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const COMMIT = '3f6c9a1e2b4d5c6e7f8091a2b3c4d5e6f7a8b9c0';
const lint = createFinding({ feed: 'quality', tool: 'eslint', toolVersion: '9.0.0', kind: 'complexity', rule: 'sonarjs/cognitive-complexity', severity: 'high',
  file: 'src/value.mjs', line: 4, snippet: 'export function parsed(list) {', message: 'Refactor this function to reduce its Cognitive Complexity from 18 to the 15 allowed.', newCode: true });
const advisory = createFinding({ feed: 'security', tool: 'npm-audit', toolVersion: '11.20.0', kind: 'dependency', package: 'lodash', installedVersion: '4.17.15',
  fixedVersion: '4.17.21', advisory: 'GHSA-29mw-wpgm-hmr9', rule: 'GHSA-29mw-wpgm-hmr9', severity: 'medium', message: 'Regular Expression Denial of Service (ReDoS) in lodash', newCode: true });
const minimist = createFinding({ feed: 'security', tool: 'npm-audit', toolVersion: '11.20.0', kind: 'dependency', package: 'minimist', installedVersion: '1.2.5',
  fixedVersion: '1.2.8', advisory: 'GHSA-xvch-5gv4-984h', rule: 'GHSA-xvch-5gv4-984h', severity: 'critical', message: 'Prototype Pollution in minimist', newCode: true });

/** gh and git as the required-checks read asks them, answering from runs recorded in the check-runs API's shape. */
function recordedGh(commit) {
  const runs = JSON.stringify({ total_count: 2, check_runs: [
    { id: 21, name: 'CodeQL', status: 'completed', conclusion: 'success', html_url: 'https://github.example.test/example-org/value-app/runs/21', app: { name: 'GitHub Code Scanning' }, head_sha: commit },
    { id: 22, name: 'SonarCloud Code Analysis', status: 'completed', conclusion: 'failure', html_url: 'https://github.example.test/example-org/value-app/runs/22', app: { name: 'SonarCloud' }, head_sha: commit }] });
  return (command, args) => {
    if (command === 'git') return { status: 0, stdout: 'https://github.example.test/example-org/value-app.git\n' };
    if (args[0] === 'auth') return { status: 0, stdout: '' };
    if (args.at(-1).includes('/check-runs')) return { status: 0, stdout: runs };
    return { status: 1, stderr: 'HTTP 404: Not Found' };
  };
}

function codeStep({ authorities = { 'code-approvers': { label: 'Code approvers', members: [{ email: 'pat@example.test' }] } } } = {}) {
  const phase = { id: 'implementation', label: 'Code', status: 'awaiting_approval', generation: 1, generationCommit: COMMIT, approvalPolicy: { authorities: ['code-approvers'] },
    deliveryEvidence: {
      acceptanceCriteria: { required: ['PAY-1:AC-001', 'PAY-1:AC-002'], witnesses: [
        { clauseId: 'PAY-1:AC-001', testSource: 'test/value.test.mjs', line: 6, identity: { name: 'reads the value' }, assertions: { adequacy: 'adequate', count: 2 } },
        { clauseId: 'PAY-1:AC-001', testSource: 'test/value.test.mjs', line: 9, identity: { name: 'parses an empty list' }, assertions: { adequacy: 'missing', count: 0 } }] },
      assertionCheck: { mode: 'warn', status: 'incomplete', inadequate: [{ path: 'test/value.test.mjs', line: 9, name: 'parses an empty list', adequacy: 'missing' }],
        words: "Assertion check: 1 test asserts nothing it tests ('parses an empty list' at test/value.test.mjs:9). It warns and refuses nothing." },
      // Submission read publication's run, so its own record has no attempt.
      qualityFindings: { mode: 'warn', outcome: 'warned', attempt: 3 },
      submittedFindings: { mode: 'warn', outcome: 'warned', attempt: null, maximumAttempts: 3, counted: [lint.fingerprint], accepted: [],
        dependencies: { held: [minimist.fingerprint], warned: [advisory.fingerprint] }, counts: { existing: 2 }, unavailable: [{ commandId: 'semgrep', reason: 'semgrep is not installed' }],
        findings: [lint, minimist, advisory] } } };
  return { workItem: { id: 'PAY-1' }, currentPhase: 'implementation', phaseOrder: ['implementation'], phases: { implementation: phase },
    lineage: { requiredChecks: ['CodeQL', 'SonarCloud Code Analysis'] }, resolution: { approvalAuthorities: authorities } };
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-approval-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root }).status, 0);
  return root;
}

test('beside the decisions: each criterion\'s tests, the findings let through, the held package with who may accept it, and the required checks', async (t) => {
  const root = await repository(t);
  const workflow = codeStep();
  // The required checks were read once through gh; completed runs are kept, so this read asks nobody.
  await requiredCheckEvidence(root, {}, workflow, { commit: COMMIT, runCommand: recordedGh(COMMIT) });
  const pat = { email: 'pat@example.test' };
  const evidence = await approvalEvidence(root, {}, workflow, 'implementation', { actor: pat, at: '2026-11-08T10:00:00.000Z' });
  assert.equal(evidence.words, 'Evidence beside these decisions. It records nothing and refuses nothing.');
  assert.equal(evidence.coverage, undefined, 'no run is bound here, so there is no coverage to say');
  assert.deepEqual(evidence.proof.criteria.map((entry) => entry.words), ["PAY-1:AC-001: 2 tests prove it; 1 asserts; 'parses an empty list' asserts nothing", 'PAY-1:AC-002: no test proves it']);
  assert.deepEqual(evidence.proof.criteria[0].assertsNothing, [{ test: 'parses an empty list', testSource: 'test/value.test.mjs', line: 9, adequacy: 'missing' }]);
  assert.deepEqual(evidence.proof.assertionCheck.tests, [{ name: 'parses an empty list', path: 'test/value.test.mjs', line: 9, adequacy: 'missing' }]);
  // The loop's attempts are publication's; the vulnerable package is the hold's, not a finding let through.
  assert.equal(evidence.findings.words, "1 finding on lines this Story changed went through after 3 attempts, recorded for the step's approvers; 1 lower-severity advisory in packages this Story added or upgraded warns and holds nothing; semgrep could not run and blocked nothing; 2 existing findings on lines this Story did not change count for nothing.");
  assert.deepEqual(evidence.findings.letThrough.map((entry) => [entry.severity, entry.rule, entry.file, entry.line, entry.accepted]),
    [['high', 'sonarjs/cognitive-complexity', 'src/value.mjs', 4, null], ['medium', 'GHSA-29mw-wpgm-hmr9', null, null, null]]);
  assert.equal(evidence.findings.letThrough[1].words, 'medium lodash@4.17.15 GHSA-29mw-wpgm-hmr9 (npm-audit): Regular Expression Denial of Service (ReDoS) in lodash. No person has accepted it.');
  assert.equal(evidence.findings.letThrough[0].words, 'high sonarjs/cognitive-complexity at src/value.mjs:4 (eslint): Refactor this function to reduce its Cognitive Complexity from 18 to the 15 allowed. No person has accepted it.');
  // No security reviewers named: the step's approvers accept the package (decision 10), and Pat is one.
  const [held] = evidence.hold.entries;
  assert.deepEqual([held.words, held.who, held.allowed], ['minimist@1.2.5 GHSA-xvch-5gv4-984h (critical, fixed in 1.2.8)',
    'An approver of Code (Code approvers) accepts it, or it is upgraded to 1.2.8 and submitted again.', true]);
  assert.match(held.command, /^singularity-flow decision finding-risk PAY-1 --phase implementation --finding F-[0-9a-f]+ --fingerprint sha256:[0-9a-f]{64} --rule GHSA-xvch-5gv4-984h --tool npm-audit --tool-version 11\.20\.0 --kind dependency --reason "<why the step may keep it>" --expires <YYYY-MM-DD>$/u);
  assert.match(evidence.hold.words, /^A known vulnerability in packages this Story added or upgraded holds Code's approval until upgraded, or accepted by a person with decision finding-risk/u);
  assert.equal((await approvalEvidence(root, {}, workflow, 'implementation', { actor: { email: 'sam@example.test' } })).hold.entries[0].allowed, false, 'someone outside the group may not');
  assert.deepEqual(evidence.requiredChecks.checks.map((check) => [check.name, check.status]), [['CodeQL', 'passed'], ['SonarCloud Code Analysis', 'failed']]);
  assert.equal(evidence.requiredChecks.words, 'Required checks on 3f6c9a1e2b4d: CodeQL passed · SonarCloud Code Analysis failed. They are evidence for the reviewer; approval does not wait on them.');

  // A person accepts the finding and the package after submission: the evidence says so, and the hold is gone.
  const at = '2026-11-08T10:00:00.000Z';
  recordFindingRisk(workflow, { phaseId: 'implementation', finding: lint, reason: 'The parser stays this size until the next refactoring Story.', expires: '2026-12-01', actor: 'Pat Reviewer', authorityGroup: 'code-approvers', at });
  recordFindingRisk(workflow, { phaseId: 'implementation', finding: minimist, reason: 'Only the CLI parser uses it, behind a fixed argument list.', expires: '2026-12-01', actor: 'Pat Reviewer', authorityGroup: 'code-approvers', at });
  const after = await approvalEvidence(root, {}, workflow, 'implementation', { actor: pat, at });
  assert.deepEqual(after.findings.letThrough[0].accepted, { id: 'FRK-001', by: 'Pat Reviewer', until: '2026-12-01' });
  assert.match(after.findings.letThrough[0].words, /\. Accepted by Pat Reviewer until 2026-12-01 \(FRK-001\)\.$/u);
  assert.match(after.findings.words, /holds nothing; 1 accepted by a person; semgrep/u);
  assert.equal(after.hold, undefined);
});

test('with security reviewers named, they accept a held package; a step with none of the evidence carries none', async (t) => {
  const root = await repository(t);
  const workflow = codeStep({ authorities: { 'code-approvers': { label: 'Code approvers', allowAnyGitIdentity: true },
    'security-reviewers': { label: 'Security reviewers', members: [{ email: 'sec@example.test' }] } } });
  workflow.lineage = {};
  const evidence = await approvalEvidence(root, {}, workflow, 'implementation', { actor: { email: 'pat@example.test' } });
  assert.deepEqual([evidence.hold.entries[0].who, evidence.hold.entries[0].allowed], ['The security reviewers accept it, or it is upgraded to 1.2.8 and submitted again.', false]);
  assert.equal((await approvalEvidence(root, {}, workflow, 'implementation', { actor: { email: 'sec@example.test' } })).hold.entries[0].allowed, true);
  assert.equal(evidence.requiredChecks, undefined, 'no required checks named, none read');
  const plain = { workItem: { id: 'PAY-2' }, currentPhase: 'specification', phaseOrder: ['specification'], phases: { specification: { id: 'specification', status: 'in_progress' } } };
  assert.equal(await approvalEvidence(root, {}, plain, 'specification'), null);
  assert.equal(await approvalEvidence(root, {}, plain, 'missing'), null);
});

const PLAN = (WORK) => [
  `# ${WORK} — Implementation plan`, '',
  '## Agent brief', '', 'Return the approved value, parsed from a list, and prove both clauses with focused tests.', '',
  '## Approach', '', 'Export a constant and a parser from the value module and test both.', '',
  '## Affected surfaces', '', '| Surface | Change | Serves |', '|---|---|---|', `| \`src/value.mjs\` | exported value and parser | ${WORK}:REQ-002 |`, '',
  '## Test strategy', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
  `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, `| \`${WORK}:REQ-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
  '## Supporting files', '', '- `package.json` — adds the minimist dependency the parser reads with.', '- `package-lock.json` — locks minimist.', '',
  '## Risks and rollback', '', 'Risk is a wrong constant; rollback restores the previous module.', ''
].join('\n');

test('decisions --json carries the evidence the card and the table show, at a code step\'s approval, outside the list\'s digest [CQF M2, M3, M4, M5]', slowLane({ timeout: 900_000 }), async (t) => {
  const WORK = 'CQF-801';
  const lock = (packages) => `${JSON.stringify({ name: 'value-app', lockfileVersion: 3, requires: true, packages: { '': { name: 'value-app' }, ...packages } }, null, 2)}\n`;
  const story = await approvedSpecificationStory(t, WORK, { configure: (configuration) => {
    configuration.phases.implementation.qualityCommands = [
      { id: 'npm-audit', kind: 'security', modelPolicy: 'never', argv: [process.execPath, 'tools/print-audit.mjs'], result: { adapter: 'npm-audit', path: '.sflow/results/npm-audit.json' } },
      { id: 'eslint', kind: 'lint', modelPolicy: 'never', argv: [process.execPath, 'tools/print-lint.mjs'], result: { adapter: 'eslint-json', path: '.sflow/results/eslint.json' } }];
  }, beforeStart: async ({ root, git }) => {
    // The stand-ins print what npm audit and ESLint printed; Node's own runner writes the lcov.
    const audit = JSON.parse(await readFile(new URL('./fixtures/findings/npm-audit.json', import.meta.url), 'utf8'));
    audit.vulnerabilities = { minimist: audit.vulnerabilities.minimist };
    audit.metadata.vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 };
    await mkdir(path.join(root, 'tools'), { recursive: true });
    await writeFile(path.join(root, 'tools/audit.json'), JSON.stringify(audit));
    await writeFile(path.join(root, 'tools/print-audit.mjs'), "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';\nconst text = readFileSync(new URL('./audit.json', import.meta.url), 'utf8');\nmkdirSync('.sflow/results', { recursive: true });\nwriteFileSync('.sflow/results/npm-audit.json', text);\nprocess.stdout.write(text);\nprocess.exitCode = 1;\n");
    await writeFile(path.join(root, 'tools/print-lint.mjs'), ["import { mkdirSync, writeFileSync } from 'node:fs';", "import path from 'node:path';",
      "const report = [{ filePath: path.resolve('src/value.mjs'), messages: [{ ruleId: 'sonarjs/cognitive-complexity', severity: 2,",
      "  message: 'Refactor this function to reduce its Cognitive Complexity from 18 to the 15 allowed.', line: 4, column: 17, endLine: 4, endColumn: 23 }], errorCount: 1, warningCount: 0 }];",
      "mkdirSync('.sflow/results', { recursive: true });", "writeFileSync('.sflow/results/eslint.json', JSON.stringify(report));", 'process.stdout.write(JSON.stringify(report));', 'process.exitCode = 1;', ''].join('\n'));
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ ...manifest, name: 'value-app',
      scripts: { test: 'mkdir -p coverage && node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=coverage/lcov.info' } }));
    await writeFile(path.join(root, 'package-lock.json'), lock({}));
    await writeFile(path.join(root, '.gitignore'), '.sflow/\ncoverage/\n');
    git('add', '.');
    git('commit', '-qm', 'Audit and lint stand-ins');
    git('push', '-q', 'origin', 'main');
  } });
  const { root, cli, item } = story;
  const workflowFile = path.join(item, 'workflow.json');
  // The Story's GitHub required checks, as a capability pins them.
  const pinned = JSON.parse(await readFile(workflowFile, 'utf8'));
  await writeFile(workflowFile, `${JSON.stringify({ ...pinned, lineage: { ...pinned.lineage, requiredChecks: ['CodeQL', 'SonarCloud Code Analysis'] } }, null, 2)}\n`);
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), PLAN(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks'); cli('approve', 'planning', '--yes');
  cli('prepare', 'implementation');
  const clauses = [`${WORK}:AC-001`, `${WORK}:REQ-002`];
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  // The parser's guard and its non-empty branch never run; src/format.mjs has no plan row, so it is a departure.
  await writeFile(path.join(root, 'src/value.mjs'), [`// @clause:${clauses[0]} returns the approved value to its callers`, `// @clause:${clauses[1]} parses the value from a list`,
    'export const value = 1;', 'export function parsed(list) {', '  if (!Array.isArray(list)) {', "    throw new TypeError('The value is read from a list');", '  }',
    '  if (list.length === 0) {', '    return value;', '  }', '  const first = Number(list[0]);', '  return Number.isFinite(first) ? first : value;', '}', ''].join('\n'));
  await writeFile(path.join(root, 'src/format.mjs'), 'export const format = (amount) => `${amount} item${amount === 1 ? \'\' : \'s\'}`;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value, parsed } from '../src/value.mjs';",
    "import { format } from '../src/format.mjs';", `// @ac:${clauses[0]}`, "test('reads the value', () => { assert.equal(value, 1); assert.equal(format(value), '1 item'); assert.equal(format(2), '2 items'); });",
    `// @ac:${clauses[0]}`, `// @ac:${clauses[1]}`, "test('parses an empty list', () => { parsed([]); });", ''].join('\n'));
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ ...manifest, dependencies: { minimist: '1.2.5' } }));
  await writeFile(path.join(root, 'package-lock.json'), lock({ 'node_modules/minimist': { version: '1.2.5', license: 'MIT' } }));
  await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), ['# Implementation summary', '', '## Agent brief', '',
    'Added the value parser, a small formatter and the minimist dependency; both clauses have a focused test.', '',
    '## Changed components and decisions', '', '- `src/value.mjs` exports the approved value and its parser.', '- `src/format.mjs` words an amount.', '',
    '## Tests and operational notes', '', '`test/value.test.mjs` reads the value and parses an empty list.', ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/implementation/operator-notes.md'), ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  // The findings loop returns the lint finding twice; the third publish check lets it through.
  let published = null;
  for (let attempt = 1; attempt <= 3 && !published; attempt += 1) {
    const result = story.run(process.execPath, [CLI, '--no-model', 'phase', 'prepublish', 'implementation', '--for-agent', '--json', '--publish-if-ready'], { allowFailure: true });
    if (result.status === 0) published = result;
    else assert.match(result.stdout, /CODE_QUALITY_FINDINGS/u, `attempt ${attempt}: ${result.stdout.slice(0, 2000)}${result.stderr.slice(-2000)}`);
  }
  assert.ok(published, 'the third publish check publishes');
  const submitted = story.run(process.execPath, [CLI, '--no-model', 'submit', 'implementation'], { allowFailure: true });
  assert.equal(submitted.status, 0, `${submitted.stdout}\n${submitted.stderr}`);
  const phase = JSON.parse(await readFile(workflowFile, 'utf8')).phases.implementation;
  assert.equal(phase.status, 'awaiting_approval');
  // Submission's review asked gh already, which this machine has no answer from: read again from the recorded answers.
  await requiredCheckEvidence(root, {}, JSON.parse(await readFile(workflowFile, 'utf8')), { commit: phase.generationCommit, runCommand: recordedGh(phase.generationCommit), refresh: true });

  const list = JSON.parse(cli('decisions', WORK, '--json').stdout).data;
  const evidence = list.approvalEvidence;
  assert.deepEqual(list.items.map((entry) => entry.kind), ['departure', 'approval-hold', 'approval'], 'the decisions are the list\'s; the evidence adds none');
  assert.equal(evidence.coverage.status, 'measured');
  assert.equal(evidence.coverage.below, true);
  assert.deepEqual(evidence.coverage.files.map((file) => [file.path, file.uncoveredLines]), [['src/value.mjs', '6-7,11']], 'only the file below 80% is listed');
  assert.match(evidence.coverage.words, /^\d+ of \d+ changed lines ran \([\d.]+%\)\. Below the 80% wanted: it warns and refuses nothing\.$/u);
  const [criterion] = evidence.proof.criteria;
  assert.deepEqual([criterion.clauseId, criterion.tests, criterion.asserting, criterion.assertsNothing.map((entry) => entry.test)], [`${WORK}:AC-001`, 2, 1, ['parses an empty list']]);
  assert.deepEqual(evidence.proof.assertionCheck.tests.map((entry) => [entry.name, entry.path]), [['parses an empty list', 'test/value.test.mjs']]);
  assert.deepEqual(evidence.findings.letThrough.map((entry) => [entry.severity, entry.rule, entry.file, entry.line, entry.accepted]), [['high', 'sonarjs/cognitive-complexity', 'src/value.mjs', 4, null]]);
  assert.match(evidence.findings.words, /^1 finding on lines this Story changed went through after 3 attempts/u);
  const hold = list.items.find((entry) => entry.kind === 'approval-hold');
  assert.deepEqual([evidence.hold.entries[0].words, evidence.hold.entries[0].command], ['minimist@1.2.5 GHSA-xvch-5gv4-984h (critical, fixed in 1.2.8)', hold.options[0].action.command],
    'the hold\'s accept command is the one the list already offers');
  assert.deepEqual(evidence.requiredChecks.checks.map((check) => [check.name, check.status]), [['CodeQL', 'passed'], ['SonarCloud Code Analysis', 'failed']]);
  // Outside the digest: the person's answers on the list they were shown record, and the text list is unchanged.
  assert.doesNotMatch(cli('decisions', WORK).stdout, /Evidence for this approval|changed lines ran/u);
  const answers = path.join(story.directory, 'answers.json');
  const accept = list.items[0].options.find((option) => option.id.startsWith('accept'));
  await writeFile(answers, JSON.stringify({ choose: { [list.items[0].id]: accept.id }, reason: { [list.items[0].id]: 'The formatter words the value for the basket page.' }, confirm: list.packetSha256 }));
  const recorded = story.run(process.execPath, [CLI, '--no-model', 'decisions', 'record', WORK, '--answers', answers, '--json'], { allowFailure: true });
  assert.equal(recorded.status, 0, `${recorded.stdout}\n${recorded.stderr}`);
  assert.equal(JSON.parse(cli('decisions', WORK, '--json').stdout).data.approvalEvidence.hold.entries.length, 1, 'the hold stays until a person accepts the package');
});
