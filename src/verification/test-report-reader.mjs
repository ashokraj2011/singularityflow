/** Explicit Node byte/hash binding. No files, repository discovery, provider or process execution. */
import {createHash} from 'node:crypto';
import {createTestReportCodec,TEST_REPORT_BYTE_SYNTAX} from '../kernel/test-report-codec.mjs';
const syntax=/* @__PURE__ */ Object.freeze({profile:TEST_REPORT_BYTE_SYNTAX,
  from:Buffer.from.bind(Buffer),alloc:Buffer.alloc.bind(Buffer),concat:Buffer.concat.bind(Buffer),
  sha256:value=>createHash('sha256').update(value).digest('hex')});
export function createNodeTestReportCodec(){return createTestReportCodec(syntax);}
const reader=/* @__PURE__ */ createNodeTestReportCodec();
export const {parseXml,nodeTapCounts,replayLocalJavascriptJsonObservation,replayLocalJunitObservation,junitCaseLocations,parseNativeNodeJunitReport,parseTrpJunitReport,replayTestReports,persistedOccurrences,testReceiptPassing,prepareTestReportReader,number,combinedReports,testReportFromContents,consistentTestCounts}=reader;
