import { deepFreeze } from '../canonicalize.mjs';
import {
  createFwmActivation, createFwmConsumer, createFwmRegistry, createFwmViewDescriptor,
  FWM_EXACT_VIEW, FWM_VIEW_ID, validateFwmActivation, validateFwmRegistry
} from './contracts.mjs';
import { fwmCanonicalJson, fwmSemanticSha256 } from './canonical.mjs';

function implementationDigest(id, revision, semantics) {
  return fwmSemanticSha256(`fwm/handler/${id}@${revision}`, { semantics });
}

function descriptor({
  name, title, handler, capabilities, lifecycle = 'active', semantics
}) {
  const revision = 1;
  const slug = name.replace('.', '-');
  return createFwmViewDescriptor({
    name,
    revision,
    title,
    handlerRef: `handler:${handler}@${revision}`,
    implementationSha256: implementationDigest(handler, revision, semantics),
    queryProfileRef: `profile:${slug}@${revision}`,
    parameterSchemaRef: `schema:${slug}-params@${revision}`,
    resultSchemaRef: 'schema:fwm-read-result@1',
    inputKinds: ['working-tree'],
    requiredDomains: ['code'],
    requiredCapabilities: [...capabilities].sort(),
    consumerClasses: ['human', 'ide'],
    freshnessPolicyRef: 'freshness:captured-working-tree@1',
    admissibilityProfileRef: 'admissibility:structural-navigation@1',
    coverageContractRef: `coverage:${slug}@${revision}`,
    orderingProfileRef: 'order:ast-structural-stable@1',
    budgetProfileRef: 'budget:fwm-read-default@1',
    renderProfileRef: 'render:fwm-json@1',
    dependencyViews: [],
    validationProfileRef: `validation:${slug}@${revision}`,
    outputUse: 'advisory',
    permissions: {
      model: 'never',
      network: 'none',
      sourceWrites: false,
      domainWrites: false,
      derivedCacheWrites: true
    },
    lifecycle
  });
}

const DESCRIPTORS = [
  descriptor({
    name: 'ncg.skeleton',
    title: 'Declaration skeletons',
    handler: 'ast-context-skeleton',
    capabilities: ['ast.skeleton'],
    semantics: 'Bounded declaration, module, import, and relationship facts from one AST cone; file bodies are excluded.'
  }),
  descriptor({
    name: 'ncg.callers',
    title: 'Known structural callers',
    handler: 'ast-query-callers',
    capabilities: ['ast.query.references', 'ast.skeleton'],
    semantics: 'Bounded calls and references for one exact symbol identity; unresolved and partial coverage remain explicit.'
  }),
  descriptor({
    name: 'ncg.map',
    title: 'Repository structural map',
    handler: 'ast-context-map',
    capabilities: ['ast.file-inventory'],
    semantics: 'Bounded file and module inventory for the selected AST cone with explicit unsupported and skipped coverage.'
  }),
  descriptor({
    name: 'ncg.grep',
    title: 'Captured text search',
    handler: 'captured-text-grep',
    capabilities: ['captured-text.scan'],
    lifecycle: 'draft',
    semantics: 'Reserved until a text-floor scanner can prove complete captured membership without narrowing to AST-supported files.'
  }),
  descriptor({
    name: 'ncg.find',
    title: 'Deterministic lexical find',
    handler: 'captured-text-find',
    capabilities: ['captured-text.excerpts', 'captured-text.rank'],
    lifecycle: 'draft',
    semantics: 'Reserved until literal excerpt and deterministic ranking contracts exist on the common captured-input boundary.'
  }),
  descriptor({
    name: 'ncg.blast',
    title: 'Snapshot-separated blast radius',
    handler: 'snapshot-blast',
    capabilities: ['snapshot.diff', 'snapshot.traversal'],
    lifecycle: 'draft',
    semantics: 'Reserved until independent base and target traversals can be bound without mixing edges from different snapshots.'
  })
];

export const BUILTIN_FWM_READ_REGISTRY = deepFreeze(createFwmRegistry(DESCRIPTORS));

