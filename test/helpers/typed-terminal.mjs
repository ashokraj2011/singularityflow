/**
 * Run a command in a real pseudo-terminal (expect) and type one answer at its prompt, as the person
 * does. Shipped code has no way to take that answer from the environment; this is the test's way in.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export const TYPED_TERMINAL_AVAILABLE = process.platform !== 'win32' && existsSync('/usr/bin/expect');

export async function typedInTerminal({ argv, cwd, env, prompt, answer, timeoutMs = 30_000 }) {
  const script = `
    set timeout ${Math.ceil(timeoutMs / 1000) - 5}
    log_user 1
    set command [list]
    for {set index 0} {[info exists env(SF_TYPED_ARG_$index)]} {incr index} { lappend command $env(SF_TYPED_ARG_$index) }
    spawn -noecho {*}$command
    expect {
      -exact $env(SF_TYPED_PROMPT) { send -- "$env(SF_TYPED_ANSWER)\\r" }
      timeout { exit 124 }
      eof { exit 125 }
    }
    expect eof
    catch wait result
    exit [lindex $result 3]
  `;
  const parent = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  const args = Object.fromEntries(argv.map((value, index) => [`SF_TYPED_ARG_${index}`, String(value)]));
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', script], { cwd,
      env: { ...parent, ...args, SF_TYPED_PROMPT: prompt, SF_TYPED_ANSWER: answer }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Typed terminal timed out: ${output.slice(-3000)}`)); }, timeoutMs);
    child.stdout.on('data', (bytes) => { output += bytes; });
    child.stderr.on('data', (bytes) => { output += bytes; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, output }); });
  });
}
