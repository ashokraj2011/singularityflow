/**
 * Engine operation vocabulary v1. Only trusted ports perform I/O. Host flags, command strings,
 * model prose, repository discovery and provider selection never enter this dispatcher.
 */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { publicationAuthorshipIntent, assertPublicationAuthorshipIntent } from '../kernel/publication-intent.mjs';
import { submissionDecisionIntent, assertSubmissionIntent } from '../kernel/submission-intent.mjs';
import { assertApprovalReviewConfirmation } from '../kernel/approval-policy.mjs';

export const ENGINE_CONTRACT = 'sflow-engine/v1';
const PUBLISH_FIELDS = Object.freeze([
  'workId', 'phaseId', 'authored', 'channel', 'from', 'usageFile', 'usage', 'externalAiUse', 'changeOrigins'
]);
const SUBMIT_FIELDS = Object.freeze(['workId', 'phaseId', 'runChecks', 'decisionValues']);
const CONVERGENCE_FIELDS = Object.freeze([...SUBMIT_FIELDS, 'confirmation']);
const WRITE_STAGES = Object.freeze(['load', 'retained', 'prepare', 'commit', 'finish']);
const APPROVAL_FIELDS = Object.freeze(['workId','phaseId','confirmation','selectionReceipt','fetch','agent',
  'checklist','witnessMappings','bindingDecisions','decisions','confirmEvidence','evidenceReason']);
const definitions = [
  { id: 'phase.publish', version: 1, effect: 'publication',
    inputFields: PUBLISH_FIELDS, port: 'publication',
    stages: WRITE_STAGES, validate:publicationInput, execute:publish },
  { id: 'phase.submit', version: 1, effect: 'submission', inputFields: SUBMIT_FIELDS,
    port: 'submission', stages: WRITE_STAGES, validate:submissionInput, execute:submit },
  { id: 'convergence.submit', version: 1, effect: 'submission', inputFields: CONVERGENCE_FIELDS,
    confirmation: 'exact-reviewed-convergence-digest', port: 'submission', stages: WRITE_STAGES,
    validate:submissionInput, execute:submit },
  { id:'phase.approve',version:1,effect:'approval',inputFields:APPROVAL_FIELDS,port:'approval',
    humanDecision:true,stages:Object.freeze(['load','prepare','commit','finish']),
    validate:approvalInput,execute:approve }
];
export const ENGINE_OPERATIONS = Object.freeze(definitions.map(({validate,execute,...descriptor})=>Object.freeze(descriptor)));
const registry = new Map(definitions.map(operation => [operation.id, Object.freeze(operation)]));

function invalid(message) {
  throw new SingularityFlowError(message, { code: 'ENGINE_INPUT_INVALID' });
}

/** Copy JSON data without executing accessors/toJSON or retaining caller-owned mutable values. */
function data(value, state = { nodes: 0, bytes: 0, parents: new Set() }, depth = 0) {
  if (++state.nodes > 100_000 || depth > 32) invalid('Engine input exceeds its structural limit.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))) {
    state.bytes += typeof value === 'string' ? value.length : 16;
    if (state.bytes > 4_194_304) invalid('Engine input exceeds its size limit.');
    return value;
  }
  if (!value || typeof value !== 'object' || state.parents.has(value)
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    invalid('Engine input must be finite, acyclic plain JSON data.');
  }
  state.parents.add(value);
  const result = Array.isArray(value) ? [] : {};
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) && (keys.length !== value.length + 1
    || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) {
    invalid('Engine input arrays must not be sparse or extended.');
  }
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value')) {
      invalid('Engine input must not contain accessors or hidden properties.');
    }
    state.bytes += key.length;
    if (state.bytes > 4_194_304) invalid('Engine input exceeds its size limit.');
    const copied = data(property.value, state, depth + 1);
    Object.defineProperty(result, key, { value: copied, enumerable: true });
  }
  state.parents.delete(value);
  return Object.freeze(result);
}

function publicationInput(value) {
  const input = data(value);
  if (!input || Array.isArray(input) || typeof input !== 'object'
    || Object.keys(input).some(key => !PUBLISH_FIELDS.includes(key))) invalid('Unknown publication input field.');
  for (const key of PUBLISH_FIELDS.filter(key => !['usage', 'changeOrigins'].includes(key))) {
    if (input[key] != null && typeof input[key] !== 'string') invalid(`Publication ${key} must be a string or null.`);
  }
  if (input.usage != null && (typeof input.usage !== 'object')) invalid('Publication usage must be JSON records.');
  if (input.usage != null && input.usageFile != null) invalid('Choose publication usage data or a usage file.');
  if (input.changeOrigins != null && (!Array.isArray(input.changeOrigins)
    || input.changeOrigins.some(value => typeof value !== 'string'))) invalid('Change origins must be an array of strings.');
  return input;
}

