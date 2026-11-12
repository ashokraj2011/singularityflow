/**
 * `decision test-command`: a Story-only test command for one step. See src/story-test-commands.mjs.
 *
 *   singularity-flow decision test-command [WORK-ID] --phase PHASE --reason TEXT (--use SUGGESTION-ID [--source-root DIR]...
 *     | --id ID --argv '<JSON ARRAY>' --working-directory DIR --affected-root DIR... --adapter ADAPTER --report PATH [--ecosystem LANGUAGE])
 *   singularity-flow decision test-command [WORK-ID] --phase PHASE --repin COMMAND-ID --reason TEXT
 *   singularity-flow decision test-command [WORK-ID] --accept TCD-001 [--reason TEXT]
 *   singularity-flow decision test-command [WORK-ID] --revoke TCD-001 --reason TEXT
 *
 * `--repin` asks that a pinned command's changed form (src/test-command-pins.mjs), as the gate
 * resolves it now, replace its pin; its acceptance lets the next gate run record it. For a pinned
 * suite the step no longer runs, it asks that it no longer run: accepted, the gate stops refusing its removal.
 *
 * Anyone working on the Story, its agent included, may request the exact command that ran. Accepting
 * or revoking it is the call of a person in the group that approves the step (the next approving
 * step's when it has none), so the Copilot guard refuses those forms, like approve; the decision list
 * offers the acceptance to the people who may give it.
 */
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { repoRoot } from '../git.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { action, commandResult, effects, noop, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { loadSession } from '../session.mjs';
import { actorKey, assertNoPendingPublication, loadConfig, transactStory } from '../state-stores.mjs';
import { pinDiffWords, recordStoryTestCommandDecision, recordStoryTestCommandRequest, storyTestCommandState } from '../story-test-commands.mjs';
import { testRunRiskAuthorities } from '../test-run-risk.mjs';
import { nowIso, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { actionActor } from './kernel.mjs';

const fail = (message, code = 'TEST_COMMAND_DECISION_INVALID') => { throw new SingularityFlowError(message, { code }); };
const COMMAND_OPTIONS = ['use', 'id', 'argv', 'working-directory', 'affected-root', 'adapter', 'report', 'ecosystem', 'source-root'];
const USAGE = 'Use: singularity-flow decision test-command [WORK-ID] --phase PHASE --reason TEXT (--use SUGGESTION-ID [--source-root DIR]... '
  + "| --id ID --argv '<JSON ARRAY>' --working-directory DIR --affected-root DIR... --adapter ADAPTER --report PATH [--ecosystem LANGUAGE] | --repin COMMAND-ID), "
  + 'or --accept TCD-… / --revoke TCD-… --reason TEXT.';

/** The step whose approvers decide: the step itself, else the next one on the route that has approvers. */
function decidingStep(workflow, phaseId) {
  const approved = (id) => {
    const policy = workflow.phases?.[id]?.approvalPolicy ?? {};
    return (policy.authorities ?? []).length + (policy.requiredAuthorities ?? []).length > 0;
  };
  if (approved(phaseId)) return phaseId;
  const order = workflow.phaseOrder ?? Object.keys(workflow.phases ?? {});
  return order.slice(order.indexOf(phaseId) + 1).find(approved) ?? phaseId;
}

/** The command a person who approves the step runs to accept a request. */
export function storyTestCommandAcceptCommand(workflow, id) {
  return `singularity-flow decision test-command ${workflow?.workItem?.id ?? '<WORK-ID>'} --accept ${id}`;
}

/**
 * Record a request, or a person's acceptance or revocation of one, and commit it. The command and
 * the decision list both record through this, so authority, the record and its commit are the same.
 */
export async function recordStoryTestCommand(root, config, workflow, { phaseId = null, command = null, repin = null, accept = null, revoke = null, reason = '' }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  const target = accept ?? revoke;
  const requested = target ? storyTestCommandState(workflow, target)?.request : null;
  if (target && !requested) fail(`This Story has no test command request ${target}.`, 'TEST_COMMAND_DECISION_UNKNOWN');
  const phase = target ? requested.phase : phaseId;
  let authority = null;
  if (target) {
    const groups = testRunRiskAuthorities(workflow, phase);
    if (!groups.length) fail(`Step ${phase} has no approval group, so nobody can decide its test commands.`, 'RISK_AUTHORITY_UNAVAILABLE');
    authority = requireApprovalAuthority(workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
      { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
  }
  const common = { actor: actorKey(actor), at: nowIso() };
  const decide = (aggregate) => target
    ? recordStoryTestCommandDecision(aggregate, { id: target, outcome: accept ? 'accept' : 'revoke', reason, ...common,
      authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null,
      selfApproval: aggregate.phases?.[decidingStep(aggregate, phase)]?.approvalPolicy?.allowSelfApproval !== false })
    : recordStoryTestCommandRequest(aggregate, { phaseId, command, repin, reason, ...common });
  const preview = decide(structuredClone(workflow));
  if (!target && storyTestCommandState(workflow, preview.id)) return { record: preview, publication: null, reused: true };
  const verb = accept ? 'accept' : revoke ? 'revoke' : 'request';
  const { value: record, publication } = await transactStory(
    root, config, workflow,
    { type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: phase, generation: null, actor, agent,
      authorityGroup: authority?.authorityGroup ?? null, payload: { decision: 'test-command' } },
    `[${id}][test-command:${verb}] ${target ?? `${phase} ${command.id}`}`,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record a test command decision');
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor ?? recorded.requestedBy, agent, event: 'test_command_decided', phase,
        detail: recorded.id
          ? `${recorded.id} requests that ${phase} ${recorded.repin ? `re-pin test command ${recorded.command.id} (${recorded.repin.changes.join('; ')})` : `run test command ${recorded.command.id}`} for this Story. ${recorded.reason}`
          : `${target} ${accept ? 'accepted' : 'revoked'} through ${recorded.authorityGroup}.${recorded.reason ? ` ${recorded.reason}` : ''}`
      });
      return recorded;
    },
    { eventFromResult: (recorded) => ({ actor, agent, authorityGroup: recorded.authorityGroup ?? null, identityAssurance: recorded.identityAssurance ?? null,
      payload: { decision: 'test-command', record: recorded.id ?? target, outcome: verb, reviewPacketSha256: null } }) }
  );
  return { record, publication };
}

