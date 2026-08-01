import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { resolveInitiativeProfile, validatePortfolio } from '../src/initiative-config.mjs';
import { initiativePackState } from '../src/initiative-evidence.mjs';

const shipped = YAML.parse(await readFile(new URL('../templates/portfolio.yml', import.meta.url), 'utf8'));

function portfolioWith(packs, { profile = 'enterprise-delivery' } = {}) {
  const value = structuredClone(shipped);
  value.initiativeProfiles[profile].packs = packs;
  return value;
}

/** Minimal initiative shaped like the state object the evidence layer reads. */
function initiativeWith(resolution, publishedByPhase) {
  const phases = {};
  for (const phase of resolution.phases) {
    phases[phase.id] = {
      outputs: Object.fromEntries(phase.outputs.map((output) => {
        const published = publishedByPhase[phase.id]?.includes(output.id);
        return [output.id, {
          id: output.id,
          status: published ? 'published' : 'draft',
          generation: published ? 1 : 0,
          sha256: published ? `${'a'.repeat(63)}${phase.order}` : null
        }];
      }))
    };
  }
  return { initiative: { id: 'SF-E-001' }, resolution, phases };
}

test('the shipped enterprise-delivery profile declares the PDLC artifact packs', () => {
  const portfolio = validatePortfolio(structuredClone(shipped));
  const resolved = resolveInitiativeProfile(portfolio, 'enterprise-delivery');
  assert.deepEqual(resolved.packs.map((pack) => pack.id), [
    'opportunity-investment-brief', 'concept-readiness', 'experience-strategy-concepts',
    'product-readiness', 'technical-design-architecture', 'implementation-specification',
    'validation-release-readiness'
  ]);
  // Profiles that declare no packs stay valid and simply have none.
  assert.deepEqual(resolveInitiativeProfile(portfolio, 'initiative-lite').packs, []);
});

test('a pack is reviewed at the latest phase that contributes a member', () => {
  const portfolio = validatePortfolio(structuredClone(shipped));
  const resolution = resolveInitiativeProfile(portfolio, 'enterprise-delivery');
  const initiative = initiativeWith(resolution, {});
  const terminal = Object.fromEntries(initiativePackState(initiative).map((pack) => [pack.id, pack.terminalPhase]));
  // Cross-phase packs settle on their last phase, which is the whole point of declaring them on the
  // profile rather than on a phase.
  assert.equal(terminal['product-readiness'], 'inception');
  assert.equal(terminal['validation-release-readiness'], 'delivery');
  assert.equal(terminal['concept-readiness'], 'discover-define');
  // Only the packs terminating at a phase are reported for that phase.
  assert.deepEqual(initiativePackState(initiative, 'elaboration').map((pack) => pack.id),
    ['technical-design-architecture', 'implementation-specification']);
});

test('pack completeness tracks required members and ignores optional ones', () => {
  const portfolio = validatePortfolio(structuredClone(shipped));
  const resolution = resolveInitiativeProfile(portfolio, 'enterprise-delivery');
  // opportunity-brief, business-case and product-roadmap are all optional in the shipped profile, so
  // an untouched brief pack must still count as complete rather than blocking the phase forever.
  const empty = initiativePackState(initiativeWith(resolution, {}), 'discover-define');
  const brief = empty.find((pack) => pack.id === 'opportunity-investment-brief');
  assert.equal(brief.complete, true, 'a pack of only optional members is complete when unpublished');
  const concept = empty.find((pack) => pack.id === 'concept-readiness');
  assert.equal(concept.complete, false, 'a required member holds its pack open');
  assert.deepEqual(concept.missing, ['discover-define/requirements']);

  const published = initiativePackState(
    initiativeWith(resolution, { 'discover-define': ['requirements'] }), 'discover-define');
  assert.equal(published.find((pack) => pack.id === 'concept-readiness').complete, true);
});

test('the pack hash covers every member, including optional ones', () => {
  const portfolio = validatePortfolio(structuredClone(shipped));
  const resolution = resolveInitiativeProfile(portfolio, 'enterprise-delivery');
  const base = initiativePackState(initiativeWith(resolution, { 'discover-define': ['requirements'] }), 'discover-define');
  const withOptional = initiativePackState(
    initiativeWith(resolution, { 'discover-define': ['requirements', 'opportunity-brief'] }), 'discover-define');
  const briefBefore = base.find((pack) => pack.id === 'opportunity-investment-brief');
  const briefAfter = withOptional.find((pack) => pack.id === 'opportunity-investment-brief');
  assert.notEqual(briefBefore.sha256, briefAfter.sha256,
    'publishing an optional member must change the pack hash so an approval cannot silently carry over');
  // The same state hashes identically — the pack identity is stable.
  const repeat = initiativePackState(initiativeWith(resolution, { 'discover-define': ['requirements'] }), 'discover-define');
  assert.equal(repeat.find((pack) => pack.id === 'opportunity-investment-brief').sha256, briefBefore.sha256);
});

test('pack declarations are validated against the profile', () => {
  assert.throws(() => validatePortfolio(portfolioWith([
    { id: 'bad', members: ['elaboration/story-plan'], approval: { authorities: ['nobody'], minimum: 1 } }
  ])), /unknown approval authority 'nobody'/);

  assert.throws(() => validatePortfolio(portfolioWith([
    { id: 'bad', members: ['elaboration/does-not-exist'] }
  ])), /references unknown output 'elaboration\/does-not-exist'/);

  // A pack may not reference a phase the profile does not run.
  assert.throws(() => validatePortfolio(portfolioWith([
    { id: 'bad', members: ['epic-planning/story-plan'] }
  ])), /references inactive phase 'epic-planning'/);

  assert.throws(() => validatePortfolio(portfolioWith([{ id: 'bad', members: [] }])),
    /must list at least one member output/);

  assert.throws(() => validatePortfolio(portfolioWith([{ id: 'bad', members: ['story-plan'] }])),
    /must be written as '<phase>\/<output>'/);

  assert.throws(() => validatePortfolio(portfolioWith([
    { id: 'dup', members: ['elaboration/story-plan'] },
    { id: 'dup', members: ['elaboration/adr-log'] }
  ])), /pack IDs/);
});
