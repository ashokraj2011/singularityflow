/** Pure decision answer validation, authority selection and stable plan batching. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {MAX_PLAN_AMENDMENT_CHANGES,DECISION_CAUSE_LIMITS as CAUSE} from './decision-limits.mjs';
import {isVisualVerificationPhase} from './phase-policy.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {decisionAfter,decisionOutcomeFacts,pendingDecisionPayload,reopenableSteps} from './workflow-decisions.mjs';
function refused(message, code, details = undefined) {
  throw new SingularityFlowError(message, {code, ...(details ? {details} : {})});
}

/** A question is interpreted from pinned rules; a surface's echoed options confer no authority. */
export function decisionContextSelection(workflow) {
  const workId=workflow.workItem.id,pending=workflow.pendingDecision??null;
  if(pending===null)return {workId,phase:null,question:null};
  const phase=Object.hasOwn(workflow.phases,pending.after)?workflow.phases[pending.after]:null;
  if(workflow.status!=='in_progress'||!phase||phase.status!=='approved'||workflow.currentPhase!==phase.id
    ||!Number.isSafeInteger(phase.generation)||phase.generation<1||!decisionAfter(workflow,phase.id)
    ||typeof pending.key!=='string'||!/^[a-f0-9]{16}$/u.test(pending.key))refused(
    'The pending decision is not bound to the approved current phase.','DECISION_STATE_INVALID');
  const outcome=decisionOutcomeFacts(workflow,phase),{key,...payload}=pending;
  if(outcome?.kind!=='pause'||canonicalJson(payload)!==canonicalJson(pendingDecisionPayload(workflow,phase,outcome,{at:pending.askedAt})))refused(
    'The pending question differs from the pinned decision.','DECISION_STATE_INVALID');
  return {workId,phase:phase.id,question:{...structuredClone(pending),generation:phase.generation,
    reopenableSteps:reopenableSteps(workflow,pending)}};
}

/** The host supplies observed provenance; wording, command rendering and human answers stay outside. */
export function decisionContextManifest(binding,facts) {
  const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
  const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
  if(!exact(facts,['workId','phase','revision','pendingKey','proof'])||facts.workId!==binding.workId||facts.phase!==binding.phase
    ||typeof facts.revision!=='string'||!facts.revision||facts.revision.length>2048
    ||facts.pendingKey!==(binding.question?.key??null)
    ||(binding.question===null?facts.proof!==null:!exact(facts.proof,['generation','reviewPacketSha256','approvalSha256'])
      ||facts.proof.generation!==binding.question.generation||!digest(facts.proof.reviewPacketSha256)||!digest(facts.proof.approvalSha256)))refused(
    'The decision context port returned differently bound provenance.','ENGINE_PORT_RESULT_INVALID');
  return {schemaVersion:1,contract:'sflow-workflow-decision-context/v1',workId:binding.workId,phase:binding.phase,
    observedRevision:facts.revision,question:structuredClone(binding.question),proof:structuredClone(facts.proof)};
}

/** Installed upstream admission: a list may inspect a closed Story; mutations require it open. */
export function upstreamOperationAdmission(operation, workflow) {
  const workId=workflow.workItem.id;
  if(operation!=='upstream.list'&&workflow.status!=='in_progress')refused(
    `Story ${workId} is ${workflow.status}; upstream issues are raised and decided while it is in progress.`,
    'UPSTREAM_ISSUE_STORY_CLOSED');
  return {workId,phase:workflow.currentPhase??null,
    phases:Object.fromEntries(Object.entries(workflow.phases??{}).map(([id,phase])=>[id,{
      generation:Number(phase.generation??0),groups:[...new Set([...(phase.approvalPolicy?.authorities??[]),
        ...(phase.approvalPolicy?.requiredAuthorities??[])])].sort()}])),
    issues:(workflow.upstreamIssues??[]).map(({id,phase})=>({id,phase})),
    amendments:(workflow.forwardAmendments??[]).map(({id,phase,fromGeneration})=>({id,phase,fromGeneration}))};
}

