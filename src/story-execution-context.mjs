import { parseAgentDependencies } from './agents.mjs';
import {
  hasRetainedWorkflowSnapshotDraft, verifyWorkflowSnapshot
} from './workflow-snapshots.mjs';
import { SingularityFlowError } from './util.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const AGENT_PARSER = 'sflow-agent-document-v1';
const COMPOSER = 'story-snapshot-agent-v1';
const VERIFIED_CLOSURE = Symbol('verified-story-execution-closure');
const STORY_EXECUTION_DEFINITION = Symbol('verified-story-execution-definition');

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function immutable(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object' || Buffer.isBuffer(value) || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) immutable(child, seen);
  return Object.freeze(value);
}

function fail(message, code = 'WFA_DEPENDENCY_UNAVAILABLE', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function hash(value, label) {
  if (!HASH.test(String(value ?? ''))) fail(`${label} has an invalid SHA-256 identity.`, 'WFA_SNAPSHOT_INVALID');
  return value;
}

function utf8(bytes, label) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(`${label} is not valid UTF-8 declarative text.`, 'WFA_RUNTIME_INCOMPATIBLE'); }
}

function selectedAgentIds(manifest) {
  return manifest.assets
    .filter((asset) => asset.purpose === 'governed-agent' && /^agent:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(asset.logicalId))
    .map((asset) => asset.logicalId.slice('agent:'.length))
    .sort(compareText);
}

function dependenciesForAgent(closure, agentId, parsed) {
  const declared = new Map((parsed.dependencies ?? []).map((entry) => [
    `${entry.type}:${entry.id}`, entry
  ]));
  const records = (closure.manifest.executionDependencies ?? []).filter((entry) => (
    entry.agentId === agentId || String(entry.id ?? '').startsWith(`agent:${agentId}:`)
  ));
  const byDeclaration = new Map(records.map((entry) => {
    const dependencyId = entry.dependencyId
      ?? String(entry.id).split(':').at(-1);
    return [`${entry.kind}:${dependencyId}`, entry];
  }));
  const dependencies = [];
  for (const [key, declaration] of [...declared.entries()].sort(([left], [right]) => compareText(left, right))) {
    const record = byDeclaration.get(key);
    if (!record) {
      if (declaration.optional) {
        dependencies.push({
          logicalId: `agent:${agentId}:${key}`, id: declaration.id, kind: declaration.type,
          optional: true, inclusion: 'omitted', sha256: null, text: null,
          phases: [...(declaration.phases ?? [])], blobPath: null
        });
        continue;
      }
      fail(
        `Required saved dependency '${agentId}/${declaration.id}' is absent from the Story snapshot.`,
        'WFA_DEPENDENCY_UNAVAILABLE',
        { agentId, dependencyId: declaration.id }
      );
    }
    if (record.inclusion === 'included') {
      const bytes = closure.assetBytes.get(record.assetLogicalId);
      if (!bytes || record.contentSha256 == null) {
        fail(`Required saved dependency '${record.id}' has no retained bytes.`, 'WFA_DEPENDENCY_UNAVAILABLE');
      }
      dependencies.push({
        logicalId: record.id, id: declaration.id, kind: declaration.type,
        optional: declaration.optional === true, inclusion: 'included',
        sha256: hash(record.contentSha256, `Saved dependency '${record.id}'`),
        text: utf8(bytes, `Saved dependency '${record.id}'`),
        phases: [...(declaration.phases ?? [])],
        blobPath: closure.manifest.assets.find((entry) => entry.logicalId === record.assetLogicalId)?.blob?.path ?? null
      });
      continue;
    }
    if (record.inclusion === 'external-requirement') {
      dependencies.push({
        logicalId: record.id, id: declaration.id, kind: declaration.type,
        optional: declaration.optional === true, inclusion: 'external-requirement',
        sha256: null, text: null, phases: [...(declaration.phases ?? [])], blobPath: null
      });
      continue;
    }
    const optionalOmission = record.inclusion === 'omitted'
      || record.availability === 'remote-optional';
    if (declaration.optional && optionalOmission) {
      dependencies.push({
        logicalId: record.id, id: declaration.id, kind: declaration.type,
        optional: true, inclusion: 'omitted', sha256: null, text: null,
        phases: [...(declaration.phases ?? [])], blobPath: null
      });
      continue;
    }
    // Older v1 snapshots recorded a lock reference but not the exact dependency bytes. Do not
    // fetch by name or URL and do not substitute a newly installed cache entry.
    fail(
      `Required saved dependency '${agentId}/${declaration.id}' is not retained by this Story snapshot.`,
      'WFA_DEPENDENCY_UNAVAILABLE',
      { agentId, dependencyId: declaration.id, snapshotHash: closure.snapshotHash }
    );
  }
  return dependencies.sort((left, right) => compareText(left.logicalId, right.logicalId));
}

