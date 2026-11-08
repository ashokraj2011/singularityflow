/**
 * The step sheet: what one step of a Story needs from a person, as one structure every surface can
 * read [study 6.1]. Beside the older fields for now (`approvalCheck`, `pending`, the list's `next`);
 * test/step-sheet-shadow.test.mjs holds the two to the same answers.
 *
 * It only reads. Nothing here decides or records anything: a step's `command` is the same command its
 * own check guards, and the gate (evaluateApproval) stays what refuses. Built from the approval check
 * and the decision list as they stand, so it says nothing they do not know.
 *
 *   holds      what stops this approval (or, before submission, this step), in the order approving
 *              meets it, each with who clears it (`clearedBy`, always) and how (`steps`)
 *   owedLater  what stops the Story's ending, not this approval
 *   next       the one answer for the person looking: a hold they can clear, else what to share with
 *              those who can (`waitingFor`), else the approval, else what is owed later
 *
 * A blank in a command is `{name}` with an entry in that step's `fills`, never `<...>`; a value the
 * system knows is already in it. A person's reason is theirs: no agent fills its default for them.
 */
import { approvalRequirementsMet, normalizeApprovalAuthorities, remainingRequiredAuthorities } from './approval-authority.mjs';
import { commandLineWithoutSkill, DECISION_LIST_CHAT_OPTIONS } from './command-skills.mjs';
import { holdItemKind, LATER_KINDS } from './decision-list.mjs';
import { recordSha256 } from './records.mjs';

export const STEP_SHEET_SCHEMA = 'sflow-step-sheet/v1';
const DOOR_CODES = Object.freeze(['LIFECYCLE_WORKTREE_REVIEW_REQUIRED', 'WORKTREE_HIDDEN_CHANGE', 'PSS_NOT_AN_APPROVER', 'PSS_POLICY_UNREADABLE',
  'PSS_KEY_NOT_REGISTERED', 'PSS_SIGNER_UNAVAILABLE', 'PSS_CARD_NOT_SHOWN']);
// What only looks: anyone may run these, and nothing is recorded.
const READS = /^singularity-flow (?:phase show|recover|evidence matrix|decisions(?! record)|story intent-amendment status|guard status|appeal (?:list|show)|nextsteps|tests plan|status)\b/u;

const sourceOf = (code, listed) => (!code ? 'list' : DOOR_CODES.includes(code) ? 'door' : code === 'STORY_COMPLETION_REFUSED' ? 'ending' : listed ? 'list' : 'gate');

/** The name a command's blank goes by: `<REASON>` and `"<why>"` are a reason, `<approve|reject>` is named by its flag. */
function blankName(inner, flag) {
  if (/^(?:reason|why)$/iu.test(inner)) return 'reason';
  if (inner.includes('|') && flag) return flag;
  return inner.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'value';
}

/**
 * A command with each `<...>` as a `{name}` declared in `fills`. `known` fills what the system knows;
 * `needs` are the list's limits and editable defaults for a value, `choices` what a blank may be.
 */
