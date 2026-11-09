/** Native value binding only; no repository, file, process or provider access. */
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {NODE_CONFIGURATION_PATH_SYNTAX} from './node-configuration-path.mjs';
import {verificationContractPolicies} from '../kernel/verification-policy.mjs';
import {specificationValuePolicies} from '../kernel/specification-values.mjs';

const contracts=/* @__PURE__ */ verificationContractPolicies(NODE_CONFIGURATION_PATH_SYNTAX,NODE_TEXT_DIGESTS);
export const proseVerificationDeclarations=/* @__PURE__ */ (()=>contracts.proseVerificationDeclarations)();
export const validateRetainedEvidenceDeclarations=/* @__PURE__ */ (()=>contracts.validateRetainedEvidenceDeclarations)();
export const parseVerificationContracts=/* @__PURE__ */ (()=>contracts.parseVerificationContracts)();
export const normalizeVerificationContracts=/* @__PURE__ */ (()=>contracts.normalizeVerificationContracts)();
export const mergedVerificationContracts=/* @__PURE__ */ (()=>contracts.mergedVerificationContracts)();
export const effectiveContract=/* @__PURE__ */ (()=>contracts.effectiveContract)();
export const contractRequiresTestTag=/* @__PURE__ */ (()=>contracts.contractRequiresTestTag)();
export const testSlotFor=/* @__PURE__ */ (()=>contracts.testSlotFor)();
export const contractSha256=/* @__PURE__ */ (()=>contracts.contractSha256)();
export const witnessMappingCore=/* @__PURE__ */ (()=>contracts.witnessMappingCore)();
export const witnessMappingSha256=/* @__PURE__ */ (()=>contracts.witnessMappingSha256)();
const specifications=/* @__PURE__ */ specificationValuePolicies(NODE_TEXT_DIGESTS);
export const extractClauses=/* @__PURE__ */ (()=>specifications.extractClauses)();
export const specificationIndexRecord=/* @__PURE__ */ (()=>specifications.specificationIndexRecord)();
