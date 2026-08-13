/**
 * Typed artifact sets and the advisory task map. `[SPK:AC-006]`
 *
 * The set shipped in `workflow.yml` from P1 onward with no reader at all — declared, validated by
 * nothing, consumed by nothing, and indistinguishable from a working feature. So what is asserted
 * here is mostly *consumption*: that a published phase is catalogued, that an approval binds the
 * whole bundle, and that a reopen scoped to one member notices when another one moves.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ARTIFACT_SET_SCHEMA_VERSION, artifactSetDiff, catalogArtifactSet, disclosureLines, memberRoot,
  normalizeArtifactSet, resolvedArtifactSet
} from '../src/artifact-sets.mjs';
import {
  advisoryTaskPath, deriveAdvisoryTasks, planSurfaces, renderAdvisoryTasks
} from '../src/advisory-tasks.mjs';
import {
  CANDIDATE_CONCERNS, assistedPrompt, assistedRecordRelative, buildAssistedRecord,
  parseAssistedCandidates, unknownCitations, unwrapProviderLineBreaks
} from '../src/assisted-quality.mjs';
import { withinGenerationWriteScope } from '../src/artifact-sidecar.mjs';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { loadConfig } from '../src/state.mjs';

const SET = {
  primary: 'plan.md',
  members: [
    { path: 'plan.md', role: 'implementation-plan', required: true },
    { path: 'tasks.md', role: 'advisory-task-map', required: false, authority: 'advisory' }
  ]
};

const PHASE = { id: 'planning', requiredArtifact: { path: 'artifacts/planning/plan.md' } };

async function fixture(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `sflow-sets-${name}-`));
  await mkdir(path.join(root, 'work/artifacts/planning'), { recursive: true });
  return root;
}

test('a set refuses to be declared in a way that cannot be honoured', () => {
  const bad = (value, pattern) => assert.throws(() => normalizeArtifactSet(value, 'demo'), pattern);
  bad({ members: SET.members }, /must name its primary member/);
  bad({ primary: 'plan.md', members: [] }, /at least one member/);
  bad({ primary: 'missing.md', members: SET.members }, /is not among its members/);
  bad({ primary: 'plan.md', members: [{ path: 'plan.md' }] }, /needs a role/);
  bad({ primary: 'plan.md', members: [{ path: '../escape.md', role: 'x' }] }, /must stay inside the phase artifact directory/);
  bad({ primary: 'plan.md', members: [...SET.members, { path: 'plan.md', role: 'again' }] }, /twice/);
  // `[SPK:CON-046]`: an advisory member is never evidence, so it cannot be required into being one.
  bad({ primary: 'plan.md', members: [{ path: 'plan.md', role: 'x', required: true, authority: 'advisory' }] }, /advisory, so it cannot be required/);

  const set = normalizeArtifactSet(SET, 'spec-driven-planning');
  assert.equal(set.id, 'spec-driven-planning');
  assert.equal(set.members[0].authority, 'governed', 'a member without an authority is governed by default');
});

test('every member is hashed, and the bundle is one value over all of them', async () => {
  // `[SPK:REQ-110]` and `[SPK:CON-045]`.
  const root = await fixture('catalog');
  await writeFile(path.join(root, 'work/artifacts/planning/plan.md'), '# Plan\n');
  const set = normalizeArtifactSet(SET, 'demo');

  const partial = await catalogArtifactSet(root, 'work', PHASE, set);
  assert.equal(partial.members.length, 2);
  assert.equal(partial.members.find((member) => member.member === 'plan.md').exists, true);
  assert.equal(partial.members.find((member) => member.member === 'tasks.md').exists, false);
  assert.deepEqual(partial.missingRequired, [], 'tasks.md is optional and must not be reported missing');

  await writeFile(path.join(root, 'work/artifacts/planning/tasks.md'), '# Tasks\n');
  const full = await catalogArtifactSet(root, 'work', PHASE, set);
  assert.notEqual(full.bundleSha256, partial.bundleSha256, 'adding a member did not change the bundle');

  // The identity is over content, not over how the members happened to be listed.
  const reordered = await catalogArtifactSet(root, 'work', PHASE, normalizeArtifactSet({
    primary: 'plan.md', members: [SET.members[1], SET.members[0]]
  }, 'demo'));
  assert.equal(reordered.bundleSha256, full.bundleSha256);

  // And editing any member changes it, which is what makes an approval un-reusable.
  await writeFile(path.join(root, 'work/artifacts/planning/tasks.md'), '# Tasks\n\n- [x] done\n');
  assert.notEqual((await catalogArtifactSet(root, 'work', PHASE, set)).bundleSha256, full.bundleSha256);
});

test('the catalogue is versioned, reads an unversioned one, and refuses a newer one', async () => {
  /**
   * `[SPK:REQ-124]` asks for versioned schemas on the new records, and this one shipped without.
   * It is the record most exposed to the omission: it is persisted on the phase and read back a
   * generation later by `artifactSetDiff`, so a future change to the member shape would have been
   * compared field-for-field against the old shape and produced a confident wrong answer.
   */
  const root = await fixture('versioned');
  await writeFile(path.join(root, 'work/artifacts/planning/plan.md'), '# Plan\n');
  await writeFile(path.join(root, 'work/artifacts/planning/tasks.md'), '# Tasks\n');
  const set = normalizeArtifactSet(SET, 'demo');
  const catalog = await catalogArtifactSet(root, 'work', PHASE, set);
  assert.equal(catalog.schemaVersion, ARTIFACT_SET_SCHEMA_VERSION);
  assert.equal(catalog.resultType, 'artifact-set-catalog');

  // Adding the stamp must not move the bundle: it is what an existing approval is bound to, and a
  // changed identity would invalidate every approval already recorded `[SPK:CON-053]`.
  const { bundleSha256 } = catalog;
  await writeFile(path.join(root, 'work/artifacts/planning/tasks.md'), '# Tasks\n');
  assert.equal((await catalogArtifactSet(root, 'work', PHASE, set)).bundleSha256, bundleSha256);

  // A Story catalogued before the stamp existed keeps working, unversioned, and still diffs.
  const { schemaVersion, ...unversioned } = catalog;
  await writeFile(path.join(root, 'work/artifacts/planning/plan.md'), '# Plan\n\nmore\n');
  const current = await catalogArtifactSet(root, 'work', PHASE, set);
  assert.deepEqual(artifactSetDiff(unversioned, current).changed.map((member) => member.member), ['plan.md']);

  // A catalogue from a newer release is refused rather than mis-compared.
  assert.throws(() => artifactSetDiff({ ...catalog, schemaVersion: ARTIFACT_SET_SCHEMA_VERSION + 1 }, current),
    /catalogued by a newer release/);
});

