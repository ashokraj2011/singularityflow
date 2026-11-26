/**
 * The organisation's marketplace, M1 [OMK §4, §5, docs/SPEC-OMK-ORG-MARKETPLACE-v1.md]: each item's owner and where it
 * came from, its lifecycle record with who and when and its fallbacks, the marketplace's own findings on them, the code
 * owners that guard the record, the channels, and the v3 listings that keep all of it per commit; then every surface
 * that shows it: the catalog, browse, the skill catalog, the conversion review and the task offers.
 *
 * The marketplace is a local Git repository made from test/fixtures/sdlc-marketplace, with its seeded bad item laid over
 * it (test/helpers/sdlc-marketplace.mjs): nothing here uses a network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { amongOwners, codeOwnersOf, codeownersPatternRegExp, parseCodeowners } from '../src/codeowners.mjs';
import { dayWords, guardWords, isLifecycleWord, itemLifecycle, LIFECYCLE_STATES, lifecycleFindings, lifecycleInstallable, lifecycleMoveAllowed,
  lifecycleReadiness, lifecycleStateOf, lifecycleSummary, lifecycleWords, parseLifecycleRecord } from '../src/marketplace-lifecycle.mjs';
import { parseOwnerBlock, resolveOwner } from '../src/marketplace-owner.mjs';
import { packageMetadata, parseMarketplaceChannels, parseMarketplaceManifest, parsePackageManifest, trustChannel } from '../src/marketplace-repository.mjs';
import { parseMarketplaceIndex } from '../src/marketplace.mjs';
import { analyzeMarketplaceCatalog, indexItems, marketplaceCatalogLines, repositoryItems } from '../src/marketplace-catalog.mjs';
import { analyzeSkillCatalog } from '../src/skill-catalog.mjs';
import { chooseTaskSkills, librarySkillCandidate, marketplaceSkillCandidate, planSkillWords } from '../src/task-skills.mjs';
import { composeTask } from '../src/task-composition.mjs';
import { convertAgent } from '../src/agent-workflow.mjs';
import { conversionReview, conversionReviewMarkdown, feedbackIssue } from '../src/conversion-review.mjs';
import { journeyRepository } from './helpers/route-follower.mjs';
import { copySampleMarketplace, SAMPLE_MARKETPLACE, SEEDED_ITEM } from './helpers/sdlc-marketplace.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const sha = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const fixture = (relative) => readFileSync(path.join(SAMPLE_MARKETPLACE, relative), 'utf8');
const COMMIT_ID = /\b[0-9a-f]{40}\b/u;
const STEWARDS = '@acme/marketplace-stewards';

// ------------------------------------------------------------------------------------------------ code owners

test('CODEOWNERS: GitHub\'s and GitLab\'s patterns, the last rule that matches wins, GitLab sections are joined [OMK:REQ-013]', () => {
  const matches = (pattern, file) => codeownersPatternRegExp(pattern).test(file);
  // GitHub's own examples.
  assert.ok(matches('*', 'any/where/file.md') && matches('*', 'apm.yml'));
  assert.ok(matches('*.js', 'src/app.js') && !matches('*.js', 'src/app.ts'));
  assert.ok(matches('/build/logs/', 'build/logs/a.log') && !matches('/build/logs/', 'deep/build/logs/a.log'));
  assert.ok(matches('apps/', 'apps/x.js') && matches('apps/', 'deep/apps/x.js'));
  assert.ok(matches('docs/*', 'docs/getting-started.md') && !matches('docs/*', 'docs/build-app/troubleshooting.md'), 'docs/* is only the files directly in docs');
  assert.ok(matches('**/logs', 'a/b/logs/x') && matches('**/logs', 'logs'));
  assert.ok(matches('apps/**', 'apps/a/b.ts') && !matches('apps/**', 'other/apps/b.ts'));
  assert.ok(matches('docs/**/guide.md', 'docs/guide.md') && matches('docs/**/guide.md', 'docs/a/b/guide.md'));
  assert.ok(matches('/skills/android-*/', 'skills/android-unit-test/apm.yml') && !matches('/skills/android-*/', 'skills/web-xray-creation/apm.yml'));
  assert.ok(matches('\\#notes.md', '#notes.md') && matches('[ab].md', 'b.md') && !matches('[ab].md', 'c.md'));

  const parsed = parseCodeowners([
    '# the stewards own everything', '*  @acme/marketplace-stewards', '/skills/web-e2e/ @acme/web-qa @Someone  # an inline comment',
    '/skills/web-e2e/lifecycle.yml', 'docs/** not-an-owner@', '**/lifecycle.yml @acme/marketplace-stewards', '/skills/x/lifecycle.yml',
    '', '[Docs] @acme/writers', '/docs/', '^[Optional review][2]', 'skills/** reviewer@example.com'
  ].join('\n'));
  assert.equal(parsed.rules.length, 8);
  assert.deepEqual(parsed.sections, ['Docs', 'Optional review']);
  assert.deepEqual(parsed.problems, ["CODEOWNERS line 5: 'not-an-owner@' is not a handle or an email, so it is not an owner."]);
  // The last rule that matches wins; a rule with no owners leaves its paths with none.
  assert.deepEqual(codeOwnersOf(parsed, 'skills/web-e2e/SKILL.md').owners, ['@acme/web-qa', '@Someone', 'reviewer@example.com'], 'the default section and GitLab\'s joined');
  assert.deepEqual(codeOwnersOf(parsed, 'skills/web-e2e/lifecycle.yml').owners, [STEWARDS, 'reviewer@example.com']);
  assert.deepEqual(codeOwnersOf(parsed, 'skills/x/lifecycle.yml'), { covered: true, owners: ['reviewer@example.com'], lines: [7, 12] });
  assert.deepEqual(codeOwnersOf(parseCodeowners('*  @a/b\n/x/lifecycle.yml\n'), 'x/lifecycle.yml'), { covered: false, owners: [], lines: [2] });
  // A section's default owners stand for an entry with none; the default section's last match (docs/**) names none.
  assert.deepEqual(codeOwnersOf(parsed, 'docs/guide.md').owners, ['@acme/writers']);
  assert.ok(amongOwners('@ACME/web-qa', ['@acme/web-qa']) && !amongOwners('', ['@acme/web-qa']));
  // Bounded: 64 KiB and 2,000 rules.
  assert.deepEqual(parseCodeowners(`# ${'x'.repeat(64 * 1024)}`).rules, []);
  assert.match(parseCodeowners(`# ${'x'.repeat(64 * 1024)}`).problems[0], /larger than 64 KiB/u);
  const many = parseCodeowners(Array.from({ length: 2100 }, (_, index) => `/f${index} @a/b`).join('\n'));
  assert.equal(many.rules.length, 2000);
  assert.match(many.problems.at(-1), /more than 2000 rules/u);
});

// ------------------------------------------------------------------------------------------------ the vocabulary

