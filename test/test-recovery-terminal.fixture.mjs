import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export const TRP_TERMINAL_AVAILABLE = process.platform !== 'win32' && existsSync('/usr/bin/expect');

/** Test harness using the real PTY ceremony; there is deliberately no consent injection API. */
export async function authorizeTrpRecord(root, workRoot, record, authority) {
  const code = `
    import {captureTerminalActionAuthorization} from ${JSON.stringify(new URL('../src/action-authorization.mjs', import.meta.url).href)};
    import {appendTrpAuthorityReceipt,appendTrpRecord,consumeTrpAuthority,trpAuthorityReview} from ${JSON.stringify(new URL('../src/test-recovery-store.mjs', import.meta.url).href)};
    const {root,workRoot,record,authority}=${JSON.stringify({ root, workRoot, record, authority })};
    try {
      const review=trpAuthorityReview(record,authority.policy);
      const grant=await captureTerminalActionAuthorization(root,review.plan,review.action,{label:'Confirm test review'});
      const witness=await consumeTrpAuthority(root,{record,...authority,review,token:grant.token});
      await appendTrpRecord(workRoot,record);
      const saved=await appendTrpAuthorityReceipt(workRoot,witness);
      console.log('TRP_TERMINAL_RESULT:'+JSON.stringify({ok:true,receipt:saved.receipt}));
    } catch(error) { console.log('TRP_TERMINAL_RESULT:'+JSON.stringify({ok:false,code:error.code,message:error.message,stack:error.stack})); }
  `;
  const script = `
    set timeout 25
    log_user 1
    spawn -noecho $env(SF_TRP_NODE) --input-type=module -e $env(SF_TRP_CODE)
    expect {
      "Type Confirm test review to confirm this exact action, or Enter to cancel:" { send -- "Confirm test review\\r" }
      timeout { exit 124 }
      eof { exit 125 }
    }
    expect eof
    catch wait result
    exit [lindex $result 3]
  `;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', script], { cwd: root,
      env: { ...environment, SF_TRP_NODE: process.execPath, SF_TRP_CODE: code }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let diagnostics = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`TRP PTY timed out: ${output.slice(-3000)}\n${diagnostics}`)); }, 30_000);
    child.stdout.on('data', (bytes) => { output += bytes; }); child.stderr.on('data', (bytes) => { diagnostics += bytes; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, output, diagnostics }); });
  });
  assert.equal(result.status, 0, `${result.output.slice(-3000)}\n${result.diagnostics}`);
  const matched = result.output.match(/TRP_TERMINAL_RESULT:(\{[^\r\n]+\})/u);
  assert.ok(matched, result.output.slice(-3000));
  const parsed = JSON.parse(matched[1]); assert.equal(parsed.ok, true, parsed.stack ?? parsed.message);
  return parsed.receipt;
}
