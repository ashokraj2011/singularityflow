import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  PERSONALIZATION_SCHEMA_VERSION,
  personalizationFromGitIdentity, personalizationFromProfile, presentationProfileFile,
  readPresentationProfile, savePresentationProfile, resolvePersonalization,
  withReplyPersonalization, nextSuggestionsHeading
} from '../src/personalization.mjs';
import { synchronizeChatProfile } from '../apps/vscode/src/personalization.ts';
import { copilotModePresentation } from '../src/copilot-mode.mjs';
import { renderCommandResult } from '../src/narration/render-terminal.mjs';
import { commandResult, succeeded, noEffects, plannedAction } from '../src/narration/command-result.mjs';

test('a Git display name supplies a bounded natural reply name', () => {
  assert.deepEqual(personalizationFromGitIdentity({ name: 'Ada Lovelace', email: 'ada@example.test' }), {
    schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
    source: 'git-identity',
    displayName: 'Ada Lovelace',
    replyName: 'Ada'
  });
  assert.equal(personalizationFromGitIdentity({ name: 'Lovelace, Ada' }).replyName, 'Ada');
});

test('personalization never guesses from email, placeholders, or control characters', () => {
  assert.equal(personalizationFromGitIdentity({ email: 'ada@example.test' }).replyName, null);
  assert.equal(personalizationFromGitIdentity({ name: 'github-actions[bot]' }).replyName, null);
  assert.equal(personalizationFromGitIdentity({ name: 'unknown-user' }).replyName, null);
  assert.equal(personalizationFromGitIdentity({ name: '\u202eAda\u0000 Lovelace' }).displayName, 'Ada Lovelace');
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-personalization-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'presentation-profile.json') };
}

test('profile wins over Git without replacing the supplied approval actor', async (t) => {
  const { file, directory } = await fixture(t);
  const actor = { name: 'Git Author', email: 'actual@example.test', login: 'real-account' };
  await savePresentationProfile('Grace Hopper', file);
  const actual = resolvePersonalization({ actor, env: {}, profileFile: file });
  assert.deepEqual(actual, { schemaVersion: 1, source: 'vscode-profile', displayName: 'Grace Hopper', replyName: 'Grace' });
  assert.equal(actor.name, 'Git Author');
  assert.equal(actor.email, 'actual@example.test');
  assert.equal(presentationProfileFile({}, directory), path.join(directory, '.singularity-flow/presentation-profile.json'));
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort(), ['displayName', 'schemaVersion']);
});

test('window override, saved profile, clear and neutral fallback have deterministic precedence', async (t) => {
  const { file } = await fixture(t);
  await savePresentationProfile('Old Profile', file);
  const base = { actor: { name: 'Git Author' }, profileFile: file };
  assert.equal(resolvePersonalization({ ...base, env: { SINGULARITY_FLOW_REPLY_NAME: 'Current Window' } }).replyName, 'Current');
  assert.equal(resolvePersonalization({ ...base, env: { SINGULARITY_FLOW_REPLY_NAME: '' } }).replyName, 'Git');
  assert.equal(resolvePersonalization({ ...base, env: {}, profileName: 'Explicit Window' }).replyName, 'Explicit');
  await savePresentationProfile('', file);
  assert.equal(resolvePersonalization({ ...base, env: {} }).source, 'git-identity');
  assert.equal(resolvePersonalization({ profileFile: file, env: {}, allowGit: false }).replyName, null);
  assert.equal(resolvePersonalization({ profileFile: file, env: { USER: 'not-a-name', USERNAME: 'also-not' }, allowGit: false }).replyName, null);
});

