/** Closed, immutable records for bounded test-command adoption and validation epochs. */
import { canonicalJson, recordSha256 } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { capabilityWorldModelGrounding } from './capability-context.mjs';
import { isTestQualityCommand } from './delivery-evidence.mjs';
import { normalizeRequiredTestCommand } from './code-delivery-tests.mjs';

export const TEST_COMMAND_AMENDMENT_DIALECT = 'test-command-adoption/v1';
export const PUBLISHED_TEST_COMMAND_AMENDMENT_DIALECT = 'test-command-adoption/v2';
export const TEST_COMMAND_AMENDMENT_DIALECTS = Object.freeze([
  TEST_COMMAND_AMENDMENT_DIALECT, PUBLISHED_TEST_COMMAND_AMENDMENT_DIALECT
]);
const string = { type: 'string', minLength: 1, maxLength: 4096 };
const digest = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const oid = { type: 'string', pattern: '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' };
const id = { type: 'string', pattern: '^TCA-[0-9]{3,6}$' };
const timestamp = { type: 'string', format: 'date-time' };
const integer = { type: 'integer', minimum: 1 };
const object = (properties, optional = []) => ({ type: 'object', properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)), additionalProperties: false });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const actor = object({ name: string, email: nullable(string), login: nullable(string) }, ['email', 'login']);
const authority = object({ authorityGroup: string,
  identityAssurance: { enum: ['configured-local', 'github-authenticated'] } });
const from = object({ revision: integer, snapshotHash: digest, policySha256: digest,
  configurationCommit: oid, commandInventorySha256: digest, validationEpoch: integer });
const to = object({ revision: { type: 'integer', minimum: 2 }, policySha256: digest,
  configurationCommit: oid, commandInventorySha256: digest, validationEpoch: integer });
const reference = object({ path: string, sha256: digest });
const ancestry = object({ schemaVersion: { const: 1 }, kind: { const: 'skill-configuration-ancestry' },
  repository: string, ancestorCommit: oid, descendantCommit: oid, objectFormat: { enum: ['sha1', 'sha256'] },
  commits: { type: 'array', minItems: 1, maxItems: 128,
    items: object({ oid, bytesBase64: { type: 'string', minLength: 1, maxLength: 87384 } }) } });
const common = (kind) => ({ schemaVersion: { const: 1 }, kind: { const: kind }, id, workId: string, phaseId: string });
const v1Schemas = {
  'test-command-adoption-review': object({ ...common('test-command-adoption-review'),
    decision: { const: 'approve' }, at: timestamp, planSha256: digest, from, to, actor,
    originalAuthority: authority, candidateAuthority: authority,
    preserved: object({ intentSha256: nullable(digest), sourceBaseCommit: oid,
      sourceTreeSha256: digest, draftSha256: digest }),
    authorization: object({ authorizationId: string, questionId: string, answerReceipt: string,
      assurance: { const: 'configured-local-review' }, planSha256: digest, actionId: string }) }),
  'test-command-adoption-decision': object({ ...common('test-command-adoption-decision'),
    status: { const: 'approved' }, approvedAt: timestamp, reason: string, from, to,
    configurationAncestry: ancestry, review: reference }),
  'test-command-adoption-summary': object({ schemaVersion: { const: 1 },
    kind: { const: 'test-command-adoption-summary' }, id, phaseId: string,
    status: { const: 'approved' }, decisionPath: string, decisionSha256: digest,
    reviewPath: string, reviewSha256: digest, from, to, decidedAt: timestamp })
};
export const TEST_COMMAND_REVALIDATION_SCHEMA = object({ mode: { const: 'published-generation' },
  generation: integer, publicationSha256: digest, publicationsSha256: digest,
  approvalsSha256: digest, deliveryEvidenceSha256: digest });
export const TEST_COMMAND_REVALIDATION_REQUIREMENT_SCHEMA = object({ id, state: { const: 'required' },
  validationEpoch: integer, generation: integer, publicationSha256: digest, commandInventorySha256: digest });
