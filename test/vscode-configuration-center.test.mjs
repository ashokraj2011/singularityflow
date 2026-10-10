import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
const {
  authorityWithMember,
  configurationCenterView,
  configurationPendingProposalStatus,
  pendingConfigurationProposal,
  configurationRefreshDecision,
  configurationSaveDisposition,
  configurationSavePlan,
  configurationSavePlanCliArgs,
  updateApprovalSecurityProfileYaml,
  updateAutoYaml,
  updateAuthorityYaml,
  updateMcpYaml,
  updateWorldModelYaml,
  validateAuthorityDraft,
  validateAutoDraft,
  validateMcpDraft,
  validateWorldModelDraft,
  validateWorldModelDraftShape
} = await import(source('configuration-center-model.ts'));
const { configurationCenterHtml, CONFIGURATION_CENTER_SCRIPT } = await import(source('configuration-center-page.ts'));

const snapshot = {
  identities: {
    git: { name: 'Casey Dev', email: 'casey@example.com', login: 'caseydev' },
    github: 'caseydev'
  },
  definition: {
    approvalSecurity: { profile: 'team' },
    phases: { intake: { label: 'Intake' }, verification: { label: 'Verification' } },
    worldModel: { sourceRoots: ['apps/payments'], sharedRoots: ['libs/contracts'] },
    approvalAuthorities: {
      'quality-reviewers': {
        label: 'Quality reviewers',
        members: [{ name: 'Quinn', email: 'quinn@example.com', githubLogin: 'quinn' }]
      }
    }
  },
  portfolio: {
    approvalAuthorities: {
      'initiative-owners': { members: [{ name: 'Pat', email: 'pat@example.com' }] }
    }
  },
  agents: [{ id: 'qa' }, { id: 'developer' }],
  mcp: {
    servers: [{
      id: 'playwright', label: 'Playwright', hostReference: 'playwright', agents: ['qa'],
      phases: ['verification'], tools: ['browser_snapshot'], required: false, approval: 'confirm',
      configured: true, sources: ['vscode-workspace'], evidence: { captureToolCalls: true, captureResults: true }
    }],
    errors: [], warnings: []
  }
};

test('configuration center keeps human authorities distinct from governed agents', () => {
  const view = configurationCenterView(snapshot, { name: 'Ashok', role: 'architect' });
  assert.deepEqual(view.agents.map((entry) => entry.id), ['developer', 'qa']);
  assert.deepEqual(view.authorities.map((entry) => `${entry.scope}:${entry.id}`), [
    'initiative:initiative-owners', 'story:quality-reviewers'
  ]);
  const html = configurationCenterHtml(view, 'people', null, null, null, []);
  assert.match(html, /People are not agents/);
  assert.match(html, /real Git email or authenticated GitHub login/);
});

test('people and approvals offers the resolved Git identity, group menu, solo mode, and governed publication', () => {
  const view = configurationCenterView(snapshot, { name: 'Local profile', role: 'architect' });
  assert.deepEqual(view.gitIdentity, {
    name: 'Casey Dev',
    email: 'casey@example.com',
    githubLogin: 'caseydev'
  });
  assert.equal(view.approvalSecurityProfile, 'team');
  assert.equal(view.approvalAllowSelfApproval, true);
  assert.equal(view.approvalAutoEnrollNewIdentities, true);
  const html = configurationCenterHtml(view, 'people', null, null, null, []);
  assert.match(html, /Add my current Git identity/);
  assert.match(html, /All configured approval groups \(2\) — default/);
  assert.match(html, /All Story approval groups \(1\)/);
  assert.ok(html.indexOf('value="*"') < html.indexOf('value="story:*"'),
    'all configured groups is the select default');
  assert.match(html, /Allow self-approval for newly started work/);
  assert.match(html, /Automatically add a new Git identity to every approval group/);
  assert.match(html, /Add, commit &amp; push/);
  assert.doesNotMatch(html, /Save without publishing/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /type: 'add-current-identity'/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /allowSelfApproval: data\.get\('allowSelfApproval'\) === 'on'/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /autoEnrollNewIdentities: data\.get\('autoEnrollNewIdentities'\) === 'on'/);
});

test('adding the current Git identity enriches matching members and never duplicates them', () => {
  const identity = { name: 'Casey Dev', email: 'CASEY@EXAMPLE.COM', githubLogin: 'caseydev' };
  const empty = authorityWithMember({
    id: 'product-approvers', label: 'Product approvers', scope: 'story',
    allowAnyGitIdentity: false, members: []
  }, identity);
  assert.equal(empty.changed, true);
  assert.deepEqual(empty.authority.members, [{
    name: 'Casey Dev', email: 'casey@example.com', githubLogin: 'caseydev'
  }]);

  const enriched = authorityWithMember({
    id: 'product-approvers', label: 'Product approvers', scope: 'story',
    allowAnyGitIdentity: false,
    members: [{ name: 'Casey Dev', email: 'casey@example.com', githubLogin: '' }]
  }, identity);
  assert.equal(enriched.changed, true);
  assert.equal(enriched.authority.members.length, 1);
  assert.equal(enriched.authority.members[0].githubLogin, 'caseydev');

  const unchanged = authorityWithMember(enriched.authority, identity);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.authority.members.length, 1);
});