function parsedSnapshotAgents(closure) {
  const parserProfile = closure.semantics?.agentDocumentParser ?? AGENT_PARSER;
  const composerProfile = closure.semantics?.promptComposer ?? COMPOSER;
  if (parserProfile !== AGENT_PARSER || composerProfile !== COMPOSER) {
    fail(
      `Story snapshot requires unsupported execution interpretation '${parserProfile}/${composerProfile}'.`,
      'WFA_RUNTIME_INCOMPATIBLE',
      { parserProfile, composerProfile }
    );
  }
  const agents = {};
  for (const agentId of selectedAgentIds(closure.manifest)) {
    const logicalId = `agent:${agentId}`;
    const asset = closure.manifest.assets.find((entry) => entry.logicalId === logicalId);
    const bytes = closure.assetBytes.get(logicalId);
    if (!asset || !bytes) fail(`Saved governed agent '${agentId}' is unavailable.`, 'WFA_DEPENDENCY_UNAVAILABLE');
    const text = utf8(bytes, `Saved governed agent '${agentId}'`);
    let parsed;
    try { parsed = parseAgentDependencies(text, { source: logicalId, agentId }); }
    catch (error) {
      fail(
        `Saved governed agent '${agentId}' cannot be interpreted by ${parserProfile}: ${error.message}`,
        'WFA_RUNTIME_INCOMPATIBLE',
        { agentId, parserProfile }
      );
    }
    agents[agentId] = {
      ...parsed,
      scope: 'workflow-snapshot', source: logicalId, file: null, text,
      sha256: hash(asset.blob.sha256, `Saved governed agent '${agentId}'`).slice(7)
    };
  }
  return { agents, parserProfile, composerProfile };
}

/**
 * Verify and retain the complete portable catalog before any Story consumer selects an agent.
 * No live agent path, installed cache, remote URL, or previous checkout participates in this read.
 */
