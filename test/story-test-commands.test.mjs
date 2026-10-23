import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeStoryTestCommands, assertStoryTestCommands, pendingStoryTestCommands, recordStoryTestCommandDecision,
  recordStoryTestCommandRequest, storyTestCommandState
} from '../src/story-test-commands.mjs';
import { resolveDeliveryQualityCommands, testCommandProvenance } from '../src/delivery-evidence.mjs';

const story = () => ({ workItem: { id: 'S-1' }, phaseOrder: ['implement'], phases: { implement: { id: 'implement', status: 'in_progress' } } });
const command = (id = 'e2e', argv = ['npx', 'nx', 'run', 'shop-e2e:e2e']) => ({ id, kind: 'test', argv, workingDirectory: '.',
  affectedRoots: ['apps/shop'], modelPolicy: 'never', result: { adapter: 'junit-xml', path: 'reports/junit.xml', minimumDiscovered: 1 } });
const request = (workflow, value = command(), actor = 'dev@example.invalid') => recordStoryTestCommandRequest(workflow,
  { phaseId: 'implement', command: value, reason: 'The Nx Playwright run is how this repository tests the app.', actor, at: '2026-10-24T10:00:00.000Z' });
const decide = (workflow, id, outcome, extra = {}) => recordStoryTestCommandDecision(workflow, { id, outcome, actor: 'lead@example.invalid',
  authorityGroup: 'tech-leads', at: '2026-10-24T11:00:00.000Z', reason: outcome === 'revoke' ? 'The repository now configures this runner.' : '', ...extra });

test('a requested command runs only once a step approver accepts it, and stops when revoked', () => {
  const workflow = story();
  const requested = request(workflow);
  assert.equal(requested.id, 'TCD-001');
  assert.deepEqual(pendingStoryTestCommands(workflow, 'implement').map((entry) => entry.id), ['TCD-001']);
  assert.deepEqual(activeStoryTestCommands(workflow, 'implement'), [], 'a request alone runs nothing');
  assert.equal(workflow.phases.implement.storyTestCommands, undefined);
  decide(workflow, 'TCD-001', 'accept');
  assert.equal(storyTestCommandState(workflow, 'TCD-001').state, 'accepted');
  const [active] = workflow.phases.implement.storyTestCommands;
  assert.deepEqual(active.argv, ['npx', 'nx', 'run', 'shop-e2e:e2e']);
  assert.match(active.storyDecision.sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(testCommandProvenance(workflow.phases.implement, active), 'story-decision');
  assert.deepEqual(pendingStoryTestCommands(workflow, 'implement'), []);
  assertStoryTestCommands(workflow);
  decide(workflow, 'TCD-001', 'revoke');
  assert.equal(workflow.phases.implement.storyTestCommands, undefined);
  assert.throws(() => decide(workflow, 'TCD-001', 'accept'), { code: 'TEST_COMMAND_DECISION_CLOSED' });
});

test('the latest acceptance of a command ID wins; a pending request never displaces an accepted command', () => {
  const workflow = story();
  request(workflow);
  decide(workflow, 'TCD-001', 'accept');
  request(workflow, command('e2e', ['npx', 'nx', 'run', 'shop-e2e:e2e', '--configuration=xq1']));
  assert.deepEqual(activeStoryTestCommands(workflow, 'implement').map((entry) => entry.storyDecision.id), ['TCD-001']);
  decide(workflow, 'TCD-002', 'accept');
  assert.deepEqual(workflow.phases.implement.storyTestCommands.map((entry) => entry.storyDecision.id), ['TCD-002']);
  decide(workflow, 'TCD-002', 'revoke');
  assert.deepEqual(workflow.phases.implement.storyTestCommands.map((entry) => entry.storyDecision.id), ['TCD-001'], 'revoking the newer one restores the older acceptance');
});

test('self-acceptance follows the step policy, closed steps take no decision, and hand-added commands are refused', () => {
  const workflow = story();
  request(workflow, command(), 'lead@example.invalid');
  assert.throws(() => decide(workflow, 'TCD-001', 'accept', { selfApproval: false }), { code: 'TEST_COMMAND_SELF_ACCEPTANCE' });
  decide(workflow, 'TCD-001', 'accept', { selfApproval: true });
  assert.throws(() => decide(workflow, 'TCD-009', 'accept'), { code: 'TEST_COMMAND_DECISION_UNKNOWN' });
  assert.throws(() => recordStoryTestCommandRequest(workflow, { phaseId: 'implement', command: command(), reason: 'short', actor: 'a', at: 'x' }),
    { code: 'TEST_COMMAND_DECISION_INVALID' });
  workflow.phases.implement.storyTestCommands.push({ ...command('sneaky', ['true']), storyDecision: { id: 'TCD-001', sha256: 'sha256:0' } });
  assert.throws(() => assertStoryTestCommands(workflow), { code: 'TEST_COMMAND_DECISION_STATE_INVALID' });
  const closed = story();
  closed.phases.implement.status = 'approved';
  assert.throws(() => request(closed), { code: 'TEST_COMMAND_DECISION_CLOSED' });
});

test('an accepted command is resolved like a configured one and owns its affected roots', async () => {
  const workflow = story();
  request(workflow);
  decide(workflow, 'TCD-001', 'accept');
  const phase = { ...workflow.phases.implement, writeScope: 'source-and-artifact', generationPolicy: { task: 'code' },
    requiredArtifact: { kind: 'implementation-summary' }, qualityCommands: [], deliveryEvidence: { sourcePaths: [], testPaths: [] } };
  const commands = await resolveDeliveryQualityCommands(process.cwd(), phase);
  assert.deepEqual(commands.map((entry) => [entry.id, testCommandProvenance(phase, entry)]), [['e2e', 'story-decision']]);
});
