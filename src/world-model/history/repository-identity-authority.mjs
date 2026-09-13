import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';

import { CAPABILITIES_PATH, EFFECTIVE_CAPABILITY_RESOLVER } from '../../capabilities.mjs';
import { resolveLifecycleCapability } from '../../capability-context.mjs';
import { readConfigurationSource } from '../../configuration-branch.mjs';
import { configurationReadRoot } from '../../configuration-read-scope.mjs';
import {
  assertCredentialFreeRemote, configuredRemoteIdentity, remoteFingerprint
} from '../../git-remote-diagnostics.mjs';
import { PORTFOLIO_PATH, validatePortfolio } from '../../initiative-config.mjs';
import { withWorldModelSourceScope } from '../../source-scope.mjs';
import { secureRepositoryPath } from '../../util.mjs';
import { canonicalJson, deepFreeze, sealRecord, sha256 } from '../canonicalize.mjs';
import {
  assertExactKeys, assertPlainRecord, assertSelfHash, assertSha256,
  assertString, contractFailure
} from '../contracts.mjs';
import {
  createWorldModelRepositoryDomain, validateWorldModelRepositoryDomain
} from './model-owners.mjs';
import { configuredWorldModelV4ScopeOptions } from '../scope/configuration.mjs';
import { createScopeManifest } from '../scope/manifest.mjs';

const AUTHORITY_KINDS = new Set(['approved-configuration', 'pinned-story-configuration']);
const CAPABILITY_MODES = new Set(['explicit-managed', 'explicit-legacy']);
const REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const CAPABILITY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAXIMUM_PORTFOLIO_BYTES = 16 * 1024 * 1024;

function fail(message, code = 'WMP_REPOSITORY_AUTHORITY_INVALID', details = {}) {
  contractFailure(message, code, details);
}

function boundedString(value, label, { pattern, maximumBytes = 256 } = {}) {
  assertString(value, label, { ...(pattern ? { pattern } : {}) });
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    fail(`${label} exceeds its ${maximumBytes}-byte limit.`, 'WMP_REPOSITORY_AUTHORITY_LIMIT');
  }
  return value;
}

function validateCapability(value) {
  assertPlainRecord(value, 'World-model Repository Identity Authority capability');
  assertExactKeys(value, {
    required: ['id', 'mode', 'resolutionSha256', 'stateSha256'],
    label: 'World-model Repository Identity Authority capability'
  });
  boundedString(value.id, 'Repository Identity Authority capability id', {
    pattern: CAPABILITY_ID, maximumBytes: 128
  });
  if (!CAPABILITY_MODES.has(value.mode)) {
    fail(
      'Repository Identity Authority requires an explicit approved capability resolution.',
      'WMP_REPOSITORY_AUTHORITY_EXPLICIT_CAPABILITY_REQUIRED'
    );
  }
  assertSha256(value.resolutionSha256,
    'Repository Identity Authority capability resolutionSha256');
  assertSha256(value.stateSha256, 'Repository Identity Authority capability stateSha256');
  return value;
}

function validateConfigurationAuthority(value) {
  assertPlainRecord(value, 'World-model Repository Identity Authority configurationAuthority');
  assertExactKeys(value, {
    required: [
      'kind', 'repositoryIdentitySha256', 'branch', 'commit', 'capabilityMapSha256',
      'portfolioSha256'
    ],
    label: 'World-model Repository Identity Authority configurationAuthority'
  });
  if (!AUTHORITY_KINDS.has(value.kind)) {
    fail(
      'Repository Identity Authority must originate from approved or Story-pinned configuration.',
      'WMP_REPOSITORY_AUTHORITY_UNGOVERNED'
    );
  }
  assertSha256(value.repositoryIdentitySha256,
    'Repository Identity Authority configuration repositoryIdentitySha256');
  boundedString(value.branch, 'Repository Identity Authority configuration branch', {
    pattern: BRANCH, maximumBytes: 256
  });
  if (value.branch.includes('..') || value.branch.includes('//') || value.branch.endsWith('/')
      || value.branch.endsWith('.lock') || value.branch.includes('@{')) {
    fail('Repository Identity Authority configuration branch is unsafe.');
  }
  assertString(value.commit, 'Repository Identity Authority configuration commit', {
    pattern: COMMIT
  });
  assertSha256(value.capabilityMapSha256,
    'Repository Identity Authority configuration capabilityMapSha256');
  assertSha256(value.portfolioSha256,
    'Repository Identity Authority configuration portfolioSha256');
  return value;
}

