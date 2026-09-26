import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectSkillPackage, skillInspectionView, verifySkillPackage
} from '../src/skp-package.mjs';

async function fixture(t, entry, declaration) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'example-skill');
  await mkdir(directory);
  await writeFile(path.join(directory, 'SKILL.md'), entry);
  if (declaration !== undefined) {
    await writeFile(path.join(directory, 'sflow-skill.json'), declaration);
  }
  return directory;
}

test('manifest and headings produce provenance-bearing candidates without authority', async (t) => {
  const directory = await fixture(t, [
    '# Example skill',
    '## Outputs',
    '- Write `artifacts/threat-report.md`.',
    '## Examples',
    '```sh',
    'touch artifacts/fictional.md',
    '```',
    'Use https://example.invalid/checklist only after separate admission.',
    ''
  ].join('\n'), JSON.stringify({
    format: 'sflow-skill-declarations/v1',
    description: 'Review a threat model.',
    outputs: [{ id: 'threat-report', path: 'artifacts/threat-report.md', kind: 'custom:threat-model' }],
    inputs: [{ phase: 'requirements', output: 'primary', required: true }],
    capabilityRequests: ['read source tree']
  }));
  await mkdir(path.join(directory, 'references'));
  await writeFile(path.join(directory, 'references', 'checklist.md'), 'exact\r\nbytes\r\n');
  await mkdir(path.join(directory, 'scripts'));
  await writeFile(path.join(directory, 'scripts', 'hook.sh'), 'exit 99\n');

  const captured = await inspectSkillPackage(directory);
  assert.equal(verifySkillPackage(captured).verified, true);
  assert.equal(captured.manifest.format, 'sflow-skill-package/v1');
  assert.equal(captured.manifest.files.find((file) => file.path === 'scripts/hook.sh').role, 'script');
  assert.deepEqual(captured.contents.get('references/checklist.md'), Buffer.from('exact\r\nbytes\r\n'));
  assert.deepEqual(captured.proposals.filter((item) => item.field === 'produces').map((item) => item.source),
    [{ path: 'sflow-skill.json', pointer: '/outputs/0' }]);
  assert.deepEqual(captured.proposals.filter((item) => item.field === 'produces.path').map((item) => item.source),
    [{ path: 'SKILL.md', line: 3 }]);
  assert.equal(captured.proposals.some((item) => /scope|authority|tools|network/i.test(item.field)), false);
  assert.ok(captured.findings.some((item) => item.code === 'SKP_CAPABILITY_REQUEST_UNRESOLVED'));
  assert.ok(captured.findings.some((item) => item.code === 'SKP_EFFECT_UNSUPPORTED'));
  assert.ok(captured.findings.some((item) => item.code === 'SKP_REMOTE_REFERENCE_UNRESOLVED'));
  const view = skillInspectionView(captured);
  assert.equal(view.confirmationRequired, true);
  assert.equal(view.executable, false);
  assert.equal('contents' in view, false);
  assert.doesNotMatch(JSON.stringify(view), /exact\\r\\nbytes|exit 99/);
  assert.equal(captured.metrics.remoteCalls, 0);
  assert.equal(captured.metrics.modelCalls, 0);
});

test('negation and examples do not propose source permission or artifact paths', async (t) => {
  const directory = await fixture(t, [
    '# Example',
    'Do not edit source files.',
    '## Outputs',
    '```text',
    '- `artifacts/example.md`',
    '```',
    '- `artifacts/real.md`',
    ''
  ].join('\n'));
  const captured = await inspectSkillPackage(directory);
  assert.deepEqual(captured.proposals.filter((item) => item.field === 'produces.path').map((item) => item.value),
    ['artifacts/real.md']);
  assert.equal(captured.findings.some((item) => item.code === 'SKP_EFFECTS_REVIEW_REQUIRED'), false);
  assert.equal(captured.proposals.some((item) => /scope|task/.test(item.field)), false);
});

test('positive source effects stay a review finding, not a grant', async (t) => {
  const directory = await fixture(t, '# Example\nEdit application source files.\n');
  const captured = await inspectSkillPackage(directory);
  assert.ok(captured.findings.some((item) => item.code === 'SKP_EFFECTS_REVIEW_REQUIRED'));
  assert.equal(captured.proposals.some((item) => /scope|task/.test(item.field)), false);
});

test('conflicting declared and prose outputs remain unresolved', async (t) => {
  const directory = await fixture(t, '# Example\n## Outputs\n- `artifacts/other.md`\n',
    JSON.stringify({ format: 'sflow-skill-declarations/v1', outputs: [
      { id: 'report', path: 'artifacts/first.md' },
      { id: 'report', path: 'artifacts/second.md' }
    ] }));
  const captured = await inspectSkillPackage(directory);
  assert.ok(captured.findings.filter((item) => item.code === 'SKP_OUTPUT_AMBIGUOUS').length >= 2);
  assert.equal(captured.proposals.every((item) => item.status === 'candidate'), true);
});

test('closed sidecar refuses duplicate keys and permission fields', async (t) => {
  const directory = await fixture(t, '# Example\n', '{"format":"sflow-skill-declarations/v1","format":"sflow-skill-declarations/v1"}');
  await assert.rejects(inspectSkillPackage(directory), { code: 'SKP_MANIFEST_INVALID' });
  await writeFile(path.join(directory, 'sflow-skill.json'),
    JSON.stringify({ format: 'sflow-skill-declarations/v1', allowedTools: ['shell'] }));
  await assert.rejects(inspectSkillPackage(directory), { code: 'SKP_MANIFEST_INVALID' });
});

test('a local Markdown resource must be included in the exact package', async (t) => {
  const directory = await fixture(t, '# Example\nRead [the checklist](references/checklist.md).\n');
  await assert.rejects(inspectSkillPackage(directory), {
    code: 'SKP_SKILL_MISSING', details: { paths: ['references/checklist.md'] }
  });
  await mkdir(path.join(directory, 'references'));
  await writeFile(path.join(directory, 'references', 'checklist.md'), 'Checklist bytes\n');
  const captured = await inspectSkillPackage(directory);
  assert.equal(captured.manifest.files.some((file) => file.path === 'references/checklist.md'), true);
  await writeFile(path.join(directory, 'SKILL.md'), '# Example\nRead [outside](../private.md).\n');
  await assert.rejects(inspectSkillPackage(directory), { code: 'SKP_PATH_REFUSED' });
});
