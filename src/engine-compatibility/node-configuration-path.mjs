/** Native path-value binding only. Workflow rules remain in the kernel; no project discovery or I/O. */
import path from 'node:path';
import { CONFIGURATION_PATH_SYNTAX_V2, configurationAssetPolicies, sourceScopePolicies, workItemLocationPolicies, artifactSetPolicies, astConfigurationPolicies, faultRepairConfigurationPolicies, constitutionConfigurationPolicies, injectionConfigurationPolicies, externalCommandConfigurationPolicies, testSelectionPolicies, trpDocumentPolicies, testRecoveryConfigurationPolicies } from '../kernel/configuration-path-policies.mjs';

// Capturing fixed node:path references has no external effects; omit the binding when unused.
export const NODE_CONFIGURATION_PATH_SYNTAX = /* @__PURE__ */ (() => Object.freeze({
  profile: CONFIGURATION_PATH_SYNTAX_V2, grammar: path.sep === '\\' ? 'win32' : 'posix',
  isAbsolute: path.isAbsolute, normalize: path.normalize, parse: path.parse,
  posixIsAbsolute: path.posix.isAbsolute, posixNormalize: path.posix.normalize, posixBasename: path.posix.basename, posixDirname: path.posix.dirname, posixRelative: path.posix.relative, win32IsAbsolute: path.win32.isAbsolute, toPosix: value => value.split(path.sep).join('/')
}))();

// Fixed factories return frozen own data without invoking primitives. Pure projections let small
// hosts omit unused policy families without importing the legacy filesystem/process utilities.
const sourceScopePoliciesBinding = /* @__PURE__ */ sourceScopePolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const normalizeSourceRoots = /* @__PURE__ */ (() => sourceScopePoliciesBinding.normalizeSourceRoots)();
export const worldModelSourceScope = /* @__PURE__ */ (() => sourceScopePoliciesBinding.worldModelSourceScope)();

const workItemLocationPoliciesBinding = /* @__PURE__ */ workItemLocationPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const DEFAULT_WORK_ITEM_ROOT = /* @__PURE__ */ (() => workItemLocationPoliciesBinding.DEFAULT_WORK_ITEM_ROOT)();
export const normalizeWorkItemRoot = /* @__PURE__ */ (() => workItemLocationPoliciesBinding.normalizeWorkItemRoot)();

const artifactSetPoliciesBinding = /* @__PURE__ */ artifactSetPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const MEMBER_AUTHORITIES = /* @__PURE__ */ (() => artifactSetPoliciesBinding.MEMBER_AUTHORITIES)();
export const normalizeArtifactSet = /* @__PURE__ */ (() => artifactSetPoliciesBinding.normalizeArtifactSet)();
export const normalizeArtifactSets = /* @__PURE__ */ (() => artifactSetPoliciesBinding.normalizeArtifactSets)();
export const artifactSetDiffValues = /* @__PURE__ */ (() => artifactSetPoliciesBinding.artifactSetDiffValues)();

const astConfigurationPoliciesBinding = /* @__PURE__ */ astConfigurationPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const AST_MODES = /* @__PURE__ */ (() => astConfigurationPoliciesBinding.AST_MODES)();
export const AST_FALLBACKS = /* @__PURE__ */ (() => astConfigurationPoliciesBinding.AST_FALLBACKS)();
export const AST_ASSURANCE = /* @__PURE__ */ (() => astConfigurationPoliciesBinding.AST_ASSURANCE)();
export const AST_EVIDENCE_MODES = /* @__PURE__ */ (() => astConfigurationPoliciesBinding.AST_EVIDENCE_MODES)();
export const AST_STORY_START_WARM_MODES = /* @__PURE__ */ (() => astConfigurationPoliciesBinding.AST_STORY_START_WARM_MODES)();
export const AST_STORY_START_WARM_SCOPES = /* @__PURE__ */ (() => astConfigurationPoliciesBinding.AST_STORY_START_WARM_SCOPES)();
export const AST_PREDICATE_TYPES = /* @__PURE__ */ (() => astConfigurationPoliciesBinding.AST_PREDICATE_TYPES)();
export const normalizeAstPolicy = /* @__PURE__ */ (() => astConfigurationPoliciesBinding.normalizeAstPolicy)();

const faultRepairConfigurationPoliciesBinding = /* @__PURE__ */ faultRepairConfigurationPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const normalizeFaultRepairPolicy = /* @__PURE__ */ (() => faultRepairConfigurationPoliciesBinding.normalizeFaultRepairPolicy)();
export const faultRepairENVIRONMENTS = /* @__PURE__ */ (() => faultRepairConfigurationPoliciesBinding.ENVIRONMENTS)();
export const faultRepairACTIONCEILINGS = /* @__PURE__ */ (() => faultRepairConfigurationPoliciesBinding.ACTION_CEILINGS)();
export const faultRepairNormalizePathPrefix = /* @__PURE__ */ (() => faultRepairConfigurationPoliciesBinding.normalizePathPrefix)();

