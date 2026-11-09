import {acceptanceWitnessPolicies} from '../kernel/verification-witnesses.mjs';
/** Native syntax and packaged-root binding for shared source policies. No source/Git/file access. */
import path from 'node:path';
import {createHash} from 'node:crypto';
import {NODE_CONFIGURATION_PATH_SYNTAX,TEST_COMMAND_ECOSYSTEMS} from './node-configuration-path.mjs';
import {ecosystemOfAdapter,ecosystemOfProgram} from '../test-runners.mjs';
import {GOVERNED_ROOTS} from '../governed-roots.mjs';
import {configurationFilePolicies,sourceBoundaryPolicies,supportingChangePolicies,applicationPathPolicies,changeScopePolicies,deliveryClassificationPolicies,sourceChangeInspectionPolicies,sourceBaselineInventoryPolicies,sourceControlObservationPolicies,testDeliveryPolicies,TEST_DELIVERY_POLICY_FACTS,createRepositoryChangeSetCodec,REPOSITORY_CHANGE_SET_VALUES,configurationMaterializationPolicies} from '../kernel/source-path-policies.mjs';
import {codeDeliveryEvidencePolicies,sourceTagOriginPolicies,sourceOriginPatchPolicies} from '../kernel/code-delivery-evidence.mjs';
export {SOURCE_TAG_ORIGIN_VALUES_PROFILE} from '../kernel/code-delivery-evidence.mjs';
import {TEST_REPORT_BYTE_SYNTAX} from '../kernel/test-report-codec.mjs';
export {SOURCE_BOUNDARIES,normalizeSourceBoundary} from '../kernel/configuration-declarations.mjs';

const configurationFilePoliciesBinding=/* @__PURE__ */ configurationFilePolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const configurationPathKind=/* @__PURE__ */ (()=>configurationFilePoliciesBinding.configurationPathKind)();
export const isConfigurationPath=/* @__PURE__ */ (()=>configurationFilePoliciesBinding.isConfigurationPath)();

const sourceBoundaryPoliciesBinding=/* @__PURE__ */ sourceBoundaryPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const isTestAutomationPath=/* @__PURE__ */ (()=>sourceBoundaryPoliciesBinding.isTestAutomationPath)();
export const assertSourceBoundary=/* @__PURE__ */ (()=>sourceBoundaryPoliciesBinding.assertSourceBoundary)();

const supportingChangePoliciesBinding=/* @__PURE__ */ supportingChangePolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const SUPPORTING_CHANGE_CLASSES=/* @__PURE__ */ (()=>supportingChangePoliciesBinding.SUPPORTING_CHANGE_CLASSES)();
export const classifySupportingChange=/* @__PURE__ */ (()=>supportingChangePoliciesBinding.classifySupportingChange)();

const applicationPathPoliciesBinding=/* @__PURE__ */ applicationPathPolicies(GOVERNED_ROOTS);
export const applicationPathContext=/* @__PURE__ */ (()=>applicationPathPoliciesBinding.applicationPathContext)();
export const isTransientTestResultPath=/* @__PURE__ */ (()=>applicationPathPoliciesBinding.isTransientTestResultPath)();
export const isTestRunnerOutputPath=/* @__PURE__ */ (()=>applicationPathPoliciesBinding.isTestRunnerOutputPath)();
export const isGeneratedOutputPath=/* @__PURE__ */ (()=>applicationPathPoliciesBinding.isGeneratedOutputPath)();
export const isApplicationPath=/* @__PURE__ */ (()=>applicationPathPoliciesBinding.isApplicationPath)();
export const isApplicationChangePath=/* @__PURE__ */ (()=>applicationPathPoliciesBinding.isApplicationChangePath)();
export const isApplicationChangeEntry=/* @__PURE__ */ (()=>applicationPathPoliciesBinding.isApplicationChangeEntry)();

const changeScopePoliciesBinding=/* @__PURE__ */ changeScopePolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const changeSetPaths=/* @__PURE__ */ (()=>changeScopePoliciesBinding.changeSetPaths)();
export const evaluateProtectedPaths=/* @__PURE__ */ (()=>changeScopePoliciesBinding.evaluateProtectedPaths)();
export const evaluateSourceBoundary=/* @__PURE__ */ (()=>changeScopePoliciesBinding.evaluateSourceBoundary)();