test('solo developer mode changes only the approval security profile', () => {
  const output = updateApprovalSecurityProfileYaml(
    'version: 2\n# retain me\napprovalSecurity:\n  profile: team\nphases: {}\n', 'poc'
  );
  assert.match(output, /# retain me/);
  assert.equal(YAML.parse(output).approvalSecurity.profile, 'poc');
  assert.deepEqual(YAML.parse(output).phases, {});
});

test('Auto mode edits repository and work-type opt-ins while preserving every other ceiling', () => {
  const input = `version: 2
auto:
  enabled: false
  maximumModelCalls: 4
workTypes:
  feature:
    label: Feature
    auto:
      eligibility: disabled
      maximumAttempts: 2
  bugfix:
    label: Bug fix
`;
  const draft = {
    enabled: true,
    workTypes: [
      { id: 'feature', eligibility: 'bounded' },
      { id: 'bugfix', eligibility: 'plan-only' }
    ]
  };
  assert.deepEqual(validateAutoDraft(draft, ['feature', 'bugfix']), []);
  const parsed = YAML.parse(updateAutoYaml(input, draft));
  assert.equal(parsed.auto.enabled, true);
  assert.equal(parsed.auto.maximumModelCalls, 4);
  assert.equal(parsed.workTypes.feature.auto.eligibility, 'bounded');
  assert.equal(parsed.workTypes.feature.auto.maximumAttempts, 2);
  assert.equal(parsed.workTypes.bugfix.auto.eligibility, 'plan-only');
  assert.throws(
    () => updateAutoYaml(input, { enabled: true, workTypes: [{ id: 'unknown', eligibility: 'bounded' }] }),
    /Unknown work type 'unknown'.*Work type 'feature' is missing/
  );
});

test('Configuration Center exposes the complete three-layer Auto policy path', async () => {
  const view = configurationCenterView({
    ...snapshot,
    definition: {
      ...snapshot.definition,
      auto: { enabled: true },
      workTypes: {
        feature: { label: 'Feature', auto: { eligibility: 'bounded' } },
        bugfix: { label: 'Bug fix' }
      }
    }
  }, { name: 'Ashok', role: 'developer' });
  assert.equal(view.auto.enabled, true);
  assert.deepEqual(view.auto.workTypes.map(({ id, eligibility }) => [id, eligibility]), [
    ['bugfix', 'disabled'], ['feature', 'bounded']
  ]);
  const html = configurationCenterHtml(view, 'auto', null, null, null, []);
  assert.match(html, /Repository Auto/);
  assert.match(html, /Work-type eligibility/);
  assert.match(html, /Review capability limits/);
  assert.match(html, /Review &amp; publish configuration/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /type: 'save-auto'/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /data-auto-work-type/);
  assert.match(await readFile(source('configuration-center.ts'), 'utf8'), /updateAutoYaml/);
  const extension = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');
  assert.match(extension, /'singularityFlow\.configureAuto': \(\) => openConfigurationCenter\('auto'\)/);
  const manifest = JSON.parse(await readFile(path.join(root, 'apps', 'vscode', 'package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.configureAuto'));
});

test('the World Model tab is the Repository brief plus the source scope it reads', async () => {
  const view = configurationCenterView(snapshot, { name: 'Ashok', role: 'architect' });
  assert.deepEqual(view.worldModel, { sourceRoots: ['apps/payments'], sharedRoots: ['libs/contracts'] });
  const html = configurationCenterHtml(view, 'world-model', null, null, null, []);
  assert.match(html, /Repository brief/);
  assert.match(html, /<button class="secondary" data-action="repository-brief">Open Repository Brief<\/button>/);
  assert.match(html, /Source scope/);
  assert.match(html, /name="sourceRoots" type="text" value="apps\/payments"/);
  assert.match(html, /name="sharedRoots" type="text" value="libs\/contracts"/);
  assert.match(html, /Save source scope/);
  assert.match(html, /singularity-flow wm brief --phase PHASE/);
  assert.doesNotMatch(html,
    /data-action="(?:build|rebuild)-world-model"|data-open-world-model-ref|World Model Explorer|Grounding policy|Registered v4|System architecture|name="views"/,
    'the registered World Model, its explorer, CALM section and build actions are gone');
  assert.match(CONFIGURATION_CENTER_SCRIPT,
    /type: 'save-world-model', sourceRoots: csv\(data\.get\('sourceRoots'\)\), sharedRoots: csv\(data\.get\('sharedRoots'\)\)/);
  assert.doesNotMatch(CONFIGURATION_CENTER_SCRIPT, /open-world-model-ref|registeredWorldModel/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /if \(savingForm\) return/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /configuration-save-busy/);
  const extension = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');
  assert.match(extension,
    /message\.action === 'repository-brief'\) await vscode\.commands\.executeCommand\('singularityFlow\.openRepositoryKnowledge'\)/);
  assert.match(extension, /'singularityFlow\.configureWorldModel': \(\) => openConfigurationCenter\('world-model'\)/);
  assert.doesNotMatch(extension, /message\.type === 'open-world-model-ref'/);
  const manifestText = await readFile(path.join(root, 'apps', 'vscode', 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.contributes.commands.find((entry) => entry.command === 'singularityFlow.configureWorldModel')?.title,
    'Singularity Flow: World Model Settings');
  for (const removed of ['buildWorldModel', 'rebuildWorldModel', 'migrateWorldModelViews']) {
    assert.doesNotMatch(manifestText, new RegExp(`singularityFlow\\.${removed}\\b`), removed);
    assert.doesNotMatch(extension, new RegExp(`'singularityFlow\\.${removed}'`), removed);
  }
  assert.doesNotMatch(manifestText, /singularityFlow\.registeredWorldModel/, 'no palette clause reads the removed context key');
  const panel = await readFile(source('configuration-center.ts'), 'utf8');
  assert.doesNotMatch(panel, /open-world-model-ref|DEFAULT_WORLD_MODEL_SLICE_LEASE_MS|'worldModel'/,
    'the tab holds no World Model slice lease');
});

test('the World Model navigation item is the only World Model entry', () => {
  const html = configurationCenterHtml(configurationCenterView(snapshot, { name: 'Ashok', role: 'architect' }),
    'overview', null, null, null, []);
  assert.match(html, /data-tab="world-model"/);
  assert.doesNotMatch(html, /Rebuild capability World Model/);
});

test('configuration center reports staged checkout edits awaiting publication', () => {
  const staged = {
    ...snapshot,
    repository: { configurationChanges: ['singularity/workflow.yml'] }
  };
  const view = configurationCenterView(staged, { name: 'Ashok', role: 'architect' });
  const html = configurationCenterHtml(view, 'world-model', null, null, null, []);
  assert.match(html, /1 local configuration change awaiting publication/);
  assert.match(html, /Saving writes a validated local draft; review and publish it before it takes effect/);
});

test('configuration center reloads a valid candidate', () => {
  const candidate = {
    ...snapshot,
    definition: {
      ...snapshot.definition,
      worldModel: { sourceRoots: ['apps/payments', 'apps/checkout'], sharedRoots: [] }
    },
    configurationSource: {
      editor: 'candidate',
      effective: {
        kind: 'approved-configuration-ref', ref: 'refs/remotes/origin/sflow/config',
        commit: 'a'.repeat(40), sha256: 'b'.repeat(64)
      },
      candidate: {
        status: 'valid', error: null, changes: ['singularity/workflow.yml'],
        sha256: 'c'.repeat(64)
      }
    },
    repository: { configurationChanges: ['singularity/workflow.yml'] }
  };
  const view = configurationCenterView(candidate, { name: 'Ashok', role: 'architect' });
  assert.deepEqual(view.worldModel.sourceRoots, ['apps/payments', 'apps/checkout']);
  assert.equal(view.configurationState.editor, 'candidate');
  const html = configurationCenterHtml(view, 'world-model', null, null, null, []);
  assert.match(html, /Validated local configuration candidate/);
  assert.match(html, /Saving creates a review proposal from the exact approved authority/);
});

test('configuration center exposes an invalid candidate and keeps approved fields fail closed', () => {
  const invalid = {
    ...snapshot,
    configurationSource: {
      editor: 'effective',
      effective: {
        kind: 'approved-configuration-ref', ref: 'refs/remotes/origin/sflow/config',
        commit: 'a'.repeat(40), sha256: 'b'.repeat(64)
      },
      candidate: {
        status: 'invalid', error: 'Workflow configuration cannot be parsed at line 7.',
        changes: ['singularity/workflow.yml'], sha256: 'c'.repeat(64)
      }
    }
  };
  const view = configurationCenterView(invalid, { name: 'Ashok', role: 'architect' });
  assert.deepEqual(view.worldModel, { sourceRoots: ['apps/payments'], sharedRoots: ['libs/contracts'] });
  const html = configurationCenterHtml(view, 'world-model', null, null, null, []);
  assert.match(html, /Local configuration candidate was not loaded/);
  assert.match(html, /continues to show approved effective configuration/);
  assert.match(html, /Workflow configuration cannot be parsed at line 7/);
});

test('world-model save rejects malformed retained-webview payloads without dereferencing them', () => {
  const incomplete = ['Source scope settings are incomplete. Reload Configuration Center and try again.'];
  assert.deepEqual(validateWorldModelDraftShape(null), incomplete);
  assert.deepEqual(validateWorldModelDraftShape({ sourceRoots: ['src'] }), incomplete);
  assert.deepEqual(validateWorldModelDraftShape({ sourceRoots: 'src', sharedRoots: [] }), incomplete);
  assert.deepEqual(validateWorldModelDraftShape({ sourceRoots: [1], sharedRoots: [] }), incomplete);
  assert.deepEqual(validateWorldModelDraft(null), incomplete);
  assert.throws(
    () => updateWorldModelYaml('version: 2\nworldModel: {}\n', { sourceRoots: null }),
    /settings are incomplete/i
  );
});

test('configuration center serializes every configuration mutation through one host gate', async () => {
  const host = await readFile(source('configuration-center.ts'), 'utf8');
  assert.match(host,
    /\['save-profile', 'add-current-identity', 'save-authority', 'save-mcp', 'save-auto', 'save-world-model', 'save-test-setup'\]/);
  assert.match(host, /\['delete-authority', 'delete-mcp'\]/);
  assert.match(host, /if \(mutation && this\.saving\)/);
  assert.match(host, /try \{ await this\.receiveReady\(message\); \}\s*finally \{[\s\S]{0,300}this\.saving = false;[\s\S]{0,300}this\.storeChanged\(\);/);
  assert.doesNotMatch(host, /private save[\s\S]{0,300}this\.saving = true/,
    'the mutex must cover the whole mutation, not only the eventual CLI write');
});

test('configuration refresh preserves dirty forms and detects repository conflicts', () => {
  const rendered = { definitionText: 'workflow-a', portfolioText: 'portfolio-a' };
  assert.equal(configurationRefreshDecision(false, rendered, rendered), 'render');
  assert.equal(configurationRefreshDecision(true, rendered, rendered), 'hold');
  assert.equal(configurationRefreshDecision(true, rendered, { ...rendered, definitionText: 'workflow-b' }), 'conflict');
  assert.equal(configurationRefreshDecision(true, rendered, { ...rendered, portfolioText: 'portfolio-b' }), 'conflict');
});

test('configuration saves bind CAS to the authority they actually mutate', () => {
  const approvedWorkflow = 'approved workflow\n';
  const approvedPortfolio = 'approved portfolio\n';
  const source = {
    editor: 'effective',
    effective: {
      kind: 'approved-configuration-ref', ref: 'refs/remotes/origin/sflow/config',
      commit: 'a'.repeat(40), sha256: '1'.repeat(64),
      remoteFingerprint: '3'.repeat(64), sourceCommit: 'a'.repeat(40),
      files: {
        'singularity/workflow.yml': '1'.repeat(64),
        'singularity/portfolio.yml': '2'.repeat(64)
      },
      worldModelFormat: 'registered-v4'
    },
    candidate: null
  };
  assert.deepEqual(configurationSavePlan(
    source, 'singularity/workflow.yml', approvedWorkflow
  ), {
    writable: true, proposal: true, expectedSha256: '1'.repeat(64),
    expectedAuthorityKind: 'approved-configuration-ref', expectedAuthorityCommit: 'a'.repeat(40),
    expectedAuthorityRemoteFingerprint: '3'.repeat(64), expectedAuthoritySourceCommit: 'a'.repeat(40)
  });
  assert.deepEqual(configurationSavePlan(
    source, 'singularity/portfolio.yml', approvedPortfolio
  ), {
    writable: true, proposal: true, expectedSha256: '2'.repeat(64),
    expectedAuthorityKind: 'approved-configuration-ref', expectedAuthorityCommit: 'a'.repeat(40),
    expectedAuthorityRemoteFingerprint: '3'.repeat(64), expectedAuthoritySourceCommit: 'a'.repeat(40)
  });

  const local = {
    ...source,
    effective: { ...source.effective, kind: 'working-tree' }
  };
  assert.deepEqual(configurationSavePlan(
    local, 'singularity/workflow.yml', approvedWorkflow
  ), {
    writable: true, proposal: false,
    expectedSha256: '1539ba452e5de3cde6a5c79eea50871ce404c74f73a920021acbe8d7c23b2edc'
  });

  const mirror = configurationSavePlan({
    ...source,
    effective: { ...source.effective, kind: 'verified-state-mirror', commit: 'b'.repeat(40) }
  }, 'singularity/workflow.yml', approvedWorkflow);
  assert.equal(mirror.writable, false);
  assert.equal(mirror.proposal, false);
  assert.match(mirror.blockedReason, /Restore or reinitialize sflow\/config/);
  assert.throws(() => configurationSavePlanCliArgs(mirror), /readable only from the verified state recovery mirror/);

  const argv = configurationSavePlanCliArgs(configurationSavePlan(
    source, 'singularity/workflow.yml', approvedWorkflow
  ));
  assert.deepEqual(argv, [
    '--expected-sha256', '1'.repeat(64),
    '--expected-authority-kind', 'approved-configuration-ref',
    '--expected-authority-commit', 'a'.repeat(40),
    '--expected-authority-remote-fingerprint', '3'.repeat(64),
    '--expected-authority-source-commit', 'a'.repeat(40),
    '--propose', '--json'
  ]);
});

test('configuration center reports dirty edits and offers an explicit conflict decision', () => {
  const view = configurationCenterView(snapshot, { name: 'Ashok', role: 'architect' });
  const html = configurationCenterHtml(view, 'world-model', null, null, null, []);
  assert.match(html, /configuration-runtime-message/);
  assert.match(html, /Reload newer configuration/);
  assert.match(html, /Keep editing/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /type: 'form-dirty'/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /configuration-repository-changed/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /configuration-save-error/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /event\.data\.conflict === true/);
});

test('configuration center reloads the store and routes external saves through proposals', async () => {
  const panel = await readFile(source('configuration-center.ts'), 'utf8');
  const extension = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');
  assert.match(panel, /reload-dirty[\s\S]{0,220}action: 'refresh'/,
    'Reload must fetch a new snapshot rather than repaint cached bytes');
  assert.match(extension, /configurationSavePlanCliArgs\(message\)/,
    'external authority saves must carry destination and authority CAS through the governed proposal route');
  assert.match(extension, /application checkout was not changed/);
  assert.match(extension, /store\.current\.error/,
    'refresh must inspect the store result because WorkspaceStore.refresh resolves after failures');
  assert.match(panel, /reloadInFlight/,
    'repository change notifications must be suppressed while an explicit reload is settling');
  assert.match(panel, /configuration-proposal-pending/,
    'successful proposals must preserve and freeze the submitted form rather than repaint approved bytes');
  assert.match(panel, /authorityMutation && this\.pendingProposal/,
    'a retained panel must refuse a second write while the first proposal is unmerged');
  assert.match(panel, /restorePendingProposal/,
    'opening or revealing a panel must restore durable pending proposal state');
  assert.match(extension, /workflow', 'proposals', '--all', '--json'/,
    'proposal reconciliation must inspect exact remote proposal ancestry');
  assert.match(panel, /type: 'proposal-status'/,
    'a deleted review branch must be resolved from exact proposal-commit ancestry');
  assert.match(extension, /'workflow', 'proposal-status'/,
    'the host must route deleted-branch merge proof through the governed CLI');
});

test('configuration save disposition and pending proposal follow actual authority state', () => {
  assert.deepEqual(configurationSaveDisposition(JSON.stringify({
    reviewRequired: true,
    branch: 'sflow/config-edit/example',
    baseBranch: 'sflow/config',
    commit: 'e'.repeat(40),
    files: ['singularity/workflow.yml']
  }), true), {
    kind: 'proposal',
    branch: 'sflow/config-edit/example',
    baseBranch: 'sflow/config',
    proposalCommit: 'e'.repeat(40),
    files: ['singularity/workflow.yml']
  });
  assert.deepEqual(configurationSaveDisposition(JSON.stringify({
    reviewRequired: false, authorityMode: 'local'
  }), true), { kind: 'local' });
  assert.deepEqual(configurationSaveDisposition(JSON.stringify({ reviewRequired: false }), true), {
    kind: 'unchanged'
  });
  assert.throws(() => configurationSaveDisposition(JSON.stringify({
    reviewRequired: true, branch: 'sflow/config-change/workflow/save-file-example'
  }), true), /exact branch and commit/,
  'a malformed proposal response must fail closed instead of looking unchanged');

  const pending = {
    branch: 'sflow/config-edit/example', baseBranch: 'sflow/config',
    proposalCommit: 'e'.repeat(40)
  };
  assert.equal(configurationPendingProposalStatus(pending, []), 'pending');
  assert.equal(configurationPendingProposalStatus(pending, [{
    ...pending, targetBranch: 'sflow/config', merged: false
  }]), 'pending', 'an unrelated authority advance must not clear an unmerged proposal');
  assert.equal(configurationPendingProposalStatus(pending, [{
    ...pending, targetBranch: 'sflow/config', merged: true
  }]), 'merged');

  const restored = pendingConfigurationProposal([{
    branch: `sflow/config-change/workflow/save-file-workflow-${'f'.repeat(12)}-${'a'.repeat(8)}`,
    proposalCommit: 'f'.repeat(40), targetBranch: 'sflow/config', merged: false
  }]);
  assert.equal(restored?.proposalCommit, 'f'.repeat(40),
    'an unmerged save-file proposal must restore the panel guard after reopen');
});

test('configuration center marks an unmerged proposal read-only', () => {
  const view = configurationCenterView(snapshot, { name: 'Ashok', role: 'architect' });
  const html = configurationCenterHtml(view, 'world-model', null, null, null, [], {
    branch: 'sflow/config-edit/example', baseBranch: 'sflow/config'
  });
  assert.match(html, /Configuration proposal pending review/);
  assert.match(html, /sflow\/config-edit\/example/);
  assert.match(html, /fieldset disabled/);
  assert.match(html, /configuration-pending-refresh/);
  assert.match(html, /configuration-resume-approved/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /configuration-proposal-pending/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /form input, form select, form textarea, form button/);
  assert.match(CONFIGURATION_CENTER_SCRIPT, /resume-approved-baseline/);
});

test('source scope editor writes only the roots and preserves comments and every other World Model setting', () => {
  const input = `version: 2\n# keep this policy note\nworldModel:\n  sourceRoots: [old]\n  context:\n    memoize: true\n  injection:\n    rules:\n      - when: { phase: intake }\n        include: [briefs/business.md]\n`;
  const output = updateWorldModelYaml(input, { sourceRoots: ['apps/payments'], sharedRoots: ['libs/contracts'] });
  assert.match(output, /# keep this policy note/);
  const parsed = YAML.parse(output);
  assert.deepEqual(parsed.worldModel.sourceRoots, ['apps/payments']);
  assert.deepEqual(parsed.worldModel.sharedRoots, ['libs/contracts']);
  assert.equal(parsed.worldModel.context.memoize, true);
  assert.equal(parsed.worldModel.injection.rules[0].when.phase, 'intake');
  assert.deepEqual(Object.keys(parsed.worldModel).sort(), ['context', 'injection', 'sharedRoots', 'sourceRoots']);
  // An empty list is a deliberate whole-repository choice, so it is written rather than dropped.
  const whole = YAML.parse(updateWorldModelYaml('version: 2\nworldModel: {}\n', { sourceRoots: [], sharedRoots: [] }));
  assert.deepEqual(whole.worldModel, { sourceRoots: [], sharedRoots: [] });
});

test('source scope editor rejects unsafe, duplicate and glob roots', () => {
  assert.deepEqual(validateWorldModelDraft({ sourceRoots: ['src', 'apps/payments'], sharedRoots: ['packages/contracts'] }), []);
  assert.deepEqual(validateWorldModelDraft({ sourceRoots: [], sharedRoots: [] }), []);
  for (const bad of ['../outside', '/etc', 'C:\\repo', 'src\\main', 'src/*', '.', ' ']) {
    assert.match(validateWorldModelDraft({ sourceRoots: [bad], sharedRoots: [] }).join(' '),
      /Source roots entry .* must be a repository-relative directory without '\.\.' or glob characters/, bad);
  }
  assert.match(validateWorldModelDraft({ sourceRoots: [], sharedRoots: ['libs', 'libs'] }).join(' '),
    /Shared roots must not contain duplicates/);
  assert.throws(() => updateWorldModelYaml('version: 2\n', { sourceRoots: ['../outside'], sharedRoots: [] }),
    /repository-relative directory/);
});

test('MCP editor changes only the governed server registry and preserves YAML comments', () => {
  const input = `version: 2\n# keep this policy note\ngit:\n  publish: required\nmcpServers:\n  old:\n    label: Old\n    hostReference: old\n`;
  const output = updateMcpYaml(input, {
    previousId: 'old', id: 'playwright', label: 'Playwright', hostReference: 'playwright',
    agents: ['qa'], phases: ['verification'], tools: ['browser_snapshot'], required: true,
    approval: 'confirm', captureToolCalls: true, captureResults: true
  });
  assert.match(output, /# keep this policy note/);
  const parsed = YAML.parse(output);
  assert.equal(parsed.git.publish, 'required');
  assert.equal(parsed.mcpServers.old, undefined);
  assert.deepEqual(parsed.mcpServers.playwright.agents, ['qa']);
  assert.equal(parsed.mcpServers.playwright.evidence.captureResults, true);
});

test('approval editor preserves unrelated workflow content and normalizes identities', () => {
  const input = `version: 2\nphases:\n  intake:\n    label: Intake\napprovalAuthorities: {}\n`;
  const output = updateAuthorityYaml(input, {
    id: 'product-approvers', previousId: '', label: 'Product approvers', scope: 'story',
    allowAnyGitIdentity: false,
    members: [{ name: 'Pat Owner', email: 'PAT@EXAMPLE.COM', githubLogin: 'pat-owner' }]
  });
  const parsed = YAML.parse(output);
  assert.equal(parsed.phases.intake.label, 'Intake');
  assert.deepEqual(parsed.approvalAuthorities['product-approvers'].members, [{
    name: 'Pat Owner', email: 'pat@example.com', githubLogin: 'pat-owner'
  }]);
});

test('Initiative approval editor keeps advanced fields and writes only supported identity data', () => {
  const input = `version: 1\napprovalAuthorities:\n  owners:\n    githubTeams: [\"@example/owners\"]\n    members: []\n`;
  const output = updateAuthorityYaml(input, {
    id: 'owners', previousId: 'owners', label: 'Initiative owners', scope: 'initiative',
    allowAnyGitIdentity: false,
    members: [{ name: 'Pat Owner', email: 'PAT@EXAMPLE.COM', githubLogin: 'not-an-initiative-identity' }]
  });
  const parsed = YAML.parse(output);
  assert.equal(parsed.approvalAuthorities.owners.label, 'Initiative owners');
  assert.deepEqual(parsed.approvalAuthorities.owners.githubTeams, ['@example/owners']);
  assert.deepEqual(parsed.approvalAuthorities.owners.members, [{ name: 'Pat Owner', email: 'pat@example.com' }]);
});

test('configuration drafts reject ambiguous approval identities and unsafe MCP identifiers', () => {
  assert.deepEqual(validateAuthorityDraft({
    id: 'owners', label: 'Owners', scope: 'initiative', allowAnyGitIdentity: false, members: []
  }), ['Initiative authorities require at least one named Git identity.']);
  assert.deepEqual(validateAuthorityDraft({
    id: 'owners', label: 'Owners', scope: 'initiative', allowAnyGitIdentity: true, members: []
  }), ['Initiative authorities require at least one named Git identity.']);
  assert.deepEqual(validateAuthorityDraft({
    id: 'owners', label: 'Owners', scope: 'story', allowAnyGitIdentity: false, members: []
  }), ['Add a member or allow any configured Git identity.']);
  assert.deepEqual(validateAuthorityDraft({
    id: 'owners', label: 'Owners', scope: 'story', allowAnyGitIdentity: false,
    members: [{ name: 'GitHub reviewer', email: '', githubLogin: 'reviewer' }]
  }), []);
  assert.match(validateMcpDraft({
    id: 'Bad ID', label: '', hostReference: '../host', agents: [], phases: [], tools: ['a', 'a'],
    required: false, approval: 'confirm', captureToolCalls: true, captureResults: false
  }).join(' '), /lower-case kebab-case.*display label.*Host reference.*duplicates/);
  assert.match(validateMcpDraft({
    id: 'host.namespace', label: 'Host', hostReference: 'host.namespace', agents: [], phases: [], tools: [],
    required: false, approval: 'confirm', captureToolCalls: true, captureResults: false
  }).join(' '), /Server ID must be lower-case kebab-case.*Host reference must be lower-case kebab-case/);
  assert.match(validateAuthorityDraft({
    id: 'review.group', label: 'Review group', scope: 'story', allowAnyGitIdentity: true, members: []
  }).join(' '), /Authority ID must be lower-case kebab-case/);
});

/**
 * The Configuration Center is now the only route to configuration, so the tests that matter most are
 * the ones that catch a surface being *shown* without being *reachable* — the defect that had already
 * shipped here: the Model routing tab rendered a strip button whose name the panel's hand-written
 * allowlist rejected, so clicking it did nothing.
 */
const { CONFIGURATION_TABS } = await import(source('configuration-center-model.ts'));
const centerPanelSource = await readFile(source('configuration-center.ts'), 'utf8');
const extensionSource = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');

test('every rendered tab is one the panel will accept', () => {
  const html = configurationCenterHtml(configurationCenterView(snapshot), 'overview', null, null, null, []);
  const rendered = [...html.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(rendered.length >= CONFIGURATION_TABS.length, 'the strip should render every tab');
  for (const tab of rendered) {
    assert.ok(CONFIGURATION_TABS.includes(tab), `the strip renders '${tab}' but it is not a known tab`);
  }
  // And the allowlist is the shared list rather than a second copy that can drift behind it.
  assert.match(centerPanelSource, /CONFIGURATION_TABS as readonly string\[\]\)\.includes/);
  assert.doesNotMatch(centerPanelSource, /\['overview', 'world-model'[^\]]*\]\.includes\(String\(message\.tab\)\)/);
});



/**
 * What the Configuration sidebar used to guarantee.
 *
 * The sidebar's file tree, world-model status, publish path, ledger line and model-independence
 * summary were deleted when Configuration collapsed to a single entry. These are the behaviours
 * those tests protected, asserted against the surface that owns them now. They are ported rather
 * than dropped because the risk of a migration like this is not that a panel looks wrong — it is
 * that something silently stops being shown anywhere.
 */
const centerHtml = (snapshotValue, tab = 'overview') =>
  configurationCenterHtml(configurationCenterView(snapshotValue), tab, null, null, null, []);

test('templates are edited in Workflow Studio and instructions in the Agent Designer, also when the definition is refused', () => {
  // Configuration is how a repository is repaired, so the tools that edit its files stay reachable
  // when the definition is invalid. The Center no longer keeps a read-only list of them.
  for (const configurationValid of [true, false]) {
    const view = configurationCenterView({ ...snapshot, configurationValid });
    const html = configurationCenterHtml(view, 'overview', null, null, null, []);
    assert.match(html, /data-action="workflow-studio"/, 'workflows, steps and templates open in Workflow Studio');
    assert.match(html, /data-action="open-instruction-designer"/, 'agents, prompts and skills open in the Agent Designer');
    assert.doesNotMatch(html, /data-tab="templates"|Templates &amp; instructions|Workflows &amp; artifacts|data-action="open-designer"/);
    assert.equal(Object.hasOwn(view, 'fileSets'), false);
  }
  assert.ok(extensionSource.includes("message.action === 'workflow') await vscode.commands.executeCommand('singularityFlow.openWorkflowStudio')"),
    'a stale link to the old Workflows & artifacts entry opens Workflow Studio');
});

test('validated configuration changes have a visible review and publish path', () => {
  const changed = {
    ...snapshot,
    repository: {
      branch: 'sflow/config-change/editor/review',
      configurationChanges: ['singularity/workflow.yml', 'singularity/templates/feature/design.md'],
      unrelatedChanges: [], publishReady: true
    }
  };
  const html = centerHtml(changed);
  assert.match(html, /2 files changed on sflow\/config-change\/editor\/review/);
  assert.match(html, /data-action="publish-configuration"/);
  // Offered only where there is something to publish — never as a permanent card.
  assert.doesNotMatch(centerHtml(snapshot), /data-action="publish-configuration"/);

  // Publishing commits one scoped transaction, so unrelated working-tree changes block it — and the
  // publish button must not be offered while they do.
  const blocked = centerHtml({
    ...changed,
    repository: { ...changed.repository, unrelatedChanges: ['src/index.ts'], publishReady: false }
  });
  assert.match(blocked, /Separate these unrelated changes before publishing: src\/index\.ts/);
  assert.doesNotMatch(blocked, /data-action="publish-configuration"/);
});

test('the Center says whether workflow progress is recorded, and where', () => {
  const view = configurationCenterView(snapshot);
  assert.equal(view.ledger.summary, 'no state branch');
  assert.match(centerHtml(snapshot), /No append-only workflow ledger/);

  const on = { ...snapshot, definition: { ...snapshot.definition, ledger: { enabled: true, branch: 'state' } } };
  assert.equal(configurationCenterView(on).ledger.summary, 'state on state');
  assert.match(centerHtml(on), /orphan branch &#39;state&#39;/);
});

test('model independence is reported with whatever is blocking it', () => {
  const html = centerHtml({
    ...snapshot,
    modelFreedom: {
      schemaVersion: 1, mode: 'auto', modeSource: 'default', modelFreeLifecycleReady: false,
      blockers: ['verification requires a model'], warnings: ['intake prefers one'],
      summary: { status: 'partial', modelFreeLifecycleReady: false }
    }
  });
  assert.match(html, /Lifecycle status: <strong>partial<\/strong>/);
  assert.match(html, /verification requires a model/);
  assert.match(html, /intake prefers one/);
});

test('every tool the Configuration sidebar used to open is reachable from the Center', () => {
  const html = centerHtml(snapshot);
  for (const action of ['reset-jira', 'workflow-studio', 'open-instruction-designer',
    'open-specification-trace', 'open-flow-impact', 'open-copilot', 'open-prompt-audit',
    'inspect-composition-cache', 'check-ledger-deployment', 'open-impact-file']) {
    // Rendered *and* handled: a card whose action name the host does not answer is the defect this
    // whole migration exists to avoid.
    assert.ok(html.includes(`data-action="${action}"`), `${action} should be offered`);
    assert.ok(extensionSource.includes(`message.action === '${action}'`), `${action} should be handled`);
  }
});

test('the Center renders whether or not an Epic is checked out', () => {
  const bare = configurationCenterHtml(
    configurationCenterView({ initiative: null, initiatives: [], workItems: [] }), 'overview', null, null, null, []);
  assert.match(bare, /Configuration Center/);
  assert.match(bare, /data-action="workflow-studio"/);
});

/**
 * The sidebar header is the logo's most-seen placement, and it was the last one still showing the
 * placeholder: a generic workflow glyph reversed out of a green tile, which is what the screenshot
 * of the shipped extension shows.
 */
test('the sidebar header shows the brand mark, not the old tile', async () => {
  // sidebar-page.ts renders the sidebar's markup and style; sidebar.ts only assembles the document.
  // Both are read, so the tile cannot come back through either.
  const sidebar = (await Promise.all(['sidebar.ts', 'sidebar-page.ts'].map((name) => readFile(source(name), 'utf8')))).join('\n');
  assert.match(sidebar, /<header class="brand">\$\{brandSymbol\(\d+\)\}/, 'the header does not render the brand mark');
  assert.doesNotMatch(sidebar, /brand-mark[^\n]*linear-gradient\(145deg/, 'the placeholder tile is still styled');
  assert.doesNotMatch(sidebar, /class="brand-mark">\$\{icon\('workflow'/, 'the header still reverses a generic glyph out of a tile');

  const { brandSymbol } = await import(source('webview.ts'));
  const svg = brandSymbol(30);
  // The brand green, matching media/brand.svg rather than an approximation.
  for (const stop of ['#419458', '#5CAE5F', '#83CC6D']) assert.ok(svg.includes(stop), `${stop} is missing`);
  assert.match(svg, /aria-label="Singularity Flow"/);

  /**
   * Two marks in one document must not share a gradient id: SVG resolves `url(#id)` against the
   * first definition in the document, so the second would silently paint itself with the first's
   * gradient — or with nothing, if the first is ever removed.
   */
  assert.notEqual(brandSymbol(20, 'one').match(/id="([^"]+)"/)[1], brandSymbol(20, 'two').match(/id="([^"]+)"/)[1]);
  assert.equal((brandSymbol(20, 'one').match(/url\(#one\)/g) ?? []).length, 2);
});

/**
 * VS Code renders a view's title as `<container>: <view>`, so a view named after its own container
 * reads "SINGULARITY FLOW: SINGULARITY FLOW" — the product saying its name twice in the one place
 * that is always on screen.
 */
test('the sidebar view is not named after its own container', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'apps', 'vscode', 'package.json'), 'utf8'));
  const [container] = manifest.contributes.viewsContainers.activitybar;
  const views = manifest.contributes.views[container.id];
  const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase('en-US');
  for (const view of views) {
    assert.notEqual(normalize(view.name), normalize(container.title),
      `view '${view.id}' repeats the container title, which renders as "${container.title}: ${view.name}"`);
  }
  // And the one view that actually renders is the webview the sidebar provider owns.
  const visible = views.filter((view) => !view.when);
  assert.deepEqual(visible.map((view) => view.id), ['singularityFlow.navigation']);
  assert.equal(visible[0].name, 'Navigator');
});
