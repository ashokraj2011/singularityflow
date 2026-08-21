import test from 'node:test';
import assert from 'node:assert/strict';

import {
  baseBranchRecord, baseRefusalReport, branchChoices, capabilityRepositories,
  parseBaseSelection, parseRemoteHeads, resolveCapabilityBase
} from '../src/capability-branches.mjs';

const WORKSPACE = {
  repositories: {
    'payments-api': { id: 'payments-api', capabilities: ['payments'], defaultBranch: 'main' },
    'payments-web': { id: 'payments-web', capabilities: ['payments'], defaultBranch: 'main' },
    'ledger-core': { id: 'ledger-core', capabilities: ['payments', 'ledger'], defaultBranch: 'main' },
    'notifications': { id: 'notifications', capabilities: ['payments'], defaultBranch: 'main' },
    'audit-sink': { id: 'audit-sink', capabilities: ['payments'], defaultBranch: 'main' },
    'unrelated': { id: 'unrelated', capabilities: ['search'], defaultBranch: 'main' }
  }
};
const PUBLISHED = {
  'payments-api': ['main', 'develop', 'release/24.3'],
  'payments-web': ['main', 'develop', 'release/24.3'],
  'ledger-core': ['main', 'develop', 'release/24.3'],
  'notifications': ['main', 'develop'],
  'audit-sink': ['main']
};

test('a capability names its own repositories and nobody else’s', () => {
  assert.deepEqual(capabilityRepositories(WORKSPACE, 'payments').map((entry) => entry.id),
    ['payments-api', 'payments-web', 'ledger-core', 'notifications', 'audit-sink']);
  // A repository can belong to more than one capability without leaking the others in.
  assert.deepEqual(capabilityRepositories(WORKSPACE, 'ledger').map((entry) => entry.id), ['ledger-core']);
});

test('an unknown capability says which ones exist', () => {
  // The likeliest cause is a typo, and the list turns a dead end into a correction.
  assert.throws(() => capabilityRepositories(WORKSPACE, 'payment'),
    /No repository in this workspace declares capability 'payment'.*ledger, payments, search/s);
});

test('remote heads are read from git’s own output, tags and junk ignored', () => {
  const output = [
    'a1b2c3\trefs/heads/main',
    'd4e5f6\trefs/heads/release/24.3',
    '99aabb\trefs/tags/v24.3',
    '',
    'ccddee\trefs/heads/main'
  ].join('\n');
  assert.deepEqual(parseRemoteHeads(output), ['main', 'release/24.3']);
  assert.deepEqual(parseRemoteHeads(''), []);
});

test('the choices put branches everyone publishes first, and name who lacks the rest', () => {
  const choices = branchChoices(PUBLISHED);
  assert.deepEqual(choices.map((entry) => [entry.branch, entry.present]),
    [['main', 5], ['develop', 4], ['release/24.3', 3]]);
  assert.equal(choices[0].everywhere, true);
  // A partial branch stays on the list: choosing it and being told what is missing is a reasonable
  // next step, and hiding it would make the refusal the first mention of it.
  assert.deepEqual(choices.at(-1).missingFrom, ['audit-sink', 'notifications']);
});

test('--from-branch takes one branch for all, and repository=branch for one', () => {
  assert.deepEqual(parseBaseSelection(['release/24.3']), { all: 'release/24.3', overrides: {} });
  const mixed = parseBaseSelection(['release/24.3', 'notifications=main', 'audit-sink=main']);
  assert.equal(mixed.all, 'release/24.3');
  assert.deepEqual(mixed.overrides, { notifications: 'main', 'audit-sink': 'main' });
  // Written in the order a person types it: the general value first, overrides after.
  assert.equal(parseBaseSelection(['main', 'ledger-core=develop']).overrides['ledger-core'], 'develop');
  assert.throws(() => parseBaseSelection(['notifications=']), /must be a branch name, or repository=branch/);
});

test('a branch published everywhere resolves for every repository', () => {
  const resolution = resolveCapabilityBase({ repositories: PUBLISHED, selection: parseBaseSelection(['main']) });
  assert.equal(resolution.usable, true);
  assert.deepEqual(Object.keys(resolution.resolved).sort(),
    ['audit-sink', 'ledger-core', 'notifications', 'payments-api', 'payments-web']);
  assert.equal(resolution.resolved['audit-sink'].source, 'requested');
  assert.equal(baseRefusalReport(resolution), null);
});

test('a branch missing anywhere refuses, and the refusal names every repository', () => {
  const resolution = resolveCapabilityBase({ repositories: PUBLISHED, selection: parseBaseSelection(['release/24.3']) });
  assert.equal(resolution.usable, false);
  assert.deepEqual(resolution.missing.map((entry) => entry.repository), ['audit-sink', 'notifications']);

  const report = baseRefusalReport(resolution, { capability: 'payments' });
  assert.match(report, /does not exist in 2 of 5 capability repositories/);
  // The three that are fine are listed too: that is what tells a reader whether they picked the
  // wrong branch or are looking at the wrong capability.
  for (const ok of ['payments-api', 'payments-web', 'ledger-core']) assert.match(report, new RegExp(`${ok} — release/24\\.3`));
  assert.match(report, /notifications — missing, has develop, main/);
  assert.match(report, /--from-branch release\/24\.3 --from-branch audit-sink=main --from-branch notifications=develop/);
});

test('an override rescues the repositories that differ', () => {
  const resolution = resolveCapabilityBase({
    repositories: PUBLISHED,
    selection: parseBaseSelection(['release/24.3', 'notifications=develop', 'audit-sink=main'])
  });
  assert.equal(resolution.usable, true);
  assert.equal(resolution.resolved['payments-api'].source, 'requested');
  assert.equal(resolution.resolved['notifications'].source, 'override');
  assert.equal(resolution.resolved['notifications'].branch, 'develop');
});

