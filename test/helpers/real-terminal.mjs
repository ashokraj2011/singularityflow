/**
 * A command in a real pty, driven as a person would: wait for its prompt, then type. Node has no pty of
 * its own, so a small Python bridge holds one and passes bytes both ways; no model and no host is
 * involved. `hasRealTerminal` is false where the bridge cannot run, and such a test skips.
 */
import { spawn, spawnSync } from 'node:child_process';

const BRIDGE = `
import os,pty,select,sys
pid,fd=pty.fork()
if pid==0:
    os.execvp(sys.argv[1],sys.argv[1:])
inputs=[fd,0]
while True:
    ready,_,_=select.select(inputs,[],[])
    if fd in ready:
        try: data=os.read(fd,65536)
        except OSError: break
        if not data: break
        os.write(1,data)
    if 0 in ready:
        data=os.read(0,65536)
        if data: os.write(fd,data)
        else: inputs=[fd]
_,status=os.waitpid(pid,0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

export const hasRealTerminal = process.platform !== 'win32' && spawnSync('python3', ['-V'], { stdio: 'ignore' }).status === 0;

/** What an agent's shell carries is exactly what a person's terminal does not. */
const asAPerson = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !['AI_AGENT', 'COPILOT_CLI'].includes(name)));

export function openRealTerminal(command, args, { cwd, env = process.env, keepAgentMarkers = false, timeout = 60_000 } = {}) {
  const child = spawn('python3', ['-I', '-c', BRIDGE, command, ...args], { cwd, env: { ...(keepAgentMarkers ? env : asAPerson(env)), TERM: 'dumb' }, stdio: ['pipe', 'pipe', 'inherit'] });
  let screen = '';
  let read = 0;
  let wake = () => {};
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (text) => { screen += text.replaceAll('\r\n', '\n'); wake(); });
  const closed = new Promise((resolve) => child.on('close', (status) => { resolve(status); wake(); }));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  closed.finally(() => clearTimeout(timer));
  return {
    get screen() { return screen; },
    /** Waits for words that came after the last answer, or fails naming what is on the screen. */
    async waitFor(pattern) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const match = pattern.exec(screen.slice(read));
        if (match) { read += match.index + match[0].length; return match; }
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`The terminal never showed ${pattern}. It shows:\n${screen}`);
        await Promise.race([new Promise((resolve) => { wake = resolve; }), new Promise((resolve) => setTimeout(resolve, 250))]);
      }
    },
    /** The number of a choice in the last list on the screen. */
    number(words) {
      const found = [...screen.matchAll(/^ {2}(\d+)\) (.*)$/gmu)].filter((match) => match[2].startsWith(words)).at(-1);
      if (!found) throw new Error(`No choice "${words}" on the terminal:\n${screen}`);
      return found[1];
    },
    type(line) { child.stdin.write(`${line}\n`); },
    /** Ctrl-D at the prompt: the input ended. */
    endInput() { child.stdin.write('\x04'); },
    finished: closed
  };
}
