/**
 * What this change does, on a real Story [CSP, docs/SPEC-CSP-CHANGE-STORY-PAGE-v1.md]: intake, code and testing through the
 * CLI. Once the code step is published, the Story's folder holds CHANGE-STORY.md, committed with the publication: every
 * section, each changed function in Copilot's checked words or "not described yet", and SFlow's own test run. The code
 * step's approval starts with the page's line, the read prints it, and the testing step's publication writes it again.
 * Nothing waits for it: the steps are submitted and approved as before.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function execute(command, args, cwd, { allowFailure = false } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Page Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'chore', agent: 'developer' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: childTimeout(180_000) });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}
const flow = (cwd, args, options) => execute(process.execPath, [bin, ...args], cwd, options);
// No detached auto-maintenance in the fixture's own Git commands (document-step-files.test.mjs).
const git = (cwd, ...args) => execute('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], cwd).stdout.trim();
const json = (result) => JSON.parse(result.stdout);

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-change-story-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(`${root}.git`, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Page Tester');
  git(root, 'config', 'user.email', 'page.tester@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Ledger\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.approvalSecurity = { profile: 'poc' };
  config.worldModel.grounding = 'off';
  config.repositoryReadiness = { ...config.repositoryReadiness, requiredBeforeStory: false };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Not a review test: every step's review is walked in review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  config.workTypes['classic-delivery'].spec = { ...(config.workTypes['classic-delivery'].spec ?? {}), mode: 'enforce', coverage: 'enforce' };
  await writeFile(configPath, YAML.stringify(config));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  execute('mkdir', ['-p', 'src', 'test'], root);
  await writeFile(path.join(root, 'src/value.mjs'), 'export function value() {\n  return 1;\n}\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", "test('value', () => assert.equal(value(), 1));", ''].join('\n'));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'initial');
  git(root, 'init', '-q', '--bare', '-b', 'main', `${root}.git`);
  for (const [key, value] of [['maintenance.auto', 'false'], ['gc.auto', '0']]) git(`${root}.git`, 'config', key, value);
  git(root, 'remote', 'add', 'origin', `${root}.git`);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return root;
}

test('the code step\'s publication writes what the change does, its approval shows it, and the testing step writes it again',
  slowLane({ timeout: 900_000 }), async (t) => {
    const W = 'CSP-1';
    const AC = `${W}:AC-001`;
    const root = await repository(t);
    const write = (relative, contents) => writeFile(path.join(root, relative), contents);
    const readiness = json(flow(root, ['precheck', '--run', '--scope', 'dependency-test', '--json'])).data.plan;
    flow(root, ['precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json']);
    flow(root, ['start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Double the value',
      '--description', 'Return 2 from value, and add a doubled value. Callers read the new number at once.']);
    const item = path.join(root, 'singularity/work-items', W);
    flow(root, ['prepare', 'intake']);
    await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
      `# ${W} — intake`, '', '## Request and outcome', '', 'Return 2 from value, and add a doubled value.', '',
      '## Scope and constraints', '', 'Change only the value module and its test.', '',
      '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${AC}] | value returns 2 and doubled returns 4. |`, '',
      '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
      `| \`${AC}\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified |`, '',
      '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''
    ].join('\n'));
    flow(root, ['wm', 'compose', '--phase', 'intake']);
    flow(root, ['clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.']);
    flow(root, ['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place']);
    flow(root, ['submit', 'intake']);
    flow(root, ['approve', 'intake', '--yes']);
    const page = path.join(item, 'CHANGE-STORY.md');
    await assert.rejects(readFile(page, 'utf8'), { code: 'ENOENT' }, 'no page before a code step is published');
    const notYet = json(flow(root, ['explain', '--subject', 'change', '--page', '--json'])).data.page;
    assert.equal(notYet.status, 'not-yet');

    // The code step: code, tests, and Copilot's plain-English notes beside its document (one of them with a link).
    flow(root, ['prepare', 'implementation']);
    await write('src/value.mjs', [`// @clause:${AC} returns the approved value`, 'export function value() {', '  return 2;', '}', '',
      'export function doubled() {', '  return value() * 2;', '}', ''].join('\n'));
    await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
      "import { doubled, value } from '../src/value.mjs';", `// @ac:${AC}`, "test('value', () => assert.equal(value(), 2));", '',
      `// @ac:${AC}`, "test('doubled', () => assert.equal(doubled(), 4));", ''].join('\n'));
    await writeFile(path.join(item, 'artifacts/implementation/change-explanation.json'), JSON.stringify({
      how: 'Every caller asks value for the number, which is now 2. The new doubled function asks value and multiplies it by two, so the two never disagree.',
      functions: { 'src/value.mjs': {
        value: { does: 'Gives the approved number', needs: 'nothing', gives: 'the number 2', changed: 'before, it gave back 1; now it gives back 2' },
        doubled: { does: 'Gives twice the approved number; see https://example.invalid' } } },
      reasons: ['doubled reads value rather than its own number, so a later change to the value needs one edit.']
    }));
    const summary = path.join(item, 'artifacts/implementation/implementation-summary.md');
    await writeFile(summary, (await readFile(summary, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module returns the approved value and its double.'));
    flow(root, ['phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place']);

    // Written in the publication's own commit, as a Story record: nothing is left to commit, no gate counts it.
    const text = await readFile(page, 'utf8');
    for (const line of text.split('\n')) t.diagnostic(`page | ${line}`);
    assert.equal(git(root, 'status', '--porcelain', '--', `singularity/work-items/${W}`), '');
    assert.ok(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').includes(`singularity/work-items/${W}/CHANGE-STORY.md`));
    assert.match(text, /^# What this change does: CSP-1, "Double the value"$/mu);
    for (const heading of ['## 1. What we had to do', '## 2. How it works', '## 3. Why we did it this way', '## 4. What we changed', '## 5. How it was tested']) {
      assert.ok(text.includes(heading), `${heading}\n${text}`);
    }
    assert.match(text, /^Return 2 from value, and add a doubled value\. Callers read the new number at once\.$/mu);
    assert.match(text, /^- `CSP-1:AC-001` value returns 2 and doubled returns 4\.$/mu);
    assert.match(text, /^Every caller asks value for the number, which is now 2\./mu);
    assert.match(text, /^\*\*Edited\*\* `src\/value\.mjs` \(serves `CSP-1:AC-001`\)$/mu);
    assert.match(text, /^- \*\*Edited\*\* `value`: Gives the approved number\. It needs nothing\. It gives back the number 2\. What changed: before, it gave back 1; now it gives back 2\.$/mu);
    assert.match(text, /^- \*\*New\*\* `doubled`: not described yet\.$/mu, 'the note with a link is withheld');
    assert.doesNotMatch(text, /example\.invalid/u);
    assert.match(text, /^- doubled reads value rather than its own number, so a later change to the value needs one edit\. \(Copilot's reason\)$/mu);
    assert.match(text, /^Removed: nothing\.$/mu);
    assert.match(text, /^\*\*Edited\*\* `test\/value\.test\.mjs` \(covers `CSP-1:AC-001`\)$/mu);
    assert.match(text, /^- Edited test "value", covers `CSP-1:AC-001`$/mu);
    assert.match(text, /^- New test "doubled", covers `CSP-1:AC-001`$/mu);
    assert.match(text, /^SFlow ran them on the delivered code \(Code version 1\): 2 passed\.$/mu, text);
    assert.doesNotMatch(text, /## 6\. Outside the plan/u);

    // The read prints the page SFlow wrote.
    const read = json(flow(root, ['explain', '--subject', 'change', '--page', '--json'])).data.page;
    assert.equal(read.status, 'written');
    assert.equal(read.path, `singularity/work-items/${W}/CHANGE-STORY.md`);
    assert.equal(read.summary, '1 file and 2 functions changed, 2 tests; SFlow\'s run: 2 passed.');
    assert.match(read.markdown, /^# What this change does: CSP-1/u);
    assert.match(flow(root, ['explain', '--subject', 'change', '--page']).stdout, /## 4\. What we changed/u);

    // Submitted and approved as before; the approval starts with the page's line and names the read.
    flow(root, ['submit', 'implementation']);
    const approval = json(flow(root, ['decisions', W, '--json'])).data.items.find((entry) => entry.kind === 'approval');
    assert.equal(approval.details.changeStory.summary, read.summary);
    assert.equal(approval.details.changeStory.path, read.path);
    assert.equal(approval.details.changeStory.command, `singularity-flow explain --subject change --page --work-id ${W}`);
    assert.match(approval.details.lines[0], /^What this change does: 1 file and 2 functions changed/u);
    assert.match(flow(root, ['decisions', W]).stdout, /What this change does: 1 file and 2 functions changed/u);
    flow(root, ['approve', 'implementation', '--yes']);
    const state = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
    assert.equal(state.phases.implementation.status, 'approved');
    assert.ok(state.phases.implementation.artifacts.some((entry) => entry.path.endsWith('artifacts/implementation/change-explanation.json')),
      'the notes are the code step\'s own output');

    // The task view's facts carry it, and the pull request's text.
    const status = json(flow(root, ['work', 'status', W, '--json']));
    assert.equal(status.changeStory.summary, read.summary);
    const body = json(flow(root, ['pr', 'describe', W, '--format', 'json'])).body;
    assert.match(body, /^### What this change does\n\n#### 1\. What we had to do$/mu);
    assert.match(body, /^- \*\*Edited\*\* `value`: Gives the approved number\./mu);

    // The testing step's publication writes it again from the latest records; nothing is left uncommitted.
    flow(root, ['prepare', 'testing']);
    const testing = path.join(item, state.phases.testing.requiredArtifact.path);
    await writeFile(testing, (await readFile(testing, 'utf8')).replace(/TODO:[^\n]*/gu, `Verified ${AC} against the committed passing receipt.`));
    flow(root, ['phase', 'publish', 'testing', '--authored', 'human', '--channel', 'manual-in-place']);
    const again = await readFile(page, 'utf8');
    assert.match(again, /^SFlow ran them on the delivered code \((?:Code|Testing) version 1\): 2 passed\.$/mu);
    assert.equal(git(root, 'status', '--porcelain', '--', `singularity/work-items/${W}`), '');
    flow(root, ['submit', 'testing']);
  });