/** Request defaults and exact amendment confirmation; native owners validate records and authority. */
export function upstreamOperationRequest(operation,input) {
  if(operation==='upstream.list')return {open:input.open===true};
  if(operation==='upstream.raise')return {fromArtifact:input.fromArtifact===true,phaseId:input.phaseId??null,
    about:input.about??null,problem:input.problem??null,assumption:input.assumption??null,impact:input.impact??null,
    proposed:input.proposed??null,authored:input.authored??null,supersedes:input.supersedes??null};
  if(operation==='upstream.decide')return {issueId:input.issueId??'',outcome:input.outcome??null,
    reason:input.reason??'',link:input.link??null,expires:input.expires??null};
  if(operation==='forward-amendment.propose')return {phaseId:input.phaseId??null,reason:input.reason??null,
    file:input.file??null,upstreamIssue:input.upstreamIssue??null};
  if(operation==='forward-amendment.decide') {
    const amendmentId=input.amendmentId??'';
    if(input.confirmation!==amendmentId)refused(`Confirm the exact amendment: --confirm ${amendmentId}.`,
      'FORWARD_AMENDMENT_CONFIRMATION_REQUIRED');
    return {amendmentId,decision:input.decision??null,reason:input.reason??null,confirmation:input.confirmation};
  }
  if(operation==='forward-amendment.revalidate')return {phaseId:input.phaseId??'',amendmentId:input.amendmentId??null,
    outcome:input.outcome??null,reason:input.reason??null};
  refused('The upstream operation is unavailable.','ENGINE_OPERATION_UNSUPPORTED');
}

/** Existing standalone admission, shared by every host before it prepares a human request. */
export function standaloneDecisionAdmission(operation, workflow) {
  const workId = workflow.workItem.id;
  if (operation === 'decision.choose') {
    if (!workflow.pendingDecision) refused(
      `Story ${workId} is not waiting for a decision. See its decisions with singularity-flow decision show ${workId}.`,
      'DECISION_NOT_PENDING');
    return {workId, phase:workflow.pendingDecision.after ?? null};
  }
  const closed = {
    'decision.scope':['SCOPE_STORY_CLOSED', `Story ${workId} is ${workflow.status}; its scope is decided while it is in progress.`],
    'decision.completeness':['SCOPE_STORY_CLOSED', `Story ${workId} is ${workflow.status}; its scope is reviewed while it is in progress.`],
    'decision.applicability':['APPLICABILITY_STORY_CLOSED', `Story ${workId} is ${workflow.status === 'closed' ? 'already closed' : workflow.status}; applicability is decided while it is in progress.`],
    'conformance.decide':['ENGINE_CONFORMANCE_NOT_CURRENT', 'Decide conformance gaps while the Story is in progress.'],
    'decision.risk':['RISK_STORY_CLOSED', `Story ${workId} is ${workflow.status}; risks are decided while it is in progress.`],
    'decision.plan':['PLAN_AMENDMENT_STORY_CLOSED', `Story ${workId} is ${workflow.status}; its plan is amended while it is in progress.`],
    'plan.correction.preview':['PLAN_AMENDMENT_STORY_CLOSED', `Story ${workId} is ${workflow.status}; its plan is amended while it is in progress.`],
    'plan.correct':['PLAN_AMENDMENT_STORY_CLOSED', `Story ${workId} is ${workflow.status}; its plan is amended while it is in progress.`],
    'decision.witness':['WITNESS_STORY_CLOSED', `Story ${workId} is ${workflow.status}; witnesses are recorded while it is in progress.`],
    'decision.witness-exception':['WITNESS_EXCEPTION_STORY_CLOSED', `Story ${workId} is ${workflow.status}; reopen it at its final step to renew a witness exception.`],
    'decision.test-risk':['RISK_STORY_CLOSED', `Story ${workId} is ${workflow.status}; risks are decided while it is in progress.`],
    'decision.test-narrowing':['TEST_NARROWING_CLOSED', `Story ${workId} is ${workflow.status}; narrowed runs are decided while it is in progress.`],
    'decision.evidence-reuse':['EVIDENCE_REUSE_STORY_CLOSED', `Story ${workId} is ${workflow.status}; evidence reuse is decided while it is in progress.`],
    'decision.visual-profile':['VISUAL_PROFILE_STORY_CLOSED', `Story ${workId} is ${workflow.status}; which screen sizes apply is decided while it is in progress.`],
    'test-command.request':['TEST_COMMAND_DECISION_CLOSED', `Story ${workId} is ${workflow.status}; its test commands are decided while it is in progress.`],
    'test-command.decide':['TEST_COMMAND_DECISION_CLOSED', `Story ${workId} is ${workflow.status}; its test commands are decided while it is in progress.`]
  }[operation];
  if (!closed) refused('The standalone decision operation is unavailable.', 'ENGINE_OPERATION_UNSUPPORTED');
  if (workflow.status !== 'in_progress') refused(closed[1], closed[0]);
  return {workId, phase:workflow.currentPhase ?? null};
}