test('one lifecycle vocabulary: the marketplace\'s words, what a task and an install do, the moves, the words a person reads [OMK:REQ-010]', () => {
  const states = Object.fromEntries(['proposed', 'draft', 'submitted', 'experimental', 'beta', 'alpha', 'preview', 'approved', 'ga', 'released', 'stable',
    'generally-available', 'deprecated', 'retired', 'withdrawn', 'archived', 'Approved', 'nonsense', null].map((word) => [String(word), lifecycleStateOf(word)]));
  assert.deepEqual(states, { proposed: 'proposed', draft: 'proposed', submitted: 'proposed', experimental: 'early', beta: 'early', alpha: 'early', preview: 'early',
    approved: 'approved', ga: 'ga', released: 'ga', stable: 'ga', 'generally-available': 'ga', deprecated: 'deprecated', retired: 'retired', withdrawn: 'retired',
    archived: 'retired', Approved: 'approved', nonsense: null, null: null });
  assert.ok(isLifecycleWord('beta') && !isLifecycleWord('web'));
  assert.deepEqual(LIFECYCLE_STATES.map((state) => lifecycleReadiness(state)), ['unreviewed', 'unreviewed', 'ready', 'ready', 'retired', 'retired'],
    'deprecated and retired are never offered; proposed and early need a yes');
  assert.equal(lifecycleReadiness(null), 'unreviewed', 'an unmarked marketplace item needs a yes');
  assert.equal(lifecycleReadiness(null, { unmarked: 'ready' }), 'ready', 'a library skill written here is used as it is');
  assert.deepEqual(LIFECYCLE_STATES.map(lifecycleInstallable), [true, true, true, true, true, false], 'only a retired item cannot be installed');
  // The moves: early moves as proposed does.
  const allowed = [['proposed', 'approved'], ['proposed', 'retired'], ['approved', 'ga'], ['approved', 'deprecated'], ['approved', 'proposed'], ['ga', 'deprecated'],
    ['deprecated', 'ga'], ['deprecated', 'retired'], ['early', 'approved'], ['beta', 'retired'], ['approved', 'experimental']];
  for (const [from, to] of allowed) assert.ok(lifecycleMoveAllowed(from, to), `${from} → ${to}`);
  for (const [from, to] of [['proposed', 'ga'], ['ga', 'approved'], ['ga', 'retired'], ['retired', 'ga'], ['deprecated', 'approved'], ['early', 'ga']]) {
    assert.equal(lifecycleMoveAllowed(from, to), false, `${from} → ${to}`);
  }
  // The words a person reads, with who and when where the record says.
  assert.equal(dayWords('2026-10-02'), '2 Oct 2026');
  const words = (record, owner) => lifecycleWords({ guarded: true, approvers: [STEWARDS], by: [], since: null, deprecation: null, ...record }, { owner });
  assert.equal(words({ state: 'proposed', word: 'proposed', since: '2026-09-14', by: ['@acme/web-qa'] }, { name: 'Web QA', handle: '@acme/web-qa' }),
    'Proposed by Web QA on 14 Sep 2026; not yet approved');
  assert.equal(words({ state: 'early', word: 'experimental' }), 'Experimental: approved for early use; it may still change');
  assert.equal(words({ state: 'approved', word: 'approved', since: '2026-10-02', by: [STEWARDS] }),
    'Approved by @acme/marketplace-stewards, the code owners of its lifecycle record, on 2 Oct 2026');
  assert.equal(words({ state: 'approved', word: 'approved', since: '2026-10-02', by: ['@someone-else'] }), 'Approved by @someone-else on 2 Oct 2026');
  assert.equal(words({ state: 'ga', word: 'ga', since: '2026-11-01' }), 'Generally available since 1 Nov 2026');
  assert.equal(words({ state: 'deprecated', word: 'deprecated', since: '2026-11-20', deprecation: { replacedBy: 'web-e2e-test-generation-v2', sunset: '2027-03-31' } }),
    'Deprecated on 20 Nov 2026: use web-e2e-test-generation-v2 (supported until 31 Mar 2027)');
  assert.equal(words({ state: 'retired', word: 'retired' }), 'Retired: no longer supported');
  assert.equal(lifecycleWords(null), 'No lifecycle recorded');
  // What guards it: "declares", never "enforced" [REQ-014].
  assert.equal(guardWords({ word: 'ga', source: 'lifecycle.yml', guarded: true, approvers: [STEWARDS] }),
    'The marketplace declares @acme/marketplace-stewards as the code owners of its lifecycle record.');
  assert.equal(guardWords({ word: 'ga', source: 'lifecycle.yml', guarded: false }), 'Lifecycle not guarded by code owners: anyone who can merge to the marketplace can change it.');
  assert.equal(guardWords({ word: 'ga', source: 'index', guarded: null }), 'Lifecycle as the index states it: an index has no code owners SFlow can read.');
  assert.equal(guardWords({ word: 'ga', source: 'lifecycle-state', guarded: null }), null, 'not known when CODEOWNERS was not read');
});

test('where the lifecycle comes from: lifecycle.yml, an apm.yml mapping, lifecycle-state, a lifecycle: tag, or nothing [OMK:REQ-002]', () => {
  const file = parseLifecycleRecord({ state: 'ga', history: [{ to: 'proposed', at: '2026-09-01' }, { from: 'proposed', to: 'approved', at: '2026-10-01' },
    { from: 'approved', to: 'ga', at: '2026-11-01', 'approved-by': [STEWARDS], change: 'https://git.example.com/acme/m/pull/9' }] });
  const mapping = parseLifecycleRecord({ state: 'approved', history: [] });
  const guard = { covered: true, owners: [STEWARDS] };
  const from = (sources) => { const found = itemLifecycle({ guard, ...sources }); return found && [found.source, found.state, found.since, found.change]; };
  assert.deepEqual(from({ file, mapping, state: 'proposed', tags: ['lifecycle:beta'] }), ['lifecycle.yml', 'ga', '2026-11-01', 'https://git.example.com/acme/m/pull/9']);
  assert.deepEqual(from({ mapping, state: 'proposed', tags: ['lifecycle:beta'] }), ['apm.yml', 'approved', null, null]);
  assert.deepEqual(from({ state: 'proposed', tags: ['lifecycle:beta'] }), ['lifecycle-state', 'proposed', null, null]);
  assert.deepEqual(from({ tags: ['web', 'lifecycle:beta'] }), ['tag', 'early', null, null]);
  assert.equal(from({ tags: ['web'] }), null, 'unmarked');
  // An index's keys are camelCase; it is never called guarded.
  const indexed = itemLifecycle({ index: parseLifecycleRecord({ state: 'deprecated', deprecation: { replacedBy: 'v2' }, history: [{ from: 'ga', to: 'deprecated', at: '2026-11-20',
    approvedBy: ['@acme/appsec'] }] }, { camel: true }) });
  assert.deepEqual([indexed.source, indexed.guarded, indexed.by, indexed.deprecation.replacedBy, indexed.words], ['index', null, ['@acme/appsec'], 'v2',
    'Deprecated on 20 Nov 2026: use v2']);
  // Bounded: the last 50 entries, each at most 1,000 characters.
  const long = parseLifecycleRecord({ state: 'approved', history: Array.from({ length: 60 }, (_, index) => ({ from: index % 2 ? 'approved' : 'proposed',
    to: index % 2 ? 'proposed' : 'approved', at: '2026-10-01', note: 'n'.repeat(5000) })) });
  assert.equal(long.history.length, 50);
  assert.ok(long.history.every((entry) => JSON.stringify(entry).length <= 1000));
  assert.match(long.problems[0], /only the last 50 are read/u);
  assert.equal(parseLifecycleRecord('ga'), null);
});

