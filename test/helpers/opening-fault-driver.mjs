/**
 * Opens a step's previewed successor in its own process and stops it at one named point of the opening operation
 * (src/story-version-opening.mjs), as a crash or an interrupted reply would: `kill` ends the process there with SIGKILL,
 * `throw` raises an error there, and `race` lets another checkout open the same version there (the command in
 * OSA2_RACE_ARGV, as JSON, run in OSA2_RACE_CWD) before this one goes on. Used by test/osa-stage2-opening.test.mjs.
 *
 *   node opening-fault-driver.mjs <checkout> <step> <confirmation> <point> <kill|throw|race|none>
 *
 * The person's yes comes from their own terminal (no Copilot turn is bound in these tests), exactly as the command takes it.
 */
import { spawnSync } from 'node:child_process';

import { loadAcceptedStoryExecution } from '../../src/accepted-story-execution.mjs';
import { gitDirectories } from '../../src/story-version-acceptance.mjs';
import { readProposalRecord } from '../../src/story-version-consent.mjs';
import { codeOpening, openSuccessor, proposalNow } from '../../src/commands/phase-opening.mjs';

const [root, phaseId, confirmation, point, how] = process.argv.slice(2);
process.chdir(root);
const { definition, config, workflow } = await loadAcceptedStoryExecution(root);
const phase = workflow.phases[phaseId];
const record = await readProposalRecord(gitDirectories(root).commonDir, confirmation);
if (!record) throw new Error(`no preview kept for ${confirmation}`);
const proposed = await proposalNow(root, workflow, phase, { reason: record.proposal.reason, confirmation, adoption: record.proposal.adoption });
const fault = async (at) => {
  if (at !== point) return;
  if (how === 'kill') process.kill(process.pid, 'SIGKILL');
  if (how === 'throw') throw Object.assign(new Error(`fault injected at ${at}`), { code: 'TEST_FAULT' });
  if (how === 'race') {
    const other = spawnSync(process.execPath, JSON.parse(process.env.OSA2_RACE_ARGV), { cwd: process.env.OSA2_RACE_CWD, encoding: 'utf8', env: process.env });
    process.stderr.write(`race: the other checkout's opening exited ${other.status}\n${other.stdout.slice(-400)}\n`);
  }
};
try {
  const opened = await openSuccessor(root, definition ?? config, workflow, phase, { ...proposed, open: codeOpening(root, definition ?? config), fault });
  console.log(JSON.stringify({ ok: true, outcome: opened.outcome, replayed: opened.replayed }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code ?? null, message: String(error.message).slice(0, 2000), details: error.details ?? null }));
  process.exitCode = 1;
}
