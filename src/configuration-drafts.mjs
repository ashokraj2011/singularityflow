/**
 * Configuration drafts: agent, skill and instruction changes kept on this machine until they are
 * proposed together, so a batch of related changes gets one review and one approval.
 *
 * Without drafts every `skill create --propose` became its own proposal, and a change that depended
 * on another (attach the skill created a minute ago) could not be proposed until the first was
 * approved. A draft is checked against the approved configuration together with every earlier draft
 * when it is saved, is listed wherever skills and instructions are listed, and is used by nothing —
 * no Story, no prompt — until the one proposal holding all of them is approved. Drafts live in the
 * repository's Git directory, shared by its worktrees, and never in a commit.
 *
 * A repository with no approved configuration branch has nothing to approve: its working tree is
 * the configuration, so changes are written there exactly as before.
 */
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareSharedPublicationStorage, sharedPublicationStorageDirectory } from './publication-storage.mjs';
import { SingularityFlowError } from './util.mjs';

export const DRAFTS_SCHEMA = 'sflow-configuration-drafts@1';
const CHANGE_SET_SCHEMA = 'sflow-studio-change-set@1';
const DIRECTORY = 'configuration-drafts';
const MAXIMUM_DRAFTS = 200;
/** The changes people make one at a time from the CLI or Copilot. Imports and workflow edits keep their own routes. */
export const DRAFTABLE_OPERATIONS = Object.freeze(['skill.create', 'skill.update', 'skill.attach', 'skill.detach', 'skill.remove',
  'instruction.create', 'instruction.update', 'instruction.remove', 'agent.create', 'agent.update']);
const DRAFTABLE = new Set(DRAFTABLE_OPERATIONS);

const fail = (message, code, details = null) => { throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) }); };
const empty = () => ({ schema: DRAFTS_SCHEMA, changes: [], proposed: null });

export function draftsPath(root) {
  return path.join(sharedPublicationStorageDirectory(root, DIRECTORY), 'drafts.json');
}

/** The saved drafts, or none. A damaged file is refused rather than silently emptied. */
export async function readDrafts(root) {
  const file = draftsPath(root);
  const info = await lstat(file).catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)));
  if (!info) return empty();
  const damaged = () => fail(`The configuration drafts file cannot be read: ${file}. Move it aside to start again; nothing in it has been proposed.`,
    'CONFIGURATION_DRAFTS_INVALID');
  if (!info.isFile() || info.isSymbolicLink()) damaged();
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); } catch { damaged(); }
  if (value?.schema !== DRAFTS_SCHEMA || !Array.isArray(value.changes)
      || value.changes.some((entry) => !entry || typeof entry !== 'object' || !DRAFTABLE.has(entry.change?.op))) damaged();
  return { schema: DRAFTS_SCHEMA, changes: value.changes, proposed: value.proposed && typeof value.proposed === 'object' ? value.proposed : null };
}

