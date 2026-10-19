/**
 * An honest partial verdict publishes; a person decides it before approval. [owner decision 2026-10-19]
 *
 * A release step's report honestly marked clauses partial and disclosed why under
 * `## Upstream discrepancies`. The draft check refused it and told the agent, in the same turn, to
 * "re-author every finding"; the agent flipped the verdicts to "matched" while its own discrepancy
 * paragraph still said "partial", and the report published. Now the verdict never blocks drafting,
 * publication or submission; approval and the final gate wait for a decided upstream issue about the
 * clause, and a table that contradicts its own discrepancy text is called out.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { completeAgentResult } from '../src/agent-output.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Verdict Tester',
      SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(cwd, '.git/fixture-mode.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(cwd, '.git/fixture-selection.json'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(cwd, '.git/fixture-registry.json') }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('an honest partial verdict publishes and submits, and approval waits for a decided upstream issue', { timeout: 600_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-honest-verdict-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const W = 'VERDICT-1';
  const [AC1, AC2] = [`${W}:AC-001`, `${W}:AC-002`];
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const attempt = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  const source = (value) => `// @clause:${AC1} returns the approved value\n// @clause:${AC2} keeps the module export named value\nexport const value = ${value};\n`;
  const check = (value, tagged) => ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", ...(tagged ? [`// @ac:${AC1}`, `// @ac:${AC2}`] : []),
    `test('value', () => assert.equal(value, ${value}));`, ''].join('\n');
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Verdict Tester'], root);
  run('git', ['config', 'user.email', 'verdict@example.test'], root);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', check(1, false));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the honest verdict fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const plan = completeAgentResult(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', plan.planId, '--json');
  cli('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery',
    '--title', 'Change the value', '--description', 'Return the approved value 2.');
  const item = path.join(root, 'singularity/work-items', W);
  const workflow = () => readFile(path.join(item, 'workflow.json'), 'utf8').then(JSON.parse);

  cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${W} — Classic delivery intake`, '', '## Request and outcome', '',
    'Return the approved new value 2 to every caller; retain the exported API.', '',
    '## Scope and constraints', '', 'Change only the value module and its executable unit test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${AC1}] | The exported value equals 2. |`, `| [${AC2}] | The module still exports a binding named value. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${AC1}\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, `| \`${AC2}\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Initial evidence', '', 'The baseline module and executable test at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is the new value 2 the approved outcome?',
    '--answer', 'Yes; keep the exported interface and add the matching unit test.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');

  cli('prepare', 'implementation');
  await write('src/value.mjs', source(2));
  await write('test/value.test.mjs', check(2, true));
  const summary = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(summary, (await readFile(summary, 'utf8')).replace(/TODO:[^\n]*/gu,
    'The clause-tagged value module and acceptance-tagged unit test now prove the approved value 2.'));
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  cli('approve', 'implementation', '--yes');

  cli('prepare', 'testing');
  const testing = path.join(item, (await workflow()).phases.testing.requiredArtifact.path);
  await writeFile(testing, (await readFile(testing, 'utf8')).replace(/TODO:[^\n]*/gu,
    `Verified ${AC1} and ${AC2} against the committed passing unit-test receipt.`).replace(/\bTODO\b/gu, 'matched'));
  cli('phase', 'publish', 'testing', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'testing');
  cli('approve', 'testing', '--yes');

  // The incident shape: AC-001 is honestly partial and disclosed; AC-002 says matched in the table
  // while the discrepancy text still calls it partial.
  cli('prepare', 'conformance');
  const report = path.join(item, (await workflow()).phases.conformance.requiredArtifact.path);
  const sampleRow = `| \`${AC1}\` | TODO | TODO | TODO | TODO: matched/partial/missing/deviated/unplanned | TODO |`;
  let text = await readFile(report, 'utf8');
  assert.ok(text.includes(sampleRow), 'Code checking provides the sample clause row');
  text = text.replace(sampleRow, [
    `| \`${AC1}\` | Exported value equals 2 | \`src/value.mjs\` @clause:${AC1} | \`test/value.test.mjs\` @ac:${AC1} | partial | the claimed 15-test run was never recorded |`,
    `| \`${AC2}\` | Export keeps its name | \`src/value.mjs\` @clause:${AC2} | \`test/value.test.mjs\` @ac:${AC2} | matched | none |`
  ].join('\n'));
  text = text.replace(/TODO:[^\n]*/gu, `Compared ${AC1} and ${AC2} against the approved Code generation and its committed receipt.`)
    .replace(/\bTODO\b/gu, 'none');
  text += [
    '', '## Upstream discrepancies', '',
    `- implementation: the Testing step cites a 15-test run that SFlow never recorded, so ${AC1} and ${AC2} remain partial until a recorded run exists.`, ''
  ].join('\n');
  await writeFile(report, text);

  const draft = completeAgentResult(cli('phase', 'draft-check', 'conformance', '--json').stdout);
  assert.equal(draft.status, 'ready', JSON.stringify(draft.findings));
  assert.deepEqual(draft.findings, []);
  assert.notEqual(draft.correction.class, 'agent-authoring', 'an honest gap is never the author\'s correction');
  assert.equal(draft.correction.sameTurn, false);
  assert.doesNotMatch(JSON.stringify(draft.correction), /re-author/u);
  const incomplete = draft.advisories.filter((entry) => entry.code === 'conformance.verdict-incomplete');
  assert.deepEqual(incomplete.map((entry) => [entry.clauseId, entry.blocking, entry.requiredBefore, entry.details.owner]),
    [[AC1, false, 'approve', 'implementation']]);
  assert.match(incomplete[0].message, /Keep the honest verdict/u);
  const contradicted = draft.advisories.filter((entry) => entry.code === 'conformance.verdict-contradicted');
  assert.deepEqual(contradicted.map((entry) => [entry.clauseId, entry.blocking, entry.details.stated]), [[AC2, false, 'partial']]);
  assert.match(contradicted[0].message, /the table says matched, the Upstream discrepancies text says partial: use the honest verdict/u);

  // One verdict source: prepare wrote the Verdict summary from the template's sample row; the
  // table has changed since, so the check says so, and preparing again refreshes the block.
  assert.match(text, /The clause table is the only place a verdict is stated\./u, 'the template tells authors where verdicts live');
  const stale = draft.advisories.find((entry) => entry.code === 'conformance.verdict-summary-stale');
  assert.equal(stale?.blocking, false);
  assert.equal(stale.details.refreshCommand, 'singularity-flow prepare conformance');
  cli('prepare', 'conformance');
  const summarized = await readFile(report, 'utf8');
  assert.equal(summarized.split('<!-- singularity-flow:verdict-summary:start -->').length, 2, 'one managed summary');
  assert.match(summarized, new RegExp(`^- \`${AC1}\`: partial; no issue raised yet; implementation owns it\\.$`, 'mu'));
  const block = summarized.slice(summarized.indexOf('<!-- singularity-flow:verdict-summary:start -->'),
    summarized.indexOf('<!-- singularity-flow:verdict-summary:end -->'));
  assert.doesNotMatch(block, new RegExp(AC2, 'u'), 'only partial and missing clauses are listed');
  assert.ok(summarized.includes('remain partial until a recorded run exists'), 'preparing again keeps every authored byte');
  const refreshed = completeAgentResult(cli('phase', 'draft-check', 'conformance', '--json').stdout);
  assert.equal(refreshed.status, 'ready');
  assert.equal(refreshed.advisories.some((entry) => entry.code === 'conformance.verdict-summary-stale'), false);
  assert.equal(refreshed.advisories.filter((entry) => entry.code === 'conformance.verdict-contradicted').length, 1,
    'the summary never counts as discrepancy text');

  const prepublish = completeAgentResult(cli('phase', 'prepublish', 'conformance', '--json').stdout);
  assert.equal(prepublish.status, 'ready', JSON.stringify(prepublish.findings));
  assert.notEqual(prepublish.correction.class, 'agent-authoring');
  assert.equal(prepublish.correction.sameTurn, false);
  const gapAdvisory = prepublish.resolution.advisories.find((entry) => entry.code === 'conformance.verdict-incomplete');
  assert.equal(gapAdvisory.requiredBefore, 'approve');
  assert.equal(gapAdvisory.blocking, false);
  assert.deepEqual(gapAdvisory.choices.map((choice) => choice.kind),
    ['upstream-issue', 'repair-return', 'evidence-reuse', 'fresh-recorded-run']);
  assert.match(gapAdvisory.choices[0].command, new RegExp(`^singularity-flow upstream-issue raise --phase implementation --about ${AC1} `, 'u'));
  assert.match(gapAdvisory.choices[2].command, new RegExp(`^singularity-flow decision evidence-reuse ${W} --phase implementation --from-attempt <ATTEMPT-ID> --reason <TEXT>$`, 'u'));
  assert.match(gapAdvisory.choices[2].detail, /never certifies a run that was not recorded/u);
  assert.match(gapAdvisory.choices[3].detail, /cannot record test runs/u);
  assert.equal(prepublish.resolution.advisories.find((entry) => entry.code === 'conformance.verdict-contradicted').requiredBefore, null);

  // Publication and submission of the final step take the honest verdict as written.
  cli('phase', 'publish', 'conformance', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'conformance');
  assert.equal((await workflow()).phases.conformance.status, 'awaiting_approval');

  const unraised = attempt('approve', 'conformance', '--yes');
  assert.notEqual(unraised.status, 0, 'approval waits for a person to decide the gap');
  const unraisedText = unraised.stdout + unraised.stderr;
  assert.match(unraisedText, new RegExp(`${AC1} remains partial: no upstream issue names it yet; raise one against implementation`, 'u'));
  assert.match(unraisedText, new RegExp(`singularity-flow upstream-issue raise --phase implementation --about ${AC1}`, 'u'));
  assert.match(unraisedText, /Keep the honest verdict; never edit it to clear a check/u);
  // The recovery plan names the decision and every route, never a repair of the report itself.
  const planText = unraisedText.slice(unraisedText.indexOf('Recovery plan:'));
  assert.match(planText, new RegExp(`Shell: singularity-flow upstream-issue raise --phase implementation --about ${AC1} `, 'u'));
  assert.match(planText, new RegExp(`Shell: singularity-flow decision evidence-reuse ${W} --phase implementation --from-attempt <ATTEMPT-ID> --reason <TEXT>`, 'u'));
  assert.match(planText, /Shell: singularity-flow reject conformance --work-id VERDICT-1 --to implementation/u);
  assert.match(planText, /Never edit the verdict to clear this check/u);
  assert.doesNotMatch(planText, /Inspect and repair only phase/u);
  assert.equal((await workflow()).phases.conformance.status, 'awaiting_approval');
  const unraisedGate = JSON.parse(attempt('gate', '--terminal', '--json').stdout).findings
    .find((finding) => finding.code === 'gate.conformance.blocking-verdict');
  assert.equal(unraisedGate.details.status, 'unraised');
  assert.match(unraisedGate.recovery.command, new RegExp(`^singularity-flow upstream-issue raise --phase implementation --about ${AC1} `, 'u'));

  cli('upstream-issue', 'raise', '--phase', 'implementation', '--about', AC1,
    '--problem', 'The Testing step cites a 15-test run that SFlow never recorded for this clause.');
  const undecided = attempt('approve', 'conformance', '--yes');
  assert.notEqual(undecided.status, 0);
  assert.match(undecided.stdout + undecided.stderr, new RegExp(`${AC1} remains partial: UPI-001 names it and is not decided`, 'u'));
  assert.match(undecided.stdout + undecided.stderr, new RegExp(`singularity-flow upstream-issue decide UPI-001 --work-id ${W} --outcome accept-risk`, 'u'));
  // The final gate asks the same question as approval and names the same decision.
  const terminalGap = (result) => JSON.parse(result.stdout).findings.find((finding) => finding.code === 'gate.conformance.blocking-verdict');
  const undecidedGate = attempt('gate', '--terminal', '--json');
  assert.notEqual(undecidedGate.status, 0);
  const undecidedFinding = terminalGap(undecidedGate);
  assert.equal(undecidedFinding.details.clauseId, AC1);
  assert.equal(undecidedFinding.details.status, 'undecided');
  assert.equal(undecidedFinding.recovery.ownerPhase, 'implementation');
  assert.match(undecidedFinding.recovery.command, new RegExp(`^singularity-flow upstream-issue decide UPI-001 --work-id ${W} --outcome accept-risk `, 'u'));
  assert.doesNotMatch(undecidedFinding.recovery.command, /reject conformance --work-id \S+ --to conformance/u, 'never back to the report author');

  // An accepted risk that has expired no longer covers the clause.
  const soon = new Date(Date.now() + 4000).toISOString();
  cli('upstream-issue', 'decide', 'UPI-001', '--outcome', 'accept-risk', '--expires', soon,
    '--reason', 'Accept the unrecorded run briefly while the runner is repaired.');
  await sleep(Math.max(0, Date.parse(soon) - Date.now()) + 500);
  const expired = attempt('approve', 'conformance', '--yes');
  assert.notEqual(expired.status, 0, 'an expired acceptance does not cover the gap');
  assert.match(expired.stdout + expired.stderr, /UPI-001's accepted risk expired at/u);
  assert.equal(terminalGap(attempt('gate', '--terminal', '--json')).details.status, 'expired', 'the gate agrees with approval');

  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  cli('upstream-issue', 'decide', 'UPI-001', '--outcome', 'accept-risk', '--expires', expires,
    '--reason', 'The delivered value is correct; the missing run record is accepted until the runner is repaired.');
  const approved = attempt('approve', 'conformance', '--yes');
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  const finished = await workflow();
  assert.equal(finished.status, 'closed');
  const kept = await readFile(report, 'utf8');
  assert.match(kept, new RegExp(`\\| \`${AC1}\` \\|[^\\n]*\\| partial \\|`, 'u'), 'the honest verdict was never edited');
  // The final gate agrees with approval: the decided gap does not refuse it.
  const gate = attempt('gate', '--terminal', '--json');
  assert.equal(gate.status, 0, gate.stdout + gate.stderr);
});
