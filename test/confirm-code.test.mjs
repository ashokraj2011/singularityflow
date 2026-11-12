/**
 * A person confirms a reviewed action by a short code, never its digest [owner, 2026-11-12: "build it"].
 *
 * The code is derived from the confirming command and kept on this machine with it (confirm-code.mjs). Typed after
 * /sf-confirm it binds the turn to that command's digest; the guard admits `confirm <CODE>` exactly as it admits the
 * command; the CLI runs that command. The document-step walk in requested-successor-document-cli.test.mjs confirms a
 * real draft 2 by its code; this file pins the code itself, its store and the refusals.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { confirmCode, confirmCodesIn, confirmCommandText, normalizeConfirmCode, rememberConfirmCommand, resolveConfirmCode,
  CONFIRM_CODE_MAX_AGE_MS } from '../src/confirm-code.mjs';
import { copilotCommandForCommand } from '../src/copilot-guidance.mjs';
import { confirmedTurn, recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const digest = (c) => `sha256:${c.repeat(64)}`;
// The person-text ratchet's hash shape (person-text-no-hashes.test.mjs): a code must never look like one.
const HEX_RUN = /(?<![0-9A-Za-z_])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,64}(?![0-9A-Za-z_])/giu;

async function codeStore(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-confirm-codes-'));
  const previous = process.env.SINGULARITY_FLOW_CONFIRM_CODES;
  process.env.SINGULARITY_FLOW_CONFIRM_CODES = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_CONFIRM_CODES;
    else process.env.SINGULARITY_FLOW_CONFIRM_CODES = previous;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('a code is eight characters derived from the command alone, and never reads like a hash', async (t) => {
  await codeStore(t);
  const command = `singularity-flow phase rollover planning --confirm ${digest('ab12')}`;
  const code = confirmCode(command);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u);
  assert.equal(confirmCode(`${command} --json`), code, '--json and --for-agent shape output, not the action');
  assert.equal(confirmCode(command.replace('singularity-flow', 'sflow')), code);
  assert.notEqual(confirmCode(command.replace('ab12', 'ab13')), code, 'another digest is another code');
  assert.equal(confirmCommandText(`sflow  decision plan W --confirm ${digest('d')} --for-agent --json`), `singularity-flow decision plan W --confirm ${digest('d')}`);
  for (let index = 0; index < 400; index += 1) assert.doesNotMatch(confirmCode(`${command} ${index}`), HEX_RUN);
  // Typed in any case, with Crockford's look-alikes, it is the same code.
  assert.equal(normalizeConfirmCode(code.toLowerCase()), code);
  assert.equal(normalizeConfirmCode('o1il-abcd'), '0111-ABCD');
  assert.equal(normalizeConfirmCode('K7Q2M8DX'), null, 'the dash is part of the code');
  assert.equal(normalizeConfirmCode('K7Q2-M8DU'), null, 'U is not in the alphabet');
  assert.deepEqual(confirmCodesIn(`/sf-confirm ${code.toLowerCase()} please`), [code]);
  assert.deepEqual(confirmCodesIn('/sf-confirm work-item and DATA-SETS'), ['DATA-SETS'], 'a word that only looks like one resolves to nothing');
});

test('the route a person types is the code, kept with the command it names; a tampered or old record names nothing', async (t) => {
  const store = await codeStore(t);
  const command = `singularity-flow decision plan W --confirm ${digest('c')} --json`;
  const route = copilotCommandForCommand(command);
  const code = confirmCode(command);
  assert.equal(route, `/sf-confirm ${code}`);
  assert.deepEqual(resolveConfirmCode(code.toLowerCase()), { code, command: confirmCommandText(command), value: digest('c') });
  const file = path.join(store, `${code}.json`);
  const kept = JSON.parse(await readFile(file, 'utf8'));
  // Another command under this code's name: the code derives from what is kept, so it names nothing.
  await writeFile(file, JSON.stringify({ ...kept, command: `singularity-flow approve planning --confirm ${digest('c')}` }));
  assert.equal(resolveConfirmCode(code), null);
  await writeFile(file, JSON.stringify(kept));
  assert.equal(resolveConfirmCode(code, { now: Date.parse(kept.recordedAt) + CONFIRM_CODE_MAX_AGE_MS + 1 }), null, 'a week on, a code is not looked up');
  assert.equal(resolveConfirmCode('ZZZZ-ZZZZ'), null);
  // A command that confirms nothing has no code.
  assert.equal(rememberConfirmCommand('singularity-flow submit planning --json'), null);
  // The prompt hook reads the code, case-folded, as the digest it stands for; two different ones bind nothing.
  assert.deepEqual(confirmedTurn(`/sf-confirm ${code.toLowerCase()}`), { digest: digest('c'), code });
  const second = rememberConfirmCommand(`singularity-flow decision plan W --confirm ${digest('e')}`);
  assert.equal(confirmedTurn(`/sf-confirm ${code} ${second}`), null);
  assert.deepEqual(confirmedTurn(`/sf-confirm decision plan W --confirm ${digest('c')}`), { digest: digest('c'), code: null }, 'an older route still binds');
});

test('confirm refuses a code this machine never gave, and anything but the code with --json or --for-agent', async (t) => {
  const store = await codeStore(t);
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sflow-confirm-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd, encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_CONFIRM_CODES: store } });
  const unknown = run('confirm', 'ZZZZ-ZZZZ', '--json');
  assert.notEqual(unknown.status, 0);
  const refusal = JSON.parse(unknown.stdout);
  assert.equal(refusal.error.code, 'CONFIRM_CODE_UNKNOWN', unknown.stdout);
  assert.match(refusal.error.message, /No confirmation is waiting under ZZZZ-ZZZZ on this machine.*Nothing was changed\. Preview the action again/u);
  const code = rememberConfirmCommand(`singularity-flow decision plan W --confirm ${digest('c')}`);
  for (const args of [['confirm', code, '--confirm', digest('d'), '--json'], ['confirm', '--json'], ['confirm', code, 'extra', '--json']]) {
    const misuse = run(...args);
    assert.notEqual(misuse.status, 0, args.join(' '));
    assert.equal(JSON.parse(misuse.stdout).error.code, 'CONFIRM_CODE_USAGE', args.join(' '));
  }
});

test('a /sf-confirm turn typed with a code admits that code only as it admits the command, never an approval', async (t) => {
  await codeStore(t);
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-confirm-guard-')));
  const root = path.join(directory, 'repository');
  await mkdir(root);
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '-q']); git(['config', 'user.name', 'Code Tester']); git(['config', 'user.email', 'code@example.test']);
  const phase = { id: 'custom-step', status: 'awaiting_approval', generation: 1, writeScope: 'artifact-only', generationPolicy: { task: 'document', requirement: 'required' } };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy'] } };
  const workflow = { workItem: { id: 'PMC-1' }, currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: {} };
  const file = path.join(root, definition.workItemRoot, 'PMC-1', 'workflow.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(workflow));
  git(['add', 'singularity']); git(['commit', '-qm', 'fixture']);
  const enter = async (prompt, sessionId) => {
    const payload = { cwd: root, sessionId, prompt };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => root, load: async () => ({ definition, workflow }) }) });
    return payload;
  };
  const shell = (payload, command) => mutationToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: root } });

  const rollover = `singularity-flow phase rollover custom-step --confirm ${digest('a')}`;
  const code = copilotCommandForCommand(rollover).split(' ')[1];
  const typed = await enter(`/sf-confirm ${code}`, 'code-confirmer');
  assert.deepEqual(await shell(typed, `singularity-flow confirm ${code} --for-agent --json`), {});
  assert.deepEqual(await shell(typed, `singularity-flow confirm ${code.toLowerCase()} --json`), {});
  assert.deepEqual(await shell(typed, rollover), {});
  // An approval is a person's own step: a code that names one is refused as the approval itself is.
  const approval = `singularity-flow approve custom-step --confirm ${digest('b')}`;
  const approvalCode = rememberConfirmCommand(approval);
  const approving = await enter(`/sf-confirm ${approvalCode}`, 'code-approver');
  assert.equal((await shell(approving, `singularity-flow confirm ${approvalCode} --json`)).permissionDecision, 'deny');
  assert.equal((await shell(approving, approval)).permissionDecision, 'deny');
  // A typed code that names nothing here binds nothing, and running it says so.
  const unknown = await enter('/sf-confirm ZZZZ-ZZZZ', 'code-unknown');
  const refused = await shell(unknown, 'singularity-flow confirm ZZZZ-ZZZZ --json');
  assert.equal(refused.permissionDecision, 'deny');
  assert.match(refused.permissionDecisionReason, /CONFIRM_CODE_UNKNOWN/u);
  assert.equal((await shell(unknown, rollover)).permissionDecision, 'deny', 'the turn runs nothing it was not given');
});
