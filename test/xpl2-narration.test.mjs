/**
 * XPL2 M2: optional structured narration and the deterministic reading tour.
 *
 * Model output here is always a fixture string or a local stand-in executable; no provider is
 * called. Every case checks the same boundary: what a reader sees is computed statement text for
 * admitted IDs, attention statements are always shown, and the computed view never changes.
 */
import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { explainXpl2Subject } from '../src/comprehension/xpl2/subjects.mjs';
import {
  buildXpl2NarrationPrompt, validateXpl2Narration, XPL2_COMMENTARY_BANNER, XPL2_CONNECTIVES,
  XPL2_NARRATION_BANNER, xpl2NarrationInput
} from '../src/comprehension/xpl2/narration.mjs';
import { narrateXpl2Explanation } from '../src/comprehension/xpl2/narration-command.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { listPromptAudits, setPromptAudit } from '../src/prompt-audit.mjs';
import { cliJson, comprehensionSlice, createXpl2Fixture, isolatedHome } from './helpers/xpl2-fixture.mjs';

const CANARY = 'PROSE-CANARY';

async function narrationFixture(t) {
  const fixture = await createXpl2Fixture(t);
  const model = explainXpl2Subject(fixture.input, { subject: 'change' });
  return { fixture, model, input: xpl2NarrationInput(model) };
}

const ids = (input) => input.statements.map((entry) => entry.id);

/** The invariant every narration must keep, whatever the model returned. */
function assertBoundary(narration, input, model) {
  const computed = new Map([...model.statements, ...model.derived].map((entry) => [entry.id, entry.text]));
  assert.equal(narration.banner, XPL2_NARRATION_BANNER);
  assert.equal(narration.authority, 'none');
  assert.equal(narration.stored, false);
  assert.equal(narration.explanationSha256, model.explanationSha256);
  for (const section of narration.sections) {
    assert.ok(Object.hasOwn(XPL2_CONNECTIVES, section.connective), section.connective);
    assert.ok(section.heading.startsWith(XPL2_CONNECTIVES[section.connective]));
    for (const statement of section.statements) {
      assert.equal(statement.text, computed.get(statement.id), 'shown text is the computed statement');
      assert.ok(!statement.text.includes(CANARY));
    }
  }
  const shown = new Set(narration.sections.flatMap((section) => section.statements.map((entry) => entry.id)));
  for (const id of input.mandatory) assert.ok(shown.has(id), `attention statement ${id} stays visible`);
  assert.ok(!JSON.stringify(narration.sections).includes(CANARY), 'model prose never reaches the sections');
  if (narration.commentary?.status === 'shown') {
    assert.equal(narration.commentary.semanticSupport, 'unverified');
    assert.equal(narration.commentary.banner, XPL2_COMMENTARY_BANNER);
  }
  assert.doesNotMatch(JSON.stringify(narration), /"semanticSupport":"supported"|"verdict":"supported"/u);
}

/**
 * At least fifty adversarial selection and prose cases [XPL2-AC-008]: negation, quantifiers,
 * false causality, wrong IDs, matching numbers, injected structure, markup, secrets and size.
 * `expect` is 'ok' (rendered), 'invalid' (whole output refused) or a check on the result.
 */
