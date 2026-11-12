/**
 * No skill tells its agent to show a person a hash [owner, 2026-11-11: "lets abstract that away from users"].
 *
 * Every skill's output contract says "Never show a person a hash, digest or commit SHA" (person-text-no-hashes.test.mjs).
 * Steps that said "show the exact plan digest", "report the source hash" or "the person types the full digest"
 * contradicted it in some 75 skills, and an agent follows the step it is on. A step names what a person knows (the step,
 * its generation, its files, a branch, a record ID) and the person confirms what a preview shows; the agent still passes
 * the exact digest in the command it runs.
 *
 * This finds a sentence in a SKILL.md that names a hash, digest or SHA (in its words or a `…Sha256` field, never inside a
 * command, placeholder or flag) beside a verb that shows, reports or relays it, or has a person type or confirm it.
 * ALLOWED is the whole allowlist, each sentence with its reason; anything else it finds is a step to reword.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE = 'Never show a person a hash, digest or commit SHA: name the step, its generation, its files.';
const HASH = /\b(?:hash(?:es)?|digests?|sha(?:-256)?|sha256)\b|[a-z]Sha256\b/iu;
const SHOWN = /\b(?:show|shows|showing|shown|display|displays|displayed|report|reports|list|lists|present|presents|relay|relays|quote|quotes|tell|tells|give|gives|print|prints|name|names|preserve|preserves|summari[sz]e|summari[sz]es|type|types|typed|typing|provide|provides|confirm|confirms|approve|approves)\b/iu;

/** A sentence's own words: commands, placeholders and flags taken out, a one-word code span (a field name) kept. */
function prose(sentence) {
  return sentence
    .replace(/`[^`]*`/gu, (span) => (/[\s<]|^`-/u.test(span) ? ' ' : span.slice(1, -1)))
    .replace(/`[^`]*\s[^`]*$/u, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/(?<![\w-])--[\w-]+/gu, ' ');
}

/** The sentences of a skill that show a person a hash, split as the exit ratchet splits them. */
function hashInstructions(text) {
  const body = text.split('\n').filter((line) => !/^argument-hint:/u.test(line)).join('\n').split(RULE).join(' ');
  return body.split(/\n+|(?<=[.;!?])\s+/u).map((sentence) => sentence.trim())
    .filter((sentence) => HASH.test(prose(sentence)) && SHOWN.test(prose(sentence)));
}

/** The allowlist: `skill: sentence` that still reads as showing a hash, and why it is not one to reword here. */
const ALLOWED = new Map([
  ['sflow-approve: **Review outside chat against the exact binding.** List each artifact/brief\'s name, generation and verified Markdown-preview link (no hashes);',
    'It says not to show one.'],
  ['sflow-documents: Preserve ID/hash/answers.',
    'A restored original keeps its document ID, digest and answers; nothing is shown.'],
  ['sflow-epic-review-decision: Require Epic key, Story key, decision (`approve` or `reject`), and the exact full packet SHA-256 previously displayed by `/sf-epic-review`.',
    'The packet is this skill\'s typed argument (`--packet <SHA-256>`) until the CLI issues a short code for an Epic review decision as it does for --confirm (confirm-code.mjs); open, CLI work.'],
  ['sflow-mcp: Never print environment variables, put secrets in `workflow.yml`, silently replace `.vscode/mcp.json`, or overstate a hash receipt.',
    'It forbids overstating a receipt; nothing is shown.'],
  ['sflow-reject: On checkpoint, digest, boundary or staged-path errors, preserve bytes and relay recovery.',
    'It names a kind of error whose recovery is relayed; no digest is shown.'],
  ['sflow-sgos: Preserve every CLI model, trust, identity, revision, exact-hash, confirmation, and authority',
    'It keeps the CLI\'s checks in force; nothing is shown.']
]);

const skillDirectories = () => readdirSync(path.join(root, 'plugin/skills')).filter((name) => name.startsWith('sflow-')).sort();

test('the finder catches a step that shows or asks for a hash, and lets commands, flags and placeholders through', () => {
  for (const sentence of ['Show the complete packet digest.', 'Report the agent, source hash, phase compatibility.',
    'Relay `removed`, `kept` and `planSha256`.', 'Propose only after the person types that full digest: run it once.',
    'Show each required check, its observed SHA, PR state.']) assert.deepEqual(hashInstructions(sentence), [sentence]);
  for (const sentence of ['Run `singularity-flow auto start --plan <PLAN-ID> --confirm <PACKET-SHA256> --json` once.',
    'Pass the preview\'s exact `resetScopeSha256` to the command.', 'Report a link to the file, `state`, counts.',
    'Never invent evidence hashes.', 'argument-hint: "[--sha256 HASH | list]"']) assert.deepEqual(hashInstructions(sentence), [], sentence);
});

test('no skill tells its agent to show a person a hash, digest or commit SHA', () => {
  const found = skillDirectories().flatMap((name) => hashInstructions(readFileSync(path.join(root, 'plugin/skills', name, 'SKILL.md'), 'utf8'))
    .map((sentence) => `${name}: ${sentence}`));
  assert.deepEqual(found.filter((entry) => !ALLOWED.has(entry)), [],
    'a step shows a person a hash: name the step, its generation, its files or branch, and have the person confirm what the preview shows');
  assert.deepEqual([...ALLOWED.keys()].filter((entry) => !found.includes(entry)), [], 'allowlist entries no skill has any more: remove them');
});
