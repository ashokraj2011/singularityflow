/** CLI correction flags, terminal presentation and legacy output. Native writes use the SDK registry. */
import {createGitEngine} from '../engine-compatibility/git-publication.mjs';
import {captureTerminalActionAuthorization,consumeActionAuthorization} from '../action-authorization.mjs';
import {commandResult,effects,noEffects,succeeded} from '../narration/command-result.mjs';
import {emitCommandResult} from '../narration/emit.mjs';
import {optionBoolean,optionString,optionStrings,SingularityFlowError} from '../util.mjs';
import {PLAN_CORRECTION_FLAGS as FLAGS} from '../command-skills.mjs';

function refused(message, details = undefined) {
  throw new SingularityFlowError(message, { code: 'PLAN_ROW_CORRECTION_INVALID', ...(details ? { details } : {}) });
}

function list(value) {
  return String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function pair(entry, flag, separator = '=', value = 'path') {
  const at = String(entry).indexOf(separator);
  if (at < 1) refused(`${flag} must be <clause>${separator}<${value}>; got '${entry}'.`);
  return [String(entry).slice(0, at).trim(), String(entry).slice(at + 1).trim()];
}

export function planCorrectionRequested(options) {
  return FLAGS.some((flag) => optionStrings(options, flag).length);
}

/** The operations named on the command line, in the order the flags list them. */
export function planCorrectionOperations(options) {
  const rows = optionStrings(options, 'add-row');
  const rowFields = { tests: optionStrings(options, 'test').flatMap(list), fulfillment: optionString(options, 'fulfillment'),
    steps: list(optionString(options, 'steps')), observableResult: optionString(options, 'observable-result') };
  const usesRowFields = rowFields.tests.length || rowFields.fulfillment || rowFields.steps.length || rowFields.observableResult;
  if (usesRowFields && rows.length !== 1) {
    refused('--test, --fulfillment, --steps and --observable-result describe one new row; name exactly one --add-row.');
  }
  return [
    ...rows.map((entry) => {
      const [clauseId, paths] = String(entry).includes('=') ? pair(entry, '--add-row') : [String(entry).trim(), ''];
      return { op: 'add-row', clauseId, expectedPaths: list(paths), ...rowFields };
    }),
    // Before tests and paths, so they correct the row as the new fulfillment reads it.
    ...optionStrings(options, 'set-fulfillment').map((entry) => {
      const [clauseId, fulfillment] = pair(entry, '--set-fulfillment', '=', 'fulfillment');
      return { op: 'set-fulfillment', clauseId, fulfillment };
    }),
    ...optionStrings(options, 'add-test').map((entry) => {
      const [clauseId, test] = pair(entry, '--add-test');
      return { op: 'add-test', clauseId, test };
    }),
    ...optionStrings(options, 'remove-test').map((entry) => {
      const [clauseId, test] = pair(entry, '--remove-test');
      return { op: 'remove-test', clauseId, test };
    }),
    ...optionStrings(options, 'replace-test').map((entry) => {
      const [clauseId, change] = pair(entry, '--replace-test');
      const [from, to] = pair(change, '--replace-test <clause>=<from>', ':');
      return { op: 'replace-test', clauseId, from, to };
    }),
    ...optionStrings(options, 'remove-location').map((entry) => {
      const [clauseId, file] = pair(entry, '--remove-location');
      return { op: 'remove-location', clauseId, path: file };
    }),
    ...optionStrings(options, 'replace-location').map((entry) => {
      const [clauseId, change] = pair(entry, '--replace-location');
      const [from, to] = pair(change, '--replace-location <clause>=<from>', ':');
      return { op: 'replace-location', clauseId, from, to };
    })
  ];
}

/** The old helper signature remains accepted; its supplied aggregate is never storage authority. */
export async function runPlanCorrection({root,workflow:prior=null,workId=null,options},{
  capture=captureTerminalActionAuthorization,consume=consumeActionAuthorization
}={}) {
  const operation=optionBoolean(options,'dry-run')?'plan.correction.preview':'plan.correct';
  const binding=createGitEngine({root,planCorrectionInteraction:{capture,consume,prepare:()=>{
    if(optionStrings(options,'add-location').length||optionStrings(options,'add-supporting').length)
      refused('Record a plan correction and a narrow amendment as two decisions.');
    // The legacy flag parser represents absent optional row fields as undefined. The SDK's
    // semantic request uses their installed JSON representation, where those fields are omitted.
    return {ownerPhase:optionString(options,'owner')??null,operations:JSON.parse(JSON.stringify(planCorrectionOperations(options))),
      reason:optionString(options,'reason')??'',upstreamIssue:optionString(options,'upstream-issue')??null};
  }}});
  const receipt=await binding.engine.run(operation,{workId:workId??prior?.workItem?.id??null,fetch:optionBoolean(options,'fetch')});
  const {workflow}=binding.presentation(),id=receipt.subject.id,reviewed=receipt.review,groups=reviewed.authorityGroups;
  const owner={id:reviewed.ownerPhase,generation:reviewed.ownerGeneration},correction={operations:reviewed.operations};
  if (receipt.status==='ready-to-review') {
    emitCommandResult(commandResult({
      operation: { id: 'decision.plan', classification: 'mutation' }, subject: { kind: 'story', id },
      outcome: succeeded('decision.plan.correction-previewed', { owner: owner.id, operations: String(correction.operations.length) }),
      effects: noEffects(),
      data: { dryRun: true, previewSha256: reviewed.previewSha256, ownerPhase: owner.id, ownerGeneration: owner.generation,
        operations: correction.operations, authorityGroups: groups }
    }), { json: optionBoolean(options, 'json'), postState: workflow });
    return;
  }
  if (receipt.status==='cancelled') {
    emitCommandResult(commandResult({
      operation: { id: 'decision.plan', classification: 'mutation' }, subject: { kind: 'story', id },
      outcome: succeeded('decision.plan.correction-cancelled', { owner: owner.id }), effects: noEffects(), data: { cancelled: true }
    }), { json: optionBoolean(options, 'json'), postState: workflow });
    return;
  }
  const recorded=receipt.record,publication={sha:receipt.revision,pushed:receipt.effects.pushed};
  emitCommandResult(commandResult({
    operation: { id: 'decision.plan', classification: 'mutation' }, subject: { kind: 'story', id },
    outcome: succeeded('decision.plan.corrected', { correction: recorded.id, owner: owner.id, operations: String(recorded.operations.length) }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, correction: recorded }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
