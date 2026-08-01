/**
 * The PDLC artifact templates: that they exist, that they render, and that they say something.
 *
 * The failure this guards against is the one that made them worth writing. Thirty-one of the
 * enterprise-delivery outputs pointed at the same four-heading stub, so a phase produced a stack of
 * identical documents titled differently — which passes every structural check the engine has, and
 * tells an author nothing about what the artifact is for.
 *
 * Driving all seven phases against a real repository takes an approval chain per phase, so that is
 * covered once by the end-to-end walk. This covers all forty-one outputs cheaply, by rendering each
 * template through the same substitution `prepareInitiativePhase` performs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(packageRoot, 'templates/artifacts');

const portfolio = YAML.parse(await readFile(path.join(packageRoot, 'templates/portfolio.yml'), 'utf8'));

/** Every output of every phase a profile runs, with the phase it belongs to. */
function outputsOf(profileId) {
  const profile = portfolio.initiativeProfiles[profileId];
  return profile.phases.flatMap((phaseId) =>
    (portfolio.initiativePhases[phaseId].outputs ?? []).map((output) => ({ phaseId, ...output })))
    // An output with a `generator` is produced by the engine from state it already holds — the
    // source catalog is the pinned sources, listed. It has no template because it is not authored.
    .filter((output) => !output.generator);
}

const enterprise = outputsOf('enterprise-delivery');

/** The substitution prepareInitiativePhase applies, with the same token set. */
function render(text) {
  const replacements = {
    '{{initiative.id}}': 'SF-1', '{{workId}}': 'SF-1', '{{initiative.title}}': 'A title',
    '{{phase.id}}': 'elaboration', '{{phase.label}}': 'Elaboration',
    '{{output.id}}': 'an-output', '{{output.label}}': 'An output',
    '{{inputs}}': '- SRC-1 brief.pdf', '{{metadata}}': '{ "schemaVersion": 1 }'
  };
  let rendered = text;
  for (const [token, value] of Object.entries(replacements)) rendered = rendered.replaceAll(token, value);
  return rendered;
}

test('the enterprise delivery profile has real templates, not the generic stub', async () => {
  // The stub still exists and is still the right default for a profile nobody has written templates
  // for. What it must not be is the answer for the profile that models the whole lifecycle.
  const generic = enterprise.filter((output) => output.template.includes('generic-output'));
  assert.deepEqual(generic.map((output) => `${output.phaseId}/${output.id}`), [],
    'these outputs would produce a four-heading stub with a different title');
  assert.ok(enterprise.length >= 40, `only ${enterprise.length} outputs found; the profile may have moved`);
});

test('every declared template exists, for every profile', async () => {
  // A template path that resolves to nothing fails at the moment somebody runs the phase, which is
  // the worst moment to find out.
  const missing = [];
  for (const profileId of Object.keys(portfolio.initiativeProfiles)) {
    for (const output of outputsOf(profileId)) {
      try { await readFile(path.join(artifactRoot, output.template), 'utf8'); }
      catch { missing.push(`${profileId}:${output.phaseId}/${output.id} → ${output.template}`); }
    }
  }
  assert.deepEqual(missing, []);
});

test('every template renders with nothing left unsubstituted', async () => {
  // A token the engine does not replace ships to the author as literal braces, and to the gate as a
  // placeholder that fails validation for a reason that names the wrong thing.
  const unresolved = [];
  for (const output of enterprise) {
    const rendered = render(await readFile(path.join(artifactRoot, output.template), 'utf8'));
    const left = rendered.match(/\{\{[^}]+\}\}/g);
    if (left) unresolved.push(`${output.phaseId}/${output.id}: ${[...new Set(left)].join(', ')}`);
  }
  assert.deepEqual(unresolved, []);
});

test('every artifact carries the metadata header the engine writes provenance into', async () => {
  const missing = [];
  for (const output of enterprise) {
    const text = await readFile(path.join(artifactRoot, output.template), 'utf8');
    const marker = output.template.endsWith('.yml')
      ? 'initiativeId:'
      : '<!-- singularity-flow:initiative-metadata';
    if (!text.includes(marker)) missing.push(`${output.phaseId}/${output.id}`);
  }
  assert.deepEqual(missing, [], 'without the header an artifact has no recorded provenance');
});

test('every markdown template is a document with structure, not a stub', async () => {
  // The threshold is deliberately low. It is not a quality bar — it is the line below which a
  // template is the old four-heading stub wearing a new name.
  const thin = [];
  for (const output of enterprise) {
    if (!output.template.endsWith('.md')) continue;
    const text = await readFile(path.join(artifactRoot, output.template), 'utf8');
    const headings = (text.match(/^## /gm) ?? []).length;
    if (text.length < 900 || headings < 4) {
      thin.push(`${output.phaseId}/${output.id} (${text.length}b, ${headings} sections)`);
    }
  }
  assert.deepEqual(thin, []);
});

test('every markdown template names the initiative and the output it is for', async () => {
  const wrong = [];
  for (const output of enterprise) {
    if (!output.template.endsWith('.md')) continue;
    const text = await readFile(path.join(artifactRoot, output.template), 'utf8');
    if (!/^# \{\{initiative\.id\}\} — \{\{output\.label\}\}$/m.test(text)) {
      wrong.push(`${output.phaseId}/${output.id}`);
    }
  }
  assert.deepEqual(wrong, [], 'the title has to identify which Epic and which artifact this is');
});

test('every markdown template gives pinned sources somewhere to land', async () => {
  // `{{inputs}}` is where the engine writes the sources an artifact is entitled to cite. A template
  // without it silently drops that list, and the author cites from memory instead.
  const missing = [];
  for (const output of enterprise) {
    if (!output.template.endsWith('.md')) continue;
    const text = await readFile(path.join(artifactRoot, output.template), 'utf8');
    if (!text.includes('{{inputs}}')) missing.push(`${output.phaseId}/${output.id}`);
  }
  assert.deepEqual(missing, []);
});

test('the story plan output uses the executable story-plan template', async () => {
  // Elaboration's story plan is materialized into Jira Stories and Git branches. It pointed at the
  // generic YAML stub, which has no stories key at all — so the phase produced a file the planner
  // could not read.
  const storyPlan = enterprise.find((output) => output.id === 'story-plan');
  assert.equal(storyPlan.template, 'initiatives/epic/story-plan.yml');
  const text = await readFile(path.join(artifactRoot, storyPlan.template), 'utf8');
  assert.match(text, /stories:/);
  assert.match(text, /dependsOn:/);
});
