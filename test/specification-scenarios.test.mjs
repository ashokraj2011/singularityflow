import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectSpecificationScenarios } from '../src/specification-scenarios.mjs';
import { extractClauses } from '../src/specifications.mjs';
import { analyzeSpecification, evaluateSpecificationQuality, policyHash, specificationQualityPolicy } from '../src/specification-quality.mjs';

const source = '# Hex specification\n\n## Actors\n\nA calculator user.\n\n## User scenarios\n\n'
  + '### S1 — Valid input\n\nGiven a positive integer\nWhen Hex is selected\nThen uppercase hex is displayed.\n\n'
  + '### S2 — Invalid input\n\nGiven a fractional or negative value\nWhen Hex is selected\nThen the display shows an error and arithmetic remains available.\n\n'
  + '## Requirements\n\n- Convert positive integers. [EGL:REQ-001]\n'
  + '- Show an error for other values. [EGL:REQ-002]\n'
  + '- Retain a screenshot showing conversion. [EGL:AC-001]\n';
const matrix = '\n## Scenario coverage\n\n| Clause | Scenario | Outcome |\n|---|---|---|\n'
  + '| `EGL:REQ-001` | S1 | success |\n| `EGL:REQ-002` | S2 | failure |\n| `EGL:AC-001` | S1 | success |\n';
const inspect = (text, options = {}) => inspectSpecificationScenarios(text, extractClauses(text), options);

test('the declared matrix checks all clauses, distinct failure cases and observable GWT structure', () => {
  const result = inspect(source + matrix, { required: true });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.advisories, []);
  assert.equal(result.scenarioCount, 2);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(inspect((source + matrix).replaceAll('\n', '\r\n')).findings, []);
  assert.deepEqual(inspect((source + matrix).replaceAll('`EGL:', '`egl:').replaceAll('| S2 |', '| s2 |')).findings, []);
});

