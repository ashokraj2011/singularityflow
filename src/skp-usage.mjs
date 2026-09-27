/**
 * Bounded, read-only declared usage in one verified approved configuration snapshot.
 * This is not a Story/history index, an authenticated team ACL, or an execution grant.
 */
import path from 'node:path';
import { withApprovedConfigurationRead } from './approved-configuration-reader.mjs';
import { loadDefinition, resolveWorkType } from './config.mjs';
import { configurationReadSnapshot } from './configuration-read-scope.mjs';
import { inspectApprovedSkillPackage } from './configuration-branch.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { assertCredentialFreeRemote, isPortableAbsoluteGitPath } from './git-remote-diagnostics.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { scanEntries } from './secrets.mjs';
import { skillPhasePrimaryOutputRole } from './specifications.mjs';
import { SingularityFlowError } from './util.mjs';

export const SKP_USAGE_LIMITS = Object.freeze({ phases: 512, workflows: 256, agents: 256,
  edges: 4096, references: 1024, page: 64, pageBytes: 256 * 1024 });
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const digest = (value) => `sha256:${recordSha256(value)}`;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function fail(message, code = 'SKP_USAGE_INVALID') {
  throw new SingularityFlowError(message, { code });
}
function checkedId(value) {
  if (typeof value !== 'string' || value.length > 128 || !ID.test(value)) {
    fail('Usage lookup requires bounded portable configuration IDs.');
  }
  return value;
}
function boundedCount(value, limit) {
  if (value > limit) fail('The approved configuration exceeds the bounded usage lookup budget; no partial result was returned.', 'SKP_USAGE_LIMIT');
}
function repositoryIdentity(root, remote) {
  assertCredentialFreeRemote(remote);
  return !isPortableAbsoluteGitPath(remote) && !remote.includes(':')
    ? path.resolve(root, remote) : remote;
}

