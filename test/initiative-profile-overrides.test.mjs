import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { resolveInitiativeProfile, validatePortfolio } from '../src/initiative-config.mjs';

const shipped = YAML.parse(await readFile(new URL('../templates/portfolio.yml', import.meta.url), 'utf8'));

/** A second delivery type running the same phases, reshaped by overrides. */
function withVariant(overrides = {}) {
  const value = structuredClone(shipped);
  value.initiativeProfiles['enterprise-internal'] = {
    label: 'Enterprise internal',
    lifecycleMode: 'full-delivery',
    phases: value.initiativeProfiles['enterprise-delivery'].phases,
    ...overrides
  };
  return value;
}

test('two delivery types can share a phase and demand different things of it', () => {
  const portfolio = validatePortfolio(withVariant({
    templateOverrides: { 'discover-define/requirements': 'initiatives/internal-requirements.md' },
    phaseOverrides: {
      elaboration: {
        label: 'Elaboration (internal)',
        bundleApproval: { mode: 'bundle', authorities: ['initiative-owners'], minimum: 1 },
        outputs: { 'solution-architecture': { required: false }, 'adr-log': { required: false } }
      }
    }
  }));
  const internal = resolveInitiativeProfile(portfolio, 'enterprise-internal');
  const regulated = resolveInitiativeProfile(portfolio, 'enterprise-delivery');
  const internalElaboration = internal.phases.find((phase) => phase.id === 'elaboration');
  const regulatedElaboration = regulated.phases.find((phase) => phase.id === 'elaboration');

  assert.equal(internalElaboration.label, 'Elaboration (internal)');
  assert.equal(regulatedElaboration.label, 'Elaboration', 'the shared phase is untouched for other profiles');

  assert.equal(internalElaboration.outputs.find((output) => output.id === 'solution-architecture').required, false);
  assert.notEqual(regulatedElaboration.outputs.find((output) => output.id === 'solution-architecture').required, false);

  assert.deepEqual(internalElaboration.bundleApproval.authorities, ['initiative-owners']);

  // Narrowing one output must not drop the rest of its definition.
  const narrowed = internalElaboration.outputs.find((output) => output.id === 'solution-architecture');
  assert.ok(narrowed.path, 'path survives the override');
  assert.ok(narrowed.template, 'template survives the override');
});

test('template overrides are keyed by phase and output', () => {
  const portfolio = validatePortfolio(withVariant({
    templateOverrides: { 'discover-define/requirements': 'initiatives/internal-requirements.md' }
  }));
  const internal = resolveInitiativeProfile(portfolio, 'enterprise-internal');
  const regulated = resolveInitiativeProfile(portfolio, 'enterprise-delivery');
  const templateFor = (resolved) => resolved.phases
    .find((phase) => phase.id === 'discover-define').outputs
    .find((output) => output.id === 'requirements').template;
  assert.equal(templateFor(internal), 'initiatives/internal-requirements.md');
  assert.equal(templateFor(regulated), 'initiatives/requirement-impact.md');
});

test('a profile with no overrides resolves exactly as before', () => {
  const portfolio = validatePortfolio(structuredClone(shipped));
  const resolved = resolveInitiativeProfile(portfolio, 'enterprise-delivery');
  for (const phase of resolved.phases) {
    const base = portfolio.initiativePhases[phase.id];
    assert.equal(phase.label, base.label);
    assert.equal(phase.outputs.length, base.outputs.length);
    assert.deepEqual(phase.outputs.map((output) => output.template), base.outputs.map((output) => output.template));
  }
});

test('overrides are validated against the profile', () => {
  assert.throws(() => validatePortfolio(withVariant({
    templateOverrides: { 'requirements': 'x.md' }
  })), /must be keyed '<phase>\/<output>'/);

  assert.throws(() => validatePortfolio(withVariant({
    templateOverrides: { 'discover-define/nope': 'x.md' }
  })), /references unknown output 'discover-define\/nope'/);

  assert.throws(() => validatePortfolio(withVariant({
    templateOverrides: { 'epic-planning/story-plan': 'x.md' }
  })), /references inactive phase 'epic-planning'/);

  assert.throws(() => validatePortfolio(withVariant({
    phaseOverrides: { 'epic-planning': { label: 'x' } }
  })), /references inactive phase 'epic-planning'/);

  assert.throws(() => validatePortfolio(withVariant({
    phaseOverrides: { elaboration: { outputs: { 'not-an-output': { required: false } } } }
  })), /is not an output of phase 'elaboration'/);

  assert.throws(() => validatePortfolio(withVariant({
    phaseOverrides: { elaboration: { outputs: { 'adr-log': { required: 'no' } } } }
  })), /required must be boolean/);

  assert.throws(() => validatePortfolio(withVariant({
    phaseOverrides: { elaboration: { bundleApproval: { mode: 'bundle', authorities: ['nobody'], minimum: 1 } } }
  })), /unknown approval authority 'nobody'/);
});

test('a delivery type can carry its own control-plane chain for a shared phase', () => {
  // The point of per-type overrides for governance: a regulated delivery needs LRC on elaboration,
  // an internal tool does not.
  const portfolio = validatePortfolio(withVariant({
    phaseOverrides: {
      elaboration: {
        bundleApproval: {
          mode: 'bundle',
          chain: [{ authority: 'architecture-reviewers' }, { authority: 'risk-reviewers', label: 'LRC Review' }]
        }
      }
    }
  }));
  const internal = resolveInitiativeProfile(portfolio, 'enterprise-internal');
  const chain = internal.phases.find((phase) => phase.id === 'elaboration').bundleApproval.chain;
  assert.deepEqual(chain.map((step) => step.authority), ['architecture-reviewers', 'risk-reviewers']);
  assert.equal(chain[1].label, 'LRC Review');
  // The shared phase keeps its own policy for every other profile.
  const regulated = resolveInitiativeProfile(portfolio, 'enterprise-delivery');
  assert.equal(regulated.phases.find((phase) => phase.id === 'elaboration').bundleApproval.chain, null);
});
