/**
 * One constitution. `[SPK:AC-008]` `[SPK:REQ-184]`
 *
 * Two properties carry this feature. An enforced article cannot say something the kernel does not do
 * — its prose is generated and a hand edit fails validation `[SPK:CON-041]`. And a Story is held to
 * the constitution that was in force when it started, not the one on the configuration branch today
 * `[SPK:CON-039]`. Everything else is bookkeeping in service of those two.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ARTICLE_LEVELS, ARTICLE_TYPES, CONSTITUTION_MODES, RENDERER_VERSION, articleHash,
  buildConstitutionException, citedArticleIds, constitutionIndex, constitutionPin,
  constitutionPolicy, expiredExceptions, generateConstitution, parseConstitution, policyValue,
  renderEnforcedArticle, requiredArticles, validateCitations
} from '../src/constitution.mjs';

const RESOLUTION = {
  phases: [
    { id: 'specification', approval: { minimum: 1, authorities: ['product-approvers'] } },
    { id: 'implementation', approval: { minimum: 2 } }
  ],
  spec: { mode: 'enforce' }
};

const SOURCE = [
  '---',
  'articles:',
  '  - id: ART-001',
  '    type: enforced',
  '    policy: phases.specification.approval.minimum',
  '  - id: ART-002',
  '    type: judged',
  '    level: must',
  '    evidenceRequired: true',
  '---',
  '',
  '# Constitution',
  '',
  '## [ART-001] A specification needs approvals',
  '',
  'Context a human wrote around the generated block.',
  '',
  '## [ART-002] Every change can be undone',
  '',
  'State how the change is reverted, who can do it, and how long it takes.',
  ''
].join('\n');

test('a policy path resolves the way an author would write it', () => {
  /**
   * The resolved work type holds phases as an array of `{ id, … }`, so index-only lookup returned
   * `undefined` for `phases.specification…` — and an enforced article with an undefined value
   * renders as "not set in the approved configuration", which reads like a deliberate statement
   * about policy rather than a typo in a path. That is the worst possible failure for this feature.
   */
  assert.equal(policyValue(RESOLUTION, 'phases.specification.approval.minimum'), 1);
  assert.equal(policyValue(RESOLUTION, 'phases.implementation.approval.minimum'), 2);
  assert.equal(policyValue(RESOLUTION, 'phases.0.approval.minimum'), 1, 'an index must still work');
  assert.equal(policyValue(RESOLUTION, 'spec.mode'), 'enforce');
  assert.equal(policyValue(RESOLUTION, 'phases.nope.approval'), undefined);
});

test('generation is byte-identical and leaves judged articles alone', async () => {
  // `[SPK:REQ-097]` `[SPK:REQ-098]`.
  const first = generateConstitution(SOURCE, RESOLUTION);
  const second = generateConstitution(SOURCE, RESOLUTION);
  assert.equal(first.markdown, second.markdown, 'the same configuration produced different bytes');
  assert.deepEqual(first.regenerated, ['ART-001']);
  assert.equal(generateConstitution(first.markdown, RESOLUTION).markdown, first.markdown, 'regeneration is not idempotent');

  // The judged article and the human prose around the enforced one come back untouched.
  assert.match(first.markdown, /State how the change is reverted, who can do it, and how long it takes\./);
  assert.match(first.markdown, /Context a human wrote around the generated block\./);
  assert.match(first.markdown, /- Effective value: 1/);

  // A policy change moves the enforced article and nothing else.
  const changed = generateConstitution(SOURCE, {
    ...RESOLUTION, phases: [{ id: 'specification', approval: { minimum: 2 } }, RESOLUTION.phases[1]]
  });
  assert.match(changed.markdown, /- Effective value: 2/);
  assert.match(changed.markdown, /State how the change is reverted/);
});

