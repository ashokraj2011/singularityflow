import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { capabilityActivationSucceeded } from '../apps/vscode/src/views/capability-proposal-model.ts';

const panelSource = await readFile(new URL(
  '../apps/vscode/src/views/capability-proposal.ts', import.meta.url
), 'utf8');

test('capability activation requires an explicit positive kernel attestation', () => {
  assert.equal(capabilityActivationSucceeded({ activated: true }), true);
  assert.equal(capabilityActivationSucceeded({ activated: false }), false);
  assert.equal(capabilityActivationSucceeded({}), false,
    'version-skew or malformed successful JSON cannot unlock a dependent journey');
  assert.equal(capabilityActivationSucceeded(null), false);
  assert.equal(capabilityActivationSucceeded('activated'), false);
});

test('a reused exact proposal panel retains new activation follow-ups', () => {
  assert.match(panelSource,
    /if \(onActivated\) existing\.activationCallbacks\.add\(onActivated\)/,
    'opening an already-visible exact proposal must still attach the team/workspace handoff');
  assert.match(panelSource,
    /Promise\.allSettled\([\s\S]*activationCallbacks/,
    'every attached UI follow-up runs only after explicit activation');
});
