/** Upstream command grammar and presentation; registered operations own coordination. */
import {repoRoot} from '../git.mjs';
import {createGitEngine} from '../engine-compatibility/git-publication.mjs';
import {discrepancySteps} from '../kernel/phase-upstream-discrepancies.mjs';
import {revalidateCommand} from '../forward-amendments.mjs';
import {upstreamIssueDecideCommand} from '../upstream-issues.mjs';
import {commandResult,effects,noEffects,succeeded} from '../narration/command-result.mjs';
import {emitCommandResult} from '../narration/emit.mjs';
import {optionBoolean,optionString,SingularityFlowError} from '../util.mjs';
export {commitUpstreamIssue,upstreamIssuePart,decideUpstreamIssueRecord,upstreamIssueDecisionPart} from '../engine-compatibility/native-upstream-decisions.mjs';

export const UPSTREAM_ISSUE_ACTIONS = Object.freeze(['raise', 'list', 'decide', 'propose-amendment', 'decide-amendment', 'revalidate']);
const ALLOWED = {
  raise: ['phase', 'about', 'problem', 'assumption', 'impact', 'proposed', 'authored', 'from-artifact', 'supersedes'],
  list: ['open'],
  decide: ['outcome', 'reason', 'link', 'expires'],
  'propose-amendment': ['phase', 'reason', 'file', 'issue'],
  'decide-amendment': ['decision', 'reason', 'confirm'],
  revalidate: ['amendment', 'outcome', 'reason']
};

