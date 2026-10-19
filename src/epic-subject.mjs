/**
 * The Epic an `epic requirements|planning <action>` command acts on.
 *
 * `--epic` names the subject. It used to choose only which Epic was loaded and checked: prepare,
 * publish and approve were then handed to the Initiative commands without it, and those resolve
 * their subject from `--initiative` or the current branch. On another Epic's branch,
 * `epic planning approve --epic A` approved the branch's Epic, whatever its phase.
 *
 * The Initiative commands record a change on the Epic's own branch and refuse anywhere else, so the
 * named Epic can only be acted on from that branch. A command that would change it from somewhere
 * else is refused here, before an agent is activated or a confirmation is asked for, and is never
 * redirected to whichever Epic the checkout happens to be on.
 */
import { branch } from './git-execution.mjs';
import { loadInitiativeAggregate } from './state-stores.mjs';
import { SingularityFlowError, optionString } from './util.mjs';

/** Actions that record a change on the Epic's branch. `status` and `validate` only read. */
const CHANGING_ACTIONS = new Set(['prepare', 'publish', 'approve']);

export async function resolveEpicSubject(root, options, { action, phaseId }) {
  const named = optionString(options, 'epic');
  const current = branch(root);
  const initiativeId = named ?? current;
  let loaded;
  try {
    loaded = await loadInitiativeAggregate(root, initiativeId);
  } catch (error) {
    if (error?.code !== 'INITIATIVE_NOT_FOUND') throw error;
    throw new SingularityFlowError(
      `No Epic '${initiativeId}' is recorded in this checkout (branch ${current}), so nothing was changed. `
      + `If it was started on its own branch, switch to it with \`singularity-flow initiative resume ${initiativeId} --fetch\`; `
      + 'otherwise check the ID with `singularity-flow initiative list`.',
      { code: 'EPIC_NOT_FOUND', cause: error, details: {
        workId: initiativeId, phase: phaseId, operation: `epic ${action}`,
        actions: [
          { command: 'singularity-flow initiative list', label: 'List the Epics recorded in this checkout.' },
          { command: `singularity-flow initiative resume ${initiativeId} --fetch`, label: 'Switch to the Epic\'s own branch if it has one.' }
        ]
      } }
    );
  }
  const epicBranch = loaded.initiative.initiative.branch;
  const onEpicBranch = epicBranch === current;
  if (!onEpicBranch && CHANGING_ACTIONS.has(action)) {
    throw new SingularityFlowError(
      `Epic '${initiativeId}' is recorded on branch ${epicBranch}, but this checkout is on ${current}. `
      + `${action} records the change on the Epic's own branch, so it was refused here and nothing was changed`
      + `${named ? `; no other Epic was ${action === 'approve' ? 'approved' : 'touched'} in its place` : ''}. `
      + `Switch with \`singularity-flow initiative resume ${initiativeId}\`, then run it again.`,
      { code: 'EPIC_BRANCH_MISMATCH', details: {
        workId: initiativeId, phase: phaseId, operation: `epic ${action}`,
        nextAction: { command: `singularity-flow initiative resume ${initiativeId}`, label: `Switch this checkout to ${epicBranch}, then run the command again.` }
      } }
    );
  }
  return { initiativeId, loaded, onEpicBranch };
}
