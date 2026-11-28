/**
 * The acts of a change the person asks for in a code step that already finished (completed-step-change.mjs holds the rules):
 * `phase rollover <code step> [--reason TEXT]` previews going back to it, asks the person "Start version 2 of Implement for this
 * change?", and only on their yes returns the Story to the code step with their words as the change
 * request and starts its next version for them, in the opening's own commit. Loaded only by `phase rollover`.
 *
 * One yes, never two: the version opens with that yes, recorded as settled on it (`person-change`, the person's own words
 * as its evidence), as a person's own return of failing tests starts the version it asked for (failing-tests-opening.mjs).
 */
import { createHash } from 'node:crypto';

import { stepEntryCommand, versionPreviewArgv, versionPreviewRoute, versionQuestionRoute } from './action-command-map.mjs';
import { PERSON_CHANGE, completedChangeQuestion, completedCodeStepForChange, stepName } from './completed-step-change.mjs';

const clean = (value, maximum = 600) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum);

/** What the person asked to change in `code`, waiting to be accounted for, in the order typed; `--reason` words join them once. */
async function requestsFor(root, workflow, code, reason) {
  const [{ gitDir }, askedFor, { noteRequestedChange }] = await Promise.all([import('./git.mjs'), import('./asked-for.mjs'), import('./requested-successor.mjs')]);
  const given = reason === null ? null : await noteRequestedChange(root, workflow, code, reason);
  const waiting = await askedFor.waitingWords(gitDir(root), workflow, code);
  return { given, requests: [...new Set([...waiting, ...(given && askedFor.typedFocusOff(workflow) ? [given] : [])])] };
}

/** The value the person confirms: the code step, the step the Story is on, and the words that ask for the change. */
function confirmationOf(workflow, code, requests) {
  const current = workflow.phases[workflow.currentPhase];
  return `sha256:${createHash('sha256').update(JSON.stringify({ kind: PERSON_CHANGE, workId: workflow.workItem.id, phase: code.id,
    generation: Number(code.generation), current: { phase: current.id, generation: Number(current.generation ?? 0), status: current.status },
    requests })).digest('hex')}`;
}

/**
 * `phase rollover <code step>` for a finished code step: preview, ask and, on the person's yes, go back and open its next
 * version. Refuses with the step's own route when the change is not this one's to make.
 */