const ACTIVE = BUILTIN_FWM_READ_REGISTRY.descriptors
  .filter((entry) => entry.lifecycle === 'active')
  .map((entry) => `${entry.name}@${entry.revision}`)
  .sort();

const CLI_CONSUMER = createFwmConsumer({
  id: 'sflow-structural-read',
  consumerClass: 'human',
  owner: 'sflow-core',
  viewRefs: [...ACTIVE],
  required: false,
  maximumBytes: 65536,
  fallback: 'ordinary-files'
});

export const BUILTIN_FWM_READ_ACTIVATION = deepFreeze(createFwmActivation({
  registrySha256: BUILTIN_FWM_READ_REGISTRY.registrySha256,
  activeViews: ACTIVE,
  aliases: ACTIVE.map((viewRef) => ({ name: viewRef.replace(/@\d+$/, ''), viewRef })),
  consumers: [CLI_CONSUMER]
}));

validateFwmActivation(BUILTIN_FWM_READ_ACTIVATION, BUILTIN_FWM_READ_REGISTRY);

export function assertInstalledFwmReadRegistry(registry, activation) {
  const checkedRegistry = validateFwmRegistry(registry);
  const checkedActivation = validateFwmActivation(activation, checkedRegistry);
  if (fwmCanonicalJson(checkedRegistry) !== fwmCanonicalJson(BUILTIN_FWM_READ_REGISTRY)
      || fwmCanonicalJson(checkedActivation) !== fwmCanonicalJson(BUILTIN_FWM_READ_ACTIVATION)) {
    const error = new TypeError('FWM read registry is not the exact reviewed package installed by this build.');
    error.code = 'FWM_REGISTRY_NOT_INSTALLED';
    error.details = {
      expectedRegistrySha256: BUILTIN_FWM_READ_REGISTRY.registrySha256,
      receivedRegistrySha256: checkedRegistry.registrySha256
    };
    throw error;
  }
  return { registry: checkedRegistry, activation: checkedActivation };
}

export function resolveFwmReadView(reference, {
  registry = BUILTIN_FWM_READ_REGISTRY,
  activation = BUILTIN_FWM_READ_ACTIVATION,
  requireActive = true
} = {}) {
  const installed = assertInstalledFwmReadRegistry(registry, activation);
  const raw = String(reference ?? '').trim();
  let exact = raw;
  if (FWM_VIEW_ID.test(raw)) {
    exact = installed.activation.aliases.find((entry) => entry.name === raw)?.viewRef ?? '';
  }
  if (!FWM_EXACT_VIEW.test(exact)) {
    const error = new TypeError(`FWM view '${raw}' is not a registered exact reference or active alias.`);
    error.code = 'FWM_INVALID_VIEW';
    throw error;
  }
  const descriptor = installed.registry.descriptors.find(
    (entry) => `${entry.name}@${entry.revision}` === exact
  );
  if (!descriptor) {
    const error = new TypeError(`FWM view '${exact}' is not registered.`);
    error.code = 'FWM_INVALID_VIEW';
    throw error;
  }
  if (requireActive && !installed.activation.activeViews.includes(exact)) {
    const error = new TypeError(
      `FWM view '${exact}' is ${descriptor.lifecycle}; this build will not fabricate an implementation.`
    );
    error.code = 'FWM_VIEW_NOT_ACTIVE';
    error.details = { reference: exact, lifecycle: descriptor.lifecycle };
    throw error;
  }
  return Object.freeze({ reference: exact, descriptor, ...installed });
}

export function fwmReadRegistryInventory() {
  return BUILTIN_FWM_READ_REGISTRY.descriptors.map((descriptor) => Object.freeze({
    id: descriptor.name,
    revision: descriptor.revision,
    reference: `${descriptor.name}@${descriptor.revision}`,
    title: descriptor.title,
    lifecycle: descriptor.lifecycle,
    active: BUILTIN_FWM_READ_ACTIVATION.activeViews.includes(`${descriptor.name}@${descriptor.revision}`),
    handlerRef: descriptor.handlerRef,
    model: descriptor.permissions.model,
    descriptorSha256: descriptor.descriptorSha256
  }));
}
