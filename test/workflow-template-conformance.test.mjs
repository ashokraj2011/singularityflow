/**
 * Step templates judged by the kernel's own readers (src/workflow-template-conformance.mjs): the
 * packaged catalog conforms, and a team's template that would stop a Story is found before one does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { templateConformanceFindings, templateReader } from '../src/workflow-template-conformance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every packaged workflow\'s templates give their authors what the kernel later checks', async () => {
  const definition = validateDefinition(YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8')));
  const read = templateReader(path.join(ROOT, 'templates'), 'artifacts');
  let owners = 0;
  for (const id of Object.keys(definition.workTypes)) {
    const resolved = resolveWorkType(definition, id);
    owners += Object.keys(resolved.plannedClaims?.owners ?? {}).length;
    assert.deepEqual(await templateConformanceFindings(resolved, { read }), [], id);
  }
  assert.ok(owners >= 10, `expected the packaged catalog to plan its code steps, found ${owners}`);
});

/** A three-step workflow: spec defines the clauses, plan plans build. */
async function judge(templates, { spec = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-template-conformance-'));
  for (const [name, text] of Object.entries(templates)) {
    await mkdir(path.dirname(path.join(root, 'templates', name)), { recursive: true });
    if (typeof text === 'object') await symlink(path.join(root, text.link), path.join(root, 'templates', name));
    else await writeFile(path.join(root, 'templates', name), text);
  }
  const resolved = {
    id: 'team', spec,
    plannedClaims: { mode: 'required', clausePhases: ['spec'], owners: { build: 'plan' } },
    phases: [
      { id: 'spec', label: 'Specification', template: 'spec.md', artifact: { kind: 'requirements' } },
      { id: 'plan', label: 'Plan', template: 'plan.md', artifact: { kind: 'implementation-plan', validation: { requiredHeadings: ['Approach'] } } },
      { id: 'build', label: 'Build', template: 'build.md', artifact: { kind: 'implementation-summary' }, generation: { task: 'code' } }
    ]
  };
  return templateConformanceFindings(resolved, { read: templateReader(root, 'templates') });
}

const SPEC = '# {{work.id}}\n\n## Requirements\n\n- Export every row. [{{work.id}}:REQ-001]\n\n## Verification intent\n\n| Clause | Methods | Criterion |\n|---|---|---|\n| `{{work.id}}:REQ-001` | TODO | - |\n';
const TABLE = '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |\n|---|---|---|---|---|\n';
const PLAN = `# Plan\n\n## Approach\n\nTODO\n\n## Planned implementation evidence\n\n${TABLE}| TODO | TODO | TODO | TODO | TODO |\n`;
const codes = (findings) => findings.map((entry) => [entry.code, entry.step, entry.severity]);

test('a conforming team workflow has nothing to report; author-owned TODO cells are not judged', async () => {
  // Verification intent methods and the plan's rows are TODO: step entry fills the rows with the
  // clauses Specification defined, and the author fills the rest.
  assert.deepEqual(await judge({ 'spec.md': SPEC, 'plan.md': PLAN, 'build.md': '# Build\n' }), []);
});

test('missing anchors, a refused or missing table, a missing section, an unfillable token and missing or linked templates', async () => {
  const findings = await judge({
    'spec.md': '# {{work.id}}\n\n## Requirements\n\n- Export every row.\n\n<!-- [{{work.id}}:REQ-001] in a comment is not an anchor -->\n',
    'plan.md': `# Plan\n\n## Planned implementation evidence\n\n| Clause | Expected paths | Planned tests | Fulfillment |\n|---|---|---|---|\n| \`{{work.id}}:REQ-001\` | \`src/export.js\` | \`test/export.test.js\` | someday |\n`,
    'build.md': { link: 'elsewhere.md' }
  });
  assert.deepEqual(codes(findings), [
    ['CHECK_TEMPLATE_CLAUSE_ANCHORS', 'spec', 'problem'],
    ['CHECK_TEMPLATE_HEADING_MISSING', 'plan', 'warning'],
    ['CHECK_TEMPLATE_PLANNED_TABLE', 'plan', 'problem'],
    ['CHECK_TEMPLATE_MISSING', 'build', 'problem']
  ]);
  const [anchors, heading, table, link] = findings;
  assert.deepEqual([anchors.location.file, anchors.location.line, anchors.template], ['templates/spec.md', 3, 'spec.md']);
  assert.match(heading.detail, /"Approach"/u);
  assert.match(table.detail, /fulfillment/iu);
  assert.equal(table.location.line, 7, 'the row with the value');
  assert.match(link.title, /is a symbolic link/u);

  const token = await judge({ 'spec.md': `${SPEC}\nOwner: {{work.owner}}\n`, 'plan.md': PLAN, 'build.md': '# Build\n' });
  assert.deepEqual(codes(token), [['CHECK_TEMPLATE_TOKEN_UNSUPPORTED', 'spec', 'problem']]);
  assert.equal(token[0].location.line, SPEC.split('\n').length + 1);

  const none = await judge({ 'spec.md': SPEC, 'plan.md': '# Plan\n\n## Approach\n\nTODO\n', 'build.md': '# Build\n' });
  assert.deepEqual(codes(none), [['CHECK_TEMPLATE_PLANNED_TABLE', 'plan', 'problem']]);
  assert.match(none[0].fix, /\| Clause \| Expected paths \| Planned tests \| Fulfillment \| Observable result \|/u);
  assert.deepEqual(none[0].stopsAt, { step: 'plan', when: 'publication' });

  const missing = await judge({ 'spec.md': SPEC, 'plan.md': PLAN });
  assert.deepEqual(codes(missing), [['CHECK_TEMPLATE_MISSING', 'build', 'problem']]);
});

test('a clause a later step redefines, or a namespace the configuration does not use, is refused as publication would', async () => {
  const redefined = await judge({ 'spec.md': `${SPEC}\n- Again. [{{work.id}}:REQ-001]\n`, 'plan.md': PLAN, 'build.md': '# Build\n' });
  assert.equal(redefined[0].code, 'CHECK_TEMPLATE_CLAUSE_ANCHORS');
  assert.match(redefined[0].detail, /Clause CHECK-1:REQ-001 is duplicated at lines/u);
  const namespaced = await judge({ 'spec.md': SPEC.replaceAll('{{work.id}}:REQ', 'OTHER:REQ'), 'plan.md': PLAN, 'build.md': '# Build\n' }, { spec: { mode: 'record', namespace: 'APP' } });
  assert.match(namespaced[0].detail, /does not use configured namespace APP/u);
});

test('guidance a published document would keep, or wrapped over lines, is a note with the exact edits that mark it', async () => {
  const wrapped = [
    '# {{work.id}}', '',
    'Write what the export must do. Every requirement below needs',
    'an anchor.', '',
    '<!-- Before drafting, read the request', 'and the attachments. -->', '',
    '## Requirements', '',
    '- Export every row. [{{work.id}}:REQ-001]', ''
  ].join('\n');
  const findings = await judge({ 'spec.md': wrapped, 'plan.md': PLAN, 'build.md': '# Build\n' });
  assert.deepEqual(codes(findings), [['CHECK_TEMPLATE_GUIDANCE', 'spec', 'note']]);
  const [note] = findings;
  assert.deepEqual(note.location, { file: 'templates/spec.md', line: 3 });
  assert.match(note.detail, /lines 3-4 and 6-7 read like guidance to the author, so every published document keeps them/u);
  assert.match(note.fix.text, /<!-- sflow:guidance \.\.\. -->/u);
  assert.deepEqual(note.fix.data, { file: 'templates/spec.md', edits: [
    { line: 3, endLine: 4, kind: 'unmarked', text: '<!-- sflow:guidance Write what the export must do. Every requirement below needs an anchor. -->' },
    { line: 6, endLine: 7, kind: 'unmarked', text: '<!-- sflow:guidance Before drafting, read the request and the attachments. -->' }
  ] });

  // Marked guidance wrapped over two lines is the same note, saying only that.
  const marked = wrapped.replace('Write what', '<!-- sflow:guidance Write what').replace('an anchor.', 'an anchor. -->')
    .replace('<!-- Before drafting, read the request\nand the attachments. -->', '<!-- sflow:guidance Before drafting, read the request and the attachments. -->');
  const [again] = await judge({ 'spec.md': marked, 'plan.md': PLAN, 'build.md': '# Build\n' });
  assert.equal(again.code, 'CHECK_TEMPLATE_GUIDANCE');
  assert.match(again.title, /wrapped over several lines/u);
  assert.match(again.detail, /lines 3-4 hold a paragraph wrapped over several lines, which an agent quoting it as one line cannot match/u);

  // Marked, one line per paragraph: nothing to say. TODO lines, anchors and tables are the author's, never guidance.
  assert.deepEqual(await judge({ 'spec.md': `${SPEC}\n<!-- sflow:guidance Write one requirement per line. -->\n`, 'plan.md': PLAN, 'build.md': '# Build\n' }), []);
});

test('an anchor written only in guidance defines no clause; a deterministic step\'s template is not judged for guidance', async () => {
  const onlyGuidance = '# {{work.id}}\n\n## Requirements\n\n<!-- sflow:guidance For example: - Export every row. [{{work.id}}:REQ-001] -->\n';
  const findings = await judge({ 'spec.md': onlyGuidance, 'plan.md': PLAN, 'build.md': '# Build\n' });
  assert.deepEqual(codes(findings).filter(([code]) => code !== 'CHECK_TEMPLATE_PLANNED_TABLE'), [['CHECK_TEMPLATE_CLAUSE_ANCHORS', 'spec', 'problem']]);
  assert.match(findings[0].title, /defines no requirement clauses/u);

  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-template-guidance-'));
  await mkdir(path.join(root, 'templates'), { recursive: true });
  await writeFile(path.join(root, 'templates', 'summary.md'), '# Summary\n\nThe kernel assembles this record from the\nchange set.\n');
  const resolved = { id: 'team', phases: [{ id: 'summary', label: 'Summary', template: 'summary.md', artifact: { kind: 'implementation-summary' }, generation: { producer: 'deterministic' } }] };
  assert.deepEqual(await templateConformanceFindings(resolved, { read: templateReader(root, 'templates') }), []);
  resolved.phases[0].generation = { producer: 'governed-agent' };
  assert.deepEqual(codes(await templateConformanceFindings(resolved, { read: templateReader(root, 'templates') })), [['CHECK_TEMPLATE_GUIDANCE', 'summary', 'note']]);
});