export async function completedStepChangeRollover(root, config, workflow, code, options) {
  const [{ optionBoolean, optionString, SingularityFlowError }, opening, { safeCommandGuidance }, { printCommandRoutes }, { typedFocusOff }] = await Promise.all([
    import('./util.mjs'), import('./commands/phase-opening.mjs'), import('./safe-command-guidance.mjs'), import('./commands/shared/print-command-routes.mjs'),
    import('./asked-for.mjs')]);
  const current = workflow.phases[workflow.currentPhase];
  if (completedCodeStepForChange(workflow, { named: code.id })?.id !== code.id) throw new SingularityFlowError(
    `${stepName(code)} finished, and a person approved it or a step after it, so this change is sent back by ${stepName(current)}'s approvers.`,
    { code: 'COMPLETED_STEP_CHANGE_UNAVAILABLE', details: { phase: code.id, nextAction: (await opening.kernelRoute(root, workflow, current, { config })).route } });
  const reason = optionString(options, 'reason', null);
  const { given, requests } = await requestsFor(root, workflow, code, reason);
  if (reason !== null && given === null) throw new SingularityFlowError('--reason needs the words that say what to change; nothing was left after redaction.', {
    code: 'GENERATION_CHANGE_REASON_REQUIRED' });
  // The step's own preview route, from the one action-to-command map: its work command and `phase rollover <step> --json`.
  const own = versionPreviewRoute(workflow, code);
  const skill = own.skill;
  if (!requests.length) throw new SingularityFlowError(
    `${stepName(code)} version ${code.generation} finished. Say what to change: ${skill} ${code.id} <what to change>.`,
    { code: 'GENERATION_CHANGE_NOT_REQUESTED', details: { phase: code.id, generation: code.generation,
      nextAction: { ...versionQuestionRoute(workflow, code), label: `Say what to change in ${stepName(code)}` } } });
  const confirmation = confirmationOf(workflow, code, requests);
  // The proposal the person answers: the code step's next version, bound to the Story as it stands now [OSA §7.1].
  const proposed = await opening.proposalNow(root, workflow, code, { reason: 'requested-change', confirmation });
  const question = completedChangeQuestion(workflow, code, proposed.proposal.version);
  const confirmArgv = [...versionPreviewArgv(code.id), ...(given && typedFocusOff(workflow) ? ['--reason', given] : []), '--confirm', confirmation];
  const route = safeCommandGuidance({ argv: confirmArgv, skill });
  const preview = { schemaVersion: 1, resultType: 'sflow-generation-rollover', kind: PERSON_CHANGE, workId: workflow.workItem.id, phase: code.id,
    fromGeneration: Number(code.generation), toGeneration: proposed.proposal.version, question, confirmation,
    returnsFrom: { phase: current.id, generation: Number(current.generation ?? 0), status: current.status },
    requestedChange: { requests, keptAs: typedFocusOff(workflow) ? 'this command only' : `typed words of version ${proposed.proposal.version} ("Asked for" once it is prepublished)` },
    preserved: `${stepName(code)} version ${code.generation}, its evidence and its test results stay as published.`,
    command: route?.command ?? null, executable: route?.executable ?? null, argv: route?.argv ?? null, skill: route?.skill ?? null,
    copilotCommand: route?.copilotCommand ?? null, platformCommands: route?.platformCommands ?? null,
    nextAction: route ? { command: route.command, copilotCommand: route.copilotCommand,
      reason: `Show the person what they asked to change, then ask "${question}" once; run this on their Yes. Never ask twice.` } : null,
    mutates: false };
  let supplied = optionString(options, 'confirm');
  let typed = false;
  if (!supplied) {
    // Kept here, sealed, so the hook that hears the person's answer binds it to this exact proposal.
    await opening.recordPreview(root, { ...proposed, question, confirmation });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(preview, null, 2));
    console.log(`Go back to ${stepName(code)} for a change (version ${code.generation} stays as published):`);
    for (const request of requests) console.log(`  · "${clean(request, 400)}"`);
    if (await opening.askAtTerminal(question)) { supplied = confirmation; typed = true; }
    else {
      console.log(question);
      printCommandRoutes(safeCommandGuidance({ argv: confirmArgv.slice(0, confirmArgv.indexOf('--confirm')), skill }),
        { label: 'To start it, run this in your own terminal, which asks you to confirm, or ask Copilot' });
      return console.log('Nothing was changed.');
    }
  }
  await opening.staleRollover(supplied, confirmation,
    'The confirmation is not the current one: what was asked for or the Story changed since the preview. Preview again (its JSON carries the current confirmation).', preview);
  // The person's yes, as it reached SFlow: their answer to the question tool, the /sf-confirm code, or their own terminal.
  const { principal, receipt } = await opening.consentFor(root, workflow, { ...proposed, question, typed });
  if (!receipt) throw new SingularityFlowError(`Nothing was changed: the person's yes did not reach SFlow. Ask them the question with your question tool, then run this again.`,
  { code: 'VERSION_CONSENT_REQUIRED', details: { phase: code.id, version: proposed.proposal.version, question, nextAction: own } });
  const opened = await goBack(root, config, workflow, code, { requests, receipt, principal, skill });
  // The yes opened this, once: it is never met again for another opening.
  const directories = (await import('./story-version-acceptance.mjs')).gitDirectories(root);
  if (directories) await (await import('./story-version-consent.mjs')).dropGrant(directories.commonDir, proposed.digest);
  const value = { ...preview, mutates: true, ...opened.data };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(value, null, 2));
  console.log(opened.line);
}

