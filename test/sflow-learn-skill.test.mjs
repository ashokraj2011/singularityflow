import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('sf-learn reuses the inert SGOS learning boundary and cannot acquire authority', async () => {
  const [skill, registry] = await Promise.all([
    readFile(path.join(root, 'plugin/skills/sflow-learn/SKILL.md'), 'utf8'),
    readFile(path.join(root, 'plugin/skills/registry.yml'), 'utf8').then(YAML.parse)
  ]);
  assert.equal(registry.skills['sflow-learn'].executionBoundary, 'repository');
  assert.equal(registry.skills['sflow-learn'].class, 'interactive');
  assert.equal(registry.automaticInvocationAllowlist.includes('sflow-learn'), false,
    'a question must not silently materialize even inert tutorial state');
  assert.match(skill, /disable-model-invocation: true/);
  assert.match(skill, /never search `\$HOME`\/parents/);
  assert.match(skill, /never executes them or changes the application\s+checkout, Git history, Devices, a governed Process/);
  assert.match(skill, /without `--confirm` once[\s\S]*stop for explicit confirmation/);
  assert.match(skill, /Never run application tests or commands on behalf of a lesson/);
  assert.match(skill, /learning only; no authority or certification/i);
});