test('the record is checked, never refused: each problem is a marketplace-owned finding with its fix [OMK:REQ-003]', () => {
  const findings = (record, { guard = { covered: true, owners: [STEWARDS] }, apmState = null, commitDate = '2026-11-26' } = {}) => {
    const parsed = parseLifecycleRecord(record);
    return lifecycleFindings({ name: 'web-e2e', parsed, lifecycle: itemLifecycle({ file: parsed, guard }), apmState, commitDate }).map((entry) => entry.class);
  };
  const clean = { state: 'ga', history: [{ to: 'proposed', at: '2026-09-01', by: '@acme/web-qa' },
    { from: 'proposed', to: 'approved', at: '2026-10-01', 'approved-by': [STEWARDS] }, { from: 'approved', to: 'ga', at: '2026-11-01', 'approved-by': [STEWARDS] }] };
  assert.deepEqual(findings(clean, { apmState: 'ga' }), []);
  assert.deepEqual(findings(clean, { apmState: 'approved' }), ['marketplace-lifecycle-mismatch']);
  assert.deepEqual(findings({ ...clean, state: 'deprecated' }), ['marketplace-lifecycle-record'], 'its last entry does not move it to its state');
  assert.deepEqual(findings({ state: 'ga', history: [clean.history[0], { from: 'proposed', to: 'ga', at: '2026-10-01', 'approved-by': [STEWARDS] }] }), ['marketplace-lifecycle-jump']);
  assert.deepEqual(findings({ state: 'ga', history: [clean.history[0], { ...clean.history[2] }] }), ['marketplace-lifecycle-record'],
    'its from is not the entry before\'s to');
  assert.deepEqual(findings({ state: 'approved', history: [{ to: 'proposed', at: '2026-10-05' }, { from: 'proposed', to: 'approved', at: '2026-10-01', 'approved-by': [STEWARDS] }] }),
    ['marketplace-lifecycle-record'], 'out of date order');
  assert.deepEqual(findings(clean, { commitDate: '2026-10-15' }), ['marketplace-lifecycle-record'], 'dated after the commit that holds it');
  assert.deepEqual(findings({ ...clean, history: [...clean.history.slice(0, 2), { ...clean.history[2], 'approved-by': ['@someone'] }] }), ['marketplace-lifecycle-approver']);
  assert.deepEqual(findings(clean, { guard: { covered: false, owners: [] } }), ['marketplace-lifecycle-unguarded']);
  assert.deepEqual(findings({ state: 'shipped', history: [] }), ['marketplace-lifecycle-record'], 'a state SFlow does not know');
  assert.deepEqual(findings({ state: 'ga', history: [{ to: 'ga', at: 'last week', change: 'http://x' }] }), ['marketplace-lifecycle-record', 'marketplace-lifecycle-record']);
  // A record read only from lifecycle-state has no history to check.
  assert.deepEqual(lifecycleFindings({ name: 'x', lifecycle: itemLifecycle({ state: 'approved', guard: { covered: false } }) }), []);
  const [jump] = lifecycleFindings({ name: 'web-e2e', parsed: null, lifecycle: itemLifecycle({ file: parseLifecycleRecord({ state: 'ga', history: [{ to: 'proposed' }, { from: 'proposed', to: 'ga' }] }),
    guard: { covered: true, owners: [STEWARDS] } }) });
  assert.deepEqual(jump, { class: 'marketplace-lifecycle-jump', owner: 'marketplace', item: 'web-e2e', from: 'proposed', to: 'ga',
    words: 'web-e2e\'s lifecycle.yml: history entry 2 moves it from proposed straight to ga, which is not one of the moves a lifecycle makes.',
    fix: 'Move web-e2e from proposed only to approved or retired, each move in its own reviewed change.' });
});

// ------------------------------------------------------------------------------------------------ the owner

test('the owner: its apm.yml block, else the code owners of its folder, else maintainer-email, else the marketplace\'s, and which [OMK:REQ-001]', () => {
  const block = parseOwnerBlock({ team: 'web-qa', name: 'Web QA', handle: '@acme/web-qa', contact: 'web-qa@example.com', issues: 'https://git.example.com/acme/m/issues',
    'feedback-labels': ['sflow-feedback', 'web e2e', '<b>'] }, { name: 'web-e2e' });
  assert.deepEqual(block.findings, []);
  assert.deepEqual(block.owner.feedbackLabels, ['sflow-feedback', 'web e2e']);
  const http = parseOwnerBlock({ team: 'Web QA!', name: 'Web QA', issues: 'http://git.example.com/acme/m/issues' }, { name: 'web-e2e' });
  assert.deepEqual([http.owner.issues, http.owner.team, http.findings.map((entry) => entry.class)], [null, null, ['marketplace-metadata', 'marketplace-metadata']]);
  assert.match(http.findings[0].words, /not an https address, so feedback does not go there/u);
  assert.deepEqual(parseOwnerBlock('web-qa', { name: 'x' }).findings.map((entry) => entry.class), ['marketplace-metadata']);
  const shown = (input) => { const owner = resolveOwner(input); return owner && [owner.from, owner.words, owner.confirmed, owner.confirmWords]; };
  assert.deepEqual(shown({ own: block.owner, folderOwners: ['@acme/web-qa'] }), ['apm.yml', 'Owner: Web QA', true, null]);
  assert.deepEqual(shown({ own: block.owner, folderOwners: ['@acme/qa-guild'] }), ['apm.yml', 'Owner: Web QA', false,
    'Owner named in apm.yml; CODEOWNERS names someone else for its folder']);
  assert.deepEqual(shown({ own: block.owner }), ['apm.yml', 'Owner: Web QA', null, null], 'no CODEOWNERS: not checked');
  assert.deepEqual(shown({ folderOwners: ['@acme/web-qa'], maintainer: 'maintainers@example.com' }), ['codeowners', 'Owner: @acme/web-qa (from CODEOWNERS)', null, null]);
  assert.deepEqual(shown({ folderOwners: [], maintainer: 'maintainers@example.com', marketplaceOwner: { name: 'Acme' } }),
    ['maintainer-email', 'Owner: maintainers@example.com (from maintainer-email)', null, null]);
  assert.deepEqual(shown({ marketplaceOwner: { name: 'Acme Retail Engineering Enablement', email: 'maintainers@example.com' } }),
    ['marketplace', 'Owner: Acme Retail Engineering Enablement (from the marketplace\'s owner)', null, null]);
  assert.equal(resolveOwner({}), null);
});

// ------------------------------------------------------------------------------------------------ the sample marketplace

const CODEOWNERS = parseCodeowners(fixture('.github/CODEOWNERS'), { path: '.github/CODEOWNERS' });
const MANIFEST = parseMarketplaceManifest(fixture('apm.yml'));
function fixtureMetadata(source, { root = SAMPLE_MARKETPLACE, codeowners = CODEOWNERS } = {}) {
  const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
  const own = parsePackageManifest(read(`${source}/apm.yml`), { source });
  return { own, ...packageMetadata({ name: path.posix.basename(source), source, own, lifecycleText: read(`${source}/lifecycle.yml`), codeowners,
    marketplaceOwner: { name: MANIFEST.owner, email: MANIFEST.ownerEmail }, commitDate: '2026-11-26' }) };
}

