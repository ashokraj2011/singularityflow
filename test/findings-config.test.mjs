/**
 * Finding commands in configuration [CQF:REQ-041, REQ-046, REQ-048]: a lint, static-analysis or
 * security command names a finding reader and a gate; the code step's mode is warn unless the
 * workflow or the capability says otherwise.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DEFAULT_FINDING_GATE, FINDING_RESULT_ADAPTERS, findingCommand, normalizeExternalCommand
} from '../src/external-command-policy.mjs';
import { normalizeCodeDeliveryPolicy, staticAnalysisMode } from '../src/code-delivery-policy.mjs';
import { foldCapabilityPolicy } from '../src/capabilities.mjs';
import { FINDING_READERS, readFindingReport } from '../src/findings/readers/index.mjs';

const eslint = {
  id: 'eslint', kind: 'lint', modelPolicy: 'never',
  argv: ['npx', 'eslint', '--format', 'json-with-metadata', '--output-file', '.sflow/results/eslint.json', '.'],
  result: { adapter: 'eslint-json', path: '.sflow/results/eslint.json' }
};

test('a finding command names its reader, its report under .sflow/results and its gate', () => {
  const normalized = normalizeExternalCommand({ ...eslint, gate: { failOn: ['high', 'blocker'] } });
  assert.deepEqual(normalized.result, { adapter: 'eslint-json', path: '.sflow/results/eslint.json' });
  assert.deepEqual(normalized.gate, { failOn: ['blocker', 'high'] }, 'in severity order');
  assert.equal(findingCommand(normalized), true);
  assert.deepEqual(DEFAULT_FINDING_GATE.failOn, ['blocker', 'critical', 'high']);
  assert.deepEqual(FINDING_RESULT_ADAPTERS, ['eslint-json', 'sarif', 'sonarqube']);
  // As a test report's, the path is the command folder's: a command in web/ writes web/.sflow/results/semgrep.sarif.
  assert.equal(normalizeExternalCommand({ ...eslint, workingDirectory: 'web', result: { adapter: 'sarif', path: '.sflow/results/semgrep.sarif' } }).result.path,
    '.sflow/results/semgrep.sarif');
  for (const [change, code] of [
    [{ result: { adapter: 'eslint-json', path: 'eslint.json' } }, 'QUALITY_COMMAND_FINDING_RESULT_INVALID'],
    [{ result: { adapter: 'eslint-json', path: '.sflow/results/e.json', minimumDiscovered: 1 } }, 'QUALITY_COMMAND_FINDING_RESULT_INVALID'],
    [{ result: { adapter: 'checkstyle', path: '.sflow/results/c.xml' } }, 'QUALITY_COMMAND_FINDING_ADAPTER_INVALID'],
    [{ gate: { failOn: ['severe'] } }, 'QUALITY_COMMAND_GATE_INVALID'],
    [{ gate: { failOn: ['high'], also: 1 } }, 'QUALITY_COMMAND_GATE_INVALID'],
    [{ kind: 'test', gate: { failOn: ['high'] }, result: { adapter: 'node-tap', path: '.sflow/results/t.tap' } }, 'QUALITY_COMMAND_GATE_INVALID'],
    [{ sonarqube: { project: 'p' } }, 'QUALITY_COMMAND_SONARQUBE_INVALID']
  ]) assert.throws(() => normalizeExternalCommand({ ...eslint, ...change }), { code }, JSON.stringify(change));
  // A test adapter on a lint command keeps working as before: it is judged by its exit, not read for findings.
  const junit = normalizeExternalCommand({ ...eslint, result: { adapter: 'junit-xml', path: 'reports/lint.xml' } });
  assert.equal(findingCommand(junit), false);
  assert.equal(findingCommand(normalizeExternalCommand({ id: 'plain-lint', kind: 'lint', argv: ['npx', 'eslint', '.'], modelPolicy: 'never' })), false);
});

test('a SonarQube scanner command names its project and whether the server analyses branches [CQF:REQ-048]', () => {
  const scanner = { id: 'sonar', kind: 'static-analysis', modelPolicy: 'never', environment: 'sonar',
    argv: ['sonar-scanner', '-Dsonar.qualitygate.wait=true', '-Dsonar.working.directory=.sflow/results/scannerwork'],
    result: { adapter: 'sonarqube', path: '.sflow/results/scannerwork/report-task.txt' } };
  assert.deepEqual(normalizeExternalCommand({ ...scanner, sonarqube: { project: 'payments-api', branchAnalysis: true } }).sonarqube,
    { project: 'payments-api', branchAnalysis: true });
  assert.deepEqual(normalizeExternalCommand({ ...scanner, sonarqube: { project: 'payments-api', scratchProject: 'payments-api-sflow' } }).sonarqube,
    { project: 'payments-api', branchAnalysis: false, scratchProject: 'payments-api-sflow' });
  assert.throws(() => normalizeExternalCommand({ ...scanner, sonarqube: { project: 'payments-api', scratchProject: 'payments-api' } }),
    { code: 'QUALITY_COMMAND_SONARQUBE_INVALID' }, 'a scratch project is never the main project');
});

test('codeDelivery.staticAnalysis is warn unless set; a capability may only make it enforce [CQF:REQ-046]', () => {
  assert.equal(normalizeCodeDeliveryPolicy({}).staticAnalysis, undefined, 'absent stays absent in the pin');
  assert.deepEqual(normalizeCodeDeliveryPolicy({ staticAnalysis: { mode: 'enforce' } }).staticAnalysis, { mode: 'enforce' });
  assert.deepEqual(normalizeCodeDeliveryPolicy({ staticAnalysis: {} }).staticAnalysis, { mode: 'warn' });
  assert.throws(() => normalizeCodeDeliveryPolicy({ staticAnalysis: { mode: 'strict' } }), /staticAnalysis\.mode must be warn, enforce, off/u);
  assert.throws(() => normalizeCodeDeliveryPolicy({ staticAnalysis: { mode: 'warn', other: true } }), /staticAnalysis must be/u);
  const story = (mode, capability) => ({ resolution: { codeDelivery: mode ? { staticAnalysis: { mode } } : {},
    capability: capability ? { policy: { staticAnalysis: capability } } : null } });
  assert.equal(staticAnalysisMode(story(null)), 'warn');
  assert.equal(staticAnalysisMode(story('off')), 'off');
  assert.equal(staticAnalysisMode(story('warn', 'enforce')), 'enforce');
  assert.equal(staticAnalysisMode(story('enforce', 'warn')), 'enforce', 'a capability never loosens');
  assert.equal(foldCapabilityPolicy({ staticAnalysis: 'warn' }, { staticAnalysis: 'enforce' }).staticAnalysis, 'enforce');
  assert.throws(() => foldCapabilityPolicy({ staticAnalysis: 'enforce' }, { staticAnalysis: 'warn' }), { code: 'CAPABILITY_POLICY_LOOSENED' });
  assert.throws(() => foldCapabilityPolicy({}, { staticAnalysis: 'off' }), { code: 'CAPABILITY_POLICY_INVALID' });
});

test('the adapters a quality command may name each have a reader', async () => {
  for (const adapter of FINDING_RESULT_ADAPTERS) assert.equal(typeof FINDING_READERS[adapter], 'function', adapter);
  assert.equal(readFindingReport('sarif', await readFile(new URL('./fixtures/findings/codeql.sarif', import.meta.url), 'utf8')).findings.length, 2);
  assert.throws(() => readFindingReport('nope', '{}'), TypeError);
});