test('a required member that is absent is reported', async () => {
  const root = await fixture('missing');
  const catalog = await catalogArtifactSet(root, 'work', PHASE, normalizeArtifactSet(SET, 'demo'));
  assert.deepEqual(catalog.missingRequired, ['work/artifacts/planning/plan.md']);
});

test('a directory member is the collection, not the directory entry', async () => {
  // `verification/` is a member of the shipped verification set, and a body of evidence is only the
  // same body if the same files are in it.
  const root = await fixture('directory');
  const set = normalizeArtifactSet({
    primary: 'plan.md',
    members: [{ path: 'plan.md', role: 'plan', required: true }, { path: 'evidence/', role: 'evidence', required: true }]
  }, 'demo');
  await writeFile(path.join(root, 'work/artifacts/planning/plan.md'), '# Plan\n');
  await mkdir(path.join(root, 'work/artifacts/planning/evidence/runs'), { recursive: true });
  await writeFile(path.join(root, 'work/artifacts/planning/evidence/runs/one.txt'), 'pass\n');

  const before = await catalogArtifactSet(root, 'work', PHASE, set);
  const evidence = before.members.find((member) => member.member === 'evidence/');
  assert.equal(evidence.directory, true);
  assert.equal(evidence.files, 1);

  await writeFile(path.join(root, 'work/artifacts/planning/evidence/runs/two.txt'), 'pass\n');
  const after = await catalogArtifactSet(root, 'work', PHASE, set);
  assert.notEqual(after.bundleSha256, before.bundleSha256, 'adding evidence left the bundle unchanged');
  assert.equal(after.members.find((member) => member.member === 'evidence/').files, 2);
});

