/**
 * `configuration drafts | propose | discard | approve | reject`: see the saved agent, skill and
 * instruction drafts, propose all of them as one review, drop some, approve a proposal after reading
 * what it lands, and reject one with a reason or withdraw one's own.
 */
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import { SingularityFlowError } from '../util.mjs';

export const CONFIGURATION_DRAFT_SUBCOMMANDS = Object.freeze(['drafts', 'propose', 'discard', 'approve', 'reject']);
const OPTIONS = Object.freeze({
  drafts: ['json'], propose: ['json', 'message', 'background-sync'], discard: ['json', 'all', 'listing'], approve: ['json', 'yes', 'confirm', 'pick'], reject: ['json', 'yes', 'confirm', 'reason']
});

function validate(subcommand, positionals, options) {
  for (const key of Object.keys(options)) {
    if (!OPTIONS[subcommand].includes(key)) {
      throw new SingularityFlowError(`configuration ${subcommand} does not take --${key}. It takes: ${OPTIONS[subcommand].map((name) => `--${name}`).join(', ')}.`,
        { code: 'CONFIGURATION_DRAFTS_OPTION_UNSUPPORTED' });
    }
  }
  const extra = { drafts: 2, propose: 2, discard: 3, approve: 3, reject: 3 }[subcommand];
  if (positionals.length > extra) {
    throw new SingularityFlowError(`configuration ${subcommand} takes ${extra === 2 ? 'no other words' : 'at most one more word'}: ${positionals.slice(extra).join(' ')}.`,
      { code: 'CONFIGURATION_DRAFTS_OPTION_UNSUPPORTED' });
  }
}

async function ask(question) {
  const io = readline.createInterface({ input, output });
  try { return await io.question(question); } finally { io.close(); }
}

/**
 * `planner(work, { refreshAuthority })`: runs `work(plan, source)` in one read of the approved
 * configuration, where `plan(changeSet)` plans a Studio change set against it. Checking the drafts one
 * by one takes several plans; with `refreshAuthority: false` it reads only what this machine holds.
 */
export function approvedConfigurationPlanner(root) {
  return async (work, { refreshAuthority = true } = {}) => {
    const [{ withApprovedConfigurationRead }, { planStudioChangeSet }] = await Promise.all([
      import('../approved-configuration-reader.mjs'), import('../workflow-studio.mjs')]);
    return withApprovedConfigurationRead(root, (source) => work((set) => planStudioChangeSet(root, set), source),
      { preferAuthority: true, refreshAuthority });
  };
}

/**
 * How each draft stands against the approved configuration, read as `skill list` reads it, or null
 * when there is none or it cannot be read (the list is shown all the same).
 */
async function currentStandings(root, drafts, module) {
  if (!drafts.changes.length) return null;
  return approvedConfigurationPlanner(root)((plan, source) => (source?.kind === 'working-tree' ? null : module.draftStandings(drafts.changes, plan)))
    .catch(() => null);
}