/** Normalize domain values only; identity, policy and publication are never request fields. */
export function standaloneDecisionRequest(operation, input) {
  const reason = input.reason ?? '';
  if (operation === 'decision.scope') {
    const item = input.item ?? null, disposition = input.disposition ?? null;
    if (!item || !disposition) refused(
      'Name the item with --item <SRI-...|DOC-...> and the disposition with --as <included|existing|excluded|deferred|informative|duplicate|superseded>.',
      'SCOPE_DECISION_INCOMPLETE');
    return {item, disposition, clauseIds:input.clauseIds ?? [], reason};
  }
  if (operation === 'decision.applicability') {
    if (!input.responsibility) refused(
      'Name the responsibility with --responsibility <scope|plan|implement|verify|review>.',
      'APPLICABILITY_RESPONSIBILITY_REQUIRED');
    return {responsibility:input.responsibility, reason};
  }
  if (operation === 'decision.risk') {
    const revoke = input.revoke ?? null, obligationId = input.obligationId ?? null;
    if (!revoke === !obligationId) refused(
      'Name an obligation with --obligation OBL-..., or a decision to revoke with --revoke RISK-...',
      'RISK_DECISION_INVALID');
    return {obligationId, revoke, category:input.category ?? null, transitions:input.transitions ?? ['terminal'],
      expires:input.expires ?? null, reason};
  }
  if (operation === 'decision.completeness') return {confirm:input.confirm ?? null,
    checklist:input.checklist ?? [], reason};
  if(operation==='conformance.decide')return {phaseId:input.phaseId??null,expected:input.expected??null,clauseId:input.clauseId??null,
    ownerPhase:input.ownerPhase??null,outcome:input.outcome??null,expires:input.expires??null,reason};
  if(operation==='decision.plan')return {changes:input.changes??[],reason};
  if(operation==='plan.correction.preview'||operation==='plan.correct')return {ownerPhase:input.ownerPhase??null,
    operations:input.operations??[],reason,upstreamIssue:input.upstreamIssue??null};
  if (operation === 'decision.choose') return {option:input.option ?? null, to:input.to ?? null,
    expected:input.expected ?? null, reason};
  if(operation==='decision.witness')return {clauseId:String(input.clauseId??'').toUpperCase(),slotName:input.slotName??'',
    file:input.file??'',answers:input.answers??{},reason,expectedContext:input.expectedContext??null,expectedFile:input.expectedFile??null};
  if(operation==='decision.witness-exception') {
    if(!input.phaseId||!/^sha256:[a-f0-9]{64}$/u.test(input.mappingSha256??''))refused(
      'Name the step and the exact exception with --phase STEP --mapping sha256:... (the final check lists both).',
      'WITNESS_EXCEPTION_RENEWAL_INVALID');
    return {phaseId:input.phaseId,mappingSha256:input.mappingSha256,expires:input.expires??null,reason};
  }
  if (operation === 'decision.evidence-reuse') return {phaseId:input.phaseId ?? null,attemptId:input.attemptId ?? null,
    revoke:input.revoke ?? null,expires:input.expires ?? null,reason};
  if (operation === 'decision.visual-profile') return {phaseId:input.phaseId ?? null,profileId:input.profileId ?? null,
    notApplicable:input.notApplicable === true,revoke:input.revoke ?? null,reason};
  if (operation === 'decision.test-narrowing') return {phaseId:input.phaseId ?? null,commandId:input.commandId ?? null,
    revoke:input.revoke ?? null,expires:input.expires ?? null,reason};
  if (operation === 'decision.test-risk') return {phaseId:input.phaseId ?? null,commandId:input.commandId ?? null,
    argvSha256:input.argvSha256 ?? null,causeClass:input.causeClass ?? null,cause:input.cause ?? '',
    revoke:input.revoke ?? null,expires:input.expires ?? null,reason};
  if (operation === 'test-command.request') {
    if (!input.phaseId || [input.command,input.suggestionId,input.repinId].filter(Boolean).length !== 1) refused(
      'A test-command request names one phase and exactly one explicit command, inspected suggestion or current pin.',
      'TEST_COMMAND_DECISION_INVALID');
    if (input.repinId && input.sourceRoots?.length) refused('A re-pin uses the command as the gate resolves it now.', 'TEST_COMMAND_DECISION_INVALID');
    return {phaseId:input.phaseId,command:input.command ?? null,suggestionId:input.suggestionId ?? null,
      sourceRoots:input.sourceRoots ?? [],repinId:input.repinId ?? null,reason};
  }
  if (operation === 'test-command.decide') {
    const accept=input.accept ?? null,revoke=input.revoke ?? null;
    if (!accept === !revoke) refused('Accept or revoke exactly one existing test-command request.', 'TEST_COMMAND_DECISION_INVALID');
    return {accept,revoke,reason};
  }
  refused('The standalone decision operation is unavailable.', 'ENGINE_OPERATION_UNSUPPORTED');
}

