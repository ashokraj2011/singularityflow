/**
 * The two channel vocabularies that had no list. `[UXH:REQ-061]` `[UXH:REQ-051]` `[INT:CON-010]`
 *
 * `warnings[]` and `restState` were both open: warnings drew from the same flat 106-code catalog as
 * `why[]`, so the two channels `[UXH:REQ-061]` keeps apart were interchangeable in practice, and
 * `restState` was an unvalidated string in a contract whose premise is that nothing is prose.
 *
 * These tests are the pair of that: every code a producer actually emits must be catalogued as the
 * kind of thing it is, and every state must have somewhere to be rendered from. Both were written
 * after the enforcement found a producer the first enumeration had missed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REASON_CODES, WARNING_CODES, isWarningCode } from '../src/gateway/catalog.mjs';
import { REST_STATES, noEffects, sflowResult } from '../src/gateway/result.mjs';
import { RESULT_MESSAGES } from '../src/gateway/messages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const view = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);

const base = {
  kind: 'read',
  operation: { id: 'test.operation', classification: 'read' },
  outcome: { status: 'succeeded', messageId: 'gateway.read' },
  effects: noEffects(),
  restState: 'informational'
};

test('every warning code is in the reason catalog, and none is a duplicate', () => {
  const orphans = WARNING_CODES.filter((code) => !REASON_CODES.includes(code));
  assert.deepEqual(orphans, [], `warning codes missing from REASON_CODES: ${orphans.join(', ')}`);
  assert.equal(new Set(WARNING_CODES).size, WARNING_CODES.length);
});

test('every warning code has a sentence, like every other code', () => {
  const mute = WARNING_CODES.filter((code) => !RESULT_MESSAGES[code]);
  assert.deepEqual(mute, [], `warning codes with no message: ${mute.join(', ')}`);
});

test('a reason code cannot be smuggled into the warning channel', () => {
  /**
   * The check that gives the enumeration teeth.
   *
   * `home.active-work-leads` is a perfectly good code and belongs in `why[]`. Accepting it here
   * would mean the two channels are one, and a reader told only "why" cannot then ask what could
   * not be established — which is the whole reason `[UXH:REQ-061]` separates them.
   */
  assert.throws(
    () => sflowResult({ ...base, warnings: [{ code: 'home.active-work-leads', source: 'lifecycle' }] }),
    /is a reason code rather than a warning/
  );
  assert.ok(isWarningCode('home.briefing-unavailable'));
  assert.equal(isWarningCode('home.active-work-leads'), false);
});

test('a legitimate warning still builds, with its source and slots intact', () => {
  const result = sflowResult({
    ...base,
    warnings: [{ code: 'work.single-repository-scope', source: 'unavailable', slots: { repository: 'calc' } }]
  });
  assert.equal(result.warnings[0].code, 'work.single-repository-scope');
  assert.equal(result.warnings[0].slots.repository, 'calc');
});

test('every warning a planner actually emits is catalogued as a warning', async () => {
  /**
   * Producers, not the list, are the source of truth.
   *
   * The first enumeration of `WARNING_CODES` had four entries and the real number is ten — the
   * enforcement caught `readiness.partial-inputs` on the first test run, because a grep for one
   * spelling of "warnings:" missed six planners that build the array a different way. Reading it
   * back out of the source is what makes the list complete rather than merely plausible.
   */
  const planners = path.join(root, 'src', 'gateway', 'planners');
  const { readdir } = await import('node:fs/promises');
  const emitted = new Set();
  for (const name of await readdir(planners)) {
    if (!name.endsWith('.mjs')) continue;
    const source = readFileSync(path.join(planners, name), 'utf8');
    // Every warning record carries `source: 'unavailable'` or sits in a `warnings` array; the
    // reliable marker across both spellings is the code beside a source on a warnings-bound object.
    for (const match of source.matchAll(/warnings[\s\S]{0,400}?code: '([^']+)'/g)) emitted.add(match[1]);
  }
  const uncatalogued = [...emitted].filter((code) => REASON_CODES.includes(code) && !isWarningCode(code));
  assert.deepEqual(uncatalogued, [],
    `planners emit these into warnings[] without cataloguing them as warnings: ${uncatalogued.join(', ')}`);
});

test('restState is enumerated, and prose is refused', () => {
  assert.ok(REST_STATES.length >= 4);
  for (const state of REST_STATES) {
    assert.ok(sflowResult({ ...base, restState: state }), `${state} is a legal rest state`);
  }
  assert.throws(() => sflowResult({ ...base, restState: 'nothing left to do' }),
    /is not one of/);
});

