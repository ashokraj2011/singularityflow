import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TRP_TERMINAL_AVAILABLE } from './test-recovery-terminal.fixture.mjs';

async function confirmation(t, answers, { terminal = true, json = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-terminal-confirm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const argv of [['init', '-q'], ['config', 'user.name', 'Terminal Reviewer'],
    ['config', 'user.email', 'terminal@example.test']]) execFileSync('git', argv, { cwd: root });
  const code = `
    import {captureTerminalActionAuthorization,consumeActionAuthorization} from ${JSON.stringify(new URL('../src/action-authorization.mjs', import.meta.url).href)};
    import {withCliJsonOutput} from ${JSON.stringify(new URL('../src/cli-json-output.mjs', import.meta.url).href)};
    const root=${JSON.stringify(root)};
    const plan={planId:'plan-1',planHash:'sha256:'+'a'.repeat(64),subject:{kind:'story',id:'TERM-1'},revision:1};
    const action={actionId:'adopt-TCA-001',confirmation:{required:true}};
    await withCliJsonOutput(${json}, async () => { try {
      const record=await captureTerminalActionAuthorization(root,plan,action,{label:'Amend test command'});
      if(record) await consumeActionAuthorization(root,record.token,plan,action,{requireTerminalPresentation:true});
      console.log('TERMINAL_CONFIRM_RESULT:'+JSON.stringify({confirmed:!!record}));
    } catch(error) {console.log('TERMINAL_CONFIRM_RESULT:'+JSON.stringify({code:error.code}));} });
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  // Real PTY interaction, not a production answer/stream injection seam.
  const script = `
    set timeout 15
    set answers [list ${answers.map(answer => JSON.stringify(answer)).join(' ')}]
    set index 0
    spawn -noecho $env(SF_CONFIRM_NODE) --input-type=module -e $env(SF_CONFIRM_CODE)
    expect {
      "Type Amend test command to confirm this exact action, or Enter to cancel:" {
        if {$index >= [llength $answers]} {exit 125}
        send -- "[lindex $answers $index]\\r"
        incr index
        exp_continue
      }
      timeout {exit 124}
      eof {}
    }
    catch wait result
    exit [lindex $result 3]
  `;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(terminal ? '/usr/bin/expect' : process.execPath,
      terminal ? ['-c', script] : ['--input-type=module', '-e', code], { cwd: root,
        env: { ...env, SF_CONFIRM_NODE: process.execPath, SF_CONFIRM_CODE: code }, stdio: ['pipe', 'pipe', 'pipe'] });
    let transcript = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Confirmation timed out: ${transcript}`)); }, 20000);
    child.stdout.on('data', bytes => { transcript += bytes; });
    child.stderr.on('data', bytes => { transcript += bytes; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); status === 0 ? resolve(transcript) : reject(new Error(transcript)); });
  });
  const match = output.match(/TERMINAL_CONFIRM_RESULT:(\{[^\r\n]+\})/u);
  assert.ok(match, output);
  return { output, result: JSON.parse(match[1]) };
}

test('terminal confirmation accepts surrounding whitespace without weakening live consent',
  { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
    assert.deepEqual((await confirmation(t, ['  Amend test command  '])).result, { confirmed: true });
  });

test('terminal confirmation explains a mismatch and permits an exact corrected answer',
  { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
    const { output, result } = await confirmation(t, ['amend test command', 'Amend test command']);
    assert.deepEqual(result, { confirmed: true });
    assert.match(output, /Confirmation did not match\. Type exactly: Amend test command\./);
  });

test('JSON output buffering cannot hide a live review card or its confirmation prompt',
  { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
    const { output, result } = await confirmation(t, ['  Amend test command  '], { json: true });
    assert.deepEqual(result, { confirmed: true });
    assert.match(output, /"planId": "plan-1"/);
    assert.match(output, /Type Amend test command to confirm this exact action/);
  });

test('Enter, a case mismatch then Enter, and three mismatches never authorize',
  { skip: !TRP_TERMINAL_AVAILABLE }, async t => {
    for (const answers of [[''], ['amend test command', ''], ['yes', 'yes', 'yes']]) {
      const { result } = await confirmation(t, answers);
      assert.deepEqual(result, { confirmed: false });
    }
  });

test('non-terminal invocation cannot acquire a live terminal authorization', async t => {
  assert.deepEqual((await confirmation(t, [], { terminal: false })).result,
    { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
});
