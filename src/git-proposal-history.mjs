/**
 * A configuration proposal's own history against `sflow/config` [SCF:REQ-005].
 *
 * A proposal's change is everything between its merge base with `sflow/config` and its tip, however
 * many commits it has, and whether or not the Git host merged `sflow/config` into it ("Update
 * branch"). The tip's first parent is not its base: with a second commit it is the proposal's own
 * earlier commit, and after a host merge it holds the merged-in configuration as the proposal's own
 * change (docs/SPEC-SIMPLE-CONFIGURATION-v1.md, finding ER-F1).
 *
 * The proposer is the author of the proposal's first own commit, walked along its first parents, so a
 * host merge or a reviewer's added commit does not make someone else the proposer.
 */
import { processResultCompleted, processResultSucceeded } from './process-result.mjs';
import { run, SingularityFlowError } from './util.mjs';

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const approveAgain = (branch) => `singularity-flow configuration approve ${branch ?? '<PROPOSAL>'}`;

function unavailable(what, result, branch) {
  throw new SingularityFlowError(`The configuration proposal's ${what} could not be read from Git. Nothing was changed; try again.`, {
    code: 'WORKFLOW_PROPOSAL_HISTORY_UNAVAILABLE',
    details: { exitCode: Number.isInteger(result?.status) ? result.status : null, timedOut: result?.timedOut === true,
      nextAction: { command: approveAgain(branch), label: 'Look at the proposal again' } }
  });
}

function exact(value, label) {
  if (!OBJECT_ID.test(String(value ?? ''))) {
    throw new SingularityFlowError(`A configuration proposal history read needs an exact ${label} commit.`, { code: 'GIT_OBJECT_ID_INVALID' });
  }
  return value;
}

/**
 * `{ mergeBase, merged, firstParent, proposer }` for `proposal` against `authority`, both exact
 * commits in `root`. `merged` says the proposal is already in `authority`'s history; `firstParent`
 * is read only then, to show what a merged proposal changed. `proposer` is `{ name, email }` or null.
 * A proposal sharing no history with `authority`, or merging it in at two unrelated places, is
 * refused: there is no single base to re-apply it from.
 */
export function readProposalHistory(root, authority, proposal, { env = process.env, branch = null } = {}) {
  exact(authority, 'authority'); exact(proposal, 'proposal');
  const bases = run('git', ['merge-base', '--all', authority, proposal], { cwd: root, env, allowFailure: true });
  const found = processResultSucceeded(bases) ? bases.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) : [];
  if (!processResultSucceeded(bases) && !(bases?.status === 1 && processResultCompleted(bases) && !bases.stderr)) unavailable('merge base', bases, branch);
  if (!found.length || found.some((commit) => !OBJECT_ID.test(commit))) {
    throw new SingularityFlowError(`Workflow proposal '${branch ?? proposal}' does not share history with 'sflow/config'.`, {
      code: 'WORKFLOW_PROPOSAL_HISTORY_INVALID',
      details: { nextAction: { command: 'singularity-flow workflow proposals', label: 'See what waits; make this change again from the current sflow/config' } }
    });
  }
  if (found.length > 1) {
    throw new SingularityFlowError(`Workflow proposal '${branch ?? proposal}' merges 'sflow/config' in at ${found.length} unrelated places, so it has no single base to apply from. `
      + 'Make the change again from the current sflow/config; nothing was changed.', {
      code: 'WORKFLOW_PROPOSAL_HISTORY_AMBIGUOUS', details: { mergeBases: found,
        nextAction: { command: 'singularity-flow workflow proposals', label: 'See what waits; make this change again from the current sflow/config' } }
    });
  }
  const [mergeBase] = found;
  const merged = mergeBase === proposal;
  let firstParent = null;
  if (merged) {
    const parent = run('git', ['rev-parse', '--verify', '--quiet', `${proposal}^1`], { cwd: root, env, allowFailure: true });
    firstParent = processResultSucceeded(parent) && OBJECT_ID.test(parent.stdout.trim()) ? parent.stdout.trim() : null;
  }
  let proposer = null;
  if (!merged) {
    const own = run('git', ['log', '--first-parent', '--no-merges', '--reverse', '--format=%an%x00%ae', `${mergeBase}..${proposal}`],
      { cwd: root, env, allowFailure: true });
    if (!processResultSucceeded(own)) unavailable('author', own, branch);
    const [name = '', email = ''] = (own.stdout.split(/\r?\n/u)[0] ?? '').split('\0');
    if (name.trim() && email.trim()) proposer = { name: name.trim(), email: email.trim() };
  }
  return { mergeBase, merged, firstParent, proposer };
}

/**
 * The author of one commit, as `{ name, email }`, or null when Git records none a person can be told apart by: a
 * proposal that shares no history with `sflow/config` (a setup proposal creating it) is proposed by its tip's author.
 */
export function readProposalAuthor(root, commit, { env = process.env, branch = null } = {}) {
  exact(commit, 'proposal');
  const shown = run('git', ['log', '-1', '--format=%an%x00%ae', commit], { cwd: root, env, allowFailure: true });
  if (!processResultSucceeded(shown)) unavailable('author', shown, branch);
  const [name = '', email = ''] = shown.stdout.trim().split('\0');
  return name.trim() && email.trim() ? { name: name.trim(), email: email.trim() } : null;
}