export async function resolveStoryExecutionCatalog(root, definition, workflow) {
  if (!workflow?.workflowSnapshot) {
    const effectiveDefinition = Object.create(
      Object.getPrototypeOf(definition), Object.getOwnPropertyDescriptors(definition)
    );
    Object.defineProperty(effectiveDefinition, STORY_EXECUTION_DEFINITION, {
      value: Object.freeze({ workId: workflow?.workItem?.id ?? null, mode: 'legacy-live' }),
      enumerable: false
    });
    Object.freeze(effectiveDefinition);
    return Object.freeze({
      mode: 'legacy-live', closure: 'unproven', policy: workflow?.resolution ?? null,
      agents: definition.agents ?? {}, agentCatalog: definition.agentCatalog ?? [],
      effectiveDefinition, snapshotHash: null,
      parserProfile: null, composerProfile: null
    });
  }
  // The path holding an accepted Story is part of that Story's immutable resolution. A later
  // configuration refresh may move `workItemRoot`; using that live value here would make the
  // already accepted closure disappear before it could supply its saved policy.
  const snapshotDefinition = workflow.resolution?.workItemRoot
    && workflow.resolution.workItemRoot !== definition.workItemRoot
    ? { ...definition, workItemRoot: workflow.resolution.workItemRoot }
    : definition;
  const creationDraft = hasRetainedWorkflowSnapshotDraft(root, snapshotDefinition, workflow);
  const closure = await verifyWorkflowSnapshot(root, snapshotDefinition, workflow, {
    retainBytes: true,
    // Story creation prepares the first artifact before its enclosing transaction commits. Only
    // the exact object that captured this closure can exercise that draft path; every reloaded or
    // accepted Story must prove its immutable creation commit.
    requireAccepted: !creationDraft
  });
  const parsed = parsedSnapshotAgents(closure);
  if (!Object.keys(parsed.agents).length) {
    fail('Story snapshot contains no governed-agent bytes.', 'WFA_DEPENDENCY_UNAVAILABLE');
  }
  const policy = immutable(structuredClone(closure.policy));
  const agents = immutable(parsed.agents);
  const agentCatalog = Object.freeze(Object.values(agents)
    .sort((left, right) => compareText(left.id, right.id)));
  // Machine capabilities (model executables, credentials, Git transport) remain live. Every
  // decision the Story captured, however, must come from its accepted closure. Overlaying only
  // agents and World-Model policy would still let a later configuration refresh change gates and
  // rendering semantics for an in-flight Story.
  const savedPolicy = Object.fromEntries([
    ['workItemRoot', policy.workItemRoot],
    ['initiativeRoot', policy.initiativeRoot],
    ['templatesRoot', policy.templatesRoot],
    ['agentPromptsRoot', policy.agentPromptsRoot],
    ['approvalSecurity', policy.approvalSecurity],
    ['approvalAuthorities', policy.approvalAuthorities],
    ['sequenceGates', policy.sequenceGates],
    ['contextPolicy', policy.contextPolicy],
    ['tokenEconomy', policy.tokenEconomy],
    ['ledger', policy.ledger],
    ['spec', policy.spec],
    ['plannedClaims', policy.plannedClaims],
    ['codeDelivery', policy.codeDelivery],
    ['faultRepair', policy.faultRepair],
    ['constitution', policy.constitution],
    ['analysisLimits', policy.analysisLimits],
    ['artifactSets', policy.artifactSets],
    ['harnessImports', policy.harnessImports],
    ['intelligence', policy.intelligence],
    ['referenceRepositoryPolicy', policy.referenceRepositoryPolicy],
    ['designSources', policy.designSources],
    ['verification', policy.verification]
  ].filter(([, value]) => value !== undefined));
  const effectiveDefinition = {
    ...definition,
    ...savedPolicy,
    ...(policy.worldModelPolicy ? { worldModel: policy.worldModelPolicy } : {}),
    ...(policy.mcpServers ? { mcpServers: policy.mcpServers } : {}),
    agents,
    agentCatalog
  };
  Object.defineProperty(effectiveDefinition, STORY_EXECUTION_DEFINITION, {
    value: Object.freeze({
      workId: workflow.workItem.id,
      mode: 'workflow-snapshot',
      snapshotHash: closure.snapshotHash
    }),
    enumerable: false
  });
  Object.freeze(effectiveDefinition);
  const catalog = {
    mode: 'workflow-snapshot', closure: 'verified', policy,
    agents, agentCatalog,
    effectiveDefinition, snapshotHash: closure.snapshotHash,
    parserProfile: parsed.parserProfile, composerProfile: parsed.composerProfile,
    manifest: immutable(structuredClone(closure.manifest))
  };
  // Kept outside the enumerable/public result so diagnostics cannot accidentally serialize prompt
  // bytes. The selected-agent resolver consumes this exact verified observation, avoiding a
  // second filesystem read and the TOCTOU window that would create.
  Object.defineProperty(catalog, VERIFIED_CLOSURE, { value: closure });
  return Object.freeze(catalog);
}

