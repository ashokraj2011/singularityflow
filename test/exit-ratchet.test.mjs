/**
 * No new exits. A sentence that ends a turn early ("…and stop", "hand off", "return the authoring
 * skill") reads as an instruction to every model that sees it. The turn rules SFlow adds to every
 * prompt once ended each /sf-submit with "Return the configured authoring skill and stop", and some
 * turns obeyed it and submitted nothing (2026-10-26). Exits may only be reviewed, conditional ones.
 *
 * - Turn rules: every sentence that names an exit must be one of TURN_RULE_EXITS, for every skill's
 *   turn mode on a document step and a code step.
 * - Skills: every exit sentence in a SKILL.md must be in fixtures/skill-exits.json. A new or reworded
 *   one fails until it is reviewed; regenerate with SINGULARITY_FLOW_UPDATE_SKILL_EXITS=1.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { turnBoundaryContext } from '../src/copilot-mutation-guard.mjs';
import { deriveMutationContract, mutationTurnMode } from '../src/phase-mutation-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(root, 'test/fixtures/skill-exits.json');
const EXIT = /\b(?:stop|stops|stopping|halt|end (?:this|the|your) turn|hand(?:s|ing)?[ -]?off|handoff|return (?:the|a) [\w-]* ?skill)\b/iu;
const exits = (text) => text.split(/\n+|(?<=[.;!?])\s+/u).map((sentence) => sentence.trim()).filter((sentence) => EXIT.test(sentence));

// Each one conditional: an app process this turn started, the command that stops it, a decision made.
const TURN_RULE_EXITS = new Set([
  'Bind the app to loopback on a free port, keep its terminal/session handle, and stop only the process/session you started (for example Ctrl+C), including on failure.',
  'When the capability declares how to start it (`singularity-flow app plan --json`), start it with `singularity-flow app start <ID>` and stop it with `singularity-flow app stop <ID>`, and run its tests with `singularity-flow tests run`, instead of guessing a command.',
  'end this turn after the decision.'
]);

const skillDirectories = () => readdirSync(path.join(root, 'plugin/skills')).filter((name) => name.startsWith('sflow-')).sort();

test('the rules SFlow adds to a turn name only reviewed, conditional exits, for every skill and step', () => {
  const steps = [
    { id: 'planning', status: 'in_progress', generation: 0, writeScope: 'artifact-only', generationPolicy: { task: 'document', requirement: 'required' } },
    { id: 'implementation', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact', generationPolicy: { task: 'code', requirement: 'required' } }
  ];
  const found = new Map();
  for (const directory of skillDirectories()) {
    const skill = `sf-${directory.slice('sflow-'.length)}`;
    for (const phase of steps) {
      const workflow = { workItem: { id: 'EXIT-1' }, currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: {} };
      const contract = deriveMutationContract({ definition: { workItemRoot: 'singularity/work-items' }, workflow, turnMode: mutationTurnMode(skill) });
      const { volatile, stable } = turnBoundaryContext({ skill, contract });
      for (const sentence of exits(`${volatile} ${stable}`)) if (!TURN_RULE_EXITS.has(sentence)) found.set(sentence, `/${skill} on ${phase.id}`);
    }
  }
  assert.deepEqual([...found].map(([sentence, where]) => `${where}: ${sentence}`), [],
    'a turn rule names an exit no review accepted; turn rules never stop a skill before its own steps');
});

test('a skill gains no exit sentence that was not reviewed', () => {
  const current = Object.fromEntries(skillDirectories()
    .map((directory) => [directory, exits(readFileSync(path.join(root, 'plugin/skills', directory, 'SKILL.md'), 'utf8'))])
    .filter(([, sentences]) => sentences.length));
  if (process.env.SINGULARITY_FLOW_UPDATE_SKILL_EXITS === '1') writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  const reviewed = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const added = Object.entries(current).flatMap(([skill, sentences]) =>
    sentences.filter((sentence) => !(reviewed[skill] ?? []).includes(sentence)).map((sentence) => `${skill}: ${sentence}`));
  assert.deepEqual(added, [], 'new or reworded exit sentences: keep the skill going, or review them and regenerate the baseline');
  const gone = Object.entries(reviewed).flatMap(([skill, sentences]) =>
    sentences.filter((sentence) => !(current[skill] ?? []).includes(sentence)).map((sentence) => `${skill}: ${sentence}`));
  assert.deepEqual(gone, [], 'exit sentences no skill has any more: regenerate the baseline so it stays exact');
});
