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