function submissionInput(value, operation) {
  const input = data(value);
  if (!input || Array.isArray(input) || typeof input !== 'object'
    || Object.keys(input).some(key => !operation.inputFields.includes(key))) invalid('Unknown submission input field.');
  for (const key of ['workId', 'phaseId', 'confirmation']) {
    if (input[key] != null && typeof input[key] !== 'string') invalid(`Submission ${key} must be a string or null.`);
  }
  if (input.runChecks != null && typeof input.runChecks !== 'boolean') invalid('Submission runChecks must be a boolean.');
  if (input.decisionValues != null && (typeof input.decisionValues !== 'object' || Array.isArray(input.decisionValues)
    || Object.values(input.decisionValues).some(value => value !== null && !['string','number','boolean'].includes(typeof value)))) {
    invalid('Submission decisionValues must map names to scalar values.');
  }
  return input;
}

function approvalInput(value) {
  const input=data(value);
  if(!input || Array.isArray(input) || typeof input!=='object'
    || Object.keys(input).some(key=>!APPROVAL_FIELDS.includes(key)))invalid('Unknown approval input field.');
  for(const key of ['workId','phaseId','selectionReceipt','agent','evidenceReason']) {
    if(input[key]!=null && typeof input[key]!=='string')invalid(`Approval ${key} must be a string or null.`);
  }
  for(const key of ['fetch','confirmEvidence'])if(input[key]!=null && typeof input[key]!=='boolean')invalid(`Approval ${key} must be a boolean.`);
  for(const key of ['checklist','witnessMappings','bindingDecisions'])if(input[key]!=null && !Array.isArray(input[key]))invalid(`Approval ${key} must be an array.`);
  for(const key of ['confirmation','decisions'])if(input[key]!=null && (typeof input[key]!=='object' || Array.isArray(input[key])))invalid(`Approval ${key} must be a record.`);
  if(input.confirmation!=null) {
    const binding=input.confirmation;
    if(Object.keys(binding).some(key=>!['workId','phase','generation','reviewPacketSha256'].includes(key))
      || !['workId','phase','reviewPacketSha256'].every(key=>typeof binding[key]==='string' && binding[key].length>0)
      || !Number.isSafeInteger(binding.generation) || binding.generation<1)invalid('Approval confirmation must name the exact submitted review.');
  }
  if(input.decisions!=null && (Object.keys(input.decisions).some(key=>!['answers','digest'].includes(key))
      || input.decisions.digest!=null && typeof input.decisions.digest!=='string'))invalid('Approval decisions require answers and a list digest.');
  return input;
}

function notCancelled(signal) {
  if (signal?.aborted) throw new SingularityFlowError('The engine operation was cancelled before its next effect.', {
    code: 'ENGINE_OPERATION_CANCELLED'
  });
}

/** SDK-owned result contract; concrete stores return facts, never host presentation or SDK envelopes. */
function publicationResult(context, facts, status) {
  const allowed = ['workId', 'phase', 'generation', 'revision', 'pushed', 'artifact', 'retentionReason'];
  if (!facts || Object.keys(facts).some(key => !allowed.includes(key))
    || typeof facts.workId !== 'string' || facts.workId !== context.subject?.id
    || facts.phase !== context.phase?.id || !Number.isSafeInteger(facts.generation) || facts.generation < 1
    || typeof facts.revision !== 'string' || !facts.revision || facts.revision.length > 512
    || typeof facts.artifact !== 'string' || !facts.artifact || typeof facts.pushed !== 'boolean'
    || (status === 'retained' && (facts.pushed || !['consumed-intent','unchanged-document'].includes(facts.retentionReason)))) {
    throw new SingularityFlowError('The publication port returned an invalid or differently bound result.', {
      code: 'ENGINE_PORT_RESULT_INVALID'
    });
  }
  return Object.freeze({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.publish',status,
    subject:Object.freeze({kind:'story',id:facts.workId}),phase:facts.phase,generation:facts.generation,
    revision:facts.revision,effects:Object.freeze({committed:status==='published',pushed:facts.pushed}),
    artifact:facts.artifact,...(status==='retained'?{retentionReason:facts.retentionReason}:{})});
}