async function writeDrafts(root, value) {
  const directory = await prepareSharedPublicationStorage(root, DIRECTORY, 'Configuration drafts');
  const file = path.join(directory, 'drafts.json');
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

const scope = (change) => (change.workflow ? `workflow ${change.workflow}` : `agent ${change.agent}`);

/** One plain line saying what a change does. */
export function describeChange(change) {
  const name = change.label ? `${change.label} (${change.id})` : change.id;
  switch (change.op) {
    case 'skill.create': return `New skill ${name}`;
    case 'skill.update': return `Edit skill ${change.id}`;
    case 'skill.remove': return `Remove skill ${change.id}`;
    case 'skill.attach': return `Attach skill ${change.skill} to ${scope(change)}${change.phases?.length ? ` in ${change.phases.join(', ')}` : ''}`;
    case 'skill.detach': return `Detach skill ${change.skill} from ${scope(change)}`;
    case 'instruction.create': return `New instruction ${name}`;
    case 'instruction.update': return `Edit instruction ${change.id}`;
    case 'instruction.remove': return `Remove instruction ${change.id}`;
    case 'agent.create': return `New agent ${name}`;
    case 'agent.update': return `Edit agent ${change.id}`;
    default: return String(change.op);
  }
}

/** What a draft or a batch of drafts adds, by kind and ID, for marking lists. */
export function draftedIds(drafts, kind) {
  const ids = new Map();
  for (const { change } of drafts.changes) {
    const [subject, action] = change.op.split('.');
    if (subject !== kind) continue;
    if (['create', 'update', 'remove'].includes(action)) ids.set(change.id, action);
  }
  return ids;
}

function batchIdentity(changes, subject, message) {
  if (changes.length === 1) return { subject, message };
  const lines = changes.map(describeChange);
  const summary = lines.join('; ');
  return {
    subject: `${changes.length}-changes`,
    message: `[configuration] ${changes.length} changes: ${summary.length > 400 ? `${summary.slice(0, 397)}...` : summary}`
  };
}

const withDrafts = (result, drafts) => (result && typeof result === 'object' ? { ...result, drafts } : result);
/** A proposal's next step is approving it, which shows what it changes first. */
const approvalNext = (result) => (result?.reviewRequired && result.branch
  ? { ...result, nextAction: `singularity-flow configuration approve ${result.branch}` } : result);

/**
 * Author one agent, skill or instruction change.
 *
 * - `--dry-run` previews it on top of the saved drafts, so a change that depends on a draft checks.
 * - `--propose` proposes the saved drafts and this change as one review.
 * - Otherwise, when an approved configuration exists, it is checked with the drafts and saved as a
 *   draft; when none exists, it is written to the working tree as before.
 *
 * `apply(changeSet, { dryRun, propose, subject, message })` is the CLI's normal applier and
 * `check(changeSet)` plans against the approved configuration, returning `{ plan, source }`, where
 * `source.kind === 'working-tree'` means there is no approved authority.
 */
export async function authorChange(root, changeSet, { dryRun = false, propose = false, subject, message, apply, check }) {
  if (!changeSet.changes.every((change) => DRAFTABLE.has(change.op))) return apply(changeSet, { dryRun, propose, subject, message });
  const drafts = await readDrafts(root);
  const included = drafts.changes.length;
  const combined = { schema: CHANGE_SET_SCHEMA, changes: [...drafts.changes.map((entry) => entry.change), ...changeSet.changes] };
  if (dryRun) return withDrafts(await apply(combined, { dryRun: true, subject, message }), { pending: included, included });
  if (propose) {
    const result = await apply(combined, { propose: true, ...batchIdentity(combined.changes, subject, message) });
    if (result?.reviewRequired && result.branch) await recordProposal(root, result, combined.changes);
    return withDrafts(approvalNext(result), { pending: result?.reviewRequired ? 0 : included, included });
  }
  const { plan, source } = await check(combined);
  if (!source || source.kind === 'working-tree') return apply(changeSet, { subject, message });
  if (plan?.valid === false) return withDrafts(plan, { pending: included, included });
  const addedAt = new Date().toISOString();
  const changes = [...drafts.changes, ...changeSet.changes.map((change) => ({ addedAt, description: describeChange(change), change }))];
  if (changes.length > MAXIMUM_DRAFTS) {
    fail(`You have ${drafts.changes.length} drafts already. Propose them for review with singularity-flow configuration propose before adding more.`,
      'CONFIGURATION_DRAFTS_LIMIT');
  }
  await writeDrafts(root, { ...drafts, changes });
  return {
    schemaVersion: 1, resultType: 'configuration-draft', valid: true, draft: true, changed: false,
    summary: plan?.summary ?? [], warnings: plan?.warnings ?? [], problems: [], files: [],
    drafts: { pending: changes.length, added: changeSet.changes.map(describeChange) },
    nextAction: 'singularity-flow configuration propose'
  };
}

async function recordProposal(root, result, changes) {
  await writeDrafts(root, { schema: DRAFTS_SCHEMA, changes: [], proposed: {
    branch: result.branch, commit: result.commit ?? result.proposalRevision ?? null,
    at: new Date().toISOString(), changes: changes.map(describeChange)
  } });
}

/**
 * A change set with the saved drafts in front, for surfaces that build their own batch (Workflow
 * Studio): what they publish carries every waiting draft, so pending work still gets one review.
 */
export async function withSavedDrafts(root, changeSet) {
  const drafts = await readDrafts(root);
  if (!drafts.changes.length) return { changeSet, included: [] };
  return { included: drafts.changes.map((entry) => entry.description ?? describeChange(entry.change)),
    changeSet: { ...changeSet, changes: [...drafts.changes.map((entry) => entry.change), ...(changeSet.changes ?? [])] } };
}

/** After a batch carrying the drafts was proposed or written, they are no longer waiting. */
export async function settleDrafts(root, result, included) {
  if (!included.length) return;
  if (result?.reviewRequired && result.branch) {
    await writeDrafts(root, { schema: DRAFTS_SCHEMA, changes: [], proposed: {
      branch: result.branch, commit: result.commit ?? result.proposalRevision ?? null, at: new Date().toISOString(), changes: included
    } });
  } else if (result && result.valid !== false) {
    const drafts = await readDrafts(root);
    await writeDrafts(root, { ...drafts, changes: [] });
  }
}

/** Propose every saved draft as one review. */
export async function proposeDrafts(root, { apply, message = null }) {
  const drafts = await readDrafts(root);
  if (!drafts.changes.length) {
    fail(drafts.proposed
      ? `No drafts are waiting. Your last proposal, ${drafts.proposed.branch}, is ready for approval: singularity-flow configuration approve`
      : 'No drafts are waiting. Create or edit an agent, skill or instruction first; each change is saved as a draft.',
    'CONFIGURATION_DRAFTS_EMPTY');
  }
  const changes = drafts.changes.map((entry) => entry.change);
  const identity = batchIdentity(changes, changes[0].id ?? changes[0].skill ?? 'change', `[configuration] ${describeChange(changes[0])}`);
  const result = await apply({ schema: CHANGE_SET_SCHEMA, changes }, { propose: true, ...identity, ...(message ? { message } : {}) });
  if (result?.reviewRequired && result.branch) await recordProposal(root, result, changes);
  return withDrafts(approvalNext(result), { pending: result?.reviewRequired ? 0 : changes.length, included: changes.length });
}

/** Drop drafts: one by its number in the list (from 1), or all of them. */
export async function discardDrafts(root, { number = null, all = false } = {}) {
  const drafts = await readDrafts(root);
  if (!drafts.changes.length) fail('There are no drafts to discard.', 'CONFIGURATION_DRAFTS_EMPTY');
  if (!all && !(Number.isSafeInteger(number) && number >= 1 && number <= drafts.changes.length)) {
    fail(`Say which draft to discard: a number from 1 to ${drafts.changes.length} (see singularity-flow configuration drafts), or --all.`,
      'CONFIGURATION_DRAFT_UNKNOWN');
  }
  const removed = all ? drafts.changes : [drafts.changes[number - 1]];
  const changes = all ? [] : drafts.changes.filter((_, index) => index !== number - 1);
  await writeDrafts(root, { ...drafts, changes });
  return { schemaVersion: 1, resultType: 'configuration-drafts-discarded', removed: removed.map((entry) => entry.description), pending: changes.length };
}

/** Forget the last proposal once it is approved, so `approve` no longer offers it. */
export async function forgetProposal(root, branch) {
  const drafts = await readDrafts(root);
  if (drafts.proposed?.branch === branch) await writeDrafts(root, { ...drafts, proposed: null });
}

/**
 * The drafts of one kind ('skill', 'instruction' or 'agent') as lines to print after a list of the
 * approved ones, so a draft is visible where people look for it and plainly not in use yet. Never
 * fails the list it decorates.
 */
export async function draftNotice(root, kind) {
  try {
    const drafts = await readDrafts(root);
    const mine = drafts.changes.filter((entry) => entry.change.op.startsWith(`${kind}.`));
    if (!mine.length) return { lines: [], entries: [] };
    return {
      entries: mine.map((entry) => ({ description: entry.description, change: entry.change })),
      lines: ['', 'Drafts, not used by any Story until approved:', ...mine.map((entry) => `  ${entry.description}`),
        'Propose them for one review: singularity-flow configuration propose']
    };
  } catch {
    return { lines: [], entries: [] };
  }
}

/** The drafts and the last proposal as lines a person reads. */
export function draftLines(drafts) {
  const lines = [];
  if (!drafts.changes.length) lines.push('No drafts. Each agent, skill or instruction change you make is saved here until you propose it.');
  else {
    lines.push(`${drafts.changes.length} draft${drafts.changes.length === 1 ? '' : 's'}, not used by any Story until approved:`);
    drafts.changes.forEach((entry, index) => lines.push(`  ${index + 1}. ${entry.description ?? describeChange(entry.change)}`));
    lines.push('', 'Next: singularity-flow configuration propose   (one review for all of them)');
    lines.push('Drop one: singularity-flow configuration discard <NUMBER>   (or --all)');
  }
  if (drafts.proposed) {
    lines.push('', `Waiting for approval: ${drafts.proposed.branch}`);
    for (const change of drafts.proposed.changes ?? []) lines.push(`  - ${change}`);
    lines.push('Approve: singularity-flow configuration approve');
  }
  return lines;
}

function changedFileLine(entry) {
  if (typeof entry === 'string') return entry;
  const status = String(entry?.status ?? '').charAt(0);
  const verb = { A: 'new', M: 'changed', D: 'removed', R: 'renamed', C: 'copied' }[status] ?? 'changed';
  const paths = Array.isArray(entry?.paths) ? entry.paths : [entry?.path ?? entry?.file].filter(Boolean);
  return `${verb}: ${paths.join(' → ') || 'a file'}`;
}

/** What approving a proposal will change, in plain lines. */
export function proposalSummaryLines(reviewed) {
  const lines = [`Proposal ${reviewed.branch}${reviewed.proposalCreatedAt ? `, made ${reviewed.proposalCreatedAt.slice(0, 16).replace('T', ' ')}` : ''}:`];
  for (const workflow of reviewed.workflows ?? []) lines.push(`  Workflow ${workflow.label ?? workflow.id}: ${workflow.change}`);
  for (const entry of reviewed.changedFiles ?? []) lines.push(`  ${changedFileLine(entry)}`);
  if (!(reviewed.changedFiles ?? []).length) lines.push('  No file changes.');
  return lines;
}

/**
 * Approve one proposal: show what it changes, confirm, and activate exactly the revision shown.
 *
 * The person never copies a commit: the reviewed revision is pinned here and activation refuses if
 * the proposal moved after the summary was shown. `sflow/config` accepts the update directly unless
 * the Git host protects it, in which case the proposal is merged there and approved again to record.
 */
export async function approveProposal(root, requested, {
  yes = false, interactive = false, ask = null, print = (line) => console.log(line),
  list, inspect, activate
}) {
  const drafts = await readDrafts(root);
  let branch = requested ?? drafts.proposed?.branch ?? null;
  if (!branch) {
    const open = (await list(root)).filter((entry) => !entry.merged);
    if (!open.length) fail('No configuration proposal is waiting for approval.', 'CONFIGURATION_APPROVE_NOTHING');
    if (open.length > 1) {
      fail(`${open.length} proposals are waiting. Name the one to approve:\n${open.map((entry) => `  singularity-flow configuration approve ${entry.branch}`).join('\n')}`,
        'CONFIGURATION_APPROVE_PROPOSAL_REQUIRED', { proposals: open.map((entry) => entry.branch) });
    }
    branch = open[0].branch;
  }
  const reviewed = await inspect(root, branch);
  for (const line of proposalSummaryLines(reviewed)) print(line);
  if (reviewed.valid === false) {
    fail(`Proposal ${branch} cannot be approved: it changes files outside the configuration${reviewed.invalidFiles?.length ? ` (${reviewed.invalidFiles.join(', ')})` : ''}.`,
      'WORKFLOW_PROPOSAL_INVALID');
  }
  if (!yes) {
    if (!interactive || typeof ask !== 'function') {
      fail(`Read the summary above, then approve with: singularity-flow configuration approve ${branch} --yes`,
        'CONFIGURATION_APPROVE_CONFIRMATION_REQUIRED', { nextAction: `singularity-flow configuration approve ${branch} --yes` });
    }
    const answer = String(await ask('Approve these changes for new Stories? This updates sflow/config. [y/N] ') ?? '').trim();
    if (!/^y(?:es)?$/iu.test(answer)) {
      print('Nothing was approved.');
      return { schemaVersion: 1, resultType: 'configuration-approval', status: 'declined', activated: false, branch };
    }
  }
  const result = await activate(root, branch, { confirm: reviewed.proposalCommit, acknowledgeUnprotected: true });
  if (result?.activated !== false && result?.status !== 'review-required' && result?.status !== 'activation-pending') {
    await forgetProposal(root, branch);
    print('Approved. New Stories use these changes; Stories already running keep the configuration they started with.');
  } else if (result?.status === 'review-required') {
    print(`sflow/config only accepts reviewed merges here. Merge ${branch} through your Git host, then run singularity-flow configuration approve ${branch} again to record it.`);
  } else {
    print(`The approval did not complete: ${result?.failure?.message ?? 'the update was not accepted'}. Nothing else changed; retry with singularity-flow configuration approve ${branch}.`);
  }
  return { schemaVersion: 1, resultType: 'configuration-approval', ...result, branch };
}