test('every rest state has its own sentence on the card', () => {
  /**
   * The failure this replaces: a two-branch ternary over a three-valued field, so `complete` and
   * `informational` rendered identical words — "you are done" and "there was nothing to say" told
   * to the reader as the same sentence.
   */
  const page = readFileSync(view('result-card-page.ts'), 'utf8');
  const block = /const REST_SENTENCES[\s\S]*?\}\);/.exec(page);
  assert.ok(block, 'the card declares a sentence per rest state');
  // A hyphenated state has to be quoted as an object key, so the closing quote sits before the
  // colon — matching only the bare form would report a state that is in fact rendered.
  const missing = REST_STATES.filter((state) => !new RegExp(`\\b${state}'?:`).test(block[0]));
  assert.deepEqual(missing, [], `rest states with no sentence on the card: ${missing.join(', ')}`);

  const sentences = [...block[0].matchAll(/: '([^']+)'/g)].map((match) => match[1]);
  assert.equal(new Set(sentences).size, sentences.length,
    'two rest states share a sentence, which is the conflation this replaced');
});

test('a capability this build lacks rests as unavailable, not as blocked', async () => {
  /**
   * "You may not" and "this build cannot" send a reader to different places, and nineteen
   * registered operations have no planner in any build. Every kernel refusal said `blocked`.
   */
  const { createGatewayKernel } = await import('../src/gateway/kernel.mjs');
  const { gatewayRegistry } = await import('../src/gateway/operations.mjs');
  const { DEFAULT_GATEWAY_POLICY } = await import('../src/gateway/policy.mjs');
  const { createHandleAuthority } = await import('../src/gateway/handles.mjs');

  const registry = gatewayRegistry();
  const kernel = createGatewayKernel({
    registry,
    policyLayers: [DEFAULT_GATEWAY_POLICY],
    // A host with no planners at all: every operation is one this build cannot serve.
    planners: new Map(),
    binding: {
      workspaceId: null, repository: '/tmp', branch: 'main', subjectKind: null, subjectId: null,
      sourceCommit: null, worktreeHash: null, lifecycleRevision: null,
      policyHash: 'sha256:test', registryHash: 'test', actorId: 'dev@example.test', hostSessionId: 's'
    },
    handles: createHandleAuthority({ now: () => 0 }),
    readOnly: true
  });

  const resolution = await kernel.resolve({ utterance: 'home' });
  const envelope = await kernel.read({ resolutionId: resolution.next[0].handle });
  assert.equal(envelope.why[0].code, 'gateway.planner-unavailable');
  assert.equal(envelope.restState, 'unavailable',
    'a missing planner is an absent capability, not a withheld permission');
});

test('the cross-workspace gap says how much is elsewhere, and does not count it as zero', async () => {
  /**
   * "The cross-workspace briefing is unavailable" told a reader nothing about whether *elsewhere*
   * meant no other workspaces or twelve — which are completely different situations to be in while
   * looking at a home that covers one. `[INT:REQ-172]`
   *
   * The count is cheap and real; the *work* in those workspaces is `not-checked`, never `0`.
   * Rendering zero would assert the other workspaces are empty on the evidence of nobody having
   * opened them — the same conflation the worktree read already refuses to make.
   */
  const { homeOverviewResult } = await import('../src/gateway/planners/home-overview.mjs');

  const counted = homeOverviewResult({
    workspace: { id: 'local--calc', name: 'calc' },
    records: { groups: {} },
    otherWorkspaces: 3
  });
  const gap = counted.warnings.find((entry) => entry.code === 'home.briefing-unavailable');
  assert.equal(gap.slots.others, '3');
  assert.equal(counted.data.crossWorkspace.count, 3);
  assert.equal(counted.data.crossWorkspace.lookup, 'resolved');
  assert.equal(counted.data.crossWorkspace.work, 'not-checked',
    'the count of workspaces is known; what is in them is not');

  // An unreadable registry is "nobody could tell", not "you have one workspace".
  const unknown = homeOverviewResult({
    workspace: { id: 'local--calc', name: 'calc' },
    records: { groups: {} },
    otherWorkspaces: null
  });
  assert.equal(unknown.warnings.find((entry) => entry.code === 'home.briefing-unavailable').slots.others, 'unknown');
  assert.equal(unknown.data.crossWorkspace.lookup, 'not-checked');
});
