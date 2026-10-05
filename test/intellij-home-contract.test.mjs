/**
 * The IntelliJ client reads `sflow home --json` and nothing else. This holds the CLI to the fields
 * that client reads (apps/intellij/src/main/kotlin/.../model/HomeParser.kt), and keeps the JSON
 * fixtures its Kotlin tests parse equal to what the CLI prints today.
 *
 * Regenerate the fixtures after an intended change with SINGULARITY_FLOW_UPDATE_INTELLIJ_FIXTURES=1.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  blankMachineFixture, governedWorkspaceFixture, homeAsIntellijClient
} from './helpers/governed-workspace-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDirectory = path.join(root, 'apps', 'intellij', 'src', 'test', 'resources', 'fixtures', 'home');
const homeCommands = JSON.parse(await readFile(
  path.join(root, 'apps', 'intellij', 'src', 'main', 'resources', 'sflow', 'home-commands.json'), 'utf8'));
const UPDATE = process.env.SINGULARITY_FLOW_UPDATE_INTELLIJ_FIXTURES === '1';

/** Volatile values become stable markers, so a fixture compares equal on every machine and run. */
function normalize(value, machine) {
  const prefixes = [...new Set([machine, machine.replace(/^\/private/u, ''), `/private${machine}`])]
    .sort((left, right) => right.length - left.length);
  const text = (input) => {
    let output = input;
    for (const prefix of prefixes) output = output.split(prefix).join('<MACHINE>');
    return output
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, '<TIME>')
      .replace(/\bsha256:[0-9a-f]{64}\b/gu, 'sha256:<HASH>')
      .replace(/\b[0-9a-f]{64}\b/gu, '<HASH>')
      .replace(/\b[0-9a-f]{40}\b/gu, '<COMMIT>')
      .replace(/\bsel_[0-9a-f]+\b/gu, 'sel_<HANDLE>')
      .replace(/\bactor:[0-9a-f]{24}\b/gu, 'actor:<ID>');
  };
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, machine));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, machine)]));
  }
  return value;
}

/** Exactly the fields HomeParser.kt reads. A field outside this set may change freely. */
function readSet(result) {
  const pick = (object, keys) => object == null ? null
    : Object.fromEntries(keys.map((key) => [key, object[key] ?? null]));
  const action = (entry) => entry == null ? null : {
    ...pick(entry, ['id', 'label', 'rank', 'kind', 'reasonCode', 'confirmation', 'emphasis', 'executable']),
    fallback: pick(entry.fallback, ['command', 'copyable'])
  };
  const attention = (entry) => ({
    ...pick(entry, ['id', 'kind', 'title', 'workId', 'phase', 'reasonCode']),
    actionId: entry.action?.id ?? null
  });
  if (result.resultType === 'sflow-refusal-plan') {
    return {
      resultType: result.resultType,
      status: result.status,
      error: pick(result.error, ['code', 'message']),
      steps: (result.remediationPlan?.steps ?? []).map((step) => pick(step, ['id', 'label', 'command', 'copyable']))
    };
  }
  const projection = result.data?.homeProjection;
  return {
    schemaVersion: result.schemaVersion,
    resultType: result.resultType,
    kind: result.kind,
    outcome: pick(result.outcome, ['status', 'messageId', 'slots']),
    why: (result.why ?? []).map((entry) => pick(entry, ['code', 'slots'])),
    warnings: (result.warnings ?? []).map((entry) => pick(entry, ['code', 'slots'])),
    next: (result.next ?? []).map(action),
    repositoryPath: result.data?.home?.repository?.path ?? null,
    projection: projection == null ? null : {
      ...pick(projection, ['schemaVersion', 'resultType']),
      context: pick(projection.context, ['workspaceId', 'workspaceLabel', 'repositoryId', 'branch', 'activeWorkId']),
      activeWork: projection.activeWork == null ? null : {
        ...pick(projection.activeWork, ['id', 'kind', 'title', 'phase', 'status', 'group']),
        rail: (projection.activeWork.rail ?? []).map((step) => pick(step, ['id', 'label', 'state'])),
        actionId: projection.activeWork.action?.id ?? null
      },
      needsUser: (projection.needsUser ?? []).map(attention),
      worthChecking: (projection.worthChecking ?? []).map(attention),
      recent: (projection.recent ?? []).map((entry) => pick(entry, ['id', 'title', 'phase', 'status', 'group'])),
      health: pick(projection.health, ['status', 'warnings'])
    }
  };
}

