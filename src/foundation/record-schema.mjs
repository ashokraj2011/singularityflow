/** Pure durable-record format, identity capabilities and version admission. */
import { SingularityFlowError } from './failures.mjs';

/** Historical convergence seals retain the bytes printed by their original published report. */
export function convergenceSealCore(record) {
  const core = structuredClone(record);
  delete core.convergenceSha256;
  delete core.candidateSnapshot;
  const holdsReplaced = Array.isArray(record.findings) && record.findings.some((finding) => finding?.decision?.replaced);
  if (record.schemaVersion >= 5 && !holdsReplaced) core.schemaVersion = record.settledByPlan === undefined ? 4 : 5;
  return core;
}
export const CONVERGENCE_VALUE_SCHEMA=Object.freeze({id:'convergence-record',currentVersion:6,
  minimumReadableVersion:1,maximumReadableVersion:6,immutable:true,unversionedAs:null});

const convergenceFamily=id=>Object.freeze({id,currentVersion:1,minimumReadableVersion:1,maximumReadableVersion:1,immutable:true,unversionedAs:null});
export const NAMESPACE_CONVERGENCE_SCHEMAS=Object.freeze({
  projection:convergenceFamily('namespace-convergence-projection'),decision:convergenceFamily('namespace-convergence-adjudication'),
  policy:convergenceFamily('namespace-convergence-policy'),report:convergenceFamily('namespace-convergence-policy-report'),
  context:convergenceFamily('namespace-convergence-context'),confirmation:convergenceFamily('namespace-convergence-confirmation')
});
export function namespaceConvergenceContextProfile(value){const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_CONVERGENCE_SCHEMAS.context,value);
  return {version:storedVersion,profile:'sflow-namespace-convergence-context/v'+storedVersion};}

export const CONSTITUTION_RECORD_SCHEMA=Object.freeze({id:'constitution-record',currentVersion:1,minimumReadableVersion:1,maximumReadableVersion:1,immutable:true,unversionedAs:null});
export const SOURCE_GROUNDED_REVIEW_SCHEMA=Object.freeze({id:'source-grounded-review',currentVersion:1,minimumReadableVersion:1,maximumReadableVersion:1,immutable:true,unversionedAs:null});
export const MULTI_SCOPE_REVIEW_SCHEMA=Object.freeze({id:'source-grounded-multi-scope-review',currentVersion:1,minimumReadableVersion:1,maximumReadableVersion:1,immutable:true,unversionedAs:null});
export const TEXT_DIGEST_PROFILE = 'sflow-text-digests/sha256-utf8-v1';
/** Existing execution-unit v1 ABI bounds, shared by operational hosts and durable decoration. */
export const EXECUTION_UNIT_LIMITS=Object.freeze({maximumEvents:4096,maximumSessions:1024,maximumOutputBytes:16*1024*1024});
const TEXT_DIGEST_CAPABILITIES = new WeakMap();

export const RECORD_BYTES_PROFILE = 'sflow-record-bytes/utf8-v1';
const RECORD_BYTE_SYNTAX = new WeakMap();

export const TEXT_VALUE_SYNTAX_PROFILE = 'sflow-text-values/utf8-sha256-v1';
const TEXT_VALUE_SYNTAX = new WeakMap();

/** Raw text primitives retain their native invalid-value errors; rules own valid-domain checks. */
export function textValueSyntax(port) {
  const invalid = () => { throw new SingularityFlowError('Text rules require one frozen, explicit UTF-8 size/hash capability.', { code: 'ENGINE_TEXT_VALUE_SYNTAX_INVALID' }); };
  if (!port || typeof port !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(port)) || !Object.isFrozen(port)) invalid();
  const fields = Object.getOwnPropertyDescriptors(port), keys = Reflect.ownKeys(fields);
  if (keys.length !== 3 || keys.some(key => !['profile', 'byteLengthUtf8', 'sha256Utf8'].includes(key))) invalid();
  for (const key of keys) if (!fields[key].enumerable || !Object.hasOwn(fields[key], 'value')
    || (key === 'profile' ? fields[key].value !== TEXT_VALUE_SYNTAX_PROFILE : typeof fields[key].value !== 'function')) invalid();
  if (TEXT_VALUE_SYNTAX.has(port)) return TEXT_VALUE_SYNTAX.get(port);
  const size = fields.byteLengthUtf8.value, hash = fields.sha256Utf8.value;
  const syntax = Object.freeze({
    byteLengthUtf8(value) {
      const result = Reflect.apply(size, port, [value]);
      if (!Number.isSafeInteger(result) || result < 0) throw new SingularityFlowError('Text syntax did not return an exact UTF-8 byte count.', { code: 'ENGINE_TEXT_VALUE_SYNTAX_RESULT_INVALID' });
      return result;
    },
    sha256Utf8(value) {
      const result = Reflect.apply(hash, port, [value]);
      if (typeof result !== 'string' || !/^[a-f0-9]{64}$/u.test(result)) throw new SingularityFlowError('Text syntax did not return an exact lowercase SHA-256 digest.', { code: 'ENGINE_TEXT_VALUE_SYNTAX_RESULT_INVALID' });
      return result;
    }
  });
  TEXT_VALUE_SYNTAX.set(port, syntax); return syntax;
}

/** Capture byte-value primitives only. Parsing, cloning and schema admission belong to foundation. */
export function recordJsonSyntax(port) {
  const invalid = () => { throw new SingularityFlowError('Record parsing requires one frozen, explicit UTF-8 byte capability.', {
    code: 'ENGINE_RECORD_BYTES_PORT_INVALID'
  }); };
  if (!port || typeof port !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(port)) || !Object.isFrozen(port)) invalid();
  const fields = Object.getOwnPropertyDescriptors(port), keys = Reflect.ownKeys(fields);
  if (keys.length !== 3 || keys.some(key => !['profile', 'isBytes', 'decodeUtf8'].includes(key))) invalid();
  for (const key of keys) if (!fields[key].enumerable || !Object.hasOwn(fields[key], 'value')
    || (key === 'profile' ? fields[key].value !== RECORD_BYTES_PROFILE : typeof fields[key].value !== 'function')) invalid();
  if (RECORD_BYTE_SYNTAX.has(port)) return RECORD_BYTE_SYNTAX.get(port);
  const isBytes = fields.isBytes.value, decodeUtf8 = fields.decodeUtf8.value;
  const syntax = Object.freeze({ parseObject(rawBytes) {
    if (rawBytes != null && typeof rawBytes === 'object' && !Array.isArray(rawBytes) && !(rawBytes instanceof Uint8Array)
        && [Object.prototype, null].includes(Object.getPrototypeOf(rawBytes))) return structuredClone(rawBytes);
    let text;
    if (typeof rawBytes === 'string') text = rawBytes;
    else {
      const bytes = Reflect.apply(isBytes, port, [rawBytes]);
      if (typeof bytes !== 'boolean') throw new SingularityFlowError('The record byte capability did not return an exact byte classification.', { code: 'ENGINE_RECORD_BYTES_RESULT_INVALID' });
      if (!bytes) throw new SingularityFlowError('Durable record bytes must be UTF-8 JSON.', { code: 'SCHEMA_RECORD_INVALID' });
      text = Reflect.apply(decodeUtf8, port, [rawBytes]);
      if (typeof text !== 'string') throw new SingularityFlowError('The record byte capability did not return UTF-8 text.', { code: 'ENGINE_RECORD_BYTES_RESULT_INVALID' });
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed) || parsed instanceof Uint8Array
          || ![Object.prototype, null].includes(Object.getPrototypeOf(parsed))) throw new Error('top-level value is not an object');
      return parsed;
    } catch (error) {
      throw new SingularityFlowError(`Durable record is not valid JSON: ${error.message}`, { code: 'SCHEMA_RECORD_INVALID', cause: error });
    }
  } });
  RECORD_BYTE_SYNTAX.set(port, syntax);
  return syntax;
}

