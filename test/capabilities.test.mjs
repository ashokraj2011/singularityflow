import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  CAPABILITIES_PATH, editCapability,
  activeCapabilityLeases, capabilityDeliveries, capabilityForRepository, capabilityPath, capabilityTree, flattenCapabilityTree, foldCapabilityPolicy, resolveCapabilityPolicy, resolveEffectiveCapabilityPolicy, validateCapabilities
} from '../src/capabilities.mjs';

test('capability policy fold only permits equal or stricter child constraints', () => {
  const folded = foldCapabilityPolicy({
    gateSeverity: 'warn',
    approvalMinimum: 1,
    allowSelfApproval: true,
    maxDocumentBytes: 1000,
    allowedPhases: ['intake', 'design'],
    requiredChecks: ['unit'],
    requiredAuthorityGroups: ['product-approvers'],
    jiraProjects: ['PAY', 'MOB'],
    jiraFields: ['summary', 'description', 'labels'],
    protectedPaths: ['singularity/workflow.yml'],
    worldModelGrounding: 'warn',
    tokenBudget: 100000,
    gitPublication: 'warn',
    contextBoundary: 'keep',
    contextMaxBytes: 100000
  }, {
    gateSeverity: 'block',
    approvalMinimum: 2,
    allowSelfApproval: false,
    maxDocumentBytes: 500,
    allowedPhases: ['design'],
    requiredChecks: ['security'],
    requiredAuthorityGroups: ['architecture-reviewers'],
    jiraProjects: ['PAY'],
    jiraFields: ['summary', 'description'],
    protectedPaths: ['singularity/capabilities.yml'],
    worldModelGrounding: 'enforce',
    tokenBudget: 50000,
    gitPublication: 'required',
    contextBoundary: 'new',
    contextMaxBytes: 50000
  });
  assert.equal(folded.gateSeverity, 'block');
  assert.equal(folded.approvalMinimum, 2);
  assert.equal(folded.allowSelfApproval, false);
  assert.equal(folded.maxDocumentBytes, 500);
  assert.deepEqual(folded.allowedPhases, ['design']);
  assert.deepEqual(folded.requiredChecks, ['unit', 'security']);
  assert.deepEqual(folded.requiredAuthorityGroups, ['product-approvers', 'architecture-reviewers']);
  assert.deepEqual(folded.jiraProjects, ['PAY']);
  assert.deepEqual(folded.jiraFields, ['summary', 'description']);
  assert.deepEqual(folded.protectedPaths, ['singularity/workflow.yml', 'singularity/capabilities.yml']);
  assert.equal(folded.worldModelGrounding, 'enforce');
  assert.equal(folded.tokenBudget, 50000);
  assert.equal(folded.gitPublication, 'required');
  assert.equal(folded.contextBoundary, 'new');
  assert.equal(folded.contextMaxBytes, 50000);
  assert.deepEqual(foldCapabilityPolicy({ jiraProjects: ['PAY'] }, { jiraProjects: [] }).jiraProjects, []);
  assert.throws(() => foldCapabilityPolicy({}, { approvalMinimum: 0 }), /positive integer/);
});

test('capability tree validates a single root and resolves inherited policy', () => {
  const definition = validateCapabilities({
    version: 1,
    capabilities: {
      enterprise: { kind: 'collection', parent: null, policy: { approvalMinimum: 1, requiredChecks: ['unit'] } },
      payments: { kind: 'collection', parent: 'enterprise', policy: { approvalMinimum: 2, requiredChecks: ['security'] } },
      checkout: { kind: 'collection', parent: 'payments', policy: { gateSeverity: 'block' } }
    }
  });
  assert.deepEqual(capabilityPath(definition, 'checkout'), ['enterprise', 'payments', 'checkout']);
  const resolved = resolveCapabilityPolicy(definition, 'checkout');
  assert.equal(resolved.policy.approvalMinimum, 2);
  assert.deepEqual(resolved.policy.requiredChecks, ['unit', 'security']);
  assert.equal(resolved.policy.gateSeverity, 'block');
});