/**
 * Validate one short-lived action proof. This value is deliberately not a MIG family or retained
 * model input: a past configuration cut must never become reusable permission for a later action.
 */
export function validateWorldModelRepositoryIdentityAuthority(value) {
  const result = value;
  assertPlainRecord(result, 'World-model Repository Identity Authority');
  assertExactKeys(result, {
    required: [
      'kind', 'version', 'repositoryDomainSha256', 'repositoryId',
      'repositoryIdentitySha256', 'capability', 'configurationAuthority', 'authoritySha256'
    ],
    label: 'World-model Repository Identity Authority'
  });
  if (result.kind !== 'wmp/repository-identity-authority' || result.version !== 1) {
    fail('World-model Repository Identity Authority kind or version is unsupported.');
  }
  assertSha256(result.repositoryDomainSha256,
    'Repository Identity Authority repositoryDomainSha256');
  boundedString(result.repositoryId, 'Repository Identity Authority repositoryId', {
    pattern: REPOSITORY_ID, maximumBytes: 256
  });
  if (result.repositoryId.includes('/') || result.repositoryId.includes('\\')
      || /^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/iu.test(result.repositoryId)) {
    fail(
      'Repository Identity Authority repositoryId cannot be a path or remote URL.',
      'WMP_REPOSITORY_DOMAIN_NOT_PORTABLE'
    );
  }
  assertSha256(result.repositoryIdentitySha256,
    'Repository Identity Authority repositoryIdentitySha256');
  validateCapability(result.capability);
  validateConfigurationAuthority(result.configurationAuthority);
  if (result.capability.stateSha256
      !== result.configurationAuthority.capabilityMapSha256) {
    fail(
      'Repository Identity Authority capability does not match its approved map.',
      'WMP_REPOSITORY_AUTHORITY_CAPABILITY_MISMATCH'
    );
  }
  assertSha256(result.authoritySha256, 'Repository Identity Authority authoritySha256');
  assertSelfHash(
    result, 'authoritySha256', 'World-model Repository Identity Authority'
  );
  return result;
}

/** Compare an action-bound authority proof to the exact retained Repository Domain. */
export function assertWorldModelRepositoryIdentityAuthority(authorityValue, repositoryDomainValue) {
  const authority = validateWorldModelRepositoryIdentityAuthority(authorityValue);
  const domain = validateWorldModelRepositoryDomain(repositoryDomainValue);
  if (authority.repositoryDomainSha256 !== domain.repositoryDomainSha256
      || authority.repositoryId !== domain.repositoryId
      || authority.repositoryIdentitySha256 !== domain.repositoryIdentitySha256) {
    fail(
      'Governed repository identity authority does not match the retained Repository Domain.',
      'WMP_REPOSITORY_AUTHORITY_DOMAIN_MISMATCH',
      {
        expectedRepositoryDomainSha256: domain.repositoryDomainSha256,
        receivedRepositoryDomainSha256: authority.repositoryDomainSha256
      }
    );
  }
  return authority;
}

function createAuthority({ repositoryDomain, capability, configurationAuthority }) {
  const domain = validateWorldModelRepositoryDomain(repositoryDomain);
  const base = {
    kind: 'wmp/repository-identity-authority',
    version: 1,
    repositoryDomainSha256: domain.repositoryDomainSha256,
    repositoryId: domain.repositoryId,
    repositoryIdentitySha256: domain.repositoryIdentitySha256,
    capability,
    configurationAuthority
  };
  return deepFreeze(validateWorldModelRepositoryIdentityAuthority(
    sealRecord(base, 'authoritySha256')
  ));
}