function adversarialCases(input) {
  const [first, second, third] = ids(input);
  const all = ids(input);
  const section = (statements, extra = {}) => ({ connective: 'changes', statements, ...extra });
  const out = (value) => JSON.stringify(value);
  const commentary = (text, citations = [first]) => out({ sections: [section([first])], commentary: { text, citations } });
  const withheld = (reason) => (result) => {
    assert.equal(result.commentary.status, 'withheld');
    assert.ok(result.commentary.reasons.includes(reason), `${reason} in ${result.commentary.reasons}`);
    assert.ok(!('text' in result.commentary));
  };
  const shownUnverified = (result) => {
    assert.equal(result.commentary.status, 'shown');
    assert.equal(result.commentary.citationSyntax, 'valid');
    assert.equal(result.commentary.semanticSupport, 'unverified');
  };
  return [
    ['prose beside valid IDs is discarded', out({ sections: [section([first], { text: `${CANARY} AC-001 is proven correct` })] }),
      (result) => assert.equal(result.discarded.prose, 1)],
    ['a summary field in a section is discarded', out({ sections: [section([first], { summary: `${CANARY} all good` })] }),
      (result) => assert.equal(result.discarded.prose, 1)],
    ['negation prose cannot flip a recorded result', out({ sections: [section([first], { note: `${CANARY} The test did not pass` })] }), 'ok'],
    ['a universal quantifier in prose is discarded', out({ sections: [section([first, second], { claim: `${CANARY} All clauses are satisfied` })] }), 'ok'],
    ['false causality in prose is discarded', out({ sections: [section([second], { why: `${CANARY} H-001 exists because of ORD:AC-002` })] }), 'ok'],
    ['matching numbers in prose prove nothing', out({ sections: [section([third], { count: `${CANARY} 3 of 3 tests passed` })] }), 'ok'],
    ['an unknown statement ID is dropped', out({ sections: [section([first, 'S-999'])] }),
      (result) => assert.equal(result.discarded.unknownIds, 1)],
    ['a lowercase ID is not an ID', out({ sections: [section(['s-001'])] }), (result) => assert.equal(result.discarded.unknownIds, 1)],
    ['a short ID is not an ID', out({ sections: [section(['S-1'])] }), (result) => assert.equal(result.discarded.unknownIds, 1)],
    ['a unit display ID is not a statement', out({ sections: [section(['H-001'])] }), (result) => assert.equal(result.discarded.unknownIds, 1)],
    ['a source ID is not a statement', out({ sections: [section(['SRC-DIFF'])] }), (result) => assert.equal(result.discarded.unknownIds, 1)],
    ['a clause ID is not a statement', out({ sections: [section(['ORD:AC-001'])] }), (result) => assert.equal(result.discarded.unknownIds, 1)],
    ['an ID with spaces is not an exact ID', out({ sections: [section([` ${first}`])] }), (result) => assert.equal(result.discarded.unknownIds, 1)],
    ['a number is not an ID', out({ sections: [section([1])] }), (result) => assert.equal(result.discarded.unknownIds, 1)],
    ['an object is not an ID', out({ sections: [section([{ id: first }])] }), (result) => assert.equal(result.discarded.unknownIds, 1)],
    ['a repeated ID is shown once', out({ sections: [section([first, first]), { connective: 'links', statements: [first] }] }),
      (result) => assert.equal(result.discarded.duplicates, 2)],
    ['an unknown connective is dropped', out({ sections: [{ connective: 'verdict', statements: [first] }] }),
      (result) => assert.equal(result.discarded.connectives, 1)],
    ['a proof connective is not in the catalog', out({ sections: [{ connective: 'proven', statements: [first] }] }),
      (result) => assert.equal(result.discarded.connectives, 1)],
    ['a connective carrying markup is dropped', out({ sections: [{ connective: 'start<script>', statements: [first] }] }),
      (result) => assert.equal(result.discarded.connectives, 1)],
    ['a numeric connective is an invalid section', out({ sections: [{ connective: 7, statements: [first] }] }),
      (result) => assert.equal(result.discarded.invalidSections, 1)],
    ['a section that is a string is invalid', out({ sections: [`${CANARY} everything passed`] }),
      (result) => assert.equal(result.discarded.invalidSections, 1)],
    ['null statements make an invalid section', out({ sections: [{ connective: 'changes', statements: null }] }),
      (result) => assert.equal(result.discarded.invalidSections, 1)],
    ['too many IDs in one section is invalid', out({ sections: [section(Array.from({ length: 41 }, () => first))] }),
      (result) => assert.equal(result.discarded.invalidSections, 1)],
    ['a __proto__ key is discarded as structure', `{"sections":[{"connective":"changes","statements":["${first}"],"__proto__":{"text":"${CANARY}"}}]}`,
      (result) => assert.equal(result.discarded.prose, 1)],
    ['a verdict at the top level refuses the whole narration', out({ sections: [section([first])], verdict: 'mergeable' }), 'invalid'],
    ['a top-level array is refused', out([section([first])]), 'invalid'],
    ['sections that are not a list are refused', out({ sections: section([first]) }), 'invalid'],
    ['thirteen sections are refused', out({ sections: Array.from({ length: 13 }, () => section([first])) }), 'invalid'],
    ['plain prose is refused', `${CANARY} This change is safe to merge.`, 'invalid'],
    ['an empty answer is refused', '', 'invalid'],
    ['an oversized answer is refused', out({ sections: [section([first], { text: 'x'.repeat(70 * 1024) })] }), 'invalid'],
    ['fenced JSON is accepted', `\`\`\`json\n${out({ sections: [section([first])] })}\n\`\`\``, 'ok'],
    ['no sections still shows every attention statement', out({ sections: [] }),
      (result) => assert.deepEqual(result.mandatory.appended, input.mandatory)],
    ['omitting the attention list cannot hide it', out({ sections: [section([first, second, third].filter((id) => !input.mandatory.includes(id)))] }),
      (result) => assert.ok(result.mandatory.appended.length > 0)],
    ['an attention statement chosen by the model is not repeated', out({ sections: [{ connective: 'attention', statements: [input.mandatory[0]] }] }),
      (result) => assert.ok(!result.mandatory.appended.includes(input.mandatory[0]))],
    ['choosing everything with brief length is cut at the word bound', out({ sections: [section(all.slice(0, 40))] }),
      (result) => { assert.ok(result.words <= 100); assert.ok(result.discarded.byLength > 0); }, { length: 'brief' }],
    ['reordered IDs are shown in the chosen order', out({ sections: [section([third, second, first])] }),
      (result) => assert.deepEqual(result.sections[0].statements.map((entry) => entry.id), [third, second, first])],
    ['commentary not requested is ignored', commentary(`${CANARY} unrequested`),
      (result) => { assert.equal(result.commentary, null); assert.equal(result.discarded.commentary, 1); }, { commentary: false }],
    ['plain commentary is shown unverified', commentary('These statements describe the changed export filter.'), shownUnverified],
    ['negated commentary is shown only as unverified', commentary('The recorded test did not pass.'), shownUnverified],
    ['an overclaiming quantifier is still only unverified', commentary('Every requirement here is proven correct.'), shownUnverified],
    ['commentary with an HTML image is withheld', commentary('<img src=x onerror=alert(1)>'), withheld('commentary-markup')],
    ['commentary with a Markdown link is withheld', commentary('see [the run](https://example.test/run)'), withheld('commentary-markup')],
    ['commentary with a code fence is withheld', commentary('```rm -rf```'), withheld('commentary-markup')],
    ['commentary with an HTML entity is withheld', commentary('a &lt;b&gt; c'), withheld('commentary-markup')],
    ['commentary with a javascript URI is withheld', commentary('open javascript:alert(1) now'), withheld('commentary-markup')],
    ['commentary with an ANSI escape is withheld', commentary(`${String.fromCharCode(27)}[31mred`), withheld('commentary-control-characters')],
    ['commentary with a bidirectional override is withheld', commentary(`abc${String.fromCharCode(0x202e)}def`), withheld('commentary-control-characters')],
    ['commentary with a cloud key is withheld', commentary(`key ${'AKIA'}${'ABCDEFGHIJKLMNOP'}`), withheld('commentary-secret-shaped')],
    ['commentary with a GitHub token is withheld', commentary(`token ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3'}`), withheld('commentary-secret-shaped')],
    ['commentary with a JWT is withheld', commentary(`jwt eyJ${'hbGciOiJIUzI1'}.eyJ${'zdWIiOiIxMjM0'}.${'SflKxwRJSMeKKF2QT4f'}`), withheld('commentary-secret-shaped')],
    ['commentary with a private key is withheld', commentary(`-----BEGIN ${'RSA PRIVATE'} KEY----- abc`), withheld('commentary-secret-shaped')],
    ['commentary with URL credentials is withheld', commentary('fetch https://user:pw@host.test/x'), withheld('commentary-secret-shaped')],
    ['oversized commentary is withheld', commentary(Array.from({ length: 300 }, () => 'word').join(' ')), withheld('commentary-oversized')],
    ['uncited commentary is withheld', commentary('A plain sentence.', []), withheld('commentary-uncited')],
    ['commentary citing an unknown statement is withheld', commentary('A plain sentence.', ['S-999']), withheld('commentary-unknown-citation')],
    ['commentary citing a source is withheld', commentary('A plain sentence.', ['SRC-DIFF']), withheld('commentary-unknown-citation')],
    ['commentary as a bare string is withheld', out({ sections: [section([first])], commentary: `${CANARY} prose` }), withheld('commentary-shape-invalid')],
    ['commentary with a verdict field is withheld', out({ sections: [section([first])], commentary: { text: 'x', citations: [first], verdict: 'supported' } }),
      withheld('commentary-shape-invalid')],
    ['commentary claiming support is never labelled supported', out({ sections: [section([first])], commentary: { text: 'Supported.', citations: [first] } }),
      (result) => assert.equal(result.commentary.semanticSupport, 'unverified')]
  ];
}