async function publish(port, inputs, signal) {
  notCancelled(signal);
  const context = await port.load(inputs, { signal });
  notCancelled(signal);
  const retained = await port.retained(context, inputs, { signal });
  if (retained) return publicationResult(context, retained, 'retained');
  const intent = publicationAuthorshipIntent(context.phase, inputs, { modelEnabled: context.modelEnabled });
  if (intent.legacyWarning) await port.notice?.({ code: 'publication.legacy-authorship' });
  assertPublicationAuthorshipIntent(context.phase, inputs, intent);
  notCancelled(signal);
  const prepared = await port.prepare(context, inputs, intent, { signal });
  notCancelled(signal);
  const committed = await port.commit(context, prepared, { signal });
  // Once the authority may have accepted the effect, cancellation cannot report it as undone.
  // Native unknown/conflict/pending errors pass through unchanged from commit.
  try {
    return publicationResult(context, await port.finish(context, prepared, committed), 'published');
  } catch (error) {
    // Preserve the actual error, while retaining the accepted commit for an inspecting host.
    if (error && typeof error === 'object' && Object.isExtensible(error)) error.enginePublication = committed;
    throw error;
  }
}

function submissionResult(context, facts, operation, retained) {
  const fields = ['workId','phase','generation','revision','pushed','phaseStatus','submittedAt','approvalMode','currentPhase','reviewPacket'];
  if (!facts || Object.keys(facts).some(key => !fields.includes(key))
    || typeof facts.workId !== 'string' || !facts.workId || facts.workId !== context.subject?.id
    || typeof facts.phase !== 'string' || !facts.phase || facts.phase !== context.phase?.id
    || !Number.isSafeInteger(facts.generation) || facts.generation < 1
    || !(retained && facts.revision === null || typeof facts.revision === 'string' && facts.revision.length > 0 && facts.revision.length <= 512)
    || typeof facts.pushed !== 'boolean' || retained && facts.pushed
    || !['approved','awaiting_approval'].includes(facts.phaseStatus)
    || retained && facts.phaseStatus !== 'awaiting_approval'
    || !['required','none','policy'].includes(facts.approvalMode)
    || facts.phaseStatus === 'approved' && facts.approvalMode === 'required'
    || facts.submittedAt !== null && typeof facts.submittedAt !== 'string'
    || facts.currentPhase !== null && typeof facts.currentPhase !== 'string'
    || facts.reviewPacket !== null && (typeof facts.reviewPacket !== 'string' || !facts.reviewPacket || facts.reviewPacket.length > 512)) {
    throw new SingularityFlowError('The submission port returned an invalid or differently bound result.', { code: 'ENGINE_PORT_RESULT_INVALID' });
  }
  return Object.freeze({schemaVersion:1,contract:ENGINE_CONTRACT,operation:operation.id,
    status:retained?'retained':facts.phaseStatus==='approved'?'completed':'awaiting-approval',
    subject:Object.freeze({kind:'story',id:facts.workId}),phase:facts.phase,generation:facts.generation,
    revision:facts.revision,effects:Object.freeze({committed:!retained,pushed:facts.pushed}),
    submission:Object.freeze({phaseStatus:facts.phaseStatus,submittedAt:facts.submittedAt,
      approvalMode:facts.approvalMode,currentPhase:facts.currentPhase,reviewPacket:facts.reviewPacket})});
}

async function submit(port, inputs, signal, operation) {
  notCancelled(signal);
  const context = await port.load(inputs, { signal });
  notCancelled(signal);
  const intent = submissionDecisionIntent(context.workflow, context.phase, inputs.decisionValues ?? {});
  if (intent.ignoredDecisionValues) await port.notice?.({code:'submission.decision-values-ignored',phase:context.phase.id});
  const retained = await port.retained(context, inputs, { signal });
  if (retained) return submissionResult(context, retained, operation, true);
  const confirmedConvergence = operation.id === 'convergence.submit';
  assertSubmissionIntent(context.workflow, context.phase, {confirmedConvergence,confirmation:inputs.confirmation});
  notCancelled(signal);
  const prepared = await port.prepare(context, inputs, {confirmedConvergence}, {signal});
  notCancelled(signal);
  const committed = await port.commit(context, prepared, {signal});
  try {
    return submissionResult(context, await port.finish(context, prepared, committed), operation, false);
  } catch (error) {
    if (error && typeof error === 'object' && Object.isExtensible(error)) error.enginePublication = committed;
    throw error;
  }
}

