/**
 * Findings in the code step's loop, through the real CLI [CQF M4 acceptance]: a real ESLint with
 * eslint-plugin-sonarjs finds a problem on a line the Story changed; the finding comes back from
 * `phase prepublish --publish-if-ready` in the same turn with a same-turn continuation, is fixed, and
 * the step publishes; submission reuses the run on unchanged code. A finding on a line the Story did
 * not change is shown as existing and counts for nothing. A scanner that is not installed blocks
 * nothing under warn; under warn the loop ends after 3 attempts and publishes; under enforce it holds
 * the step for a person, who may accept the finding with `decision finding-risk`.
 *
 * ESLint comes from SINGULARITY_FLOW_TEST_NODE_TOOLS and eslint-plugin-sonarjs from
 * SINGULARITY_FLOW_TEST_SONARJS_TOOLS (folders whose node_modules hold them); a tool that is not
 * installed is a visible skip.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { completeAgentResult } from '../src/agent-output.mjs';
import { approvedSpecificationStory, CLI, implementationPlan } from './helpers/submitted-planning-story.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulesWith = (name, ...folders) => folders.filter(Boolean).map((folder) => path.join(folder, 'node_modules'))
  .find((folder) => existsSync(path.join(folder, name, 'package.json'))) ?? null;
const ESLINT = modulesWith('eslint', process.env.SINGULARITY_FLOW_TEST_NODE_TOOLS, CHECKOUT);
const SONARJS = modulesWith('eslint-plugin-sonarjs', process.env.SINGULARITY_FLOW_TEST_SONARJS_TOOLS, process.env.SINGULARITY_FLOW_TEST_NODE_TOOLS, CHECKOUT);
const absent = (t, why) => (process.env.SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES === '1' ? t.diagnostic(why) : t.skip(why));

const ESLINT_CONFIG = [
  "import sonarjs from 'eslint-plugin-sonarjs';",
  "export default [{ files: ['src/**/*.mjs', 'lib/**/*.mjs'], plugins: { sonarjs },",
  "  rules: { 'sonarjs/no-collapsible-if': 'error', 'sonarjs/no-identical-expressions': 'error' } }];", ''
].join('\n');
const eslintCommand = (extra = {}) => ({ id: 'eslint-sonarjs', kind: 'lint', modelPolicy: 'never',
  argv: [process.execPath, 'node_modules/eslint/bin/eslint.js', '--format', 'json-with-metadata', '--output-file', '.sflow/results/eslint.json', 'src', 'lib'],
  result: { adapter: 'eslint-json', path: '.sflow/results/eslint.json' }, ...extra });