test('the sample marketplace: every item owned, its lifecycle recorded and guarded, its channels, and no finding [OMK §11]', () => {
  assert.deepEqual(CODEOWNERS.problems, []);
  assert.deepEqual(MANIFEST.channels, { beta: { ref: 'channels/beta', description: 'New and changed items, about two weeks before stable.', after: null },
    stable: { ref: 'channels/stable', description: null, after: 'beta' } });
  assert.equal(MANIFEST.ownerEmail, 'maintainers@example.com');
  for (const entry of MANIFEST.packages) {
    const meta = fixtureMetadata(entry.source);
    assert.deepEqual(meta.findings, [], entry.name);
    assert.deepEqual([meta.owner.from, meta.owner.confirmed], ['apm.yml', true], entry.name);
    assert.deepEqual([meta.lifecycleRecord.source, meta.lifecycleRecord.guarded, meta.lifecycleRecord.approvers, meta.lifecycleRecord.state],
      ['lifecycle.yml', true, [STEWARDS], meta.own.lifecycleState], entry.name);
  }
  const ga = fixtureMetadata('skills/web-e2e-test-generation');
  assert.deepEqual([ga.owner.words, ga.owner.issues, ga.owner.feedbackLabels], ['Owner: Web QA', 'https://git.example.com/acme/sdlc-marketplace/issues',
    ['sflow-feedback', 'web-e2e-test-generation']]);
  assert.deepEqual([ga.lifecycleRecord.words, ga.lifecycleRecord.since, ga.lifecycleRecord.by, ga.lifecycleRecord.change],
    ['Generally available since 1 Nov 2026', '2026-11-01', [STEWARDS], 'https://git.example.com/acme/sdlc-marketplace/pull/26']);
  assert.equal(fixtureMetadata('skills/requirements-writer').lifecycleRecord.words,
    'Approved by @acme/marketplace-stewards, the code owners of its lifecycle record, on 2 Oct 2026');
  assert.equal(fixtureMetadata('agents/qa-test-automation-agent').lifecycleRecord.words, 'Proposed by QA Guild on 16 Sep 2026; not yet approved');
  // Channels: only stable and beta, a ref a trust takes, an order within the marketplace; a trust is a channel by its ref [REQ-004, REQ-021].
  const channels = parseMarketplaceChannels({ stable: { ref: 'channels/stable', after: 'nightly' }, nightly: { ref: 'x' }, beta: { ref: '../escape' } });
  assert.deepEqual(channels.channels, { stable: { ref: 'channels/stable', description: null, after: null } });
  assert.equal(channels.problems.length, 3);
  assert.deepEqual([trustChannel(MANIFEST.channels, 'channels/stable'), trustChannel(MANIFEST.channels, 'channels/beta'), trustChannel(MANIFEST.channels, 'main'),
    trustChannel(MANIFEST.channels, null)], ['stable', 'beta', null, null]);
  // An older marketplace with none of the additions: the owner from maintainer-email, the lifecycle from lifecycle-state, no channel [REQ-006].
  const plain = packageMetadata({ name: 'web-e2e', source: 'skills/web-e2e', own: parsePackageManifest('name: web-e2e\ntype: skill\nlifecycle-state: approved\nmaintainer-email: m@example.com\n',
    { source: 'skills/web-e2e' }) });
  assert.deepEqual([plain.owner.words, plain.lifecycleRecord.source, plain.lifecycleRecord.words, plain.lifecycleRecord.guarded, plain.findings],
    ['Owner: m@example.com (from maintainer-email)', 'lifecycle-state', 'Approved', false, []]);
  assert.deepEqual(parseMarketplaceManifest('marketplace:\n  packages: []\n').channels, {});
});

test('the seeded bad item: a jump, a mismatch, an unguarded record, an owner CODEOWNERS does not name, an issues address that is not https [OMK §11, A3]', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-omk-seeded-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const market = await copySampleMarketplace(path.join(directory, 'acme'), { seeded: true });
  const codeowners = parseCodeowners(await readFile(path.join(market, '.github/CODEOWNERS'), 'utf8'));
  const seeded = fixtureMetadata(`skills/${SEEDED_ITEM}`, { root: market, codeowners });
  assert.deepEqual(seeded.findings.map((entry) => entry.class), ['marketplace-metadata', 'marketplace-lifecycle-mismatch', 'marketplace-lifecycle-jump',
    'marketplace-lifecycle-unguarded', 'marketplace-owner-unconfirmed']);
  assert.ok(seeded.findings.every((entry) => entry.owner === 'marketplace' && entry.fix), 'each the marketplace\'s, with its fix');
  assert.deepEqual([seeded.lifecycleRecord.state, seeded.lifecycleRecord.guarded, lifecycleSummary(seeded.lifecycleRecord).notGuarded], ['ga', false, true]);
  assert.match(await readFile(path.join(market, 'skills', SEEDED_ITEM, 'SKILL.md'), 'utf8'), /‮/u, 'its hidden character, written by the helper');
  // The rest of the marketplace keeps no finding.
  assert.deepEqual(fixtureMetadata('skills/web-e2e-test-generation', { root: market, codeowners }).findings, []);
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'test/fixtures/sdlc-marketplace-seeded/skills', SEEDED_ITEM, 'SKILL.md'), 'utf8'), /[‪-‮⁦-⁩​-‏]/u,
    'no file in the repository holds a hidden character');
});

// ------------------------------------------------------------------------------------------------ an index

test('an index may say who owns an entry, its lifecycle and its channels; never guarded, never followed elsewhere [OMK:REQ-005]', () => {
  const marketplace = { id: 'shared', index: 'https://skills.example.org/stable.json', allowedOrigins: ['https://cdn.example.org'] };
  const entry = { id: 'security-review', kind: 'skill', version: '2.1.0', url: 'https://skills.example.org/security-review.md', sha256: 'a'.repeat(64) };
  const index = parseMarketplaceIndex(Buffer.from(JSON.stringify({ format: 'sflow-marketplace@1', name: 'Shared', publisher: 'Acme AppSec', channel: 'stable',
    channels: { stable: { index: 'https://skills.example.org/stable.json', after: 'beta' }, beta: { index: 'https://elsewhere.example.net/beta.json' }, nightly: { index: 'https://skills.example.org/n.json' } },
    entries: [
      { ...entry, owner: { team: 'appsec', name: 'AppSec', issues: 'https://git.example.com/acme/skills/issues', feedbackLabels: ['sflow-feedback'] },
        lifecycle: { state: 'ga', history: [{ from: 'approved', to: 'ga', at: '2026-11-01', approvedBy: ['@acme/appsec'], change: 'https://git.example.com/acme/skills/pull/9' }] } },
      { ...entry, id: 'plain-skill' }] })), marketplace);
  assert.equal(index.channel, 'stable');
  assert.deepEqual(index.channels, { stable: { index: 'https://skills.example.org/stable.json', after: null } }, 'beta at an origin the trust does not allow is never read');
  assert.equal(index.problems.length, 2);
  const [owned, plain] = index.entries;
  assert.deepEqual([owned.owner.words, owned.owner.issues, owned.lifecycle.words, owned.lifecycle.guarded, owned.lifecycle.guardWords],
    ['Owner: AppSec', 'https://git.example.com/acme/skills/issues', 'Generally available since 1 Nov 2026', null,
      'Lifecycle as the index states it: an index has no code owners SFlow can read.']);
  assert.deepEqual([plain.owner.words, plain.lifecycle], ['Owner: Acme AppSec (from the marketplace\'s owner)', undefined]);
  // The catalog's item and a task's candidate read the same lifecycle.
  const [item] = indexItems({ entries: [owned] });
  assert.deepEqual([item.owner.name, item.lifecycleRecord.state], ['AppSec', 'ga']);
  assert.equal(marketplaceSkillCandidate({ name: owned.id, tags: [], lifecycleRecord: owned.lifecycle }, 'shared').lifecycle, 'ready');
  // An index with none of the fields: nothing new on its entries [REQ-006].
  const older = parseMarketplaceIndex(Buffer.from(JSON.stringify({ format: 'sflow-marketplace@1', entries: [entry] })), marketplace);
  assert.deepEqual([older.channel, older.channels, older.entries[0].owner, older.entries[0].lifecycle], [null, {}, undefined, undefined]);
});