test('XPL2-AC-008 no lexical entailment shortcut: fifty-plus adversarial selections show only computed statements', async (t) => {
  const { model, input } = await narrationFixture(t);
  const cases = adversarialCases(input);
  assert.ok(cases.length >= 50, `${cases.length} adversarial cases`);
  for (const [name, output, expect, options = { commentary: true }] of cases) {
    if (expect === 'invalid') {
      assert.throws(() => validateXpl2Narration(output, input, options), (error) => error.code === 'XPL2_NARRATION_INVALID', name);
      continue;
    }
    const result = validateXpl2Narration(output, input, options);
    assertBoundary(result, input, model);
    if (typeof expect === 'function') expect(result);
  }
});

test('XPL2-AC-009 narration cannot mutate results: failures, reorders and overclaims leave the view unchanged', async (t) => {
  const { fixture, model, input } = await narrationFixture(t);
  const before = JSON.stringify(model);
  for (const output of [
    JSON.stringify({ sections: [{ connective: 'checks', statements: [...ids(input)].reverse().slice(0, 10), text: 'AC-003 is proven' }] }),
    'not json',
    JSON.stringify({ sections: [], verdict: 'approved' })
  ]) {
    try { validateXpl2Narration(output, input, { commentary: true }); } catch { /* unavailable narration */ }
  }
  assert.equal(JSON.stringify(model), before, 'the computed view is byte-identical after any narration');
  const again = explainXpl2Subject(fixture.input, { subject: 'change' });
  assert.equal(again.explanationSha256, model.explanationSha256);
  assert.equal(again.explanationSetSha256, model.explanationSetSha256);
  // The record-derived summary the explorer copies is built from the computed tour only.
  const { explorerSummary } = await import('../apps/vscode/src/views/change-explorer.ts');
  assert.doesNotMatch(explorerSummary(model), /AI-organized|commentary/iu);
  // Without the optional operation the narration is unavailable and nothing else differs.
  const fallback = await narrateXpl2Explanation(fixture.root, model, { operation: { id: 'explain.subject' } });
  assert.equal(fallback.status, 'unavailable');
  assert.equal(fallback.reason, 'model-disabled-fallback');
  assert.equal(fallback.explanationSha256, model.explanationSha256);
  assert.ok(!('sections' in fallback));
});