const constitutionConfigurationPoliciesBinding = /* @__PURE__ */ constitutionConfigurationPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const CONSTITUTION_MODES = /* @__PURE__ */ (() => constitutionConfigurationPoliciesBinding.CONSTITUTION_MODES)();
export const DEFAULT_CONSTITUTION_PATH = /* @__PURE__ */ (() => constitutionConfigurationPoliciesBinding.DEFAULT_CONSTITUTION_PATH)();
export const constitutionPolicy = /* @__PURE__ */ (() => constitutionConfigurationPoliciesBinding.constitutionPolicy)();

const injectionConfigurationPoliciesBinding = /* @__PURE__ */ injectionConfigurationPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const injectionConfig = /* @__PURE__ */ (() => injectionConfigurationPoliciesBinding.injectionConfig)();
export const validateInjectionDefinition = /* @__PURE__ */ (() => injectionConfigurationPoliciesBinding.validateInjectionDefinition)();

const externalCommandConfigurationPoliciesBinding = /* @__PURE__ */ externalCommandConfigurationPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const EXTERNAL_MODEL_POLICIES = /* @__PURE__ */ (() => externalCommandConfigurationPoliciesBinding.EXTERNAL_MODEL_POLICIES)();
export const QUALITY_COMMAND_KINDS = /* @__PURE__ */ (() => externalCommandConfigurationPoliciesBinding.QUALITY_COMMAND_KINDS)();
export const QUALITY_COMMAND_REQUIREMENTS = /* @__PURE__ */ (() => externalCommandConfigurationPoliciesBinding.QUALITY_COMMAND_REQUIREMENTS)();
export const ENVIRONMENT_ID_PATTERN = /* @__PURE__ */ (() => externalCommandConfigurationPoliciesBinding.ENVIRONMENT_ID_PATTERN)();
export const TEST_RESULT_ADAPTERS = /* @__PURE__ */ (() => externalCommandConfigurationPoliciesBinding.TEST_RESULT_ADAPTERS)();
export const TEST_COMMAND_ECOSYSTEMS = /* @__PURE__ */ (() => externalCommandConfigurationPoliciesBinding.TEST_COMMAND_ECOSYSTEMS)();
export const normalizeExternalCommand = /* @__PURE__ */ (() => externalCommandConfigurationPoliciesBinding.normalizeExternalCommand)();

const testSelectionPoliciesBinding = /* @__PURE__ */ testSelectionPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const normalizeTestSelectionPath = /* @__PURE__ */ (() => testSelectionPoliciesBinding.normalizeTestSelectionPath)();
export const testSelectionPolicyRefuse = /* @__PURE__ */ (() => testSelectionPoliciesBinding.refuse)();

const trpDocumentPoliciesBinding = /* @__PURE__ */ trpDocumentPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const normalizeDocumentObligations = /* @__PURE__ */ (() => trpDocumentPoliciesBinding.normalizeDocumentObligations)();

const testRecoveryConfigurationPoliciesBinding = /* @__PURE__ */ testRecoveryConfigurationPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const normalizeTestRecoveryPolicy = /* @__PURE__ */ (() => testRecoveryConfigurationPoliciesBinding.normalizeTestRecoveryPolicy)();
export const testRecoveryIntakeFail = /* @__PURE__ */ (() => testRecoveryConfigurationPoliciesBinding.fail)();

// Fixed Node string primitives derive the same default asset policy as the original native owner.
const configurationAssets = /* @__PURE__ */ configurationAssetPolicies(NODE_CONFIGURATION_PATH_SYNTAX);
export const configurationAssetPolicy = /* @__PURE__ */ (() => configurationAssets.configurationAssetPolicy)();
export const mergeConfigurationAssetPolicies = /* @__PURE__ */ (() => configurationAssets.mergeConfigurationAssetPolicies)();
export const DEFAULT_CONFIGURATION_ASSET_POLICY = /* @__PURE__ */ (() => configurationAssets.DEFAULT_CONFIGURATION_ASSET_POLICY)();
export const portableConfigurationPath = /* @__PURE__ */ (() => configurationAssets.portableConfigurationPath)();
export const isConfigurationAssetPath = /* @__PURE__ */ (() => configurationAssets.isConfigurationAssetPath)();
export const configurationAssetSearchRoots = /* @__PURE__ */ (() => configurationAssets.configurationAssetSearchRoots)();
