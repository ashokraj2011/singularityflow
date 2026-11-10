/** Compatibility exports; production callers use the shared value owner. */
export { conformanceTableRows, unreadConformanceTables, missingQualifiedConformanceRows, duplicateQualifiedConformanceRows, blockingConformanceVerdicts, contradictedConformanceVerdicts } from './kernel/conformance-report.mjs';
export {conformanceVerdictGaps} from './engine-compatibility/node-specification-policy.mjs';