/** The client's run-or-type decision, from home-commands.json: an exact token match per template. */
function matchingTemplate(command) {
  const tokens = command.trim().split(/\s+/u);
  if (!['singularity-flow', 'sflow'].includes(tokens[0])) return null;
  const argv = tokens.slice(1);
  return homeCommands.templates.find((template) => template.argv.length === argv.length
    && template.argv.every((token, index) => (/^<[A-Z][A-Z0-9-]*>$/u.test(token)
      ? !argv[index].startsWith('-') : token === argv[index]))) ?? null;
}

async function compareFixture(name, result, machine) {
  const file = path.join(fixtureDirectory, `${name}.json`);
  const normalized = normalize(result, machine);
  if (UPDATE) {
    await mkdir(fixtureDirectory, { recursive: true });
    await writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`);
    return;
  }
  const committed = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(readSet(normalized), readSet(committed),
    `${name}.json no longer matches what the IntelliJ client reads from sflow home --json. `
    + 'Update HomeParser.kt if a field moved, then regenerate with SINGULARITY_FLOW_UPDATE_INTELLIJ_FIXTURES=1.');
}

function assertEnvelope(result) {
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.resultType, 'sflow-result');
  assert.equal(result.operation?.id, 'home.overview');
  assert.ok(result.data?.homeProjection, 'home --json carries data.homeProjection');
  assert.equal(result.data.homeProjection.resultType, 'my-work-home');
  assert.ok(result.next.filter((entry) => entry.emphasis === 'primary').length <= 1, 'at most one primary action');
  for (const entry of result.next) {
    assert.ok(entry.fallback?.command, `${entry.id} has a fallback command`);
    assert.ok(matchingTemplate(entry.fallback.command),
      `${entry.id} falls back to '${entry.fallback.command}', which matches no home-commands.json template`);
  }
}

test('on a blank machine home offers only workspace setup, each with a known command', { timeout: 120_000 }, async (t) => {
  const fixture = await blankMachineFixture();
  t.after(fixture.cleanup);
  const home = homeAsIntellijClient(fixture);
  assert.equal(home.status, 0, home.stdout || home.stderr);
  const result = JSON.parse(home.stdout);
  assertEnvelope(result);
  assert.equal(result.data.homeProjection.activeWork, null);
  assert.equal(result.why[0]?.code, 'home.no-workspace-selected');
  await compareFixture('blank', result, fixture.machine);
});

test('with an active Story home leads with it, and its continue command is a mutation the client only types', {
  timeout: 300_000
}, async (t) => {
  const fixture = await governedWorkspaceFixture({ storyId: 'FIX-1' });
  t.after(fixture.cleanup);
  const home = homeAsIntellijClient({ cwd: fixture.repository, env: fixture.env });
  assert.equal(home.status, 0, home.stdout || home.stderr);
  const result = JSON.parse(home.stdout);
  assertEnvelope(result);
  const projection = result.data.homeProjection;
  assert.equal(projection.activeWork?.id, 'FIX-1');
  assert.equal(projection.activeWork.rail.filter((step) => step.state === 'current').length, 1);
  assert.equal(await realpath(result.data.home.repository.path), await realpath(fixture.repository));
  const primary = result.next.find((entry) => entry.emphasis === 'primary');
  assert.equal(primary.fallback.command, 'singularity-flow resume FIX-1');
  assert.equal(matchingTemplate(primary.fallback.command).classification, 'mutation');
  assert.equal(matchingTemplate('singularity-flow status').classification, 'read');
  await compareFixture('active-story', result, fixture.machine);
});

test('an unknown --workspace fails with one refusal-plan object on stdout', { timeout: 300_000 }, async (t) => {
  const fixture = await governedWorkspaceFixture();
  t.after(fixture.cleanup);
  const home = homeAsIntellijClient({ cwd: fixture.repository, env: fixture.env, workspace: 'missing' });
  assert.notEqual(home.status, 0);
  const result = JSON.parse(home.stdout);
  assert.equal(result.resultType, 'sflow-refusal-plan');
  assert.equal(result.status, 'failed');
  assert.ok(result.error?.message);
  assert.ok((result.remediationPlan?.steps ?? []).every((step) => typeof step.command === 'string'));
  await compareFixture('unknown-workspace', result, fixture.machine);
});

test('home-commands.json classifies every home fallback, and runs none that can change state', () => {
  const byId = Object.fromEntries(homeCommands.templates.map((template) => [template.id, template]));
  for (const id of ['work.continue', 'work.start.intake', 'workspace.prepare.guide', 'fault.fix']) {
    assert.equal(byId[id]?.classification, 'mutation', `${id} must be typed, not run`);
  }
  for (const id of ['work.status', 'work.return', 'work.review', 'workspace.switch', 'help.explain']) {
    assert.equal(byId[id]?.classification, 'read', `${id} may run on click`);
  }
});