/** A Story at its implementation step, in a repository whose main already has one sonarjs finding. */
async function storyAtImplementation(t, WORK, { qualityCommands, staticAnalysis = null } = {}) {
  const story = await approvedSpecificationStory(t, WORK, { configure: (configuration) => {
    configuration.phases.implementation.qualityCommands = qualityCommands;
    if (staticAnalysis) configuration.codeDelivery = { ...(configuration.codeDelivery ?? {}), staticAnalysis };
  }, beforeStart: async ({ root, git }) => {
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await symlink(path.join(ESLINT, 'eslint'), path.join(root, 'node_modules/eslint'), 'dir');
    await symlink(path.join(SONARJS, 'eslint-plugin-sonarjs'), path.join(root, 'node_modules/eslint-plugin-sonarjs'), 'dir');
    await mkdir(path.join(root, 'lib'), { recursive: true });
    await writeFile(path.join(root, 'eslint.config.mjs'), ESLINT_CONFIG);
    await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.sflow/\n');
    // Existing code with a finding: shown as existing, never counted against the Story.
    await writeFile(path.join(root, 'lib/legacy.mjs'), 'export function legacy(a, b) {\n  if (a) {\n    if (b) {\n      return 2;\n    }\n  }\n  return 0;\n}\n');
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ ...manifest, devDependencies: { eslint: '^10.0.0', 'eslint-plugin-sonarjs': '^4.0.0' } }));
    git('add', '.');
    git('commit', '-qm', 'Lint with sonarjs');
    git('push', '-q', 'origin', 'main');
  } });
  const { root, cli, item } = story;
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks'); cli('approve', 'planning', '--yes');
  cli('prepare', 'implementation');
  const clauses = [`${WORK}:AC-001`, `${WORK}:REQ-002`];
  const writeValue = (body) => writeFile(path.join(root, 'src/value.mjs'),
    `${clauses.map((clause) => `// @clause:${clause} returns the approved value to its callers\n`).join('')}${body}`);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'test/value.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value, pick} from '../src/value.mjs';\n${clauses.map((clause) => `// @ac:${clause}\n`).join('')}test('value', () => { assert.equal(value, 1); assert.equal(pick(true, true), 1); });\n`);
  await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), ['# Implementation summary', '', '## Agent brief', '',
    'Added the value module; both clauses have one focused test that reads the approved value and proves it.', '',
    '## Changed components and decisions', '', '- `src/value.mjs` exports the approved value.', '',
    '## Tests and operational notes', '', '`test/value.test.mjs` verifies the value, and nothing else changes for anyone who reads it.', ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/implementation/operator-notes.md'), ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  // A collapsible if on a line this Story adds: a sonarjs finding on new code.
  const findingBody = 'export const value = 1;\nexport function pick(a, b) {\n  if (a) {\n    if (b) {\n      return 1;\n    }\n  }\n  return 0;\n}\n';
  const fixedBody = 'export const value = 1;\nexport function pick(a, b) {\n  if (a && b) {\n    return 1;\n  }\n  return 0;\n}\n';
  await writeValue(findingBody);
  const prepublish = () => {
    const result = story.run(process.execPath, [CLI, '--no-model', 'phase', 'prepublish', 'implementation', '--for-agent', '--json', '--publish-if-ready'], { allowFailure: true });
    const text = result.stdout.trim() || result.stderr.trim();
    return { status: result.status, stderr: result.stderr, value: completeAgentResult(text.slice(text.indexOf('{'))) };
  };
  const workflow = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  return { ...story, writeValue, findingBody, fixedBody, prepublish, workflow };
}

const refusal = (result) => result.value?.error ?? result.value;