function validateEffectiveResolution(value) {
  assertPlainRecord(value, 'Effective capability resolution');
  if (value.kind !== 'effective-capability-resolution'
      || !CAPABILITY_MODES.has(value.mode)
      || canonicalJson(value.resolver) !== canonicalJson(EFFECTIVE_CAPABILITY_RESOLVER)) {
    fail(
      'WMP repository authority requires a current explicit capability resolution.',
      'WMP_REPOSITORY_AUTHORITY_EXPLICIT_CAPABILITY_REQUIRED'
    );
  }
  const core = structuredClone(value);
  delete core.resolutionSha256;
  delete core.policy;
  if (value.resolutionSha256 !== sha256(core)
      || value.policySha256 !== sha256(value.policy)) {
    fail(
      'Effective capability resolution does not verify.',
      'WMP_REPOSITORY_AUTHORITY_CAPABILITY_MISMATCH'
    );
  }
  if (!value.repository || !REPOSITORY_ID.test(value.repository.id ?? '')
      || !/^sha256:[a-f0-9]{64}$/u.test(value.repository.identitySha256 ?? '')) {
    fail(
      'The selected checkout does not resolve to one portable approved portfolio repository.',
      'WMP_REPOSITORY_AUTHORITY_REPOSITORY_MISMATCH'
    );
  }
  if (!value.capability || !CAPABILITY_ID.test(value.capability.id ?? '')
      || !/^sha256:[a-f0-9]{64}$/u.test(value.capabilityStateSha256 ?? '')
      || !/^sha256:[a-f0-9]{64}$/u.test(value.approvedConfigurationSha256 ?? '')) {
    fail(
      'Effective capability resolution omits its portable repository or approved map identity.',
      'WMP_REPOSITORY_AUTHORITY_CAPABILITY_MISMATCH'
    );
  }
  return value;
}

function pinnedAuthorityMatches(left, right) {
  return left?.repository === right?.repository
    && left?.branch === right?.branch
    && left?.commit === right?.commit;
}

/**
 * Select the immutable capability resolution from a validated canonical Story aggregate.
 * `loadWorkflow` owns aggregate/schema admission; this function binds that pin to the exact
 * configuration source and capability map selected by the repository resolver.
 */
export function selectPinnedStoryCapabilityResolution(workflow, resolvedCapability, {
  suppliedResolution = null,
  currentConfigurationSource = null
} = {}) {
  const pinned = workflow?.resolution?.capability;
  const configurationSource = workflow?.resolution?.configurationSource;
  const map = resolvedCapability?.map;
  if (!pinned?.effectiveResolution || !currentConfigurationSource
      || pinned.id !== resolvedCapability?.id
      || pinned.map?.path !== CAPABILITIES_PATH
      || pinned.map?.sha256 !== map?.sha256
      || !pinnedAuthorityMatches(pinned.map, map)
      || !pinnedAuthorityMatches(configurationSource, map)
      || currentConfigurationSource.files?.[CAPABILITIES_PATH] !== map?.sha256
      || canonicalJson(configurationSource) !== canonicalJson(currentConfigurationSource)) {
    fail(
      'The current Story does not bind the exact pinned capability and configuration authority.',
      'WMP_STORY_CAPABILITY_PIN_MISMATCH'
    );
  }
  const effective = validateEffectiveResolution(pinned.effectiveResolution);
  if (suppliedResolution
      && canonicalJson(validateEffectiveResolution(suppliedResolution))
        !== canonicalJson(effective)) {
    fail(
      'The supplied Story capability resolution differs from the canonical Story pin.',
      'WMP_STORY_CAPABILITY_PIN_MISMATCH'
    );
  }
  return effective;
}

