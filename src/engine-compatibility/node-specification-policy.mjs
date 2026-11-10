/** Native value binding only; no repository, file, process or provider access. */
import {NODE_TEXT_DIGESTS,NODE_TEXT_VALUE_SYNTAX} from '../records.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from './node-configuration-path.mjs';
import {verificationContractPolicies,verificationExecutionProfiles,plannedTestCapabilityPolicies} from '../kernel/verification-policy.mjs';
import {specificationValuePolicies,specificationClaimPolicies} from '../kernel/specification-values.mjs';

const contracts=/* @__PURE__ */ verificationContractPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS);
export const proseVerificationDeclarations=/* @__PURE__ */ (()=>contracts.proseVerificationDeclarations)();
export const validateRetainedEvidenceDeclarations=/* @__PURE__ */ (()=>contracts.validateRetainedEvidenceDeclarations)();
export const parseVerificationContracts=/* @__PURE__ */ (()=>contracts.parseVerificationContracts)();
export const normalizeVerificationContracts=/* @__PURE__ */ (()=>contracts.normalizeVerificationContracts)();
export const mergedVerificationContracts=/* @__PURE__ */ (()=>contracts.mergedVerificationContracts)();
export const effectiveContract=/* @__PURE__ */ (()=>contracts.effectiveContract)();
export const contractRequiresTestTag=/* @__PURE__ */ (()=>contracts.contractRequiresTestTag)();
export const requiredAcceptanceFromPlan=/* @__PURE__ */ (()=>contracts.requiredAcceptanceFromPlan)();
export const testSlotFor=/* @__PURE__ */ (()=>contracts.testSlotFor)();
export const contractSha256=/* @__PURE__ */ (()=>contracts.contractSha256)();
export const witnessMappingCore=/* @__PURE__ */ (()=>contracts.witnessMappingCore)();
export const witnessMappingSha256=/* @__PURE__ */ (()=>contracts.witnessMappingSha256)();
const specifications=/* @__PURE__ */ specificationValuePolicies(NODE_TEXT_DIGESTS);
export const extractClauses=/* @__PURE__ */ (()=>specifications.extractClauses)();
export const specificationIndexRecord=/* @__PURE__ */ (()=>specifications.specificationIndexRecord)();

const claims=/* @__PURE__ */ specificationClaimPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_VALUE_SYNTAX);
export const normalizeClaimMapReplay=/* @__PURE__ */ (()=>claims.normalizeClaimMapReplay)();
export const inspectPlannedClaimMapReplay=/* @__PURE__ */ (()=>claims.inspectPlannedClaimMapReplay)();
export const derivePlannedClaimMapReplay=/* @__PURE__ */ (()=>claims.derivePlannedClaimMapReplay)();
export const deriveObservedClaimMapReplay=/* @__PURE__ */ (()=>claims.deriveObservedClaimMapReplay)();
export const validatePlannedEvidenceTypes=/* @__PURE__ */ (()=>claims.validatePlannedEvidenceTypes)();
export const planSupportingFiles=/* @__PURE__ */ (()=>claims.planSupportingFiles)();
export const testOnlyClaimEvidence=/* @__PURE__ */ (()=>claims.testOnlyClaimEvidence)();
export const mergeObservedClaimRecords=/* @__PURE__ */ (()=>claims.mergeObservedClaimRecords)();
export const evaluateSpecCoverageReplay=/* @__PURE__ */ (()=>claims.evaluateSpecCoverageReplay)();
export const evaluateSpecAcceptance=/* @__PURE__ */ (()=>claims.evaluateSpecAcceptance)();
export const candidateSpecificationCoverageReplay=/* @__PURE__ */ (()=>claims.candidateSpecificationCoverageReplay)();
export {codeCoverageEnforcement,plannedClaimsForObservedPhase,selectActiveSpecRecords} from '../kernel/specification-policy.mjs';

const profiles=/* @__PURE__ */ verificationExecutionProfiles(NODE_CONFIGURATION_PATH_SYNTAX);
export const profileForCommand=/* @__PURE__ */ (()=>profiles.profileForCommand)();
export const testAdapterProfile=/* @__PURE__ */ (()=>profiles.testAdapterProfile)();
export const profileIsExact=/* @__PURE__ */ (()=>profiles.profileIsExact)();
export const profileCeiling=/* @__PURE__ */ (()=>profiles.profileCeiling)();

const plannedCapabilities=/* @__PURE__ */ plannedTestCapabilityPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS);
export const plannedTestSlots=/* @__PURE__ */ (()=>plannedCapabilities.plannedTestSlots)();
export const plannedTestAssuranceProblem=/* @__PURE__ */ (()=>plannedCapabilities.plannedTestAssuranceProblem)();

import {SPECIFICATION_CHECKLIST_ID,SPECIFICATION_REQUIRED_SECTIONS} from '../kernel/specification-policy.mjs';
import {specificationAnalysisPolicies,SPECIFICATION_ANALYSIS_DECLARATIONS} from '../kernel/specification-analysis.mjs';
export const STARTER_CHECKLIST = Object.freeze({
  id: SPECIFICATION_CHECKLIST_ID,
  version: 1,
  articles: Object.freeze([
    { id: 'completeness', title: 'Completeness', question: 'Does the specification cover every scenario the work is expected to serve, including failure and empty states?' },
    { id: 'ambiguity', title: 'Ambiguity', question: 'Is every requirement free of wording that two competent readers could implement differently?' },
    { id: 'consistency', title: 'Consistency', question: 'Do the requirements agree with each other, with the scenarios, and with the cited constitution articles?' },
    { id: 'verifiability', title: 'Verifiability', question: 'Can each requirement be proved or disproved by a stated test, check, or observation?' },
    { id: 'boundary-conditions', title: 'Boundary conditions', question: 'Are limits, sizes, counts, and timeouts stated, with the behaviour at and beyond each one?' },
    { id: 'non-functional', title: 'Non-functional requirements', question: 'Are latency, availability, privacy, accessibility and retention stated as measurable numbers rather than adjectives?' }
  ])
});
const analysis=/* @__PURE__ */ specificationAnalysisPolicies(NODE_TEXT_VALUE_SYNTAX,Object.freeze({profile:SPECIFICATION_ANALYSIS_DECLARATIONS,
 requiredSections:SPECIFICATION_REQUIRED_SECTIONS,starterChecklist:STARTER_CHECKLIST}));
export const policyHash=/* @__PURE__ */ (()=>analysis.policyHash)();
export const witnessedClauseReviewFields=/* @__PURE__ */ (()=>analysis.witnessedClauseReviewFields)();
export const analyzeSpecification=/* @__PURE__ */ (()=>analysis.analyzeSpecification)();
export const evaluateSpecificationQuality=/* @__PURE__ */ (()=>analysis.evaluateSpecificationQuality)();
export const validateChecklistDecisions=/* @__PURE__ */ (()=>analysis.validateChecklistDecisions)();
export {WITNESS_TYPES,CHECKLIST_DECISIONS,MARKER_FINDING_KINDS} from '../kernel/specification-analysis.mjs';
export {specificationQualityPolicy,SPECIFICATION_QUALITY_MODES,WITNESSED_CLAUSE_PROFILE} from '../kernel/specification-policy.mjs';
export {evaluateMarkerPolicy,markerPolicy} from '../kernel/specification-markers.mjs';

export const evaluateApprovalChecklist=/* @__PURE__ */ (()=>analysis.evaluateApprovalChecklist)();
export const specificationGateValue=/* @__PURE__ */ (()=>analysis.specificationGateValue)();
