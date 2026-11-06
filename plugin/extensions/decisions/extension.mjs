import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { joinSession } from '@github/copilot-sdk/extension';
import { runDecisions } from './decisions.mjs';

const executeFile = promisify(execFile);
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
let session;

async function workingDirectory() {
  const snapshot = await session.rpc.metadata.snapshot();
  if (typeof snapshot?.workingDirectory === 'string' && snapshot.workingDirectory.trim()) return snapshot.workingDirectory.trim();
  throw new Error('No repository working directory is attached to this Copilot session.');
}

async function runFlow(args) {
  const executable = process.env.SINGULARITY_FLOW_BIN || 'singularity-flow';
  try {
    const { stdout } = await executeFile(executable, args, { cwd: await workingDirectory(), encoding: 'utf8', timeout: 120000, maxBuffer: 12 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error("The 'singularity-flow' executable is not on PATH.");
    throw new Error(String(error?.stderr || error?.stdout || error?.message || error).trim());
  }
}

/** The answers reach the CLI in a private file that is gone once it has run. */
async function record(list, answers) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-adjudication-'));
  const file = path.join(directory, 'answers.json');
  try {
    await writeFile(file, JSON.stringify({ answers }), { mode: 0o600, flag: 'wx' });
    return await runFlow(['story', 'adjudicate', '--answers', file, '--expect', list.digest, '--work-id', list.workId]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const decide = (workId) => runDecisions({
  read: () => runFlow(['story', 'adjudications', ...(workId ? ['--work-id', workId] : []), '--json']),
  ask: (form) => session.ui.elicitation(form),
  show: (text) => session.log(text),
  record
});

session = await joinSession({
  commands: [{
    name: 'adjudicate',
    description: 'Decide every Singularity Flow convergence item as one table: accept all with one reason, or decide each.',
    handler: async (context) => {
      const [workId] = String(context?.args ?? '').trim().split(/\s+/u).filter(Boolean);
      if (workId && !WORK_ID.test(workId)) return void await session.log('Usage: /adjudicate [WORK-ID]');
      try { await session.log((await decide(workId)).message); }
      catch (error) { await session.log(`Nothing was recorded. ${error.message}`); }
    }
  }],
  tools: [{
    name: 'sflow_adjudicate',
    description: 'Show the person every convergence item for a Story as one table and let them decide all of them. Pass only the exact workId. The person answers and confirms; no answer, reason or selection comes from you. It returns what was recorded and what remains.',
    parameters: { type: 'object', additionalProperties: false, required: ['workId'], properties: { workId: { type: 'string', pattern: WORK_ID.source } } },
    handler: async (input) => {
      // No form here (an older Copilot, or a host without forms) is not a refusal: the skill asks in chat instead.
      if (!session.capabilities?.ui?.elicitation) return JSON.stringify({ status: 'unavailable', recorded: null, message: 'This Copilot cannot show the form. Ask in chat instead.' });
      if (Object.keys(input ?? {}).some((key) => key !== 'workId') || !WORK_ID.test(String(input?.workId ?? ''))) {
        return JSON.stringify({ status: 'blocked', recorded: null, message: 'This takes only a Story ID. Answers and reasons come from the person.' });
      }
      try { return JSON.stringify(await decide(input.workId)); }
      catch (error) { return JSON.stringify({ status: 'unavailable', recorded: null, message: `Nothing was recorded. ${error.message}` }); }
    }
  }]
});
