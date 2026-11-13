/** Shared check evidence and report-capture policy. No command execution, storage or host rendering. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {testReceiptPassing} from './test-report-codec.mjs';
const fail=(message,code='ENGINE_INPUT_INVALID',details=null)=>{throw new SingularityFlowError(message,{code,details});};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);

export function qualityValidationVerdict(checks = [], { required = false } = {}) {
  const known = new Set(['passed', 'failed', 'blocked', 'skipped-warning', 'unavailable']);
  const invalid = checks.filter((check) => !known.has(check?.status));
  const explicitFailures = checks.filter((check) => check.status === 'failed' || check.status === 'blocked');
  // Unknown output is never passing evidence; the runtime gate and the simulator share this rule.
  const failed = [...explicitFailures, ...invalid];
  const unavailable = checks.filter((check) => ['skipped-warning', 'unavailable'].includes(check.status));
  const unavailableRequired = unavailable.filter((check) => (check.requirement ?? 'required') === 'required');
  let verdict;
  if (!checks.length) verdict = required ? 'invalid' : 'not-required';
  else if (invalid.length) verdict = 'invalid';
  else if (explicitFailures.length) verdict = 'failed';
  else if (unavailable.length === checks.length) verdict = 'unavailable';
  else if (unavailable.length) verdict = 'partial';
  else verdict = 'passed';
  return { verdict, failed, invalid, unavailable, unavailableRequired };
}

/** The host supplies native basename syntax; every command keeps its original stdout policy. */
export function qualityReportUsesStdout(policy,basename) {
  return policy.kind === 'test' && Array.isArray(policy.argv) && (policy.result?.adapter === 'go-test-json'
    || policy.result?.adapter === 'node-tap'
    || policy.result?.adapter === 'karma-text'
    || (policy.result?.adapter === 'cargo-json' && /^cargo(?:\.exe)?$/iu.test(basename(policy.argv[0])))
    || (policy.result?.adapter === 'junit-xml'
      && policy.argv.some((argument) => argument === '--test-reporter=junit')));
}
export function phaseChecksInput(input) {
  const fields=['operationId','workId','phaseId'];
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==fields.length
    ||!fields.every(key=>Object.hasOwn(input,key)&&id(input[key])))fail('Phase checks require an exact operation ID, Story and phase.');
  return {...input};
}
/** Observations become passing checks only through the existing receipt predicate and fresh source binding. */
export function observedPhaseCheck(command,{process,tests,diagnostics,sourceMatched}) {
  if(!process||!Array.isArray(diagnostics)||typeof sourceMatched!=='boolean')fail('The check owner returned invalid execution facts.','ENGINE_PORT_RESULT_INVALID');
  const receipt={status:'passed',exitCode:process.status,timedOut:process.timedOut,skipped:false,suppressed:false,tests};
  const passed=sourceMatched&&process.closed===true&&process.signal===null&&process.overflow===false&&!diagnostics.length
    &&testReceiptPassing(receipt,command.result.minimumDiscovered,command.result.minimumPassed);
  const status=passed?'passed':process.status!==0||process.timedOut||process.overflow||!sourceMatched?'failed':'unavailable';
  return {id:command.id,requirement:command.requirement,status,tests:tests??null,diagnostics:[...diagnostics]};
}
/** Process checks have an explicit separate meaning. Successful compilation never claims tests ran. */
export function observedCommandCheck(command,{process,tests=null,diagnostics,sourceMatched}){
  if(command.kind==='test'||command.result!=null||tests!==null||!process||!Array.isArray(diagnostics)||typeof sourceMatched!=='boolean')
    fail('A command observation cannot stand in for structured test evidence.','ENGINE_PORT_RESULT_INVALID');
  const passed=sourceMatched&&process.closed===true&&process.signal===null&&process.overflow===false&&!process.timedOut
    &&process.status===0&&!diagnostics.length,
    status=passed?'passed':process.status!==0||process.timedOut||process.overflow||!sourceMatched?'failed':'unavailable';
  return {id:command.id,requirement:command.requirement,status,tests:null,diagnostics:[...diagnostics]};
}
export function phaseChecksResult(input,facts) {
  if(!facts||facts.workId!==input.workId||facts.phase!==input.phaseId||facts.operationId!==input.operationId
    ||!Number.isSafeInteger(facts.generation)||facts.generation<1||typeof facts.replayed!=='boolean'
    ||!Array.isArray(facts.checks)||facts.checks.length>1024||typeof facts.principalId!=='string'
    ||typeof facts.recordedAt!=='string'||!Number.isFinite(Date.parse(facts.recordedAt))
    ||typeof facts.record?.key!=='string'||typeof facts.record?.version!=='string'
    ||facts.record?.content?.namespace!=='evidence'||!/^([a-f0-9]{64})$/u.test(facts.record?.content?.sha256??''))
    fail('The phase check writer returned another result binding.','ENGINE_PORT_RESULT_INVALID');
  if(!facts.record.key||!facts.record.version||!Number.isSafeInteger(facts.record.content.bytes)||facts.record.content.bytes<1
    ||facts.record.content.bytes>33_554_432||facts.checks.some(check=>!check||typeof check!=='object'||Array.isArray(check)
      ||typeof check.id!=='string'||!check.id||!id(check.repositoryId)||!['required','advisory'].includes(check.requirement)
      ||!['passed','failed','blocked','skipped-warning','unavailable'].includes(check.status)))
    fail('The phase check writer returned malformed observation facts.','ENGINE_PORT_RESULT_INVALID');
  const summary=qualityValidationVerdict(facts.checks,{required:true});
  if(summary.verdict!==facts.verdict)fail('The phase check summary differs from its observed checks.','ENGINE_PORT_RESULT_INVALID');
  return {status:facts.replayed?'retained':'recorded',subject:{kind:'story',id:input.workId},phase:input.phaseId,
    operationId:input.operationId,generation:facts.generation,record:facts.record,recordedAt:facts.recordedAt,
    principalId:facts.principalId,checks:facts.checks,verdict:summary.verdict,replayed:facts.replayed,
    effects:{committed:!facts.replayed,pushed:false,checkResultsRecorded:!facts.replayed,evidenceRetained:true,
      phasePublished:false,approvalRecorded:false,storyAdvanced:false}};
}