test('capability validation rejects multiple roots and cycles', () => {
  assert.throws(() => validateCapabilities({
    version: 1,
    capabilities: {
      one: { kind: 'collection' },
      two: { kind: 'collection' }
    }
  }), /exactly one root/);
  assert.throws(() => validateCapabilities({
    version: 1,
    capabilities: {
      one: { kind: 'collection', parent: 'two' },
      two: { kind: 'collection', parent: 'one' }
    }
  }), /exactly one root|cycle/);
});

test('break-glass leases relax policy outside the monotone fold and expire or revoke explicitly', () => {
  const definition = validateCapabilities({
    version: 1,
    capabilities: {
      enterprise: { kind: 'collection', policy: { approvalMinimum: 2, gateSeverity: 'block' } },
      checkout: { kind: 'collection', parent: 'enterprise', policy: {} }
    }
  });
  const grant = {
    eventType: 'capability-lease-granted',
    capabilityId: 'enterprise',
    authorityGroup: 'risk-reviewers',
    actor: { email: 'reviewer@example.com' },
    payload: {
      leaseId: 'lease-1',
      expiresAt: '2030-01-01T00:00:00.000Z',
      reason: 'Controlled recovery',
      relaxation: { approvalMinimum: 1, gateSeverity: 'warn' }
    }
  };
  const effective = resolveEffectiveCapabilityPolicy(definition, 'checkout', [grant], {
    at: new Date('2029-01-01T00:00:00.000Z')
  });
  assert.equal(effective.basePolicy.approvalMinimum, 2);
  assert.equal(effective.policy.approvalMinimum, 1);
  assert.equal(effective.policy.gateSeverity, 'warn');
  assert.equal(effective.leases.length, 1);
  assert.equal(activeCapabilityLeases(definition, 'checkout', [grant], {
    at: new Date('2031-01-01T00:00:00.000Z')
  }).length, 0);
  assert.equal(activeCapabilityLeases(definition, 'checkout', [{
    eventType: 'capability-lease-revoked',
    capabilityId: 'enterprise',
    payload: { leaseId: 'lease-1' }
  }, grant], {
    at: new Date('2029-01-01T00:00:00.000Z')
  }).length, 0);
});

test('collection and delivery kinds agree with repository responsibility', () => {
  const definition = validateCapabilities({
    version: 1,
    capabilities: {
      commerce: { kind: 'collection', parent: null },
      payments: { kind: 'collection', parent: 'commerce' },
      'payments-api': { kind: 'delivery', parent: 'payments', repository: 'api' }
    }
  }, { repositories: { api: {} } });

  const rows = flattenCapabilityTree(capabilityTree(definition));
  assert.deepEqual(rows.map((row) => [row.id, row.delivery]), [
    ['commerce', false], ['payments', false], ['payments-api', true]
  ]);
});

test('a capability may ship and contain, and may ship from several repositories', () => {
  // Both were forbidden. Neither holds: a product with a web app and a service is one capability
  // with two repositories, and it may still group the capabilities beneath it.
  const definition = {
    version: 1,
    capabilities: {
      payments: {
        kind: 'delivery', type: 'tech', parent: null,
        repositories: ['api', 'web'], leadRepository: 'api'
      },
      'payments-api': { kind: 'delivery', type: 'tech', parent: 'payments', repository: 'api' }
    }
  };
  const portfolio = { repositories: { api: {}, web: {} } };
  validateCapabilities(definition, portfolio);

  const [root] = capabilityTree(definition);
  assert.deepEqual(root.repositories, ['api', 'web']);
  assert.equal(root.leadRepository, 'api', 'one lead holds the governed state');
  assert.equal(root.delivery, true);
  assert.deepEqual(root.children.map((child) => child.id), ['payments-api']);
});