test('a reopen scoped to one member discloses everything else that moved', async () => {
  // `[SPK:REQ-111]`. Disclosed, not refused: a regeneration that reflowed a neighbour is usually
  // harmless, and refusing it would push people into rewriting the whole bundle.
  const root = await fixture('reopen');
  const set = normalizeArtifactSet(SET, 'demo');
  await writeFile(path.join(root, 'work/artifacts/planning/plan.md'), '# Plan\n');
  await writeFile(path.join(root, 'work/artifacts/planning/tasks.md'), '# Tasks\n');
  const before = await catalogArtifactSet(root, 'work', PHASE, set);

  await writeFile(path.join(root, 'work/artifacts/planning/plan.md'), '# Plan\n\nRevised.\n');
  const honoured = artifactSetDiff(before, await catalogArtifactSet(root, 'work', PHASE, set), { declared: ['plan.md'] });
  assert.deepEqual(honoured.changed.map((member) => member.member), ['plan.md']);
  assert.deepEqual(honoured.preserved.map((member) => member.member), ['tasks.md']);
  assert.deepEqual(honoured.incidental, [], 'the declared member was reported as incidental');
  assert.deepEqual(disclosureLines(honoured), []);

  await writeFile(path.join(root, 'work/artifacts/planning/tasks.md'), '# Tasks\n\n- [x] done\n');
  const strayed = artifactSetDiff(before, await catalogArtifactSet(root, 'work', PHASE, set), { declared: ['plan.md'] });
  assert.deepEqual(strayed.incidental.map((member) => member.member), ['tasks.md']);
  assert.match(disclosureLines(strayed)[0], /tasks\.md changed although the reopen did not ask for it/);

  // With nothing declared, nothing is incidental — an ordinary regeneration is not a broken promise.
  assert.deepEqual(artifactSetDiff(before, await catalogArtifactSet(root, 'work', PHASE, set)).incidental, []);
});

test('the resolution is normalized however it reached us', async () => {
  /**
   * The bug this pins, found by reading a real catalogue: `resolvedArtifactSet` short-circuited on
   * `set.members ? set : normalize(...)`, and raw YAML has members too. A Story whose resolution
   * predates artifact sets fell back to the raw definition and got a set with no `id` and no
   * defaulted authority — so the record said `setId: undefined` and lost the governed/advisory
   * distinction, without failing anything.
   */
  const raw = { phases: [{ id: 'planning', artifactSet: 'demo' }] };
  const set = resolvedArtifactSet({ artifactSets: { demo: SET } }, { resolution: raw }, PHASE);
  assert.equal(set.id, 'demo');
  assert.equal(set.members[0].authority, 'governed');
  assert.throws(
    () => resolvedArtifactSet({ artifactSets: {} }, { resolution: raw }, PHASE),
    /declares unknown artifact set 'demo'/
  );
  assert.equal(resolvedArtifactSet({}, { resolution: { phases: [] } }, { id: 'planning' }), null);
  assert.equal(memberRoot(PHASE), 'artifacts/planning');
});

test('the shipped profile declares sets its phases can actually satisfy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sets-shipped-'));
  spawnSync('git', ['init', '-b', 'main'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  await initializeDefinition(root);
  const config = await loadConfig(root);
  const resolved = resolveWorkType(config, 'spec-driven-standard');

  for (const phase of resolved.phases.filter((entry) => entry.artifactSet)) {
    const set = resolvedArtifactSet(config, { resolution: resolved }, phase);
    // Config load already refuses a mismatch; asserting it here says why it matters — the primary
    // is the phase's required artifact, so a set naming a different one would catalogue a bundle
    // whose main document nobody was asked to write.
    assert.equal(set.primary, path.posix.basename(phase.artifact.path), `${phase.id} primary disagrees with its artifact`);
    assert.ok(set.members.every((member) => member.authority !== 'advisory' || !member.required));
  }
  assert.ok(resolved.artifactSets['spec-driven-planning'], 'the resolution does not pin the sets');
});

