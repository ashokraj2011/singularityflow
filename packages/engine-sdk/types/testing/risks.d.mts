import type {TestRunCause,TestCauseCounts,TestRunCauseValues} from './causes.mjs';
export interface TestRunRiskAttempt {
  readonly attemptId?:string;readonly commandId?:string;readonly argvSha256?:string;readonly status?:string;readonly exitCode?:number|null;
  readonly timedOut?:boolean;readonly process?:{readonly infrastructureUnavailable?:boolean};readonly tests?:TestCauseCounts|null;readonly cause?:TestRunCause|null;
}
export interface TestRunRiskRecord {
  readonly id:string;readonly phase:string;readonly commandId:string;readonly argvSha256:string;readonly causeClass:string;
  readonly cause:string;readonly reason:string;readonly expiresAt:string;readonly actor:string;readonly authorityGroup:string;readonly at:string;
  readonly identityAssurance:unknown;readonly boundBy?:'command-digest';
  readonly observation?:{readonly attemptId:string;readonly status:string;readonly exitCode:number|null;readonly testsExecuted:number};
}
export interface TestRunRiskValues {
  readonly MAX_TEST_RUN_RISK_DAYS:90;
  testsExecuted(attempt:TestRunRiskAttempt|null):number;
  noTestExecuted(attempt:TestRunRiskAttempt|null):boolean;
  testRunCause(attempt:TestRunRiskAttempt|null):TestRunCause;
  testRunCauseText(cause:TestRunCause|null):string;
  testRunRiskText(value:unknown,minimum:number,maximum:number,option:string,what:string):string;
  testRunRiskIneligibility(attempt:TestRunRiskAttempt|null):string|null;
  /** Mutates only the supplied value aggregate. Authority, source and retained execution must be verified by the caller. */
  recordTestRunRisk(workflow:{testRunRisks?:unknown[]},input:{readonly phaseId:string;readonly attempt?:TestRunRiskAttempt|null;
    readonly commandId?:string|null;readonly argvSha256?:string|null;readonly causeClass?:string|null;readonly cause:string;readonly reason:string;
    readonly expires:string;readonly actor:string;readonly authorityGroup:string;readonly identityAssurance?:unknown;readonly at:string}):TestRunRiskRecord;
}
export declare function testRunRiskRecordPolicies(values:Pick<TestRunCauseValues,'classifyTestRunCause'|'testRunCauseCategory'|'testRunCauseWords'>):Readonly<TestRunRiskValues>;
