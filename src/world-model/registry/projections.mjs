import { currentSchemaVersion } from '../../schema-migrations.mjs';
import {
  assertCanonicalOrder, assertExactKeys, assertInteger, assertPlainRecord,
  assertSchemaKind, assertSelfHash, assertSha256, assertString, contractFailure
} from '../contracts.mjs';
import { compareText, sealRecord } from '../canonicalize.mjs';

export const PROJECTION_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
export const CALM_SCHEMA_URI = 'https://calm.finos.org/release/1.2/meta/calm.json';

const ARCH_CALM_CONTRACT = sealRecord({
  schemaVersion: currentSchemaVersion('world-model-projection-contract'),
  kind: 'world-model-projection-contract',
  id: 'arch.calm',
  version: 1,
  publisher: { id: 'sflow-core' },
  format: 'finos-calm',
  output: {
    path: 'projections/arch.calm.json',
    mediaType: 'application/json',
    schemaUri: CALM_SCHEMA_URI,
    schemaSha256: 'sha256:938d87a1f1f3b3a5f82806fedfe64f5af22c1ddb002ae07faafa7d830ece9fce'
  },
  inputs: {
    capabilitySnapshot: 'required', configurationSnapshot: 'required',
    factLedger: 'required', publishedContracts: 'optional'
  },
  assurance: {
    allowed: [
      'deterministically-derived', 'human-confirmed', 'not-applicable',
      'runtime-observed', 'source-exact', 'structurally-derived'
    ],
    forbidden: ['heuristic', 'model-advisory']
  },
  model: { mode: 'never' },
  budgets: {
    maximumNodes: 500, maximumRelationships: 2000, maximumInterfaces: 2000,
    maximumControls: 500, maximumBytes: 5242880
  },
  validity: { status: 'active' }
}, 'contractSha256');

export function validateProjectionContract(value) {
  assertPlainRecord(value, 'World-model Projection Contract');
  assertExactKeys(value, {
    required: [
      'schemaVersion', 'kind', 'id', 'version', 'publisher', 'format', 'output',
      'inputs', 'assurance', 'model', 'budgets', 'validity', 'contractSha256'
    ],
    label: 'World-model Projection Contract'
  });
  assertSchemaKind(value, 'world-model-projection-contract', 'World-model Projection Contract');
  assertString(value.id, 'Projection id', { pattern: PROJECTION_ID_PATTERN });
  assertInteger(value.version, 'Projection version', { minimum: 1 });
  assertExactKeys(value.publisher, { required: ['id'], label: 'Projection publisher' });
  assertString(value.publisher.id, 'Projection publisher id');
  if (value.format !== 'finos-calm') contractFailure("Projection format must be 'finos-calm'.");
  assertExactKeys(value.output, {
    required: ['path', 'mediaType', 'schemaUri', 'schemaSha256'], label: 'Projection output'
  });
  if (value.output.path !== 'projections/arch.calm.json') {
    contractFailure("arch.calm output must be 'projections/arch.calm.json'.");
  }
  if (value.output.mediaType !== 'application/json' || value.output.schemaUri !== CALM_SCHEMA_URI) {
    contractFailure('arch.calm output type or schema URI is not the installed contract.');
  }
  assertSha256(value.output.schemaSha256, 'Projection output schema SHA-256');
  assertExactKeys(value.inputs, {
    required: ['capabilitySnapshot', 'configurationSnapshot', 'factLedger', 'publishedContracts'],
    label: 'Projection inputs'
  });
  assertExactKeys(value.assurance, { required: ['allowed', 'forbidden'], label: 'Projection assurance' });
  if (!Array.isArray(value.assurance.allowed) || !Array.isArray(value.assurance.forbidden)) {
    contractFailure('Projection assurance sets must be arrays.');
  }
  assertExactKeys(value.model, { required: ['mode'], label: 'Projection model policy' });
  if (value.model.mode !== 'never') contractFailure("arch.calm model mode must be 'never'.");
  assertExactKeys(value.budgets, {
    required: [
      'maximumNodes', 'maximumRelationships', 'maximumInterfaces', 'maximumControls', 'maximumBytes'
    ],
    label: 'Projection budgets'
  });
  for (const field of Object.keys(value.budgets)) {
    assertInteger(value.budgets[field], `Projection budget ${field}`, { minimum: 1 });
  }
  assertExactKeys(value.validity, { required: ['status'], label: 'Projection validity' });
  if (!['active', 'deprecated', 'revoked'].includes(value.validity.status)) {
    contractFailure('Projection validity status is invalid.');
  }
  assertSha256(value.contractSha256, 'Projection contractSha256');
  assertSelfHash(value, 'contractSha256', 'World-model Projection Contract');
  return value;
}

export function createProjectionRegistry(contracts) {
  if (!Array.isArray(contracts) || !contracts.length) {
    contractFailure('Projection Registry contracts must be a non-empty array.');
  }
  const sorted = contracts.map((contract) => structuredClone(validateProjectionContract(contract)))
    .sort((left, right) => compareText(`${left.id}@${left.version}`, `${right.id}@${right.version}`));
  const identities = sorted.map((contract) => `${contract.id}@${contract.version}`);
  if (new Set(identities).size !== identities.length) contractFailure('Projection Registry repeats a contract.');
  return validateProjectionRegistry(sealRecord({
    schemaVersion: currentSchemaVersion('world-model-projection-registry'),
    kind: 'world-model-projection-registry',
    contracts: sorted
  }, 'registrySha256'));
}

export function validateProjectionRegistry(value) {
  assertPlainRecord(value, 'World-model Projection Registry');
  assertExactKeys(value, {
    required: ['schemaVersion', 'kind', 'contracts', 'registrySha256'],
    label: 'World-model Projection Registry'
  });
  assertSchemaKind(value, 'world-model-projection-registry', 'World-model Projection Registry');
  if (!Array.isArray(value.contracts) || !value.contracts.length) {
    contractFailure('Projection Registry contracts must be non-empty.');
  }
  value.contracts.forEach(validateProjectionContract);
  assertCanonicalOrder(value.contracts, (item) => `${item.id}@${item.version}`, 'Projection Registry contracts');
  assertSha256(value.registrySha256, 'Projection Registry registrySha256');
  assertSelfHash(value, 'registrySha256', 'World-model Projection Registry');
  return value;
}

export function resolveProjectionContract(registry, reference) {
  const installed = validateProjectionRegistry(registry);
  const match = /^(?<id>.+)@(?<version>[1-9][0-9]*)$/.exec(String(reference ?? ''))?.groups;
  if (!match) contractFailure(`Projection reference '${reference}' must include an exact version.`);
  const contract = installed.contracts.find(
    (entry) => entry.id === match.id && entry.version === Number(match.version)
  );
  if (!contract) contractFailure(`Projection '${reference}' is not installed.`, 'WMC_PROJECTION_NOT_CONFIGURED');
  if (contract.validity.status !== 'active') {
    contractFailure(`Projection '${reference}' is not active.`, 'WMC_PROJECTION_CONTRACT_INVALID');
  }
  return contract;
}

export const BUILTIN_PROJECTION_REGISTRY = createProjectionRegistry([
  validateProjectionContract(ARCH_CALM_CONTRACT)
]);

export const BUILTIN_ARCH_CALM_CONTRACT = resolveProjectionContract(
  BUILTIN_PROJECTION_REGISTRY, 'arch.calm@1'
);