export const TEST_COMMAND_EPOCH_VALIDATION_SCHEMA = object({ schemaVersion: { const: 1 },
  kind: { const: 'test-command-epoch-validation' },
  id: { type: 'string', pattern: '^TCEV-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' },
  workId: string, phaseId: string, amendmentId: id, generation: integer, validationEpoch: integer,
  policySha256: digest, commandInventorySha256: digest, publicationSha256: digest,
  generationCommit: oid, sourceTreeSha256: digest, deliveryReceipt: reference,
  checksSha256: digest, status: { const: 'passed' }, validatedAt: timestamp });
const v2Schemas = Object.fromEntries(Object.entries(v1Schemas).map(([kind, schema]) => [kind,
  { ...schema, properties: { ...schema.properties, schemaVersion: { const: 2 }, revalidation: TEST_COMMAND_REVALIDATION_SCHEMA },
    required: [...schema.required, 'revalidation'] }]));
export const TEST_COMMAND_AMENDMENT_SCHEMAS = Object.freeze(Object.fromEntries(Object.keys(v1Schemas)
  .map(kind => [kind, { anyOf: [v1Schemas[kind], v2Schemas[kind]] }])));

function fail(message) { throw new SingularityFlowError(message, { code: 'WFA_AMENDMENT_INVALID' }); }
function shape(schema, value, at = '$') {
  if (schema.anyOf) {
    if (!schema.anyOf.some((entry) => { try { shape(entry, value, at); return true; } catch { return false; } })) fail(`${at}: invalid value`);
    return;
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) fail(`${at}: unexpected value`);
  if (schema.enum && !schema.enum.includes(value)) fail(`${at}: unsupported value`);
  if (schema.type === 'null' && value !== null) fail(`${at}: expected null`);
  if (schema.type === 'string' && (typeof value !== 'string' || value.length < (schema.minLength ?? 0)
      || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
      || (schema.format === 'date-time' && !Number.isFinite(Date.parse(value))))) fail(`${at}: invalid string`);
  if (schema.type === 'integer' && (!Number.isSafeInteger(value) || value < schema.minimum)) fail(`${at}: invalid integer`);
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail(`${at}: invalid array`);
    value.forEach((entry, index) => shape(schema.items, entry, `${at}[${index}]`));
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${at}: expected plain record`);
    for (const key of schema.required) if (!Object.hasOwn(value, key)) fail(`${at}.${key}: required`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) fail(`${at}.${key}: unknown field`);
      shape(schema.properties[key], value[key], `${at}.${key}`);
    }
  }
}
export function validateTestCommandAmendmentRecord(record, { reviewCore = false } = {}) {
  if (!TEST_COMMAND_AMENDMENT_SCHEMAS[record?.kind]) fail('Unsupported test-command amendment record.');
  const storedVersion = readRecord(record.kind, record).storedVersion;
  const schema = ({ 1: v1Schemas, 2: v2Schemas })[storedVersion]?.[record.kind];
  if (!schema) fail('Unsupported test-command amendment version.');
  const selected = reviewCore && record.kind === 'test-command-adoption-review'
    ? { ...schema, required: schema.required.filter((key) => key !== 'authorization'),
      properties: Object.fromEntries(Object.entries(schema.properties).filter(([key]) => key !== 'authorization')) } : schema;
  shape(selected, record);
  return record;
}
export function testCommandAmendmentVersion(record) {
  validateTestCommandAmendmentRecord(record);
  return readRecord(record.kind, record).storedVersion;
}
export function testCommandAmendmentDialect(record) {
  return testCommandAmendmentVersion(record) === 2
    ? PUBLISHED_TEST_COMMAND_AMENDMENT_DIALECT : TEST_COMMAND_AMENDMENT_DIALECT;
}
export function testCommandAmendmentDigest(value) { return `sha256:${recordSha256(value)}`; }
export function validateTestCommandEpochValidation(record) {
  readRecord('test-command-epoch-validation', record);
  shape(TEST_COMMAND_EPOCH_VALIDATION_SCHEMA, record);
  return record;
}
/** Hash retained historical records, not mutable passing-status labels. */
export function publishedTestCommandRevalidation(phase) {
  if (!Number.isSafeInteger(phase?.generation) || phase.generation < 1
      || !Array.isArray(phase.generationPublications) || !Array.isArray(phase.approvals)
      || !phase.deliveryEvidence || typeof phase.deliveryEvidence !== 'object'
      || Array.isArray(phase.deliveryEvidence)) fail('Published command adoption requires exact historical publication, approval and delivery evidence records.');
  const publications = phase.generationPublications.filter(entry => entry.generation === phase.generation);
  if (publications.length !== 1 || !publications[0].record
      || !/^sha256:[a-f0-9]{64}$/u.test(publications[0].resultDigest ?? '')) fail('Published command adoption requires one immutable publication for the retained generation.');
  return { mode: 'published-generation', generation: phase.generation,
    publicationSha256: testCommandAmendmentDigest(publications[0]),
    publicationsSha256: testCommandAmendmentDigest(phase.generationPublications),
    approvalsSha256: testCommandAmendmentDigest(phase.approvals),
    deliveryEvidenceSha256: testCommandAmendmentDigest(phase.deliveryEvidence) };
}
export function testCommandRevalidationRequirement(decision) {
  validateTestCommandAmendmentRecord(decision);
  if (testCommandAmendmentVersion(decision) !== 2) return null;
  return { id: decision.id, state: 'required', validationEpoch: decision.to.validationEpoch,
    generation: decision.revalidation.generation, publicationSha256: decision.revalidation.publicationSha256,
    commandInventorySha256: decision.to.commandInventorySha256 };
}
export function structuredTestCommand(command) {
  return Boolean(command && typeof command === 'object' && !Array.isArray(command)
    && command.kind === 'test' && Array.isArray(command.argv) && command.argv.length
    && command.argv.every((part) => typeof part === 'string' && part.length));
}

/** A runner repair cannot silently reduce the retained command inventory or coverage floor. */
export function assertTestCommandRunnerRepairScope(prior, next) {
  if (!Array.isArray(prior) || !Array.isArray(next)) fail('Test-command inventories must be arrays.');
  const before = prior.filter(isTestQualityCommand);
  const after = next.filter(isTestQualityCommand);
  const explicitAddition = !before.length && prior.every((entry) => entry
    && typeof entry === 'object' && !Array.isArray(entry) && Array.isArray(entry.argv) && entry.argv.length
    && entry.argv.every(part => typeof part === 'string' && part.length) && !isTestQualityCommand(entry));
  if ((!before.length && !explicitAddition) || !after.length
      || [...before, ...after].some(entry => !structuredTestCommand(entry))) fail('Test-command amendment requires structured test contracts and cannot reinterpret legacy commands.');
  if (canonicalJson(prior.filter(entry => !isTestQualityCommand(entry)))
      !== canonicalJson(next.filter(entry => !isTestQualityCommand(entry)))) fail('Test-command amendment changed a retained non-test command.');
  const oldTests = before.map(normalizeRequiredTestCommand);
  const newTests = after.map(normalizeRequiredTestCommand);
  const oldIds = oldTests.map(entry => entry.id); const newIds = newTests.map(entry => entry.id);
  if (new Set(oldIds).size !== oldIds.length || new Set(newIds).size !== newIds.length
      || newTests.some(entry => entry.requirement !== 'required')
      || (oldTests.length && canonicalJson([...oldIds].sort()) !== canonicalJson([...newIds].sort()))) fail('Test-command amendment must retain distinct test identities and required execution.');
  for (const original of oldTests) {
    const candidate = newTests.find(entry => entry.id === original.id);
    if (canonicalJson(candidate.affectedRoots) !== canonicalJson(original.affectedRoots)
        || canonicalJson(candidate.result.sourceExtensions) !== canonicalJson(original.result.sourceExtensions)
        || candidate.result.minimumDiscovered < original.result.minimumDiscovered
        || candidate.result.minimumPassed < original.result.minimumPassed) fail('Test-command amendment cannot reduce test coverage or passing thresholds.');
  }
  return { oldTests, newTests };
}

/** Candidate provenance may advance only when the source's unrelated policy is unchanged. */
export function assertTestCommandCandidateGlobalScope(retained, candidate) {
  const projected = structuredClone(candidate);
  const capability = retained.capability;
  if (Object.hasOwn(projected, 'worldModelGrounding')) projected.worldModelGrounding = projected.intelligence?.worldModel === 'off'
    ? 'off' : capabilityWorldModelGrounding(projected.worldModelGrounding, capability);
  if (Object.hasOwn(projected, 'worldModelStaleness')) projected.worldModelStaleness ??= retained.worldModelPolicy?.staleness ?? 'warn';
  if (capability?.policy?.maxDocumentBytes && projected.documents) {
    projected.documents.maxFileBytes = Math.min(projected.documents.maxFileBytes
      ?? capability.policy.maxDocumentBytes, capability.policy.maxDocumentBytes);
  }
  const keys = new Set([...Object.keys(projected).filter(key => Object.hasOwn(retained, key)),
    'testRecovery', 'reworkLoops', 'decisions']);
  keys.delete('phases');
  if ([...keys].some(key => canonicalJson(retained[key] ?? null) !== canonicalJson(projected[key] ?? null))
      || (retained.workType != null && projected.id !== retained.workType)
      || (retained.workTypeLabel != null && projected.label !== retained.workTypeLabel)) {
    fail('Approved command candidate changed unrelated global policy.');
  }
}

/** Only test argv contracts in one unchanged phase can change. Epoch is explicitly pinned. */
export function assertTestCommandAmendmentPolicyScope(previous, proposed, phaseId) {
  const oldPolicy = structuredClone(previous);
  const nextPolicy = structuredClone(proposed);
  const prior = oldPolicy.phases?.find((phase) => phase.id === phaseId);
  const next = nextPolicy.phases?.find((phase) => phase.id === phaseId);
  if (!phaseRequiresCodeDelivery(prior) || !phaseRequiresCodeDelivery(next)
      || !Array.isArray(prior.qualityCommands) || !Array.isArray(next.qualityCommands)) fail('Test-command amendment requires a retained code-delivery phase.');
  assertTestCommandRunnerRepairScope(prior.qualityCommands, next.qualityCommands);
  const oldTests = prior.qualityCommands.filter(structuredTestCommand);
  const nextTests = next.qualityCommands.filter(structuredTestCommand);
  if (canonicalJson(oldTests) === canonicalJson(nextTests)) {
    fail('Test-command amendment requires a changed, structured test command contract.');
  }
  const beforeEpoch = previous.testRecoveryValidationEpoch ?? 1;
  if (!Number.isSafeInteger(beforeEpoch) || beforeEpoch < 1
      || proposed.testRecoveryValidationEpoch !== beforeEpoch + 1) fail('Test-command amendment must advance exactly one pinned validation epoch.');
  const oldSource = structuredClone(oldPolicy.configurationSource);
  const nextSource = structuredClone(nextPolicy.configurationSource);
  if (!oldSource || !nextSource || oldSource.repository !== nextSource.repository
      || oldSource.commit === nextSource.commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(nextSource.commit ?? '')) fail('Test-command amendment requires a new configuration revision at the same authority.');
  // Provenance may update only the exact content identity, never source authority/type.
  delete oldSource.commit; delete nextSource.commit;
  delete oldSource.filesSha256; delete nextSource.filesSha256;
  if (canonicalJson(oldSource) !== canonicalJson(nextSource)) fail('Test-command amendment changed configuration authority semantics.');
  for (const value of [oldPolicy, nextPolicy]) {
    delete value.policySha256; delete value.configurationSource; delete value.testRecoveryValidationEpoch;
    value.phases.find((phase) => phase.id === phaseId).qualityCommands = value.phases.find((phase) => phase.id === phaseId).qualityCommands.filter((entry) => !structuredTestCommand(entry));
  }
  if (canonicalJson(oldPolicy) !== canonicalJson(nextPolicy)) fail('Test-command amendment changed topology or policy outside the selected test command subset.');
  return { prior: previous.phases.find((phase) => phase.id === phaseId),
    next: proposed.phases.find((phase) => phase.id === phaseId), beforeEpoch };
}