/** Select a target from native, presence-checked lookup facts; no files, identity or command execution. */
export function resolveTestEvidenceIntent(operation, workflow, input, {target=null,causeCategory=null}={}) {
  if(!['decision.evidence-reuse','decision.visual-profile','decision.test-narrowing','decision.test-risk'].includes(operation)) {
    refused('The test-evidence decision operation is unavailable.','ENGINE_OPERATION_UNSUPPORTED');
  }
  const id=workflow.workItem.id, revoke=input.revoke, requestedPhase=input.phaseId;
  if (operation === 'decision.evidence-reuse') {
    if (!revoke === !requestedPhase || revoke && (input.attemptId || input.expires)) refused(
      'Name the step with --phase PHASE --from-attempt TA-..., or a decision to revoke with --revoke ERU-...', 'EVIDENCE_REUSE_INVALID');
    if (!revoke && !input.attemptId) refused("Name the recorded run to reuse with --from-attempt TA-... (an earlier step's retained attempt).", 'EVIDENCE_REUSE_INVALID');
    if (revoke && (!target || target.id!==revoke)) refused(`This Story has no evidence-reuse decision ${revoke}.`, 'EVIDENCE_REUSE_UNKNOWN');
    const phaseId=revoke?target.phase:requestedPhase;
    if (!workflow.phases?.[phaseId] || workflow.phases[phaseId].status==='skipped') refused(
      `Story ${id} has no step ${phaseId} that is on its route.`, 'EVIDENCE_REUSE_INVALID');
    return {...input,phaseId};
  }
  if (operation === 'decision.visual-profile') {
    if (revoke?Boolean(requestedPhase || input.profileId || input.notApplicable):!(requestedPhase && input.profileId && input.notApplicable)) refused(
      'Name the step and the profile that does not apply with --phase VISUAL-STEP --profile PROFILE-ID --not-applicable, or a decision to revoke with --revoke VPD-...', 'VISUAL_PROFILE_DECISION_INVALID');
    if (revoke && (!target || target.id!==revoke)) refused(`This Story has no visual-profile decision ${revoke}.`, 'VISUAL_PROFILE_DECISION_UNKNOWN');
    const phaseId=revoke?target.phase:requestedPhase,phase=workflow.phases?.[phaseId];
    if (!phase || phase.status==='skipped' || !isVisualVerificationPhase(phase)) refused(
      `Story ${id} has no visual verification step ${phaseId} on its route (a step whose artifact is visual-test-evidence).`, 'VISUAL_PROFILE_DECISION_INVALID');
    const {notApplicable,...request}=input;
    return {...request,phaseId};
  }
  const narrowing=operation==='decision.test-narrowing';
  const invalid=narrowing?'TEST_NARROWING_INVALID':'TEST_RUN_RISK_INVALID';
  if (!revoke === !requestedPhase) refused(`Name the step with --phase PHASE, or a decision to revoke with --revoke ${narrowing?'TNR':'TRR'}-...`,invalid);
  if (revoke && (!target || target.id!==revoke)) refused(
    `This Story has no ${narrowing?'test-narrowing':'test-run risk'} decision ${revoke}.`,narrowing?'TEST_NARROWING_UNKNOWN':'TEST_RUN_RISK_UNKNOWN');
  const phaseId=revoke?target.phase:requestedPhase;
  if (!workflow.phases?.[phaseId]) refused(`Story ${id} has no step ${phaseId}.`,invalid);
  if (!narrowing) {
    if (input.argvSha256!==null && (revoke || !input.commandId || !/^[a-f0-9]{64}$/u.test(input.argvSha256))) refused(
      '--argv-sha256 takes the 64-character digest a refusal named, with --phase and --command.',invalid);
    if (input.causeClass!==null && (revoke || causeCategory!=='environment')) refused(
      '--cause-class takes the environment cause class a refusal named, with --phase.',invalid);
  }
  return {...input,phaseId};
}