async function canonicalStoryCapabilityResolution(root, resolvedCapability, suppliedResolution) {
  try {
    // Dynamic loading avoids making capability discovery depend on the lifecycle state module at
    // module-initialization time. The loaded aggregate is still admitted by the normal Story
    // schema and branch/session index before any nested resolution is trusted.
    const [{ loadDefinition }, { loadWorkflow }, { verifyWorkflowSnapshot }] = await Promise.all([
      import('../../config.mjs'), import('../../state.mjs'),
      import('../../workflow-snapshots.mjs')
    ]);
    // Re-read and verify the complete materialized asset set. Matching only the branch/commit is
    // insufficient because a copied configuration-source record can be rewritten together with
    // changed assets while continuing to name the old commit.
    const currentConfigurationSource = await readConfigurationSource(root, { verify: true });
    const definition = await loadDefinition(root);
    const workflow = await loadWorkflow(root, definition);
    const accepted = await verifyWorkflowSnapshot(root, definition, workflow, {
      retainBytes: true, requireAccepted: true
    });
    if (!accepted.enrolled || !accepted.policy) {
      fail(
        'Story-backed WMP authority requires an immutable accepted workflow-policy snapshot.',
        'WMP_STORY_CAPABILITY_PIN_REQUIRED'
      );
    }
    const effective = selectPinnedStoryCapabilityResolution(
      { resolution: accepted.policy }, resolvedCapability, {
      suppliedResolution,
      currentConfigurationSource
      }
    );
    if (!accepted.policy.worldModelPolicy
        || typeof accepted.policy.worldModelPolicy !== 'object'
        || Array.isArray(accepted.policy.worldModelPolicy)) {
      fail(
        'Story-backed WMP scope authority requires its accepted World-model policy snapshot.',
        'WMP_STORY_SCOPE_POLICY_REQUIRED'
      );
    }
    return {
      effective,
      scopeCapability: accepted.policy.capability,
      worldModelPolicy: accepted.policy.worldModelPolicy,
      worldModelSourceScope: accepted.policy.worldModelSourceScope ?? null
    };
  } catch (error) {
    if (error?.code?.startsWith?.('WMP_STORY_')) throw error;
    fail(
      'Story-backed WMP repository authority requires the canonical Story capability pin.',
      'WMP_STORY_CAPABILITY_PIN_REQUIRED', { cause: error?.code ?? null }
    );
  }
}

async function readApprovedPortfolioBytes(root) {
  const located = await secureRepositoryPath(root, PORTFOLIO_PATH, {
    label: 'Approved repository portfolio', type: 'file'
  });
  if (!located.exists) {
    fail(
      `Approved repository authority is missing ${PORTFOLIO_PATH}.`,
      'WMP_REPOSITORY_AUTHORITY_PORTFOLIO_REQUIRED'
    );
  }
  let handle;
  try {
    handle = await open(located.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAXIMUM_PORTFOLIO_BYTES) {
      fail(
        `Approved repository portfolio must be a bounded regular file.`,
        'WMP_REPOSITORY_AUTHORITY_PORTFOLIO_REQUIRED',
        { bytes: stat.size, maximumBytes: MAXIMUM_PORTFOLIO_BYTES }
      );
    }
    return await handle.readFile();
  } catch (error) {
    if (error?.code?.startsWith?.('WMP_')) throw error;
    fail(
      'Approved repository portfolio could not be retained safely.',
      'WMP_REPOSITORY_AUTHORITY_PORTFOLIO_REQUIRED',
      { cause: error?.code ?? null }
    );
  } finally {
    await handle?.close();
  }
}

function fingerprint(value, label) {
  let remote;
  try { remote = assertCredentialFreeRemote(value); }
  catch (error) {
    fail(`${label} is not a credential-free repository identity.`,
      'WMP_REPOSITORY_AUTHORITY_REMOTE_INVALID', { cause: error?.code ?? null });
  }
  return `sha256:${remoteFingerprint(remote)}`;
}