test('the task map is derived from approved generations and records their hashes', () => {
  // `[SPK:REQ-112]`.
  const specification = {
    path: 'work/artifacts/specification/spec.md',
    generation: 3,
    sha256: 'a'.repeat(64),
    markdown: [
      '## Requirements', '',
      '- The system creates a new attempt on retry. [D:REQ-001]',
      '- The system preserves the original failed attempt. [D:REQ-002]'
    ].join('\n')
  };
  const planning = {
    path: 'work/artifacts/planning/plan.md',
    generation: 2,
    sha256: 'b'.repeat(64),
    markdown: [
      '| Surface | Change | Serves |', '|---|---|---|',
      '| `src/retry.ts` | new handler | D:REQ-001 |',
      '| `src/attempts.ts` | append only | REQ-002 |'
    ].join('\n')
  };

  const map = deriveAdvisoryTasks({ workId: 'D-1', specification, planning });
  assert.equal(map.authority, 'advisory');
  assert.equal(map.derivedFrom.specification.generation, 3);
  assert.equal(map.derivedFrom.planning.sha256, 'b'.repeat(64));

  /**
   * The item text comes from the anchor's own line, not from `clause.body`.
   *
   * The extractor defines a body as everything *after* the anchor, so with trailing anchors — the
   * style used above and throughout the starter template — every item described the *next*
   * requirement and the last described nothing. A list that is confidently wrong is worse than no
   * list, because it reads as agreement.
   */
  assert.deepEqual(map.items.map((item) => item.summary), [
    'The system creates a new attempt on retry.',
    'The system preserves the original failed attempt.'
  ]);
  // `[SPK:REQ-113]`: expected paths come from the plan, matched with or without the namespace.
  assert.deepEqual(map.items[0].expectedPaths, ['src/retry.ts']);
  assert.deepEqual(map.items[1].expectedPaths, ['src/attempts.ts']);

  const rendered = renderAdvisoryTasks(map);
  assert.match(rendered, /- \[ \] \*\*D:REQ-001\*\* — The system creates a new attempt on retry\./);
  // `[SPK:CON-046]`, said in the document, because the reader most at risk is looking at a fully
  // ticked list at the end of a long week.
  assert.match(rendered, /not evidence/);
  assert.match(rendered, /Ticking every box proves nothing/);
  // Byte-identical for identical inputs, so regenerating an unchanged map is a no-op diff.
  assert.equal(renderAdvisoryTasks(deriveAdvisoryTasks({ workId: 'D-1', specification, planning })), rendered);

  // Without an approved plan the items survive; they simply carry no expected paths.
  const early = deriveAdvisoryTasks({ workId: 'D-1', specification, planning: null });
  assert.equal(early.items.length, 2);
  assert.deepEqual(early.items[0].expectedPaths, []);
  assert.match(renderAdvisoryTasks(early), /Plan: none approved yet, so no expected paths are listed\./);
});

test('the plan surface table is read, and non-table prose is not', () => {
  const surfaces = planSurfaces([
    'Prose mentioning D:REQ-009 should not become a surface.',
    '| Surface | Change | Serves |',
    '|---|---|---|',
    '| `src/a.ts` | edit | D:REQ-001, D:REQ-002 |',
    '| | | |'
  ].join('\n'));
  assert.deepEqual([...surfaces.keys()], ['D:REQ-001', 'D:REQ-002']);
  assert.deepEqual(surfaces.get('D:REQ-001').paths, ['src/a.ts']);
});

test('the task map lands on the advisory member of the planning set', () => {
  assert.equal(
    advisoryTaskPath('singularity/work-items/D-1', PHASE),
    'singularity/work-items/D-1/artifacts/planning/tasks.md'
  );
});