// One unchanged v1 record family, shared by the portable policy reader and native registry.
export const APPLICATION_REVIEW_POLICY_SCHEMA = Object.freeze({ id: 'application-review-policy',
  currentVersion: 1, minimumReadableVersion: 1, maximumReadableVersion: 1, unversionedAs: 1,
  immutable: true, migrationPolicy: 'migrate-on-read' });
export const APPLICATION_REVIEW_SESSION_SCHEMA = Object.freeze({ id: 'application-review-session',
  currentVersion: 1, minimumReadableVersion: 1, maximumReadableVersion: 1, unversionedAs: null,
  immutable: false, migrationPolicy: 'migrate-on-read' });

export const REPOSITORY_COMMIT_POLICY_SCHEMAS = Object.freeze({
  policy: Object.freeze({ id: 'repository-commit-policy', currentVersion: 1, minimumReadableVersion: 1,
    maximumReadableVersion: 1, unversionedAs: null, immutable: true, migrationPolicy: 'migrate-on-read' }),
  profile: Object.freeze({ id: 'repository-commit-policy-profile', currentVersion: 1, minimumReadableVersion: 1,
    maximumReadableVersion: 1, unversionedAs: null, immutable: true, migrationPolicy: 'migrate-on-read' })
});

/** Capture a synchronous text primitive without invoking it or evaluating an accessor. */
export function textDigestCapability(port) {
  const invalid = () => { throw new SingularityFlowError('Record identity requires one frozen, explicit UTF-8 SHA-256 capability.', {
    code: 'ENGINE_TEXT_DIGEST_PORT_INVALID'
  }); };
  if (!port || typeof port !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(port)) || !Object.isFrozen(port)) invalid();
  const fields = Object.getOwnPropertyDescriptors(port), keys = Reflect.ownKeys(fields);
  if (keys.length !== 2 || keys.some(key => !['profile', 'sha256Utf8'].includes(key))
    || !fields.profile?.enumerable || !Object.hasOwn(fields.profile, 'value') || fields.profile.value !== TEXT_DIGEST_PROFILE
    || !fields.sha256Utf8?.enumerable || !Object.hasOwn(fields.sha256Utf8, 'value') || typeof fields.sha256Utf8.value !== 'function') invalid();
  if (TEXT_DIGEST_CAPABILITIES.has(port)) return TEXT_DIGEST_CAPABILITIES.get(port);
  const method = fields.sha256Utf8.value;
  const capability = Object.freeze({ sha256Utf8(value) {
    if (typeof value !== 'string') throw new SingularityFlowError('The text digest capability requires a string.', { code: 'ENGINE_TEXT_DIGEST_INPUT_INVALID' });
    const digest = Reflect.apply(method, port, [value]);
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)) throw new SingularityFlowError(
      'The text digest capability did not return an exact lowercase SHA-256 digest.', { code: 'ENGINE_TEXT_DIGEST_RESULT_INVALID' });
    return digest;
  } });
  TEXT_DIGEST_CAPABILITIES.set(port, capability);
  return capability;
}

// Shared immutable format metadata, not backend selection or model/World Model behavior.
const frozenFamily = id => Object.freeze({ id, currentVersion: 1, minimumReadableVersion: 1,
  maximumReadableVersion: 1, unversionedAs: null, immutable: true, migrationPolicy: 'frozen-identity' });