/** No caller-supplied definition, approval flag, remote selector, or Story scope is accepted. */
export async function lookupApprovedSkillUsage(root, request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(request))
      || Object.keys(request).some((key) => !['skillId', 'packageSha256', 'limit', 'cursor', 'expectedSource'].includes(key))) {
    fail('Usage lookup accepts only a selected skill, exact digests and bounded pagination.');
  }
  const { skillId, packageSha256, limit = 32, cursor = 0, expectedSource } = request;
  checkedId(skillId);
  if ((packageSha256 !== undefined && (typeof packageSha256 !== 'string' || !SHA.test(packageSha256)))
      || (expectedSource !== undefined && (typeof expectedSource !== 'string' || !SHA.test(expectedSource)))
      || !Number.isSafeInteger(limit) || limit < 1 || limit > SKP_USAGE_LIMITS.page
      || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > SKP_USAGE_LIMITS.references
      || (cursor > 0 && expectedSource === undefined)) {
    fail('Select a bounded page and exact digests; later pages require the preceding source digest.');
  }
  return withApprovedConfigurationRead(root, async (authority) => {
    const snapshot = configurationReadSnapshot(root);
    if (!authority || authority.kind === 'working-tree' || typeof authority.remote !== 'string'
        || !OID.test(authority.commit ?? '') || !snapshot
        || snapshot.observedCommit !== authority.commit
        || snapshot.sourceCommit !== (authority.manifest?.source?.commit ?? authority.commit)
        || snapshot.authority.remote !== authority.remote) {
      fail('Usage lookup requires one complete verified approved configuration snapshot; unknown scope is not empty usage.', 'SKP_USAGE_SCOPE_UNAVAILABLE');
    }
    const repository = repositoryIdentity(root, authority.remote);
    const workflowAsset = snapshot.assets.find((entry) => entry.relative === 'singularity/workflow.yml');
    if (!workflowAsset) fail('The approved usage source is incomplete.', 'SKP_USAGE_SCOPE_UNAVAILABLE');
    const source = { kind: authority.kind, repository, ref: authority.ref,
      observedCommit: authority.commit, configurationCommit: snapshot.sourceCommit,
      workflowSha256: `sha256:${workflowAsset.sha256}` };
    const sourceSha256 = digest(source);
    if (expectedSource !== undefined && expectedSource !== sourceSha256) {
      fail('The approved configuration source changed; restart usage pagination from the first page.', 'SKP_USAGE_SOURCE_CHANGED');
    }
    // The package owner verifies only this selected package's retained bytes, not all skills.
    const capture = await inspectApprovedSkillPackage(snapshot, skillId, { expectedPackageSha256: packageSha256 });
    const selectedPackageSha256 = capture.manifest.packageSha256;
    const definition = await loadDefinition(root);
    const phaseEntries = Object.entries(definition.phases);
    const workflowEntries = Object.entries(definition.workTypes);
    // Ambient plugin/bundled agents are not bytes retained by this exact configuration source.
    const agents = (definition.agentCatalog ?? []).filter((agent) => agent.scope === 'repository');
    boundedCount(phaseEntries.length, SKP_USAGE_LIMITS.phases);
    boundedCount(workflowEntries.length, SKP_USAGE_LIMITS.workflows);
    boundedCount(agents.length, SKP_USAGE_LIMITS.agents);
    phaseEntries.forEach(([id]) => checkedId(id));
    workflowEntries.forEach(([id]) => checkedId(id));
    const rows = [];
    let edges = 0;
    const edge = () => boundedCount(++edges, SKP_USAGE_LIMITS.edges);
    const add = (row) => { boundedCount(rows.length + 1, SKP_USAGE_LIMITS.references); rows.push(row); };
    const selectedPhases = new Set();
    let otherPackageBindings = 0;
    for (const [phaseId, phase] of phaseEntries) {
      const binding = phase.kind === 'skill' ? phase.skillBinding?.bindingRefs?.skill : null;
      if (binding?.id !== skillId) continue;
      if (binding.packageSha256 !== selectedPackageSha256) { otherPackageBindings += 1; continue; }
      selectedPhases.add(phaseId);
      const output = phase.skillBinding.bindingRefs.outputs.find((candidate) => candidate.path === phase.artifact.path);
      add({ kind: 'phase', phaseId, packageBinding: 'exact',
        packageSha256: selectedPackageSha256, compilationSha256: phase.skillBinding.compilationSha256,
        claimRole: skillPhasePrimaryOutputRole({ ...phase, id: phaseId }),
        clauses: output?.clauses ?? null, codeDelivery: phaseRequiresCodeDelivery(phase) });
    }
    const agentPhases = new Map();
    const phaseDefaultAgents = new Map();
    for (const agent of agents) {
      checkedId(agent.id);
      const directDefaults = [...new Set(agent.defaultFor.filter((phaseId) => selectedPhases.has(phaseId)))];
      if (directDefaults.length) add({ kind: 'agent', agentId: agent.id,
        reference: 'skill-phase-default-agent', packageBinding: 'exact',
        meaning: 'declared-default-producer-not-observed-execution' });
      for (const phaseId of directDefaults) {
        edge(); phaseDefaultAgents.set(phaseId, agent.id);
        add({ kind: 'agent-phase', agentId: agent.id, phaseId,
          reference: 'skill-phase-default-agent', packageBinding: 'exact', selection: 'default' });
      }
      const declarations = agent.skills.filter((entry) => entry.id === skillId);
      if (!declarations.length) continue;
      add({ kind: 'agent', agentId: agent.id, reference: 'remote-skill-id',
        packageBinding: 'unbound', meaning: 'declared-dependency-not-observed-execution' });
      const declared = new Set();
      for (const entry of declarations) {
        for (const [phaseId] of phaseEntries) {
          edge();
          if ((!agent.phases.length || agent.phases.includes(phaseId))
              && (!entry.phases.length || entry.phases.includes(phaseId))) declared.add(phaseId);
        }
      }
      agentPhases.set(agent.id, declared);
      for (const phaseId of [...declared].sort(compare)) add({ kind: 'agent-phase', agentId: agent.id,
        phaseId, packageBinding: 'unbound', selection: agent.defaultFor.includes(phaseId) ? 'default' : 'compatible-only' });
    }
    for (const [workflowId, workflow] of workflowEntries.sort(([left], [right]) => compare(left, right))) {
      boundedCount(workflow.phases.length, SKP_USAGE_LIMITS.phases);
      const resolved = resolveWorkType(definition, workflowId);
      const policy = resolved.plannedClaims;
      const codePhases = resolved.phases.filter(phaseRequiresCodeDelivery);
      for (const phase of resolved.phases) {
        edge();
        const direct = selectedPhases.has(phase.id);
        const defaultAgent = agentPhases.get(phase.defaultAgent)?.has(phase.id) ? phase.defaultAgent : null;
        if (!direct && !defaultAgent) continue;
        // Only the existing owner's complete required topology proves these declared impacts.
        const criteriaFor = policy.mode === 'required' && policy.clausePhases.includes(phase.id)
          ? codePhases.map((candidate) => candidate.id).sort(compare) : [];
        const plannedClaimOwnerFor = policy.mode === 'required'
          ? Object.entries(policy.owners).filter(([, owner]) => owner === phase.id).map(([id]) => id).sort(compare) : [];
        for (const reference of [
          ...(direct ? [{ reference: 'skill-phase', packageBinding: 'exact',
            ...(phaseDefaultAgents.has(phase.id) ? { agentId: phaseDefaultAgents.get(phase.id) } : {}) }] : []),
          ...(defaultAgent ? [{ reference: 'default-agent-remote-skill-id', packageBinding: 'unbound', agentId: defaultAgent }] : [])
        ]) add({ kind: 'workflow', workflowId, phaseId: phase.id, ...reference,
          contractImpact: { codeDelivery: phaseRequiresCodeDelivery(phase),
            claimRole: skillPhasePrimaryOutputRole(phase), topologyMode: policy.mode,
            criteriaFor, plannedClaimOwnerFor,
            assessment: codePhases.length ? (policy.mode === 'required' ? 'declared-required-topology' : 'not-proven') : 'code-not-applicable' } });
      }
    }
    rows.sort((left, right) => compare(canonicalJson(left), canonicalJson(right)));
    if (cursor > rows.length) fail('The selected usage page does not exist.', 'SKP_USAGE_INVALID');
    const page = rows.slice(cursor, cursor + limit);
    const report = { format: 'sflow-skill-usage/v1', subject: { skillId, packageSha256: selectedPackageSha256 },
      source, sourceSha256, permissionEffect: 'none',
      readScope: { kind: 'selected-approved-configuration', authorization: 'existing-git-repository-read-access',
        authenticatedPrincipal: 'not-established', teamFiltering: 'not-established' },
      coverage: { kind: 'configuration-only', declaredReferences: 'complete-within-bounds',
        executionUsage: 'not-assessed', storyPins: 'not-searched', historicalConfigurations: 'not-searched',
        otherRepositories: 'not-searched', initiativeDefinitions: 'not-searched',
        ambientAgents: 'not-searched', idOnlyAgentReferences: 'not-package-proof', otherPackageBindings },
      page: { cursor, limit, total: rows.length, returned: page.length,
        nextCursor: cursor + page.length < rows.length ? cursor + page.length : null,
        complete: cursor + page.length >= rows.length }, references: page };
    const text = canonicalJson(report);
    if (Buffer.byteLength(text) > SKP_USAGE_LIMITS.pageBytes) fail('The selected usage page exceeds its byte budget; select a smaller page.', 'SKP_USAGE_LIMIT');
    if (scanEntries([{ path: 'skill-usage.json', content: text, forceScan: true }]).findings.length) {
      fail('The usage projection contains credential-shaped metadata and cannot be disclosed.', 'SKP_USAGE_DISCLOSURE_BLOCKED');
    }
    return JSON.parse(text);
  }, { preferAuthority: true, requireAuthorityRefresh: true, allowLocalHeads: false });
}
