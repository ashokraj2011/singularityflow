import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Suite routing: this test imports apps/vscode TypeScript sources directly.
const source = (name) => path.join(packageRoot, 'apps', 'vscode', 'src', name);

const {
  TEAM_ONBOARDING_MAX_SELECTED,
  TEAM_ONBOARDING_STATUS_LABELS,
  TEAM_ONBOARDING_STEPS,
  beginTeamRepositoryInspection,
  changeRepositoryCapabilityId,
  changeRepositoryFriendlyName,
  changeTeamName,
  changeTeamRepositoryDecision,
  changeTeamRepositorySelection,
  classifyTeamRepositoryInspection,
  effectiveTeamRepositoryStatus,
  eligibleTeamRepositories,
  emptyTeamOnboardingView,
  finishTeamRepositoryInspection,
  mapTeamCommand,
  mapTeamRequest,
  recordTeamRepositoryOutcome,
  repositoryFriendlyName,
  selectedTeamRepositories,
  teamOnboardingCatalogKey,
  teamOnboardingId,
  teamOnboardingProblems,
  teamOnboardingProposalPreview,
  teamOnboardingRepository
} = await import(source('views/team-onboarding-model.ts'));
const {
  TEAM_ONBOARDING_MESSAGE_TYPES,
  TEAM_ONBOARDING_SCRIPT,
  teamOnboardingHtml
} = await import(source('views/team-onboarding-page.ts'));

const authority = {
  id: 'authority:platform',
  label: 'Platform capability map',
  leadUrl: 'https://git.example.com/platform.git',
  detail: 'sflow/config'
};

function repository(index, owner = 'acme') {
  return teamOnboardingRepository({
    id: `catalog-row:${index}`,
    nameWithOwner: `${owner}/service-${index}-api`,
    locator: `https://git.example.com/${owner}/service-${index}-api.git`,
    visibility: index % 2 ? 'private' : 'internal',
    access: 'maintain'
  });
}

function selectedView(count = 2) {
  let view = emptyTeamOnboardingView([authority],
    Array.from({ length: count }, (_, index) => repository(index + 1)));
  view = changeTeamName(view, 'Payments Platform');
  for (const row of view.repositories) {
    view = changeTeamRepositorySelection(view, row.id, true).view;
  }
  return view;
}

test('TON-v1 exposes the three exact journey steps and five exact row labels', () => {
  assert.deepEqual(TEAM_ONBOARDING_STEPS.map((step) => step.label), [
    'Team and repositories', 'Check and onboard', 'Workspaces'
  ]);
  assert.deepEqual(Object.values(TEAM_ONBOARDING_STATUS_LABELS), [
    'Not checked yet', 'Will add', 'Will link', 'Needs a choice', 'Left out'
  ]);
  assert.equal(TEAM_ONBOARDING_MAX_SELECTED, 20);
});

test('friendly names and editable IDs start from deterministic repository suggestions', () => {
  assert.equal(repositoryFriendlyName('commerce/checkout-api.git'), 'Checkout API');
  assert.equal(teamOnboardingId('Crème & Checkout API'), 'creme-checkout-api');

  let view = emptyTeamOnboardingView([authority], [repository(1)]);
  view = changeTeamName(view, 'Checkout Crew');
  assert.equal(view.teamId, 'checkout-crew');
  view = changeRepositoryFriendlyName(view, view.repositories[0].id, 'Public Gateway API');
  assert.equal(view.repositories[0].capabilityId, 'public-gateway-api');
  view = changeRepositoryCapabilityId(view, view.repositories[0].id, 'gateway-edge');
  view = changeRepositoryFriendlyName(view, view.repositories[0].id, 'Gateway Edge API');
  assert.equal(view.repositories[0].capabilityId, 'gateway-edge', 'an explicitly edited ID is stable');
});