/** The existing execution-unit ABI envelope is retained verbatim when journaled. */
export const EXECUTION_UNIT_ABI_SCHEMA=frozenFamily('sgos-execution-unit-abi');
export const NAMESPACE_STORAGE_SCHEMAS = Object.freeze({
  manifest: frozenFamily('namespace-filesystem-manifest'),
  entry: frozenFamily('namespace-filesystem-entry')
});
export const SQLITE_NAMESPACE_SCHEMAS = Object.freeze({
  manifest: frozenFamily('namespace-sqlite-manifest'),
  entry: frozenFamily('namespace-sqlite-entry')
});
export const CONTENT_STORAGE_SCHEMA = frozenFamily('content-sqlite-manifest');
export const NAMESPACE_READER_SCHEMAS = Object.freeze({
  head: frozenFamily('namespace-story-read-head'),
  state: Object.freeze({id:'namespace-story-read-state',currentVersion:2,minimumReadableVersion:1,
    maximumReadableVersion:2,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  policy: frozenFamily('namespace-story-read-policy'), documents: frozenFamily('namespace-story-document-index'),
  'lifecycle-head': frozenFamily('namespace-story-lifecycle-read-head')
});
const NAMESPACE_READ_STATE_PROFILES=Object.freeze({
  1:Object.freeze({status:false,terminalStatuses:Object.freeze([])}),
  2:Object.freeze({status:true,terminalStatuses:Object.freeze(['closed','cancelled'])})
});
export function namespaceReaderRecordProfile(kind,input) {
  if(!Object.hasOwn(NAMESPACE_READER_SCHEMAS,kind))throw new SingularityFlowError('Unknown namespace read record family.',{code:'SCHEMA_FAMILY_UNKNOWN'});
  const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_READER_SCHEMAS[kind],input);
  return Object.freeze({version:storedVersion,format:`sflow-namespace-read-${kind}/v${storedVersion}`,
    state:kind==='state'?NAMESPACE_READ_STATE_PROFILES[storedVersion]:null});
}
/** Preserved immutable records are read at their stored version; no synthetic migration step. */
export function recordReadTargetVersion(entry,storedVersion) {
  return entry.migrationPolicy==='preserve-versions'?storedVersion:entry.currentVersion;
}
export function assertRecordRestampAllowed(entry,value) {
  if(entry.migrationPolicy==='preserve-versions'&&value.schemaVersion!=null&&value.schemaVersion!==entry.currentVersion) {
    throw new SingularityFlowError('Preserve the stored record version; create a new explicitly versioned record instead.',{
      code:'SCHEMA_VERSION_RESTAMP_PROHIBITED',details:{family:entry.id,stored:value.schemaVersion,current:entry.currentVersion}});
  }
}
export const NAMESPACE_LIFECYCLE_SCHEMAS = Object.freeze({
  authority: frozenFamily('namespace-lifecycle-authority'), configuration: frozenFamily('namespace-lifecycle-configuration'),
  head: frozenFamily('namespace-lifecycle-head'),
  // Immutable bodies keep their stored version and identity; readers dispatch without migration.
  state: Object.freeze({ id: 'namespace-lifecycle-state', currentVersion: 2, minimumReadableVersion: 1,
    maximumReadableVersion: 2, unversionedAs: null, immutable: true, migrationPolicy: 'preserve-versions' }),
  prepared: Object.freeze({id:'namespace-lifecycle-prepared',currentVersion:3,minimumReadableVersion:1,maximumReadableVersion:3,
    unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  manifest: Object.freeze({id:'namespace-lifecycle-manifest',currentVersion:3,minimumReadableVersion:1,maximumReadableVersion:3,
    unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'})
});
export const NAMESPACE_ENROLLMENT_SCHEMAS = Object.freeze({
  intent: frozenFamily('namespace-enrollment-intent'), manifest: frozenFamily('namespace-enrollment-manifest')
});
export const NAMESPACE_CONFIGURATION_SCHEMAS = Object.freeze({
  source: frozenFamily('namespace-configuration-source'), compiled: frozenFamily('namespace-configuration-compiled'),
  head: frozenFamily('namespace-configuration-head'), intent: frozenFamily('namespace-configuration-intent'),
  manifest: frozenFamily('namespace-configuration-manifest')
});
export const NAMESPACE_STORY_SCHEMAS = Object.freeze({
  intent: frozenFamily('namespace-story-creation-intent'), genesis: frozenFamily('namespace-story-genesis'),
  manifest: frozenFamily('namespace-story-creation-manifest'), workflow: frozenFamily('namespace-story-workflow')
});
export const SOURCE_SNAPSHOT_SCHEMA = frozenFamily('sgos-source-snapshot');
export const SOURCE_BINDING_SCHEMA = frozenFamily('namespace-source-binding');
export const NAMESPACE_DRAFT_SCHEMAS = Object.freeze({
  head: frozenFamily('namespace-phase-draft-head'), body: frozenFamily('namespace-phase-draft-body'),
  operation: frozenFamily('namespace-phase-draft-operation')
});
export const NAMESPACE_PREPARATION_SCHEMAS = Object.freeze({
  context: frozenFamily('namespace-preparation-context'), generation:Object.freeze({id:'namespace-source-generation',currentVersion:4,
    minimumReadableVersion:1,maximumReadableVersion:4,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'})
});
/** Legacy private payload bytes remain unversioned v1; typed output members have their own v2. */
export const NAMESPACE_PREPARED_PAYLOAD_SCHEMA=Object.freeze({id:'namespace-prepared-phase',currentVersion:4,
  minimumReadableVersion:1,maximumReadableVersion:4,unversionedAs:1,immutable:true,migrationPolicy:'preserve-versions'});
/** Unversioned v1 keeps its exact old shape, including refusal of extra wire fields. */
export function namespacePreparedPayloadProfile(value){const storedVersion=value?.format==='sflow-namespace-prepared-phase/v1'?1
  :admitRecordSchemaVersion(NAMESPACE_PREPARED_PAYLOAD_SCHEMA,value).storedVersion;
  return Object.freeze({version:storedVersion,format:'sflow-namespace-prepared-phase/v'+storedVersion,members:storedVersion>=2,
    ...(storedVersion>=3?{convergence:true}:{}),...(storedVersion===4?{artifactRepair:true}:{})});}
export const NAMESPACE_ARTIFACT_SET_SCHEMAS=Object.freeze(Object.fromEntries([['manifest','namespace-artifact-set-policy'],['report','namespace-artifact-set-report']]
  .map(([kind,id])=>[kind,Object.freeze({id,currentVersion:2,minimumReadableVersion:1,maximumReadableVersion:2,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'})])));
export function namespaceArtifactSetRecordProfile(kind,value){const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_ARTIFACT_SET_SCHEMAS[kind],value);
  return Object.freeze({version:storedVersion,format:'sflow-'+NAMESPACE_ARTIFACT_SET_SCHEMAS[kind].id+'/v'+storedVersion,repair:storedVersion===2});}
export const NAMESPACE_WITNESS_CONTEXT_SCHEMA=frozenFamily('namespace-witness-context');
export function namespaceWitnessContextProfile(value){const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_WITNESS_CONTEXT_SCHEMA,value);
  return Object.freeze({version:storedVersion,profile:'sflow-namespace-witness-context/v'+storedVersion});}
export function namespaceGenerationProfile(value){const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_PREPARATION_SCHEMAS.generation,value);
  return Object.freeze({version:storedVersion,continuation:storedVersion===2,...(storedVersion===3?{predecessors:true}:{}),
    ...(storedVersion===4?{reviewedOpening:true,optionalPredecessors:true}:{}),format:'sflow-namespace-source-generation/v'+storedVersion});}
export const NAMESPACE_SOURCE_OPENING_CONTEXT_SCHEMA=frozenFamily('namespace-source-opening-context');
export function namespaceSourceOpeningContextProfile(value){const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_SOURCE_OPENING_CONTEXT_SCHEMA,value);
  return Object.freeze({version:storedVersion,profile:'sflow-namespace-source-opening-context/v'+storedVersion});}
export const NAMESPACE_PHASE_CHECK_SCHEMAS = /* @__PURE__ */ Object.freeze({
  plan: /* @__PURE__ */ Object.freeze({id:'namespace-phase-check-plan',currentVersion:5,minimumReadableVersion:1,maximumReadableVersion:5,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  intent: /* @__PURE__ */ frozenFamily('namespace-phase-check-intent'),
  result: /* @__PURE__ */ frozenFamily('namespace-phase-check-result'),
  manifest: /* @__PURE__ */ frozenFamily('namespace-phase-check-manifest'),
  index: /* @__PURE__ */ frozenFamily('namespace-phase-check-index'),
  binding: /* @__PURE__ */ frozenFamily('namespace-phase-check-binding')
});
export function namespacePhaseCheckPlanProfile(value){
  const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_PHASE_CHECK_SCHEMAS.plan,value);
  return Object.freeze({version:storedVersion,format:'sflow-namespace-phase-check-plan/v'+storedVersion,commands:storedVersion>=2,...(storedVersion===3||storedVersion>=4&&Object.hasOwn(value,'recovery')?{recovery:true}:{}),...(storedVersion===4||storedVersion===5&&Object.hasOwn(value,'executionProfile')?{mixed:true}:{}),...(storedVersion===5?{selective:true}:{})});
}
export const isNamespaceTestRecoveryPolicy=kind=>['test-recovery/v1','test-recovery/v2'].includes(kind);
export const NAMESPACE_SELECTIVE_TEST_RECOVERY_SCHEMA=frozenFamily('namespace-selective-test-recovery');
export const NAMESPACE_SELECTIVE_TEST_RECOVERY_CONTEXT_SCHEMA=frozenFamily('namespace-selective-test-recovery-context');
export const SELECTIVE_CHECK_SUMMARY_SCHEMA=frozenFamily('selective-check-summary');
export const NODE_CHECK_ENVIRONMENT_OBSERVATION_SCHEMA=frozenFamily('node-check-environment-observation');
export const NAMESPACE_STORY_COMMAND_SCHEMAS=Object.freeze({context:frozenFamily('namespace-test-command-context'),replacement:frozenFamily('namespace-command-replacement')});
export const NAMESPACE_TEST_RECOVERY_SCHEMAS=Object.freeze({
  agreement:frozenFamily('namespace-test-recovery-agreement'),context:frozenFamily('namespace-test-recovery-review'),
  policy:Object.freeze({id:'namespace-test-recovery-policy-manifest',currentVersion:2,minimumReadableVersion:1,maximumReadableVersion:2,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),report:Object.freeze({id:'namespace-test-recovery-policy',currentVersion:2,minimumReadableVersion:1,maximumReadableVersion:2,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  attempt:frozenFamily('namespace-test-repair-attempt'),result:frozenFamily('namespace-test-repair-result'),
  budget:frozenFamily('namespace-test-repair-budget')});
export function namespaceTestRecoveryRecordProfile(kind,value){
  const family=NAMESPACE_TEST_RECOVERY_SCHEMAS[kind];
  if(!family)throw new SingularityFlowError('Unknown test-recovery record family.',{code:'SCHEMA_FAMILY_UNKNOWN'});
  const {storedVersion}=admitRecordSchemaVersion(family,value);
  return Object.freeze({version:storedVersion,profile:'sflow-'+family.id+'/v'+storedVersion});
}
export const isNamespaceTestCohortPolicy=kind=>['test-cohort/v1','test-cohort/v2'].includes(kind);
export const NAMESPACE_TEST_COHORT_SCHEMAS=Object.freeze({decision:frozenFamily('namespace-test-cohort-decision'),context:frozenFamily('namespace-test-cohort-context'),policy:Object.freeze({id:'namespace-test-cohort-policy-manifest',currentVersion:2,minimumReadableVersion:1,maximumReadableVersion:2,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),report:Object.freeze({id:'namespace-test-cohort-policy',currentVersion:2,minimumReadableVersion:1,maximumReadableVersion:2,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'})});
const reuseFamily=id=>Object.freeze({id,currentVersion:2,minimumReadableVersion:1,maximumReadableVersion:2,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'});
export const NAMESPACE_EVIDENCE_REUSE_SCHEMAS=Object.freeze({
  record:reuseFamily('namespace-evidence-reuse'),context:reuseFamily('namespace-evidence-reuse-context'),
  policy:reuseFamily('namespace-evidence-reuse-policy-manifest'),report:reuseFamily('namespace-evidence-reuse-policy')});
export const isNamespaceEvidenceReusePolicy=kind=>['evidence-reuse/v1','evidence-reuse/v2'].includes(kind);
const testRiskFamily=id=>Object.freeze({id,currentVersion:3,minimumReadableVersion:1,maximumReadableVersion:3,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'});
export const NAMESPACE_TEST_RISK_SCHEMAS=Object.freeze({record:testRiskFamily('namespace-test-run-risk'),
  context:testRiskFamily('namespace-test-risk-context'),policy:testRiskFamily('namespace-test-risk-policy-manifest'),report:testRiskFamily('namespace-test-risk-policy')});
export const NAMESPACE_KNOWN_TEST_RISK_SCHEMAS=Object.freeze({record:frozenFamily('namespace-known-test-run-risk'),context:frozenFamily('namespace-known-test-risk-context'),
  policy:frozenFamily('namespace-known-test-risk-policy-manifest'),report:frozenFamily('namespace-known-test-risk-policy')});
export const isNamespaceTestRiskPolicy=kind=>['test-risk/v1','test-risk/v2','test-risk/v3','known-test-risk/v1'].includes(kind);
export const namespaceTestRiskPolicyKind=report=>namespaceTestRiskRecordProfile('report',report).knownFailure?'known-test-risk/v1':'test-risk/v'+namespaceTestRiskRecordProfile('report',report).version;
export function namespaceTestRiskRecordProfile(kind,value){
  if(String(value?.profile??value?.format??'').startsWith('sflow-namespace-known-test-')){
    const family=NAMESPACE_KNOWN_TEST_RISK_SCHEMAS[kind];if(!family)throw new SingularityFlowError('Unknown known-test-risk family.',{code:'SCHEMA_FAMILY_UNKNOWN'});
    const {storedVersion}=admitRecordSchemaVersion(family,value);return Object.freeze({version:storedVersion,profile:'sflow-'+family.id+'/v'+storedVersion,
      executionRisk:true,recoveryRisk:true,knownFailure:true});
  }
  const family=NAMESPACE_TEST_RISK_SCHEMAS[kind];
  if(!family)throw new SingularityFlowError('Unknown test-risk record family.',{code:'SCHEMA_FAMILY_UNKNOWN'});
  const {storedVersion}=admitRecordSchemaVersion(family,value);
  return Object.freeze({version:storedVersion,profile:'sflow-'+family.id+'/v'+storedVersion,
    ...(storedVersion>=2?{executionRisk:true}:{}),...(storedVersion===3?{recoveryRisk:true}:{})});
}
export function namespaceEvidenceReuseRecordProfile(kind,value){
  const family=NAMESPACE_EVIDENCE_REUSE_SCHEMAS[kind];
  if(!family)throw new SingularityFlowError('Unknown evidence-reuse record family.',{code:'SCHEMA_FAMILY_UNKNOWN'});
  const {storedVersion}=admitRecordSchemaVersion(family,value);
  return Object.freeze({version:storedVersion,profile:'sflow-'+family.id+'/v'+storedVersion,...(storedVersion===2?{environmentQualified:true}:{})});
}
export const NAMESPACE_EVIDENCE_CONTEXT_SCHEMA=Object.freeze({id:'namespace-evidence-context',currentVersion:4,minimumReadableVersion:1,maximumReadableVersion:4,
  unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'});
export const NAMESPACE_OBLIGATION_RISK_SCHEMA=frozenFamily('namespace-obligation-risk');
export function namespaceObligationRiskRecordProfile(value){const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_OBLIGATION_RISK_SCHEMA,value);
  return {version:storedVersion,profile:'sflow-namespace-obligation-risk/v'+storedVersion};}
export function namespaceEvidenceContextProfile(value){
  const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_EVIDENCE_CONTEXT_SCHEMA,value);
  return {version:storedVersion,profile:'sflow-namespace-evidence-context/v'+storedVersion};
}
export function namespaceStoryCommandRecordProfile(kind,value){
  const family=NAMESPACE_STORY_COMMAND_SCHEMAS[kind];
  if(!family)throw new SingularityFlowError('Unknown Story-command record family.',{code:'SCHEMA_FAMILY_UNKNOWN'});
  const {storedVersion}=admitRecordSchemaVersion(family,value);
  return Object.freeze({version:storedVersion,format:'sflow-'+family.id+'/v'+storedVersion});
}
export const NAMESPACE_SOURCE_RETENTION_SCHEMAS = /* @__PURE__ */ Object.freeze({
  plan: /* @__PURE__ */ frozenFamily('namespace-source-retention-plan'),
  intent: /* @__PURE__ */ frozenFamily('namespace-source-retention-intent'),
  result: /* @__PURE__ */ frozenFamily('namespace-source-retention-result'),
  repository: /* @__PURE__ */ frozenFamily('namespace-source-retention-repository'),
  manifest: /* @__PURE__ */ frozenFamily('namespace-source-retention-manifest'),
  index: /* @__PURE__ */ frozenFamily('namespace-source-retention-index'),
  binding: /* @__PURE__ */ frozenFamily('namespace-source-retention-binding')
});
/** Explicit output intent is distinct from local input attachments and source archives. */
export const NAMESPACE_OUTPUT_RETENTION_SCHEMAS=/* @__PURE__ */ Object.freeze({
  plan:/* @__PURE__ */ frozenFamily('namespace-output-retention-plan'),intent:/* @__PURE__ */ frozenFamily('namespace-output-retention-intent'),
  result:/* @__PURE__ */ frozenFamily('namespace-output-retention-result'),manifest:/* @__PURE__ */ frozenFamily('namespace-output-retention-manifest'),
  index:/* @__PURE__ */ frozenFamily('namespace-output-retention-index'),binding:/* @__PURE__ */ frozenFamily('namespace-output-retention-binding')});
export const NAMESPACE_SOURCE_BASELINE_SCHEMAS = /* @__PURE__ */ Object.freeze({
  plan: /* @__PURE__ */ frozenFamily('namespace-source-baseline-plan'),
  intent: /* @__PURE__ */ frozenFamily('namespace-source-baseline-intent'),
  result: /* @__PURE__ */ frozenFamily('namespace-source-baseline-result'),
  repository: /* @__PURE__ */ frozenFamily('namespace-source-baseline-repository'),
  manifest: /* @__PURE__ */ frozenFamily('namespace-source-baseline-manifest'),
  index: /* @__PURE__ */ frozenFamily('namespace-source-baseline-index')
});
export const SOURCE_CONTROL_OBSERVATION_SCHEMA=/* @__PURE__ */ Object.freeze({id:'source-control-observation',currentVersion:2,
  minimumReadableVersion:1,maximumReadableVersion:2,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'});
/** A v1 capability keeps its original readable range, including future-version errors. */
export function sourceControlObservationRecordProfile(contract,input){
  const v2=contract==='sflow-source-control-reader/v2',expected=v2?2:1,
    family=v2?SOURCE_CONTROL_OBSERVATION_SCHEMA:{...SOURCE_CONTROL_OBSERVATION_SCHEMA,currentVersion:1,maximumReadableVersion:1},
    {storedVersion}=admitRecordSchemaVersion(family,input);
  if(storedVersion!==expected)throw new SingularityFlowError('The source-control capability requires its own observation version.',{code:'SCHEMA_VERSION_INVALID'});
  return Object.freeze({version:storedVersion,format:'sflow-source-control-observation/v'+storedVersion});
}
// Native claim-map v2 retains its v1 reader/migration path; the actual conversion stays in SDA.
export const SPECIFICATION_CLAIM_MAP_SCHEMA=/* @__PURE__ */ Object.freeze({id:'specification-claim-map',currentVersion:2,
  minimumReadableVersion:1,maximumReadableVersion:2,unversionedAs:null,immutable:true,migrationPolicy:'migrate-on-read'});
// Native specification-index v1 keeps its existing read range and migration classification.
export const SPECIFICATION_INDEX_SCHEMA=/* @__PURE__ */ Object.freeze({id:'specification-index',currentVersion:1,
  minimumReadableVersion:1,maximumReadableVersion:1,unversionedAs:null,immutable:true,migrationPolicy:'migrate-on-read'});
// Shared native/portable v1 read metadata; preserve the installed family's migration classification.
export const REPOSITORY_CHANGE_SET_SCHEMA=/* @__PURE__ */ Object.freeze({id:'repository-change-set',currentVersion:1,
  minimumReadableVersion:1,maximumReadableVersion:1,unversionedAs:null,immutable:true,migrationPolicy:'migrate-on-read'});
/** Frozen native replay admission, including the existing numeric-string compatibility. */
export function codeDeliveryReplayVersion(receipt) {
  return Boolean(receipt&&receipt.kind==='code-delivery'&&Number(receipt.schemaVersion)===2);
}
export const NAMESPACE_SOURCE_CONTROL_SCHEMAS=/* @__PURE__ */ Object.freeze({
  ...Object.fromEntries(['plan','intent','result','manifest','index'].map(kind=>[kind,Object.freeze({id:'namespace-source-control-'+kind,currentVersion:2,
    minimumReadableVersion:1,maximumReadableVersion:2,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'})]))
});
export function namespaceSourceControlRecordProfile(kind,input){
  if(!Object.hasOwn(NAMESPACE_SOURCE_CONTROL_SCHEMAS,kind))throw new SingularityFlowError('Unknown source-control record family.',{code:'SCHEMA_FAMILY_UNKNOWN'});
  const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_SOURCE_CONTROL_SCHEMAS[kind],input);
  return Object.freeze({version:storedVersion,profile:'sflow-namespace-source-control/v'+storedVersion,
    format:'sflow-namespace-source-control-'+kind+'/v'+storedVersion,origins:storedVersion===2});
}
export const PHASE_PUBLICATION_SCHEMAS = Object.freeze({
  binding: frozenFamily('phase-publication-binding'),
  manifest:Object.freeze({id:'namespace-phase-publication',currentVersion:5,minimumReadableVersion:1,maximumReadableVersion:5,
    unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'})
});
export function namespacePublicationRecordProfile(input) {
  const {storedVersion}=admitRecordSchemaVersion(PHASE_PUBLICATION_SCHEMAS.manifest,input);
  return Object.freeze({version:storedVersion,format:`sflow-namespace-phase-publication/v${storedVersion}`,
    profile:storedVersion===5?'sflow-forward-amendment-publication/v1':storedVersion===4?'sflow-policy-publication/v1':storedVersion===3?'sflow-specification-publication/v1':`sflow-primary-document-publication/v${storedVersion}`,
    checks:storedVersion>1,...(storedVersion>=3?{optionalChecks:true,specifications:true}:{}),
    ...(storedVersion>=4?{optionalSpecifications:true,policyEvidence:true}:{}),...(storedVersion===5?{forwardAmendment:true}:{})});
}
export const SPECIFICATION_ANALYSIS_REPORT_SCHEMA=frozenFamily('specification-quality-analysis');
export const REPAIR_BUDGET_STATE_SCHEMA=frozenFamily('repair-budget-state');
export const NAMESPACE_REPAIR_BUDGET_SCHEMA=frozenFamily('namespace-repair-budget-source');
export const NAMESPACE_HUMAN_DECISION_SCHEMA=Object.freeze({id:'namespace-human-decision',currentVersion:4,minimumReadableVersion:1,maximumReadableVersion:4,
  unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'});
export function namespaceHumanDecisionProfile(value){const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_HUMAN_DECISION_SCHEMA,value);
  return Object.freeze({version:storedVersion,format:'sflow-namespace-human-decision/v'+storedVersion,repairBudget:storedVersion>=2,
    ...(storedVersion===3?{targeted:true}:{}),...(storedVersion===4?{artifactRepair:true}:{})});}
export const NAMESPACE_UPSTREAM_PLAN_CORRECTION_PROFILE='sflow-namespace-upstream-plan-correction-source/v1';
export const NAMESPACE_PLAN_CORRECTION_SCHEMAS=Object.freeze({record:Object.freeze({id:'namespace-plan-row-correction',currentVersion:2,minimumReadableVersion:1,maximumReadableVersion:2,
  unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),context:frozenFamily('namespace-plan-correction-context')});
export function namespacePlanCorrectionRecordProfile(kind,value){const family=NAMESPACE_PLAN_CORRECTION_SCHEMAS[kind];
  const {storedVersion}=admitRecordSchemaVersion(family,value);return Object.freeze({version:storedVersion,format:'sflow-'+family.id+'/v'+storedVersion,
    ...(kind==='record'&&storedVersion>1?{evidenceClassification:true}:{})});}
export const NAMESPACE_PHASE_POLICY_SCHEMAS=Object.freeze({binding:frozenFamily('namespace-phase-policy-evidence-binding'),
  documentReview:Object.freeze({id:'namespace-document-review',currentVersion:2,minimumReadableVersion:1,maximumReadableVersion:2,
    unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  documentReviewReport:Object.freeze({id:'namespace-document-review-report',currentVersion:2,minimumReadableVersion:1,maximumReadableVersion:2,
    unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  constitution:frozenFamily('namespace-constitution-policy'),constitutionReport:frozenFamily('namespace-constitution-policy-report'),
  assignment:frozenFamily('namespace-phase-assignment-policy'),assignmentReport:frozenFamily('namespace-phase-assignment-report'),
  analysis:frozenFamily('namespace-specification-analysis'),
  code:Object.freeze({id:'namespace-code-policy',currentVersion:38,minimumReadableVersion:1,maximumReadableVersion:38,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  codeReport:Object.freeze({id:'namespace-code-policy-report',currentVersion:38,minimumReadableVersion:1,maximumReadableVersion:38,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  codeInputs:Object.freeze({id:'namespace-code-input-policy',currentVersion:3,minimumReadableVersion:1,maximumReadableVersion:3,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  codeInputReport:Object.freeze({id:'namespace-code-input-policy-report',currentVersion:3,minimumReadableVersion:1,maximumReadableVersion:3,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  conformance:Object.freeze({id:'namespace-conformance-policy',currentVersion:4,minimumReadableVersion:1,maximumReadableVersion:4,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  conformanceReport:Object.freeze({id:'namespace-conformance-policy-report',currentVersion:4,minimumReadableVersion:1,maximumReadableVersion:4,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'})});
export function namespaceDocumentReviewRecordProfile(kind,value){const family=NAMESPACE_PHASE_POLICY_SCHEMAS[kind==='report'?'documentReviewReport':'documentReview'],
  {storedVersion}=admitRecordSchemaVersion(family,value);return Object.freeze({version:storedVersion,format:'sflow-'+family.id+'/v'+storedVersion,kind:'document-review/v'+storedVersion});}
/** Schema selection stays here; evidence location and acceptance remain persistence concerns. */
export function namespacePhasePolicyBindingProfile(value){const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS.binding,value);
  return Object.freeze({version:storedVersion,format:'sflow-namespace-phase-policy-evidence-binding/v'+storedVersion});}
/** Producer failures stay failed; v2 carries only separately authenticated known-failure permission. */
export function namespaceCodeInputPolicyProfile(kind,value){
  if(!['codeInputs','codeInputReport'].includes(kind))throw new SingularityFlowError('Unknown Code input record family.',{code:'SCHEMA_FAMILY_UNKNOWN'});
  const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS[kind],value);
  return Object.freeze({version:storedVersion,kind:'approved-code-inputs/v'+storedVersion,
    format:'sflow-namespace-code-input-policy'+(kind==='codeInputReport'?'-report':'')+'/v'+storedVersion,...(storedVersion===2?{knownFailureInputs:true}:{}),...(storedVersion===3?{selectiveInputs:true}:{})});
}
/** Frozen opt-in conformance meanings; installed migration families remain unchanged. */
export function namespaceConformancePolicyProfile(kind,value){
  if(!['conformance','conformanceReport'].includes(kind))throw new SingularityFlowError('Unknown conformance policy record family.',{code:'SCHEMA_FAMILY_UNKNOWN'});
  const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS[kind],value);
  return Object.freeze({version:storedVersion,issueLinks:[2,4].includes(storedVersion),kind:'conformance/v'+storedVersion,...(storedVersion>=3?{knownFailureInputs:true}:{}),
    format:'sflow-namespace-conformance-policy'+(kind==='conformanceReport'?'-report':'')+'/v'+storedVersion});
}
export function namespaceCodePolicyProfile(kind,value){
  if(!['code','codeReport'].includes(kind))throw new SingularityFlowError('Unknown Code policy record family.',{code:'SCHEMA_FAMILY_UNKNOWN'});
  const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_PHASE_POLICY_SCHEMAS[kind],value);
  if(storedVersion===38)return {version:38,selectiveRecovery:true,kind:'code-delivery/v38',format:'sflow-namespace-code-policy'+(kind==='codeReport'?'-report':'')+'/v38'};
  if(storedVersion===32)return {version:32,executionRisk:true,kind:'code-delivery/v32',format:'sflow-namespace-code-policy'+(kind==='codeReport'?'-report':'')+'/v32'};
  if(storedVersion===33)return {version:33,executionRisk:true,knownFailureRisk:true,kind:'code-delivery/v33',format:'sflow-namespace-code-policy'+(kind==='codeReport'?'-report':'')+'/v33'};
  if([36,37].includes(storedVersion))return {version:storedVersion,executionRisk:true,reviewedSuccessorRisk:true,...(storedVersion===37?{knownFailureRisk:true}:{}),
    kind:'code-delivery/v'+storedVersion,format:'sflow-namespace-code-policy'+(kind==='codeReport'?'-report':'')+'/v'+storedVersion};
  if([34,35].includes(storedVersion))return {version:storedVersion,reviewedSuccessor:true,rework:true,optionalHistory:true,optionalPredecessors:true,optionalOutputs:true,optionalRepositoryCoverage:true,
    ...(storedVersion===35?{humanAcceptance:true}:{}),kind:'code-delivery/v'+storedVersion,format:'sflow-namespace-code-policy'+(kind==='codeReport'?'-report':'')+'/v'+storedVersion};
  return {version:storedVersion,rework:storedVersion>=2,...(storedVersion>=6?{optionalHistory:true}:{}),...([7,9,11,13,15,17,19,21,23,25,27,29,31].includes(storedVersion)?{humanAcceptance:true}:{}),
    ...([10,11].includes(storedVersion)?{predecessors:true}:{}),...(storedVersion>=12?{outputs:true,optionalPredecessors:true}:{}),
    ...(storedVersion>=14?{optionalOutputs:true}:{}),...([14,15,18,19,24,25,26,27,28,29,30,31].includes(storedVersion)?{targeted:true}:{}),
    ...([16,17,18,19,22,23,26,27,30,31].includes(storedVersion)?{repositoryCoverage:true}:{}),...(storedVersion>=20?{documentRepair:true}:{}),...(storedVersion>=24?{repeatedReturns:true}:{}),
    kind:'code-delivery/v'+storedVersion,format:'sflow-namespace-code-policy'+(kind==='codeReport'?'-report':'')+'/v'+storedVersion};
}
export function namespaceCodeReportEvidenceProfile(report){const outer=namespaceCodePolicyProfile('codeReport',report);return outer.executionRisk||outer.selectiveRecovery?namespaceCodePolicyProfile('codeReport',{schemaVersion:report.evidenceVersion}):outer;}
export function namespaceCodeExecutionRiskEvidenceAllowed(profile,version){return Number.isInteger(version)
  &&(profile.reviewedSuccessorRisk?[34,35].includes(version):version>=1&&version<=31);}
export function namespaceCodeExecutionRiskProfile(report,{evidenceVersion=null}={}){const known=namespaceTestRiskRecordProfile('report',report).knownFailure,
  successor=[34,35].includes(evidenceVersion);return namespaceCodePolicyProfile('codeReport',{schemaVersion:successor?known?37:36:known?33:32});}
/** Authenticated configured loops retain v2 bytes; explicit reviewer returns use a new v3 proof. */
export function namespaceCodePreflightVersion(preflight){
  if(preflight.history?.profile==='sflow-namespace-code-history/v13')return 34;
  if(['sflow-namespace-code-history/v11','sflow-namespace-code-history/v12'].includes(preflight.history?.profile))return preflight.repositoryScope?.profile==='sflow-namespace-repository-coverage/v1'?30:28;
  if(preflight.history?.profile==='sflow-namespace-code-history/v10')return preflight.repositoryScope?.profile==='sflow-namespace-repository-coverage/v1'?26:24;
  if(preflight.history?.profile==='sflow-namespace-code-history/v9')return preflight.repositoryScope?.profile==='sflow-namespace-repository-coverage/v1'?22:20;
  if(preflight.repositoryScope?.profile==='sflow-namespace-repository-coverage/v1')return preflight.history?.profile==='sflow-namespace-code-history/v8'?18:16;
  if(preflight.history?.profile==='sflow-namespace-code-history/v8')return 14;
  if(preflight.outputs?.profile==='sflow-namespace-code-outputs/v1'&&preflight.outputs.files?.length)return 12;
  if(preflight.priorCode?.profile==='sflow-namespace-code-predecessors/v1'&&preflight.priorCode.phases?.length)return 10;
  if(['sflow-namespace-code-history/v5','sflow-namespace-code-history/v6','sflow-namespace-code-history/v7'].includes(preflight.history?.profile))return 8;
  if(preflight.plan?.amendments?.length)return 6;
  if(!preflight.history)return 1;
  if(preflight.history.profile==='sflow-namespace-code-history/v1')return 2;
  if(preflight.history.profile==='sflow-namespace-code-history/v2')return 3;
  if(preflight.history.profile==='sflow-namespace-code-history/v3')return 4;
  if(preflight.history.profile==='sflow-namespace-code-history/v4')return 5;
  throw new SingularityFlowError('Unknown Code history profile.',{code:'ENGINE_STORAGE_UNSUPPORTED'});
}
/** Manifest and report versions are selected together by the immutable record contract. */
export function namespaceCodePolicyVersionsMatch(manifest,report){
  return namespaceCodePolicyProfile('code',manifest).version===namespaceCodePolicyProfile('codeReport',report).version;
}
export const NAMESPACE_CLARIFICATION_SCHEMAS=Object.freeze({response:frozenFamily('namespace-clarification-response'),
  manifest:frozenFamily('namespace-clarification-manifest'),index:frozenFamily('namespace-clarification-index'),
  publication:frozenFamily('namespace-clarification-publication')});
export const NAMESPACE_SPECIFICATION_SCHEMAS=Object.freeze({
  binding:frozenFamily('namespace-specification-evidence-binding'),manifest:Object.freeze({id:'namespace-specification-evidence',currentVersion:2,
    minimumReadableVersion:1,maximumReadableVersion:2,unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'})
});
export const REPOSITORY_PLAN_SCHEMA=/* @__PURE__ */ frozenFamily('repository-plan');
export function namespaceSpecificationRecordProfile(input){
  const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_SPECIFICATION_SCHEMAS.manifest,input);
  return Object.freeze({version:storedVersion,format:'sflow-namespace-specification-evidence/v'+storedVersion,repositoryPlan:storedVersion===2});
}
export function namespaceSpecificationWriterProfile({repositoryPlan=false}={}){
  return namespaceSpecificationRecordProfile({schemaVersion:repositoryPlan?2:1});
}
export const NAMESPACE_SOURCE_REVIEW_SCHEMAS=Object.freeze({context:frozenFamily('namespace-source-review-context'),submitted:frozenFamily('namespace-submitted-source-review')});
export function namespaceSourceReviewRecordProfile(kind,input){const entry=NAMESPACE_SOURCE_REVIEW_SCHEMAS[kind];
  if(!entry)throw new SingularityFlowError('Unknown source-review record family.',{code:'SCHEMA_FAMILY_UNKNOWN'});
  const {storedVersion}=admitRecordSchemaVersion(entry,input);
  return Object.freeze({version:storedVersion,profile:(kind==='context'?'sflow-namespace-source-review-context/v':'sflow-namespace-submitted-source-review/v')+storedVersion});}
export const NAMESPACE_SUBMISSION_SCHEMAS = Object.freeze({
  binding: frozenFamily('namespace-phase-submission-binding'),
  packet:Object.freeze({id:'namespace-phase-review-packet',currentVersion:6,minimumReadableVersion:1,maximumReadableVersion:6,
    unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  routing:frozenFamily('namespace-submission-routing'),input:frozenFamily('phase-decision-input-record')
});
export function namespaceSubmissionRecordProfile(input) {
  const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_SUBMISSION_SCHEMAS.packet,input);
  return Object.freeze({version:storedVersion,format:`sflow-namespace-phase-review-packet/v${storedVersion}`,
    profile:storedVersion===6?'sflow-forward-amendment-submission/v1':`sflow-primary-document-submission/v${storedVersion}`,routing:storedVersion>1&&storedVersion<6,...(storedVersion>2&&storedVersion<6?{checks:true}:{}),
    ...(storedVersion>=4&&storedVersion<6?{sourceReview:true}:{}),...(storedVersion===5?{convergence:true}:{}),...(storedVersion===6?{forwardAmendment:true}:{})});
}
export function namespaceSubmissionWriterProfile({routing=false,checks=false,sourceReview=false,convergence=false}={}) {
  return namespaceSubmissionRecordProfile({schemaVersion:convergence?5:sourceReview?4:checks?3:routing?2:1});
}
export const NAMESPACE_APPROVAL_SCHEMAS = Object.freeze({
  vote:Object.freeze({id:'namespace-phase-approval-vote',currentVersion:9,minimumReadableVersion:1,maximumReadableVersion:9,
    unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),binding:frozenFamily('namespace-phase-approval-binding'),
  artifactSet:Object.freeze({id:'namespace-primary-approval-artifact-set',currentVersion:2,minimumReadableVersion:1,maximumReadableVersion:2,
    unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  routing:Object.freeze({id:'namespace-phase-approval-routing',currentVersion:2,minimumReadableVersion:1,maximumReadableVersion:2,
    unversionedAs:null,immutable:true,migrationPolicy:'preserve-versions'}),
  receipt:frozenFamily('namespace-phase-approval-receipt')
});
export function namespaceApprovalArtifactSetProfile(input) {
  const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_APPROVAL_SCHEMAS.artifactSet,input);
  return Object.freeze({version:storedVersion,format:`sflow-namespace-primary-approval-artifact-set/v${storedVersion}`,policyChecklist:storedVersion>1});
}
export const NAMESPACE_CONSTITUTION_EXCEPTION_SCHEMA=frozenFamily('namespace-constitution-exception');
export const NAMESPACE_CONSTITUTION_EXCEPTION_CONTEXT_SCHEMA=frozenFamily('namespace-constitution-exception-context');
export function namespaceConstitutionExceptionContextProfile(input){const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_CONSTITUTION_EXCEPTION_CONTEXT_SCHEMA,input);
  return Object.freeze({version:storedVersion,format:'sflow-namespace-constitution-exception-context/v'+storedVersion});}
export const NAMESPACE_DECISION_SCHEMA=frozenFamily('namespace-recorded-decision');
export const NAMESPACE_WITNESS_MAPPING_SCHEMAS=Object.freeze({context:frozenFamily('namespace-witness-mapping-context'),review:frozenFamily('namespace-witness-mapping-review')});
export function namespaceWitnessMappingProfile(kind,value){const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_WITNESS_MAPPING_SCHEMAS[kind],value);
  return Object.freeze({version:storedVersion,profile:'sflow-'+NAMESPACE_WITNESS_MAPPING_SCHEMAS[kind].id+'/v'+storedVersion});}
export const NAMESPACE_DECISION_BATCH_SCHEMAS=Object.freeze({body:frozenFamily('namespace-decision-batch'),reference:frozenFamily('namespace-decision-batch-reference'),outcome:frozenFamily('namespace-decision-batch-outcome')});
export function namespaceDecisionBatchProfile(kind,value){const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_DECISION_BATCH_SCHEMAS[kind],value);
  return Object.freeze({version:storedVersion,format:'sflow-'+NAMESPACE_DECISION_BATCH_SCHEMAS[kind].id+'/v'+storedVersion});}
export const NAMESPACE_ROUTING_CHOICE_SCHEMAS=Object.freeze({
  record:frozenFamily('namespace-routing-choice'),receipt:frozenFamily('namespace-routing-choice-receipt')
});
export function namespaceApprovalRecordProfile(input) {
  const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_APPROVAL_SCHEMAS.vote,input);
  return Object.freeze({version:storedVersion,format:`sflow-namespace-phase-approval-vote/v${storedVersion}`,
    profile:storedVersion>=6?`sflow-witness-mapping-approval/v${storedVersion-5}`:storedVersion===3?'sflow-forward-amendment-approval/v1':storedVersion>=4?`sflow-terminal-evidence-approval/v${storedVersion-3}`:`sflow-primary-document-approval/v${storedVersion}`,
    routing:[2,5,7,9].includes(storedVersion),...(storedVersion===3?{forwardAmendment:true}:{}),...([4,5,8,9].includes(storedVersion)?{terminalEvidence:true}:{}),
    ...(storedVersion>=6?{witnessReview:true}:{})});
}
export function namespaceApprovalWriterProfile({routing=false,terminalEvidence=false,witnessReview=false}={}) {
  return namespaceApprovalRecordProfile({schemaVersion:witnessReview?terminalEvidence?routing?9:8:routing?7:6:terminalEvidence?routing?5:4:routing?2:1});
}
export function namespaceApprovalRoutingProfile(input) {
  const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_APPROVAL_SCHEMAS.routing,input);
  return Object.freeze({version:storedVersion,format:`sflow-namespace-phase-approval-routing/v${storedVersion}`,generationBound:storedVersion>1});
}
/** Portable publication reference metadata; acceptance and byte verification belong to its owners. */
export function phasePublicationBindingValue(value) {
  admitRecordSchemaVersion(PHASE_PUBLICATION_SCHEMAS.binding,value);
  const fields=['schemaVersion','format','generation','record'];
  const record=value.record;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||!fields.every(key=>Object.hasOwn(value,key))
    ||value.format!=='sflow-phase-publication-binding/v1'||!Number.isSafeInteger(value.generation)||value.generation<1
    ||!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).length!==3||!['namespace','sha256','bytes'].every(key=>Object.hasOwn(record,key))
    ||record.namespace!=='evidence'||typeof record.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(record.sha256)
    ||!Number.isSafeInteger(record.bytes)||record.bytes<1||record.bytes>4_194_304)throw new SingularityFlowError(
      'The phase publication binding is invalid.',{code:'PUBLICATION_BINDING_INVALID'});
  return value;
}
// Wire shape constraints, selected here without rewriting an immutable historical body.
const LIFECYCLE_STATE_PROFILES = Object.freeze({
  1: Object.freeze({ requireOwnedCurrentPhase: false, terminalStatuses: Object.freeze([]) }),
  2: Object.freeze({ requireOwnedCurrentPhase: true, terminalStatuses: Object.freeze(['closed', 'cancelled']) })
});

/** Preserve existing writer bytes; conditional absence has a distinct v3 meaning. */
export function namespaceLifecycleWriteVersion(proposal) {
  if(!Object.hasOwn(proposal,'readBindings'))return 1;
  return Array.isArray(proposal.readBindings)&&proposal.readBindings.some(binding=>binding?.version===null)?3:2;
}

export function namespaceLifecycleRecordProfile(kind, input) {
  if (!Object.hasOwn(NAMESPACE_LIFECYCLE_SCHEMAS, kind)) {
    throw new SingularityFlowError('Unknown namespace lifecycle record family.', { code: 'SCHEMA_FAMILY_UNKNOWN' });
  }
  const { storedVersion } = admitRecordSchemaVersion(NAMESPACE_LIFECYCLE_SCHEMAS[kind], input);
  return Object.freeze({ format: `sflow-namespace-lifecycle-${kind}/v${storedVersion}`,
    ...((kind==='prepared'||kind==='manifest')&&storedVersion>1?{readBindings:true,...(storedVersion>=3?{absentReadBindings:true}:{})}:{}),
    state: kind === 'state' ? LIFECYCLE_STATE_PROFILES[storedVersion] : null });
}
// Historical view records retain their original schema and compatibility export indefinitely.
export const WORLD_MODEL_VIEW_CONTRACT_SCHEMA_VERSION = frozenFamily('world-model-view-contract').currentVersion;
// Writers need the current wire stamp, not every historical migration function.
export const COMMAND_TIMING_SCHEMA = Object.freeze({ id: 'dx-command-timing', currentVersion: 6 });

export function admitRecordSchemaVersion(entry, input) {
  const familyId = entry.id;
  let record = input;
  const storedVersion = Number.isInteger(record.schemaVersion) && record.schemaVersion > 0
    ? record.schemaVersion
    : entry.unversionedAs;
  if (storedVersion != null && record.schemaVersion == null) record = { ...record, schemaVersion: storedVersion };
  if (!Number.isInteger(storedVersion) || storedVersion < 1) {
    throw new SingularityFlowError(`Durable record '${familyId}' has no valid schemaVersion.`, {
      code: 'SCHEMA_VERSION_MISSING', details: { family: familyId, received: storedVersion ?? null }
    });
  }
  const future = storedVersion > entry.maximumReadableVersion;
  if (future || storedVersion < entry.minimumReadableVersion) {
    const direction = future ? 'above' : 'below';
    const recovery = future ? 'it was written by a newer sflow — upgrade to read it.'
      : 'use the archival reader for that release or a republication with recorded lineage.';
    throw new SingularityFlowError(
      `Durable record '${familyId}' is stored at schema version ${storedVersion} (v${storedVersion}), ${direction} this build's readable range v${entry.minimumReadableVersion}–v${entry.maximumReadableVersion}; ${recovery}`,
      { code: future ? 'SCHEMA_VERSION_FUTURE' : 'SCHEMA_VERSION_ARCHIVED',
        details: { family: familyId, storedVersion, readable: { minimum: entry.minimumReadableVersion, maximum: entry.maximumReadableVersion } } }
    );
  }
  return { record, storedVersion };
}



export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}


export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}


/** The ledger's historical compact identity uses the same key ordering, without display spaces. */
export function compactCanonicalJson(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}


/** Closed, bounded JSON value grammar. Limits/codes are data; no adapter or admission callbacks. */
export function jsonValueContract(options) {
  const keys=['maximumBytes','maximumDepth','maximumNodes','inputCode','limitCode'];
  if(!options || ![Object.prototype,null].includes(Object.getPrototypeOf(options))
    || Reflect.ownKeys(options).length!==keys.length || keys.some(key=>{const d=Object.getOwnPropertyDescriptor(options,key);return !d?.enumerable || !Object.hasOwn(d,'value');})
    || !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes<1 || options.maximumBytes>134_217_728
    || !Number.isSafeInteger(options.maximumDepth) || options.maximumDepth<1 || options.maximumDepth>64
    || !Number.isSafeInteger(options.maximumNodes) || options.maximumNodes<1 || options.maximumNodes>250_000
    || ![options.inputCode,options.limitCode].every(value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,127}$/u.test(value))) {
    throw new SingularityFlowError('Invalid closed JSON value contract.',{code:'ENGINE_JSON_CONTRACT_INVALID'});
  }
  const NAMESPACE_LIMITS=Object.freeze({maxTransactionBytes:options.maximumBytes,maxDepth:options.maximumDepth,maxNodes:options.maximumNodes});
  const inputCode=options.inputCode,limitCode=options.limitCode;
  const namespaceError=(message,code=inputCode)=>new SingularityFlowError(message,{code,details:null});
function exactObject(value, required, optional = [], label = 'Value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw namespaceError(`${label} must be a plain object.`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw namespaceError(`${label} contains an unsupported field or accessor.`);
    }
  }
  if (required.some(key => !Object.hasOwn(value, key))) throw namespaceError(`${label} is missing a required field.`);
  return value;
}

function encode(value) {
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${encode(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function namespaceJson(value, {
  maxBytes = NAMESPACE_LIMITS.maxTransactionBytes, maxDepth = NAMESPACE_LIMITS.maxDepth, maxNodes = NAMESPACE_LIMITS.maxNodes
} = {}) {
  for (const [value, maximum] of [[maxBytes, NAMESPACE_LIMITS.maxTransactionBytes],
    [maxDepth, NAMESPACE_LIMITS.maxDepth], [maxNodes, NAMESPACE_LIMITS.maxNodes]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw namespaceError('Invalid namespace JSON bound.', limitCode);
    }
  }
  let nodes = 0;
  let minimumBytes = 0;
  const budget = amount => {
    minimumBytes += amount;
    if (minimumBytes > maxBytes) throw namespaceError('JSON exceeds the namespace byte limit.', limitCode);
  };
  const ancestors = new Set();
  const copy = (item, depth) => {
    if (++nodes > maxNodes || depth > maxDepth) {
      throw namespaceError('JSON exceeds the namespace contract bounds.', limitCode);
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'string'
      || (typeof item === 'number' && Number.isFinite(item))) {
      if (typeof item === 'string' && item.length > maxBytes) {
        throw namespaceError('JSON exceeds the namespace byte limit.', limitCode);
      }
      budget(JSON.stringify(item).length);
      return Object.is(item, -0) ? 0 : item;
    }
    if (!item || typeof item !== 'object' || ancestors.has(item)
      || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) {
      throw namespaceError('Namespace data must be finite, acyclic plain JSON.');
    }
    ancestors.add(item);
    const result = Array.isArray(item) ? [] : {};
    const keys = Reflect.ownKeys(item);
    if (Array.isArray(item) && (keys.length !== item.length + 1
      || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length)))) {
      throw namespaceError('Sparse or extended arrays are not JSON records.');
    }
    budget(2 + Math.max(0, keys.length - (Array.isArray(item) ? 1 : 0) - 1));
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw namespaceError('Namespace JSON cannot contain accessors, symbols or hidden properties.');
      }
      budget(Array.isArray(item) ? 0 : JSON.stringify(key).length + 1);
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    ancestors.delete(item);
    return Object.freeze(result);
  };
  const result = copy(value, 0);
  if (new TextEncoder().encode(encode(result)).byteLength > maxBytes) {
    throw namespaceError('JSON exceeds the namespace byte limit.', limitCode);
  }
  return result;
}
  return Object.freeze({exactObject,namespaceJson,encode});
}

/** Frozen SGOS v1 JSON-value semantics, shared by record and execution adapters. */
function invalidSgosRecordValue(message, details = {}) {
  throw new SingularityFlowError(message, {code: 'SGOS_CONTRACT_INVALID', details});
}
export function cloneSgosRecordValue(value, location = '$', seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidSgosRecordValue(`${location} must contain only finite JSON numbers.`);
    return value;
  }
  if (typeof value !== 'object') invalidSgosRecordValue(`${location} must be JSON-safe; received ${typeof value}.`);
  if (seen.has(value)) invalidSgosRecordValue(`${location} contains a cycle.`);
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry, index) => cloneSgosRecordValue(entry, `${location}[${index}]`, seen));
  } else {
    if (![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalidSgosRecordValue(`${location} must contain only plain JSON objects.`);
    result = {};
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) invalidSgosRecordValue(`${location} contains unsafe key '${key}'.`);
      result[key] = cloneSgosRecordValue(value[key], `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
  return result;
}

export const NAMESPACE_FORWARD_ORIGIN_SCHEMA=frozenFamily('namespace-forward-amendment-origin');
export function namespaceForwardOriginProfile(value){const {storedVersion}=admitRecordSchemaVersion(NAMESPACE_FORWARD_ORIGIN_SCHEMA,value);return Object.freeze({version:storedVersion,format:'sflow-namespace-forward-amendment-origin/v'+storedVersion});}