const deliveryClassificationPoliciesBinding=/* @__PURE__ */ deliveryClassificationPolicies(NODE_CONFIGURATION_PATH_SYNTAX, GOVERNED_ROOTS);
export const pathInside=/* @__PURE__ */ (()=>deliveryClassificationPoliciesBinding.pathInside)();
export const isDocumentationPath=/* @__PURE__ */ (()=>deliveryClassificationPoliciesBinding.isDocumentationPath)();
export const classifyDeliveryChanges=/* @__PURE__ */ (()=>deliveryClassificationPoliciesBinding.classifyDeliveryChanges)();
const sourceChangeInspectionPoliciesBinding=/* @__PURE__ */ sourceChangeInspectionPolicies(NODE_CONFIGURATION_PATH_SYNTAX,GOVERNED_ROOTS);
export const inspectSourceChanges=/* @__PURE__ */ (()=>sourceChangeInspectionPoliciesBinding.inspectSourceChanges)();
const sourceBaselineInventoryBinding=/* @__PURE__ */ sourceBaselineInventoryPolicies(NODE_CONFIGURATION_PATH_SYNTAX,GOVERNED_ROOTS);
export const sourceBaselineInventory=/* @__PURE__ */ (()=>sourceBaselineInventoryBinding.sourceBaselineInventory)();
const testDeliveryFacts=/* @__PURE__ */ Object.freeze({profile:TEST_DELIVERY_POLICY_FACTS,ecosystems:TEST_COMMAND_ECOSYSTEMS,
  posixExtname:path.posix.extname,ecosystemOfAdapter,ecosystemOfProgram});
const testDeliveryBinding=/* @__PURE__ */ testDeliveryPolicies(NODE_CONFIGURATION_PATH_SYNTAX,testDeliveryFacts);
export const isTestSourceName=/* @__PURE__ */ (()=>testDeliveryBinding.isTestSourceName)();
export const sourceEcosystem=/* @__PURE__ */ (()=>testDeliveryBinding.sourceEcosystem)();
export const testCommandEcosystem=/* @__PURE__ */ (()=>testDeliveryBinding.testCommandEcosystem)();
export const testCommandCoversPath=/* @__PURE__ */ (()=>testDeliveryBinding.testCommandCoversPath)();
export const isAllowedTestAutomationPath=/* @__PURE__ */ (()=>testDeliveryBinding.isAllowedTestAutomationPath)();
export const isSupportingTestResourcePath=/* @__PURE__ */ (()=>testDeliveryBinding.isSupportingTestResourcePath)();
export const isExecutableTestSourceCandidate=/* @__PURE__ */ (()=>testDeliveryBinding.isExecutableTestSourceCandidate)();
export const affectedDeliveryPaths=/* @__PURE__ */ (()=>testDeliveryBinding.affectedDeliveryPaths)();
export const testCoverageExemptPath=/* @__PURE__ */ (()=>testDeliveryBinding.testCoverageExemptPath)();
export const testCoverageDeliveryPaths=/* @__PURE__ */ (()=>testDeliveryBinding.testCoverageDeliveryPaths)();
export const uncoveredTestDeliveryPaths=/* @__PURE__ */ (()=>testDeliveryBinding.uncoveredTestDeliveryPaths)();
export const deliveryPathCohorts=/* @__PURE__ */ (()=>testDeliveryBinding.deliveryPathCohorts)();
const repositoryChangeSetValues=/* @__PURE__ */ Object.freeze({profile:REPOSITORY_CHANGE_SET_VALUES,
  sha256Text:value=>'sha256:'+createHash('sha256').update(value).digest('hex'),
  compareUtf8:(left,right)=>Buffer.compare(Buffer.from(left,'utf8'),Buffer.from(right,'utf8'))});
const repositoryChangeSetBinding=/* @__PURE__ */ createRepositoryChangeSetCodec(repositoryChangeSetValues);
export const compareRepositoryIdentity=/* @__PURE__ */ (()=>repositoryChangeSetBinding.compareRepositoryIdentity)();
export const repositoryChangeEntryOrder=/* @__PURE__ */ (()=>repositoryChangeSetBinding.entryOrder)();
export const withRepositoryChangeEntryIdentity=/* @__PURE__ */ (()=>repositoryChangeSetBinding.withEntryIdentity)();
export const repositoryChangeSetDigest=/* @__PURE__ */ (()=>repositoryChangeSetBinding.repositoryChangeSetDigest)();
export const verifyRepositoryChangeSetIntegrity=/* @__PURE__ */ (()=>repositoryChangeSetBinding.verifyRepositoryChangeSetIntegrity)();
const sourceControlObservationBinding=/* @__PURE__ */ sourceControlObservationPolicies(NODE_CONFIGURATION_PATH_SYNTAX,GOVERNED_ROOTS,repositoryChangeSetValues);
export const verifySourceControlObservation=/* @__PURE__ */ (()=>sourceControlObservationBinding.verifySourceControlObservation)();

