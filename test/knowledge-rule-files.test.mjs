/**
 * Rules kept as data (World Model v5, M1d): JSON and YAML rule objects in rule folders, read with
 * their conditions and values (secrets withheld), as rule records the docs are compared with.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readDocumentation } from '../src/knowledge/brief.mjs';
import { buildRuleRecords, ruleStatusWords } from '../src/knowledge/records/rules.mjs';
import { isRuleFile, ruleFileRules } from '../src/knowledge/rule-files.mjs';
import { buildKnowledge } from '../src/knowledge/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = (relative, text) => ({ path: relative, lines: text.split('\n') });

test('rule files are recognised by folder or name, and their rule objects read in every common shape', () => {
  assert.ok(isRuleFile('rules/discounts.yml'));
  assert.ok(isRuleFile('config/policies/access/admin.json'));
  assert.ok(isRuleFile('src/main/resources/pricing-rules.yaml'));
  assert.ok(!isRuleFile('package.json') && !isRuleFile('rules/tsconfig.json') && !isRuleFile('src/rules/engine.ts'));
  const yaml = ruleFileRules(file('rules/discounts.yml', [
    'rules:', '  - name: loyal-customer-discount', '    when:', '      all:', '        - field: customer.years', '          op: gte', '          value: 3',
    '        - field: order.total', '          op: gt', '          value: 100', '    then:', '      discount: 0.1'
  ].join('\n')));
  assert.deepEqual(yaml.map((rule) => [rule.name, rule.when, rule.then, rule.line]), [
    ['loyal-customer-discount', ['customer.years >= 3', 'order.total > 100'], 'discount = 0.1', 2]
  ]);
  const json = ruleFileRules(file('config/rules/eligibility.json', JSON.stringify({
    rules: [
      { id: 'minimum-age', condition: { age: { gte: 18 } }, outcome: 'eligible' },
      { id: 'region', if: { any: [{ fact: 'country', operator: 'in', value: ['NL', 'BE'] }, { fact: 'vip', operator: 'equal', value: true }] }, then: { route: 'eu' } },
      { id: 'partner', condition: { field: 'partner', op: 'eq', value: 'acme' }, outcome: { route: 'partner-queue', apiKey: 'not-a-real-key' } }
    ]
  }, null, 2)));
  assert.deepEqual(json.map((rule) => [rule.name, rule.when.join('; '), rule.then]), [
    ['minimum-age', 'age >= 18', 'eligible'],
    ['region', 'any of (country in ["NL", "BE"]; vip == true)', 'route = "eu"'],
    ['partner', 'partner == "acme"', 'route = "partner-queue", apiKey = (withheld)']
  ]);
  assert.deepEqual(ruleFileRules(file('rules/broken.json', '{ not json')), [], 'an unreadable file yields nothing');
});

test('rule-file rules are compared with the docs like code rules', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-rule-files-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', 'rules-config'), repository, { recursive: true });
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Fixture']]) {
    assert.equal(spawnSync('git', args, { cwd: repository, encoding: 'utf8' }).status, 0);
  }
  const result = await buildKnowledge(repository, {});
  const fromFiles = result.knowledge.items.filter((item) => item.kind === 'rule' && item.statement.source === 'rule-file');
  assert.deepEqual(fromFiles.map((item) => item.subject.symbol).sort(), ['high-risk-block', 'loyal-customer-discount', 'minimum-age', 'partner-routing']);
  assert.ok(fromFiles.every((item) => item.citations[0].path.match(/rules\//u)), 'each rule cites its file and line');
  assert.equal(result.knowledge.items.filter((item) => item.kind === 'configuration' && /rules\//u.test(item.subject.path)).length, 0, 'rule files are not configuration keys');
  assert.equal(result.knowledge.metrics.invalidCitations, 0);
  const records = buildRuleRecords(result.knowledge, readDocumentation(repository));
  const record = (name) => records.find((entry) => entry.text.startsWith(`${name}:`));
  assert.equal(record('loyal-customer-discount').status, 'agreed', '"at least 3 years and orders over 100" pairs both bounds');
  assert.equal(record('high-risk-block').status, 'agreed', 'a rejecting outcome states the allowed range, like a refusal');
  assert.equal(record('minimum-age').status, 'conflict');
  assert.equal(record('minimum-age').conflict, 'the docs say at least 21; the code allows at least 18');
  assert.equal(ruleStatusWords(record('partner-routing')), 'Not documented, enforced.', 'whether a test exercises a rule file is not claimed');
  assert.match(record('partner-routing').text, /apiKey = \(withheld\)/u);
});
