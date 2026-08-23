import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { gitDir } from './git.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { nowIso, writeText } from './util.mjs';
import { evaluateEngineConformance } from './harness-conformance.mjs';
import { primarySkillForCommand } from './command-skills.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

function registeredHarnessSkill(command) {
  const registered = primarySkillForCommand(command?.[1]);
  return registered?.replace(/^sf-/, 'sflow-') ?? null;
}

export function beginHarnessInvocation({ subject = null, skill = null, contractClass = null, command = [] } = {}) {
  return {
    schemaVersion: currentSchemaVersion('harness-event'),
    eventType: 'engine.invocation.started',
    invocationId: randomUUID(),
    subject,
    skill: skill ?? registeredHarnessSkill(command),
    contractClass,
    command,
    startedAt: nowIso()
  };
}

export async function completeHarnessInvocation(root, started, { exitCode, output = null, actionsExecuted = [], questions = [] } = {}) {
  const event = { ...started, eventType: 'engine.invocation.completed', endedAt: nowIso(), exitCode, output, actionsExecuted, questions };
  const checkers = evaluateEngineConformance(event);
  const core = { ...event, checkers }; const eventId = recordSha256(core);
  const target = path.join(gitDir(root), 'singularity-flow', 'harness-events', `${started.invocationId}.json`);
  await writeText(target, canonicalJson({ ...core, eventId }));
  return { eventId, path: target, event: { ...core, eventId } };
}

export async function harnessReport(root) {
  const directory = path.join(gitDir(root), 'singularity-flow', 'harness-events');
  let names = [];
  try { names = (await readdir(directory)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).sort(); } catch { /* empty report */ }
  const events = [];
  for (const name of names) {
    try {
      const stored = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      const { eventId, ...core } = stored;
      // Verify the exact stored bytes' logical record before any future in-memory migration. The
      // eventId is an immutable receipt for that historical shape, not for its upgraded projection.
      if (recordSha256(core) === eventId) events.push(readRecord('harness-event', stored).record);
    } catch { /* corrupt local projections are omitted and surfaced in counts below */ }
  }
  const verdicts = { pass: 0, fail: 0, 'not-observed': 0 };
  let rawBytes = 0; let previewBytes = 0;
  for (const event of events) {
    rawBytes += event.output?.rawBytes ?? 0;
    previewBytes += event.output?.previewBytes ?? 0;
    for (const checker of event.checkers ?? []) verdicts[checker.verdict] = (verdicts[checker.verdict] ?? 0) + 1;
  }
  const checkerCount = Object.values(verdicts).reduce((sum, value) => sum + value, 0);
  return {
    schemaVersion: 1,
    invocations: events.length,
    output: { rawBytes, previewBytes, savedBytes: Math.max(0, rawBytes - previewBytes) },
    checkers: { total: checkerCount, coverage: checkerCount ? (verdicts.pass + verdicts.fail) / checkerCount : 0, verdicts },
    hostObservations: {
      total: events.length,
      exact: 0,
      unavailable: events.length,
      coverage: 0,
      status: events.length ? 'unavailable' : 'not-observed',
      reason: 'The current Copilot host exposes no exact model/tool-loop observation envelope; no values were inferred.'
    },
    events
  };
}