test('capability kind is exactly collection or delivery and controls repository responsibility', () => {
  assert.throws(() => validateCapabilities({
    version: 1,
    capabilities: { payments: { kind: 'business', parent: null } }
  }), /kind must be one of: collection, delivery/);

  assert.throws(() => validateCapabilities({
    version: 1,
    capabilities: { payments: { kind: 'collection', parent: null, repository: 'api' } }
  }), /collection and cannot name repositories/);

  assert.throws(() => validateCapabilities({
    version: 1,
    capabilities: { payments: { kind: 'delivery', parent: null } }
  }), /delivery and must name at least one repository/);

  validateCapabilities({
    version: 1,
    capabilities: {
      payments: { kind: 'collection', parent: null },
      'payments-api': { kind: 'delivery', parent: 'payments', repository: 'api' }
    }
  }, { repositories: { api: {} } });
});

test('the lead repository must be one the capability actually ships from', () => {
  assert.throws(() => validateCapabilities({
    version: 1,
    capabilities: {
      payments: { kind: 'delivery', parent: null, repositories: ['api'], leadRepository: 'web' }
    }
  }, { repositories: { api: {}, web: {} } }), /leads with 'web', which is not one of its repositories/);
});

test('optional capability type is tech or business and remains separate from kind', () => {
  // A closed pair is the whole point: a tree where half the leaves say "technical" and half say
  // "tech" is a tree nobody can filter.
  assert.throws(() => validateCapabilities({
    version: 1,
    capabilities: { payments: { kind: 'collection', type: 'technical', parent: null } }
  }), /type must be one of: tech, business/);

  for (const type of ['tech', 'business']) {
    validateCapabilities({
      version: 1, capabilities: { payments: { kind: 'collection', type, parent: null } }
    });
  }
});

test('metadata, documentation and resources are free-form maps checked as non-empty text', () => {
  // Every organisation names these differently, so the keys are theirs; what cannot vary is that a
  // link is something you can follow.
  const definition = {
    version: 1,
    capabilities: {
      payments: {
        kind: 'collection', type: 'business', parent: null,
        metadata: { applicationId: 'APP-1001', costCenter: 'CC-42' },
        documentation: { confluence: 'https://wiki.example/payments', runbook: 'docs/runbook.md' },
        resources: { aws: 'arn:aws:iam::1234:role/payments', dashboard: 'https://grafana/payments' }
      }
    }
  };
  validateCapabilities(definition);
  const [root] = capabilityTree(definition);
  assert.equal(root.metadata.applicationId, 'APP-1001');
  assert.equal(root.documentation.confluence, 'https://wiki.example/payments');
  assert.equal(root.resources.aws, 'arn:aws:iam::1234:role/payments');

  assert.throws(() => validateCapabilities({
    version: 1,
    capabilities: { payments: { kind: 'collection', parent: null, documentation: { confluence: 42 } } }
  }), /documentation\.confluence must be non-empty text/);
  assert.throws(() => validateCapabilities({
    version: 1,
    capabilities: { payments: { kind: 'collection', parent: null, metadata: { applicationId: '' } } }
  }), /metadata\.applicationId must be non-empty text/);
});

test('a delivery capability must name a repository the portfolio declares', () => {
  assert.throws(() => validateCapabilities({
    version: 1,
    capabilities: { ghost: { kind: 'delivery', parent: null, repository: 'not-configured' } }
  }, { repositories: { api: {} } }), /which the portfolio does not declare/);

  // Without a portfolio it validates, so a map can be drafted before the repositories exist.
  assert.ok(validateCapabilities({
    version: 1,
    capabilities: { ghost: { kind: 'delivery', parent: null, repository: 'not-configured' } }
  }));
});

