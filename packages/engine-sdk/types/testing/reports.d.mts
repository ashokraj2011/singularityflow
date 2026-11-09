import type {JsonValue} from '../namespace.mjs';
export type ReportBytes=Uint8Array|string|readonly number[];
export type ReportBuffer=Uint8Array&{toString(encoding?:string):string};
export interface ReportByteSyntax {
  readonly profile:'sflow-test-report-bytes/v1';
  readonly from:(value:ReportBytes,encoding?:string)=>ReportBuffer;
  readonly alloc:(length:number)=>ReportBuffer;
  readonly concat:(values:readonly Uint8Array[])=>ReportBuffer;
  readonly sha256:(value:Uint8Array|string)=>string;
}
export interface TestReportCounts {readonly discovered:number;readonly passed:number;readonly failed:number;readonly skipped:number}
export interface RawTestReport {readonly contents:ReportBytes}
export interface TestReportObservation {
  readonly framework?:string;readonly occurrences:readonly Readonly<Record<string,JsonValue>>[];
  readonly parser?:Readonly<Record<string,JsonValue>>;
}
export interface ParsedTestReport {
  readonly adapter?:string;readonly tests:TestReportCounts;readonly testcaseObservation:TestReportObservation|null;
  readonly result:{readonly sha256:string;readonly bytes:number;readonly files:readonly {readonly sha256:string;readonly bytes:number}[]};
}
export interface XmlTestReportNode {
  readonly name:string;readonly localName:string;readonly attributes:Readonly<Record<string,string>>;
  readonly children:readonly XmlTestReportNode[];readonly sourceStart:number;readonly sourceEnd:number;
}
/** Parsing counts does not authenticate an executor, certify acceptance or waive a policy. */
export interface TestReportCodec {
  prepareTestReportReader(adapter:string):Promise<void>;
  replayTestReports(adapter:string,reports:readonly RawTestReport[]):ParsedTestReport;
  replayLocalJavascriptJsonObservation(reports:readonly RawTestReport[],adapter:'jest-json'|'vitest-json'):ParsedTestReport;
  replayLocalJunitObservation(reports:readonly RawTestReport[],options?:{readonly maximumOccurrences?:number}):ParsedTestReport;
  parseXml(text:string,fail?:(message:string)=>never):XmlTestReportNode;
  nodeTapCounts(text:string):TestReportCounts;
  junitCaseLocations(reports:readonly ReportBytes[]):readonly {readonly file:string|null;readonly line:number|null}[];
  parseNativeNodeJunitReport(bytes:ReportBytes):{readonly tests:TestReportCounts;readonly cases:readonly Readonly<Record<string,JsonValue>>[]};
  parseTrpJunitReport(bytes:ReportBytes):{readonly tests:TestReportCounts;readonly cases:readonly Readonly<Record<string,JsonValue>>[]};
  persistedOccurrences(parsed:unknown):readonly Readonly<Record<string,JsonValue>>[];
  testReceiptPassing(receipt:unknown,minimumDiscovered?:number,minimumPassed?:number):boolean;
  nodeTestObservation(text:string,counts:TestReportCounts):TestReportObservation|null;
  jsonTestReport(adapter:string,text:string):{readonly tests:TestReportCounts;readonly testcaseObservation:TestReportObservation}|null;
}
export declare const TEST_REPORT_BYTE_SYNTAX:'sflow-test-report-bytes/v1';
export declare const TEST_REPORT_LIMITS:Readonly<{maximumFiles:1000;maximumFileBytes:16777216;maximumTotalBytes:67108864;maximumOccurrences:100000}>;
export declare function createTestReportCodec(syntax:ReportByteSyntax):Readonly<TestReportCodec>;
