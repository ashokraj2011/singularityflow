/**
 * Impact computed from the Story plan, and reconciled against the impact map that was written down.
 *
 * The pure function is tested directly rather than through the CLI: every input it needs is already
 * a plain object, so a fixture states the exact situation under test instead of a repository being
 * driven into it. The CLI wiring is covered separately in initiative-cli.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeInitiativeImpact, impactDocument, impactFindings } from '../src/initiative-impact.mjs';

const portfolio = {
  repositories: {
    web: { lead: true, remote: 'git@example.com:acme/web.git' },
    api: { remote: 'git@example.com:acme/api.git' },
    jobs: { remote: 'git@example.com:acme/jobs.git' }
  }
};

/** A breakdown as validateInitiativeBreakdown would have returned it. */
function breakdown(stories) {
  return {
    version: 2,
    initiativeId: 'INIT-IMPACT',
    epics: [],
    stories: stories.map((story) => ({
      blocking: true, dependsOn: [], consumesContracts: [], epicId: 'E1', ...story
    }))
  };
}

test('impact is derived from where Stories land, not from what the map claims', () => {
  const impact = computeInitiativeImpact(portfolio, breakdown([
    { id: 'S1', repository: 'web' },
    { id: 'S2', repository: 'web', blocking: false },
    { id: 'S3', repository: 'api' }
  ]));

  assert.deepEqual(impact.repositories.map((repository) => repository.id), ['api', 'web']);
  const web = impact.repositories.find((repository) => repository.id === 'web');
  assert.equal(web.storyCount, 2);
  assert.equal(web.blockingStoryCount, 1, 'a non-blocking Story still lands but does not gate');
  assert.equal(web.lead, true);
  assert.deepEqual(web.stories, ['S1', 'S2']);
  // jobs is declared in the portfolio but no Story touches it, so it is not impacted.
  assert.ok(!impact.repositories.some((repository) => repository.id === 'jobs'));
});

test('a map that names the wrong repositories is caught in both directions', () => {
  // This is the case the existing validator cannot see: every name it checks exists, so it passes.
  const impact = computeInitiativeImpact(portfolio, breakdown([
    { id: 'S1', repository: 'web' },
    { id: 'S2', repository: 'api' }
  ]), { claimed: { repositories: { web: {}, jobs: {} } } });

  assert.equal(impact.reconciliation.compared, true);
  assert.deepEqual(impact.reconciliation.agreed, ['web']);
  assert.deepEqual(impact.reconciliation.unclaimed, ['api'], 'a repository Stories land in but the map omits');
  assert.deepEqual(impact.reconciliation.unsupported, ['jobs'], 'a repository the map names but no Story touches');

  const findings = impactFindings(impact);
  assert.match(findings[0], /omits 'api', which 1 Story lands in/);
  assert.match(findings[1], /names 'jobs', which no Story touches/);
});

test('an empty map is reported as unreconciled rather than as agreement', () => {
  // verifyInitiativeImpactMap returns clean for an empty map, which reads as "checked and fine".
  const impact = computeInitiativeImpact(portfolio, breakdown([{ id: 'S1', repository: 'web' }]),
    { claimed: { repositories: {} } });
  assert.equal(impact.reconciliation.compared, false);
  assert.deepEqual(impactFindings(impact), [], 'nothing to reconcile is not the same as a finding');
  assert.match(impactDocument(impact), /No impact map has been published yet/);
});

test('a Story plan that lands nowhere is a finding on its own', () => {
  const impact = computeInitiativeImpact(portfolio, breakdown([]));
  assert.deepEqual(impactFindings(impact), ['the Story plan lands in no repository at all']);
});

test('cross-repository edges follow Story dependencies and point the way work flows', () => {
  const impact = computeInitiativeImpact(portfolio, breakdown([
    { id: 'S-API', repository: 'api' },
    { id: 'S-WEB', repository: 'web', dependsOn: [{ story: 'S-API', requiredPhase: 'implementation-spec' }] },
    { id: 'S-WEB2', repository: 'web', dependsOn: [{ story: 'S-API', requiredPhase: 'implementation-spec' }] },
    // A dependency inside one repository is real, but says nothing about cross-repository impact.
    { id: 'S-WEB3', repository: 'web', dependsOn: [{ story: 'S-WEB', requiredPhase: 'implementation-spec' }] }
  ]));

  assert.equal(impact.crossRepository.length, 1, 'same-repository dependencies must not pad the count');
  const [edge] = impact.crossRepository;
  assert.equal(edge.from, 'api', 'the dependency is upstream, so its repository lands first');
  assert.equal(edge.to, 'web');
  assert.deepEqual(edge.via.map((via) => via.story), ['S-WEB', 'S-WEB2']);
});

test('impact names no World Model: an old map with views per repository reads as the repositories it names', () => {
  // The registered World Model was removed (WMR REQ-003): no manifest is read, no column is shown, and a
  // view an old map still claims is neither a finding nor a refusal.
  const impact = computeInitiativeImpact(portfolio, breakdown([
    { id: 'S1', repository: 'web' },
    { id: 'S2', repository: 'api' }
  ]), { claimed: { repositories: { web: { worldModelViews: ['business', 'telepathy'] }, api: { views: ['data'] } } } });

  assert.deepEqual(impact.reconciliation.agreed, ['api', 'web']);
  assert.deepEqual(impactFindings(impact), []);
  for (const repository of impact.repositories) {
    for (const field of ['worldModel', 'claimedViews', 'unknownClaimedViews']) assert.equal(Object.hasOwn(repository, field), false, field);
  }
  for (const field of ['unknownViews', 'missingWorldModel']) assert.equal(Object.hasOwn(impact.reconciliation, field), false, field);
  const document = impactDocument(impact);
  assert.doesNotMatch(document, /world model/i);
  assert.match(document, /\| Repository \| Stories \| Blocking \| Contracts consumed \| In impact map \|/);
});

test('consumed contracts are reported per repository and never invented into an edge', () => {
  // consumesContracts entries carry no producing Story, so there is no honest repo-to-repo edge.
  const impact = computeInitiativeImpact(portfolio, breakdown([
    { id: 'S1', repository: 'web', consumesContracts: [{ id: 'orders-v2', version: '2', sha256: null }] },
    { id: 'S2', repository: 'web', consumesContracts: [{ id: 'orders-v2', version: '2', sha256: null }] }
  ]));

  const web = impact.repositories.find((repository) => repository.id === 'web');
  assert.deepEqual(web.consumesContracts, ['orders-v2'], 'deduplicated across Stories');
  assert.equal(impact.crossRepository.length, 0);
});

test('the document renders the drift a reviewer has to act on', () => {
  const impact = computeInitiativeImpact(portfolio, breakdown([
    { id: 'S1', repository: 'web' },
    { id: 'S2', repository: 'api', dependsOn: [{ story: 'S1', requiredPhase: 'implementation-spec' }] }
  ]), { claimed: { repositories: { web: {} } } });

  const document = impactDocument(impact);
  assert.match(document, /# Computed impact — INIT-IMPACT/);
  assert.match(document, /2 Stories across 2 repositories/);
  assert.match(document, /\| `web` \(lead\) \| 1 \|/);
  assert.match(document, /Must land first/);
  assert.match(document, /omits 'api'/);
});