test('Jira and teams belong to the capability, not to the workspace', () => {
  // A workspace is a local convenience — a directory of checkouts. Which board tracks a capability
  // and who runs it are true regardless of who has cloned what.
  const definition = validateCapabilities({
    version: 1,
    capabilities: {
      payments: {
        kind: 'collection', parent: null,
        jira: { projectKey: 'PAY', board: 'Payments board' },
        teams: ['Payments squad', 'Platform']
      }
    }
  });
  const [payments] = capabilityTree(definition);
  assert.deepEqual(payments.jira, { projectKey: 'PAY', board: 'Payments board' });
  assert.deepEqual(payments.teams, ['Payments squad', 'Platform']);

  assert.throws(() => validateCapabilities({
    version: 1,
    capabilities: { payments: { kind: 'collection', parent: null, jira: { projectKey: 42 } } }
  }), /jira\.projectKey must be text/);

  // Team lists are trimmed and de-duplicated rather than rejected, which is the convention `owns`
  // already follows: a repeated name is a typo, not a decision worth failing a build over.
  const [tidied] = capabilityTree(validateCapabilities({
    version: 1,
    capabilities: { payments: { kind: 'collection', parent: null, teams: [' Platform ', 'Platform'] } }
  }));
  assert.deepEqual(tidied.teams, ['Platform']);

  assert.throws(() => validateCapabilities({
    version: 1,
    capabilities: { payments: { kind: 'collection', parent: null, teams: ['ok', ''] } }
  }), /must be an array of non-empty strings/);
});

test('what a capability ships, and which capability ships a repository', () => {
  const definition = validateCapabilities({
    version: 1,
    capabilities: {
      commerce: { kind: 'collection', parent: null },
      payments: { kind: 'collection', parent: 'commerce' },
      'payments-api': { kind: 'delivery', parent: 'payments', repository: 'api' },
      storefront: { kind: 'collection', parent: 'commerce' },
      'storefront-web': { kind: 'delivery', parent: 'storefront', repository: 'web' }
    }
  }, { repositories: { api: {}, web: {} } });

  assert.deepEqual(capabilityDeliveries(definition, 'commerce').map((entry) => entry.repository), ['api', 'web']);
  assert.deepEqual(capabilityDeliveries(definition, 'payments').map((entry) => entry.repository), ['api']);
  assert.deepEqual(capabilityDeliveries(definition, 'payments-api').map((entry) => entry.repository), ['api'],
    'a leaf ships itself');
  assert.throws(() => capabilityDeliveries(definition, 'nowhere'), /Unknown capability/);

  assert.deepEqual(capabilityForRepository(definition, 'web'),
    { id: 'storefront-web', name: 'storefront-web', ancestors: ['commerce', 'storefront'] });
  assert.equal(capabilityForRepository(definition, 'unclaimed'), null);
});

