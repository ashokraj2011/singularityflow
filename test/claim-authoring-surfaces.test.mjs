import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const AUTHORING_SURFACES = [
  '../templates/artifacts/spec-driven/plan.md',
  '../templates/artifacts/bugfix/fix-spec.md',
  '../templates/artifacts/feature/implementation-spec.md'
];

test('planning-owner templates require exact planned-test claim bindings', async () => {
  for (const source of AUTHORING_SURFACES) {
    const content = await readFile(new URL(source, import.meta.url), 'utf8');
    assert.match(content, /^\| Clause \| Expected paths \| Planned tests \|$/m, source);
    assert.match(content, /fully qualified/i, source);
    assert.match(content, /repository-relative/i, source);
    assert.match(content, /exact\s+repository-relative\s+(?:source and test\s+)?paths? in backticks/i, source);
    assert.match(content, /`not-applicable:` followed by.*concrete reviewed/s, source);
    assert.match(content, /genuinely\s+non-testable/i, source);
    assert.match(content, /`\{\{work\.id\}\}:[A-Z]+-001`/, source);
  }
});

test('sflow-plan preserves the structured claim table and refuses vague paths', async () => {
  const content = await readFile(
    new URL('../plugin/skills/sflow-plan/SKILL.md', import.meta.url),
    'utf8'
  );
  assert.match(content, /Clause \| Expected paths \| Planned tests/);
  assert.match(content, /exactly one row per authoritative clause/);
  assert.match(content, /fully qualified ID/);
  assert.match(content, /backticked, repository-relative exact paths/);
  assert.match(content, /Never use directories, globs, modules, or prose as paths/);
  assert.match(content, /`not-applicable:` followed by.*concrete reviewed/s);
  assert.match(content, /genuinely\s+non-testable/);
});
