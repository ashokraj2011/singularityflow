/**
 * "Governed" is retired from what people read (docs/GLOSSARY.md). test/vscode-flow-vocabulary.test.mjs
 * keeps it out of the VS Code UI; this keeps it out of what the CLI says: console output, help pages,
 * error and refusal text, next steps and the reports it writes. Machine names keep the word (flags,
 * command syntax, hyphenated identifiers, code spans and the feature names) and are stripped by
 * pattern. Everything else that still says it is listed below by file and exact phrase, each group
 * for a reason, and an entry that no longer matches fails too, so the list can only shrink.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORD = /\b(?:un)?govern(?:ed|ance)\b/iu;

// Command syntax, flag values, hyphenated identifiers, code spans and the feature names.
const MACHINE = /`[^`]*`|[\w./-]*govern\w*-[\w./-]+|[\w./-]+-govern\w*|--mode governed|singularity-flow governance[^'"`]*|[Gg]overnance (?:rebuild|restore)|[Gg]overned [Ee]xecution|Governed Delivery and Proof/gu;

const KEPT = {
  // Agent prompts, contracts and boundaries composed into phase prompts. Their bytes are hashed
  // into prompt and contract receipts, so rewording them is a prompt change, not a copy edit.
  'src/agent-briefs.mjs': ['of a governed artifact'],
  'src/agent-guidance.mjs': ['for governed Story reads'],
  'src/agent-packet-presentation.mjs': ['for governed outcomes'],
  'src/clarifications.mjs': ['from its governed evidence', 'publish the governed output', 'reading the governed evidence', 'and governed repository evidence'],
  'src/harness-imports.mjs': ['content is governed evidence'],
  'src/initiative-context.mjs': ['# Governed Copilot prompt', '## Selected governed agent', 'Review the governed file', 'from earlier governed work'],
  'src/mcp.mjs': ['# Governed MCP tools'],
  'src/phase-authoring-contract.mjs': ['governed configuration still'],
  'src/phase-draft-check.mjs': ['the existing governed prompt'],
  'src/phase-execution-evidence.mjs': ['a failed governed run', 'for governed command outcomes'],
  'src/phase-mutation-contract.mjs': ['protected and governed state'],
  'src/planning.mjs': ['# Governed story context', '## Selected governed agent', '- Governed agent:', 'Governed destination:', 'their governed destinations', 'its governed jiraKey'],
  'src/publication-preflight.mjs': ['substantive governed content'],
  'src/reference-repositories.mjs': ['change governance, or', 'the current governed prompt'],
  'src/stakeholder-prompt-context.mjs': ['> Governed evidence, not'],
  'src/workspace-impact.mjs': ['is approved, governed, or'],
  'src/worldmodel.mjs': ['# Approved governed references', 'BEGIN GOVERNED PHASE PROMPT', 'END GOVERNED PHASE PROMPT', 'Where governed evidence is',
    'Singularity Flow governed Story handoff', 'a model, governed agent, or', 'its governed response record', 'after governed evidence is read'],
  // Markers that captured prompts are parsed by.
  'src/prompt-audit.mjs': ['BEGIN CAPTURED GOVERNED PROMPT', 'END CAPTURED GOVERNED PROMPT'],
  // Bound to a digest or an exact recorded value: the telemetry consent is accepted by digest, the
  // closed vocabulary has a generated manifest, benchmark receipts must repeat their interpretation
  // exactly, and a Repair Plan record keeps the scope it was approved with.
  'src/telemetry-provision.mjs': ['usage for governed work'],
  'src/vocabularies/catalog.mjs': ['Binds a governed subject', 'one governed artifact generation', 'for governed approval', 'amendment to governed intent',
    'Approves a governed intent', 'Rejects a governed intent', 'of a governed intent amendment', 'additional governed branch',
    'the governed impact classification', 'the governed impact decision', 'Cancels governed work', 'Records governed work'],
  'src/wel-benchmark-evidence.mjs': ['its governed local commits'],
  'src/auto/auto-p1-control.mjs': ['protected governance paths'],
  // Values of --json fields that readers match, and the content of plans confirmed by digest.
  'src/fast-path.mjs': ['governed state'],
  'src/context-xray.mjs': ['governed phase telemetry'],
  'src/work-intervals.mjs': ['governed artifacts', 'start a new governed Story'],
  'src/test-recovery-repair.mjs': ['normal governed Story transaction'],
  // Headings of documents already committed in repositories: poc-lite artifact templates require
  // "Governed inputs", and completion records and source catalogs are written once and kept.
  'src/state.mjs': ['## Governed inputs'],
  'src/epic-completion.mjs': ['## Governance statement'],
  'src/initiative-generators.mjs': ['projection of governed state']
};

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? sources(path.join(directory, entry.name))
    : entry.name.endsWith('.mjs') ? [path.join(directory, entry.name)] : []));
  return nested.flat();
}

const TEXT_KINDS = new Set([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail]);

/** Every string and template piece in src/, one entry per source line, as the parser reads it. */
async function prose(pattern) {
  const pieces = [];
  for (const file of (await sources(path.join(root, 'src'))).sort()) {
    const text = await readFile(file, 'utf8');
    if (!pattern.test(text)) continue;
    const relative = path.relative(root, file).split(path.sep).join('/');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node) => {
      if (TEXT_KINDS.has(node.kind)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        node.text.split('\n').forEach((value, index) => pieces.push({ file: relative, line: line + index, value }));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return pieces;
}

test('CLI prose never says "governed" or "governance"', async () => {
  const offenders = [];
  const used = new Set();
  for (const { file, line, value } of await prose(WORD)) {
    // A value with no space is an identifier, key, path or code.
    if (!WORD.test(value) || !/\s/u.test(value.trim())) continue;
    if (!WORD.test(value.replace(MACHINE, ''))) continue;
    const kept = (KEPT[file] ?? []).filter((phrase) => value.includes(phrase));
    kept.forEach((phrase) => used.add(`${file}\u0000${phrase}`));
    if (!kept.length) offenders.push(`${file}:${line}: ${value.trim().slice(0, 140)}`);
  }
  assert.deepEqual(offenders, [], 'say the thing instead: a Story, a repository, an agent, a Flow Gate (see docs/GLOSSARY.md)');
  const stale = Object.entries(KEPT).flatMap(([file, phrases]) => phrases
    .filter((phrase) => !used.has(`${file}\u0000${phrase}`)).map((phrase) => `${file}: ${phrase}`));
  assert.deepEqual(stale, [], 'these kept phrases are gone; remove them from KEPT');
});

test('the three Flow names are the only Flow-prefixed nouns in CLI prose', async () => {
  // Flow Impact is the impact-study feature, named before this vocabulary and kept (docs/GLOSSARY.md).
  const allowed = new Set(['Flow Gate', 'Flow Gates', 'Flow Ledger', 'Flow Policy', 'Flow Policies', 'Flow agent', 'Flow agents', 'Flow Impact']);
  const found = new Set();
  for (const { value } of await prose(/\bFlow [A-Za-z]/u)) {
    for (const match of value.matchAll(/(?<!Singularity )\bFlow (?:[A-Z][a-z]+|agents?)\b/gu)) found.add(match[0]);
  }
  assert.deepEqual([...found].filter((name) => !allowed.has(name)), [],
    'only Flow Gate, Flow Ledger and Flow Policy take the prefix (and Flow agent beside other Copilot agents)');
});