test('XPL2-AC-009 the CLI narration falls back to the identical computed view when models are off', async (t) => {
  const { fixture } = await narrationFixture(t);
  const home = await isolatedHome(t);
  const plain = cliJson(fixture.root, home, ['explain', '--subject', 'change', '--json']);
  const narrated = cliJson(fixture.root, home, ['explain', '--subject', 'change', '--narrate', '--length', 'brief', '--json']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(narrated.status, 0, narrated.stderr);
  assert.equal(narrated.json.operation.id, 'explain.subject');
  assert.equal(narrated.json.data.narration.status, 'unavailable');
  assert.equal(narrated.json.data.narration.reason, 'model-disabled-fallback');
  assert.deepEqual(narrated.json.data.explanation, plain.json.data.explanation);
  assert.ok(plain.json.next.some((entry) => entry.id === 'explanation.narrate' && entry.modelPolicy === 'optional'
    && /explain --subject change --narrate --json$/u.test(entry.command)));
  for (const [args, code] of [
    [['--length', 'brief'], 'XPL2_NARRATION_LENGTH_INVALID'],
    [['--commentary'], 'XPL2_NARRATION_OPTION_INVALID'],
    [['--narrate', '--length', 'endless'], 'XPL2_NARRATION_LENGTH_INVALID']
  ]) {
    const refused = cliJson(fixture.root, home, ['explain', '--subject', 'change', ...args, '--json']);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, new RegExp(code, 'u'));
  }
});

