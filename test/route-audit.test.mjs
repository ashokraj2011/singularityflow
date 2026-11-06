/**
 * `scripts/route-audit.mjs` says what really followed each refusal in a host's session logs. It reads
 * logs and prints aggregates: a command argument, a path, a prompt or a reason never reaches its output.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyAftermath, refusalFromCompletion, routeKind, routeShape } from '../scripts/route-audit.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/route-audit.mjs', import.meta.url));
const refused = (code, callKey = 'a') => ({ refusal: { code, route: {} }, callKey, sflowWords: ['appeal', 'prepare'], isSflow: true, ok: false });
const worked = (words, isSflow = true) => ({ callKey: 'x', sflowWords: words, isSflow, ok: true });

test('what followed a refusal is named from the calls up to the person\'s next message', () => {
  const isMutation = (words) => words?.[0] === 'submit';
  const after = (...calls) => classifyAftermath([refused('X_CODE'), ...calls], 0, { skill: '/sf-recover', shell: 'singularity-flow recover --json' }, { isMutation });
  assert.equal(after().outcome, 'stopped');
  assert.equal(after(refused('X_CODE')).outcome, 'looped', 'the very same call again');
  const other = after(refused('X_CODE', 'b'));
  assert.deepEqual([other.outcome, other.recurred], ['stopped', true], 'the same code for another call is not a loop');
  const read = after(worked(['recover']));
  assert.deepEqual([read.outcome, read.routeTaken], ['readsOnly', true], 'a route that only reads moved nothing');
  assert.equal(after(worked(['submit'])).outcome, 'advanced');
  assert.equal(after(worked(['appeal', 'prepare'])).outcome, 'advanced', 'the refused command itself then worked');
  assert.equal(after(worked(null, false)).outcome, 'otherTools');
  const person = after({ person: true, slash: '/sf-recover' }, worked(['submit']));
  assert.deepEqual([person.outcome, person.routeTaken, person.personNext, person.sessionEnded], ['stopped', true, '/sf-recover', false],
    'the turn ends at the person\'s message, and the next turn is not counted for it');
});

test('a refusal is read from a guard denial, a refusal plan and an act block, and a passing command is not one', () => {
  const guard = refusalFromCompletion({ success: false, error: { message: 'Denied by preToolUse hook: PHASE_MUTATION_TOOL_PROTOCOL: no.\n\n- Copilot: /sf-code\n- Shell: singularity-flow prepare build' } }, { toolName: 'bash' });
  assert.deepEqual(guard, { kind: 'guard', code: 'PHASE_MUTATION_TOOL_PROTOCOL', route: { skill: '/sf-code', shell: 'singularity-flow prepare build' } });
  const prose = refusalFromCompletion({ success: false, error: { message: 'Denied by preToolUse hook: This explicit SFlow turn must not discover a repository by searching home.' } }, {});
  assert.equal(prose.code, 'GUARD_PROSE_REPOSITORY_SEARCH');
  const command = { toolName: 'bash', arguments: { command: 'singularity-flow appeal prepare --phase build' } };
  const plan = refusalFromCompletion({ success: true, shellExecution: { exitCode: 1 }, result: { content: JSON.stringify({ resultType: 'sflow-refusal-plan', status: 'failed', error: { code: 'PHASE_APPEAL_PATH_UNSUPPORTED' },
    remediationPlan: { steps: [{ command: 'singularity-flow recover --phase build --json', skill: '/sf-recover' }] } }) } }, command);
  assert.deepEqual(plan.route, { skill: '/sf-recover', shell: 'singularity-flow recover --phase build --json' });
  const act = refusalFromCompletion({ success: true, shellExecution: { exitCode: 1 }, result: { content: `progress\n${JSON.stringify({ act: { state: 'refused', said: 'PHASE_APPEAL_INVALID: no.', do: { copilot: '/sf-recover', shell: null } } })}\n<shellId: 4 completed with exit code 1>` } }, command);
  assert.equal(act.code, 'PHASE_APPEAL_INVALID');
  assert.equal(refusalFromCompletion({ success: true, shellExecution: { exitCode: 0 }, result: { content: '{"act":{"state":"author"}}' } }, command), null);
  assert.equal(refusalFromCompletion({ success: true, shellExecution: { exitCode: 1 }, result: { content: 'ls: no such file' } }, { toolName: 'bash', arguments: { command: 'ls' } }), null, 'not an SFlow command');
});

test('a route keeps only command words the registry knows', () => {
  const known = new Set(['recover', 'appeal', 'appeal prepare']);
  assert.equal(routeShape({ skill: '/sf-recover', shell: 'singularity-flow recover X --json' }, known), '/sf-recover');
  assert.equal(routeShape({ shell: 'singularity-flow appeal prepare --phase build' }, known), 'singularity-flow appeal prepare');
  assert.equal(routeShape({ shell: 'singularity-flow recover some-story-id' }, known), 'singularity-flow recover', 'an argument never passes');
  assert.equal(routeShape({ shell: 'singularity-flow some-story-id' }, known), 'singularity-flow (other)');
  assert.equal(routeKind('/sf-recover'), 'read-only');
  assert.equal(routeKind('/sf-code'), 'can-change');
  assert.equal(routeKind('(prose only)'), 'none');
});

test('the script reads the logs and prints aggregates with nothing from a session in them', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-route-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const session = path.join(directory, '11111111-aaaa-4bbb-8ccc-000000000001');
  await mkdir(session, { recursive: true });
  const SECRET_PATH = '/home/private-person/private-repo/secret-file.txt';
  const events = [
    { type: 'session.start', data: { startTime: '2026-11-01T00:00:00.000Z', context: { gitRoot: SECRET_PATH } } },
    { type: 'system.message', data: { content: 'You are an AI assistant using Copilot SDK in VS Code.' } },
    { type: 'user.message', data: { content: '/sf-code private prompt words' } },
    { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'bash', arguments: { command: `singularity-flow appeal prepare --add-supporting ${SECRET_PATH}=class --reason private-reason` } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, shellExecution: { exitCode: 1 }, result: { content: JSON.stringify({ resultType: 'sflow-refusal-plan', status: 'failed',
      error: { code: 'PHASE_APPEAL_PATH_UNSUPPORTED', message: `Cannot account for ${SECRET_PATH}` }, remediationPlan: { steps: [{ command: 'singularity-flow recover private-story --json', skill: '/sf-recover' }] } }) } } }
  ];
  await writeFile(path.join(session, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'));
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', SCRIPT, '--sessions', directory, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.refusals, 1);
  const [row] = report.table;
  assert.deepEqual([row.code, row.stopped, row.topRoute, row.topRouteKind, row.sessionEnded], ['PHASE_APPEAL_PATH_UNSUPPORTED', 1, '/sf-recover', 'read-only', 1]);
  assert.doesNotMatch(run.stdout, /private|secret|11111111/u);
});
