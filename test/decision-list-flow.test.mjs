/**
 * The decision list through a whole Story, from the terminal: the release-approval incident made easy.
 *
 * The incident: approval of the last step waited on a partial verdict whose issue had been raised
 * against the wrong step. The person ran six commands across three approval groups (raise a
 * replacement, reuse the recorded run, decide the replacement, dismiss the original, approve), and
 * next steps offered approval while the superseded original still refused it.
 *
 * Here the same records are one item in `decisions`: the gap and the replacement issue merged, the
 * superseded original absent, reuse recommended because a recorded run on unchanged code covers the
 * clause. One `decisions record` writes the reuse and the issue decision through their own commands,
 * each under its own approval group, and approval then succeeds. Next steps and the refusal route to
 * the list until then, never to an approval the engine would refuse.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { slowLane } from './helpers/slow-lane.mjs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { completeAgentResult } from '../src/agent-output.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const RECORD_ID = /\b(?:UPI|ERU|TRR|CR|PRC|FAM)-\d{3}\b|\bTA-[a-f0-9]{20}\b|\s--[a-z]/u;

function run(command, args, cwd, { allowFailure = false, as = null } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Decision Tester', SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
      SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(cwd, '.git/fixture-mode.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(cwd, '.git/fixture-selection.json'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(cwd, '.git/fixture-registry.json'),
      ...(as ? { SINGULARITY_FLOW_GITHUB_ACTOR: as } : {}) }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('the release-approval incident is one decision: recorded once, then approval succeeds', slowLane({ timeout: 900_000 }), async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-decision-list-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const W = 'DECIDE-1';
  const [AC1, AC2] = [`${W}:AC-001`, `${W}:AC-002`];
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const cliAs = (as, ...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { as });
  const attempt = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  const attemptAs = (as, ...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true, as });
  const json = (result) => JSON.parse(result.stdout);
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  const source = (value) => `// @clause:${AC1} returns the approved value\n// @clause:${AC2} keeps the module export named value\nexport const value = ${value};\n`;
  const check = (value, tagged) => ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", ...(tagged ? [`// @ac:${AC1}`, `// @ac:${AC2}`] : []),
    `test('value', () => assert.equal(value, ${value}));`, ''].join('\n');
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Decision Tester'], root);
  run('git', ['config', 'user.email', 'decider@example.invalid'], root);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', check(1, false));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Only a named person approves Testing (and so may reuse a run for it); anyone approves the rest.
  config.approvalAuthorities['quality-reviewers'] = { label: 'Quality reviewers', allowAnyGitIdentity: false,
    members: [{ githubLogin: 'release-reviewer' }] };
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the decision list fixture'], root);
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
  const recorded = (await workflow()).phases.implementation.deliveryEvidence.testExecutions.find((entry) => entry.attemptId);
  assert.equal(recorded.status, 'passed');

  cli('prepare', 'testing');
  const testing = path.join(item, (await workflow()).phases.testing.requiredArtifact.path);
  await writeFile(testing, (await readFile(testing, 'utf8')).replace(/TODO:[^\n]*/gu,
    `Verified ${AC1} and ${AC2}: 15 tests passed when run by hand.`).replace(/\bTODO\b/gu, 'matched'));
  cli('phase', 'publish', 'testing', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'testing');
  cliAs('release-reviewer', 'approve', 'testing', '--yes');

  cli('prepare', 'conformance');
  const report = path.join(item, (await workflow()).phases.conformance.requiredArtifact.path);
  const sampleRow = `| \`${AC1}\` | TODO | TODO | TODO | TODO: matched/partial/missing/deviated/unplanned | TODO |`;
  let text = await readFile(report, 'utf8');
  assert.ok(text.includes(sampleRow), 'Code checking provides the sample clause row');
  text = text.replace(sampleRow, [
    `| \`${AC1}\` | Exported value equals 2 | \`src/value.mjs\` @clause:${AC1} | \`test/value.test.mjs\` @ac:${AC1} | partial | the 15-test run Testing cites was never recorded |`,
    `| \`${AC2}\` | Export keeps its name | \`src/value.mjs\` @clause:${AC2} | \`test/value.test.mjs\` @ac:${AC2} | matched | none |`
  ].join('\n'));
  text = text.replace(/TODO:[^\n]*/gu, `Compared ${AC1} and ${AC2} against the approved Code generation and its committed receipt.`)
    .replace(/\bTODO\b/gu, 'none');
  text += '\n\n## Upstream discrepancies\n\n'
    + '- **Testing, “Acceptance results”:** Testing cites a 15-test execution that its packet did not retain. '
    + 'Impact: the test portion of both clauses lacks a retained execution. Proposed owner action: retain a genuine run.\n';
  await writeFile(report, text);
  cli('prepare', 'conformance');
  cli('phase', 'publish', 'conformance', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'conformance');

  // A section-only issue filed from the exact report is one problem with its partial verdict,
  // owned by Testing, not a second invented Code defect. Every surface agrees before recording.
  cli('upstream-issue', 'raise', '--from-artifact');
  const sectionPacket = json(cliAs('release-reviewer', 'decisions', W, '--json')).data;
  // The gap, then the step's approval it holds: one list holds every pending kind, the approval last.
  assert.deepEqual(sectionPacket.items.map((entry) => [entry.kind, entry.details.heldBy ?? null]), [['conformance-gap', null], ['approval', ['d1']]]);
  assert.deepEqual([sectionPacket.items[0].details.owner, sectionPacket.items[0].details.issue], ['testing', 'UPI-001']);
  assert.equal(sectionPacket.items[0].options.some((option) => option.effects.some((effect) => effect.kind === 'upstream-issue')), false);
  assert.deepEqual(sectionPacket.items[0].options.find((option) => option.id === 'accept-risk').decidedBy.groups, ['quality-reviewers']);
  const sectionRefusal = json(attempt('approve', 'conformance', '--yes', '--json'));
  assert.equal(sectionRefusal.error.details.decisions.count, 1);
  assert.equal(sectionRefusal.error.details.conformanceGaps[0].owner, 'testing');
  assert.equal(sectionRefusal.error.details.conformanceGaps[0].issue, 'UPI-001');
  const sectionGate = json(attempt('gate', '--terminal', '--json')).findings.find((finding) => finding.code === 'gate.conformance.blocking-verdict');
  assert.equal(sectionGate.details.owner, 'testing');
  const routing = json(cli('decision', 'show', W, '--json'));
  assert.deepEqual(routing.decisions, []);
  assert.equal(routing.upstreamIssues[0].id, 'UPI-001');
  assert.equal(routing.commandGuidance.pendingDecisions.command, `singularity-flow decisions ${W} --json`);
  assert.match(cli('decision', 'show', W).stdout, new RegExp(`Shell: singularity-flow decisions ${W} --json`, 'u'));

  // Historical supersession still works: the retained report need not be rewritten to replace
  // an issue. Its original reference follows the explicit replacement record, not prose guessing.
  cli('upstream-issue', 'raise', '--phase', 'implementation', '--about', AC1, '--supersedes', 'UPI-001',
    '--problem', 'The delivered change has no recorded run for this clause beyond the Code step.');

  // Next steps never offer the approval the engine would refuse; the decision list takes its place.
  const before = json(cli('nextsteps', W, '--json'));
  assert.equal(before.actions.some((entry) => entry.command?.startsWith('singularity-flow approve conformance')), false,
    JSON.stringify(before.actions.map((entry) => entry.command)));
  const first = before.actions.find((entry) => entry.timing === 'now');
  assert.equal(first.command, `singularity-flow decisions ${W}`);
  assert.equal(first.copilotCommand, `/sf-decide ${W}`);
  assert.match(first.reason, /^Code checking can't be approved yet: 1 decision needed\./u);

  // The refusal leads with one plain sentence and the list; the per-clause commands stay in details.
  const refusedApproval = attempt('approve', 'conformance', '--yes', '--json');
  assert.notEqual(refusedApproval.status, 0);
  const refusal = json(refusedApproval);
  assert.equal(refusal.error.code, 'CONFORMANCE_BLOCKING_VERDICTS');
  assert.match(refusal.error.message, /^Code checking can't be approved yet: 1 decision needed\. Decide them in one place\. - Copilot: \/sf-decide DECIDE-1 - Shell: singularity-flow decisions DECIDE-1 - VS Code \(model-free\): not available for this action\s/u);
  assert.equal(refusal.remediationPlan.steps[0].command, `singularity-flow decisions ${W}`);
  assert.equal(refusal.remediationPlan.steps[0].copilotCommand, `/sf-decide ${W}`);
  assert.equal(refusal.error.details.nextAction, `singularity-flow decisions ${W}`);
  assert.deepEqual(refusal.error.details.decisions, { headline: 'Code checking can\'t be approved yet: 1 decision needed.', count: 1 });
  assert.ok(refusal.error.details.conformanceGaps[0].choices.some((choice) => /upstream-issue decide UPI-002/u.test(choice.command)), 'scripts keep the exact commands');
  const gate = json(attempt('gate', '--terminal', '--json')).findings.find((finding) => finding.code === 'gate.conformance.blocking-verdict');
  assert.equal(gate.recovery.command, `singularity-flow decisions ${W}`);

  // One item: the gap and the replacement issue together; the superseded original is not there.
  const packet = json(cliAs('release-reviewer', 'decisions', W, '--json')).data;
  assert.equal(packet.resultType, 'sflow-decisions');
  assert.equal(packet.headline, 'Code checking can\'t be approved yet: 1 decision needed.');
  assert.deepEqual(packet.items.map((entry) => [entry.kind, entry.details.heldBy ?? null]), [['conformance-gap', null], ['approval', ['d1']]],
    JSON.stringify(packet.items, null, 2));
  const [d1] = packet.items;
  assert.equal(d1.id, 'd1');
  assert.equal(d1.kind, 'conformance-gap');
  assert.equal(d1.title, 'AC-001 is partial in the Code checking report');
  assert.match(d1.why, /No run by Testing is recorded, and the code has not changed since Code's recorded run \(\d+ of \d+ passed\)/u);
  for (const words of [d1.title, d1.why, ...d1.options.map((option) => option.label)]) assert.doesNotMatch(words, RECORD_ID, words);
  assert.deepEqual([d1.details.issue, d1.details.supersedes, d1.details.issueStatus], ['UPI-002', ['UPI-001'], 'open']);
  assert.doesNotMatch(JSON.stringify(packet.items.map((entry) => [entry.title, entry.why])), /UPI-001/u);
  assert.deepEqual(d1.options.map((option) => [option.id, option.recommended]),
    [['reuse', true], ['accept-risk', false], ['dismiss', false], ['return', false]]);
  const [reuse] = d1.options;
  assert.deepEqual(reuse.effects.map((effect) => [effect.kind, effect.phase ?? effect.issue, effect.outcome ?? effect.recordedBy]),
    [['evidence-reuse', 'testing', 'implementation'], ['upstream-issue-decision', 'UPI-002', 'accept-risk']]);
  assert.equal(reuse.effects[0].attemptId, recorded.attemptId);
  assert.match(reuse.needs.expires.default, /^\d{4}-\d{2}-\d{2}$/u);
  assert.ok(reuse.needs.reason.default.length >= 20);
  assert.equal(reuse.decidedBy.allowed, true);
  assert.match(packet.packetSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(packet.record.recommended, `singularity-flow decisions record ${W} --choose d1=reuse --confirm ${packet.packetSha256}`);

  // The same list for someone outside Testing's approvers: they may accept the risk, not reuse the run.
  const theirs = json(cliAs('other-engineer', 'decisions', W, '--json')).data;
  assert.equal(theirs.packetSha256, packet.packetSha256, 'the digest binds the list, not who reads it');
  assert.equal(theirs.items[0].options[0].decidedBy.allowed, false);
  assert.equal(theirs.items[0].options[0].decidedBy.words, 'The Quality reviewers decide this.');
  assert.equal(theirs.items[0].options[0].decidedBy.share, `/sf-decide ${W}`);
  const notTheirs = attemptAs('other-engineer', 'decisions', 'record', W, '--choose', 'd1=reuse', '--confirm', packet.packetSha256, '--json');
  assert.notEqual(notTheirs.status, 0);
  const notTheirsResult = json(notTheirs);
  assert.equal(notTheirsResult.error.code, 'DECISIONS_NOT_YOURS');
  assert.match(notTheirsResult.error.message, /The Quality reviewers decide this\. Share this with them: \/sf-decide DECIDE-1/u);
  assert.deepEqual((await workflow()).evidenceReuses ?? [], [], 'nothing was recorded for it');

  // A list that changed since it was reviewed refuses the old confirmation, with the current list.
  const stale = attemptAs('release-reviewer', 'decisions', 'record', W, '--choose', 'd1=reuse', '--confirm', `sha256:${'0'.repeat(64)}`, '--json');
  assert.notEqual(stale.status, 0);
  const staleResult = json(stale);
  assert.equal(staleResult.error.code, 'DECISIONS_PACKET_CHANGED');
  assert.equal(staleResult.error.details.packet.packetSha256, packet.packetSha256);
  assert.equal(staleResult.error.details.confirmation.expected, packet.packetSha256, 'a real change carries the current digest');
  // A digest copied with a slip after its first twelve characters (both were shown as the same "changed"
  // prefix) is a slip: nothing changed, use the exact digest [copied values].
  const slipped = `${packet.packetSha256.slice(0, 40)}${packet.packetSha256[40] === 'a' ? 'b' : 'a'}${packet.packetSha256.slice(41)}`;
  const slip = json(attemptAs('release-reviewer', 'decisions', 'record', W, '--choose', 'd1=reuse', '--confirm', slipped, '--json'));
  assert.equal(slip.error.code, 'DECISIONS_PACKET_MISTYPED');
  assert.match(slip.error.message, new RegExp(`a copying slip of the current value; nothing changed\\. Use --confirm ${packet.packetSha256} exactly`, 'u'));
  assert.deepEqual(slip.error.details.confirmation, { expected: packet.packetSha256, given: slipped, slip: true });
  const cut = json(attemptAs('release-reviewer', 'decisions', 'record', W, '--choose', 'd1=reuse', '--confirm', packet.packetSha256.slice(0, 30), '--json'));
  assert.equal(cut.error.code, 'DECISIONS_PACKET_MISTYPED', 'a digest cut short is a slip too');
  // An item not on the list is named, with the items there are; it was dropped without a word before.
  const unknownItem = json(attemptAs('release-reviewer', 'decisions', 'record', W, '--choose', 'd9=reuse', '--confirm', packet.packetSha256, '--json'));
  assert.equal(unknownItem.error.code, 'DECISIONS_ANSWER_INVALID');
  assert.match(unknownItem.error.message, /--choose names d9, which is not an item of this list; its items are d1/u);
  assert.deepEqual((await workflow()).evidenceReuses ?? [], [], 'nothing was recorded for a slip or an unknown item');
  const unconfirmed = attemptAs('release-reviewer', 'decisions', 'record', W, '--choose', 'd1=reuse', '--json');
  assert.equal(json(unconfirmed).error.code, 'DECISIONS_CONFIRMATION_REQUIRED');
  assert.equal(json(unconfirmed).error.details.record.command, packet.record.recommended);

  // One confirmation records both effects through their own commands, each under its own group.
  const done = json(cliAs('release-reviewer', 'decisions', 'record', W, '--choose', 'd1=reuse', '--confirm', packet.packetSha256, '--json'));
  assert.deepEqual(done.data.recorded.map((entry) => [entry.item, entry.kind, entry.record]),
    [['d1', 'evidence-reuse', 'ERU-001'], ['d1', 'upstream-issue-decision', 'UPI-002 accept-risk']]);
  // Two records, one decision, and it says what was decided: what the card tells the agent to report.
  assert.equal(done.data.decided.length, 1);
  assert.match(done.data.decided[0].words, /reuse .*; then accept it as a risk until \d{4}-\d{2}-\d{2} \(decision on UPI-002\)/u);
  const after = await workflow();
  assert.deepEqual(after.evidenceReuses.map((entry) => [entry.id, entry.phase, entry.attempt.phase, entry.authorityGroup]),
    [['ERU-001', 'testing', 'implementation', 'quality-reviewers']]);
  assert.deepEqual(after.upstreamIssueDecisions.map((entry) => [entry.issue, entry.outcome, entry.authorityGroup]),
    [['UPI-002', 'accept-risk', 'engineering-reviewers']]);
  assert.equal(after.upstreamIssueDecisions.some((entry) => entry.issue === 'UPI-001'), false, 'the superseded issue needs no decision');
  assert.ok(after.history.some((entry) => entry.event === 'evidence_reuse_decided'));
  assert.ok(after.history.some((entry) => entry.event === 'upstream_issue_decided'));
  assert.equal(json(cli('decisions', W, '--json')).data.status, 'nothing-to-decide');

  // Parity the other way: once nothing is pending, next steps offer the approval, and it succeeds.
  const ready = json(cli('nextsteps', W, '--json'));
  assert.equal(ready.actions.find((entry) => entry.timing === 'now').command, `singularity-flow approve conformance --work-id ${W} --fetch`);
  const approved = attempt('approve', 'conformance', '--yes');
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.equal((await workflow()).status, 'closed');
  const kept = await readFile(report, 'utf8');
  assert.match(kept, new RegExp(`\\| \`${AC1}\` \\|[^\\n]*\\| partial \\|`, 'u'), 'the honest verdict was never edited');
});