test('publication catalogues the set and approval binds the bundle', async () => {
  // A source-level check that the consumers exist, because the whole defect this feature corrects
  // was a declaration with no consumer.
  const state = await readFile(new URL('../src/state.mjs', import.meta.url), 'utf8');
  assert.match(state, /catalogArtifactSet\(/, 'publication does not catalogue the set');
  assert.match(state, /bundleSha256: phase\.artifactSet\.bundleSha256/, 'no decision binds the bundle [SPK:CON-045]');
  const publish = state.slice(state.indexOf('export async function publishGeneration'), state.indexOf('export async function reconcilePhaseTelemetry'));
  assert.ok(publish.includes('catalogArtifactSet('), 'the catalogue is built outside publishGeneration');
  assert.ok(
    publish.indexOf('await scanArtifacts(') < publish.indexOf('catalogArtifactSet('),
    'the set is catalogued before the artifacts are scanned, so it describes a stale bundle'
  );
});

/**
 * Assisted specification-quality candidates. `[SPK:REQ-057]` `[SPK:REQ-058]` `[SPK:CON-029]`
 *
 * The property worth defending is separation. A model is genuinely good at spotting an undefined
 * term; it must never be able to make that observation *look like* a deterministic finding, and it
 * must never touch one.
 */
test('an assisted record references the deterministic report and cannot alter it', () => {
  const report = {
    binding: {
      artifactPath: 'work/artifacts/specification/spec.md', artifactSha256: 'a'.repeat(64),
      phase: 'specification', generation: 2, policySha256: 'b'.repeat(64), checklist: 'requirements-quality-v1'
    },
    findings: [{ kind: 'missing-required-section', message: "the specification has no 'Actors' section" }],
    clauseIds: ['D:REQ-001']
  };
  const record = buildAssistedRecord({
    report,
    invocation: { provider: 'copilot-cli', model: 'gpt-5', invocationId: 'inv-1', operationId: 'spec.analyze', usage: { status: 'exact', totalTokens: 900 } },
    candidates: parseAssistedCandidates('{"candidates":[{"concern":"undefined-term","clauseIds":["D:REQ-001"],"text":"\\"attempt\\" is never defined."}]}'),
    prompt: 'prompt bytes',
    workId: 'D-1',
    generatedAt: '2026-01-01T00:00:00.000Z'
  });

  // `[SPK:REQ-058]`: model, provider, prompt hash, input hashes, candidate text, clause IDs, usage, time.
  assert.equal(record.model.provider, 'copilot-cli');
  assert.equal(record.model.model, 'gpt-5');
  assert.match(record.promptSha256, /^[0-9a-f]{64}$/);
  assert.equal(record.deterministicReport.artifactSha256, report.binding.artifactSha256);
  assert.equal(record.deterministicReport.policySha256, report.binding.policySha256);
  assert.equal(record.usage.totalTokens, 900);
  assert.equal(record.generatedAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(record.candidates[0].clauseIds, ['D:REQ-001']);

  // `[SPK:CON-029]`: the findings are referenced by count and hash, never carried, so there is
  // nothing here for an assisted pass to edit, drop, or re-rank.
  assert.equal(record.deterministicReport.findingCount, 1);
  assert.equal('findings' in record, false, 'the assisted record carries a copy of the deterministic findings');
  assert.match(record.disclaimer, /not deterministic findings/);
  assert.throws(() => buildAssistedRecord({ report, invocation: {}, candidates: [] }), /missing/);
});

test('an unparseable or out-of-contract reply is refused, not stored', () => {
  // A record that keeps "roughly what the model said" is worse than none: it reads as evidence.
  assert.throws(() => parseAssistedCandidates('I think the spec looks fine!'), /did not return the requested JSON/);
  assert.throws(() => parseAssistedCandidates('{"candidates":"none"}'), /no candidate list/);
  assert.throws(() => parseAssistedCandidates('{"candidates":[{"concern":"looks-bad","text":"x"}]}'), /expected one of/);
  assert.throws(() => parseAssistedCandidates('{"candidates":[{"concern":"undefined-term","text":"  "}]}'), /no text/);
  assert.throws(
    () => parseAssistedCandidates(JSON.stringify({ candidates: [{ concern: 'undefined-term', text: 'x'.repeat(501) }] })),
    /the limit is 500/
  );

  // A fenced reply is the common real shape, and an empty list is a valid answer.
  const fenced = parseAssistedCandidates('Here you go:\n```json\n{"candidates":[]}\n```\n');
  assert.deepEqual(fenced, []);
});

test('a cited clause that does not exist is flagged rather than deleted', () => {
  // Usually the model invented it. Occasionally the reviewer is on the wrong generation. Dropping
  // the citation would hide both; the danger to avoid is a reviewer believing it is real.
  const candidates = parseAssistedCandidates(JSON.stringify({
    candidates: [{ concern: 'ambiguous-wording', clauseIds: ['D:REQ-001', 'D:REQ-009'], text: 'Ambiguous.' }]
  }));
  assert.deepEqual(unknownCitations(candidates, ['D:REQ-001']), ['D:REQ-009']);
  assert.deepEqual(unknownCitations(candidates, ['D:REQ-001', 'd:req-009']), []);
});

test('the assisted prompt tells the model what not to do', () => {
  const prompt = assistedPrompt({
    report: { findings: [{ kind: 'unresolved-clarification', message: 'unresolved clarification marker at line 3: who?' }] },
    markdown: '# Spec\n',
    namespace: 'D'
  });
  // The deterministic findings go in so the model does not spend its turn restating them, and the
  // instruction not to touch them is explicit `[SPK:CON-029]`.
  assert.match(prompt, /unresolved clarification marker at line 3/);
  assert.match(prompt, /Do NOT restate, contradict, re-rank or comment on the deterministic findings/);
  assert.match(prompt, /Do NOT judge the specification as a whole/);
  assert.match(prompt, /`D:` namespace/);
  for (const concern of CANDIDATE_CONCERNS) assert.ok(prompt.includes(concern), `the prompt never names '${concern}'`);
});

test('the assisted pass runs with no tools and lands outside the write scope', async () => {
  const cli = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  const runner = cli.slice(cli.indexOf('async function runAssistedAnalysis'), cli.indexOf('async function specCommand'));
  // A model that can also run commands is doing something other than reading one document, and
  // `[SPK:CON-029]` would have nothing to stand on.
  assert.match(runner, /tools: \{ mode: 'none' \}/, 'assisted analysis grants the model tools');
  assert.match(runner, /channel: 'specification-quality-assisted'/);
  // `context/` is outside the artifact-only generation write scope, like every other kernel record.
  assert.equal(assistedRecordRelative('work', 'specification', 2), 'work/context/spec-quality/specification-gen2-assisted.json');
  assert.equal(withinGenerationWriteScope('work', 'specification', assistedRecordRelative('work', 'specification', 2)), false);
});

test('a wrapped reply is reconstructed, and the two kinds of break are told apart', () => {
  /**
   * The provider hard-wraps at 100 columns and ignores `COLUMNS`, so a correct JSON reply arrives
   * unparseable. Both break kinds appeared in real runs and each has a wrong answer that looks
   * plausible: welding `to` and `retry` into `toretry`, or inserting a space into `DRIVE:REQ-0 03`
   * and citing a clause that does not exist.
   */
  const pad = (text) => text + 'x'.repeat(100 - text.length);

  // A break inside a long unbroken token — no space existed, so none is restored.
  const split = unwrapProviderLineBreaks(`${'a'.repeat(100)}\nbcd`, { width: 100 });
  assert.equal(split, `${'a'.repeat(100)}bcd`);

  // A full-width line whose break fell between two short words: the wrapper ate a space, because it
  // would have moved a token this short down whole rather than splitting it.
  const words = unwrapProviderLineBreaks(`${pad('return the payment ')}\nretry.`, { width: 100 });
  assert.ok(words.endsWith('x retry.'), `a consumed space was not restored: ${JSON.stringify(words.slice(-20))}`);

  // A short line whose next word would still have fit was ended on purpose, so its newline stays.
  assert.equal(unwrapProviderLineBreaks('short\nline', { width: 100 }), 'short\nline');

  /**
   * End to end on the shape the provider really produces: a greedy wrap where every line lands in
   * the low-to-high nineties, one break inside an unbroken run of JSON and one at a space.
   */
  const reply = [
    '{"candidates":[{"concern":"undefined-term","clauseIds":["D:REQ-001","D:REQ-002","D:REQ-003","D:REQ-0',
    '04"],"text":"The term attempt is never defined here, so two engineers could implement the retry',
    'count differently."}]}'
  ].join('\n');
  assert.equal(reply.split('\n')[0].length, 100, 'the fixture must wrap where the provider wraps');
  assert.ok(reply.split('\n')[1].length > 90, 'the fixture must wrap where the provider wraps');
  const candidates = parseAssistedCandidates(reply);
  assert.deepEqual(candidates[0].clauseIds, ['D:REQ-001', 'D:REQ-002', 'D:REQ-003', 'D:REQ-004'], 'a clause ID was corrupted by the rejoin');
  assert.match(candidates[0].text, /implement the retry count differently/);

  // Well-formed output never reaches the reconstruction at all.
  assert.deepEqual(parseAssistedCandidates('{"candidates":[{"concern":"undefined-term","text":"a\\nb"}]}')[0].text, 'a b');
});