/** The return and the version start, on the person's yes: their words are the change request, their yes the version's start. */
async function goBack(root, config, workflow, code, { requests, receipt, principal, skill }) {
  const workId = workflow.workItem.id;
  const current = workflow.phases[workflow.currentPhase];
  const from = { phase: current.id, generation: Number(current.generation ?? 0), code: Number(code.generation) };
  const [{ transactStory, rejectPhase, actorKey }, { LIFECYCLE_EVENT }, { loadAcceptedStoryExecution }, { actionActor }, opening] = await Promise.all([
    import('./state-stores.mjs'), import('./lifecycle-event.mjs'), import('./accepted-story-execution.mjs'), import('./git.mjs'), import('./commands/phase-opening.mjs')]);
  const actor = principal ?? actionActor(root);
  const assurance = receipt.principal?.assurance ?? 'person-consent';
  const surface = receipt.response?.surface ?? 'their answer';
  const words = clean(`The person asked for a change after ${stepName(code)} version ${code.generation} had finished: ${requests.map((request) => `"${clean(request, 400)}"`).join('; ')}`, 1800);
  const { value: returned } = await transactStory(root, config, workflow,
    { type: LIFECYCLE_EVENT.PHASE_REJECTED, phaseId: current.id, generation: current.generation, actor, agent: null, authorityGroup: null,
      payload: { targetPhaseId: code.id, personChange: true } },
    `[${workId}][phase:${current.id}][reject] the person's change goes back to ${code.id}`,
    (aggregate) => rejectPhase(root, config, aggregate, { phaseId: current.id, target: code.id, reason: words, actor, agent: null,
      personChange: { assurance } }),
    { eventFromResult: (transition) => ({ actor, agent: null, authorityGroup: null, identityAssurance: assurance,
      payload: { targetPhaseId: code.id, changeRequestId: transition.changeRequest.id, personChange: true } }) });
  const changeRequest = returned.changeRequest?.id ?? null;
  const reloaded = (await loadAcceptedStoryExecution(root, workId));
  // The session follows the Story back to the code step, with its agent, as after any return (reject's own activation).
  await (await import('./session.mjs')).activateWorkItemSession(root, reloaded.config, reloaded.workflow).catch(() => null);
  const back = reloaded.workflow.phases[code.id];
  const proposed = await opening.proposalNow(root, reloaded.workflow, back, { reason: await opening.successorReason(reloaded.workflow, back) });
  const next = proposed.proposal.version;
  const settlement = { kind: PERSON_CHANGE, by: 'sflow', phase: code.id,
    subject: `${code.id} version ${from.code}: the person's change after it finished`,
    answer: `Went back to ${stepName(code)} and started version ${next} for the change the person asked for`,
    evidence: [
      { what: `the person asked: ${clean(requests[0], 400)}${requests.length > 1 ? ` (and ${requests.length - 1} more)` : ''}`, where: `${code.id} asked for` },
      { what: `the person said yes to "Start version ${next} of ${stepName(code)} for this change?" (${surface})`, where: `${current.id} change requests (${changeRequest})` }
    ],
    effect: { generation: from.code, toGeneration: next, fromPhase: from.phase, fromGeneration: from.generation, changeRequest, byPerson: changeRequest } };
  let started = null;
  try {
    const result = await opening.openSuccessor(root, reloaded.config, reloaded.workflow, back, { ...proposed,
      settled: { kind: PERSON_CHANGE, settlement, actor: actorKey(actor) }, open: opening.codeOpening(root, reloaded.config) });
    started = { generation: next, settled: result.settled ? { id: result.settled.id, kind: PERSON_CHANGE } : null, opening: result.outcome ?? null };
  } catch (error) {
    // The return stands: the version is then the person's yes again, as after any return.
    const after = (await loadAcceptedStoryExecution(root, workId));
    return { line: `Went back to ${stepName(code)} for your change. Its version ${next} could not start on its own (${clean(error?.message, 300)}), so start it with ${skill} ${code.id}.`,
      data: { returned: true, changeRequest, opened: null, nextAction: (await opening.kernelRoute(root, after.workflow, after.workflow.phases[code.id])).route } };
  }
  const after = await loadAcceptedStoryExecution(root, workId);
  const nextAction = (await opening.kernelRoute(root, after.workflow, after.workflow.phases[code.id], { config: after.config })).route;
  return { line: `Went back to ${stepName(code)} and started version ${next} for your change. ${stepName(code)} version ${from.code} stays as published; ${stepName(current)} runs again after it. Make the change now with ${skill} ${code.id}.`,
    data: { returned: true, changeRequest, opened: { phase: code.id, generation: next, status: 'open' }, settled: started.settled, opening: started.opening,
      next: { command: stepEntryCommand(code.id, workId), copilotCommand: `${skill} ${code.id}`,
        reason: `Make the change in ${stepName(code)} version ${next} now, in this same turn: refresh the entry once and write it; its tests run again before it is published.` },
      nextAction } };
}
