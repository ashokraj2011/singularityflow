/** Native syntax and packaged-root binding for shared source policies. No source/Git/file access. */
import {NODE_CONFIGURATION_PATH_SYNTAX} from './node-configuration-path.mjs';
import {GOVERNED_ROOTS} from '../governed-roots.mjs';
import {configurationFilePolicies,sourceBoundaryPolicies,supportingChangePolicies,applicationPathPolicies,changeScopePolicies,deliveryClassificationPolicies,sourceChangeInspectionPolicies,sourceBaselineInventoryPolicies} from '../kernel/source-path-policies.mjs';
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