/** A re-pin's before and after, for the person reading the request in a terminal. */
function repinWords(repin) {
  return repin.diff?.length ? `\n${repin.diff.map((entry) => `  ${pinDiffWords(entry)}`).join('\n')}\n  ${repin.dropped}` : '';
}

export async function decisionTestCommandCommand(positionals, options) {
  const root = repoRoot();
  // `--accept` is a global flag, so `--accept TCD-001` leaves the request ID among the positionals.
  const request = (value) => /^TCD-[0-9]{3,}$/u.test(String(value ?? ''));
  const named = positionals.slice(2);
  const requestedId = named.find((value) => !request(value)) ?? optionString(options, 'work-id') ?? null;
  let config = await loadConfig(root);
  if (requestedId) await checkoutStoryBranch(root, config, requestedId, { fetch: optionBoolean(options, 'fetch') });
  const accepted = await loadAcceptedStoryExecution(root, requestedId ?? undefined);
  config = accepted.definition;
  const workflow = accepted.workflow;
  const id = workflow.workItem.id;
  if (workflow.status !== 'in_progress') fail(`Story ${id} is ${workflow.status}; its test commands are decided while it is in progress.`, 'TEST_COMMAND_DECISION_CLOSED');
  const accept = optionBoolean(options, 'accept') ? named.find(request) ?? null : null;
  const revoke = optionString(options, 'revoke') ?? null;
  if (optionBoolean(options, 'accept') && !accept) fail(`Name the request to accept: --accept TCD-001. ${USAGE}`);
  const phaseId = optionString(options, 'phase') ?? null;
  if ([accept, revoke, phaseId].filter(Boolean).length !== 1) {
    fail(`Request a command for a step with --phase PHASE, or decide a request with --accept or --revoke. ${USAGE}`);
  }
  if ((accept || revoke) && COMMAND_OPTIONS.some((key) => options[key] !== undefined)) fail('--accept and --revoke decide the requested command as it was asked; they take no command options.');
  const repinId = optionString(options, 'repin') ?? null;
  if (repinId && (!phaseId || COMMAND_OPTIONS.some((key) => options[key] !== undefined))) {
    fail(`--repin takes the command as the gate resolves it now, with --phase PHASE and no command options. ${USAGE}`);
  }
  let command = null;
  let repin = null;
  if (phaseId && repinId) {
    const [{ resolveStoryLocalTestCommands }, { removalRequest, repinRequest }] = await Promise.all([import('../local-test-runs.mjs'), import('../test-command-pins.mjs')]);
    const { phase, commands } = await resolveStoryLocalTestCommands(root, config, workflow, { phaseId });
    const current = commands.find((entry) => entry.id === repinId);
    // A pinned suite the step no longer runs: the request is that it no longer run [TCE:REQ-012].
    const removal = current ? null : await removalRequest(root, config, workflow, phase, repinId);
    if (!current && !removal) fail(`Step ${phaseId} runs no test command ${repinId} now (it runs ${commands.map((entry) => entry.id).join(', ') || 'none'}).`);
    if (removal) ({ repin, command } = removal);
    else {
      repin = await repinRequest(root, config, workflow, phase, current);
      command = { id: current.id, kind: 'test', argv: current.argv, workingDirectory: current.workingDirectory,
        affectedRoots: current.affectedRoots, ...(current.ecosystem ? { ecosystem: current.ecosystem } : {}), modelPolicy: 'never', result: current.result };
    }
  } else if (phaseId) {
    const [{ requestedCommand }, { normalizeRequiredTestCommand }, { phaseRequiresCodeDelivery }] = await Promise.all([
      import('../test-setup-proposal.mjs'), import('../code-delivery-tests.mjs'), import('../delivery-evidence.mjs')]);
    if (!workflow.phases?.[phaseId]) fail(`Story ${id} has no step ${phaseId}.`);
    if (!phaseRequiresCodeDelivery(workflow.phases[phaseId])) fail(`Step ${phaseId} delivers no code, so it runs no test command.`);
    let requested;
    // The command options are `capability test-setup`'s; say how this command takes them.
    try { requested = await requestedCommand(root, options); }
    catch (error) { if (error?.code === 'TEST_SETUP_PROPOSAL_USAGE') fail(`${error.message.replace(/ Use: [\s\S]*$/u, '')} ${USAGE}`); throw error; }
    try { normalizeRequiredTestCommand(requested); } catch (error) { fail(`Test command '${requested.id}' cannot be requested: ${error.message}`); }
    command = { id: requested.id, kind: 'test', argv: requested.argv, ...(requested.env ? { env: requested.env } : {}),
      ...(requested.ecosystem ? { ecosystem: requested.ecosystem } : {}),
      workingDirectory: requested.workingDirectory, affectedRoots: requested.affectedRoots, modelPolicy: 'never', result: requested.result };
  }
  const actor = actionActor(root);
  const session = await loadSession(root, { required: false });
  const agent = session?.workId === id ? session.agent ?? null : null;
  const { record, publication, reused = false } = await recordStoryTestCommand(root, config, workflow,
    { phaseId, command, repin, accept, revoke, reason: optionString(options, 'reason') ?? '' }, { actor, agent });
  const recordId = record.id ?? accept ?? revoke;
  const repinned = accept ? storyTestCommandState(workflow, accept)?.request?.repin ?? null : null;
  if (!optionBoolean(options, 'json')) {
    console.log(record.repin?.removed
      ? `Requested ${record.id}: ${record.phase} no longer runs ${record.command.id} once a person who approves it accepts: ${storyTestCommandAcceptCommand(workflow, record.id)}, or from the decision list (/sf-decide ${id}).`
      : record.repin
      ? `Requested ${record.id}: ${record.phase} re-pins ${record.command.id} (${record.repin.changes.join('; ')}) once a person who approves it accepts: ${storyTestCommandAcceptCommand(workflow, record.id)}, or from the decision list (/sf-decide ${id}).${repinWords(record.repin)}`
      : record.id
        ? `Requested ${record.id}: ${record.phase} runs ${JSON.stringify(record.command.argv)} (${record.command.result.adapter} ${record.command.result.path}) for this Story once a person who approves it accepts: ${storyTestCommandAcceptCommand(workflow, record.id)}, or from the decision list (/sf-decide ${id}).`
        : repinned?.removed ? `Accepted ${accept}: ${repinned.commandId} no longer runs for this Story, and its removal is no longer refused. Publish the step again.`
        : repinned ? `Accepted ${accept}: the next gate run of ${repinned.commandId} records it as the Story's pin. Publish the step again.`
          : accept ? `Accepted ${accept}: it runs at every publication and submission of ${record.phase}, and its tests must pass. Publish the step again.`
            : `Revoked ${revoke}: ${record.phase} no longer runs it.`);
    console.log(reused ? `Reused existing ${record.id}; no new request, decision, commit or push.`
      : publication.pushed ? `Decision committed and pushed.`
        : `Decision committed locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.test-command', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: reused ? noop('decision.test-command.reused', { request: record.id })
      : succeeded('decision.test-command.succeeded', { record: record.id ? `request ${record.id}` : `the ${accept ? 'acceptance' : 'revocation'} of ${recordId}` }),
    effects: effects({ stateChanged: !reused, filesChanged: !reused, publicationCreated: !reused }),
    next: record.id ? [action({ id: 'decision.test-command.review', command: `singularity-flow decisions ${id} --json`, rank: 'NOW', kind: 'review',
      label: 'Review the exact request and required human authority. Copilot can explain the decision; it cannot accept it.' }),
    action({ id: 'decision.test-command.accept', command: storyTestCommandAcceptCommand(workflow, record.id), rank: 'SOON', kind: 'review',
      label: `A person who approves ${record.phase} accepts the requested command in their own terminal; an agent never accepts it.` })] : [],
    data: { commit: publication?.sha ?? null, pushed: publication?.pushed ?? false, reused, record }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
