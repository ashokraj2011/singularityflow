/**
 * Every refusal the Repository brief's code and its callers raise [WMR:REQ-025]. The World Model is guidance, never
 * authority: a refusal may stop a read command a person runs (`wm knowledge show`, `wm rules confirm`), never a Story
 * step, an approval or a publication. A new `SingularityFlowError` in src/knowledge/, or a new module that loads it,
 * fails here until it is placed in one of the lists below; one on a step, approval or publication path must be caught
 * and become a warning, as the brief's own are (A11).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(path.join(root, 'package.json'))('typescript');

/** Raised by a read command a person runs; it may refuse. */
const PERSON_READ = 'a read command a person runs';
/** Raised under a step's compose, inside repositoryBriefPrompt's guard: it becomes a warning and the step goes on. */
const COMPOSE_CAUGHT = 'caught in a step\'s compose: a warning, never a refusal';

const RAISES = Object.freeze({
  'src/knowledge/benchmark.mjs parseKnowledgeExpectations KNOWLEDGE_EXPECTATIONS_INVALID': PERSON_READ, // wm knowledge eval
  'src/knowledge/brief.mjs parseBriefOutput KNOWLEDGE_BRIEF_INVALID': PERSON_READ, // wm knowledge brief (a model's answer)
  'src/knowledge/command.mjs built KNOWLEDGE_SCOPE_TOO_LARGE': PERSON_READ,
  'src/knowledge/command.mjs knowledgeCommand -': PERSON_READ, // usage and unknown views, kinds and roles
  'src/knowledge/command.mjs briefTarget KNOWLEDGE_REF_UNKNOWN': PERSON_READ,
  'src/knowledge/command.mjs reviewCommand -': PERSON_READ, // wm knowledge confirm|correct|reject
  'src/knowledge/confirm.mjs readConfirmations KNOWLEDGE_CONFIRMATIONS_INVALID': COMPOSE_CAUGHT,
  'src/knowledge/confirm.mjs recordReview -': PERSON_READ,
  'src/knowledge/confirm.mjs recordReview KNOWLEDGE_ITEM_UNKNOWN': PERSON_READ,
  'src/knowledge/confirm.mjs recordReview KNOWLEDGE_REVIEW_NOTE_REQUIRED': PERSON_READ,
  'src/knowledge/explain.mjs parseOutput KNOWLEDGE_EXPLANATION_INVALID': PERSON_READ, // wm knowledge explain (a model's answer)
  'src/knowledge/rule-meaning.mjs readMeaningEntries KNOWLEDGE_RULE_MEANINGS_INVALID': COMPOSE_CAUGHT,
  'src/knowledge/rule-meaning.mjs confirmRuleMeaning KNOWLEDGE_RULE_UNANCHORED': PERSON_READ, // wm rules confirm
  'src/knowledge/rules-command.mjs ruleRecords KNOWLEDGE_SCOPE_TOO_LARGE': PERSON_READ,
  'src/knowledge/rules-command.mjs rulesCommand -': PERSON_READ,
  'src/knowledge/rules-command.mjs confirmCommand -': PERSON_READ,
  'src/knowledge/rules-command.mjs confirmCommand KNOWLEDGE_RULE_UNKNOWN': PERSON_READ,
  'src/knowledge/rules-command.mjs confirmCommand KNOWLEDGE_RULE_MEANING_REQUIRED': PERSON_READ,
  'src/knowledge/source.mjs excludedSource KNOWLEDGE_SCOPE_INVALID': COMPOSE_CAUGHT,
  'src/knowledge/source.mjs readKnowledgeSource KNOWLEDGE_SCOPE_INVALID': COMPOSE_CAUGHT,
  'src/knowledge/source.mjs readKnowledgeSource KNOWLEDGE_SOURCE_UNAVAILABLE': COMPOSE_CAUGHT,
  // spec author's knowledge refusal stops `spec author research` (a read a person runs); `gaps` lists the gaps without it.
  'src/commands/spec-author.mjs knowledgeAtHead SPEC_RESEARCH_UNAVAILABLE': PERSON_READ
});

/** The modules outside src/knowledge/ that load it, and why none can refuse a step, an approval or a publication. */
const CALLERS = Object.freeze({
  'src/phase-prompt-composer.mjs': 'a step\'s compose: repositoryBriefPrompt never throws; a failed brief is a warning',
  'src/worldmodel.mjs': 'wm brief, wm knowledge and wm rules: read commands a person runs',
  'src/workflow-studio.mjs': 'Workflow Studio: the brief profile of each step, pure',
  'src/commands/spec-author.mjs': 'spec author: research may refuse; gaps lists the gaps with impact "not available"',
  'src/spec-library/proposals.mjs': 'a span digest, pure',
  'src/spec-library/research.mjs': 'a span digest, pure'
});

async function sources(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sources(file));
    else if (file.endsWith('.mjs')) found.push(file);
  }
  return found;
}

