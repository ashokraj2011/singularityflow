import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const AUTHORING_SURFACES = [
  '../templates/artifacts/spec-driven/plan.md',
  '../templates/artifacts/bugfix/fix-spec.md',
  '../templates/artifacts/feature/implementation-spec.md',
  '../templates/artifacts/benchmark/design.md',
  '../templates/artifacts/figma-mobile/mobile-spec.md',
  '../templates/artifacts/poc-workflow/ui-exploration.md'
];

test('planning-owner templates require exact planned-test claim bindings', async () => {
  for (const source of AUTHORING_SURFACES) {
    const content = await readFile(new URL(source, import.meta.url), 'utf8');
    assert.match(content, /^\| Clause \| Expected paths \| Planned tests \| Fulfillment \| Observable result \|$/m, source);
    assert.match(content, /Fulfillment: new, modified, existing .*test-only .*document, configuration, or evidence .*Observable result/s, source);
    assert.match(content, /never repeat a test file in both columns/i, source);
    assert.match(content, /fully qualified/i, source);
    assert.match(content, /repository-relative/i, source);
    assert.match(content, /exact\s+repository-relative\s+(?:source and test\s+)?paths? in backticks/i, source);
    assert.match(content, /`not-applicable:` followed by.*concrete reviewed/s, source);
    assert.match(content, /genuinely\s+non-testable/i, source);
    assert.match(content, /`(?:\{\{work\.id\}\}|POC):[A-Z]+-001`/, source);
    assert.doesNotMatch(content, /`(?:src|test|tests)\/path\/to\//, `${source} invents a project path`);
    assert.match(content, /TODO: replace with exact backticked repository-relative/, source);
  }
});

test('Figma Mobile and POC define namespaced clauses before their planned-test owner', async () => {
  const mobile = await readFile(
    new URL('../templates/artifacts/figma-mobile/mobile-spec.md', import.meta.url), 'utf8'
  );
  const pocIntake = await readFile(
    new URL('../templates/artifacts/poc-workflow/intake.md', import.meta.url), 'utf8'
  );
  const pocExploration = await readFile(
    new URL('../templates/artifacts/poc-workflow/ui-exploration.md', import.meta.url), 'utf8'
  );

  assert.match(mobile, /\[\{\{work\.id\}\}:AC-001\]/);
  assert.match(mobile, /\[\{\{work\.id\}\}:IFC-001\]/);
  assert.match(mobile, /^## Planned implementation evidence$/m);
  assert.match(pocIntake, /\[POC:AC-001\]/);
  assert.match(pocExploration, /^## Planned test generation evidence$/m);

  for (const [label, content] of [['figma-mobile', mobile], ['poc-workflow', pocExploration]]) {
    assert.doesNotMatch(content, /`(?:src|test|tests)\/path\/to\//, `${label} invents a project path`);
    assert.match(content, /TODO: replace with exact backticked repository-relative/, label);
  }
});

test('sflow-plan preserves the structured claim table and refuses vague paths', async () => {
  const content = await readFile(
    new URL('../plugin/skills/sflow-plan/SKILL.md', import.meta.url),
    'utf8'
  );
  assert.match(content, /fill the planned-evidence table, one row per authoritative clause/);
  assert.match(content, /fully qualified ID/);
  assert.match(content, /backticked exact repository-relative paths \(never directories, globs, modules or prose\)/);
  assert.match(content, /Fulfillment and Observable result/);
  assert.match(content, /non-testable clauses use `not-applicable:` with a reviewed explanation, never to hide unknowns/);
  assert.match(content, /Test-only obligations use fulfillment `test-only` with `Expected paths` = `-`/);
});

test('authoring skills relay returned correction and human-risk alternatives without auto acceptance', async () => {
  for (const name of ['code', 'phase', 'plan', 'specify', 'design', 'requirements', 'release']) {
    const content = await readFile(new URL(`../plugin/skills/sflow-${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(content, /resolution\.issues\[\]\.choices/, name);
    assert.match(content, /Never auto-accept risk/, name);
    assert.match(content, /authorized human confirmation/, name);
  }
  const code = await readFile(new URL('../plugin/skills/sflow-code/SKILL.md', import.meta.url), 'utf8');
  assert.match(code, /revision status --json` only when `generation > 0`/);
  assert.match(code, /first-generation authoring creates that candidate/);
});
