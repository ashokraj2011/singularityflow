/**
 * Per-command help.
 *
 * The load-bearing test here is the first one. `--help` was parsed into options and then ignored,
 * and because unknown options are accepted silently the command simply ran — so asking a governance
 * tool what `approve` does would have attempted an approval.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { allCommands, documentedCommands, renderCommandHelp, synopsisFor } from '../src/help-pages.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function sflow(args, cwd) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
}

test('--help describes a mutating command instead of running it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-help-'));
  t.after(() => spawnSync('rm', ['-rf', root]));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Help Tester'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'help@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# help fixture\n');
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  const before = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();

  for (const command of ['approve', 'submit', 'cancel', 'start']) {
    const result = sflow([command, '--help'], root);
    assert.equal(result.status, 0, `${command} --help exits cleanly`);
    assert.match(result.stdout, new RegExp(`^NAME\\n {4}singularity-flow ${command}`), `${command} --help renders a page`);
    assert.match(result.stdout, /\nSYNOPSIS\n/, `${command} --help has a synopsis`);
  }

  assert.equal(
    spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), before,
    'no command ran while its help was requested'
  );
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout, '',
    'requesting help changed nothing on disk');
});

test('every dispatched command publishes a synopsis', () => {
  // Both directions of the drift that produced this file: `cockpit`, `logs`, `hook` and `reset-all`
  // all dispatched while missing from the overview.
  const missing = allCommands().filter((command) => synopsisFor(command).length === 0);
  assert.deepEqual(missing, [], 'commands dispatch but publish no usage synopsis');
});

test('every command has a complete current reference page', () => {
  assert.deepEqual(documentedCommands().sort(), allCommands().sort());
  for (const command of allCommands()) {
    const page = renderCommandHelp(command);
    assert.match(page, /^NAME\n/);
    assert.match(page, /\nSYNOPSIS\n/);
    assert.match(page, /\nDESCRIPTION\n/);
    assert.match(page, /\nOPTIONS\n/);
    assert.match(page, /\nEXAMPLES\n/);
    assert.match(page, /\nCOPILOT\n/);
    assert.match(page, /\nSEE ALSO\n/);
    assert.doesNotMatch(page, /No detailed page has been written/, command);
  }
});

test('an authored page carries description, examples and related commands', () => {
  const page = renderCommandHelp('start');
  assert.match(page, /Begin governed work on a Story/);
  assert.match(page, /\nDESCRIPTION\n/);
  assert.match(page, /\nOPTIONS\n/);
  assert.match(page, /\nEXAMPLES\n/);
  assert.match(page, /\$ singularity-flow start PAY-1 --work-type feature/);
  assert.match(page, /\nSEE ALSO\n/);
});

test('process help describes the installed parallel adapters and operational inspection surface', () => {
  const page = renderCommandHelp('process');
  assert.match(page, /process list \[--json\]/);
  assert.match(page, /process fsck <PROCESS-ID> \[--json\]/);
  assert.match(page, /process stop <PROCESS-ID> \[--expected-revision N\] \[--json\]/);
  assert.match(page, /For process step, run, pause, stop, or resume, compare-and-swap/);
  assert.match(page, /one bounded deterministic parallel wave/);
  assert.match(page, /`deterministic-translator` AGENT/);
  assert.match(page, /proposal-only `copilot-cli` AGENT/);
  assert.match(page, /Copilot is allowed only with `--allow-model`/);
  assert.match(page, /immutable proposal evidence/);
  assert.match(page, /explicit independent VERIFY gate/);
  assert.match(page, /read-only `filesystem-read` DEVICE/);
  assert.match(page, /consequential proof Device/);
  assert.match(page, /`sandbox-cas`/);
  assert.match(page, /Tool Intent is durable/);
  assert.match(page, /recovery verifies the exact postcondition without replaying it/);
  assert.match(page, /reports quiescence only after every exact attempt and its owner lease have settled/);
  assert.doesNotMatch(page, /tasks sequentially|Agent and device opcodes stop/);
});

test('task help distinguishes read-only inspection from confirmation-bound retry', () => {
  const page = renderCommandHelp('task');
  assert.match(page, /`task list`, `task show`, and `task evidence` are projection-only/);
  assert.match(page, /`task retry` is a mutation with a two-step boundary/);
  assert.match(page, /task retry PROC-\.\.\. failed-task --confirm sha256:/);
  assert.match(page, /Stale state, exhausted attempts, and unsafe effects are refused/);
});

test('Intent and Program help expose exact authoring and configuration-review ceremonies', () => {
  const intent = renderCommandHelp('intent');
  assert.match(intent, /intent packet <ENVELOPE> --answers <FILE>/);
  assert.match(intent, /intent confirm <ENVELOPE> --answers <FILE> --confirm <PACKET-SHA256>/);
  assert.match(intent, /intent workflow <INTENT-IR> --policy <FILE> --declaration <FILE>/);
  assert.match(intent, /intent ratification-packet <INTENT-IR>/);
  assert.match(intent, /intent ratify <INTENT-IR>/);
  assert.match(intent, /Every authoring transformation, validation, and compilation is deterministic and model-free/);

  const program = renderCommandHelp('program');
  assert.match(program, /program approve <FILE> \[--confirm <PROPOSAL-SHA256> --approved-at <RFC3339>\]/);
  assert.match(program, /normal review proposal based on `sflow\/config`/);
  assert.match(program, /does not change the selected application branch/);
});

test('policy help exposes read-only planning and exact confirmation-bound apply', () => {
  const page = renderCommandHelp('policy');
  assert.match(page, /policy plan --invalidate-process/);
  assert.match(page, /policy apply --expected-revision/);
  assert.match(page, /stale plan.*fails closed/s);
  assert.match(page, /refuses `process step` and `process run` before any mutation/);
});

test('learn help exposes only digest-bound descriptor missions and non-authoritative evaluation', () => {
  const page = renderCommandHelp('learn');
  assert.match(page, /learn start\|inspect <LESSON-ID>/);
  assert.match(page, /learn explain-change <LESSON-ID> <STEP-ID>/);
  assert.match(page, /learn quiz\|teach-back <LESSON-ID> <CHECK-ID>/);
  assert.match(page, /strict v1 learning-module JSON file/);
  assert.match(page, /never materializes or executes the fixture/);
  assert.match(page, /never.*invokes a model or tool/s);
  assert.match(page, /not semantic understanding or certification/);
});

test('the synopsis comes from the usage listing, not the worked example', () => {
  // `Typical flow:` at the end of the overview contains real invocations. Scanning the whole
  // document pulled one of them into `start`'s synopsis as though it were a distinct form.
  const synopsis = synopsisFor('start');
  assert.ok(synopsis.length > 0);
  assert.ok(!synopsis.includes('singularity-flow start ENG-142'), 'walkthrough steps are not synopsis lines');
});

test('help <command> and <command> --help render the same page', () => {
  const viaHelp = sflow(['help', 'ledger'], packageRoot);
  assert.equal(viaHelp.status, 0);
  assert.equal(viaHelp.stdout.trimEnd(), renderCommandHelp('ledger').trimEnd(), 'help <command> renders the command page');
});

test('an alias resolves to its canonical page', () => {
  assert.equal(renderCommandHelp('home'), renderCommandHelp('cockpit'));
  assert.match(renderCommandHelp('home'), /\nALIASES\n {4}cockpit/);
});