/** A local stand-in provider: it reads the attachment prompt and chooses three statements in reverse. */
const STAND_IN = [
  'const fs=require("node:fs"),a=process.argv.slice(1),f=a[a.indexOf("--attachment")+1],p=fs.readFileSync(f,"utf8");',
  'const j=JSON.parse(p.slice(p.indexOf("XPL2_NARRATION_INPUT_JSON\\n")+26));',
  'process.stdout.write(JSON.stringify({sections:[{connective:"start",statements:j.statements.slice(0,3).map(s=>s.id).reverse(),text:"PROSE-CANARY"}]}))'
].join('');

function standIn(root) {
  return {
    provider: 'copilot-cli',
    providerConfig: { executable: process.execPath, arguments: ['-e', STAND_IN, '--'], promptTransport: 'attachment' },
    model: null
  };
}

function narrate(root, model, options = {}) {
  return withOperationContext({
    operation: { id: 'explain.subject.narrate', modelPolicy: 'optional' }, modelMode: { enabled: true }, root, command: 'explain'
  }, () => narrateXpl2Explanation(root, model, { operation: { id: 'explain.subject.narrate' }, provider: standIn(root), ...options }));
}

test('XPL2-AC-010 opening and selecting call no model; explicit narration uses the runner and the existing capture setting', async (t) => {
  const { fixture, model } = await narrationFixture(t);
  const invocations = path.join(fixture.root, '.git', 'singularity-flow', 'model-invocations');
  // Opening the explorer (the leased slice) and asking subjects performs zero model calls.
  const slice = await comprehensionSlice(fixture.root);
  assert.ok(slice.explanationView, 'the slice built its change view');
  const home = await isolatedHome(t);
  for (const args of [['--subject', 'change'], ['--subject', 'line', '--path', 'src/export/service.ts', '--line', '5']]) {
    assert.equal(cliJson(fixture.root, home, ['explain', ...args, '--json']).status, 0);
  }
  await assert.rejects(access(invocations), 'no model invocation was recorded by reading');

  // Capture off (the default): the runner audits the invocation, and no prompt is captured.
  const narrated = await narrate(fixture.root, model);
  assert.equal(narrated.status, 'available');
  assert.equal(narrated.sections[0].connective, 'start');
  assert.equal(narrated.discarded.prose, 1, 'the stand-in prose was discarded');
  assert.ok(!JSON.stringify(narrated).includes(CANARY));
  const audits = await readdir(invocations);
  assert.equal(audits.length, 1);
  const { listModelInvocations } = await import('../src/model-runner.mjs');
  const [audit] = await listModelInvocations(fixture.root);
  assert.equal(audit.channel, 'xpl2-narration-advisory');
  assert.equal(audit.toolPolicy.mode, 'none', 'narration has no tools');
  assert.equal((await listPromptAudits(fixture.root)).records.length, 0, 'capture stays off');

  // Capture on, chosen by the person beforehand: the existing prompt log records it.
  await setPromptAudit(fixture.root, true);
  await narrate(fixture.root, model);
  const captured = await listPromptAudits(fixture.root, { includePrompt: true });
  assert.equal(captured.records.length, 1);
  // XPL2-AC-047: the prompt carries computed statements, never the patch or source bytes.
  assert.doesNotMatch(captured.records[0].prompt, /range\.start|formatInZone|@@ -/u);
});