function approvalResult(context,facts,binding) {
  const fields=['workId','phase','generation','revision','pushed','reviewPacket','artifactSet','actorId',
    'authorityGroup','selfApproval','thresholdReached','currentPhase'];
  const text=value=>typeof value==='string' && value.length>0 && value.length<=512;
  if(!facts || Object.keys(facts).some(key=>!fields.includes(key))
    || !text(facts.workId) || facts.workId!==context.subject?.id || facts.workId!==binding.workId
    || facts.phase!==binding.phase || facts.generation!==binding.generation
    || !text(facts.revision) || typeof facts.pushed!=='boolean'
    || facts.reviewPacket!==binding.reviewPacketSha256 || !text(facts.artifactSet)
    || !text(facts.actorId) || !text(facts.authorityGroup)
    || typeof facts.selfApproval!=='boolean' || typeof facts.thresholdReached!=='boolean'
    || facts.currentPhase!==null && !text(facts.currentPhase)) {
    throw new SingularityFlowError('The approval port returned an invalid or differently bound decision.',{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  return Object.freeze({schemaVersion:1,contract:ENGINE_CONTRACT,operation:'phase.approve',status:'recorded',
    subject:Object.freeze({kind:'story',id:facts.workId}),phase:facts.phase,generation:facts.generation,
    revision:facts.revision,effects:Object.freeze({committed:true,pushed:facts.pushed}),
    approval:Object.freeze({actorId:facts.actorId,authorityGroup:facts.authorityGroup,selfApproval:facts.selfApproval,
      thresholdReached:facts.thresholdReached,reviewPacket:facts.reviewPacket,artifactSet:facts.artifactSet}),currentPhase:facts.currentPhase});
}

async function approve(port,inputs,signal) {
  notCancelled(signal);
  const context=await port.load(inputs,{signal});
  const binding=data(context.reviewBinding ?? null);
  notCancelled(signal);
  const prepared=await port.prepare(context,inputs,{signal});
  assertApprovalReviewConfirmation(binding,prepared?.confirmation);
  notCancelled(signal);
  const committed=await port.commit(context,prepared,{signal});
  try {
    return approvalResult(context,await port.finish(context,prepared,committed),binding);
  } catch(error) {
    if(error && typeof error==='object' && Object.isExtensible(error))error.enginePublication=committed;
    throw error;
  }
}

export function createEngine({ ports } = {}) {
  if (!ports || typeof ports !== 'object') invalid('Engine construction requires explicit trusted ports.');
  const bound = new Map();
  for (const name of new Set(ENGINE_OPERATIONS.map(operation => operation.port))) {
    const supplied = ports[name];
    if (supplied === undefined) continue;
    const stages=ENGINE_OPERATIONS.find(operation=>operation.port===name).stages;
    if (!supplied || stages.some(stage => typeof supplied[stage] !== 'function')) {
      invalid(`The ${name} port must implement every declared operation stage.`);
    }
    bound.set(name, Object.freeze(Object.fromEntries([
      ...stages.map(stage => [stage, supplied[stage].bind(supplied)]),
      ...(typeof supplied.notice === 'function' ? [['notice', supplied.notice.bind(supplied)]] : [])
    ])));
  }
  if (!bound.size) invalid('Engine construction requires at least one complete operation port.');
  const invoke = typeof ports.invocation?.run === 'function'
    ? ports.invocation.run.bind(ports.invocation) : callback => callback();
  const execute = async (operation, inputs = {}, { signal = null } = {}) => {
    if (typeof operation !== 'string' || !registry.has(operation)) throw new SingularityFlowError('The engine operation is unavailable in this contract.', {
      code: 'ENGINE_OPERATION_UNSUPPORTED', details: { operation: typeof operation === 'string' ? operation.slice(0, 128) : null, contract: ENGINE_CONTRACT }
    });
    const definition = registry.get(operation);
    const input = definition.validate(inputs, definition);
    const port = bound.get(definition.port);
    if (!port) throw new SingularityFlowError('No port implements this engine operation in the current host.', {
      code:'ENGINE_PORT_UNAVAILABLE',details:{operation,port:definition.port}
    });
    return invoke(() => definition.execute(port, input, signal, definition));
  };
  return Object.freeze({ contract: ENGINE_CONTRACT, operations: ENGINE_OPERATIONS,
    run: execute, publishPhase: (inputs, options) => execute('phase.publish', inputs, options),
    submitPhase: (inputs, options) => execute('phase.submit', inputs, options),
    submitConvergence: (inputs, options) => execute('convergence.submit', inputs, options),
    approvePhase:(inputs,options)=>execute('phase.approve',inputs,options) });
}