test('catalog identity keeps the same owner and repository distinct across Git hosts', () => {
  const github = teamOnboardingCatalogKey({
    providerInstanceId: 'github:github.com', nameWithOwner: 'acme/payments'
  });
  const enterprise = teamOnboardingCatalogKey({
    providerInstanceId: 'github:ghe.company.com', nameWithOwner: 'acme/payments'
  });
  assert.notEqual(github, enterprise);
  assert.equal(github, teamOnboardingCatalogKey({
    providerInstanceId: 'GITHUB:GITHUB.COM', nameWithOwner: 'ACME/PAYMENTS'
  }), 'host and repository casing cannot fork one provider identity');
});

test('selection resolves opaque host row IDs and refuses a twenty-first repository', () => {
  let view = emptyTeamOnboardingView([authority],
    Array.from({ length: 21 }, (_, index) => repository(index + 1)));
  for (const row of view.repositories.slice(0, 20)) {
    const changed = changeTeamRepositorySelection(view, row.id, true);
    assert.equal(changed.problem, null);
    view = changed.view;
  }
  const overflow = changeTeamRepositorySelection(view, view.repositories[20].id, true);
  assert.match(overflow.problem, /at most 20/);
  assert.equal(selectedTeamRepositories(overflow.view).length, 20);

  const forged = changeTeamRepositorySelection(view, 'https://evil.invalid/repository.git', true);
  assert.match(forged.problem, /no longer in the current catalog/);
  assert.equal(forged.view, view);
});

test('only selected rows enter the bounded inspection queue', () => {
  let view = emptyTeamOnboardingView([authority], [repository(1), repository(2), repository(3)]);
  view = changeTeamRepositorySelection(view, view.repositories[0].id, true).view;
  view = changeTeamRepositorySelection(view, view.repositories[2].id, true).view;
  view = beginTeamRepositoryInspection(view);
  assert.equal(view.inspection.total, 2);
  assert.equal(view.inspection.running, true);
  assert.equal(view.step, 'check-and-onboard');
  assert.deepEqual(view.repositories.map((row) => row.selected), [true, false, true]);
});

test('cancelling an inspection clears the transient checking state so the row is recoverable', () => {
  let view = beginTeamRepositoryInspection(selectedView(1));
  view = { ...view, repositories: view.repositories.map((row) => ({ ...row, inspecting: true })) };
  view = finishTeamRepositoryInspection(view, { cancelled: true });
  assert.equal(view.inspection.running, false);
  assert.equal(view.inspection.cancelled, true);
  assert.equal(view.repositories[0].inspecting, false);
  assert.equal(view.repositories[0].status, 'not-checked');
});