export function commandWithFills(raw, { known = {}, needs = {}, choices = {} } = {}) {
  const fills = new Map();
  const command = String(raw ?? '').replace(/(?:(--[a-z-]+)[ =])?(["']?)<([^<>\n]+)>\2/gu, (whole, flag, quote, inner) => {
    if (Object.hasOwn(known, inner)) return `${flag ? `${flag} ` : ''}${known[inner]}`;
    const name = blankName(inner, flag?.slice(2));
    const need = needs[name];
    const options = inner.includes('|') ? inner.split('|').map((id) => ({ id })) : choices[name] ?? null;
    fills.set(name, options ? { name, kind: 'choice', options }
      : { name, kind: 'text', ...(need?.minimum != null ? { min: need.minimum } : {}), ...(need?.maximum != null ? { max: need.maximum } : {}) });
    return `${flag ? `${flag} ` : ''}{${name}}`;
  });
  return { command, fills: [...fills.values()] };
}

const groupsOf = (ids, registry) => ids.map((id) => ({ id, label: registry?.[id]?.label ?? id,
  members: (registry?.[id]?.members ?? []).map((member) => member.name ?? member.email ?? member.githubLogin).slice(0, 5),
  anyIdentity: registry?.[id]?.allowAnyGitIdentity === true }));

/** Who clears a hold, from what the list says of its item, for the person looking. */
function partyOf(decidedBy, registry, kind) {
  const groups = decidedBy?.groups ?? [];
  return { kind: kind ?? (groups.length ? 'approvers' : decidedBy?.allowed ? 'anyone' : 'nobody'), groups: groupsOf(groups, registry),
    includesViewer: decidedBy?.allowed === true, words: decidedBy?.words ?? '',
    ...(decidedBy?.share ? { share: decidedBy.share } : {}) };
}

function effectOf(item, command, option) {
  if (item.kind === 'approval' || /^singularity-flow approve /u.test(command)) return 'approves';
  if (/^singularity-flow reject /u.test(command)) return 'returns';
  return !option.effects?.length && READS.test(command) ? 'reads' : 'records';
}

/** One way through an item: an option of the list, as the command that takes it and where it may run. */
function stepOf(workflow, packet, item, option, { rows = [], card = true } = {}) {
  const workId = workflow.workItem.id;
  const needs = option.needs ?? {};
  // A choice recorded on the list has no command of its own: the list's record command for it.
  const notYet = option.available === false;
  const raw = notYet ? null : option.chat?.command ?? option.action?.command ?? [`singularity-flow decisions record ${workId} --choose ${item.id}=${option.id}`,
    ...Object.keys(needs).map((flag) => `--${flag} ${item.id}=<${flag}>`), `--confirm ${packet.packetSha256}`].join(' ');
  const { command, fills } = notYet ? { command: null, fills: [] } : commandWithFills(raw, { known: { 'WORK-ID': workId }, needs,
    choices: rows.length ? { clause: rows.map((row) => ({ id: row.clauseId, ...(row.result ? { hint: row.result } : {}) })) } : {} });
  for (const [name, need] of Object.entries(needs)) {
    const fill = fills.find((entry) => entry.name === name);
    if (fill && need?.default) fill.default = need.default;
    if (fill && need?.latest) fill.latest = need.latest;
  }
  // The list's own question: is this option one a /sf-decide turn takes, on its card or in chat, or only
  // the person's terminal? A host with no card (`card: false`) records in chat only what that turn may.
  const alone = notYet ? true : option.recordable === false ? typeof option.action?.command === 'string' && commandLineWithoutSkill(option.action.command) && !(card && option.action.humanReview)
    : !card && !DECISION_LIST_CHAT_OPTIONS.includes(option.id) && !option.chat;
  return { id: option.id, label: option.label, effect: effectOf(item, command, option), fills, command,
    where: { copilot: item.kind === 'approval' ? `/sf-approve ${packet.phase} --work-id ${workId}` : item.routeSkill ? `${item.routeSkill} ${workId}` : alone ? null : `/sf-decide ${workId}`,
      terminal: true, vscode: item.kind === 'approval' ? 'singularityFlow.approve' : 'singularityFlow.decisions' },
    available: option.available !== false, whyNotYet: option.available === false ? option.words ?? null : null };
}

/** A list item as a hold: its title and why, who clears it, and each of its options as a step. */
function holdOfItem(workflow, packet, item, registry, codes, partyKind, card) {
  const code = item.details?.code ?? codes[0] ?? null;
  const rows = item.details?.planRows ?? [];
  const key = item.details?.path ? `${item.kind}:${item.details.path}` : item.details?.departure ? `${item.kind}:${item.details.departure}` : `${item.kind}:${code ?? item.details?.amendment ?? item.details?.clause ?? item.details?.scopeItem
    ?? item.details?.key ?? item.details?.appeal ?? item.details?.request ?? item.details?.issue ?? item.id}`;
  return { key, code, codes, item: item.id, source: sourceOf(code, !codes.length), title: item.title, why: item.why, clearedBy: partyOf(item.decidedBy, registry, partyKind),
    steps: item.options.map((option) => stepOf(workflow, packet, item, option, { rows, card })) };
}

/** An answer the approval's own form takes, or its signature in the person's terminal: no item of its own. */
function holdOfAnswer(hold, workflow) {
  const route = hold.action?.command ? commandWithFills(hold.action.command, { known: { 'WORK-ID': workflow.workItem.id } }) : null;
  return { key: `answer:${hold.code}`, code: hold.code, codes: [hold.code], item: null, source: sourceOf(hold.code, false), title: hold.summary, why: hold.message ?? hold.summary,
    clearedBy: { kind: hold.clearedBy?.kind ?? 'viewer-form', groups: [], includesViewer: true, words: hold.who },
    steps: route ? [{ id: 'route', label: hold.action.label ?? hold.summary, effect: 'approves', fills: route.fills, command: route.command, where: { copilot: null, terminal: true, vscode: null }, available: true, whyNotYet: null }] : [] };
}

/** Which of the check's holds each list item carries; what the list has no item for keeps its own. */
function carriedCodes(checkHolds, items) {
  const byItem = new Map();
  const carriedBy = (hold) => {
    const kind = holdItemKind(hold);
    return items.find((item) => item.details?.code === hold.code)
      ?? items.find((item) => item.holdsApproval && (hold.unclaimedPaths?.length ? item.kind === 'plan-accounting' : item.kind === kind))
      ?? (hold.code === 'STORY_COMPLETION_REFUSED' ? items.find((item) => item.holdsApproval) : null);
  };
  const free = [];
  for (const hold of checkHolds) {
    const item = holdItemKind(hold) === 'approval' ? null : carriedBy(hold);
    // One refusal, one item per path or departure it names.
    const carriers = !item ? [] : hold.unclaimedPaths?.length ? items.filter((entry) => entry.kind === 'plan-accounting')
      : item.kind === 'departure' ? items.filter((entry) => entry.kind === 'departure') : [item];
    for (const carrier of carriers) byItem.set(carrier.id, [...(byItem.get(carrier.id) ?? []), hold.code]);
    if (!item) free.push(hold);
  }
  return { byItem, free };
}

/**
 * The sheet for one step, from the packet decisionPacket built and the approval check it read.
 * `counts` is SF Guard's predicate on a Story that requires it (null elsewhere).
 */
export function stepSheet(workflow, packet, { approvalCheck = null, authorities = null, actor = null, counts = null, card = true } = {}) {
  const phase = workflow.phases?.[packet.phase] ?? null;
  let registry = null;
  try { registry = normalizeApprovalAuthorities(authorities ?? workflow.resolution?.approvalAuthorities); } catch { registry = null; }
  const awaiting = phase?.status === 'awaiting_approval';
  const items = packet.items ?? [];
  const approvalItem = items.find((item) => item.kind === 'approval') ?? null;
  const open = items.filter((item) => item.kind !== 'approval' && !item.machine);
  // Before submission, what stops the step is everything but a sign-off owed to the ending or a departure
  // its approval waits for, as the list counts it.
  const stops = (item) => item.holdsApproval || (!awaiting && !LATER_KINDS.includes(item.kind));
  const checkHolds = awaiting ? approvalCheck?.holds ?? [] : [];
  const { byItem, free } = carriedCodes(checkHolds, items);
  const partyKindOf = (item) => checkHolds.find((hold) => (byItem.get(item.id) ?? []).includes(hold.code))?.clearedBy?.kind;
  const holds = [...items.filter(stops).filter((item) => item.kind !== 'approval').map((item) => holdOfItem(workflow, packet, item, registry, byItem.get(item.id) ?? [], partyKindOf(item), card)),
    ...free.map((hold) => holdOfAnswer(hold, workflow))];
  const owedLater = open.filter((item) => !stops(item)).map((item) => holdOfItem(workflow, packet, item, registry, [], null, card));

  const policy = phase?.approvalPolicy ?? {};
  const active = (phase?.approvals ?? []).filter((entry) => !entry.invalidatedAt && entry.decision === 'approved');
  // What stands between the person and recording: an answer the form takes, or a signature in their terminal, is part of approving.
  const blocking = holds.filter((hold) => hold.clearedBy.kind !== 'viewer-form' && hold.code !== 'PSS_CARD_NOT_SHOWN');
  const allowed = approvalItem?.decidedBy?.allowed === true;
  const mayApproveNow = awaiting && !blocking.length && allowed;
  const approvalParty = approvalItem ? partyOf(approvalItem.decidedBy, registry, 'approvers') : null;
  const approval = {
    needed: Number(policy.minimum ?? 1),
    recorded: active.map((entry) => ({ who: entry.actor?.name ?? entry.actor?.email ?? entry.actor?.login ?? null, group: entry.authorityGroup ?? null, at: entry.at ?? null,
      counts: counts ? counts(entry) === true : true })),
    requiredGroupsLeft: remainingRequiredAuthorities(policy, active, { counts }),
    reached: approvalRequirementsMet(policy, active, { counts }),
    selfApprovalAllowed: policy.allowSelfApproval !== false,
    mayApproveNow,
    whyNot: mayApproveNow ? null : blocking[0] ? { words: blocking[0].clearedBy.words, hold: blocking[0].key } : awaiting ? { words: approvalParty?.words ?? '' } : { words: `${phase?.label ?? packet.phase} does not await approval.` }
  };

  const share = (party) => ({ id: 'share', label: party.words, effect: 'reads', fills: [], command: `singularity-flow decisions ${workflow.workItem.id}`,
    where: { copilot: party.share ?? `/sf-decide ${workflow.workItem.id}`, terminal: true, vscode: 'singularityFlow.decisions' }, available: true, whyNotYet: null });
  // A hold with several ways through has no answer chosen for the person, and one whose command only their
  // terminal runs is reached through the card: either way on is the list, where they choose.
  const firstStep = (hold) => {
    const open = hold.steps.filter((step) => step.available);
    if (open.length < 2 && !(open[0]?.where.copilot && commandLineWithoutSkill(open[0].command))) return open[0] ?? null;
    return { id: 'choose', label: hold.title, effect: 'reads', fills: [], command: `singularity-flow decisions ${workflow.workItem.id}`,
      where: { copilot: open.some((step) => step.where.copilot) ? `/sf-decide ${workflow.workItem.id}` : null, terminal: true, vscode: 'singularityFlow.decisions' }, available: true, whyNotYet: null };
  };
  const mine = blocking.find((hold) => hold.clearedBy.includesViewer && firstStep(hold));
  const theirs = blocking[0] ?? null;
  const approveStep = approvalItem ? stepOf(workflow, packet, approvalItem, approvalItem.options[0], { card }) : null;
  const owedStep = owedLater.map((hold) => (hold.clearedBy.includesViewer ? firstStep(hold) : null)).find(Boolean) ?? null;
  let next = null;
  let waitingFor = null;
  if (mine) next = firstStep(mine);
  else if (theirs) { waitingFor = theirs.clearedBy; next = share(theirs.clearedBy); }
  else if (mayApproveNow) next = approveStep;
  else if (awaiting && approvalParty) { waitingFor = approvalParty; next = share(approvalParty); }
  else if (owedStep) next = owedStep;

  const generation = Number(phase?.generation ?? 0);
  const submission = [...(workflow.lineage?.submissions ?? [])].reverse().find((entry) => entry.phase === packet.phase && Number(entry.generation) === generation);
  const sheet = {
    schema: STEP_SHEET_SCHEMA, story: workflow.workItem.id, headline: packet.headline ?? null,
    step: { id: packet.phase, label: packet.phaseLabel, generation, status: phase?.status ?? null, packetSha256: submission?.packetSha256 ?? null },
    viewer: { email: actor?.email ?? null, login: actor?.login ?? null, known: Boolean(actor?.email || actor?.login) },
    approval, holds, owedLater, next, waitingFor,
    notes: approvalCheck?.notes ?? [], warnings: approvalCheck?.warnings ?? [], unavailable: packet.unavailable ?? []
  };
  return { ...sheet, digest: `sha256:${recordSha256(sheet)}` };
}

/**
 * The sheet as it stands now, when nothing has read the list yet: `known` passes what a caller read
 * (`approvalCheck`, `owed`, `publication`). Null if the list cannot be read here; the older fields
 * still stand, so a surface reading only those loses nothing.
 */
export async function readStepSheet(root, config, workflow, { phaseId = workflow?.currentPhase ?? null, offline = true, ...known } = {}) {
  try {
    const { readPendingList } = await import('./decision-list-reads.mjs');
    return (await readPendingList(root, config, workflow, { phaseId, reuse: false, offline, ...known })).sheet ?? null;
  } catch { return null; }
}