test('legacy happy-path-only drafts get a specific failure hint, never a heuristic refusal', () => {
  const legacy = source.replace(/### S2[\s\S]*?(?=## Requirements)/u, '')
    + '\n## Failure and empty states\n\nInvalid inputs show an error.\n';
  const result = inspect(legacy);
  assert.deepEqual(result.findings, []);
  assert.equal(result.advisories.length, 1);
  assert.equal(result.advisories[0].clauseId, 'EGL:REQ-002');
  assert.match(result.advisories[0].message, /distinct Given\/When\/Then.*observable error/u);
  const report = analyzeSpecification(legacy, { policy: { mode: 'enforce' } });
  assert.deepEqual(evaluateSpecificationQuality(report).errors, []);
  assert.equal(evaluateSpecificationQuality(report).warnings.length, 1);
});

test('required coverage cannot be deleted and typed rows cannot point to nonexistent cases', () => {
  assert.equal(inspect(source, { required: true }).findings[0].kind, 'scenario-coverage-required');
  const missing = inspect(source + matrix.replace('| S2 | failure', '| S3 | failure'));
  assert.ok(missing.findings.some(finding => finding.kind === 'scenario-coverage-scenario-missing'
    && finding.clauseId === 'EGL:REQ-002' && finding.scenarioId === 'S3' && finding.line > 1));
  const noFailure = inspect(source + matrix.replace('| S2 | failure', '| S1 | success'));
  assert.equal(noFailure.advisories.length, 1, 'a happy-path row does not silence the failure hint');
});

test('incomplete acceptance cases report their exact scenario and preserve the authored draft', () => {
  for (const mutation of [
    text => text.replace('Then the display shows an error and arithmetic remains available.', 'Then'),
    text => text.replace('When Hex is selected\nThen the display', 'Then the display'),
    text => text.replace('## Requirements', 'Given another invalid value\nWhen Hex is selected\n\n## Requirements')
  ]) {
    const text = mutation(source + matrix);
    const result = inspect(text);
    assert.ok(result.findings.some(finding => finding.kind === 'scenario-acceptance-incomplete'
      && finding.scenarioId === 'S2' && finding.line === source.split('\n').findIndex(line => line.startsWith('### S2')) + 1));
    assert.equal(text, mutation(source + matrix));
  }
});

test('one-line and bold Given/When/Then cases with literal outcomes are supported', () => {
  const compact = (source + matrix).replace('Given a fractional or negative value\nWhen Hex is selected\nThen the display shows an error and arithmetic remains available.',
    '- **Given** an invalid value **When** Hex is selected **Then** the display shows `Error`.');
  assert.deepEqual(inspect(compact).findings, []);
  assert.deepEqual(inspect(compact).advisories, []);
});

test('nested situations and literal keyword strings cannot lend another case its acceptance fields', () => {
  const text = source.replace('### S2', '#### S2');
  assert.deepEqual(inspect(text + matrix).findings, []);
  const broken = text.replace('Then uppercase hex is displayed.', 'Then');
  assert.ok(inspect(broken + matrix).findings.some(finding => finding.kind === 'scenario-acceptance-incomplete'
    && finding.scenarioId === 'S1'));
  const literal = source.replace('Then uppercase hex is displayed.', 'Then the literal `Given When Then` is displayed.');
  assert.deepEqual(inspect(literal + matrix).findings, []);
});

test('comments, code examples and managed upstream inputs cannot supply scenario proof', () => {
  const absent = source.replace(/### S2[\s\S]*?(?=## Requirements)/u, '') + matrix;
  const ghost = '### S2 — Example\nGiven an invalid value\nWhen Hex is selected\nThen show an error.\n';
  for (const wrapper of [text => `<!--\n${text}-->`, text => `\`\`\`markdown\n${text}\`\`\``,
    text => `~~~markdown\n${text}~~~`,
    text => `<!-- singularity-flow:inputs:start -->\n${text}<!-- singularity-flow:inputs:end -->`]) {
    const result = inspect(wrapper(ghost) + '\n' + absent);
    assert.ok(result.findings.some(finding => finding.kind === 'scenario-coverage-scenario-missing'));
    assert.equal(result.advisories.length, 1);
  }
});

test('duplicate definitions, unknown clauses, unmapped clauses and malformed outcomes are diagnosed', () => {
  for (const [text, kind] of [
    [source + matrix + '\n### S2 — Duplicate\nGiven input When selected Then show an error.\n', 'scenario-definition-duplicate'],
    [source + matrix.replace('`EGL:REQ-002`', '`OTHER:REQ-002`'), 'scenario-coverage-clause-unknown'],
    [source + matrix.replace('| `EGL:REQ-002` | S2 | failure |\n', ''), 'scenario-coverage-clause-missing'],
    [source + matrix.replace('| failure |', '| passed |'), 'scenario-coverage-row-invalid'],
    [source + matrix.replace('Scenario | Outcome', 'Scenario | Result'), 'scenario-coverage-format'],
    [source + matrix + '| `EGL:REQ-001` | S1 | success |\n', 'scenario-coverage-row-duplicate'],
    [source + matrix + matrix, 'scenario-coverage-duplicate']
  ]) assert.ok(inspect(text).findings.some(finding => finding.kind === kind), kind);
});

test('multiple outcomes may cover one clause, and constraints need no fabricated user case', () => {
  const text = source + '\n- No remote service is used. [EGL:CON-001]\n' + matrix
    + '| `EGL:REQ-001` | S2 | boundary |\n';
  assert.deepEqual(inspect(text).findings, []);
});

test('new required policy is pinned, while omission and explicit off preserve legacy behavior', () => {
  assert.equal(Object.hasOwn(specificationQualityPolicy({ mode: 'enforce' }), 'scenarioCoverage'), false);
  assert.throws(() => specificationQualityPolicy({ scenarioCoverage: 'guess' }), /off or required/u);
  const legacy = policyHash({ mode: 'enforce' });
  assert.notEqual(policyHash({ mode: 'enforce', scenarioCoverage: 'required' }), legacy);
  assert.equal(policyHash({ mode: 'enforce' }), legacy);
  const report = analyzeSpecification(source, { policy: { mode: 'enforce', scenarioCoverage: 'required' } });
  assert.ok(evaluateSpecificationQuality(report).errors.some(message => /Scenario coverage/u.test(message)));
  const disabled = analyzeSpecification(source + matrix.replace('| S2 |', '| S99 |'), {
    policy: { mode: 'enforce', scenarioCoverage: 'off' }
  });
  assert.deepEqual(disabled.findings, []);
  assert.equal(disabled.scenarioCoverage, undefined);
});