test('editing a capability preserves the comments and ordering of the file it edits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-edit-'));
  try {
    await mkdir(path.join(root, 'singularity'), { recursive: true });
    await writeFile(path.join(root, CAPABILITIES_PATH), [
      '# What this organisation builds. The lead repository holds this map.',
      'version: 1',
      'capabilities:',
      '  commerce:',
      '    kind: collection',
      '    parent: null',
      '    # Two approvals, because money moves through everything beneath this.',
      '    policy:',
      '      approvalMinimum: 2',
      '  payments:',
      '    kind: collection',
      '    parent: commerce',
      ''
    ].join('\n'), 'utf8');

    await editCapability(root, 'payments', { name: 'Payments', teams: ['Payments squad'] });
    const text = await readFile(path.join(root, CAPABILITIES_PATH), 'utf8');

    // A file people hand-edit and a screen also writes has to survive the screen having written it.
    assert.match(text, /# What this organisation builds/);
    assert.match(text, /# Two approvals, because money moves/);
    assert.match(text, /name: Payments/);
    assert.match(text, /- Payments squad/);
    // Untouched fields stay untouched rather than being re-emitted from a parsed object.
    assert.match(text, /kind: collection/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a refused capability edit leaves the file exactly as it was', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-refuse-'));
  try {
    await mkdir(path.join(root, 'singularity'), { recursive: true });
    const original = [
      'version: 1',
      'capabilities:',
      '  commerce: { kind: collection, parent: null }',
      '  payments: { kind: collection, parent: commerce }',
      ''
    ].join('\n');
    await writeFile(path.join(root, CAPABILITIES_PATH), original, 'utf8');

    // The refusal has to happen before the write — a map that is briefly invalid on disk is a map
    // something else can read while it is invalid.
    await assert.rejects(
      () => editCapability(root, 'commerce', { kind: 'delivery', repository: 'nowhere' }, { portfolio: { repositories: { api: {} } } }),
      /which the portfolio does not declare/);
    assert.equal(await readFile(path.join(root, CAPABILITIES_PATH), 'utf8'), original);

    await assert.rejects(
      () => editCapability(root, 'payments', { kind: 'delivery', repository: 'unconfigured' }, { portfolio: { repositories: { api: {} } } }),
      /which the portfolio does not declare/);
    await assert.rejects(() => editCapability(root, 'payments', { parent: 'payments' }), /cycle/);
    await assert.rejects(() => editCapability(root, 'Payments', {}, { mode: 'add' }), /kebab-case/);
    await assert.rejects(() => editCapability(root, 'payments', {}, { mode: 'add' }), /already exists/);
    await assert.rejects(() => editCapability(root, 'missing', {}), /Unknown capability/);
    await assert.rejects(() => editCapability(root, 'commerce', {}, { mode: 'remove' }), /still contains 'payments'/);
    assert.equal(await readFile(path.join(root, CAPABILITIES_PATH), 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an empty value clears a field, and an omitted one leaves it alone', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-clear-'));
  try {
    await mkdir(path.join(root, 'singularity'), { recursive: true });
    await writeFile(path.join(root, CAPABILITIES_PATH), [
      'version: 1',
      'capabilities:',
      '  commerce: { kind: collection, parent: null }',
      '  payments-api:',
      '    kind: delivery',
      '    parent: commerce',
      '    repository: api',
      '    metadata: { applicationId: APP-1001, costCenter: CC-42 }',
      '    teams: [Payments squad]',
      '    jira: { projectKey: PAY }',
      ''
    ].join('\n'), 'utf8');
    const portfolio = { repositories: { api: {} } };

    // Changing structural responsibility is explicit: switch the kind and clear the repository.
    // That is a different edit from saying nothing about either field, so both must be expressible.
    const cleared = await editCapability(root, 'payments-api', { kind: 'collection', repository: '', teams: [] }, { portfolio });
    assert.equal(cleared.capabilities['payments-api'].repository, undefined);
    assert.equal(cleared.capabilities['payments-api'].teams, undefined);
    assert.deepEqual(cleared.capabilities['payments-api'].jira, { projectKey: 'PAY' }, 'untouched');
    assert.deepEqual(cleared.capabilities['payments-api'].metadata,
      { applicationId: 'APP-1001', costCenter: 'CC-42' }, 'untouched');
    assert.equal(cleared.capabilities['payments-api'].kind, 'collection');

    const metadataEdited = await editCapability(root, 'payments-api', {
      metadata: { applicationId: 'APP-2002', costCenter: '', ownerCode: 'PZN' }
    }, { portfolio });
    assert.deepEqual(metadataEdited.capabilities['payments-api'].metadata,
      { applicationId: 'APP-2002', ownerCode: 'PZN' }, 'entries merge and empty values delete');

    const added = await editCapability(root, 'payments-web',
      { name: 'Payments Web', kind: 'delivery', parent: 'commerce', repository: 'api' },
      { mode: 'add', portfolio });
    assert.equal(added.capabilities['payments-web'].name, 'Payments Web');

    const removed = await editCapability(root, 'payments-web', {}, { mode: 'remove', portfolio });
    assert.equal(removed.removed, true);
    assert.equal(removed.capabilities['payments-web'], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
