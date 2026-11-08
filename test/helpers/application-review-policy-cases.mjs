import * as native from '../../src/code-delivery-policy.mjs';
import * as facade from '../../src/application-review-policy.mjs';
import { recordSha256 } from '../../src/records.mjs';
import { readRecord } from '../../src/schema-migrations.mjs';

export const reviewPolicyModules = { native, facade };

export function reviewRecordSyntaxResults(read = value => {
  const { record, storedVersion } = readRecord('application-review-policy', value);
  return { record, storedVersion };
}) {
  const inputs = [
    ['ordinary', () => ({ mode: 'required' })], ['versioned', () => ({ schemaVersion: 1, mode: 'off' })],
    ['null-prototype', () => Object.assign(Object.create(null), { mode: 'optional' })],
    ['text', () => '{"schemaVersion":1,"quality":["unicode 🧭"]}'],
    ['buffer', () => Buffer.from('{"schemaVersion":1,"mode":"required"}')],
    ['uint8', () => new Uint8Array(Buffer.from('{"mode":"optional"}'))],
    ['empty-buffer', () => Buffer.alloc(0)], ['empty-uint8', () => new Uint8Array()],
    ['bom', () => Buffer.from('\ufeff{"mode":"off"}')], ['malformed-utf8', () => Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])],
    ['text-array', () => '[]'], ['text-null', () => 'null'], ['invalid-json', () => '{'],
    ['array', () => []], ['null', () => null], ['undefined', () => undefined], ['date', () => new Date(0)],
    ['uint16', () => new Uint16Array([123, 125])], ['arraybuffer', () => new ArrayBuffer(2)], ['dataview', () => new DataView(new ArrayBuffer(2))],
    ['future', () => ({ schemaVersion: 2 })], ['invalid-version', () => ({ schemaVersion: 'future' })],
    ['detached-bytes', () => { const buffer = new ArrayBuffer(2), bytes = new Uint8Array(buffer); structuredClone(buffer, { transfer: [buffer] }); return bytes; }],
    ['shared-bytes', () => { const bytes = new Uint8Array(new SharedArrayBuffer(2)); bytes.set([123, 125]); return bytes; }]
  ];
  return inputs.map(([id, make]) => {
    try { return { id, value: read(make()) }; }
    catch (error) { return { id, error: errorResult(error) }; }
  });
}

const cases = [
  ['absent', () => undefined], ['null', () => null], ['default', () => ({})],
  ['explicit-version', () => ({ schemaVersion: 1 })],
  ...['off', 'optional', 'required'].map(mode => ['mode-' + mode, () => ({ mode })]),
  ...['auto', 'web', 'backend', 'cli', 'library', 'artifact'].map(surface => ['surface-' + surface, () => ({ surface })]),
  ['complete', () => ({ schemaVersion: 1, mode: 'required', surface: 'web',
    preview: { entry: 'review-app', outputDirectory: 'build/review' }, repairAttempts: 3, totalRepairAttempts: 12,
    authorities: ['engineering-reviewers', 'quality-reviewers', 'engineering-reviewers'],
    quality: ['  Error behavior is visible  ', 'Error behavior is visible'],
    capture: { maximumPages: 24, casesPerPage: 10, maximumBytes: 20000, timeoutMs: 10000, viewport: { width: 1920, height: 1080 } } })],
  ['lower-limits', () => ({ repairAttempts: 1, totalRepairAttempts: 1, capture: { maximumPages: 1, casesPerPage: 1, maximumBytes: 1024, timeoutMs: 1000, viewport: { width: 640, height: 480 } } })],
  ['upper-limits', () => ({ repairAttempts: 10, totalRepairAttempts: 100, capture: { maximumPages: 500, casesPerPage: 50, maximumBytes: 268435456, timeoutMs: 600000, viewport: { width: 3840, height: 2160 } } })],
  ['null-fields', () => ({ mode: null, surface: null, preview: null, capture: null, quality: null, authorities: null })],
  ['null-prototype', () => Object.assign(Object.create(null), { mode: 'required' })],
  ['array', () => []], ['string', () => 'required'], ['boolean', () => false], ['number', () => 1],
  ['date', () => new Date('2026-01-01T00:00:00Z')],
  ['class', () => new (class Policy {})()],
  ['future-version', () => ({ schemaVersion: 2 })], ['zero-version', () => ({ schemaVersion: 0 })],
  ['text-version', () => ({ schemaVersion: '1' })], ['negative-version', () => ({ schemaVersion: -1 })],
  ['fraction-version', () => ({ schemaVersion: 1.5 })], ['null-version', () => ({ schemaVersion: null })],
  ['uncloneable-mode', () => ({ mode: () => 'required' })],
  ['unknown-authority', () => ({ approvedBy: 'model' })], ['unknown-mode', () => ({ mode: 'accepted' })],
  ['unknown-surface', () => ({ surface: 'desktop' })], ['zero-budget', () => ({ repairAttempts: 0 })],
  ['infinite-budget', () => ({ totalRepairAttempts: Infinity })], ['fraction-budget', () => ({ repairAttempts: 1.5 })],
  ['preview-parent', () => ({ preview: { outputDirectory: '../outside' } })],
  ['preview-absolute', () => ({ preview: { outputDirectory: '/outside' } })],
  ['preview-backslash', () => ({ preview: { outputDirectory: 'build\\review' } })],
  ['preview-invalid-entry', () => ({ preview: { entry: 'Build App' } })],
  ['preview-extra-field', () => ({ preview: { command: 'start' } })],
  ['empty-authorities', () => ({ authorities: [] })], ['bad-authorities', () => ({ authorities: ['Quality Reviewer'] })],
  ['quality-not-list', () => ({ quality: 'works' })], ['quality-too-many', () => ({ quality: Array(51).fill('works') })],
  ['quality-empty', () => ({ quality: [' '] })], ['quality-too-long', () => ({ quality: ['x'.repeat(1001)] })],
  ['capture-extra-field', () => ({ capture: { recorded: true } })],
  ['capture-too-few-pages', () => ({ capture: { maximumPages: 0 } })],
  ['capture-too-large', () => ({ capture: { maximumBytes: 268435457 } })],
  ['capture-too-slow', () => ({ capture: { timeoutMs: 600001 } })],
  ['viewport-too-narrow', () => ({ capture: { viewport: { width: 1, height: 800 } } })],
  ['viewport-extra-field', () => ({ capture: { viewport: { width: 1280, height: 800, scale: 2 } } })]
];

