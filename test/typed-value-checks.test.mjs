/**
 * The places a person must type an exact value, or tick a box before a button, stay counted and only fall [owner, 2026-11-28:
 * "No typed values and no second confirmations"]. scripts/typed-value-checks.mjs reads them from the sources.
 *
 * Measured on main b63148851 before this work: 54 (22 terminal prompts, 5 VS Code input boxes, 10 VS Code pages to type into,
 * 14 pages with a box to tick, 3 skill lines). What is left is each kept for a reason named here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { typedValueChecks } from '../scripts/typed-value-checks.mjs';

// Kept, each for its reason: the person's own terminal review of a governance step (live terminal review, owner 2026-11-19),
// the factory reset's permanent discard, trusting an agent's public dependencies (supply chain), the telemetry disclosure
// (consent to capture, twice: the CLI and its command), and the version question's typed "yes" in the person's own terminal
// (a Yes already, two prompts) [ask once].
const KEPT = Object.freeze([
  'src/action-authorization.mjs', 'src/cli.mjs', 'src/cli.mjs', 'src/cli.mjs', 'src/commands/phase-opening.mjs', 'src/commands/telemetry.mjs',
  'src/requested-successor.mjs']);

test('typed-value checks: only the kept ones are left, and none in VS Code or in a skill', async () => {
  const { total, kinds, sites } = await typedValueChecks();
  assert.deepEqual(kinds, { 'terminal-typed': KEPT.length, 'vscode-typed-box': 0, 'vscode-typed-page': 0, 'vscode-checkbox': 0, 'chat-typed': 0 },
    sites.map((site) => `${site.kind} ${site.file}:${site.line} ${site.text}`).join('\n'));
  assert.equal(total, KEPT.length);
  assert.deepEqual(sites.map((site) => site.file).sort(), [...KEPT].sort());
  // The kept CLI prompts, by what they guard: the reset, the agent's trusted dependencies, the telemetry disclosure.
  assert.deepEqual(sites.filter((site) => site.file === 'src/cli.mjs').map((site) => /to reset|trusted hashes|trust decision|usage capture/u.test(site.text)), [true, true, true]);
});