test('an override for a branch that is also missing still refuses', () => {
  // The escape hatch is an explicit choice, not a way to skip the check.
  const resolution = resolveCapabilityBase({
    repositories: PUBLISHED, selection: parseBaseSelection(['main', 'audit-sink=release/24.3'])
  });
  assert.equal(resolution.usable, false);
  assert.equal(resolution.missing[0].reason, 'override branch not published');
});

test('an override naming a repository outside the capability is refused, not ignored', () => {
  const resolution = resolveCapabilityBase({
    repositories: PUBLISHED, selection: parseBaseSelection(['main', 'serch=main'])
  });
  assert.equal(resolution.usable, false);
  assert.deepEqual(resolution.unknownOverrides, ['serch']);
  assert.match(baseRefusalReport(resolution, { capability: 'payments' }),
    /names a repository outside capability 'payments': serch/);
});

test('with no branch asked for, each repository falls back to its own recorded default', () => {
  const resolution = resolveCapabilityBase({
    repositories: PUBLISHED,
    selection: parseBaseSelection([]),
    defaults: Object.fromEntries(Object.keys(PUBLISHED).map((id) => [id, 'main']))
  });
  assert.equal(resolution.usable, true);
  assert.equal(resolution.resolved['payments-api'].source, 'default');
});

test('a repository with no default and no request is named, not silently skipped', () => {
  const resolution = resolveCapabilityBase({ repositories: { alpha: ['main'] }, selection: parseBaseSelection([]) });
  assert.equal(resolution.usable, false);
  assert.equal(resolution.missing[0].reason, 'no base branch');
  assert.match(baseRefusalReport(resolution), /have no base branch to start from/);
});

test('the record keeps the per-repository truth, not just the branch that was typed', () => {
  const resolution = resolveCapabilityBase({
    repositories: PUBLISHED,
    selection: parseBaseSelection(['release/24.3', 'notifications=develop', 'audit-sink=main'])
  });
  const record = baseBranchRecord(resolution, { capability: 'payments', selectedAt: '2026-08-14T00:00:00.000Z' });
  assert.equal(record.requested, 'release/24.3');
  assert.equal(record.repositories['notifications'].branch, 'develop');
  assert.equal(record.repositories['notifications'].source, 'override');
  assert.equal(record.repositories['payments-api'].source, 'requested');
  // "Four on it, one overridden" must not be recordable as "all five on release/24.3".
  assert.notEqual(record.repositories['notifications'].branch, record.requested);
});

test('an unusable resolution is never recorded', () => {
  const resolution = resolveCapabilityBase({ repositories: PUBLISHED, selection: parseBaseSelection(['release/24.3']) });
  assert.throws(() => baseBranchRecord(resolution), /unusable base resolution is never recorded/);
});

/**
 * The surfaces, checked where they are actually wired rather than by re-testing the resolver.
 * The defect this guards is the one this codebase keeps producing: a computation that is written,
 * validated, and never reaches a caller.
 */
import { readFile } from 'node:fs/promises';
const source = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('every clone path that had a hard-coded default branch now accepts the capability base', async () => {
  // `start`, `story fetch`, and the governed initiative materialization were three separate places
  // that each decided a base branch on their own.
  const cli = await source('src/cli.mjs');
  assert.match(cli, /storyBaseForRepository\(root, \{/, 'start does not resolve an explicit Story base');
  assert.match(cli, /const baseAtStart = storyBase\.localBase/, 'start ignores the resolved base');

  const story = await source('src/commands/story.mjs');
  assert.match(story, /capabilityBaseForRepository\(target, \{/, 'story fetch does not resolve a capability base');
  assert.match(story, /base: capabilityBase\?\.localBase \?\? repository\.defaultBranch/, 'story fetch ignores it');

  const initiative = await source('src/initiative-repositories.mjs');
  assert.match(initiative, /capabilityBase\?\.repositories\?\.\[repository\.id\]\?\.branch \?\? repository\.defaultBranch/,
    'the initiative path still hard-codes each repository default');
  // The lead repository is not overridable: branching from the epic branch is governance.
  assert.match(initiative, /if \(isLeadRepository\(root, repository\)\) return initiative\.initiative\.branch/);
});

test('merge state uses the branch a Story was recorded as cut from, not a fresh computation', async () => {
  // Recomputing asks what the base would be today; a Story cut from a release line would then be
  // compared against main and report unmerged forever.
  const initiative = await source('src/initiative-repositories.mjs');
  assert.match(initiative, /const parentBranch = story\.parentBranch \?\? parentBranchFor\(root, repository, initiative\);/);
});

test('the editor can list the branches, because it cannot answer a prompt', async () => {
  const cli = await source('src/cli.mjs');
  assert.match(cli, /subcommand === 'branches'/, 'there is no way for a webview to fetch the choices');
  const registry = await source('src/command-registry.mjs');
  // Listing branches reads remotes and must never be classified as a model operation.
  assert.match(registry, /WORKSPACE_NEVER_OPERATIONS = new Set\(\[\s*\n\s*'branches'/);

  const panel = await source('apps/vscode/src/views/intake-panel.ts');
  assert.match(panel, /\['workspace', 'branches', '--json'\]/, 'the intake panel never asks for the choices');
  const form = await source('apps/vscode/src/views/intake-form.ts');
  assert.match(form, /form\.baseBranch \? \['--from-branch', form\.baseBranch\] : \[\]/,
    'the intake form collects a base branch and does not pass it');
  // Every Story source carries it: tracked/Jira, GitHub Issue, and manual intake use distinct args.
  assert.equal((form.match(/\.\.\.capabilityBase/g) ?? []).length, 3);
});