/** `new SingularityFlowError(…, { code })` and spec author's `fail(…, code)`, with the function each is raised in. */
function raises(file, text) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  const literal = (node) => (node && ts.isStringLiteral(node) ? node.text : null);
  const visit = (node, owner) => {
    let name = owner;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) name = node.name.text;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) name = node.name.text;
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'SingularityFlowError') {
      const options = node.arguments?.[1];
      const code = options && ts.isObjectLiteralExpression(options)
        ? options.properties.map((property) => (property.name?.text === 'code' ? literal(property.initializer) : null)).find(Boolean) ?? null : null;
      found.push(`${name} ${code ?? '-'}`);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fail' && literal(node.arguments?.[1])) {
      found.push(`${name} ${literal(node.arguments[1])}`);
    }
    ts.forEachChild(node, (child) => visit(child, name));
  };
  visit(tree, '(module)');
  return found;
}

test('every refusal src/knowledge/ raises is listed, and only a read command a person runs may refuse [WMR:REQ-025]', async () => {
  const seen = new Set();
  for (const file of await sources(path.join(root, 'src', 'knowledge'))) {
    for (const raise of raises(file, await readFile(file, 'utf8'))) seen.add(`${path.relative(root, file).split(path.sep).join('/')} ${raise}`);
  }
  // spec author's refusals about the knowledge (the rest are its own drafts', not the brief's).
  const author = path.join(root, 'src', 'commands', 'spec-author.mjs');
  for (const raise of raises(author, await readFile(author, 'utf8')).filter((entry) => / SPEC_RESEARCH_UNAVAILABLE$/u.test(entry))) {
    seen.add(`src/commands/spec-author.mjs ${raise}`);
  }
  const unlisted = [...seen].filter((entry) => !Object.hasOwn(RAISES, entry));
  assert.deepEqual(unlisted, [], 'A new refusal: list it in RAISES. On a Story step, approval or publication path it must be caught and become a warning.');
  const gone = Object.keys(RAISES).filter((entry) => !seen.has(entry));
  assert.deepEqual(gone, [], 'A listed refusal is no longer raised: take it out of RAISES.');
});

test('the modules that load src/knowledge/ are listed; none is an approval or a publication [WMR:REQ-025]', async () => {
  const loads = /(?:from\s+'(?:\.\.?\/)+knowledge\/[\w-]+\.mjs'|import\('(?:\.\.?\/)+knowledge\/[\w-]+\.mjs'\)|'src',\s*'knowledge',\s*'[\w-]+\.mjs')/u;
  const callers = [];
  for (const file of await sources(path.join(root, 'src'))) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative.startsWith('src/knowledge/')) continue;
    if (loads.test(await readFile(file, 'utf8'))) callers.push(relative);
  }
  assert.deepEqual(callers.sort(), Object.keys(CALLERS).sort(), 'A new caller of src/knowledge/: list it in CALLERS with why it cannot refuse a step, an approval or a publication.');
});

test('A11: with the knowledge build forced to fail, a step\'s brief is a warning, never a refusal [WMR:REQ-025]', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-refusal-inventory-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', 'shop'), repository, { recursive: true });
  // An environment declaration that cannot be read stops every knowledge read (KNOWLEDGE_SCOPE_INVALID).
  await mkdir(path.join(repository, 'singularity'), { recursive: true });
  await writeFile(path.join(repository, 'singularity', 'environments.yml'), 'environments: [unclosed\n');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'Shop']]) {
    assert.equal(spawnSync('git', args, { cwd: repository, env, encoding: 'utf8' }).status, 0);
  }
  const { buildKnowledge } = await import('../src/knowledge/store.mjs');
  await assert.rejects(buildKnowledge(repository), (error) => error.code === 'KNOWLEDGE_SCOPE_INVALID', 'the build itself refuses');
  const { repositoryBriefPrompt } = await import('../src/knowledge/prompt.mjs');
  for (const phase of ['design', 'implementation', 'verification']) {
    const brief = await repositoryBriefPrompt(repository, { definition: null, phase, workflow: { workItem: { title: 'Free shipping from 75.00' } }, polish: 'off' });
    assert.equal(brief.text, '', `${phase}: no brief`);
    assert.equal(brief.status, 'unavailable');
    assert.match(brief.warnings.join('\n'), /Repository knowledge was not added: .*environments\.yml could not be read/u);
  }
});

test('P5: a failure while recording a step\'s lessons cannot block its approval [WMR:REQ-022 probe]', async (t) => {
  // Recording runs inside the approval's publication unit, in a try whose catch only drops the lesson.
  const service = path.join(root, 'src', 'story-publication-service.mjs');
  const tree = ts.createSourceFile(service, await readFile(service, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'noticeStepLessons') calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(calls.length, 1, 'one place records a step\'s lessons at its approval');
  let guard = calls[0].parent;
  while (guard && !(ts.isTryStatement(guard) && guard.tryBlock.pos <= calls[0].pos && calls[0].end <= guard.tryBlock.end)) guard = guard.parent;
  assert.ok(guard?.catchClause, 'it is inside a try');
  assert.equal(guard.catchClause.block.statements.length, 0, 'whose catch rethrows nothing: no lesson, same approval');
  // What approve and submit print after the approval reads the store, and never throws even when the store is broken.
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-lessons-broken-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repository });
  await mkdir(path.join(repository, 'singularity', 'knowledge'), { recursive: true });
  await writeFile(path.join(repository, 'singularity', 'knowledge', 'records'), 'not a folder\n');
  const { lessonsAfterApproval } = await import('../src/story-lessons-notice.mjs');
  assert.equal(await lessonsAfterApproval(repository, 'LRN-9', 'implementation'), null);
});