test('raw inspection classification is fail-closed and never treats incomplete evidence as absence', () => {
  const complete = { completeness: 'complete', proposalCoverage: 'complete' };
  assert.deepEqual(classifyTeamRepositoryInspection({
    ...complete, status: 'not-onboarded', matches: [], pendingMatches: []
  }, { authorityLeadUrl: authority.leadUrl, teamId: 'payments' }).status, 'will-add');

  const link = classifyTeamRepositoryInspection({
    ...complete,
    status: 'already-mapped',
    matches: [{ lead: authority.leadUrl, capabilities: ['checkout-api'] }],
    organisations: [{
      lead: authority.leadUrl,
      organisation: {
        capabilities: [{ id: 'checkout-api', name: 'Checkout API', kind: 'delivery', parent: null }]
      }
    }]
  }, { authorityLeadUrl: authority.leadUrl, teamId: 'payments' });
  assert.deepEqual(link, {
    status: 'will-link',
    detail: 'One compatible top-level delivery can be linked explicitly.',
    existingCapabilityId: 'checkout-api',
    existingCapabilityName: 'Checkout API'
  });

  const parented = classifyTeamRepositoryInspection({
    ...complete,
    status: 'already-mapped',
    matches: [{ lead: authority.leadUrl, capabilities: ['checkout-api'] }],
    organisations: [{
      lead: authority.leadUrl,
      organisation: {
        capabilities: [{ id: 'checkout-api', kind: 'delivery', parent: 'retail' }]
      }
    }]
  }, { authorityLeadUrl: authority.leadUrl, teamId: 'payments' });
  assert.equal(parented.status, 'needs-choice');
  assert.match(parented.detail, /already belongs to retail/);

  const nestedWithoutRedundantParent = classifyTeamRepositoryInspection({
    ...complete,
    status: 'already-mapped',
    matches: [{ lead: authority.leadUrl, capabilities: ['checkout-api'] }],
    organisations: [{
      lead: authority.leadUrl,
      organisation: {
        capabilities: [{
          id: 'retail', kind: 'collection',
          children: [{ id: 'checkout-api', kind: 'delivery' }]
        }]
      }
    }]
  }, { authorityLeadUrl: authority.leadUrl, teamId: 'payments' });
  assert.equal(nestedWithoutRedundantParent.status, 'needs-choice');
  assert.match(nestedWithoutRedundantParent.detail, /already belongs to retail/);

  assert.equal(classifyTeamRepositoryInspection({
    status: 'not-onboarded', completeness: 'partial', proposalCoverage: 'complete'
  }, { authorityLeadUrl: authority.leadUrl, teamId: 'payments' }).status, 'needs-choice');
  assert.equal(classifyTeamRepositoryInspection({
    ...complete, status: 'not-onboarded', pendingMatches: [{}]
  }, { authorityLeadUrl: authority.leadUrl, teamId: 'payments' }).status, 'needs-choice');
  assert.equal(classifyTeamRepositoryInspection({
    status: 'unreachable', failures: [{ message: 'Network unavailable' }]
  }, { authorityLeadUrl: authority.leadUrl, teamId: 'payments' }).status, 'left-out');
});

test('eligible and set-aside semantics let good rows proceed around one failure', () => {
  let view = beginTeamRepositoryInspection(selectedView(3));
  view = recordTeamRepositoryOutcome(view, view.repositories[0].id, { status: 'will-add' });
  view = recordTeamRepositoryOutcome(view, view.repositories[1].id, {
    status: 'needs-choice', detail: 'Existing parent needs review.'
  });
  view = recordTeamRepositoryOutcome(view, view.repositories[2].id, {
    status: 'left-out', detail: 'Repository was unreachable.'
  });
  view = { ...view, inspection: { ...view.inspection, running: false } };
  assert.equal(eligibleTeamRepositories(view).length, 1);
  assert.match(teamOnboardingProblems(view).join(' '), /Resolve or set aside/);

  view = changeTeamRepositoryDecision(view, view.repositories[1].id, 'set-aside');
  view = {
    ...view,
    repositories: view.repositories.map((row, index) => index > 0
      ? { ...row, friendlyName: '', capabilityId: '' }
      : row)
  };
  assert.equal(effectiveTeamRepositoryStatus(view.repositories[1]), 'left-out');
  assert.deepEqual(teamOnboardingProblems(view), []);
  assert.equal(teamOnboardingProposalPreview(view).excluded.length, 2);
});