test('an ESLint sonarjs finding on a changed line comes back in the same turn, is fixed, and submission reuses the run [CQF M4]', slowLane({ timeout: 900_000 }), async (t) => {
  if (!ESLINT || !SONARJS) return absent(t, 'eslint and eslint-plugin-sonarjs are not installed: set SINGULARITY_FLOW_TEST_NODE_TOOLS and SINGULARITY_FLOW_TEST_SONARJS_TOOLS');
  const WORK = 'CQF-401';
  const story = await storyAtImplementation(t, WORK, { qualityCommands: [eslintCommand(), eslintCommand({ id: 'not-installed-scanner', kind: 'security',
    argv: ['sflow-test-scanner-that-is-not-installed', '--sarif'], result: { adapter: 'sarif', path: '.sflow/results/missing.sarif' } })] });

  const first = story.prepublish();
  assert.notEqual(first.status, 0, 'nothing was published');
  const error = refusal(first);
  assert.equal(error.code, 'CODE_QUALITY_FINDINGS', JSON.stringify(first.value).slice(0, 3000));
  const quality = error.details.qualityFindings;
  assert.deepEqual([quality.mode, quality.attempt, quality.maximumAttempts], ['warn', 1, 3]);
  assert.deepEqual(quality.findings.map((finding) => [finding.tool, finding.rule, finding.file, finding.line, finding.severity]),
    [['eslint', 'sonarjs/no-collapsible-if', 'src/value.mjs', 5, 'high']], 'only the changed line; lib/legacy.mjs is existing code');
  assert.equal(quality.findings[0].toolVersion.split('.').length, 3);
  assert.deepEqual(quality.unavailable.map((entry) => entry.commandId), ['not-installed-scanner'], 'the missing scanner is recorded, and blocks nothing');
  const plan = first.value.remediationPlan;
  assert.equal(plan.repairContinuation.kind, 'quality-findings');
  assert.equal(plan.repairContinuation.currentTurnRepair, true, 'the same turn repairs it');
  assert.equal(plan.repairContinuation.nextCommand, 'singularity-flow phase prepublish implementation --for-agent --json --publish-if-ready');
  assert.equal(plan.context.turn, 'current-turn');
  assert.equal(plan.steps[0].id, 'repair-quality-findings');
  assert.equal((await story.workflow()).phases.implementation.generation, 0, 'nothing was published');

  // The code step fixes it in the same turn: attempt 2 publishes.
  await story.writeValue(story.fixedBody);
  const second = story.prepublish();
  assert.equal(second.status, 0, JSON.stringify(second.value).slice(0, 3000));
  assert.equal(second.value.publishIfReady.published, true);
  assert.deepEqual(second.value.publishIfReady.qualityFindings.unavailable, ['not-installed-scanner']);
  const published = (await story.workflow()).phases.implementation;
  const findings = published.deliveryEvidence.qualityFindings;
  assert.equal(findings.outcome, 'passed');
  assert.deepEqual(findings.commands.map((command) => [command.id, command.status]), [['eslint-sonarjs', 'read'], ['not-installed-scanner', 'unavailable']]);
  assert.equal(findings.commands[0].counts.existing, 1, 'the legacy finding is shown as existing');
  assert.equal(findings.counts.counted, 0);

  // Submission reuses the publish check's run on the unchanged code: nothing reruns.
  const submitted = story.run(process.execPath, [CLI, '--no-model', 'submit', 'implementation'], { allowFailure: true });
  assert.equal(submitted.status, 0, `${submitted.stdout}\n${submitted.stderr}`);
  assert.match(submitted.stderr, /Not run again: eslint-sonarjs read this exact code with the same tool and rules/u);
  const after = (await story.workflow()).phases.implementation;
  const lint = after.checks.find((check) => check.id === 'eslint-sonarjs');
  assert.deepEqual([lint.status, lint.evidenceUse, lint.findings.counted], ['passed', 'reused', 0]);
  assert.match(lint.findings.reusedFrom, /^QR-[0-9a-f]{20}$/u);
  const missing = after.checks.find((check) => check.id === 'not-installed-scanner');
  assert.deepEqual([missing.status, missing.requirement], ['unavailable', 'advisory'], 'unavailable under warn is advisory');
  assert.equal(after.status, 'awaiting_approval');
});