// ------------------------------------------------------------------------------------------------ the surfaces, pure

function sampleCatalog() {
  const metaOf = (source) => { const { owner, lifecycleRecord, findings } = fixtureMetadata(source); return { owner, lifecycleRecord, findings }; };
  const retired = itemLifecycle({ file: parseLifecycleRecord({ state: 'retired', history: [{ from: 'deprecated', to: 'retired', at: '2026-11-20', 'approved-by': [STEWARDS] }] }),
    guard: { covered: true, owners: [STEWARDS] } });
  return {
    marketplaces: [{ id: 'acme', label: 'Acme', kind: 'repository', commit: 'e'.repeat(40), channel: 'stable', warning: null, items: repositoryItems({
      skills: [
        { name: 'web-e2e-test-generation', version: '1.0.0-pdlc', tags: ['web'], pdlcTasks: ['e2e-testing'], lifecycleState: 'ga', sha256: '1'.repeat(64), ...metaOf('skills/web-e2e-test-generation') },
        { name: 'requirements-writer', version: '1.0.0-pdlc', tags: [], pdlcTasks: ['requirements-analysis'], lifecycleState: 'approved', sha256: '2'.repeat(64), ...metaOf('skills/requirements-writer') },
        { name: 'old-checks', version: '0.1.0', tags: ['web'], pdlcTasks: ['e2e-testing'], lifecycleState: 'approved', sha256: '3'.repeat(64), owner: null, lifecycleRecord: retired, findings: [] }],
      agents: [{ name: 'qa-test-automation-agent', version: '1.0.0-pdlc', tags: [], lifecycleState: 'proposed', skills: [], text: 'qa', manifestSha256: '4'.repeat(64),
        ...metaOf('agents/qa-test-automation-agent') }] }) }],
    library: [], imports: {}, workflows: {}, steps: {}, unapproved: []
  };
}

test('the catalog: each row\'s owner, lifecycle record, channel and findings; a retired item is not installed; the terminal\'s owner column and lifecycle lines [OMK:REQ-015]', () => {
  const catalog = JSON.parse(JSON.stringify(analyzeMarketplaceCatalog(sampleCatalog())));
  const byKey = new Map(catalog.items.map((item) => [item.key, item]));
  const ga = byKey.get('market:acme/skill/web-e2e-test-generation');
  assert.deepEqual([ga.lifecycle, ga.readiness, ga.channel, ga.deprecatedInUse, ga.safety, ga.use, ga.findings], ['ga', 'ready', 'stable', null, null, null, []]);
  assert.deepEqual(ga.owner, { team: 'web-qa', name: 'Web QA', handle: '@acme/web-qa', contact: 'web-qa@example.com', issues: 'https://git.example.com/acme/sdlc-marketplace/issues',
    from: 'apm.yml', words: 'Owner: Web QA', confirmed: true, confirmWords: null, feedbackLabels: ['sflow-feedback', 'web-e2e-test-generation'] });
  assert.deepEqual(ga.lifecycleRecord, { state: 'ga', word: 'ga', source: 'lifecycle.yml', since: '2026-11-01', by: [STEWARDS],
    change: 'https://git.example.com/acme/sdlc-marketplace/pull/26', guarded: true, approvers: [STEWARDS], deprecation: null,
    words: 'Generally available since 1 Nov 2026', guardWords: 'The marketplace declares @acme/marketplace-stewards as the code owners of its lifecycle record.', notGuarded: false });
  const retired = byKey.get('market:acme/skill/old-checks');
  assert.deepEqual([retired.status, retired.readiness, retired.importable, retired.actions.install, retired.statusWords],
    ['not-installed', 'retired', false, undefined, 'Retired in the marketplace: no longer supported, so it is not installed here.']);
  assert.ok(retired.actions.preview, 'its text can still be read');
  assert.equal(byKey.get('market:acme/agent/qa-test-automation-agent').lifecycleRecord.words, 'Proposed by QA Guild on 16 Sep 2026; not yet approved');
  const lines = marketplaceCatalogLines(catalog);
  assert.match(lines.find((line) => line.includes('web-e2e-test-generation')), /^ {2}web-e2e-test-generation +Acme +Web QA +1\.0\.0-pdlc +not installed \(stable\)$/u);
  assert.ok(lines.includes('      Lifecycle: Approved by @acme/marketplace-stewards, the code owners of its lifecycle record, on 2 Oct 2026.'));
  assert.ok(lines.includes('      Lifecycle: Retired: no longer supported.'));
  assert.ok(!lines.some((line) => line.includes('Generally available')), 'no lifecycle line for a guarded ga item');
  assert.doesNotMatch(lines.join('\n'), COMMIT_ID);
  // Without the additions: nothing new but null and empty fields, and today's words [REQ-006, A1].
  const older = analyzeMarketplaceCatalog({ marketplaces: [{ id: 'acme', label: 'Acme', kind: 'repository', commit: 'e'.repeat(40), warning: null,
    items: repositoryItems({ skills: [{ name: 'web-e2e-test-generation', version: '1.0.0', tags: ['web'], pdlcTasks: [], lifecycleState: 'approved', sha256: '1'.repeat(64) }] }) }] });
  assert.deepEqual([older.items[0].owner, older.items[0].lifecycleRecord, older.items[0].channel, older.items[0].findings, older.items[0].lifecycle, older.items[0].readiness],
    [null, null, null, [], 'approved', 'ready']);
});

test('task offers: the plan line names the owner and the state; deprecated never offered; the trusted commit\'s state counts for a library skill [OMK:REQ-011, REQ-015]', () => {
  const composition = composeTask(BASE, { kind: 'fix' });
  const meta = fixtureMetadata('skills/web-e2e-test-generation');
  const e2e = (overrides = {}) => marketplaceSkillCandidate({ name: 'web-e2e-test-generation', tags: ['web'], pdlcTasks: ['e2e-testing'], version: '1.0.0', lifecycleState: 'ga',
    owner: meta.owner, lifecycleRecord: meta.lifecycleRecord, ...overrides }, 'acme');
  const offered = chooseTaskSkills(composition, { candidates: [e2e()], kinds: ['web'] });
  assert.deepEqual(offered.offers.map(({ id, owner, state }) => [id, owner, state]), [['web-e2e-test-generation', 'Web QA', null]]);
  assert.equal(planSkillWords(offered.byStep.implementation), ' (with web-e2e-test-generation from acme (Web QA), new here: add it?)');
  const beta = chooseTaskSkills(composition, { candidates: [e2e({ lifecycleRecord: { ...meta.lifecycleRecord, word: 'beta', state: 'early' } })], kinds: ['web'] });
  assert.equal(planSkillWords(beta.byStep.implementation), ' (with web-e2e-test-generation from acme (Web QA), beta and new here: add it?)');
  for (const word of ['deprecated', 'retired']) {
    assert.deepEqual(chooseTaskSkills(composition, { candidates: [e2e({ lifecycleRecord: { ...meta.lifecycleRecord, word, state: word } })], kinds: ['web'] }).offers, [], word);
  }
  // A library skill imported while approved: the marketplace's state at the commit trusted now is the one that counts.
  const skill = { id: 'web-e2e-test-generation', tags: [], sha256: 'x' };
  const imported = { source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'web-e2e-test-generation', tasks: ['e2e-testing'], tags: ['web'], lifecycleState: 'approved' } };
  const recorded = librarySkillCandidate(skill, imported);
  assert.deepEqual([recorded.lifecycle, recorded.state, recorded.lifecycleFrom], ['ready', 'approved', 'recorded']);
  const deprecated = librarySkillCandidate(skill, imported, { trusted: { name: 'web-e2e-test-generation', lifecycleState: 'ga', owner: meta.owner,
    lifecycleRecord: { ...meta.lifecycleRecord, word: 'deprecated', state: 'deprecated' } } });
  assert.deepEqual([deprecated.lifecycle, deprecated.state, deprecated.lifecycleFrom, deprecated.owner], ['retired', 'deprecated', 'trusted', 'Web QA']);
  assert.deepEqual(chooseTaskSkills(composition, { candidates: [deprecated], kinds: ['web'] }).skills, [], 'deprecated since: not used');
  assert.deepEqual(chooseTaskSkills(composition, { candidates: [recorded], kinds: ['web'] }).skills.map((entry) => entry.id), ['web-e2e-test-generation']);
});

