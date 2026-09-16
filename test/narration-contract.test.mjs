/**
 * Conformance for the narration contract.
 *
 * These are the clauses that have to be mechanical rather than aspirational, because every one of
 * them is a way for narration to start lying: reassurance that outlives the truth it described,
 * prose smuggled into a data field, a refusal that stops someone with no way forward.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  action, assertContinuation, because, commandResult, effects, failed, noEffects, noop,
  preservedEverything, refused, succeeded, validateCommandResult
} from '../src/narration/command-result.mjs';
import { MESSAGES, REASONS, preservingMessageIds } from '../src/narration/messages.mjs';
import { renderCommandResult } from '../src/narration/render-terminal.mjs';
import { renderCommandResultJson } from '../src/narration/render-json.mjs';
import { attachContinuation, remediationActions } from '../src/narration/continuation.mjs';
import {
  LEGACY_NARRATION_COMMANDS, MAX_LEGACY_NARRATION_COMMANDS,
  MIGRATED_NARRATION_COMMANDS, validateNarrationMigrationStatus
} from '../src/narration/migration-status.mjs';

const OPERATION = { id: 'submit', classification: 'mutation' };
const SUBJECT = { kind: 'story', id: 'PAY-1187' };

function base(overrides = {}) {
  return commandResult({
    operation: OPERATION,
    subject: SUBJECT,
    outcome: refused('submit.refused', { phase: 'requirements' }),
    effects: noEffects(),
    why: [because('sequence.gate-failed', 'gate', { slots: { failed: 2, total: 8 } })],
    next: [action({ id: 'x', label: 'Do the thing', command: 'singularity-flow validate' })],
    restState: null,
    ...overrides
  });
}

test('NCL-002 the command result is not a reference envelope', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/command-result.schema.json', import.meta.url), 'utf8'));
  const reference = JSON.parse(await readFile(new URL('../schemas/reference-envelope.schema.json', import.meta.url), 'utf8'));
  assert.notEqual(schema.$id, reference.$id, 'the two contracts are distinct documents');
  // Evidence transport belongs to the reference envelope; explanation and continuation do not.
  for (const field of ['why', 'next', 'effects', 'outcome']) {
    assert.ok(!reference.properties?.[field], `reference envelope must not grow a ${field} field`);
  }
  for (const field of ['preview', 'handle', 'resolvedRevision']) {
    assert.ok(!schema.properties?.[field], `command result must not absorb the reference envelope's ${field}`);
  }
});

test('NCL-003 every refusal declares machine-readable effects', () => {
  const result = base();
  assert.deepEqual(Object.keys(result.effects).sort(),
    ['externalSystemsChanged', 'filesChanged', 'publicationCreated', 'stateChanged']);
  assert.ok(preservedEverything(result));
});

test('effect declarations reject misspelled or unknown contract keys', () => {
  assert.throws(() => effects({ published: true }), /unknown key: published/);
});

test('NCL-004 a refusal that changed something is rejected outright', () => {
  assert.throws(
    () => base({ effects: effects({ filesChanged: true }) }),
    /is a refusal but declares effects: filesChanged/
  );
});

test('NCL-004 reassurance is derived from effects, never authored beside them', () => {
  const preserved = renderCommandResult(base());
  assert.match(preserved, /No governed state, files, publications or external systems were changed\./);

  // The same catalog message on a result that did change something must not reassure. `preserves`
  // marks a message as permitted to reassure; the effects decide whether it actually does.
  const changed = commandResult({
    operation: OPERATION,
    subject: SUBJECT,
    outcome: noop('submit.noop', { phase: 'requirements' }),
    effects: effects({ filesChanged: true }),
    next: [action({ id: 'x', label: 'Continue', command: 'singularity-flow status' })]
  });
  assert.doesNotMatch(renderCommandResult(changed), /were changed\./);
});

test('every narrated continuation includes exact Shell and Copilot routes', () => {
  const result = base();
  assert.equal(result.next[0].command, 'singularity-flow validate');
  assert.equal(result.next[0].skill, '/sf-doctor');
  const rendered = renderCommandResult(result);
  assert.match(rendered, /Shell: singularity-flow validate/);
  assert.match(rendered, /Copilot: \/sf-doctor/);
});

test('an SGOS continuation preserves its full Copilot relay command', () => {
  const result = commandResult({
    operation: { id: 'sgos-status', classification: 'read' },
    status: 'noop',
    outcome: noop('fos.authority-current', { authority: 'state' }),
    effects: noEffects(),
    why: [],
    next: [action({
      id: 'process-status', label: 'Inspect process state',
      command: 'singularity-flow process status --json', kind: 'informational'
    })],
    restState: null
  });
  assert.equal(result.next[0].skill, '/sf-sgos');
  assert.equal(result.next[0].copilotCommand, '/sf-sgos process status --json');
  const rendered = renderCommandResult(result);
  assert.match(rendered, /Shell: .*singularity-flow process status --json/);
  assert.match(rendered, /Copilot: .*\/sf-sgos process status --json/);
});

test('active Goals render through the supported terminal status vocabulary', () => {
  const result = commandResult({
    operation: { id: 'goal.list', classification: 'read' },
    subject: { kind: 'workspace', id: 'goal-workspace' },
    outcome: succeeded('goal.listed', { count: 1, workspace: 'Goal workspace' }),
    effects: noEffects(),
    restState: 'informational',
    data: {
      activeGoalId: 'GOL-20260819-001',
      goals: [{
        id: 'GOL-20260819-001',
        statement: 'Make the demo reliable',
        status: 'active',
        links: [],
        successCriteria: ['The demo completes without recovery']
      }]
    }
  });

  assert.match(renderCommandResult(result), /● GOL-20260819-001  Make the demo reliable/);
});

test('NCL-004 every message permitted to reassure is only used where nothing changed', () => {
  // The catalog cannot promise preservation for a message a mutating outcome would use.
  for (const id of preservingMessageIds()) {
    assert.ok(MESSAGES[id].headline, `${id} needs a headline`);
    assert.doesNotMatch(id, /^(approve|reject|resume)\.succeeded$/,
      `${id} reports a change and must not be marked as preserving`);
  }
});

test('NCL-005 WHY carries cataloged reason codes, never handler prose', () => {
  assert.throws(
    () => base({ why: [{ code: 'sequence.gate-failed', source: 'gate', detail: 'two gates failed' }] }),
    /carries reason codes, not prose/
  );
  assert.throws(() => base({ why: [because('Not A Code', 'gate')] }), /must be a dotted lower-case reason code/);
  assert.throws(() => base({ why: [because('a.b', 'invented-source')] }), /why\[\]\.source/);
  for (const entry of base().why) assert.ok(REASONS[entry.code], `${entry.code} must be in the catalog`);
});

test('NCL-005 a WHY reference stays resolvable beside its friendly wording', () => {
  const withRef = base({
    why: [because('phase.selected-by-pinned-rail', 'pin', { ref: 'workflow@4af71c2', slots: { phase: 'requirements', position: 1 } })]
  });
  const rendered = renderCommandResult(withRef);
  assert.match(rendered, /requirements is phase 1 of the rail this Story pinned when it started/);
  assert.match(rendered, /↳ pin:workflow@4af71c2/, 'the immutable reference survives the friendly line');
});

test('NCL-006 a result with neither continuation nor rest state is refused at the boundary', () => {
  // Checked on the way out, not at construction: the planner resolves continuation against
  // post-command state, which a handler cannot know while it is still building its result.
  const stranded = base({ next: [], restState: 'informational' });
  assert.throws(
    () => assertContinuation({ ...stranded, next: [], restState: null }),
    /offers no next action and declares no rest state/
  );
});

test('NCL-006 a refusal is given remediation, not a rest state', () => {
  const blocked = {
    ...base({ next: [], restState: 'informational' }),
    why: [because('publication.pending', 'sequence'), because('ledger.behind', 'evidence', { slots: { pending: 1 } })]
  };
  const remediation = remediationActions(blocked);
  assert.deepEqual(remediation.map((entry) => entry.id), ['sync-publication', 'reconcile-ledger']);
  for (const entry of remediation) assert.equal(entry.kind, 'remediation');
});

test('NCL-006 an unexplained refusal or failure cannot masquerade as informational rest', () => {
  for (const outcome of [refused('submit.refused'), failed('submit.refused')]) {
    const stranded = commandResult({
      operation: OPERATION,
      subject: SUBJECT,
      outcome,
      effects: noEffects()
    });
    const attached = attachContinuation(stranded);
    assert.equal(attached.restState, null);
    assert.throws(() => assertContinuation(attached), /offers no next action/);
  }
});

test('NCL-005 runtime validation rejects values the JSON schema forbids', () => {
  assert.throws(() => base({ subject: { kind: 'person', id: 'x' } }), /subject.kind/);
  assert.throws(() => base({ subject: { kind: 'story', id: '' } }), /subject.id/);
  assert.throws(() => base({ outcome: refused('missing.message') }), /narration catalog/);
  assert.throws(() => base({ why: [because('missing.reason', 'gate')] }), /reason catalog/);
  const result = base();
  assert.throws(() => validateCommandResult({
    ...result,
    next: [{ ...result.next[0], modelPolicy: 'sometimes' }]
  }), /modelPolicy/);
  assert.throws(() => validateCommandResult({
    ...result,
    next: [{ ...result.next[0], skill: '/sf-not valid' }]
  }), /installed direct Copilot skill/);
});

test('the command-result schema matches runtime subject and documentation reason vocabulary', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/command-result.schema.json', import.meta.url), 'utf8'));
  const subjectKinds = schema.properties.subject.properties.kind.enum;
  for (const kind of ['goal', 'outcome', 'adhoc']) {
    assert.ok(subjectKinds.includes(kind), `schema must accept runtime subject kind '${kind}'`);
    const result = base({ subject: { kind, id: `${kind}-1` } });
    assert.equal(result.subject.kind, kind);
  }

  const whyProperties = schema.properties.why.items.properties;
  assert.ok(whyProperties.source.enum.includes('docs'));
  assert.deepEqual(whyProperties.topic, {
    type: 'string',
    pattern: '^[a-z0-9]+(-[a-z0-9]+)*$'
  });
  const documented = base({
    why: [because('docs.no-such-topic', 'docs', { topic: 'help-and-docs' })]
  });
  assert.equal(documented.why[0].source, 'docs');
  assert.equal(documented.why[0].topic, 'help-and-docs');
  const rendered = renderCommandResult(documented);
  assert.match(rendered, /Shell: .*sflow explain help-and-docs/);
  assert.match(rendered, /Copilot: .*\/sf-docs/);
});

test('Copilot continuation commands enforce the schema byte-independent character ceiling', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/command-result.schema.json', import.meta.url), 'utf8'));
  const limit = schema.properties.next.items.properties.copilotCommand.maxLength;
  assert.equal(limit, 4096);

  const result = base();
  const prefix = '/sf-help ';
  const atLimit = `${prefix}${'x'.repeat(limit - [...prefix].length)}`;
  assert.throws(() => validateCommandResult({
    ...result,
    next: [{ ...result.next[0], copilotCommand: atLimit }]
  }), /safe registered Shell\/Copilot pair/,
  'a within-limit producer route must still match the command crosswalk');
  assert.throws(() => validateCommandResult({
    ...result,
    next: [{ ...result.next[0], copilotCommand: `${atLimit}x` }]
  }), /copilotCommand must be at most 4096 characters/);

  // JSON Schema maxLength counts Unicode code points, not UTF-16 code units. Runtime follows it
  // even though a non-canonical route is rejected independently by the strict pair validator.
  const emojiOverLimit = `${prefix}${'🚀'.repeat(limit + 1)}`;
  assert.throws(() => validateCommandResult({
    ...result,
    next: [{ ...result.next[0], copilotCommand: emojiOverLimit }]
  }), /copilotCommand must be at most 4096 characters/);
});

test('terminal narration never reflects a secret-bearing or mismatched producer route', () => {
  const result = base();
  const rendered = renderCommandResult({
    ...result,
    next: [{ ...result.next[0], command: 'singularity-flow status', skill: '/sf-status',
      copilotCommand: '/sf-status --token TOPSECRET' }]
  });
  assert.doesNotMatch(rendered, /TOPSECRET|--token/u);
  assert.match(rendered, /Command guidance unavailable/u);
});

test('schema version 1 remains compatible with continuation actions created before Copilot routes', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/command-result.schema.json', import.meta.url), 'utf8'));
  const required = schema.properties.next.items.required;
  assert.ok(!required.includes('skill'));
  assert.ok(!required.includes('copilotCommand'));

  const current = base();
  const priorV1Action = { ...current.next[0] };
  delete priorV1Action.skill;
  delete priorV1Action.copilotCommand;
  assert.doesNotThrow(() => validateCommandResult({
    ...current,
    next: [priorV1Action]
  }, { requireEnvelope: true }));
  const legacyRendered = renderCommandResult({ ...current, next: [priorV1Action] });
  assert.match(legacyRendered, /Shell: .*singularity-flow validate/);
  assert.match(legacyRendered, /Copilot: .*\/sf-doctor/);
  assert.doesNotMatch(legacyRendered, /undefined/);

  // New producers still populate both routes even though old persisted envelopes remain readable.
  const produced = action({ id: 'status', label: 'Show status', command: 'singularity-flow status' });
  assert.equal(produced.skill, '/sf-status');
  assert.equal(produced.copilotCommand, '/sf-status');
});

test('NCL-005 output validation requires the versioned command-result envelope', () => {
  const result = base();
  const missingEnvelope = { ...result };
  delete missingEnvelope.schemaVersion;
  assert.throws(
    () => validateCommandResult(missingEnvelope, { requireEnvelope: true }),
    /schemaVersion must be 1/
  );
  assert.throws(
    () => validateCommandResult({ ...result, resultType: 'something-else' }, { requireEnvelope: true }),
    /resultType must be 'command-result'/
  );
});

test('NCL-008 continuation is derived from post-command state', () => {
  const attached = attachContinuation({ ...base({ next: [], restState: 'informational' }), restState: null, next: [] });
  assert.ok(attached.next.length || attached.restState, 'a continuation is always attached');
});

test('NCL-008 planner timing maps to command-result ranks', () => {
  const workflow = {
    workItem: { id: 'PAY-1187', workType: 'feature', workTypeLabel: 'Feature' },
    status: 'active',
    currentPhase: 'requirements',
    phaseOrder: ['requirements', 'design'],
    phases: {
      requirements: { id: 'requirements', label: 'Requirements', status: 'awaiting_approval', generation: 1, artifacts: [], approvalPolicy: {} },
      design: { id: 'design', label: 'Design', status: 'not_started', generation: 0, artifacts: [], approvalPolicy: {} }
    }
  };
  const result = commandResult({
    operation: { id: 'status', classification: 'read' },
    subject: SUBJECT,
    outcome: succeeded('status.reported', { workId: 'PAY-1187', phase: 'requirements' }),
    effects: noEffects()
  });
  const attached = attachContinuation(result, { postState: workflow });
  assert.ok(attached.next.some((entry) => entry.rank === 'NOW'));
  assert.ok(attached.next.some((entry) => entry.rank === 'SOON'));
});

test('NCL-009 and NCL-010 terminal formatting never reaches JSON', () => {
  const result = base({
    why: [because('sequence.gate-failed', 'gate', { ref: 'gate@abc1234', slots: { failed: 2, total: 8 } })]
  });
  const json = JSON.parse(renderCommandResultJson(result));
  const serialized = JSON.stringify(json);
  assert.doesNotMatch(serialized, /↳/, 'no terminal arrows in JSON');
  assert.doesNotMatch(serialized, /\bNOW {2,}/, 'no column padding in JSON');
  // Codes and slots travel; the client renders its own words.
  assert.equal(json.why[0].code, 'sequence.gate-failed');
  assert.deepEqual(json.why[0].slots, { failed: 2, total: 8 });
  assert.equal(json.rendered.preservedEverything, true);
});

test('NCL-020 narration computes no lifecycle truth', async () => {
  // The plane explains and projects. It must not write, move refs, or decide governed questions.
  for (const file of ['command-result.mjs', 'messages.mjs', 'render-terminal.mjs', 'render-json.mjs', 'continuation.mjs']) {
    const source = await readFile(new URL(`../src/narration/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /writeJson|writeFile|writeAtomic|saveWorkflow|saveInitiative/, `${file} must not persist`);
    assert.doesNotMatch(source, /commitAndPublish|commitIsolated|pushBranch|update-ref/, `${file} must not publish`);
  }
});

test('the catalog covers every message and reason the constructors admit', () => {
  const result = base();
  assert.ok(MESSAGES[result.outcome.messageId], 'outcome message is cataloged');
  assert.equal(typeof MESSAGES[result.outcome.messageId].headline, 'function');
  for (const code of Object.keys(REASONS)) {
    assert.equal(typeof REASONS[code].render, 'function', `${code} renders`);
    assert.match(code, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${code} is a dotted lower-case code`);
  }
});

test('succeeded, failed and noop outcomes all round-trip', () => {
  for (const outcome of [
    succeeded('submit.succeeded', { phase: 'requirements' }),
    failed('submit.refused', { phase: 'requirements' }),
    noop('submit.noop', { phase: 'requirements' })
  ]) {
    const result = commandResult({
      operation: OPERATION,
      subject: SUBJECT,
      outcome,
      effects: outcome.status === 'succeeded' ? effects({ stateChanged: true, publicationCreated: true }) : noEffects(),
      restState: 'complete'
    });
    assert.equal(result.outcome.status, outcome.status);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.resultType, 'command-result');
  }
});

test('the narration migration catalog classifies every public command explicitly', () => {
  const status = validateNarrationMigrationStatus();
  assert.equal(status.registered, status.migrated.length + status.legacy.length);
  assert.ok(status.legacy.length <= MAX_LEGACY_NARRATION_COMMANDS,
    'the explicit legacy narration allowlist may shrink but never grow');
  for (const name of ['agent', 'approve', 'reject', 'resume', 'submit']) {
    assert.ok(MIGRATED_NARRATION_COMMANDS.includes(name));
    assert.ok(!LEGACY_NARRATION_COMMANDS.includes(name));
  }
});