function refused(message, code = 'UPSTREAM_ISSUE_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function emit(options, workflow, action, { slots = {}, body = {}, changed = false }) {
  emitCommandResult(commandResult({
    operation: { id: `upstream-issue.${action}`, classification: action === 'list' ? 'read' : 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id }, outcome: succeeded(`upstream-issue.${action}.succeeded`, slots),
    effects: changed ? effects({ stateChanged: true, filesChanged: true, publicationCreated: true }) : noEffects(),
    data: body
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

function unownedGuidance(workflow, entries) {
  if(!entries.length)return [];
  const current=workflow.phases[workflow.currentPhase];
  const order=discrepancySteps(workflow).map(step=>step.id);
  const earlier=order.slice(0,Math.max(0,order.indexOf(current.id)));
  const workId = workflow.workItem.id;
  const produced = earlier.filter((id) => Number(workflow.phases?.[id]?.generation) > 0 && workflow.phases[id].status !== 'not_started');
  const unowned = entries.map(({ path: file, text, owner, about }) => ({
    path: file, text, owner,
    reason: owner.status === 'conflicting' ? `it names more than one owning step (${owner.named.join(', ')})`
      : owner.status === 'not-earlier' ? `it names ${owner.named[0]}, which is not a step before ${current.id}`
        : owner.status === 'unknown-step' ? `its owner field names "${owner.value}", which is not a step of this Story`
          : owner.status === 'not-run' ? `it names ${owner.named[0]}, which has not produced anything`
          : 'it does not name its owning step',
    command: `singularity-flow upstream-issue raise --work-id ${workId} --phase ${produced.length ? produced.join('|') : '<EARLIER>'} --about "${about.replaceAll('"', "'")}" --problem "<this item's text>"`,
    rerun: `singularity-flow upstream-issue raise --from-artifact --work-id ${workId}`
  }));
  return unowned;
}
function raise(workflow, options, receipt) {
  const raised=receipt.records,unowned=unownedGuidance(workflow,receipt.unowned);
  if (!optionBoolean(options, 'json')) {
    if (!raised.length && !unowned.length) console.log('No unraised upstream discrepancies are recorded in this step\'s artifacts.');
    for (const issue of raised) {
      console.log(`Raised ${issue.id} against ${issue.phase}: ${issue.about}. This step continues; ${issue.phase}'s approvers decide it:`);
      console.log(`  ${upstreamIssueDecideCommand(workflow.workItem.id, issue, null, workflow)}`);
      const prior = issue.supersedes ? workflow.upstreamIssues?.find((entry) => entry.id === issue.supersedes) : null;
      if (prior) console.log(`${issue.id} supersedes ${prior.id}, recorded against ${prior.phase}: it no longer blocks anything and stays in the history.`);
    }
    if (unowned.length) console.log(`Not raised: ${unowned.length} item(s) name no single earlier owning step, and an owner is never guessed.`);
    for (const item of unowned) {
      const text = item.text.replace(/\s*\n\s*/gu, ' ');
      console.log(`  - ${item.path}: ${text.length > 160 ? `${text.slice(0, 159)}…` : text}`);
      console.log(`    Not raised because ${item.reason}. Raise it against its owning step:`);
      console.log(`    ${item.command}`);
      console.log(`    Or start the item with that step (for example "planning: …") or add "Owner: <step>", then rerun: ${item.rerun}`);
    }
  }
  emit(options, workflow, 'raise', { slots: { count: String(raised.length), unowned: String(unowned.length) },
    body: { issues: raised, unowned }, changed: raised.length > 0 });
}
function list(workflow, options, receipt) {
  const states=receipt.issues.map(({status,decision,supersededBy,...issue})=>({issue,status,decision,supersededBy}));
  if (!optionBoolean(options, 'json')) {
    if (!states.length) console.log(optionBoolean(options, 'open') ? 'No open upstream issues.' : 'No upstream issues.');
    for (const { issue, decision, status, supersededBy } of states) {
      console.log(`${issue.id} [${status}] ${issue.phase} — ${issue.about}: ${issue.problem}`);
      if (issue.supersedes) console.log(`  supersedes ${issue.supersedes}`);
      if (supersededBy) console.log(`  superseded by ${supersededBy}${status === 'decided' ? '' : '; it no longer blocks anything'}`);
      if (decision) console.log(`  ${decision.outcome}${decision.link ? ` (${decision.link})` : ''} by ${decision.actor}: ${decision.reason}`);
      else if (status !== 'superseded') console.log(`  ${upstreamIssueDecideCommand(workflow.workItem.id, issue, null, workflow)}`);
    }
  }
  emit(options, workflow, 'list', {
    slots: { count: String(states.length) },
    body: { issues: states.map(({ issue, decision, status, supersededBy }) => ({ ...issue, status, decision, supersededBy })) }
  });
}
function decide(workflow, issueId, options, receipt) {
  const [value]=receipt.records,authority={authorityGroup:value.authorityGroup},outcome=optionString(options,'outcome');
  if (!optionBoolean(options, 'json')) {
    console.log(`Decided ${issueId} through ${authority.authorityGroup}: ${outcome}${value.link ? ` (${value.link})` : ''}.`);
    if (outcome === 'return') console.log(`${value.changeRequest.id} returned the Story to ${value.changeRequest.targetPhase}; the current step's working files are kept.`);
  }
  const { changeRequest, ...recorded } = value;
  emit(options, workflow, 'decide', { slots: { issue: issueId, outcome },
    body: { decision: recorded, ...(changeRequest ? { changeRequestId: changeRequest.id } : {}) }, changed: true });
}

function proposeAmendment(workflow, options, receipt) {
  const [proposal]=receipt.records,phaseId=proposal.phase;
  const decide = `singularity-flow upstream-issue decide-amendment ${proposal.id} --work-id ${workflow.workItem.id} --decision approve|reject --reason "<why>" --confirm ${proposal.id}`;
  if (!optionBoolean(options, 'json')) {
    console.log(`Proposed ${proposal.id}: ${phaseId} generation ${proposal.fromGeneration + 1} from ${proposal.proposedPath}. ${phaseId}'s approvers decide it:`);
    console.log(`  ${decide}`);
  }
  emit(options, workflow, 'propose-amendment', { slots: { amendment: proposal.id, phase: phaseId }, body: { proposal, decide }, changed: true });
}

function decideAmendment(workflow, amendmentId, options, receipt) {
  const [value]=receipt.records,proposal=workflow.forwardAmendments.find(entry=>entry.id===amendmentId);
  const owed=receipt.revalidate.map(phase=>({phase,amendment:amendmentId}));
  if (!optionBoolean(options, 'json')) {
    if (!value.applied) console.log(`Rejected ${amendmentId}; ${proposal.phase} keeps generation ${proposal.fromGeneration}.`);
    else {
      console.log(`Approved ${amendmentId}: ${proposal.phase} is now generation ${value.approval.generation}; no step was reset.`);
      if (value.refreshed) console.log(`${value.refreshed} reads the amended ${proposal.phase} from its next composition; its draft text is kept.`);
      for (const entry of owed) console.log(`  Revalidate ${entry.phase}: ${revalidateCommand(workflow.workItem.id, entry)}`);
    }
  }
  emit(options, workflow, 'decide-amendment', { slots: { amendment: amendmentId, decision: value.decision.decision },
    body: { decision: value.decision, revalidate: owed.map((entry) => entry.phase), refreshed: value.refreshed ?? null }, changed: true });
}

function revalidate(workflow, phaseId, options, receipt) {
  const [value]=receipt.records,outcome=optionString(options,'outcome'),amendmentId=optionString(options,'amendment');
  if (!optionBoolean(options, 'json')) {
    console.log(outcome === 'return'
      ? `${value.link} returned the Story to ${phaseId} after ${amendmentId}.`
      : `Recorded that ${phaseId} holds under ${amendmentId}; its approval stands.`);
  }
  emit(options, workflow, 'revalidate', { slots: { phase: phaseId, outcome }, body: { revalidation: value }, changed: true });
}

export async function run(argv, { positionals = argv, options = {} } = {}) {
  const action = positionals[1] ?? 'list';
  if (options.help === true) {
    console.log('Usage: singularity-flow upstream-issue raise|list|decide [--work-id WORK-ID] [--json]\n'
      + 'raise: --phase EARLIER --about ID|SECTION --problem TEXT [--assumption TEXT] [--impact TEXT] [--proposed KIND] [--authored human|governed-agent] [--supersedes UPI-ID], or --from-artifact\n'
      + '  --from-artifact raises each item against the step it names as its owner (its leading label, such as "planning:", or an "Owner: <step>" field); an item naming none, or two, is listed with the command that raises it. An item once filed against another step supersedes that issue. --supersedes replaces an open issue raised against the wrong step; its approvers dismiss it.\n'
      + 'list: [--open]\n'
      + 'decide UPI-ID --outcome plan-correction|amend|return|accept-risk|dismiss --reason TEXT [--link PRC-ID|FAM-ID] [--expires YYYY-MM-DD]\n'
      + 'propose-amendment --phase EARLIER --reason TEXT [--file DRAFT] [--issue UPI-ID]; decide-amendment FAM-ID --decision approve|reject --reason TEXT --confirm FAM-ID\n'
      + 'revalidate PHASE --amendment FAM-ID --outcome unchanged|return --reason TEXT\n'
      + 'Raising never stops the current step; the earlier step\'s approvers decide, and the Story completes only when every issue is decided.');
    return;
  }
  if (!UPSTREAM_ISSUE_ACTIONS.includes(action)) {
    refused(`Unknown upstream-issue action '${action}'. Use ${UPSTREAM_ISSUE_ACTIONS.join(', ')}.`, 'UPSTREAM_ISSUE_ACTION_INVALID');
  }
  const allowed = new Set(['json', 'help', 'no-model', 'work-id', ...ALLOWED[action]]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) refused(`Unsupported upstream-issue ${action} option --${key}.`, 'UPSTREAM_ISSUE_OPTIONS_INVALID');
  }
  if (positionals.length > (['decide', 'decide-amendment', 'revalidate'].includes(action) ? 3 : 2)) refused('Unexpected upstream-issue arguments. Use --work-id for the Story.');
  const operations={list:'upstream.list',raise:'upstream.raise',decide:'upstream.decide',
    'propose-amendment':'forward-amendment.propose','decide-amendment':'forward-amendment.decide',revalidate:'forward-amendment.revalidate'};
  const mappings={raise:{phase:'phaseId',about:'about',problem:'problem',assumption:'assumption',impact:'impact',
    proposed:'proposed',authored:'authored',supersedes:'supersedes'},
    decide:{outcome:'outcome',reason:'reason',link:'link',expires:'expires'},
    'propose-amendment':{phase:'phaseId',reason:'reason',file:'file',issue:'upstreamIssue'},
    'decide-amendment':{decision:'decision',reason:'reason',confirm:'confirmation'},
    revalidate:{amendment:'amendmentId',outcome:'outcome',reason:'reason'}};
  const input={workId:optionString(options,'work-id')??null};
  for(const [flag,field] of Object.entries(mappings[action]??{}))if(options[flag]!==undefined)input[field]=optionString(options,flag);
  if(action==='raise')input.fromArtifact=optionBoolean(options,'from-artifact');
  if(action==='list')input.open=optionBoolean(options,'open');
  if(action==='decide')input.issueId=positionals[2]??'';
  if(action==='decide-amendment')input.amendmentId=positionals[2]??'';
  if(action==='revalidate')input.phaseId=positionals[2]??'';
  const binding=createGitEngine({root:repoRoot()});
  const receipt=await binding.engine.run(operations[action],input);
  const {workflow}=binding.presentation();
  if(action==='list')return list(workflow,options,receipt);
  if(action==='raise')return raise(workflow,options,receipt);
  if(action==='propose-amendment')return proposeAmendment(workflow,options,receipt);
  if(action==='decide-amendment')return decideAmendment(workflow,positionals[2],options,receipt);
  if(action==='revalidate')return revalidate(workflow,positionals[2],options,receipt);
  return decide(workflow,positionals[2],options,receipt);
}