test('the skill catalog: owner, lifecycle with who and when, channel; a library skill counts its marketplace\'s state now, or says it is the recorded one [OMK:REQ-011, REQ-015]', () => {
  const meta = fixtureMetadata('skills/web-e2e-test-generation');
  const deprecated = itemLifecycle({ file: parseLifecycleRecord({ state: 'deprecated', deprecation: { 'replaced-by': 'web-e2e-v2' }, history: [{ from: 'ga', to: 'deprecated',
    at: '2026-11-20', 'approved-by': [STEWARDS] }] }), guard: { covered: true, owners: [STEWARDS] } });
  const listed = { name: 'web-e2e-test-generation', version: '1.0.0-pdlc', description: 'Playwright tests.', tags: ['web'], pdlcTasks: ['e2e-testing'], lifecycleState: 'deprecated',
    owner: meta.owner, lifecycleRecord: deprecated, findings: [] };
  const input = (marketplace) => ({ library: [{ id: 'web-e2e-test-generation', label: 'web-e2e-test-generation', description: '', tags: [], sha256: 'x' }],
    imports: { 'library-skill:web-e2e-test-generation': { kind: 'library-skill', source: { kind: 'marketplace-skill', marketplace: 'acme', entry: 'web-e2e-test-generation',
      version: '1.0.0-pdlc', tasks: ['e2e-testing'], tags: ['web'], lifecycleState: 'approved' } } },
    marketplaces: [marketplace], definition: structuredClone(BASE), kinds: ['web'] });
  const read = analyzeSkillCatalog(input({ id: 'acme', label: 'Acme', kind: 'repository', channel: 'beta', warning: null, skills: [listed] }));
  const row = (catalog, key) => catalog.rows.find((entry) => entry.key === key);
  const library = row(read, 'library:web-e2e-test-generation');
  assert.deepEqual([library.lifecycle, library.readiness, library.owner.name, library.channel, library.lifecycleRecord.words, library.deprecatedInUse],
    ['deprecated', 'retired', 'Web QA', 'beta', 'Deprecated on 20 Nov 2026: use web-e2e-v2', null]);
  assert.deepEqual(row(read, 'market:acme/web-e2e-test-generation').channel, 'beta');
  const unread = analyzeSkillCatalog(input({ id: 'acme', label: 'Acme', kind: 'repository', warning: 'Marketplace acme could not be read.', skills: [] }));
  const kept = row(unread, 'library:web-e2e-test-generation');
  assert.deepEqual([kept.lifecycle, kept.readiness, kept.lifecycleRecord.recorded, kept.lifecycleRecord.words], ['approved', 'ready', true, 'Approved (as recorded when it was imported)']);
});

test('the conversion review shows the owner and the lifecycle record; the lifecycle finding fires only for proposed, early or unmarked, never ga [OMK:REQ-010, MCR §4.1]', () => {
  const MARKET = { id: 'acme', repository: '/srv/acme-marketplace', commit: 'c'.repeat(40) };
  const read = (source) => {
    const meta = fixtureMetadata(source);
    const name = path.posix.basename(source);
    const document = meta.own.kind === 'agent' ? 'agent.md' : 'SKILL.md';
    return { ...meta.own, name, source, owner: meta.owner, lifecycleRecord: meta.lifecycleRecord, findings: meta.findings, document: `${source}/${document}`,
      text: fixture(`${source}/${document}`), skills: meta.own.dependencies.map((dependency) => path.posix.basename(dependency.path ?? '')).filter(Boolean) };
  };
  const agent = read('agents/qa-test-automation-agent');
  const skills = agent.skills.map((skill) => read(`skills/${skill}`));
  const review = conversionReview(convertAgent({ marketplace: MARKET, agent, skills }));
  assert.equal(review.source.owner.words, 'Owner: QA Guild');
  assert.equal(review.source.lifecycle, 'Proposed by QA Guild on 16 Sep 2026; not yet approved');
  assert.deepEqual([review.source.lifecycleRecord.guarded, review.source.lifecycleRecord.change], [true, 'https://git.example.com/acme/sdlc-marketplace/pull/15']);
  assert.ok(review.feedback.some((entry) => entry.class === 'marketplace-lifecycle' && /record its approval in its lifecycle\.yml/u.test(entry.fix)));
  const markdown = conversionReviewMarkdown(review, { forPerson: true });
  assert.match(markdown, /^- Owner: QA Guild\.$/mu);
  assert.match(markdown, /^- Lifecycle: Proposed by QA Guild on 16 Sep 2026; not yet approved\. The marketplace declares @acme\/marketplace-stewards as the code owners of its lifecycle record\.$/mu);
  assert.doesNotMatch(markdown, /[a-f0-9]{12}/u, 'no commit for a person');
  assert.match(conversionReviewMarkdown(review), /^- Its lifecycle change: https:\/\/git\.example\.com\/acme\/sdlc-marketplace\/pull\/15$/mu);
  // The lifecycle finding by state: ga and approved raise none (it fired for ga before).
  const lifecycleFindingsOf = (overrides, marketplace = MARKET) => convertAgent({ marketplace, agent: { ...agent, lifecycleRecord: null, ...overrides }, skills })
    .findings.filter((entry) => entry.class === 'marketplace-lifecycle').map((entry) => entry.words);
  assert.deepEqual(lifecycleFindingsOf({ lifecycleState: 'ga' }), []);
  assert.deepEqual(lifecycleFindingsOf({ lifecycleState: 'approved' }), []);
  assert.deepEqual(lifecycleFindingsOf({ lifecycleState: 'deprecated' }), [], 'deprecated is shown where it is used, not as a conversion finding');
  assert.deepEqual(lifecycleFindingsOf({ lifecycleState: 'proposed' }), ['qa-test-automation-agent is proposed in the marketplace, not yet reviewed by its maintainers.']);
  assert.deepEqual(lifecycleFindingsOf({ lifecycleState: 'beta' }), ['qa-test-automation-agent is beta in the marketplace: approved for early use, and it may still change.']);
  assert.deepEqual(lifecycleFindingsOf({ lifecycleState: null }), ['qa-test-automation-agent has no lifecycle recorded in the marketplace, so nobody can see whether it was reviewed.']);
  assert.deepEqual(lifecycleFindingsOf({ lifecycleState: null }, null), [], 'an agent folder of its own is not a marketplace\'s');
  // The marketplace's own findings on its record reach the feedback.
  const jumped = conversionReview(convertAgent({ marketplace: MARKET, agent: { ...agent, findings: [{ class: 'marketplace-lifecycle-jump', words: 'It jumped.', fix: 'Move it in order.' }] }, skills }));
  assert.ok(jumped.feedback.some((entry) => entry.class === 'marketplace-lifecycle-jump' && entry.fix === 'Move it in order.'));
  // GitLab's new-issue form reads issue[title] and issue[description] (probe P4).
  const gitlab = feedbackIssue({ ...review, source: { ...review.source, sourceRepository: 'https://gitlab.example.com/team/agents' } }, 'The body.');
  const query = new URL(gitlab.url).searchParams;
  assert.deepEqual([query.get('issue[title]'), query.get('issue[description]'), query.get('title')], ['SFlow conversion feedback: qa-test-automation-agent 1.0.0-pdlc', 'The body.', null]);
  assert.equal(new URL(feedbackIssue(review, 'The body.').url).searchParams.get('body'), 'The body.', 'GitHub keeps title and body');
});