/**
 * Resolve Story policy once at an operation boundary and reuse that immutable definition in every
 * nested evaluator. The private marker is only an intra-process optimization: callers cannot mint
 * it, and it is scoped to one Work ID, so passing another Story always verifies its own closure.
 */
export async function resolveStoryExecutionDefinition(root, definition, workflow) {
  const resolved = definition?.[STORY_EXECUTION_DEFINITION];
  if (resolved?.workId === (workflow?.workItem?.id ?? null)) return definition;
  return (await resolveStoryExecutionCatalog(root, definition, workflow)).effectiveDefinition;
}

/** Resolve one selected agent and the exact declarative bytes used to assemble its prompt. */
export async function resolveStoryExecutionContext(root, definition, workflow, {
  agentId = null, phaseId = null, overrideSha256 = null
} = {}) {
  const catalog = await resolveStoryExecutionCatalog(root, definition, workflow);
  const selectedId = agentId ?? workflow?.phases?.[phaseId ?? workflow?.currentPhase]?.defaultAgent ?? null;
  const agent = selectedId ? catalog.agents[selectedId] : null;
  if (!selectedId || !agent) {
    fail(
      `Governed agent '${selectedId ?? 'unavailable'}' is not captured by this Story's execution closure.`,
      catalog.mode === 'workflow-snapshot' ? 'WFA_DEPENDENCY_UNAVAILABLE' : 'WFA_RUNTIME_INCOMPATIBLE',
      { agentId: selectedId, allowedAgents: Object.keys(catalog.agents).sort(compareText) }
    );
  }
  if (catalog.mode === 'legacy-live') {
    return Object.freeze({
      ...catalog, agentId: selectedId, agent, dependencies: Object.freeze([]),
      identity: Object.freeze({ mode: 'legacy-live' })
    });
  }
  // Preserve the existing audited session-override contract. A user may explicitly keep an agent
  // whose declared phase list does not include the current phase; resolvePhaseAgent reports that
  // as a compatibility override instead of treating it as an unknown or untrusted agent. The
  // snapshot boundary must behave the same way: it verifies and uses the exact saved bytes, while
  // phase-scoped dependencies remain filtered by their own declarations. Requiring phase
  // membership here broke model-free/manual Story creation before a phase default could be
  // restored, even though the captured agent itself was valid and immutable.
  const compatible = !phaseId || !agent.phases.length || agent.phases.includes(phaseId);
  const compatibilityWarning = compatible ? null
    : `Agent '${selectedId}' is not declared for phase '${phaseId}'. Continuing with an audited compatibility override.`;
  const closure = catalog[VERIFIED_CLOSURE];
  if (!closure) fail('Verified Story execution bytes were not retained for selection.', 'WFA_SNAPSHOT_INVALID');
  const dependencies = Object.freeze(dependenciesForAgent(closure, selectedId, agent)
    .map((entry) => Object.freeze(entry)));
  const identity = Object.freeze({
    mode: 'workflow-snapshot',
    snapshotHash: catalog.snapshotHash,
    agentId: selectedId,
    agentBlobSha256: `sha256:${agent.sha256}`,
    dependencies: Object.freeze(dependencies.filter((entry) => entry.inclusion === 'included')
      .map((entry) => Object.freeze({ logicalId: entry.logicalId, sha256: entry.sha256 }))
      .sort((left, right) => compareText(left.logicalId, right.logicalId))),
    parserProfile: catalog.parserProfile,
    composerProfile: catalog.composerProfile,
    overrideSha256: overrideSha256 == null ? null : hash(overrideSha256, 'Prompt override')
  });
  return Object.freeze({
    ...catalog, agentId: selectedId, agent, dependencies, identity,
    compatible, compatibilityWarning
  });
}