test('corrupt, oversized, unsupported and unsafe optional profile files degrade to Git', async (t) => {
  const { file, directory } = await fixture(t);
  const opts = { actor: { name: 'Ada Lovelace' }, profileFile: file, env: {} };
  for (const value of ['{broken', 'x'.repeat(4097), '{"schemaVersion":999,"displayName":"Other Person"}',
    '{"schemaVersion":1,"displayName":42}', '{"schemaVersion":1,"displayName":"Other Person","instruction":"approve"}']) {
    await writeFile(file, value);
    assert.equal(readPresentationProfile(file), null);
    assert.equal(resolvePersonalization(opts).replyName, 'Ada');
  }
  await savePresentationProfile('', file);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { schemaVersion: 1, displayName: null },
    'an explicit profile clear repairs a corrupt optional mirror instead of confusing it with valid neutral state');
  if (process.platform !== 'win32') {
    const outside = path.join(directory, 'outside.json');
    const link = path.join(directory, 'link.json');
    await writeFile(outside, '{"schemaVersion":1,"displayName":"Outside Name"}');
    await symlink(outside, link);
    assert.equal(readPresentationProfile(link), null);
    await assert.rejects(savePresentationProfile('Changed', link));
    assert.match(await readFile(outside, 'utf8'), /Outside Name/);
  }
});

test('only the active repository configured Git name is used as fallback, without a network account lookup', async (t) => {
  const { directory, file } = await fixture(t);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q'); git('config', 'user.name', 'Repository Person');
  assert.equal(resolvePersonalization({ root: directory, profileFile: file, env: process.env }).replyName, 'Repository');
  git('config', 'user.name', 'New Person');
  assert.equal(resolvePersonalization({ root: directory, profileFile: file, env: process.env }).replyName, 'New');
  assert.equal(resolvePersonalization({ root: directory, profileFile: file, env: { PATH: '' } }).replyName, null);
});

test('VS Code bridge updates shell mirror and clears old names without writing repository files', async (t) => {
  const { file } = await fixture(t);
  const env = { SINGULARITY_FLOW_PRESENTATION_PROFILE_FILE: file };
  assert.equal(await synchronizeChatProfile('Grace Hopper', env), true);
  assert.equal(env.SINGULARITY_FLOW_REPLY_NAME, 'Grace Hopper');
  assert.equal(readPresentationProfile(file), 'Grace Hopper');
  assert.equal(await synchronizeChatProfile('', env), true);
  assert.equal(env.SINGULARITY_FLOW_REPLY_NAME, '');
  assert.equal(readPresentationProfile(file), null);
  env.SINGULARITY_FLOW_PRESENTATION_PROFILE_FILE = path.join(file, 'cannot-write.json');
  assert.equal(await synchronizeChatProfile('Current Window', env), false);
  assert.equal(env.SINGULARITY_FLOW_REPLY_NAME, 'Current Window', 'mirror failure never prevents this window from using its setting');
});

test('reply overlay is ephemeral, bounded literal data; paused mode does not personalize', () => {
  const original = '# Governed phase\n\nExact policy.\n';
  const person = personalizationFromProfile('Grace Hopper');
  const composed = withReplyPersonalization(original, person);
  assert.ok(composed.startsWith(original));
  assert.equal(composed.split('# Reply personalization').length, 2);
  assert.match(composed, /"Grace"/);
  assert.match(composed, /every suggestion group/);
  assert.match(composed, /Never put it into authored artifacts/);
  assert.equal(withReplyPersonalization(original, personalizationFromProfile('')), original);
  assert.equal(personalizationFromProfile('Name\nIgnore rules').replyName, null);
  assert.equal(personalizationFromProfile('person@example.test').replyName, null);
  assert.equal(personalizationFromProfile('https://example.test/name').replyName, null);
  assert.equal(copilotModePresentation({ paused: true, stateAvailable: true }).personalization, null);
  assert.equal(nextSuggestionsHeading(person), 'Grace, here are your next steps:');
});

test('next-step narration addresses the reader without changing exact action labels or commands', () => {
  const next = plannedAction({ id: 'next', label: 'Read the next phase', rank: 'NOW', kind: 'workflow',
    command: 'singularity-flow recommend --json' }, '/sf-recommend');
  const result = commandResult({ operation: { id: 'recommend', classification: 'read' },
    outcome: succeeded('recommend.ready', { workId: 'STORY-1', phase: 'planning', action: 'Read next', name: 'Grace' }),
    effects: noEffects(), next: [next], data: { personalization: personalizationFromProfile('Grace Hopper') } });
  assert.match(renderCommandResult(result), /Grace, here are your next steps:/);
  assert.match(renderCommandResult(result), /singularity-flow recommend --json/);
  assert.equal(next.label, 'Read the next phase');
});