/** The policy data a planner consumes; host commands and display-only authority prose stay out. */
export function decisionPolicyPacket(packet) {
  const item = entry => ({id: entry.id, kind: entry.kind, title: entry.title,
    options: entry.options.map(option => ({id: option.id, label: option.label,
      recordable: option.recordable !== false, needs: option.needs ?? {}, effects: option.effects ?? [],
      decidedBy: {allowed: option.decidedBy?.allowed === true, groups: option.decidedBy?.groups ?? []}}))});
  return {workId: packet.workId, phase: packet.phase ?? null, packetSha256: packet.packetSha256,
    items: packet.items.map(item), offered: (packet.offered ?? []).map(item)};
}

export function assertDecisionConfirmation(expected, actual) {
  if (actual == null) refused('Recording decisions requires confirmation of the exact reviewed list.',
    'DECISIONS_CONFIRMATION_REQUIRED', {packetSha256: expected});
  if (typeof actual !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(actual)) {
    refused('Decision confirmation must be an exact SHA-256 digest.', 'DECISIONS_OPTIONS_INVALID');
  }
  if (actual !== expected) refused('The decision list changed after it was reviewed. Review the current list again.',
    'DECISIONS_PACKET_CHANGED', {expected, confirmed: actual});
}

function validDate(value, at, latest) {
  const text = String(value ?? '');
  const day = /^\d{4}-\d{2}-\d{2}$/u.test(text) ? Date.parse(`${text}T00:00:00.000Z`) : Number.NaN;
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== text) return false;
  return text > String(at).slice(0, 10) && text <= latest;
}

export function parseDecisionAnswers({ choose = [], reason = [], expires = [], cause = [], clause = [], article = {} } = {}) {
  const read = (flag, values) => {
    const entries = Array.isArray(values) ? values.map((value) => {
      const text = String(value);
      const split = text.indexOf('=');
      if (split < 1) refused(`--${flag} takes <ITEM>=<VALUE>, such as d1=${flag === 'choose' ? 'reuse' : 'TEXT'}; got '${text}'.`, 'DECISIONS_ANSWER_INVALID');
      return [text.slice(0, split).trim(), text.slice(split + 1)];
    }) : Object.entries(values ?? {}).map(([item, value]) => [item, String(value)]);
    const map = new Map();
    for (const [item, value] of entries) {
      if (!/^d\d{1,3}$/u.test(item)) refused(`--${flag} names '${item}', which is not an item of the list (d1, d2, ...).`, 'DECISIONS_ANSWER_INVALID');
      if (map.has(item)) refused(`--${flag} names ${item} twice.`, 'DECISIONS_ANSWER_INVALID');
      map.set(item, value);
    }
    return map;
  };
  const articles = new Map();
  for (const [item, value] of Object.entries(article ?? {})) {
    if (!/^d\d{1,3}$/u.test(item) || !Array.isArray(value)) refused(`The article answers name '${item}': each item of the list holds a list of { article, decision, reason }.`, 'DECISIONS_ANSWER_INVALID');
    articles.set(item, value);
  }
  return { choose: read('choose', choose), reason: read('reason', reason), expires: read('expires', expires), cause: read('cause', cause), clause: read('clause', clause), article: articles };
}