test('under warn the loop ends after 3 attempts and publishes; a suppression added on a changed line is a finding [CQF:REQ-043, REQ-044]', slowLane({ timeout: 900_000 }), async (t) => {
  if (!ESLINT || !SONARJS) return absent(t, 'eslint and eslint-plugin-sonarjs are not installed: set SINGULARITY_FLOW_TEST_NODE_TOOLS and SINGULARITY_FLOW_TEST_SONARJS_TOOLS');
  const WORK = 'CQF-402';
  const story = await storyAtImplementation(t, WORK, { qualityCommands: [eslintCommand()] });
  // A model that silences the rule instead of fixing it: the suppression is the finding now.
  await story.writeValue(story.findingBody.replace('  if (a) {', '  // eslint-disable-next-line sonarjs/no-collapsible-if\n  if (a) {'));
  for (const attempt of [1, 2]) {
    const result = story.prepublish();
    const error = refusal(result);
    assert.equal(error.code, 'CODE_QUALITY_FINDINGS');
    assert.equal(error.details.qualityFindings.attempt, attempt);
    assert.deepEqual(error.details.qualityFindings.findings.map((finding) => [finding.tool, finding.rule, finding.line]),
      [['sflow', 'suppression-added:eslint-disable', 5]]);
  }
  const third = story.prepublish();
  assert.equal(third.status, 0, JSON.stringify(third.value).slice(0, 3000));
  // The publication says what it let through, so the code step can tell the person.
  const told = third.value.publishIfReady.qualityFindings;
  assert.deepEqual([told.outcome, told.attempt, told.remaining.map((finding) => finding.rule)], ['warned', 3, ['suppression-added:eslint-disable']]);
  assert.match(told.words, /1 finding\(s\) on changed lines remain after 3 attempt\(s\) and go to the step's approvers/u);
  const evidence = (await story.workflow()).phases.implementation.deliveryEvidence.qualityFindings;
  assert.deepEqual([evidence.outcome, evidence.attempt, evidence.counts.counted, evidence.escalated.length], ['warned', 3, 1, 1]);
  assert.equal(evidence.findings[0].rule, 'suppression-added:eslint-disable');
});

test('under enforce the spent loop holds the step for a person, who accepts the finding with decision finding-risk [CQF:REQ-046, REQ-047]', slowLane({ timeout: 900_000 }), async (t) => {
  if (!ESLINT || !SONARJS) return absent(t, 'eslint and eslint-plugin-sonarjs are not installed: set SINGULARITY_FLOW_TEST_NODE_TOOLS and SINGULARITY_FLOW_TEST_SONARJS_TOOLS');
  const WORK = 'CQF-403';
  const story = await storyAtImplementation(t, WORK, { qualityCommands: [eslintCommand()], staticAnalysis: { mode: 'enforce' } });
  for (const attempt of [1, 2]) assert.equal(refusal(story.prepublish()).details.qualityFindings.attempt, attempt);
  const held = story.prepublish();
  const error = refusal(held);
  assert.equal(error.code, 'CODE_QUALITY_FINDINGS_HELD');
  assert.equal(held.value.remediationPlan.repairContinuation, undefined, 'no same-turn repair once the loop is spent');
  assert.match(held.value.remediationPlan.retry.label, /a person decides each held finding/u);
  const route = held.value.remediationPlan.steps.find((step) => /decision finding-risk/u.test(step.command ?? ''));
  assert.ok(route, JSON.stringify(held.value.remediationPlan.steps));
  const [finding] = error.details.qualityFindings.findings;
  assert.match(route.command, new RegExp(`--finding ${finding.id} --fingerprint ${finding.fingerprint} --rule sonarjs/no-collapsible-if --tool eslint --tool-version \\S+ --kind code-smell`, 'u'));
  // A short reason and a far expiry are refused; the person's decision binds the finding.
  const expires = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const decide = (...extra) => story.run(process.execPath, [CLI, '--no-model', 'decision', 'finding-risk', WORK, '--phase', 'implementation', '--finding', finding.id, ...extra], { allowFailure: true });
  assert.match(decide('--reason', 'too short', '--expires', expires).stderr, /20 to 1000 characters/u);
  assert.match(decide('--reason', 'The nested branches mirror the pricing table.', '--expires', '2099-01-01').stderr, /at most 90 days ahead/u);
  // On another checkout the refusal's own binding names the finding; it must be this finding's.
  assert.match(decide('--fingerprint', `sha256:${'0'.repeat(64)}`, '--tool', 'eslint', '--reason', 'The nested branches mirror the pricing table.', '--expires', expires).stderr,
    /must belong to --finding/u);
  assert.match(decide('--fingerprint', finding.fingerprint, '--tool', 'eslint', '--kind', 'harmless', '--reason', 'The nested branches mirror the pricing table.', '--expires', expires).stderr,
    /--kind is one of/u);
  const accepted = decide('--reason', 'The nested branches mirror the pricing table.', '--expires', expires);
  assert.equal(accepted.status, 0, accepted.stderr);
  const [decision] = (await story.workflow()).findingRisks;
  assert.deepEqual([decision.id, decision.fingerprint, decision.rule, decision.tool, decision.phase], ['FRK-001', finding.fingerprint, 'sonarjs/no-collapsible-if', 'eslint', 'implementation']);
  const published = story.prepublish();
  assert.equal(published.status, 0, JSON.stringify(published.value).slice(0, 3000));
  const evidence = (await story.workflow()).phases.implementation.deliveryEvidence.qualityFindings;
  assert.deepEqual([evidence.outcome, evidence.counts.counted, evidence.accepted.map((entry) => entry.decision.id)], ['passed', 0, ['FRK-001']]);
});
