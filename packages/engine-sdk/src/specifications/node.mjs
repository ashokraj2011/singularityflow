/** Optional Node path/hash binding. Observation and acceptance remain separate operations. */
export {extractClauses,specificationIndexRecord,parseVerificationContracts,normalizeVerificationContracts,
  mergedVerificationContracts,effectiveContract,contractRequiresTestTag,testSlotFor,contractSha256,
  witnessMappingCore,witnessMappingSha256,proseVerificationDeclarations,validateRetainedEvidenceDeclarations} from '../../../../src/engine-compatibility/node-specification-policy.mjs';
export {normalizeClaimMapReplay,inspectPlannedClaimMapReplay,derivePlannedClaimMapReplay,deriveObservedClaimMapReplay,
  validatePlannedEvidenceTypes,planSupportingFiles,testOnlyClaimEvidence,mergeObservedClaimRecords,evaluateSpecCoverageReplay,evaluateSpecAcceptance,
  candidateSpecificationCoverageReplay,codeCoverageEnforcement,plannedClaimsForObservedPhase,selectActiveSpecRecords} from '../../../../src/engine-compatibility/node-specification-policy.mjs';
export {STARTER_CHECKLIST,policyHash,witnessedClauseReviewFields,analyzeSpecification,evaluateSpecificationQuality,validateChecklistDecisions,evaluateApprovalChecklist,specificationGateValue} from '../../../../src/engine-compatibility/node-specification-policy.mjs';
export {scanJavaScriptDeclarations,JAVASCRIPT_DECLARATION_SCHEMA,tokenizeJavaScript,eachTitlePattern,analyzeTestDeclarationAssertions,
  javascriptSourceComments,scanSourceClauseTags} from '../../../../src/engine-compatibility/node-source-analysis.mjs';
export {implementationBindingsReplay,bindingsDigest,reviewBindings,BINDING_DECISIONS,documentationLanguage,unsupportedSourceLanguage,
  publicDeclarations,changedDeclarations,POLYGLOT_STRUCTURAL_LANGUAGES,maskPolyglotNonCode,extractPolyglotSymbols,extractPolyglotImports,resolvePolyglotLocal} from '../../../../src/engine-compatibility/node-source-analysis.mjs';
export {carriedTagIdsReplay,storyTagLinesReplay,SOURCE_TAG_ORIGIN_VALUES_PROFILE} from '../../../../src/engine-compatibility/node-source-policy.mjs';
export {deriveRepositoryPlan,repositoryPlanValue,repositoryPlanProjection,assertRepositoryPlanSources,repositoryPlanTestLocation} from '../../../../src/engine-compatibility/node-repository-plan.mjs';
export {discoverAcceptanceWitnessesReplay,commandForTestFileReplay} from '../../../../src/engine-compatibility/node-source-policy.mjs';