test('/sf-marketplace shows the owner, lifecycle and channel columns, and the deprecated-in-use words [OMK:REQ-015]', () => {
  const text = readFileSync(path.join(ROOT, 'plugin/skills/sflow-marketplace/SKILL.md'), 'utf8');
  for (const field of ['`owner.name`', '`lifecycleRecord.words`', '`channel`', '`deprecatedInUse.words`']) assert.ok(text.includes(field), field);
});

// ------------------------------------------------------------------------------------------------ import records

test('import records gain only optional fields under source, and the bundle reader and transfer review carry them unchanged [OMK:REQ-006, R8]', async (t) => {
  const [{ initializeDefinition }, { exportWorkflowBundle, planWorkflowImport, applyWorkflowImport }, { parseImportsLedger, renderImportsLedger }, { addReleaseWorkflow }] = await Promise.all([
    import('../src/config.mjs'), import('../src/workflow-transfer.mjs'), import('../src/imports-ledger.mjs'), import('./helpers/release-workflow-fixture.mjs')]);
  const repository = async (prefix) => {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix));
    t.after(() => rm(root, { recursive: true, force: true }));
    await initializeDefinition(root);
    return root;
  };
  const added = { owner: { team: 'release-tools', name: 'Release Tools' }, channel: 'stable', safety: { checker: 'sflow-text-checks/1', looked: [] } };
  const source = await repository('sflow-omk-transfer-source-');
  await addReleaseWorkflow(source, 'source');
  const lockPath = path.join(source, 'singularity/imports.lock.yml');
  const ledger = parseImportsLedger(await readFile(lockPath, 'utf8'));
  const key = 'skill:release-manager/store-checklist';
  ledger.imports[key].source = { ...ledger.imports[key].source, ...added };
  await writeFile(lockPath, renderImportsLedger(ledger));
  assert.deepEqual(parseImportsLedger(await readFile(lockPath, 'utf8')).imports[key].source, ledger.imports[key].source, 'the ledger reads and writes them as they are');
  const bundle = await exportWorkflowBundle(source, ['mobile-release']);
  assert.deepEqual(bundle.imports[key].source, ledger.imports[key].source, 'the bundle carries them');
  const target = await repository('sflow-omk-transfer-target-');
  const plan = await planWorkflowImport(target, bundle);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.unresolved));
  await applyWorkflowImport(target, bundle, { expectedPlanSha256: plan.planSha256 });
  const written = YAML.parse(await readFile(path.join(target, 'singularity/imports.lock.yml'), 'utf8')).imports[key].source;
  assert.deepEqual(written, ledger.imports[key].source, 'the target records them unchanged');
  // The same record imported again is the same import, not a conflict.
  const again = await planWorkflowImport(target, bundle);
  assert.equal(again.status, 'ready', JSON.stringify(again.unresolved));
});

// ------------------------------------------------------------------------------------------------ read, as Stories do