test('a hand-edited enforced article fails validation', () => {
  // `[SPK:CON-041]` `[SPK:REQ-184]`, the reason enforced articles are generated at all: a document
  // that says something other than what the kernel does is a lie the kernel signed.
  const generated = generateConstitution(SOURCE, RESOLUTION).markdown;
  assert.deepEqual(parseConstitution(generated, { resolution: RESOLUTION }).findings, []);

  const edited = generated.replace('- Effective value: 1', '- Effective value: 2 (two approvals required)');
  const findings = parseConstitution(edited, { resolution: RESOLUTION }).findings;
  assert.deepEqual(findings.map((finding) => finding.kind), ['hand-edited']);
  assert.match(findings[0].message, /Regenerate it instead of editing it/);

  // The subtler failure: the policy moved and the article stayed still, so an intact-looking
  // document describes rules that are no longer in force.
  const stale = parseConstitution(generated, {
    resolution: { ...RESOLUTION, phases: [{ id: 'specification', approval: { minimum: 5 } }] }
  }).findings;
  assert.ok(stale.some((finding) => finding.kind === 'stale-policy'), `expected a stale-policy finding, got ${JSON.stringify(stale)}`);

  // And a path that resolves to nothing is named rather than rendered as "not set".
  const broken = generateConstitution(SOURCE.replace('phases.specification.approval.minimum', 'phases.nope.minimum'), RESOLUTION).markdown;
  assert.ok(parseConstitution(broken, { resolution: RESOLUTION }).findings.some((finding) => finding.kind === 'unresolved-policy'));
});

test('judged prose is immutable after approval', () => {
  // `[SPK:REQ-096]`: replacement withdraws the old ID and allocates a new one, so "we changed our
  // mind" stays readable in the record instead of the old rule appearing never to have existed.
  const generated = generateConstitution(SOURCE, RESOLUTION).markdown;
  const edited = generated.replace('State how the change is reverted', 'State clearly how the change is reverted');
  const findings = parseConstitution(edited, { resolution: RESOLUTION }).findings;
  assert.deepEqual(findings.map((finding) => finding.kind), ['judged-prose-changed']);
  assert.match(findings[0].message, /Withdraw it and allocate a new ID/);
});

test('front matter and the visible body must agree', () => {
  // `[SPK:REQ-095]`: the front matter is not what anyone reads, so an article that exists only there
  // is a configuration entry wearing a document's name.
  const orphan = SOURCE.replace('## [ART-002] Every change can be undone\n\nState how the change is reverted, who can do it, and how long it takes.\n', '');
  assert.ok(parseConstitution(orphan).findings.some((finding) => finding.kind === 'missing-anchor'));

  const undeclared = `${SOURCE}\n## [ART-009] Never declared\n\nText.\n`;
  assert.ok(parseConstitution(undeclared).findings.some((finding) => finding.kind === 'undeclared-anchor'));

  assert.deepEqual([...ARTICLE_TYPES], ['enforced', 'judged']);
  assert.deepEqual([...ARTICLE_LEVELS], ['must', 'should']);
  assert.throws(() => parseConstitution('# No front matter\n'), /needs YAML front matter/);
  assert.throws(() => parseConstitution('---\narticles: []\n---\n'.replace('articles: []', 'articles: notalist')), /must declare an `articles` array/);
});

test('an article declared badly is refused rather than half-understood', () => {
  const bad = (yaml, pattern) => assert.throws(() => parseConstitution(`---\narticles:\n${yaml}\n---\n\n# C\n`), pattern);
  bad('  - id: nope\n    type: judged', /needs a stable ID/);
  bad('  - id: ART-001\n    type: guessed', /type must be enforced or judged/);
  bad('  - id: ART-001\n    type: enforced', /must reference one machine-policy path/);
  bad('  - id: ART-001\n    type: judged\n    evidenceRequired: true', /needs level must or should/);
  bad('  - id: ART-001\n    type: judged\n    level: must', /needs evidenceRequired/);
});

test('the index is derived and says so', () => {
  // `[SPK:CON-042]`: the approved constitution.md is the authority. An index that presented itself
  // as one more thing to approve would become the thing people edit instead of the document.
  const generated = generateConstitution(SOURCE, RESOLUTION).markdown;
  const { articles } = parseConstitution(generated, { resolution: RESOLUTION });
  const index = constitutionIndex({ articles, path: 'singularity/constitution.md', fileSha256: 'a'.repeat(64), resolution: RESOLUTION });
  assert.equal(index.derived, true);
  assert.match(index.authority, /authority; this index is a recomputable projection/);
  assert.deepEqual(index.articles.map((article) => article.id), ['ART-001', 'ART-002']);
  assert.equal(index.articles[0].policy, 'phases.specification.approval.minimum');
  assert.equal(index.articles[1].evidenceRequired, true);
  assert.match(index.indexSha256, /^[0-9a-f]{64}$/);
  assert.equal(index.rendererVersion, RENDERER_VERSION);
  // Recomputable: the same bytes and configuration give the same index.
  assert.equal(constitutionIndex({ articles, path: 'singularity/constitution.md', fileSha256: 'a'.repeat(64), resolution: RESOLUTION }).indexSha256, index.indexSha256);
});

