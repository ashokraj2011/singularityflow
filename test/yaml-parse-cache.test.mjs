import assert from 'node:assert/strict';
import test from 'node:test';
import YAML from 'yaml';

import { parseYamlText } from '../src/yaml-parse-cache.mjs';

test('identical text is parsed once but every caller gets its own copy', () => {
  const text = 'phases:\n  intake:\n    label: Intake\nlist: [a, b]\n';
  const first = parseYamlText(text);
  assert.deepEqual(first, YAML.parse(text));
  first.phases.intake.label = 'Changed by a caller';
  first.list.push('c');
  const second = parseYamlText(text);
  assert.deepEqual(second, YAML.parse(text), 'a caller normalizing in place does not change the next answer');
  assert.notEqual(second, first);
});

test('changed text is parsed afresh, and a parse error is thrown every time', () => {
  assert.deepEqual(parseYamlText('value: 1\n'), { value: 1 });
  assert.deepEqual(parseYamlText('value: 2\n'), { value: 2 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => parseYamlText('value: [unclosed\n'), /Flow sequence|end of the stream|Missing/u);
  }
});

test('scalars and empty documents keep YAML.parse results', () => {
  assert.equal(parseYamlText(''), null);
  assert.equal(parseYamlText('42\n'), 42);
  assert.equal(parseYamlText('text\n'), 'text');
});