function errorResult(error) {
  return { name: error.name, message: error.message, code: error.code ?? null, details: error.details ?? null,
    exitCode: error.exitCode ?? null, cause: error.cause ? { name: error.cause.name, message: error.cause.message } : null };
}

export function applicationReviewPolicyResults(api = native) {
  return cases.map(([id, make]) => {
    try {
      const value = api.normalizeApplicationReview(make());
      return { id, value, sha256: recordSha256(value) };
    } catch (error) { return { id, error: errorResult(error) }; }
  });
}

export function applicationReviewPhaseResults(api = native) {
  const code = (id, generation = 1) => ({ id, generation, generationPolicy: { task: 'code', requirement: 'required' }, artifact: { kind: 'implementation-summary' } });
  const report = id => ({ id, generation: 1, generationPolicy: { task: 'verification', requirement: 'required' }, artifact: { kind: 'test-evidence' } });
  const first = code('deliver'), second = code('repair'), later = report('evidence');
  const phases = { deliver: first, repair: second, evidence: later };
  const entries = [
    ['current-code', { currentPhase: 'deliver', phaseOrder: Object.keys(phases), phases }],
    ['current-later-code', { currentPhase: 'repair', phaseOrder: Object.keys(phases), phases }],
    ['report-after-two-deliveries', { currentPhase: 'evidence', phaseOrder: Object.keys(phases), phases }],
    ['no-explicit-order', { currentPhase: 'evidence', phases }],
    ['unpublished-later-code', { currentPhase: 'evidence', phases: { ...phases, repair: code('repair', 0) } }],
    ['no-published-code', { currentPhase: 'evidence', phases: { evidence: later } }],
    ['unknown-current', { currentPhase: 'unknown', phases }],
    ['null-current', { currentPhase: null, phases }]
  ];
  const result = entries.map(([id, workflow]) => ({ id, value: api.applicationReviewPhase(workflow) }));
  for (const [id, workflow] of [
    ['absent-test-scope', {}], ['intake-test-scope', { resolution: { testExecutionMode: 'all-configured' } }],
    ['amended-test-scope', { resolution: { testExecutionMode: 'all-configured' }, testScopeChanges: [{ to: 'new-and-changed' }] }]
  ]) result.push({ id, value: api.storyTestScope(workflow) });
  for (const [id, value] of [['phases', [first, later]], ['workflow', { phases: [first, second, later] }], ['empty', {}]])
    result.push({ id: 'code-generation-' + id, value: api.workflowCodeGeneration(value) });
  for (const [id, phase, workflow] of [
    ['configured', { id: 'deliver', authoringSkill: 'draft-code' }, null],
    ['pinned', { id: 'deliver', authoringSkill: 'changed' }, { resolution: { phases: [{ id: 'deliver', authoringSkill: 'original' }] } }],
    ['pinned-missing', { id: 'deliver', authoringSkill: 'changed' }, { resolution: { phases: [] } }]
  ]) result.push({ id: 'authoring-' + id, value: api.configuredAuthoringSkill(phase, workflow) });
  return result;
}