test('XPL2-AC-046 unsafe commentary is withheld visibly and the computed view survives', async (t) => {
  const { model, input } = await narrationFixture(t);
  const before = model.explanationSha256;
  for (const [text, reason] of [
    [`${String.fromCharCode(27)}]8;;https://evil.test${String.fromCharCode(7)}x`, 'commentary-control-characters'],
    ['<b>bold</b>', 'commentary-markup'],
    [`ghp_${'Z'.repeat(36)}`, 'commentary-secret-shaped'],
    ['x '.repeat(4001), 'commentary-oversized']
  ]) {
    const result = validateXpl2Narration(JSON.stringify({ sections: [], commentary: { text, citations: [input.statements[0].id] } }), input, { commentary: true });
    assert.equal(result.commentary.status, 'withheld');
    assert.ok(result.commentary.reasons.includes(reason), reason);
    assert.equal(result.commentary.explanation.length, result.commentary.reasons.length, 'every omission says why');
    assert.ok(!('text' in result.commentary), 'withheld text is not carried');
    assert.ok(result.sections.length > 0, 'attention statements are still shown');
  }
  assert.equal(model.explanationSha256, before);
});

test('XPL2-AC-047 the model sees only the approved projection, bounded with a declared subset', async (t) => {
  const { model } = await narrationFixture(t);
  const input = xpl2NarrationInput(model, { maximumStatements: 6 });
  assert.equal(input.statements.length, 6);
  assert.equal(input.omittedStatements, model.statements.length + model.derived.length - 6);
  for (const id of input.mandatory) assert.ok(input.statements.some((entry) => entry.id === id), 'attention first');
  for (const entry of input.statements) {
    assert.deepEqual(Object.keys(entry).sort(), ['cites', 'id', 'kind', 'limitations', 'text']);
  }
  assert.deepEqual(Object.keys(input).sort(), [
    'attention', 'connectives', 'contract', 'counts', 'explanationSha256', 'inputSha256', 'mandatory',
    'omittedStatements', 'statements', 'subject'
  ]);
  const prompt = buildXpl2NarrationPrompt(input, { length: 'brief' });
  assert.match(prompt, /Do not add commentary\./u);
  assert.doesNotMatch(prompt, /"inputSha256"|"mandatory"|regionSha256|sourceReferences|patch/u);
  const narrated = validateXpl2Narration(JSON.stringify({ sections: [] }), input, { length: 'brief' });
  assert.equal(narrated.coverage.omittedFromInput, input.omittedStatements, 'the summary declares what it left out');
});

test('XPL2 13.1 the deterministic reading tour orders purpose, changes, links, checks, attention and one safe action', async (t) => {
  const { model } = await narrationFixture(t);
  const tour = model.presentation.tour;
  assert.deepEqual(tour.map((step) => step.step), ['purpose', 'changes', 'links', 'checks', 'attention', 'history', 'next']);
  const byId = new Map(model.statements.map((entry) => [entry.id, entry]));
  const kinds = (step) => tour.find((entry) => entry.step === step).statements.map((id) => byId.get(id).kind);
  assert.ok(kinds('purpose').every((kind) => kind.startsWith('clause-')));
  assert.ok(kinds('changes').includes('change-inventory'));
  assert.ok(kinds('links').includes('region-association'));
  assert.ok(kinds('checks').includes('test-result'));
  for (const entry of model.attention) assert.ok(tour.flatMap((step) => step.statements).includes(entry.statement));
  const placed = tour.flatMap((step) => step.statements);
  assert.equal(new Set(placed).size, placed.length, 'a statement appears in one step only');
  assert.equal(tour.at(-1).action.kind, 'inspect');
});

test('XPL2 13.1 the tour is presentation: every audience gets the same tour and the same hashes', async (t) => {
  const { fixture, model } = await narrationFixture(t);
  for (const audience of ['auditor', 'developer']) {
    const other = explainXpl2Subject(fixture.input, { subject: 'change', audience });
    assert.deepEqual(other.presentation.tour, model.presentation.tour);
    assert.equal(other.explanationSha256, model.explanationSha256);
  }
  const line = explainXpl2Subject(fixture.input, { subject: 'line', path: 'src/export/service.ts', line: 5 });
  const changes = line.presentation.tour.find((step) => step.step === 'changes').statements;
  assert.ok(changes.some((id) => id.startsWith('D-')), 'a line question tours its own derived statements');
});