/**
 * Resolve one governed WMP repository identity from approved configuration and the exact checkout.
 *
 * Callers cannot supply a repository ID or digest. The resolver obtains both from the verified
 * capability rail, proves the checkout's raw origin against the approved portfolio, and returns
 * only digest identities. It never persists a URL or machine path.
 */
export async function resolveWorldModelRepositoryIdentityAuthority(root, {
  capabilityId = null,
  pinnedCapabilityResolution = null
} = {}) {
  const repositoryRoot = path.resolve(root);
  const resolved = await resolveLifecycleCapability(repositoryRoot, {
    capabilityId, required: true, refuseAmbiguous: true,
    // Persisted lookup/build consumes only a locally admitted approved configuration cut. It must
    // never fetch the state ledger, wait for credentials, or fold a live lease behind the user's
    // back. Story leases arrive only through the canonical aggregate pin below.
    offline: true
  });
  const recomputedEffective = validateEffectiveResolution(resolved?.effectiveResolution);
  const map = resolved?.map;
  if (!map || !AUTHORITY_KINDS.has(map.authority)
      || map.path !== CAPABILITIES_PATH || !/^[a-f0-9]{64}$/u.test(map.sha256 ?? '')
      || !map.repository || !map.branch || !map.commit) {
    fail(
      'WMP repository identity is not backed by approved or Story-pinned configuration.',
      'WMP_REPOSITORY_AUTHORITY_UNGOVERNED',
      { authority: map?.authority ?? null }
    );
  }
  const selectedDelivery = resolved.kind === 'delivery'
    ? resolved.deliveries?.find((entry) => entry.id === resolved.id)
    : null;
  if (!selectedDelivery
      || !selectedDelivery.repositories?.includes(recomputedEffective.repository.id)) {
    fail(
      `Capability '${resolved.id}' does not deliver the current repository '${recomputedEffective.repository.id}'.`,
      'WMP_REPOSITORY_AUTHORITY_CAPABILITY_REPOSITORY_MISMATCH', {
        capabilityId: resolved.id,
        repositoryId: recomputedEffective.repository.id
      }
    );
  }
  const capabilityMapSha256 = `sha256:${map.sha256}`;
  // A Story is authorized by the exact capability resolution captured when it was accepted. Do
  // not silently replace that pin with a later break-glass lease or current policy fold. The
  // caller that owns the Story aggregate must supply its sealed resolution for every action; a
  // missing pin is a refusal, not permission to recompute.
  let effective = recomputedEffective;
  let storyScope = null;
  if (map.authority === 'pinned-story-configuration') {
    storyScope = await canonicalStoryCapabilityResolution(
      repositoryRoot, resolved, pinnedCapabilityResolution
    );
    effective = storyScope.effective;
  } else if (pinnedCapabilityResolution) {
    // A supplied pin may never override configuration which the resolver did not identify as the
    // Story's exact approved snapshot.
    fail(
      'A Story capability pin cannot be applied to non-Story configuration authority.',
      'WMP_STORY_CAPABILITY_PIN_MISMATCH'
    );
  }
  if (effective.capabilityStateSha256 !== capabilityMapSha256
      || effective.approvedConfigurationSha256 !== capabilityMapSha256
      || resolved.id !== effective.capability.id
      || resolved.mode !== effective.mode) {
    fail(
      'Capability resolution does not match its exact approved capability map.',
      'WMP_REPOSITORY_AUTHORITY_CAPABILITY_MISMATCH'
    );
  }
  if (effective.repository.id !== recomputedEffective.repository.id
      || effective.repository.identitySha256
        !== recomputedEffective.repository.identitySha256) {
    fail(
      'Story-pinned capability repository differs from the selected checkout repository.',
      'WMP_REPOSITORY_AUTHORITY_CAPABILITY_REPOSITORY_MISMATCH'
    );
  }

  const portfolioBytes = await readApprovedPortfolioBytes(configurationReadRoot(repositoryRoot));
  let portfolio;
  try { portfolio = validatePortfolio(YAML.parse(portfolioBytes.toString('utf8'))); }
  catch (error) {
    fail(
      `Approved repository portfolio is invalid: ${error.message}`,
      'WMP_REPOSITORY_AUTHORITY_PORTFOLIO_REQUIRED', { cause: error?.code ?? null }
    );
  }
  const declared = portfolio.repositories?.[effective.repository.id];
  if (!declared?.url) {
    fail(
      `Approved portfolio does not bind repository '${effective.repository.id}'.`,
      'WMP_REPOSITORY_AUTHORITY_REPOSITORY_MISSING',
      { repositoryId: effective.repository.id }
    );
  }
  const approvedRepositoryIdentitySha256 = fingerprint(
    declared.url, 'Approved portfolio repository URL'
  );
  const checkout = configuredRemoteIdentity(repositoryRoot, 'origin', { direction: 'fetch' });
  if (!checkout.configured || checkout.ambiguous || !checkout.fingerprint) {
    fail(
      'WMP repository authority requires one exact raw credential-free origin URL.',
      'WMP_REPOSITORY_AUTHORITY_REMOTE_INVALID',
      { configured: checkout.configured, ambiguous: checkout.ambiguous }
    );
  }
  const checkoutIdentitySha256 = `sha256:${checkout.fingerprint}`;
  if (checkoutIdentitySha256 !== approvedRepositoryIdentitySha256
      || effective.repository.identitySha256 !== approvedRepositoryIdentitySha256) {
    fail(
      'The selected checkout does not match its approved portfolio repository identity.',
      'WMP_REPOSITORY_AUTHORITY_REPOSITORY_MISMATCH',
      { repositoryId: effective.repository.id }
    );
  }

  const repositoryDomain = createWorldModelRepositoryDomain({
    repositoryId: effective.repository.id,
    repositoryIdentitySha256: approvedRepositoryIdentitySha256
  });
  const repositoryIdentityAuthority = createAuthority({
    repositoryDomain,
    capability: {
      id: effective.capability.id,
      mode: effective.mode,
      resolutionSha256: effective.resolutionSha256,
      stateSha256: effective.capabilityStateSha256
    },
    configurationAuthority: {
      kind: map.authority,
      repositoryIdentitySha256: fingerprint(
        map.repository, 'Approved configuration repository URL'
      ),
      branch: map.branch,
      commit: map.commit,
      capabilityMapSha256,
      portfolioSha256: sha256(portfolioBytes)
    }
  });
  assertWorldModelRepositoryIdentityAuthority(repositoryIdentityAuthority, repositoryDomain);
  // Build the Scope Manifest from the same approved bytes used by the normal WMB command path.
  // A caller may present a Scope Manifest for source capture, but it cannot define or widen these
  // paths: persisted-model preparation compares that value with this independently derived owner.
  let scopeDefinition;
  let scopeConfiguration;
  if (storyScope) {
    const [{ loadDefinition }] = await Promise.all([import('../../config.mjs')]);
    const currentDefinition = await loadDefinition(repositoryRoot);
    scopeDefinition = withWorldModelSourceScope({
      ...currentDefinition,
      worldModel: structuredClone(storyScope.worldModelPolicy)
    }, storyScope.worldModelSourceScope);
    scopeConfiguration = {
      definition: scopeDefinition,
      workflow: { resolution: { capability: storyScope.scopeCapability } },
      repositoryCapability: null
    };
  } else {
    const [{ loadDefinition }] = await Promise.all([import('../../config.mjs')]);
    const currentDefinition = await loadDefinition(repositoryRoot);
    scopeDefinition = withWorldModelSourceScope(currentDefinition, resolved.sourceScope ?? null);
    scopeConfiguration = {
      definition: scopeDefinition,
      workflow: null,
      repositoryCapability: resolved
    };
  }
  const scopeManifest = createScopeManifest(
    configuredWorldModelV4ScopeOptions(repositoryRoot, scopeConfiguration)
  );
  return deepFreeze({ repositoryDomain, repositoryIdentityAuthority, scopeManifest });
}
