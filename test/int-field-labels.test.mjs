/**
 * Every operation input reads as words, on every screen that shows one. `[UXH:REQ-070]`
 *
 * The Investigation page printed `observedVersion` and `lastKnownGood`: its renderer turned dashes
 * into spaces and nothing else, so a camelCase argument name reached the screen as it is spelled on
 * the wire. The schema now carries every field's label, and one fallback (`identifierWords`) covers
 * a name no schema labels. These tests walk every declared field and every renderer that draws one,
 * so a new field, schema or screen cannot bring the wire name back.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ARGUMENT_SCHEMAS, fieldLabel, hostActionSchemaId, identifierWords } from '../src/gateway/argument-schemas.mjs';
import { formModel } from '../src/gateway/form-model.mjs';
import { problemInvestigate } from '../src/gateway/planners/problem-investigate.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = (name) => pathToFileURL(path.join(root, 'apps', 'vscode', 'src', 'views', name)).href;
const { formHtml } = await import(views('form-page.ts'));
const { schemaForm } = await import(views('schema-form-model.ts'));
const { HOST_RECORD_ACTIONS, hostRecordHtml, investigationView, loadingView } = await import(views('host-record-page.ts'));

/**
 * A label shown as the identifier it came from: lower-case first (`expected`), a camelCase hump
 * (`observedVersion`), or snake_case. Labels on these screens are sentence case, so each of those is
 * a name that skipped its label rather than a word that happens to look like one.
 */
function rawIdentifier(label, name = null) {
  return typeof label !== 'string' || !label.trim() || label === name
    || /^[a-z]/u.test(label) || /[a-z0-9][A-Z]/u.test(label) || /_/u.test(label);
}

const decode = (html) => html.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'");

test('identifierWords turns any identifier into words a person reads', () => {
  assert.equal(identifierWords('observedVersion'), 'Observed version');
  assert.equal(identifierWords('lastKnownGood'), 'Last known good');
  assert.equal(identifierWords('observedBuildId'), 'Observed build ID', 'a known acronym is said in capitals');
  assert.equal(identifierWords('workIds'), 'Work IDs');
  assert.equal(identifierWords('PascalCase'), 'Pascal case');
  assert.equal(identifierWords('parseJSONResponse'), 'Parse JSON response', 'a run of capitals is one word');
  assert.equal(identifierWords('snake_case_name'), 'Snake case name');
  assert.equal(identifierWords('kebab-case-name'), 'Kebab case name');
  assert.equal(identifierWords('problem.investigate'), 'Problem investigate');
  assert.equal(identifierWords('  spaced  out  '), 'Spaced out');
  assert.equal(identifierWords('Already words'), 'Already words');
  assert.equal(identifierWords(''), '');
  assert.equal(identifierWords(null), '');
});

test('every argument schema field carries a label that reads as words', () => {
  const raw = [];
  for (const schema of ARGUMENT_SCHEMAS) {
    for (const [name, spec] of Object.entries(schema.fields)) {
      if (rawIdentifier(spec.label, name)) raw.push(`${schema.id}.${name}: ${JSON.stringify(spec.label)}`);
      assert.equal(fieldLabel(schema.id, name), spec.label, `${schema.id}.${name} is read through fieldLabel`);
    }
  }
  assert.deepEqual(raw, [], `fields shown as identifiers:\n  ${raw.join('\n  ')}`);
  // A name the schema labels reads its label; anything else falls back to its words.
  assert.equal(fieldLabel('problem-investigate-v1', 'lastKnownGood'), 'Last known good revision');
  assert.equal(fieldLabel('problem-investigate-v1', 'observedVersion'), 'Observed version');
  assert.equal(fieldLabel('problem-investigate-v1', 'notDeclared'), 'Not declared');
  assert.equal(fieldLabel('not-a-schema-v1', 'workId'), 'Work ID');
  assert.equal(fieldLabel(null, 'workId'), 'Work ID');
});