function namedClauses(item, text, known) {
  const named = String(text ?? '').split(/[\s,]+/u).filter(Boolean).map((entry) => {
    const upper = entry.toUpperCase();
    return known.find((id) => id === upper || id.endsWith(`:${upper}`)) ?? upper;
  });
  if (!named.length) refused(`Name the clauses that carry ${item.id}.`, 'DECISIONS_ANSWER_INVALID', { item: item.id });
  const unknown = known.length ? named.filter((id) => !known.includes(id)) : [];
  if (unknown.length) refused(`${item.id} names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a clause' : 'are not clauses'} of this Story. Its clauses: ${known.slice(0, 12).join(', ')}.`, 'DECISIONS_ANSWER_INVALID', { item: item.id, unknown });
  return [...new Set(named)];
}

function checkedArticles(item, given, need) {
  const answers = Array.isArray(given) ? given : [];
  const problem = need.articles.find(({ id }) => answers.filter((entry) => entry?.article === id).length !== 1)
    ? 'Answer every checklist article once'
    : answers.find((entry) => !need.decisions.includes(entry?.decision)) ? `Each article is ${need.decisions.join(', ')}`
      : answers.find((entry) => entry.decision !== 'satisfied' && !String(entry.reason ?? '').trim()) ? 'An article that is not satisfied needs its own reason'
        : answers.length !== need.articles.length ? 'Those are not this checklist\'s articles' : null;
  if (problem) refused(`${item.id}: ${problem}.`, 'DECISIONS_ANSWER_INVALID', { item: item.id, condition: 'checklist', problem });
  return answers.map(({ article, decision, reason }) => ({ article, decision, ...(decision === 'satisfied' ? {} : { reason: String(reason).trim() }) }));
}

export function decisionRecordPlan(packet, answers, { at }) {
  const steps = [];
  const refusedItems = [];
  for (const item of [...packet.items, ...(packet.offered ?? [])]) {
    const chosen = answers.choose.get(item.id);
    if (!chosen) {
      for (const flag of ['reason', 'expires', 'cause', 'clause', 'article']) {
        if (answers[flag]?.has(item.id)) refused(`--${flag} ${item.id}=... is given, but ${item.id} is not chosen with --choose.`, 'DECISIONS_ANSWER_INVALID');
      }
      continue;
    }
    const selected = item.options.find((entry) => entry.id === chosen);
    if (!selected) {
      refused(`${item.id} has no option '${chosen}'; its options are ${item.options.map((entry) => entry.id).join(', ')}.`, 'DECISIONS_ANSWER_INVALID',
        { item: item.id, options: item.options.map((entry) => entry.id) });
    }
    for (const flag of ['reason', 'expires', 'cause', 'clause', 'article']) {
      if (answers[flag]?.has(item.id) && !selected.needs[flag]) refused(`${item.id}=${chosen} takes no --${flag}.`, 'DECISIONS_ANSWER_INVALID');
    }
    if (selected.recordable === false) {
      refused('This option requires an action and cannot be recorded as a decision.', 'DECISIONS_OPTION_NOT_RECORDABLE', { item: item.id, option: chosen });
    }
    if (!selected.decidedBy.allowed) {
      refusedItems.push({ item: item.id, title: item.title, option: chosen, groups: selected.decidedBy.groups });
      continue;
    }
    const values = {};
    if (selected.needs.reason) {
      const reason = String(answers.reason.get(item.id) ?? selected.needs.reason.default).trim();
      const { minimum, maximum } = selected.needs.reason;
      if (reason.length < minimum || reason.length > maximum) {
        refused(`The reason for ${item.id} must be ${minimum} to ${maximum} characters.`, 'DECISIONS_ANSWER_INVALID', { item: item.id });
      }
      values.reason = reason;
    }
    if (selected.needs.cause) {
      const cause = String(answers.cause.get(item.id) ?? selected.needs.cause.default).trim();
      if (cause.length < CAUSE.minimum || cause.length > CAUSE.maximum) {
        refused(`The cause for ${item.id} must be ${CAUSE.minimum} to ${CAUSE.maximum} characters.`, 'DECISIONS_ANSWER_INVALID', { item: item.id });
      }
      values.cause = cause;
    }
    if (selected.needs.expires) {
      const expires = String(answers.expires.get(item.id) ?? selected.needs.expires.default).trim();
      if (!validDate(expires, at, selected.needs.expires.latest)) {
        refused(`The date for ${item.id} must be YYYY-MM-DD, after today and no later than ${selected.needs.expires.latest}.`,
          'DECISIONS_ANSWER_INVALID', { item: item.id });
      }
      values.expires = expires;
    }
    if (selected.needs.clause) values.clause = namedClauses(item, answers.clause?.get(item.id), selected.needs.clause.known ?? []);
    if (selected.needs.article) values.article = checkedArticles(item, answers.article?.get(item.id), selected.needs.article);
    steps.push({ item: item.id, title: item.title, option: chosen, label: selected.label, values,
      effects: selected.effects.map((effect) => ({ ...effect })) });
  }
  // A route moves the Story on, so everything else on this list is written first.
  const routes = (step) => step.effects.some((effect) => effect.kind === 'routing');
  return { steps: [...steps.filter((step) => !routes(step)), ...steps.filter(routes)], refused: refusedItems };
}

