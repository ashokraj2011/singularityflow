/**
 * A quick-design Story (intake, fix-design, implement, verify) in a repository of its own, for the change impact tests
 * [SPEC-CIC v1.1 stage 7]: the scope holds an untested requirement (REQ-001) and two tested acceptance criteria (AC-001,
 * AC-002), so its amendments can be editorial, a refinement or material. `changeImpact` is the repository's
 * spec.changeImpact: `on` or `off` written out, or `null` for the template's own (on by default since 2026-11-15).
 * Used by test/cic-change-impact-counts.test.mjs and test/iac-decide-card.test.mjs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { childTimeout } from './child-timeout.mjs';

const cli = fileURLToPath(new URL('../../bin/singularity-flow.mjs', import.meta.url));

export async function changeImpactStory(t, { changeImpact = 'on' } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), `sflow-cic-counts-${changeImpact}-`));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Cone Tester', SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'w.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'a.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'l.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'c.json'),
    SINGULARITY_FLOW_COPILOT_SESSION_STATE: path.join(base, 'copilot-sessions'), SINGULARITY_FLOW_COPILOT_CHAT_OTEL_FILE: path.join(base, 'copilot-chat.jsonl'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Cone Tester', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'cone@example.invalid' };
  const run = (args) => spawnSync(process.execPath, [cli, '--no-model', ...args], { cwd: root, env, encoding: 'utf8', timeout: childTimeout(180_000), maxBuffer: 1 << 26 });
  const must = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000), maxBuffer: 1 << 26 });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'src/value.mjs'), '// The single export of this module.\nexport const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n");
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const group of Object.values(config.approvalAuthorities)) group.allowAnyGitIdentity = true;
  // On: switches 1 and 3 together, and switch 2 as every new Story pins it. Off: every switch off.
  if (changeImpact !== null) config.spec = { ...(config.spec ?? {}), ...(changeImpact === 'on' ? { changeImpact: 'on' } : { changeImpact: 'off', preAmendmentDrafts: 'legacy' }) };
  delete config.phases['fix-design'].clarification;
  config.workTypes['quick-design'] = { ...config.workTypes['quick-fix'], phases: ['intake', 'fix-design', 'implement', 'verify'] };
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Change impact counts fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  const item = (id, ...parts) => path.join(root, 'singularity/work-items', id, ...parts);
  const workflow = async (id) => JSON.parse(await readFile(item(id, 'workflow.json'), 'utf8'));
  const intake = (id) => [
    `# ${id} — Quick fix scope and plan`, '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    `- [${id}:REQ-001] The value module opens with one comment that names its export.`, '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${id}:AC-001] | The exported value equals 2. |`, `| [${id}:AC-002] | The value module stays a single export. |`, '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    `| \`${id}:REQ-001\` | \`src/value.mjs\` | not-applicable: A reviewer reads the module's opening comment. | existing | The comment names the export. |`,
    `| \`${id}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | The test reads 2. |`,
    `| \`${id}:AC-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` | existing | One export remains. |`, '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');
  const designText = (id) => [`# ${id} — Fix Design`, '', '## Root cause', '', 'The exported constant holds the old value; nothing computes it.', '',
    '## Minimal safe change', '', `Change the one literal that holds the value. ${id}:AC-002 keeps the module to a single export, so no import changes.`, '',
    '## Alternatives and regression risk', '', 'A computed value was rejected as unnecessary; the only regression surface is the one test that reads it.', ''].join('\n');
  const code = async (id) => {
    await writeFile(path.join(root, 'src/value.mjs'), `// The single export of this module.\n// @clause:${id}:REQ-001 the opening comment names the export\n`
      + `// @clause:${id}:AC-001 the exported value is the number 2\n// @clause:${id}:AC-002 the single export stays\nexport const value = 2;\n`);
    await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n"
      + `// @ac:${id}:AC-001\ntest('value', () => assert.equal(value, 2));\n// @ac:${id}:AC-002\ntest('one export', async () => assert.deepEqual(Object.keys(await import('../src/value.mjs')), ['value']));\n`);
  };
  // Through the approved scope and design; the design is published without a composed prompt, so under observed
  // dependencies its record is incomplete (receipt-missing).
  const designed = async (id) => {
    sflow('start', id, '--from-branch', 'main', '--work-type', 'quick-design', '--title', 'Change the value', '--description', 'Return 2.');
    sflow('prepare', 'intake'); sflow('phase', 'enter', 'intake', '--compose', '--json');
    await writeFile(item(id, 'artifacts/intake/intake.md'), intake(id));
    sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place'); sflow('submit', 'intake'); sflow('approve', 'intake', '--yes');
    sflow('prepare', 'fix-design');
    await writeFile(item(id, 'artifacts/fix-design/fix-design.md'), designText(id));
    sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place'); sflow('submit', 'fix-design'); sflow('approve', 'fix-design', '--yes');
  };
  const amend = async (id, name, transform, reason) => {
    const file = path.join(base, `${id}-${name}.md`);
    await writeFile(file, transform(await readFile(item(id, 'artifacts/intake/intake.md'), 'utf8')));
    const { proposal } = JSON.parse(sflow('story', 'intent-amendment', 'propose', '--file', file, '--reason', reason, '--json'));
    sflow('story', 'intent-amendment', 'decide', proposal.id, '--decision', 'approve', '--confirm', proposal.id);
    return proposal.id;
  };
  const report = (id, ...format) => {
    const result = run(['report', id, ...format]);
    assert.equal(result.status, 0, `report ${format.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  return { root, run, sflow, item, workflow, code, designed, amend, report };
}

/** The amendments the tests make: REQ-001 reworded (editorial), AC-001 revised (a refinement), REQ-002 added (material). */
export const reword = (text) => text.replace('opens with one comment that names its export', 'begins with a single comment naming its export');
export const reviseCriterion = (text) => text.replace('The exported value equals 2. |', 'The exported value equals 2 and is a number. |');
export const addClause = (id) => (text) => text.replace('## Acceptance criteria', `- [${id}:REQ-002] The value module keeps no other state.\n\n## Acceptance criteria`)
  .replace(`| \`${id}:AC-001\` |`, `| \`${id}:REQ-002\` | \`src/value.mjs\` | not-applicable: A reviewer reads the module. | existing | No other state remains. |\n| \`${id}:AC-001\` |`);