test('proposal preview and map-team transports include eligible adds and links exactly once', () => {
  let view = beginTeamRepositoryInspection(selectedView(3));
  view = { ...view, jiraProject: 'PAY' };
  view = recordTeamRepositoryOutcome(view, view.repositories[0].id, { status: 'will-add' });
  view = recordTeamRepositoryOutcome(view, view.repositories[1].id, {
    status: 'will-link', existingCapabilityId: 'settlement-worker', existingCapabilityName: 'Settlement Worker'
  });
  view = recordTeamRepositoryOutcome(view, view.repositories[2].id, {
    status: 'needs-choice', detail: 'Already belongs to Finance.'
  });
  view = changeTeamRepositoryDecision(view, view.repositories[2].id, 'set-aside');
  view = { ...view, inspection: { ...view.inspection, running: false } };

  const preview = teamOnboardingProposalPreview(view);
  assert.equal(preview.members.length, 1);
  assert.equal(preview.links.length, 1);
  assert.equal(preview.excluded.length, 1);
  assert.deepEqual(preview.defaults, {
    sourceScope: 'whole repository', cloneMode: 'blobless', sparseCone: null, fallback: 'refuse'
  });
  assert.deepEqual(mapTeamRequest(view), {
    teamId: 'payments-platform',
    lead: 'https://git.example.com/platform.git',
    name: 'Payments Platform',
    jiraProject: 'PAY',
    members: [{
      capabilityId: 'service-1-api',
      repositoryUrl: 'https://git.example.com/acme/service-1-api.git',
      name: 'Service 1 API'
    }],
    links: ['settlement-worker']
  });
  assert.deepEqual(mapTeamCommand(view), [
    'capability', 'map-team', 'payments-platform',
    '--lead', 'https://git.example.com/platform.git',
    '--name', 'Payments Platform',
    '--jira-project', 'PAY',
    '--member', 'service-1-api=https://git.example.com/acme/service-1-api.git',
    '--member-name', 'service-1-api=Service 1 API',
    '--link', 'settlement-worker',
    '--json'
  ]);
});

test('map-team argv refuses unsafe host state before it could be logged', () => {
  let view = beginTeamRepositoryInspection(selectedView(1));
  view = recordTeamRepositoryOutcome(view, view.repositories[0].id, { status: 'will-add' });
  view = {
    ...view,
    inspection: { ...view.inspection, running: false },
    repositories: [{ ...view.repositories[0], locator: 'https://user:secret@git.example.com/repo.git' }]
  };
  assert.throws(() => mapTeamCommand(view), /credential-free/);
});

test('a valid twenty-member team can exceed the Windows process command-line ceiling', () => {
  let view = beginTeamRepositoryInspection(selectedView(20));
  view = {
    ...view,
    repositories: view.repositories.map((row, index) => ({
      ...row,
      locator: `https://git.example.com/acme/${'repository-segment-'.repeat(110)}${index}.git`
    }))
  };
  for (const row of view.repositories) {
    view = recordTeamRepositoryOutcome(view, row.id, { status: 'will-add' });
  }
  view = { ...view, inspection: { ...view.inspection, running: false } };

  assert.ok(mapTeamCommand(view).join(' ').length > 32_767,
    'the legacy flag form can exceed CreateProcessW even before executable-path quoting');
  assert.equal(mapTeamRequest(view).members.length, 20,
    'the same valid request remains available to the bounded file transport');
});

test('step one renders the mockup structure accessibly without embedding URLs in controls', () => {
  let view = selectedView(2);
  const html = teamOnboardingHtml(view);
  assert.match(html, /Onboard a team/);
  assert.match(html, /Step 1 of 3/);
  assert.match(html, /class="start-wizard-step current" aria-current="step"/);
  assert.match(html, /Team and repositories/);
  assert.match(html, /Check and onboard/);
  assert.match(html, /Workspaces/);
  assert.match(html, /aria-labelledby="team-onboarding-heading"/);
  assert.match(html, /<caption>Repositories available to select/);
  assert.match(html, /class="artifact-studio"/);
  assert.match(html, /class="document-preview"/);
  assert.match(html, /2\/20/);
  assert.match(html, /Load GitHub\/GHE repositories/,
    'provider disclosure remains an explicit user action when no provider is active');
  assert.doesNotMatch(html, /data-[\w-]+="https?:/i,
    'URLs are display text, never identities sent back by a control');
});