test('every schema form, as modelled and as rendered, labels its fields in words', () => {
  for (const schema of ARGUMENT_SCHEMAS) {
    const model = formModel(schema.id);
    for (const field of model.fields) {
      assert.equal(field.label, schema.fields[field.name].label, `${schema.id}.${field.name}: the form says what the schema says`);
    }
    const shown = [...formHtml(model).matchAll(/<label for="[^"]*">([^<]*)/gu)].map((match) => decode(match[1]));
    assert.equal(shown.length, model.fields.filter((field) => field.renderable).length, `${schema.id} rendered every field`);
    for (const label of shown) assert.ok(!rawIdentifier(label), `${schema.id} renders ${JSON.stringify(label)}`);
    for (const field of schemaForm(schema).fields) {
      assert.equal(field.label, schema.fields[field.name].label, `${schema.id}.${field.name} in the editor form model`);
    }
  }
});

test('a form field with no label, or with no input, is still named in words', () => {
  const view = {
    schemaId: 'test-v1',
    unrenderable: ['observedBuildId'],
    fields: [
      { name: 'lastKnownGood', type: 'ref', control: 'line', required: false, values: null, ceremony: false, value: null, persist: true, renderable: true },
      { name: 'observedBuildId', label: 'Observed build ID', type: 'blob', control: null, required: false, values: null, ceremony: false, value: null, persist: true, renderable: false }
    ]
  };
  const html = formHtml(view);
  assert.match(html, /<label for="sf-test-v1-lastKnownGood">Last known good</u);
  assert.match(html, /This build has no input for: Observed build ID\./u);
  assert.equal(schemaForm({ id: 'test-v1', fields: { lastKnownGood: { type: 'ref' } } }).fields[0].label, 'Last known good');
});

test('a record view names its request by label while it reads', () => {
  for (const [action, { fields }] of Object.entries(HOST_RECORD_ACTIONS)) {
    const request = Object.fromEntries(fields.map((field) => [field, field === 'workKind' ? 'story' : 'REC-1']));
    const { subtitle } = loadingView(action, request);
    for (const field of fields) {
      const label = fieldLabel(hostActionSchemaId(action), field);
      assert.ok(!rawIdentifier(label, field), `${action}.${field} is labelled ${JSON.stringify(label)}`);
      assert.ok(subtitle.includes(`${label} ${request[field]}`), `${action}: ${subtitle}`);
      assert.ok(!subtitle.includes(`${field} `), `${action} shows the argument name ${field}: ${subtitle}`);
    }
  }
});

test('the Investigation page shows every input, unknown and record in words', async (t) => {
  const repo = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-field-labels-')));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: childTimeout(60_000) }).status, 0, args.join(' '));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'labels@example.test');
  git('config', 'user.name', 'Labels Fixture');
  await writeFile(path.join(repo, 'postal.mjs'), 'export const postalRequired = true;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'postal check');

  const result = await problemInvestigate({ root: repo, arguments: { symptom: 'postal check fails' }, context: { repositoryId: 'labels' } });
  const report = result.data.report;
  // The report's inputs are the schema's fields, so the schema is what names them.
  const declared = Object.keys(ARGUMENT_SCHEMAS.find((schema) => schema.id === 'problem-investigate-v1').fields);
  for (const field of [...Object.keys(report.inputs), ...report.unknown]) assert.ok(declared.includes(field), `${field} is not a declared input`);
  for (const entry of report.records.filter((record) => record.type === 'unknown' && declared.includes(record.reference))) {
    assert.equal(entry.statement, `${fieldLabel('problem-investigate-v1', entry.reference)}: not given`);
  }

  const kept = { investigationId: result.data.investigationId, receivedAt: '2026-10-25T10:00:00.000Z', result };
  const model = investigationView({ request: { investigationId: kept.investigationId }, record: kept, kept: [kept] });
  const labels = [
    ...model.facts.map(([label]) => label),
    ...model.sections.flatMap((section) => (section.facts ?? []).map(([label]) => label))
  ];
  for (const label of labels) assert.ok(!rawIdentifier(label), `fact labelled ${JSON.stringify(label)}`);
  const page = decode(hostRecordHtml(model, 'r1'));
  for (const field of declared) {
    assert.ok(!new RegExp(`\\b${field}\\b`, 'u').test(page) || !/[A-Z]/u.test(field), `the page shows the argument name ${field}`);
  }
  assert.match(page, /<dt>Last known good revision<\/dt>/u);
  assert.match(page, /<li>Unknown: Observed version<\/li>/u);
});
