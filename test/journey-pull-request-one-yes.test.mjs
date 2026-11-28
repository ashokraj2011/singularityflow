/**
 * Journey: a closed Story to its pull request, counting what the person does [owner, 2026-11-28: no typed values, no second
 * confirmations]. On main before this, in their own terminal: `pr W` printed "Preview only. Re-run with --create", then `pr W
 * --create` asked "Type W to open the pull request": 2 commands and 1 typed value. In chat, /sf-pr had the person type the Work
 * ID. Now `pr W` shows the preview and asks one Yes that names the branches; /sf-pr asks that Yes with its question tool and runs
 * `pr W --create --yes`. Nothing is typed but the command itself, and nothing opens without the Yes.
 *
 * The Story walks a chore's four steps by their CLI commands, as base-branch-moves.test.mjs does; the remote is named as a GitHub
 * one and a stand-in `gh` on PATH records what it was asked, so nothing reaches the network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { TYPED_TERMINAL_AVAILABLE, typedInTerminal } from './helpers/typed-terminal.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const W = 'PRJ-1';
const URL_OPENED = 'https://github.com/example-org/ledger/pull/7';

let ghBin = null;
let ghLog = null;
const environment = () => ({ ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Journey Tester',
  SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'chore', agent: 'developer' }),
  ...(ghBin ? { PATH: `${ghBin}${path.delimiter}${process.env.PATH}`, SFLOW_FAKE_GH_LOG: ghLog } : {}) });
function execute(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: environment(), timeout: childTimeout(180_000) });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}
const flow = (cwd, args, options) => execute(process.execPath, [bin, ...args], cwd, options);
const git = (cwd, ...args) => execute('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], cwd).stdout.trim();

async function closedStory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-pr-journey-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(`${root}.git`, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Journey Tester');
  git(root, 'config', 'user.email', 'journey.tester@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Ledger\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.approvalSecurity = { profile: 'poc' };
  config.worldModel.grounding = 'off';
  config.repositoryReadiness = { ...config.repositoryReadiness, requiredBeforeStory: false };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'initial');
  git(root, 'init', '-q', '--bare', '-b', 'main', `${root}.git`);
  for (const [key, value] of [['maintenance.auto', 'false'], ['gc.auto', '0']]) git(`${root}.git`, 'config', key, value);
  git(root, 'remote', 'add', 'origin', `${root}.git`);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  flow(root, ['start', W, '--from-branch', 'main', '--title', 'Tidy the ledger', '--description', 'Maintenance only.']);
  for (const phaseId of ['intake', 'implementation', 'verification', 'conformance']) {
    if (phaseId !== 'intake') flow(root, ['prepare', phaseId]);
    const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items', W, 'workflow.json'), 'utf8'));
    const file = path.join(root, 'singularity/work-items', W, workflow.phases[phaseId].requiredArtifact.path);
    await writeFile(file, (await readFile(file, 'utf8'))
      .replace(/^\| `([^`]+:AC-\d{3})` \|.*$/gmu, '| `$1` | The ledger outcome holds | `README.md` | Checked by inspection in verification | matched | none |')
      .replace(/^TODO: Map each qualified acceptance[^\n]*$/mu, `${W}:AC-001 holds: README.md was inspected. Not applicable: a documentation outcome carries no test tags.`)
      .replace(/TODO:[^\n]*/g, 'Checked the ledger outcome with complete operational detail and exact references.')
      .replace(/\bTODO\b/g, 'checked'));
    flow(root, ['phase', 'publish', phaseId]);
    flow(root, ['submit']);
    const approved = flow(root, ['approve', '--yes'], { allowFailure: true });
    assert.equal(approved.status, 0, `${phaseId}\n${approved.stdout}\n${approved.stderr}`);
  }
  // The pull request opens on GitHub: the remote is named as one, and its stand-in CLI records each call.
  git(root, 'remote', 'set-url', 'origin', 'https://github.com/example-org/ledger.git');
  ghBin = path.join(root, '.journey-bin');
  ghLog = path.join(root, '.journey-gh.log');
  await mkdir(ghBin, { recursive: true });
  await writeFile(path.join(ghBin, 'gh'), `#!/bin/sh\necho "$@" >> "$SFLOW_FAKE_GH_LOG"\nif [ "$1 $2" = "pr create" ]; then echo "${URL_OPENED}"; fi\nexit 0\n`);
  await chmod(path.join(ghBin, 'gh'), 0o755);
  t.after(() => { ghBin = null; ghLog = null; });
  return root;
}

const opened = async () => (await readFile(ghLog, 'utf8').catch(() => '')).split('\n').filter((line) => line.startsWith('pr create'));

test('journey: a closed Story to its pull request is one command and one Yes in the person\'s terminal, and one Yes in chat; nothing typed, nothing opened without it', slowLane({ timeout: 900_000 }), async (t) => {
  const root = await closedStory(t);
  // Where no one can be asked (a script, a chat's shell), the preview opens nothing and names the one route that opens it.
  const preview = flow(root, ['pr', W]);
  assert.match(preview.stdout, new RegExp(`Preview only: nothing was opened\\. It opens on one Yes: singularity-flow pr ${W} --create`, 'u'));
  assert.doesNotMatch(preview.stdout + preview.stderr, /Re-run with --create|Type PRJ-1/u, 'no second command, no typed Work ID');
  assert.deepEqual(await opened(), [], 'nothing opened');

  // In chat: /sf-pr asks "Open a pull request from … into …?" with its question tool, and runs this after the Yes.
  const skill = await readFile(path.join(packageRoot, 'plugin/skills/sflow-pr/SKILL.md'), 'utf8');
  assert.match(skill, /ask once with your question tool \(ask_user; in VS Code, vscode_askQuestions\): "Open a pull request from <head> into <base>, titled "<title>"\?" \(Open it; Not now\)/u);
  assert.doesNotMatch(skill, /type the Work ID/iu);

  if (TYPED_TERMINAL_AVAILABLE) {
    // The person's own terminal: `pr W` shows the preview, then asks one Yes naming the branches. "n" opens nothing.
    const question = `Open this pull request from ${W} into main? [y/N] `;
    const declined = await typedInTerminal({ argv: [process.execPath, bin, 'pr', W], cwd: root, env: environment(), prompt: question, answer: 'n' });
    assert.equal(declined.status, 0, declined.output.slice(-2000));
    assert.match(declined.output, /Not opened; nothing changed\./u);
    assert.deepEqual(await opened(), [], 'nothing opened on No');
    const yes = await typedInTerminal({ argv: [process.execPath, bin, 'pr', W], cwd: root, env: environment(), prompt: question, answer: 'y' });
    assert.equal(yes.status, 0, yes.output.slice(-2000));
    assert.match(yes.output, new RegExp(`--- title ---[\\s\\S]*Open this pull request from ${W} into main\\? \\[y/N\\][\\s\\S]*Opened ${URL_OPENED.replaceAll('/', '\\/')}`, 'u'),
      'the preview first, then the one Yes, then the pull request');
    assert.deepEqual((await opened()).length, 1);
  }
  // What /sf-pr runs after the person's Yes in chat opens it too; an existing one is never opened twice.
  const fromChat = flow(root, ['pr', W, '--create', '--yes']);
  assert.match(fromChat.stdout, /Opened https:\/\/github\.com\/example-org\/ledger\/pull\/7|A pull request already exists/u);
  // The person, then: in their terminal 2 commands and 1 typed value (the Work ID); in chat 1 typed value. Now: 1 command and
  // 1 Yes in their terminal (the pty walk above), 1 answer in chat, and nothing typed in either.
});