test('step two renders per-row progress, every outcome, set-aside actions and exact preview', () => {
  let view = beginTeamRepositoryInspection(selectedView(4));
  const statuses = [
    { status: 'will-add' },
    { status: 'will-link', existingCapabilityId: 'existing-api', existingCapabilityName: 'Existing API' },
    { status: 'needs-choice', detail: 'Already parented.' },
    { status: 'left-out', detail: 'Unreachable.' }
  ];
  statuses.forEach((outcome, index) => {
    view = recordTeamRepositoryOutcome(view, view.repositories[index].id, outcome);
  });
  view = { ...view, inspection: { ...view.inspection, running: false } };
  const html = teamOnboardingHtml(view);
  assert.match(html, /Step 2 of 3/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /4 of 4 checked/);
  for (const label of Object.values(TEAM_ONBOARDING_STATUS_LABELS).slice(1)) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /data-row-action="resolve"/);
  assert.match(html, /data-row-action="set-aside"/);
  assert.match(html, /Create one review proposal/);
  assert.match(html, /<details class="advanced-settings"><summary>Advanced settings<\/summary>/);
  assert.match(html, /Read-only safe defaults for this team transaction/);
});

test('step three distinguishes exact clone and reuse previews before opening workspace setup', () => {
  const view = {
    ...selectedView(1),
    step: 'workspaces',
    proposal: { status: 'active', message: 'Proposal activated.', branch: null, commit: null },
    workspace: {
      ready: true,
      busy: false,
      capabilities: [{
        id: 'capability-choice:payments', capabilityId: 'payments-platform',
        name: 'Payments Platform', authorityLabel: authority.label, selected: true
      }],
      repositories: [
        { id: 'workspace-repository:api', name: 'payments-api', origin: 'https://git.example.com/payments-api.git', action: 'clone' },
        { id: 'workspace-repository:web', name: 'payments-web', origin: 'https://git.example.com/payments-web.git', action: 'reuse', evidence: '/work/payments-web' }
      ]
    }
  };
  const html = teamOnboardingHtml(view);
  assert.match(html, /Step 3 of 3/);
  assert.match(html, /Will clone/);
  assert.match(html, /Will reuse/);
  assert.match(html, /Continue to workspace setup/);
  assert.match(html, /data-workspace-capability="capability-choice:payments"/);
  assert.doesNotMatch(html, /data-[\w-]+="https?:/i);
});

test('step three never guesses clone or reuse before workspace target preflight', () => {
  const view = {
    ...selectedView(1),
    step: 'workspaces',
    proposal: { status: 'active', message: 'Proposal activated.', branch: null, commit: null },
    workspace: {
      ready: true,
      busy: false,
      capabilities: [{
        id: 'capability-choice:payments', capabilityId: 'payments-platform',
        name: 'Payments Platform', authorityLabel: authority.label, selected: true
      }],
      repositories: [{
        id: 'workspace-repository:api', name: 'payments-api',
        origin: 'https://git.example.com/payments-api.git', action: 'pending',
        evidence: 'The workspace target preflight will prove clone or reuse.'
      }]
    }
  };
  const html = teamOnboardingHtml(view);
  assert.match(html, /Pending preflight/);
  assert.match(html, /await workspace preflight/);
  assert.doesNotMatch(html, /<strong>1<\/strong><span>repositories will clone/);
  assert.doesNotMatch(html, /<strong>1<\/strong><span>checkouts will be reused/);
});

test('the webview contract posts only host-owned identities and never URL-shaped authority fields', () => {
  for (const type of TEAM_ONBOARDING_MESSAGE_TYPES) {
    assert.match(TEAM_ONBOARDING_SCRIPT, new RegExp(`['"]${type}['"]`), `${type} is wired`);
  }
  assert.match(TEAM_ONBOARDING_SCRIPT, /rowId: data\.repositorySelect/);
  assert.match(TEAM_ONBOARDING_SCRIPT, /authorityId: event\.target\.value/);
  assert.match(TEAM_ONBOARDING_SCRIPT, /capabilityKey: data\.workspaceCapability/);
  assert.match(TEAM_ONBOARDING_SCRIPT, /post\('repository-paste'\)/,
    'paste requests native host collection instead of returning a raw URL');
  assert.doesNotMatch(TEAM_ONBOARDING_SCRIPT,
    /\b(?:url|locator|leadUrl|cursor|selectionRef|proposalBranch)\s*:/i);
});
