/**
 * Probe E: how this machine's Git treats SFlow's state checkout (SSB M0).
 *
 * In a temporary repository, never the person's: `/.sflow-state/` goes into the clone's info/exclude, a linked
 * worktree is made there on a detached HEAD the way story-state-ref.mjs makes it, and a record file is left in it.
 * Then the main checkout runs `git status`, `git stash -u`, `git clean -fdx` and `git clean -ffdx`, and after each
 * the probe looks whether `.sflow-state/` and its record are still there.
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check, PASS } from './report.mjs';

const IDENTITY = ['-c', 'user.name=SFlow office check', '-c', 'user.email=office-check@example.invalid', '-c', 'commit.gpgsign=false'];

export function stateCheckoutChecks(ctx) {
  const root = path.join(ctx.tempReal, 'state-checkout');
  const main = path.join(root, 'main');
  const state = path.join(main, '.sflow-state');
  const record = path.join(state, 'record.json');
  mkdirSync(main, { recursive: true });
  const tempGit = (args) => ctx.run.gitIn(main, [...IDENTITY, ...args], { env: ctx.env, timeoutMs: 30_000 });
  const steps = [
    tempGit(['init', '-q']),
    (writeFileSync(path.join(main, 'README.md'), 'office check\n'), tempGit(['add', 'README.md'])),
    tempGit(['commit', '-q', '-m', 'office check base'])
  ];
  if (steps.some((step) => !step.ok)) {
    return [check('state-setup', 'E', 'A state checkout in a temporary repository', 'not available', ['Git could not make the temporary repository.'], 'Nothing was learned here.')];
  }
  const common = tempGit(['rev-parse', '--git-common-dir']).stdout.trim();
  const exclude = path.join(path.resolve(main, common), 'info', 'exclude');
  mkdirSync(path.dirname(exclude), { recursive: true });
  appendFileSync(exclude, '\n# Singularity Flow: a Story\'s state checkout (.sflow-state), its own Git worktree; never commit it\n/.sflow-state/\n');
  const added = tempGit(['worktree', 'add', '--detach', '.sflow-state', 'HEAD']);
  if (!added.ok) {
    return [check('state-setup', 'E', 'A state checkout in a temporary repository', 'fail', [`git worktree add refused: ${added.stderr.split('\n')[0].slice(0, 200)}`],
      'SFlow cannot make its state checkout with this Git.')];
  }
  writeFileSync(record, '{"office-check":true}\n');
  const survives = () => existsSync(path.join(state, '.git')) && existsSync(record);
  const status = tempGit(['status', '--porcelain']);
  const listed = status.stdout.split(/\r?\n/u).some((line) => line.includes('.sflow-state'));
  const ignored = tempGit(['status', '--porcelain', '--ignored']).stdout.includes('.sflow-state');
  writeFileSync(path.join(main, 'scratch.txt'), 'untracked\n');
  const stash = tempGit(['stash', 'push', '-u', '-m', 'office check']);
  const afterStash = survives();
  const clean = tempGit(['clean', '-fdx']);
  const afterClean = survives();
  const force = tempGit(['clean', '-ffdx']);
  const afterForce = survives();
  const stale = afterForce ? null : tempGit(['worktree', 'list', '--porcelain']).stdout.includes('prunable');
  const checks = [
    check('state-status', 'E', '`git status` and the state checkout', listed ? 'fail' : 'pass',
      [listed ? '`git status` lists .sflow-state/.' : '`git status` does not list .sflow-state/.', ignored ? '`git status --ignored` shows it as ignored.' : '`git status --ignored` does not show it.'],
      listed ? 'Every change list here would show SFlow\'s records: the exclude line does not work with this Git.' : 'The state checkout stays out of every change list and `git add -A`.'),
    check('state-stash', 'E', '`git stash -u` and the state checkout', stash.ok && afterStash ? PASS : 'fail',
      [stash.ok ? '`git stash -u` ran.' : `\`git stash -u\` failed: ${stash.stderr.split('\n')[0].slice(0, 160)}`, afterStash ? '.sflow-state/ and its record survived.' : '.sflow-state/ or its record was removed.'],
      afterStash ? 'A person\'s stash never takes SFlow\'s state checkout with it.' : 'A stash here takes SFlow\'s state checkout: SFlow must rebuild it from the ref after one.'),
    check('state-clean', 'E', '`git clean -fdx` and the state checkout', clean.ok && afterClean ? PASS : 'fail',
      [clean.ok ? '`git clean -fdx` ran.' : `\`git clean -fdx\` failed: ${clean.stderr.split('\n')[0].slice(0, 160)}`, afterClean ? '.sflow-state/ and its record survived.' : '.sflow-state/ was removed.'],
      afterClean ? 'An ordinary clean keeps SFlow\'s state checkout.' : 'An ordinary clean removes SFlow\'s state checkout: work not yet on the state ref would be lost.'),
    check('state-force-clean', 'E', '`git clean -ffdx` and the state checkout', 'pass',
      [force.ok ? '`git clean -ffdx` ran.' : '`git clean -ffdx` failed.', afterForce ? '.sflow-state/ survived.' : `.sflow-state/ was removed${stale ? ' and Git still lists it as a worktree to prune' : ''}.`],
      afterForce ? 'Even a forced clean keeps the state checkout here.' : 'As expected, a forced clean removes it; SFlow makes it again from the state ref (only uncommitted records are lost).')
  ];
  return checks;
}