test('a Story is held to the constitution it started under', () => {
  // `[SPK:REQ-091]` `[SPK:CON-039]`.
  const generated = generateConstitution(SOURCE, RESOLUTION).markdown;
  const { articles } = parseConstitution(generated, { resolution: RESOLUTION });
  const constitution = { path: 'singularity/constitution.md', fileSha256: 'a'.repeat(64), articles };
  const index = constitutionIndex({ ...constitution, resolution: RESOLUTION });
  const pin = constitutionPin({ constitution, index, configurationCommit: 'b'.repeat(40), resolution: RESOLUTION });

  for (const field of ['path', 'fileSha256', 'indexSha256', 'configurationCommit', 'policyResolutionSha256', 'articles']) {
    assert.ok(field in pin, `the pin omits ${field}`);
  }
  assert.deepEqual(pin.articles.map((article) => article.id), ['ART-001', 'ART-002']);

  // Citations are validated against the pin, so an article added after the Story started is not a
  // rule the author can be held to — they never read it.
  assert.deepEqual(validateCitations(pin, ['ART-002']).errors, []);
  assert.match(validateCitations(pin, ['ART-009'], { label: 'Phase specification' }).errors[0], /which the pinned constitution does not contain/);
  assert.match(validateCitations(null, ['ART-002']).errors[0], /pinned no constitution/);
  assert.deepEqual(validateCitations(null, []).errors, []);
  const withdrawn = { ...pin, articles: [{ id: 'ART-002', type: 'judged', status: 'withdrawn' }] };
  assert.match(validateCitations(withdrawn, ['ART-002']).warnings[0], /which was withdrawn/);

  // An evidence-required article is carried even when nobody cited it `[SPK:REQ-102]`, because that
  // is exactly the one most likely to be forgotten.
  assert.deepEqual(requiredArticles(pin, []), ['ART-002']);
  assert.deepEqual(requiredArticles(pin, ['ART-001']), ['ART-001', 'ART-002']);
});

test('a citation is what the artifact says it is bound by, not every mention', () => {
  /**
   * The end-of-section lookahead was `\Z`, which JavaScript reads as a literal `Z`. A Constitution
   * section at the end of a document — where the template puts it — matched nothing and cited
   * nothing, so the gate passed everything. The regex lived in two files and both were wrong.
   */
  const trailing = '# S\n\n## Requirements\n\n- x [D:REQ-001]\n\n## Constitution articles\n\n- ART-002\n- ART-003\n';
  assert.deepEqual(citedArticleIds(trailing), ['ART-002', 'ART-003']);
  assert.deepEqual(citedArticleIds(`${trailing}\n## Assumptions\n\nART-999 is only discussed here.\n`), ['ART-002', 'ART-003']);
  assert.deepEqual(citedArticleIds('# S\n\nART-004 mentioned in prose with no section.\n'), []);
  assert.deepEqual(citedArticleIds(''), []);
});

test('an exception records everything that makes it a decision', () => {
  // `[SPK:REQ-103]`. The only thing separating an exception from a rule quietly ignored is that all
  // of this was written down at the time.
  const base = {
    articleId: 'art-003', reason: 'Internal tool.', scope: 'D-1', actor: { login: 'reviewer' },
    authority: 'architecture-reviewers', at: '2026-01-01T00:00:00.000Z', workId: 'D-1', sourceCommit: 'c'.repeat(40)
  };
  const exception = buildConstitutionException({ ...base, expiresAt: '2026-06-30' });
  assert.equal(exception.articleId, 'ART-003', 'the article ID is not normalized');
  assert.deepEqual(exception.binding, { workId: 'D-1', sourceCommit: 'c'.repeat(40) });
  assert.match(exception.exceptionSha256, /^[0-9a-f]{64}$/);
  for (const field of ['articleId', 'reason', 'scope', 'actor', 'authority', 'at', 'workId', 'sourceCommit']) {
    assert.throws(() => buildConstitutionException({ ...base, [field]: '' }), new RegExp(`needs '${field}'`), `${field} was optional`);
  }
  // Expiry is decided against a time the caller supplies, so nothing here reads a clock.
  assert.deepEqual(expiredExceptions([exception], '2026-12-01').map((entry) => entry.articleId), ['ART-003']);
  assert.deepEqual(expiredExceptions([exception], '2026-02-01'), []);
  assert.throws(() => expiredExceptions([exception]), /observation time from the caller/);
});

