export type TestReportBytes=Uint8Array|string;
export interface TestCauseCounts {readonly discovered?:number;readonly passed?:number;readonly failed?:number;readonly skipped?:number}
export interface TestRunCause {readonly category:'environment'|'code'|'unknown';readonly class:string;readonly basis:string;
  readonly signal:string;readonly file?:string;readonly failedTests?:number;readonly failedSuites?:number}
export interface TestCauseCheck {readonly status?:string;readonly exitCode?:number|null;readonly stdout?:string;readonly stderr?:string;
  readonly timedOut?:boolean;readonly sourceMutation?:boolean;readonly infrastructureUnavailable?:boolean}
export interface TestCauseOccurrence {readonly outcome:string;readonly [name:string]:unknown}
export interface TestRunCauseValues {
  readonly TEST_RUN_CAUSES:Readonly<Record<string,readonly ['environment'|'code'|'unknown',string]>>;readonly CASE_MESSAGE_LIMIT:2000;
  testRunCauseCategory(causeClass:string|null):'environment'|'code'|'unknown'|null;
  testRunCauseWords(causeClass:string|null):string;
  classifyTestRunCause(input?:{readonly check?:TestCauseCheck|null;readonly tests?:TestCauseCounts|null;readonly failedMessages?:readonly (string|null)[]|null;
    readonly failedSuites?:readonly {readonly name:string;readonly message:string|null}[]|null;readonly changedPaths?:readonly string[]}):TestRunCause;
  boundedCaseMessage(value:unknown):string|null;
  failedSuiteMessages(adapter:string,contents:readonly TestReportBytes[]):readonly {readonly name:string;readonly message:string|null}[];
  testCaseMessages(adapter:string,contents:readonly TestReportBytes[],occurrenceCount:number):readonly (string|null)[]|null;
  failedTestMessages(adapter:string,occurrences:readonly TestCauseOccurrence[],messages:readonly (string|null)[]|null,
    contents:readonly TestReportBytes[]):readonly (string|null)[]|null;
  attemptRunCause(input:{readonly check:TestCauseCheck;readonly parsed:{readonly rawReports?:readonly {readonly contents:TestReportBytes}[]}|null;
    readonly attempt:{readonly adapter:string;readonly tests:TestCauseCounts|null;readonly occurrences?:readonly TestCauseOccurrence[]};
    readonly delivery?:{readonly sourcePaths?:readonly string[];readonly testPaths?:readonly string[]}}):TestRunCause;
}
/** A value result classifies supplied observations; it cannot accept a risk, approve evidence or execute tests. */
export declare function testRunCausePolicies(bytes:{readonly toBytes:(value:TestReportBytes)=>Uint8Array}):Readonly<TestRunCauseValues>;