/** The sample marketplace with its seeded item, as a Git repository whose channels are branches. */
async function marketplaceRepository(t) {
  const directory = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-omk-market-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await copySampleMarketplace(path.join(directory, 'acme'), { seeded: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=Market Maintainer', '-c', 'user.email=maintainers@example.com', ...args], { cwd: repository, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'The marketplace');
  git('branch', 'channels/beta');
  git('branch', 'channels/stable');
  return { directory, repository, git, commit: git('rev-parse', 'HEAD') };
}

const WEB_PACKAGE = JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' }, dependencies: { react: '^18.3.1' } });
const json = (text) => JSON.parse(text);

test('read at the trusted commit: the catalog, browse, the skill catalog, the conversion review and a task show the owner, the lifecycle and the channel; a move changes what counts [OMK §5]', async (t) => {
  const acme = await marketplaceRepository(t);
  const e2eText = fixture('skills/web-e2e-test-generation/SKILL.md');
  const story = await journeyRepository(t, {
    files: {
      'package.json': WEB_PACKAGE,
      'singularity/skill-library/web-e2e-test-generation/SKILL.md': e2eText,
      'singularity/imports.lock.yml': YAML.stringify({ version: 1, imports: {
        'library-skill:web-e2e-test-generation': { kind: 'library-skill', target: { id: 'web-e2e-test-generation', path: 'singularity/skill-library/web-e2e-test-generation/SKILL.md' },
          sha256: sha(e2eText), source: { kind: 'marketplace-skill', marketplace: 'acme', repository: acme.repository, commit: acme.commit, entry: 'web-e2e-test-generation',
            version: '1.0.0-pdlc', tasks: ['e2e-testing', 'ui-test-automation'], tags: ['web', 'playwright'], lifecycleState: 'approved' } } } })
    },
    configure: (configuration) => { configuration.marketplaces = { acme: { label: 'Acme', repository: acme.repository, ref: 'channels/stable', commit: acme.commit } }; }
  });
  story.git('push', '-q', 'origin', 'main:sflow/config');
  // A listing kept by an older build (v2) is read again once [REQ-006].
  const keptAgents = path.join(story.root, '.git', 'singularity-flow', 'task-marketplace-agents');
  const keptFile = path.join(keptAgents, `${sha(`${acme.repository}\n${acme.commit}`)}.json`);
  await mkdir(keptAgents, { recursive: true });
  await writeFile(keptFile, JSON.stringify({ format: 'sflow-task-marketplace-agents/v2', repository: acme.repository, commit: acme.commit, agents: [], skills: [] }));

  const catalog = json(story.cli('marketplace', 'catalog', '--json'));
  assert.equal(JSON.parse(await readFile(keptFile, 'utf8')).format, 'sflow-task-marketplace-agents/v3');
  const byKey = new Map(catalog.items.map((item) => [item.key, item]));
  const e2e = byKey.get('market:acme/skill/web-e2e-test-generation');
  assert.deepEqual([e2e.status, e2e.owner.words, e2e.lifecycleRecord.words, e2e.lifecycleRecord.guarded, e2e.lifecycleRecord.change, e2e.channel],
    ['installed', 'Owner: Web QA', 'Generally available since 1 Nov 2026', true, 'https://git.example.com/acme/sdlc-marketplace/pull/26', 'stable']);
  assert.equal(byKey.get('market:acme/agent/qa-test-automation-agent').lifecycleRecord.words, 'Proposed by QA Guild on 16 Sep 2026; not yet approved');
  const seeded = byKey.get(`market:acme/skill/${SEEDED_ITEM}`);
  assert.deepEqual(seeded.findings.map((entry) => entry.class), ['marketplace-metadata', 'marketplace-lifecycle-mismatch', 'marketplace-lifecycle-jump',
    'marketplace-lifecycle-unguarded', 'marketplace-owner-unconfirmed']);
  assert.deepEqual([seeded.status, Boolean(seeded.actions.install), seeded.lifecycleRecord.notGuarded], ['not-installed', true, true], 'nothing is refused for its record');
  assert.ok(catalog.items.every((item) => item.deprecatedInUse === null && item.safety === null && item.use === null));
  assert.doesNotMatch(JSON.stringify(catalog), COMMIT_ID, 'no commit ID reaches the page');
  const text = story.cli('marketplace', 'catalog');
  assert.match(text, /^ {2}web-e2e-test-generation +Acme +Web QA +1\.0\.0-pdlc +installed \(stable\)$/mu);
  assert.match(text, /^ {6}Lifecycle: Generally available since 5 Oct 2026\. Not guarded by code owners\.$/mu);
  assert.match(text, /^ {6}For the marketplace: legacy-smoke-checks's lifecycle\.yml: history entry 2 moves it from proposed straight to ga/mu);
  assert.doesNotMatch(text, COMMIT_ID);
  // browse: an owner and lifecycle line under each entry, and the channel the trust reads.
  const browsed = story.cli('marketplace', 'browse', 'acme');
  assert.match(browsed, /\(.*, its stable channel\): 10 entries\./u);
  assert.match(browsed, /^ {9}Owner: Web QA · Lifecycle: Generally available since 1 Nov 2026 · The marketplace declares @acme\/marketplace-stewards as the code owners of its lifecycle record\.$/mu);
  const browsedJson = json(story.cli('marketplace', 'browse', 'acme', '--json'));
  assert.equal(browsedJson.marketplace.channel, 'stable');
  // The skill catalog.
  const skills = json(story.cli('skill', 'catalog', '--json'));
  const libraryRow = skills.rows.find((row) => row.key === 'library:web-e2e-test-generation');
  assert.deepEqual([libraryRow.lifecycle, libraryRow.owner.name, libraryRow.channel, libraryRow.lifecycleRecord.words], ['ga', 'Web QA', 'stable', 'Generally available since 1 Nov 2026']);
  // The conversion review of the proposed agent, as Workflow Studio and Copilot read it.
  const converted = json(story.cli('workflow', 'from-agent', 'acme/qa-test-automation-agent', '--json'));
  assert.deepEqual([converted.review.source.owner.words, converted.review.source.lifecycle, converted.review.source.lifecycleRecord.guardWords],
    ['Owner: QA Guild', 'Proposed by QA Guild on 16 Sep 2026; not yet approved', 'The marketplace declares @acme/marketplace-stewards as the code owners of its lifecycle record.']);
  // A task uses the library's copy while its marketplace says ga.
  const before = json(story.cli('work', 'fix the checkout button', '--kind', 'fix', '--json'));
  assert.match(before.plan, /^Plan: code \(with web-e2e-test-generation\) → tests\./u);
  assert.deepEqual(before.notes ?? [], []);

  // The marketplace deprecates it, and retires android-unit-test; the repository moves its trust, as a reviewed change does.
  const record = async (relative, state, entries) => writeFile(path.join(acme.repository, relative),
    `${(await readFile(path.join(acme.repository, relative), 'utf8')).replace(/^state: .*$/mu, `state: ${state}`)}${entries}`);
  await record('skills/web-e2e-test-generation/lifecycle.yml', 'deprecated', [
    '  - from: ga', '    to: deprecated', '    at: 2026-11-20', `    approved-by: ["${STEWARDS}"]`, '    change: https://git.example.com/acme/sdlc-marketplace/pull/57', ''].join('\n'));
  await writeFile(path.join(acme.repository, 'skills/web-e2e-test-generation/lifecycle.yml'),
    `${await readFile(path.join(acme.repository, 'skills/web-e2e-test-generation/lifecycle.yml'), 'utf8')}deprecation:\n  replaced-by: web-e2e-test-generation-v2\n  sunset: 2027-03-31\n`);
  await record('skills/android-unit-test/lifecycle.yml', 'retired', ['  - from: approved', '    to: deprecated', '    at: 2026-11-10', `    approved-by: ["${STEWARDS}"]`,
    '  - from: deprecated', '    to: retired', '    at: 2026-11-21', `    approved-by: ["${STEWARDS}"]`, ''].join('\n'));
  for (const [relative, state] of [['skills/web-e2e-test-generation/apm.yml', 'deprecated'], ['skills/android-unit-test/apm.yml', 'retired']]) {
    const file = path.join(acme.repository, relative);
    await writeFile(file, (await readFile(file, 'utf8')).replace(/^lifecycle-state: .*$/mu, `lifecycle-state: ${state}`));
  }
  acme.git('commit', '-qam', 'lifecycle: web-e2e-test-generation ga → deprecated; android-unit-test retired');
  acme.git('branch', '-f', 'channels/stable', 'main');
  const moved = acme.git('rev-parse', 'HEAD');
  const trusted = YAML.parse(await story.read('singularity/workflow.yml'));
  trusted.marketplaces.acme.commit = moved;
  await story.write('singularity/workflow.yml', YAML.stringify(trusted));
  story.git('commit', '-qam', 'Trust the newer marketplace commit');
  story.git('push', '-q', 'origin', 'main:sflow/config');

  const after = new Map(json(story.cli('marketplace', 'catalog', '--json')).items.map((item) => [item.key, item]));
  assert.equal(after.get('market:acme/skill/web-e2e-test-generation').lifecycleRecord.words,
    'Deprecated on 20 Nov 2026: use web-e2e-test-generation-v2 (supported until 31 Mar 2027)');
  const retired = after.get('market:acme/skill/android-unit-test');
  assert.deepEqual([retired.status, retired.actions.install, retired.importable, retired.lifecycleRecord.words], ['not-installed', undefined, false, 'Retired: no longer supported']);
  assert.deepEqual(after.get('market:acme/skill/web-e2e-test-generation').findings, [], 'a deprecation in order is no finding');
  const refused = story.raw(['import', 'preview', 'market:acme/android-unit-test', '--as', 'skill', '--json']);
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /MARKETPLACE_ITEM_RETIRED/u);
  // Deprecated since it was imported approved: the task no longer uses it [REQ-011].
  const now = json(story.cli('work', 'fix the checkout button', '--kind', 'fix', '--json'));
  assert.doesNotMatch(now.plan, /web-e2e-test-generation/u);
  assert.equal(now.offers, undefined);
  const skillsNow = json(story.cli('skill', 'catalog', '--json'));
  assert.deepEqual(['lifecycle', 'readiness'].map((field) => skillsNow.rows.find((row) => row.key === 'library:web-e2e-test-generation')[field]), ['deprecated', 'retired']);
  assert.equal(story.git('status', '--porcelain'), '', 'reading writes nothing in the checkout');
  const kept = await readdir(path.join(story.root, '.git', 'singularity-flow', 'task-marketplace-skills'));
  for (const file of kept.filter((name) => !name.startsWith('index-'))) {
    assert.equal(JSON.parse(await readFile(path.join(story.root, '.git', 'singularity-flow', 'task-marketplace-skills', file), 'utf8')).format, 'sflow-task-marketplace-skills/v3');
  }
});