const materializationBinding=/* @__PURE__ */ configurationMaterializationPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const approvedConfigurationMaterializations=/* @__PURE__ */ (()=>materializationBinding.approvedConfigurationMaterializations)();
export const evaluateStoryProtectedPaths=/* @__PURE__ */ (()=>materializationBinding.evaluateStoryProtectedPaths)();
const deliveryByteSyntax=/* @__PURE__ */ Object.freeze({profile:TEST_REPORT_BYTE_SYNTAX,
  from:Buffer.from.bind(Buffer),alloc:Buffer.alloc.bind(Buffer),concat:Buffer.concat.bind(Buffer),
  sha256:value=>createHash('sha256').update(value).digest('hex')});
const deliveryEvidenceBinding=/* @__PURE__ */ codeDeliveryEvidencePolicies(NODE_CONFIGURATION_PATH_SYNTAX,GOVERNED_ROOTS,testDeliveryFacts,repositoryChangeSetValues,deliveryByteSyntax);
export const codeDeliveryReceiptReplay=/* @__PURE__ */ (()=>deliveryEvidenceBinding.codeDeliveryReceiptReplay)();
export const codeDeliveryEvidencePath=/* @__PURE__ */ (()=>deliveryEvidenceBinding.safeEvidencePath)();
export const implementationBindingsDigest=/* @__PURE__ */ (()=>deliveryEvidenceBinding.bindingsDigest)();
export const cornerCaseMatrixDigest=/* @__PURE__ */ (()=>deliveryEvidenceBinding.cornerCaseMatrixDigest)();
export const prepareCodeDeliveryReportReader=/* @__PURE__ */ (()=>deliveryEvidenceBinding.prepareTestReportReader)();

export const codeDeliveryPreflightReplay=/* @__PURE__ */ (()=>deliveryEvidenceBinding.codeDeliveryPreflightReplay)();
export const plannedSourceClauseBindingsReplay=/* @__PURE__ */ (()=>deliveryEvidenceBinding.plannedSourceClauseBindingsReplay)();
export const plannedImplementationPaths=/* @__PURE__ */ (()=>deliveryEvidenceBinding.plannedImplementationPaths)();
export const plannedProductSourcePaths=/* @__PURE__ */ (()=>deliveryEvidenceBinding.plannedProductSourcePaths)();
export const changesProductSource=/* @__PURE__ */ (()=>deliveryEvidenceBinding.changesProductSource)();
export const plannedSupportingFiles=/* @__PURE__ */ (()=>deliveryEvidenceBinding.plannedSupportingFiles)();
export const codeDeliveryCandidateScope=/* @__PURE__ */ (()=>deliveryEvidenceBinding.codeDeliveryCandidateScope)();
export const plannedCodeStepPaths=/* @__PURE__ */ (()=>deliveryEvidenceBinding.plannedCodeStepPaths)();
export const canonicalFinding=/* @__PURE__ */ (()=>deliveryEvidenceBinding.canonicalFinding)();
export const canonicalFindingId=/* @__PURE__ */ (()=>deliveryEvidenceBinding.canonicalFindingId)();
export const codeDeliveryCandidateSha256=/* @__PURE__ */ (()=>deliveryEvidenceBinding.codeDeliveryCandidateSha256)();
const originValuesBinding=/* @__PURE__ */ sourceTagOriginPolicies(NODE_CONFIGURATION_PATH_SYNTAX,GOVERNED_ROOTS);
const originPatchBinding=/* @__PURE__ */ sourceOriginPatchPolicies(NODE_CONFIGURATION_PATH_SYNTAX,GOVERNED_ROOTS);
export const sourceOriginLineDeltasReplay=/* @__PURE__ */ (()=>originPatchBinding.sourceOriginLineDeltasReplay)();
export const carriedTagIdsReplay=/* @__PURE__ */ (()=>originValuesBinding.carriedTagIdsReplay)();
export const storyTagLinesReplay=/* @__PURE__ */ (()=>originValuesBinding.storyTagLinesReplay)();

export const commandCovering=/* @__PURE__ */ (()=>testDeliveryBinding.commandCovering)();

const acceptanceWitnessBinding=/* @__PURE__ */ acceptanceWitnessPolicies(NODE_CONFIGURATION_PATH_SYNTAX,testDeliveryFacts);
export const discoverAcceptanceWitnessesReplay=/* @__PURE__ */ (()=>acceptanceWitnessBinding.discoverAcceptanceWitnessesReplay)();
export const commandForTestFileReplay=/* @__PURE__ */ (()=>acceptanceWitnessBinding.commandForTestFileReplay)();
