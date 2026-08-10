/**
 * What happens when a footer link is followed and the destination is not there.
 *
 * The wiring test proves the five links resolve to five contributed, registered commands. This is
 * the part that only exists at runtime: three of those — Journey, Approvals, Configuration — are
 * registered after a governed repository resolves, while Help and Diagnostics are registered before
 * it and can both be opened with no workspace selected. So Help's footer can offer Journey at a
 * moment when Journey does not exist, and executing an unregistered command raises VS Code's own
 * "command 'x' not found" — the dead control this footer was added to remove, one level down.
 *
 * The judgement is tested rather than the adapter. `navigate.ts` imports `vscode` as an ESM module,
 * and the CommonJS substitution vscode-host.test.mjs uses does not reach an ESM import, so the
 * decision was moved somewhere it can be examined and the adapter left small enough to read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { navigationPlan, NAV_COMMANDS, NAV_RESOLVE_COMMAND } =
  await import('../apps/vscode/src/views/webview.ts');

/** Everything that exists once a governed repository has resolved. */
const RESOLVED = [...Object.values(NAV_COMMANDS), NAV_RESOLVE_COMMAND];
/** What exists before one does — the state in which Help and Diagnostics can still be opened. */
const DEGRADED = ['singularityFlow.doctor', 'singularityFlow.openHelp', NAV_RESOLVE_COMMAND];

test('every destination is simply executed once the repository has resolved', () => {
  for (const command of Object.values(NAV_COMMANDS)) {
    assert.deepEqual(navigationPlan(command, RESOLVED), { kind: 'execute', command });
  }
});

test('the destinations that survive the degraded state still work there', () => {
  for (const command of ['singularityFlow.doctor', 'singularityFlow.openHelp']) {
    assert.equal(navigationPlan(command, DEGRADED).kind, 'execute',
      `${command} is registered early and must not be treated as missing`);
  }
});

test('a destination that does not exist yet explains itself instead of throwing', () => {
  for (const command of [
    'singularityFlow.openJourney',
    'singularityFlow.openApprovals',
    'singularityFlow.openConfigurationCenter'
  ]) {
    const plan = navigationPlan(command, DEGRADED);
    assert.equal(plan.kind, 'unavailable', `${command} is registered late and must be guarded`);
    assert.match(plan.message, /governed repository/);
    assert.equal(plan.action, 'Choose a workspace');
    // And the offer resolves the actual cause rather than just apologising.
    assert.equal(plan.resolve, NAV_RESOLVE_COMMAND);
    assert.ok(DEGRADED.includes(plan.resolve), 'the remedy must itself be reachable in this state');
  }
});

test('the remedy is never the thing that was unavailable', () => {
  // A loop here would be worse than the original error: press Journey, be offered something that
  // also does not exist, press that.
  const plan = navigationPlan('singularityFlow.openJourney', []);
  assert.notEqual(plan.resolve, 'singularityFlow.openJourney');
});