export function planBatches(plan) {
  const batches = [];
  const byReason = new Map();
  for (const step of plan.steps) {
    const amends = step.effects.length === 1 && step.effects[0].kind === 'plan-amendment';
    const open = amends ? byReason.get(step.values.reason) : null;
    if (open && open.length < MAX_PLAN_AMENDMENT_CHANGES) { open.push(step); continue; }
    const batch = [step];
    batches.push(batch);
    if (amends) byReason.set(step.values.reason, batch);
  }
  return batches;
}

const planCorrectionRefused=message=>refused(message,'PLAN_ROW_CORRECTION_INVALID');

export function planCorrectionOwner(workflow, requested) {
  const plannedPolicy = workflow.resolution?.plannedClaims;
  const order = workflow.phaseOrder ?? Object.keys(workflow.phases ?? {});
  const owners = (plannedPolicy?.mode === 'required'
    ? [...new Set(Object.values(plannedPolicy.owners ?? {}))]
    : order.filter((id) => workflow.phases?.[id]?.claimMaps?.planned))
    .filter((id) => workflow.phases?.[id]?.status === 'approved' && workflow.phases[id].generation > 0);
  if (requested && !owners.includes(requested)) {
    planCorrectionRefused(`${requested} is not an approved plan of this Story${owners.length ? `; approved plans: ${owners.join(', ')}` : ''}.`);
  }
  if (!requested && owners.length !== 1) {
    planCorrectionRefused(owners.length ? `This Story has several approved plans; name one with --owner (${owners.join(', ')}).`
      : 'This Story has no approved plan to correct.');
  }
  const owner = workflow.phases[requested ?? owners[0]];
  if (!owner.claimMaps?.planned?.sha256) planCorrectionRefused(`Plan ${owner.id} has no bound claim map, so it cannot be corrected.`);
  return owner;
}

/** Shared with the native upstream decision owner: preserve its reason/expiry contract. */
export function upstreamDispositionFacts({outcome,reason,expiresAt=null,at}) {
  let expiry=null;
  if(outcome==='accept-risk'){
    const parsed=Date.parse(expiresAt??'');
    if(!Number.isFinite(parsed)||parsed<=Date.parse(at)||parsed-Date.parse(at)>90*86_400_000)refused(
      'An accepted risk expires: give --expires within 90 days.','UPSTREAM_ISSUE_RISK_EXPIRY_REQUIRED');
    expiry=new Date(parsed).toISOString();
  }else if(expiresAt)refused('--expires is used only with --outcome accept-risk.','UPSTREAM_ISSUE_INVALID');
  const text=String(reason??'').trim();
  if(text.length<20||text.length>1000)refused('Say why in 20 to 1000 characters with --reason.','UPSTREAM_ISSUE_REASON_REQUIRED');
  return {reason:text,expiresAt:expiry};
}
