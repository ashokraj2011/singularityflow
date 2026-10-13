/**
 * `configuration drafts | propose | discard | approve`: see the saved agent, skill and instruction
 * drafts, propose all of them as one review, drop some, and approve a proposal after reading what
 * it changes — without copying a commit.
 */
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import { SingularityFlowError } from '../util.mjs';

export const CONFIGURATION_DRAFT_SUBCOMMANDS = Object.freeze(['drafts', 'propose', 'discard', 'approve']);
const OPTIONS = Object.freeze({
  drafts: ['json'], propose: ['json', 'message', 'background-sync'], discard: ['json', 'all'], approve: ['json', 'yes']
});

function validate(subcommand, positionals, options) {
  for (const key of Object.keys(options)) {
    if (!OPTIONS[subcommand].includes(key)) {
      throw new SingularityFlowError(`configuration ${subcommand} does not take --${key}. It takes: ${OPTIONS[subcommand].map((name) => `--${name}`).join(', ')}.`,
        { code: 'CONFIGURATION_DRAFTS_OPTION_UNSUPPORTED' });
    }
  }
  const extra = { drafts: 2, propose: 2, discard: 3, approve: 3 }[subcommand];
  if (positionals.length > extra) {
    throw new SingularityFlowError(`configuration ${subcommand} takes ${extra === 2 ? 'no other words' : 'at most one more word'}: ${positionals.slice(extra).join(' ')}.`,
      { code: 'CONFIGURATION_DRAFTS_OPTION_UNSUPPORTED' });
  }
}

async function ask(question) {
  const io = readline.createInterface({ input, output });
  try { return await io.question(question); } finally { io.close(); }
}

export async function run({ subcommand, positionals, options, root, apply, printResult }) {
  validate(subcommand, positionals, options);
  const json = options.json === true;
  const drafts = await import('../configuration-drafts.mjs');
  if (subcommand === 'drafts') {
    const value = await drafts.readDrafts(root);
    if (json) {
      return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'configuration-drafts',
        drafts: value.changes.map((entry, index) => ({ number: index + 1, description: entry.description, addedAt: entry.addedAt, change: entry.change })),
        proposed: value.proposed }, null, 2));
    }
    return console.log(drafts.draftLines(value).join('\n'));
  }
  if (subcommand === 'propose') {
    const result = await drafts.proposeDrafts(root, { apply, message: typeof options.message === 'string' ? options.message : null });
    if (json) return console.log(JSON.stringify(result, null, 2));
    if (result?.reviewRequired) console.log(`Proposed ${result.drafts.included} draft${result.drafts.included === 1 ? '' : 's'} as one review.`);
    return printResult({ ...result, drafts: undefined }, { dryRun: false });
  }
  if (subcommand === 'discard') {
    const number = positionals[2] == null ? null : Number(positionals[2]);
    const result = await drafts.discardDrafts(root, { number, all: options.all === true });
    if (json) return console.log(JSON.stringify(result, null, 2));
    for (const line of result.removed) console.log(`Discarded: ${line}`);
    return console.log(`${result.pending} draft${result.pending === 1 ? '' : 's'} left.`);
  }
  const { activateWorkflowConfigurationProposal, inspectWorkflowConfigurationProposal, listWorkflowConfigurationProposals } = await import('../configuration-proposal.mjs');
  const result = await drafts.approveProposal(root, positionals[2] ?? null, {
    yes: options.yes === true, interactive: !json && Boolean(input.isTTY && output.isTTY), ask,
    print: json ? () => {} : (line) => console.log(line),
    list: (repository) => listWorkflowConfigurationProposals(repository),
    inspect: inspectWorkflowConfigurationProposal, activate: activateWorkflowConfigurationProposal
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  if (result.status === 'review-required' || result.status === 'activation-pending') process.exitCode = 2;
}
