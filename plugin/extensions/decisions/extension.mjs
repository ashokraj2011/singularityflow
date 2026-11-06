import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { joinSession } from '@github/copilot-sdk/extension';
import { runCard } from './card.mjs';
import { runDecisions } from './decisions.mjs';

const executeFile = promisify(execFile);
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
let session;

async function workingDirectory() {
  const snapshot = await session.rpc.metadata.snapshot();
  if (typeof snapshot?.workingDirectory === 'string' && snapshot.workingDirectory.trim()) return snapshot.workingDirectory.trim();
  throw new Error('No repository working directory is attached to this Copilot session.');
}

/** What the CLI refused, in its own words and with its code when its JSON says so. */
function refusalOf(failure) {
  const text = String(failure?.stderr || failure?.stdout || failure?.message || failure).trim();
  try {
    const refusal = JSON.parse(text).error;
    if (refusal?.message) return Object.assign(new Error(refusal.message), { code: refusal.code });
  } catch { /* Not JSON: the words as they are. */ }
  return new Error(text);
}

async function runFlow(args) {
  const executable = process.env.SINGULARITY_FLOW_BIN || 'singularity-flow';
  try {
    const { stdout } = await executeFile(executable, args, { cwd: await workingDirectory(), encoding: 'utf8', timeout: 120000, maxBuffer: 12 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error("The 'singularity-flow' executable is not on PATH.");
    throw refusalOf(error);
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

const adjudicate = (workId) => runDecisions({
  read: () => runFlow(['story', 'adjudications', ...(workId ? ['--work-id', workId] : []), '--json']),
  ask: (form) => session.ui.elicitation(form),
  show: (text) => session.log(text),
  record
});

async function recordCard(packet, answers) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-decide-'));
  const file = path.join(directory, 'answers.json');
  try {
    await writeFile(file, JSON.stringify(answers), { mode: 0o600, flag: 'wx' });
    return (await runFlow(['decisions', 'record', packet.workId, '--answers', file, '--json'])).data;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function recordWitness(packet, review, { file, reason, answers }) {
  const bytes = await readFile(path.resolve(packet.repositoryPath, file));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return (await runFlow(['decision', 'witness', '--work-id', packet.workId, '--criterion', review.clauseId, '--slot', review.slot, '--file', file, '--reason', reason,
    '--expected-context-sha256', review.contextBinding, '--expected-file-sha256', digest, ...answers.flatMap(([id, yes]) => [yes ? '--confirm' : '--deny', id]), '--json'])).data;
}

/** Puts the evidence in front of the person: the path always, and their own viewer when the machine has one. */
async function inspect(packet, file) {
  const absolute = path.resolve(packet.repositoryPath, file);
  await session.log(`Look at ${absolute}`);
  const opener = { darwin: 'open', linux: 'xdg-open' }[process.platform];
  if (opener) await executeFile(opener, [absolute], { timeout: 5000 }).catch(() => undefined);
}

const decide = (workId) => runCard({
  read: async () => (await runFlow(['decisions', ...(workId ? [workId] : []), '--json'])).data,
  ask: (form) => session.ui.elicitation(form),
  show: (text) => session.log(text),
  record: recordCard, witness: recordWitness, inspect
});

session = await joinSession({
  commands: [{
    name: 'decide',
    description: 'Decide everything a Singularity Flow step waits on as one table: one answer for all, or each with its own reason.',
    handler: async (context) => {
      const [workId] = String(context?.args ?? '').trim().split(/\s+/u).filter(Boolean);
      if (workId && !WORK_ID.test(workId)) return void await session.log('Usage: /decide [WORK-ID]');
      try { await session.log((await decide(workId)).message); }
      catch (error) { await session.log(`Nothing more was recorded. ${error.message}`); }
    }
  }, {
    name: 'adjudicate',
    description: 'Decide every Singularity Flow convergence item as one table: accept all with one reason, or decide each.',
    handler: async (context) => {
      const [workId] = String(context?.args ?? '').trim().split(/\s+/u).filter(Boolean);
      if (workId && !WORK_ID.test(workId)) return void await session.log('Usage: /adjudicate [WORK-ID]');
      try { await session.log((await adjudicate(workId)).message); }
      catch (error) { await session.log(`Nothing was recorded. ${error.message}`); }
    }
  }],
  tools: [{
    name: 'sflow_decide',
    description: 'Show the person everything a Story\'s step waits on as one table and let them decide all of it. Pass only the exact workId. The person answers and confirms; no answer, reason or selection comes from you. It returns what was recorded and what remains.',
    parameters: { type: 'object', additionalProperties: false, required: ['workId'], properties: { workId: { type: 'string', pattern: WORK_ID.source } } },
    handler: async (input) => {
      // No form here (an older Copilot, or a host without forms) is not a refusal: the skill asks in chat instead.
      if (!session.capabilities?.ui?.elicitation) return JSON.stringify({ status: 'unavailable', recorded: null, message: 'This Copilot cannot show the form. Ask in chat instead.' });
      if (Object.keys(input ?? {}).some((key) => key !== 'workId') || !WORK_ID.test(String(input?.workId ?? ''))) {
        return JSON.stringify({ status: 'blocked', recorded: null, message: 'This takes only a Story ID. Answers and reasons come from the person.' });
      }
      try { return JSON.stringify(await decide(input.workId)); }
      catch (error) { return JSON.stringify({ status: 'unavailable', recorded: null, message: `Nothing more was recorded. ${error.message}` }); }
    }
  }, {
    name: 'sflow_adjudicate',
    // Always listed: the skill calls it when it is available, and a tool loaded on demand does not look available.
    defer: 'never',
    description: 'Show the person every convergence item for a Story as one table and let them decide all of them. Pass only the exact workId. The person answers and confirms; no answer, reason or selection comes from you. It returns what was recorded and what remains.',
    parameters: { type: 'object', additionalProperties: false, required: ['workId'], properties: { workId: { type: 'string', pattern: WORK_ID.source } } },
    handler: async (input) => {
      // No form here (an older Copilot, or a host without forms) is not a refusal: the skill asks in chat instead.
      if (!session.capabilities?.ui?.elicitation) return JSON.stringify({ status: 'unavailable', recorded: null, message: 'This Copilot cannot show the form. Ask in chat instead.' });
      if (Object.keys(input ?? {}).some((key) => key !== 'workId') || !WORK_ID.test(String(input?.workId ?? ''))) {
        return JSON.stringify({ status: 'blocked', recorded: null, message: 'This takes only a Story ID. Answers and reasons come from the person.' });
      }
      try { return JSON.stringify(await adjudicate(input.workId)); }
      catch (error) { return JSON.stringify({ status: 'unavailable', recorded: null, message: `Nothing was recorded. ${error.message}` }); }
    }
  }]
});