test('the shipped examples cannot become policy by being copied', async () => {
  // `[SPK:REQ-099]`. The way this goes wrong is someone copying the example to see what happens and
  // forgetting; deleting one line is the right size of deliberate act for "these are now our rules".
  const example = await readFile(new URL('../examples/constitution/constitution.md', import.meta.url), 'utf8');
  const { articles } = parseConstitution(example, { allowExample: true });
  assert.equal(articles.filter((article) => article.type === 'enforced').length, 1);
  assert.equal(articles.filter((article) => article.type === 'judged').length, 2, 'the clause asks for one enforced and two judged');
  assert.throws(() => parseConstitution(example, { allowExample: false }), /still marked `example: true`/);
});

test('the policy is validated, and defaults to governing nothing', () => {
  assert.deepEqual([...CONSTITUTION_MODES], ['off', 'warn', 'enforce']);
  assert.equal(constitutionPolicy({}).mode, 'off');
  assert.equal(constitutionPolicy(null).path, 'singularity/constitution.md');
  assert.equal(constitutionPolicy({ mode: 'enforce' }).mode, 'enforce');
  assert.throws(() => constitutionPolicy({ mode: 'enfroce' }), /must be one of/);
  assert.throws(() => constitutionPolicy({ nope: 1 }), /unknown field 'nope'/);
  assert.throws(() => constitutionPolicy({ path: '../escape.md' }), /without ".."/);
});

test('the renderer is versioned, and the article hash covers what the prose came from', () => {
  // `[SPK:REQ-093]` `[SPK:CON-041]`: hashing the prose alone would miss a policy that moved.
  const prose = renderEnforcedArticle({ policy: 'spec.mode', value: 'enforce' });
  assert.match(prose, /- Policy: `spec\.mode`/);
  assert.match(prose, /- Effective value: "enforce"/);
  assert.throws(() => renderEnforcedArticle({ policy: 'x', value: 1, rendererVersion: 99 }), /is not available/);

  const article = { id: 'ART-001', type: 'enforced', policy: 'spec.mode', policyValueSha256: 'a'.repeat(64), rendererVersion: 1 };
  assert.notEqual(articleHash(article, prose), articleHash({ ...article, policyValueSha256: 'b'.repeat(64) }, prose));
  assert.notEqual(articleHash(article, prose), articleHash({ ...article, rendererVersion: 2 }, prose));
  assert.notEqual(articleHash(article, prose), articleHash(article, `${prose} edited`));
});

test('publication validates citations and the packet renders the articles', async () => {
  // The consumers exist, because a constitution nothing reads is the shape this whole pack keeps
  // producing — `constitution: { path, mode }` shipped in workflow.yml at P1 with neither.
  const state = await readFile(new URL('../src/state.mjs', import.meta.url), 'utf8');
  const review = await readFile(new URL('../src/review.mjs', import.meta.url), 'utf8');
  const config = await readFile(new URL('../src/config.mjs', import.meta.url), 'utf8');
  assert.match(state, /validateCitations\(/, 'publication does not validate citations');
  assert.match(state, /constitutionPin\(/, 'Story start does not pin the constitution');
  assert.match(review, /constitutionRendering\(/, 'the review packet does not render the constitution');
  // The snapshot is what a Story reads for the rest of its life; a policy resolved and then dropped
  // there reaches every gate as `undefined`, which is exactly how this one enforced nothing at first.
  assert.match(config, /constitution: structuredClone\(resolved\.constitution/, 'the Story snapshot drops the constitution policy');
  assert.match(config, /artifactSets: structuredClone\(resolved\.artifactSets/, 'the Story snapshot drops the artifact sets');
});
