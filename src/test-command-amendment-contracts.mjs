/** Closed, immutable records for the bounded prepublication test-command dialect. */
import { canonicalJson, recordSha256 } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';

export const TEST_COMMAND_AMENDMENT_DIALECT = 'test-command-adoption/v1';
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
export const TEST_COMMAND_AMENDMENT_SCHEMAS = Object.freeze({
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
});

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
  const schema = TEST_COMMAND_AMENDMENT_SCHEMAS[record?.kind];
  if (!schema) fail('Unsupported test-command amendment record.');
  readRecord(record.kind, record);
  const selected = reviewCore && record.kind === 'test-command-adoption-review'
    ? { ...schema, required: schema.required.filter((key) => key !== 'authorization'),
      properties: Object.fromEntries(Object.entries(schema.properties).filter(([key]) => key !== 'authorization')) } : schema;
  shape(selected, record);
  return record;
}
export function testCommandAmendmentDigest(value) { return `sha256:${recordSha256(value)}`; }
export function structuredTestCommand(command) {
  return Boolean(command && typeof command === 'object' && !Array.isArray(command)
    && command.kind === 'test' && Array.isArray(command.argv) && command.argv.length
    && command.argv.every((part) => typeof part === 'string' && part.length));
}

/** Only test argv contracts in one unchanged phase can change. Epoch is explicitly pinned. */
export function assertTestCommandAmendmentPolicyScope(previous, proposed, phaseId) {
  const oldPolicy = structuredClone(previous);
  const nextPolicy = structuredClone(proposed);
  const prior = oldPolicy.phases?.find((phase) => phase.id === phaseId);
  const next = nextPolicy.phases?.find((phase) => phase.id === phaseId);
  if (!phaseRequiresCodeDelivery(prior) || !phaseRequiresCodeDelivery(next)
      || !Array.isArray(prior.qualityCommands) || !Array.isArray(next.qualityCommands)) fail('Test-command amendment requires a retained code-delivery phase.');
  const oldTests = prior.qualityCommands.filter(structuredTestCommand);
  const nextTests = next.qualityCommands.filter(structuredTestCommand);
  if (!oldTests.length || !nextTests.length || canonicalJson(oldTests) === canonicalJson(nextTests)
      || [...prior.qualityCommands, ...next.qualityCommands].some((entry) => entry?.kind === 'test' && !structuredTestCommand(entry))) {
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
