/** Node byte normalization only; all cause and report-message decisions belong to the pure owner. */
import {testRunCausePolicies} from '../kernel/test-run-cause.mjs';
export const {CASE_MESSAGE_LIMIT,boundedCaseMessage,failedSuiteMessages,testCaseMessages,TEST_RUN_CAUSES,testRunCauseCategory,testRunCauseWords,classifyTestRunCause,failedTestMessages,attemptRunCause}=testRunCausePolicies({toBytes:value=>Buffer.from(value)});