export async function run({ subcommand, positionals, options, root, apply, printResult }) {
  validate(subcommand, positionals, options);
  const json = options.json === true;
  const drafts = await import('../configuration-drafts.mjs');
  if (subcommand === 'drafts') {
    const value = await drafts.readDrafts(root);
    const standings = await currentStandings(root, value, drafts);
    const standing = new Map((standings ?? []).map((entry) => [entry.draftId, entry]));
    if (json) {
      return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'configuration-drafts', listing: value.listing,
        drafts: value.changes.map((entry, index) => ({ number: index + 1, draftId: entry.draftId, state: entry.state, description: entry.description,
          addedAt: entry.addedAt, operationId: entry.operationId, checkedAgainst: entry.checkedAgainst, change: entry.change,
          standing: standing.get(entry.draftId)?.standing ?? null, ...(standing.get(entry.draftId)?.problem ? { problem: standing.get(entry.draftId).problem } : {}) })),
        proposed: value.proposed }, null, 2));
    }
    const upload = value.proposed?.upload?.intentId
      ? await import('../transport-intents.mjs').then(({ readTransportIntent }) => readTransportIntent(value.proposed.upload.intentId)).catch(() => null) : null;
    return console.log(drafts.draftLines(value, standings, { uploadFinished: upload?.status === 'succeeded' }).join('\n'));
  }
  if (subcommand === 'propose') {
    const result = await drafts.proposeDrafts(root, { apply, planner: approvedConfigurationPlanner(root),
      message: typeof options.message === 'string' ? options.message : null });
    if (json) return console.log(JSON.stringify(result, null, 2));
    for (const line of result?.drafts?.settled ?? []) console.log(`Already approved, no longer waiting: ${line}`);
    if (result?.drafts?.nothingToPropose) {
      const left = result.drafts.pending;
      return console.log(`Nothing to propose: the approved configuration already has these changes. ${left ? `${left} draft${left === 1 ? '' : 's'} still waiting: singularity-flow configuration drafts` : 'No drafts are waiting.'}`);
    }
    if (result?.reviewRequired) console.log(`Proposed ${result.drafts.included} draft${result.drafts.included === 1 ? '' : 's'} as one review.`);
    return printResult({ ...result, drafts: undefined }, { dryRun: false });
  }
  if (subcommand === 'discard') {
    // A number is a place in the list `configuration drafts` showed; --listing names that list, so a
    // list that changed since is refused rather than dropping a different draft. A draft ID is exact.
    const target = positionals[2] ?? null;
    const byId = target != null && drafts.DRAFT_ID.test(target);
    if (options.listing !== undefined && typeof options.listing !== 'string') {
      throw new SingularityFlowError('--listing takes the listing shown by singularity-flow configuration drafts.', { code: 'CONFIGURATION_DRAFTS_OPTION_UNSUPPORTED' });
    }
    const result = await drafts.discardDrafts(root, { ids: byId ? [target] : [], number: target == null || byId ? null : Number(target),
      listing: options.listing ?? null, all: options.all === true });
    if (json) return console.log(JSON.stringify(result, null, 2));
    for (const line of result.removed) console.log(`Discarded: ${line}`);
    return console.log(`${result.pending} draft${result.pending === 1 ? '' : 's'} left.`);
  }
  const { activateWorkflowConfigurationProposal, configurationProposalCommitStatus, inspectWorkflowConfigurationProposal,
    listWorkflowConfigurationProposals, finishInterruptedApproval, removeRejectedConfigurationProposal } = await import('../configuration-proposal.mjs');
  if (subcommand === 'reject') {
    // Reject with a reason, or withdraw one's own proposal [SCF:REQ-009].
    const [{ optionString }, { configurationCommitIdentity }, { publishConfigurationRejection, configurationRejectionRecord }, { agentStarted }] = await Promise.all([
      import('../util.mjs'), import('../git.mjs'), import('../configuration-rejection.mjs'), import('../presence/person-records.mjs')]);
    const result = await drafts.rejectProposal(root, positionals[2] ?? null, {
      yes: options.yes === true, confirm: optionString(options, 'confirm', null), reason: optionString(options, 'reason', null),
      interactive: !json && Boolean(input.isTTY && output.isTTY), ask, print: json ? () => {} : (line) => console.log(line),
      inspect: inspectWorkflowConfigurationProposal, remove: removeRejectedConfigurationProposal,
      identity: (repository) => configurationCommitIdentity(repository),
      record: (repository, fields) => publishConfigurationRejection(repository, configurationRejectionRecord(fields)),
      agent: () => agentStarted()
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    return;
  }
  const [{ optionString, optionStrings }, { configurationPicks }, { configurationCommitIdentity }] = await Promise.all([
    import('../util.mjs'), import('../configuration-state-git.mjs'), import('../git.mjs')]);
  // A pick keeps one of the two values of a field both the proposal and sflow/config changed [SCF:REQ-007].
  const choices = configurationPicks(optionStrings(options, 'pick'));
  const result = await drafts.approveProposal(root, positionals[2] ?? null, {
    yes: options.yes === true, confirm: optionString(options, 'confirm', null), choices,
    interactive: !json && Boolean(input.isTTY && output.isTTY), ask,
    print: json ? () => {} : (line) => console.log(line),
    list: (repository) => listWorkflowConfigurationProposals(repository),
    inspect: inspectWorkflowConfigurationProposal, activate: activateWorkflowConfigurationProposal,
    finish: (repository, branch) => finishInterruptedApproval(repository, branch),
    identity: (repository) => configurationCommitIdentity(repository),
    // A recorded proposal that is gone: did its exact commit reach sflow/config, and is its upload still to finish?
    status: (repository, branch, commit) => configurationProposalCommitStatus(repository, branch, commit),
    upload: (intentId) => import('../transport-intents.mjs').then(({ readTransportIntent }) => readTransportIntent(intentId))
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  if (result.status === 'review-required' || result.status === 'activation-pending') process.exitCode = 2;
}
